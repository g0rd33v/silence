/* ============================================================
   Silence · whisper.js  (v1.0)
   ------------------------------------------------------------
   Main-thread STT module. Owns the Web Worker that hosts
   transformers.js + Whisper-tiny, the rolling 16kHz audio
   buffer, and the periodic dispatch loop.

   Loaded BEFORE app.js so the global `whisper` object is
   available to startSession()/completeSession() without any
   load-order dance. Reads CONFIG.STT_* constants which app.js
   defines later, but only inside functions that run after boot.

   Public surface (used by app.js):
     whisper.preload(onStatus)      — start fetching the model
     whisper.startSession(rate, cb) — arm dispatch, set text callback
     whisper.endSession()           — flush + drain (await it)
     whisper.appendSamples(float32) — feed mic samples in
   ============================================================ */

'use strict';

const whisper = {
  worker: null,
  ready: false,
  loading: false,
  loadProgress: 0,
  unsupported: false,
  loadError: null,
  _onText: null,
  _onStatus: null,

  buffer: null,
  bufferLen: 0,
  inputSampleRate: 0,

  dispatchTimer: null,
  chunkId: 0,
  pending: 0,

  // v1.2: language hint for transcription. 'auto' | 'russian' | 'english'.
  // Passed through to whisper via generate_kwargs; non-auto dramatically
  // cuts hallucination rate on the target language.
  language: 'auto',

  setLanguage(lang) {
    this.language = lang || 'auto';
  },

  ensureWorker() {
    if (this.worker) return true;
    if (this.unsupported) return false;
    if (typeof Worker === 'undefined') {
      this.unsupported = true;
      this.loadError = 'Web Workers not supported on this browser.';
      this._emitStatus();
      return false;
    }
    try {
      this.worker = new Worker('./whisper-worker.js', { type: 'module' });
      this.worker.addEventListener('message', (e) => this._onMessage(e.data));
      this.worker.addEventListener('error', (e) => {
        this.loadError = (e && e.message) || 'Worker error.';
        this.unsupported = true;
        this._emitStatus();
      });
      return true;
    } catch (e) {
      this.unsupported = true;
      this.loadError = (e && e.message) || 'Worker init failed.';
      this._emitStatus();
      return false;
    }
  },

  preload(onStatus) {
    if (onStatus) this._onStatus = onStatus;
    if (this.ready) { this._emitStatus(); return; }
    if (!this.ensureWorker()) return;
    if (this.loading) return;
    this.loading = true;
    this._emitStatus();
    this.worker.postMessage({ type: 'load' });
  },

  startSession(inputSampleRate, onText) {
    this.inputSampleRate = inputSampleRate || 48000;
    this._onText = onText || null;
    this.chunkId = 0;
    this.pending = 0;
    const cap = CONFIG.STT_SAMPLE_RATE * CONFIG.STT_CHUNK_SECONDS * 2;
    if (!this.buffer || this.buffer.length < cap) {
      this.buffer = new Float32Array(cap);
    }
    this.bufferLen = 0;
    this.ensureWorker();
    if (!this.dispatchTimer) {
      this.dispatchTimer = setInterval(
        () => this._dispatch(false),
        CONFIG.STT_DISPATCH_INTERVAL_MS
      );
    }
  },

  async endSession() {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    this._dispatch(true);

    const deadline = Date.now() + 60000;
    while (this.pending > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this._onText = null;
    this.bufferLen = 0;
  },

  appendSamples(input) {
    if (!input || input.length === 0 || !this.buffer) return;
    const ratio = this.inputSampleRate / CONFIG.STT_SAMPLE_RATE;
    const outNeeded = Math.floor(input.length / ratio);
    const room = this.buffer.length - this.bufferLen;
    const n = Math.min(outNeeded, room);
    for (let i = 0; i < n; i++) {
      const src = Math.floor(i * ratio);
      this.buffer[this.bufferLen + i] = input[src] || 0;
    }
    this.bufferLen += n;
  },

  _dispatch(isFinal) {
    if (!this.worker) return;
    const sr = CONFIG.STT_SAMPLE_RATE;
    const minSamples = sr * 5;
    if (!isFinal && this.bufferLen < minSamples) return;
    if (this.bufferLen === 0) return;

    const maxSamples = sr * CONFIG.STT_CHUNK_SECONDS;
    const sendLen = Math.min(this.bufferLen, maxSamples);
    const slice = this.buffer.slice(0, sendLen);

    let keepFrom;
    if (isFinal) {
      keepFrom = sendLen;
    } else {
      keepFrom = Math.max(0, sendLen - sr);
    }
    if (keepFrom > 0 && keepFrom < this.bufferLen) {
      this.buffer.copyWithin(0, keepFrom, this.bufferLen);
      this.bufferLen -= keepFrom;
    } else {
      this.bufferLen = 0;
    }

    const id = ++this.chunkId;
    this.pending++;
    this.worker.postMessage({
      type: 'transcribe',
      audio: slice,
      id,
      language: this.language,
    });
  },

  _onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'progress') {
      const total = msg.total || 1;
      const loaded = msg.loaded || 0;
      this.loadProgress = Math.min(1, loaded / total);
      this._emitStatus();
      return;
    }
    if (msg.type === 'ready') {
      this.ready = true;
      this.loading = false;
      this.loadProgress = 1;
      this._emitStatus();
      return;
    }
    if (msg.type === 'error') {
      if (msg.id != null) {
        this.pending = Math.max(0, this.pending - 1);
        console.warn('[silence] stt chunk error:', msg.error);
        return;
      }
      this.loading = false;
      this.loadError = msg.error;
      this.unsupported = true;
      this._emitStatus();
      return;
    }
    if (msg.type === 'result') {
      this.pending = Math.max(0, this.pending - 1);
      const text = (msg.text || '').trim();
      this.lastResult = text;
      if (text.length >= CONFIG.STT_MIN_CHARS && this._onText) {
        this._onText(text);
      }
      return;
    }
  },

  _emitStatus() {
    if (!this._onStatus) return;
    let stateName = 'idle';
    if (this.unsupported) stateName = 'unsupported';
    else if (this.loading) stateName = 'loading';
    else if (this.ready)   stateName = 'ready';
    this._onStatus({
      state: stateName,
      progress: this.loadProgress,
      error: this.loadError,
    });
  },

  // v1.1.1: debug stats for the Mumbles diagnostic panel.
  getStats() {
    let stateName = 'idle';
    if (this.unsupported) stateName = 'unsupported';
    else if (this.loading) stateName = 'loading';
    else if (this.ready)   stateName = 'ready';
    const sr = (typeof CONFIG !== 'undefined' && CONFIG.STT_SAMPLE_RATE) || 16000;
    return {
      state: stateName,
      progress: this.loadProgress,
      error: this.loadError,
      bufferSamples: this.bufferLen,
      bufferSeconds: this.bufferLen / sr,
      chunksSent: this.chunkId,
      chunksPending: this.pending,
      chunksDone: Math.max(0, this.chunkId - this.pending),
      inputSampleRate: this.inputSampleRate,
      sessionActive: this.dispatchTimer != null,
    };
  },

  // Last transcript text seen (set externally by app.js to avoid
  // duplicating the join logic). Only used by the debug panel.
  lastResult: '',
};
