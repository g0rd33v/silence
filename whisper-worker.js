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

// Model identity. whisper-tiny multilingual.
const MODEL_ID = 'Xenova/whisper-tiny';

let transcriber = null;
let loading = false;

async function loadPipeline() {
  if (transcriber) return transcriber;
  if (loading) {
    while (loading) await new Promise((r) => setTimeout(r, 50));
    return transcriber;
  }
  loading = true;

  try {
    let device = 'wasm';
    try {
      if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
        device = 'webgpu';
      }
    } catch (_) {}

    try {
      transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
        device,
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
    } catch (gpuErr) {
      // WebGPU failed — retry on WASM
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
    try { await loadPipeline(); } catch (_) { return; }
  }
  if (!audio || audio.length === 0) {
    self.postMessage({ type: 'result', text: '', id });
    return;
  }

  try {
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
