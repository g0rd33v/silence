/* ============================================================
   Silence · whisper-worker.js
   ------------------------------------------------------------
   Web Worker for on-device speech-to-text.

   Runs OpenAI Whisper-tiny (~40MB, multilingual) via
   transformers.js v3. WebGPU when available, WASM fallback.
   Model is fetched once on first opt-in, then cached by the
   browser's Cache API for subsequent sessions.

   Lives off the main thread because Whisper inference is CPU-
   heavy enough to cause UI jank (especially the WASM path on
   iOS Safari).

   Protocol — main → worker:
     { type: 'load' }                   request model load
     { type: 'transcribe', audio, id }  audio = Float32Array @ 16kHz
                                         id = monotonic chunk id
     { type: 'shutdown' }               release the pipeline

   Protocol — worker → main:
     { type: 'progress', loaded, total, file } during model fetch
     { type: 'ready' }                          model loaded, idle
     { type: 'error', error }                   any failure
     { type: 'result', text, id }               transcription done
   ============================================================ */

// transformers.js v3 — pinned major. Loaded from jsdelivr to keep
// install identical to the cached service-worker assets we ship.
import {
  pipeline,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/dist/transformers.min.js';

// We always pull from the HF Hub (no local model files in the repo);
// transformers.js will cache the ONNX shards in the browser Cache API.
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Model identity. whisper-tiny multilingual. Quantized = q8 for the
// fp32 default; we leave dtype unset so the library picks the best
// quant for the chosen device automatically.
const MODEL_ID = 'Xenova/whisper-tiny';

// Whisper expects 16kHz mono Float32 audio. The main thread is
// responsible for resampling. Anything non-conforming is rejected.
const SAMPLE_RATE = 16000;

// Transcriber instance. Created once per worker lifetime.
let transcriber = null;
let loading = false;

async function loadPipeline() {
  if (transcriber) return transcriber;
  if (loading) {
    // De-dupe: if a load is already in-flight, just wait for it
    while (loading) await new Promise((r) => setTimeout(r, 50));
    return transcriber;
  }
  loading = true;

  try {
    // Try WebGPU first — much faster on supported devices. Fall back to
    // WASM (the default) on failure. We don't try to detect WebGPU
    // ourselves; let transformers.js try and we catch the throw.
    let device = 'wasm';
    try {
      // Feature detect via a soft check. Real init happens in pipeline().
      if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
        device = 'webgpu';
      }
    } catch (_) {}

    try {
      transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
        device,
        progress_callback: (p) => {
          // Library emits {status, name, file, loaded, total, progress}
          if (p && p.status === 'progress') {
            self.postMessage({
              type: 'progress',
              loaded: p.loaded || 0,
              total: p.total || 0,
              file: p.file || '',
            });
          }
        },
      });
    } catch (gpuErr) {
      // WebGPU failed (driver, OS, browser flag) — retry on WASM
      if (device === 'webgpu') {
        transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
          device: 'wasm',
          progress_callback: (p) => {
            if (p && p.status === 'progress') {
              self.postMessage({
                type: 'progress',
                loaded: p.loaded || 0,
                total: p.total || 0,
                file: p.file || '',
              });
            }
          },
        });
      } else {
        throw gpuErr;
      }
    }

    self.postMessage({ type: 'ready' });
    return transcriber;
  } catch (e) {
    self.postMessage({ type: 'error', error: e && e.message ? e.message : String(e) });
    transcriber = null;
    throw e;
  } finally {
    loading = false;
  }
}

async function transcribe(audio, id) {
  if (!transcriber) {
    // Should not happen — main thread waits for 'ready' before sending.
    // Defensive load anyway.
    try { await loadPipeline(); } catch (_) { return; }
  }
  if (!audio || audio.length === 0) {
    self.postMessage({ type: 'result', text: '', id });
    return;
  }

  try {
    // chunk_length_s = 30 matches Whisper's native receptive field.
    // For our 30-second slices, no internal chunking is needed but we
    // pass the param explicitly so the lib's long-form path is happy.
    // language: undefined = auto-detect (multilingual model).
    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    });
    const text = (out && typeof out.text === 'string') ? out.text.trim() : '';
    self.postMessage({ type: 'result', text, id });
  } catch (e) {
    self.postMessage({
      type: 'error',
      error: e && e.message ? e.message : String(e),
      id,
    });
  }
}

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'load') {
    try { await loadPipeline(); } catch (_) {}
    return;
  }
  if (msg.type === 'transcribe') {
    await transcribe(msg.audio, msg.id);
    return;
  }
  if (msg.type === 'shutdown') {
    transcriber = null;
    return;
  }
});
