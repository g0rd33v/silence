/* ================================================================
   Silence · whisper.js  (v1.4 hardened)
   ----------------------------------------------------------------
   Main-thread STT controller. Spawns the Web Worker, owns the
   rolling 16 kHz audio buffer, throttles chunk dispatch, and
   exposes a rich observability surface for the Diagnostics panel.

   Public surface (stable):
     whisper.preload(onStatus)             start model fetch
     whisper.startSession(rate, onText)    arm dispatch loop
     whisper.endSession()                  flush + drain (await)
     whisper.appendSamples(float32)        feed mic samples
     whisper.setLanguage(lang)             'auto' | 'english' | 'russian' | …
     whisper.getStats()                    panel readout
     whisper.getDiag()                     deep diagnostics snapshot
     whisper.probeGpu()                    ask worker to re-probe
     whisper.reloadWorker()                terminate + rebuild
     whisper.forceBackend(b)               'webgpu' | 'wasm' | null
     whisper.ping()                        Promise<workerPing>

   v1.4 changes:
     • Every chunk transfers its underlying ArrayBuffer to the
       worker (no copy), halving the transient RAM spike.
     • Backpressure: we never keep more than 1 chunk in flight.
       Late chunks are coalesced onto the rolling buffer.
     • Per-chunk deadlines; worker timeouts are reported and the
       worker is told to rebuild its pipeline on timeout.
     • Worker 'error' events surface to a ring buffer (last 16).
     • Full diagnostics bundle for the Diag panel.
   ================================================================ */

'use strict';

const whisper = {
  worker: null,
  ready: false,
  loading: false,
  loadProgress: 0,
  loadError: null,
  unsupported: false,
  backend: null,            // 'webgpu' | 'wasm' | null (set on 'ready')
  model: 'Xenova/whisper-small',
  _forceBackend: null,

  _onStatus: null,
  _onText: null,

  buffer: null,
  bufferLen: 0,
  inputSampleRate: 0,

  dispatchTimer: null,
  chunkId: 0,
  pending: 0,
  inFlight: false,          // true while a chunk is awaiting a result

  // v1.4: rolling diagnostics
  _errorsRing: [],          // {ts, where, error, id?}
  _progressFiles: {},       // {file: {loaded,total}}
  _bytesLoaded: 0,
  _bytesTotal: 0,
  _lastResult: '',
  _lastChunkMs: null,
  _chunksDone: 0,
  _chunksErr: 0,
  _deviceLostCount: 0,
  _gpu: null,
  _workerBootTs: 0,
  _lastDiag: null,
  _sessionStartedAt: 0,

  language: 'auto',

  setLanguage(lang) { this.language = lang || 'auto'; },

  forceBackend(b) {
    this._forceBackend = (b === 'webgpu' || b === 'wasm') ? b : null;
  },

  _pushError(where, error, id) {
    this._errorsRing.push({ ts: Date.now(), where, error, id: (id == null ? null : id) });
    while (this._errorsRing.length > 16) this._errorsRing.shift();
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
      this.worker = new Worker('./whisper-worker.js?v=1.4.0', { type: 'module' });
      this._workerBootTs = Date.now();
      this.worker.addEventListener('message', (e) => this._onMessage(e.data));
      this.worker.addEventListener('error', (e) => {
        const msg = (e && e.message) || 'Worker error.';
        this._pushError('worker-onerror', msg);
        this.loadError = msg;
        this.unsupported = true;
        this._emitStatus();
      });
      this.worker.addEventListener('messageerror', (e) => {
        this._pushError('worker-messageerror', 'structured-clone failed');
      });
      return true;
    } catch (e) {
      this.unsupported = true;
      this.loadError = (e && e.message) || 'Worker init failed.';
      this._pushError('ensureWorker', this.loadError);
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
    const opts = {};
    if (this._forceBackend) opts.forceBackend = this._forceBackend;
    this.worker.postMessage({ type: 'load', opts });
  },

  startSession(inputSampleRate, onText) {
    this.inputSampleRate = inputSampleRate || 48000;
    this._onText = onText || null;
    this.chunkId = 0;
    this.pending = 0;
    this.inFlight = false;
    this._sessionStartedAt = Date.now();
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
    this.inFlight = false;
    this._sessionStartedAt = 0;
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
    // Backpressure: don't queue a second chunk while one is in flight,
    // unless this is the final flush (endSession needs to drain).
    if (this.inFlight && !isFinal) return;

    const maxSamples = sr * CONFIG.STT_CHUNK_SECONDS;
    const sendLen = Math.min(this.bufferLen, maxSamples);

    // Make a standalone Float32Array backed by its own ArrayBuffer so
    // we can transfer ownership to the worker with zero-copy.
    const slice = new Float32Array(sendLen);
    slice.set(this.buffer.subarray(0, sendLen));

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
    this.inFlight = true;
    try {
      this.worker.postMessage({
        type: 'transcribe',
        audio: slice,
        id,
        language: this.language,
        deadlineMs: 90000,
      }, [slice.buffer]);
    } catch (e) {
      // Transfer failed (very old browsers). Fall back to structured clone.
      try {
        this.worker.postMessage({
          type: 'transcribe',
          audio: slice,
          id,
          language: this.language,
          deadlineMs: 90000,
        });
      } catch (e2) {
        this.pending = Math.max(0, this.pending - 1);
        this.inFlight = false;
        this._pushError('dispatch-postMessage', (e2 && e2.message) || String(e2), id);
      }
    }
  },

  _onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'progress') {
      const total = msg.total || 0;
      const loaded = msg.loaded || 0;
      if (msg.file) this._progressFiles[msg.file] = { loaded, total };
      // Aggregate across files for an honest progress bar.
      let sumL = 0, sumT = 0;
      for (const k in this._progressFiles) {
        sumL += this._progressFiles[k].loaded;
        sumT += this._progressFiles[k].total;
      }
      this._bytesLoaded = sumL;
      this._bytesTotal = sumT;
      if (sumT > 0) this.loadProgress = Math.min(1, sumL / sumT);
      this._emitStatus();
      return;
    }
    if (msg.type === 'ready') {
      this.ready = true;
      this.loading = false;
      this.loadProgress = 1;
      this.backend = msg.backend || null;
      this.model = msg.model || this.model;
      this._emitStatus();
      return;
    }
    if (msg.type === 'diag') {
      const p = msg.payload || {};
      this._lastDiag = { ts: Date.now(), ...p };
      if (p.kind === 'gpu-probe') this._gpu = p.gpu;
      if (p.kind === 'backend-dropped') this._deviceLostCount = p.deviceLostCount || this._deviceLostCount;
      return;
    }
    if (msg.type === 'error') {
      this._pushError(msg.where || 'worker', msg.error || 'unknown', msg.id);
      if (msg.id != null) {
        this.pending = Math.max(0, this.pending - 1);
        this.inFlight = this.pending > 0;
        this._chunksErr++;
        return;
      }
      // Fatal / load error (no id):
      this.loading = false;
      this.loadError = msg.error || 'load failed';
      this.unsupported = true;
      this._emitStatus();
      return;
    }
    if (msg.type === 'result') {
      this.pending = Math.max(0, this.pending - 1);
      this.inFlight = this.pending > 0;
      this._chunksDone++;
      this._lastChunkMs = msg.ms || null;
      const text = (msg.text || '').trim();
      this._lastResult = text;
      if (text.length >= CONFIG.STT_MIN_CHARS && this._onText) {
        try { this._onText(text); }
        catch (e) { this._pushError('onText-callback', (e && e.message) || String(e)); }
      }
      return;
    }
    if (msg.type === 'pong') {
      this._lastPong = { ts: Date.now(), ...msg };
      this._deviceLostCount = msg.deviceLostCount || this._deviceLostCount;
      if (msg.adapterInfo) this._gpu = msg.adapterInfo;
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
      backend: this.backend,
      model: this.model,
      bytesLoaded: this._bytesLoaded,
      bytesTotal: this._bytesTotal,
    });
  },

  /* ---- Introspection -------------------------------------------- */

  getStats() {
    let stateName = 'idle';
    if (this.unsupported) stateName = 'unsupported';
    else if (this.loading) stateName = 'loading';
    else if (this.ready)   stateName = 'ready';
    return {
      state: stateName,
      progress: this.loadProgress,
      error: this.loadError,
      backend: this.backend,
      model: this.model,
      sessionActive: this.dispatchTimer !== null,
      pending: this.pending,
      inFlight: this.inFlight,
      chunksDone: this._chunksDone,
      chunksErr: this._chunksErr,
      lastChunkMs: this._lastChunkMs,
      bufferLen: this.bufferLen,
      bufferCap: this.buffer ? this.buffer.length : 0,
      deviceLostCount: this._deviceLostCount,
      lastError: this._errorsRing.length ? this._errorsRing[this._errorsRing.length - 1] : null,
    };
  },

  // Deep snapshot for the Diagnostics panel and "copy JSON" button.
  getDiag() {
    return {
      version: 'whisper-client-v1.4',
      state: this.getStats(),
      gpu: this._gpu,
      workerBootTs: this._workerBootTs,
      sessionStartedAt: this._sessionStartedAt,
      language: this.language,
      forceBackend: this._forceBackend,
      progressFiles: this._progressFiles,
      bytesLoaded: this._bytesLoaded,
      bytesTotal: this._bytesTotal,
      lastResult: this._lastResult,
      lastChunkMs: this._lastChunkMs,
      chunksDone: this._chunksDone,
      chunksErr: this._chunksErr,
      deviceLostCount: this._deviceLostCount,
      errors: this._errorsRing.slice(),
      lastDiag: this._lastDiag,
      lastPong: this._lastPong || null,
      config: {
        sampleRate: (typeof CONFIG !== 'undefined') ? CONFIG.STT_SAMPLE_RATE : null,
        chunkSeconds: (typeof CONFIG !== 'undefined') ? CONFIG.STT_CHUNK_SECONDS : null,
        dispatchIntervalMs: (typeof CONFIG !== 'undefined') ? CONFIG.STT_DISPATCH_INTERVAL_MS : null,
        minChars: (typeof CONFIG !== 'undefined') ? CONFIG.STT_MIN_CHARS : null,
      },
    };
  },

  probeGpu() {
    if (!this.ensureWorker()) return;
    try { this.worker.postMessage({ type: 'probe' }); } catch (_) {}
  },

  ping(timeoutMs) {
    const self = this;
    return new Promise((resolve) => {
      if (!self.ensureWorker()) return resolve(null);
      const start = Date.now();
      const onMsg = (e) => {
        if (e.data && e.data.type === 'pong') {
          self.worker.removeEventListener('message', onMsg);
          resolve({ rttMs: Date.now() - start, ...e.data });
        }
      };
      self.worker.addEventListener('message', onMsg);
      try { self.worker.postMessage({ type: 'ping' }); } catch (_) { resolve(null); }
      setTimeout(() => {
        self.worker.removeEventListener('message', onMsg);
        resolve(null);
      }, Math.max(500, timeoutMs || 3000));
    });
  },

  reloadWorker() {
    try { this.worker && this.worker.terminate(); } catch (_) {}
    this.worker = null;
    this.ready = false;
    this.loading = false;
    this.loadProgress = 0;
    this.loadError = null;
    this.unsupported = false;
    this.backend = null;
    this.pending = 0;
    this.inFlight = false;
    this._progressFiles = {};
    this._bytesLoaded = 0;
    this._bytesTotal = 0;
    this._emitStatus();
  },

  // Kept for legacy Mumbles panel binding.
  lastResult: '',
};

// Keep the legacy `lastResult` field mirrored for the old Mumbles panel.
Object.defineProperty(whisper, 'lastResult', {
  configurable: true,
  get() { return this._lastResult; },
  set(v) { this._lastResult = v || ''; },
});

// Expose as window property for legacy scripts that check window.whisper.
window.whisper = whisper;
