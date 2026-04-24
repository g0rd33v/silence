/* ================================================================
   Silence · whisper-worker.js  (v1.4 hardened)
   ----------------------------------------------------------------
   Web Worker hosting transformers.js + Whisper for on-device STT.

   Design goals (v1.4):
     • Never freeze the main thread: all expensive work is isolated
       here. Main thread only posts audio + awaits messages.
     • Never leak the GPU: if the WebGPU device is lost, we mark
       the pipeline dead and the main thread can rebuild us.
     • Always surface failure: every unexpected path posts a
       structured 'error' message that the UI can show.
     • Be observable: we post diag messages the main thread records
       in a ring buffer (adapter info, chunk timings, backend).

   Protocol (main → worker):
     { type: 'load', opts? }          start model fetch + pipeline init
                                       opts.forceBackend: 'webgpu' | 'wasm'
                                       opts.modelId: override model id
     { type: 'transcribe', audio, id, language, deadlineMs? }
     { type: 'probe' }                post 'diag' with gpu probe
     { type: 'shutdown' }             drop the pipeline ref
     { type: 'ping' }                 'pong' back with uptime

   Protocol (worker → main):
     { type: 'progress', loaded, total, file }
     { type: 'ready', backend, model, loadMs }
     { type: 'diag', payload }         capability / health snapshot
     { type: 'result', text, id, ms }  one chunk done
     { type: 'error', error, id?, where } structured failures
     { type: 'pong', uptimeMs }
   ================================================================ */

'use strict';

const BOOT_TS = Date.now();
const log = (...a) => { try { console.log('[silence/worker]', ...a); } catch (_) {} };

// State
let transcriber = null;
let backend = null;          // 'webgpu' | 'wasm' | null
let loading = false;
let loadErr = null;
let lastLoadMs = 0;
let deviceLostCount = 0;
let adapterInfo = null;      // cached GPU probe
let transformersMod = null;
let modelId = 'Xenova/whisper-small';

// Chunk-level metrics (ring, cap 32)
const perf = [];
function pushPerf(entry) {
  perf.push(entry);
  if (perf.length > 32) perf.shift();
}
function perfSnapshot() {
  const done = perf.filter(p => typeof p.ms === 'number');
  const avg = done.length ? Math.round(done.reduce((s, p) => s + p.ms, 0) / done.length) : null;
  const last = done.length ? done[done.length - 1].ms : null;
  const errors = perf.filter(p => p.error).length;
  return { count: perf.length, avgMs: avg, lastMs: last, errors, recent: perf.slice(-8) };
}

/* ---- WebGPU probe --------------------------------------------- */
async function probeGpu() {
  const out = {
    hasApi: typeof navigator !== 'undefined' && !!navigator.gpu,
    adapter: null,
    adapterInfo: null,
    limits: null,
    features: [],
    error: null,
  };
  if (!out.hasApi) return out;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { out.error = 'no-adapter'; return out; }
    out.adapter = true;
    try {
      const info = (adapter.requestAdapterInfo && await adapter.requestAdapterInfo()) || {};
      out.adapterInfo = {
        vendor: info.vendor || '',
        architecture: info.architecture || '',
        device: info.device || '',
        description: info.description || '',
      };
    } catch (_) {}
    try {
      const lims = adapter.limits || {};
      out.limits = {
        maxBufferSize: lims.maxBufferSize,
        maxStorageBufferBindingSize: lims.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: lims.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: lims.maxComputeInvocationsPerWorkgroup,
      };
    } catch (_) {}
    try {
      out.features = Array.from(adapter.features || []);
    } catch (_) {}
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}

/* ---- transformers.js dynamic import ----------------------------
   Pinned version. We import lazily so a CDN outage only breaks STT,
   not the whole page, and so we can fall back cleanly to WASM-only
   if WebGPU throws during pipeline construction.
---------------------------------------------------------------- */
const TRANSFORMERS_VERSION = '3.0.0';
const TRANSFORMERS_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@' +
  TRANSFORMERS_VERSION +
  '/dist/transformers.min.js';

async function ensureTransformers() {
  if (transformersMod) return transformersMod;
  const t0 = performance.now();
  try {
    const m = await import(TRANSFORMERS_URL);
    m.env.allowLocalModels = false;
    m.env.allowRemoteModels = true;
    // Hint to transformers.js that shards may be cached by the SW later.
    try { m.env.useBrowserCache = true; } catch (_) {}
    transformersMod = m;
    self.postMessage({
      type: 'diag',
      payload: {
        kind: 'transformers-loaded',
        version: TRANSFORMERS_VERSION,
        url: TRANSFORMERS_URL,
        ms: Math.round(performance.now() - t0),
      },
    });
    return m;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    self.postMessage({
      type: 'error',
      where: 'transformers-import',
      error: msg,
    });
    throw new Error('transformers.js failed to load: ' + msg);
  }
}

/* ---- Pipeline load with backend choice + fallback ------------- */
async function loadPipeline(opts) {
  opts = opts || {};
  if (opts.modelId) modelId = opts.modelId;
  if (transcriber && !opts.force) return transcriber;
  if (loading) {
    // Park until the in-flight load completes.
    const deadline = Date.now() + 120000;
    while (loading && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    return transcriber;
  }
  loading = true;
  loadErr = null;
  const t0 = performance.now();

  try {
    const mod = await ensureTransformers();

    // Choose backend. Respect an explicit override; else probe.
    let chosen = opts.forceBackend || null;
    if (!chosen) {
      const gpu = await probeGpu();
      adapterInfo = gpu;
      self.postMessage({ type: 'diag', payload: { kind: 'gpu-probe', gpu } });
      chosen = (gpu.hasApi && gpu.adapter) ? 'webgpu' : 'wasm';
    }

    const progress_callback = (p) => {
      if (!p) return;
      if (p.status === 'progress') {
        self.postMessage({
          type: 'progress',
          loaded: p.loaded || 0,
          total: p.total || 0,
          file: p.file || '',
        });
      } else if (p.status === 'ready') {
        // transformers.js fires 'ready' per-asset; we ignore per-asset.
      }
    };

    try {
      transcriber = await mod.pipeline('automatic-speech-recognition', modelId, {
        device: chosen,
        progress_callback,
      });
      backend = chosen;
    } catch (e1) {
      const msg1 = (e1 && e1.message) || String(e1);
      self.postMessage({
        type: 'diag',
        payload: { kind: 'backend-failed', backend: chosen, error: msg1 },
      });
      if (chosen === 'webgpu') {
        // Retry on WASM once.
        transcriber = await mod.pipeline('automatic-speech-recognition', modelId, {
          device: 'wasm',
          progress_callback,
        });
        backend = 'wasm';
      } else {
        throw e1;
      }
    }

    lastLoadMs = Math.round(performance.now() - t0);
    self.postMessage({ type: 'ready', backend, model: modelId, loadMs: lastLoadMs });
    return transcriber;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    loadErr = msg;
    transcriber = null;
    backend = null;
    self.postMessage({ type: 'error', where: 'pipeline-load', error: msg });
    throw e;
  } finally {
    loading = false;
  }
}

/* ---- Transcribe one chunk with timeout + metrics -------------- */
async function transcribe(audio, id, language, deadlineMs) {
  const started = performance.now();
  const entry = { id, ts: Date.now(), samples: audio ? audio.length : 0, error: null, ms: null, backend };
  pushPerf(entry);

  if (!audio || audio.length === 0) {
    entry.ms = Math.round(performance.now() - started);
    self.postMessage({ type: 'result', text: '', id, ms: entry.ms, backend });
    return;
  }

  try {
    if (!transcriber) {
      await loadPipeline();
    }
    if (!transcriber) throw new Error('pipeline-unavailable');

    const opts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    };
    if (language && language !== 'auto') {
      opts.language = language;
      opts.task = 'transcribe';
    }

    // Run with a deadline so a GPU stall can't hang the worker forever.
    const limit = Math.max(5000, deadlineMs || 90000);
    const run = transcriber(audio, opts);
    const timeout = new Promise((_r, rej) =>
      setTimeout(() => rej(new Error('chunk-timeout-' + limit + 'ms')), limit));
    const out = await Promise.race([run, timeout]);

    const text = (out && typeof out.text === 'string') ? out.text.trim() : '';
    entry.ms = Math.round(performance.now() - started);
    entry.chars = text.length;
    self.postMessage({ type: 'result', text, id, ms: entry.ms, backend });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    entry.error = msg;
    entry.ms = Math.round(performance.now() - started);
    // Treat timeouts / device loss as "backend dead" -> force rebuild next time.
    if (/timeout|lost|destroy/i.test(msg)) {
      transcriber = null;
      deviceLostCount++;
      self.postMessage({
        type: 'diag',
        payload: { kind: 'backend-dropped', reason: msg, deviceLostCount },
      });
    }
    self.postMessage({ type: 'error', where: 'transcribe', error: msg, id });
  }
}

/* ---- Message dispatch ----------------------------------------- */
self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') {
      try { await loadPipeline(msg.opts || {}); } catch (_) {}
      return;
    }
    if (msg.type === 'transcribe') {
      await transcribe(msg.audio, msg.id, msg.language, msg.deadlineMs);
      return;
    }
    if (msg.type === 'probe') {
      const gpu = await probeGpu();
      adapterInfo = gpu;
      self.postMessage({ type: 'diag', payload: { kind: 'gpu-probe', gpu } });
      return;
    }
    if (msg.type === 'shutdown') {
      transcriber = null;
      backend = null;
      return;
    }
    if (msg.type === 'ping') {
      self.postMessage({
        type: 'pong',
        uptimeMs: Date.now() - BOOT_TS,
        backend,
        hasPipeline: !!transcriber,
        loading,
        loadErr,
        lastLoadMs,
        deviceLostCount,
        adapterInfo,
        modelId,
        perf: perfSnapshot(),
      });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      where: 'dispatch:' + (msg && msg.type),
      error: (err && err.message) || String(err),
    });
  }
});

// Catch-all for anything that escapes the try/catch.
self.addEventListener('error', (ev) => {
  try {
    self.postMessage({
      type: 'error',
      where: 'worker-error',
      error: (ev && ev.message) || 'worker error',
    });
  } catch (_) {}
});
self.addEventListener('unhandledrejection', (ev) => {
  try {
    const r = ev && ev.reason;
    self.postMessage({
      type: 'error',
      where: 'worker-unhandledrejection',
      error: (r && r.message) || String(r || 'unhandled rejection'),
    });
  } catch (_) {}
});

log('worker boot v1.4, pid ts=' + BOOT_TS);
