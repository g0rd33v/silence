/* ============================================================
   Silence · whisper.js
   ------------------------------------------------------------
   Main-thread interface to the Whisper Web Worker.

   Owns:
     - Worker lifecycle (lazy create on first opt-in, kept warm).
     - Rolling audio buffer at 16 kHz mono Float32.
     - Periodic dispatch loop that ships chunks to the worker.
     - Public events for status/text so app.js can stay thin.

   Lives in its own file (rather than inline in app.js) so the
   patchset to app.js stays small enough to push reliably.

   Public API (window.silenceWhisper):
     preload(onStatus)            — start fetching the model
     startSession(rate, onText)   — begin a session, take samples
     endSession()                 — flush + drain in-flight chunks
     feed(float32Samples)         — push one mic buffer worth
     isSupported()                — false if Worker is unavailable

   Status callback receives:
     { state: 'idle' | 'loading' | 'ready' | 'unsupported',
       progress: 0..1, error?: string }

   Text callback receives a single string per finalised chunk —
   already trimmed; minimum length filter applied here.
   ============================================================ */

(function (global) {
  'use strict';

  // ---- Tunables. App.js pulls these from CONFIG; we duplicate the
  // defaults here so this file is independently usable.
  const STT_SAMPLE_RATE          = 16000;
  const STT_CHUNK_SECONDS        = 30;
  const STT_DISPATCH_INTERVAL_MS = 30 * 1000;
  const STT_MIN_CHARS            = 2;
  // Buffer cap = 2× chunk so a slow worker doesn't drop audio in
  // the common case (60s of speech queued is plenty of headroom).
  const BUFFER_SECONDS           = STT_CHUNK_SECONDS * 2;
  // Trailing context kept after each non-final dispatch — gives the
  // worker a 1-second overlap so words straddling a boundary aren't
  // halved.
  const OVERLAP_SECONDS          = 1;

  const whisper = {
    worker: null,
    ready: false,
    loading: false,
    loadProgress: 0,
    unsupported: false,
    loadError: null,

    // Per-session state — wiped between sessions.
    _onText:    null,
    _onStatus:  null,
    buffer:     null,    // Float32Array, length = BUFFER_SECONDS * 16000
    bufferLen:  0,
    inputSampleRate: 0,
    dispatchTimer: null,
    chunkId:   0,
    pending:   0,        // in-flight transcribe count

    // ---- Capability check used by app.js to decide whether to even
    // show the voice-notes UI on a given device.
    isSupported() {
      return typeof Worker !== 'undefined';
    },

    // ---- Lazy worker construction. Returns true on success.
    _ensureWorker() {
      if (this.worker) return true;
      if (this.unsupported) return false;
      if (!this.isSupported()) {
        this.unsupported = true;
        this.loadError = 'Web Workers not supported on this browser.';
        this._emitStatus();
        return false;
      }
      try {
        this.worker = new Worker('./whisper-worker.js', { type: 'module' });
        this.worker.addEventListener('message', (e) => this._onMessage(e.data));
        this.worker.addEventListener('error', (e) => {
          // Any worker-level error puts us into the unsupported state —
          // no point retrying for the rest of the page lifetime.
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

    // ---- Begin model download. Safe to call repeatedly. The status
    // callback fires at every meaningful state change (loading → ready).
    preload(onStatus) {
      if (onStatus) this._onStatus = onStatus;
      if (this.ready) { this._emitStatus(); return; }
      if (!this._ensureWorker()) return;
      if (this.loading) return;
      this.loading = true;
      this._emitStatus();
      this.worker.postMessage({ type: 'load' });
    },

    // ---- Begin a session. inputSampleRate is the mic's actual rate;
    // we resample on-the-fly. onText is called once per finalised chunk.
    startSession(inputSampleRate, onText) {
      this.inputSampleRate = inputSampleRate || 48000;
      this._onText = onText || null;
      this.chunkId = 0;
      this.pending = 0;
      const cap = STT_SAMPLE_RATE * BUFFER_SECONDS;
      if (!this.buffer || this.buffer.length < cap) {
        this.buffer = new Float32Array(cap);
      }
      this.bufferLen = 0;
      this._ensureWorker();
      if (!this.dispatchTimer) {
        this.dispatchTimer = setInterval(
          () => this._dispatch(false),
          STT_DISPATCH_INTERVAL_MS
        );
      }
    },

    // ---- End a session. Caller awaits to ensure the final chunk is
    // transcribed before the session record is written.
    async endSession() {
      if (this.dispatchTimer) {
        clearInterval(this.dispatchTimer);
        this.dispatchTimer = null;
      }
      // Final flush — sends whatever's left without keeping overlap.
      this._dispatch(true);

      // Wait up to 60s for in-flight chunks. Whisper-tiny on WASM
      // transcribes 30s of audio in ~5–15s on a phone; 60s is comfortable.
      const deadline = Date.now() + 60000;
      while (this.pending > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      this._onText = null;
      this.bufferLen = 0;
    },

    // ---- Push a buffer of mic samples (Float32 @ inputSampleRate).
    // Resamples to 16 kHz with nearest-neighbour. Speech is low-frequency
    // and Whisper's mel filter ignores the high end anyway, so a more
    // sophisticated resampler isn't worth the cost.
    feed(input) {
      if (!input || input.length === 0 || !this.buffer) return;
      const ratio = this.inputSampleRate / STT_SAMPLE_RATE;
      const outNeeded = Math.floor(input.length / ratio);
      const room = this.buffer.length - this.bufferLen;
      const n = Math.min(outNeeded, room);
      for (let i = 0; i < n; i++) {
        const src = Math.floor(i * ratio);
        this.buffer[this.bufferLen + i] = input[src] || 0;
      }
      this.bufferLen += n;
    },

    // ---- Send a chunk to the worker. Skips if buffer is too short
    // (under 5s) and we're not on a final flush.
    _dispatch(isFinal) {
      if (!this.worker) return;
      const sr = STT_SAMPLE_RATE;
      const minSamples = sr * 5;
      if (!isFinal && this.bufferLen < minSamples) return;
      if (this.bufferLen === 0) return;

      const maxSamples = sr * STT_CHUNK_SECONDS;
      const sendLen = Math.min(this.bufferLen, maxSamples);
      const slice = this.buffer.slice(0, sendLen);

      // Trim the buffer, keeping the trailing overlap on non-final
      // dispatches so cross-boundary words still get heard.
      let keepFrom;
      if (isFinal) {
        keepFrom = sendLen;
      } else {
        keepFrom = Math.max(0, sendLen - sr * OVERLAP_SECONDS);
      }
      if (keepFrom > 0 && keepFrom < this.bufferLen) {
        this.buffer.copyWithin(0, keepFrom, this.bufferLen);
        this.bufferLen -= keepFrom;
      } else {
        this.bufferLen = 0;
      }

      const id = ++this.chunkId;
      this.pending++;
      this.worker.postMessage({ type: 'transcribe', audio: slice, id });
    },

    _onMessage(msg) {
      if (!msg) return;
      if (msg.type === 'progress') {
        const total = msg.total || 1;
        const loaded = msg.loaded || 0;
        // Latest-wins on per-file progress — bounces a bit but settles.
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
        // Per-chunk error keeps the pipeline alive; load-time error kills it.
        if (msg.id != null) {
          this.pending = Math.max(0, this.pending - 1);
          if (typeof console !== 'undefined') {
            console.warn('[silence] stt chunk error:', msg.error);
          }
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
        if (text.length >= STT_MIN_CHARS && this._onText) {
          this._onText(text);
        }
        return;
      }
    },

    _emitStatus() {
      if (!this._onStatus) return;
      let stateName = 'idle';
      if (this.unsupported)    stateName = 'unsupported';
      else if (this.loading)   stateName = 'loading';
      else if (this.ready)     stateName = 'ready';
      this._onStatus({
        state: stateName,
        progress: this.loadProgress,
        error: this.loadError,
      });
    },
  };

  // Expose under a stable name so app.js can find it without imports.
  global.silenceWhisper = whisper;
})(typeof window !== 'undefined' ? window : this);
