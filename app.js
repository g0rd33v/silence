/* ============================================================
   Silence · app.js
   ------------------------------------------------------------
   Single-file, no-build-step application logic.
   Organized in clearly marked sections; scan the section banners
   to navigate.

   Sections, in order:
   1.  Config                — tunable constants
   2.  State                 — single global state object
   3.  DOM refs              — cached element lookups
   4.  SVG assets            — icon path constants (single source)
   5.  Utilities             — formatters, date math, dB conversion
   6.  Audio synthesis       — all sounds, generated on demand
   6b. Whisper STT (v1.0)    — Web Worker pipeline
   7.  Starfield             — Steady Night canvas animation
   8.  IndexedDB             — session persistence
   9.  Sensing: microphone   — getUserMedia + RMS-based dB
   10. Sensing: motion       — devicemotion accelerometer deltas
   11. Wake lock             — screen-on while running
   12. Permissions flow      — first-run overlay
   13. Mode selection        — before / after / unwind / sleep / infinity
   14. Steady Night          — UI fade-to-starfield transition
   15. Pause state machine   — enterPause / exitPause
   16. Timer + sensing loop  — the tick function
   17. Session lifecycle     — start / complete / close
   18. Summary modal         — post-session with rating
   19. Log rendering         — stats panel (bar chart + entries)
   20. Wire                 — event handlers
   21. Boot                 — init sequence
   ============================================================ */

'use strict';

// ============================================================
// 1. Config
// ============================================================
const CONFIG = {
  MOTION_THRESHOLD:       0.6,
  MOTION_GRACE_MS:        800,
  FOCUS_GRACE_MS:         500,     // tab can be blipped briefly
  PAUSE_TIMEOUT_MS:       3 * 60 * 1000, // 3 min -> auto-end

  INFINITY_CAP_SECONDS:   60 * 60, // Infinity sessions end at 1 hour

  NIGHT_THRESHOLD_MS:     10000,  // 10s of verified silence → enter night
  NIGHT_EXIT_FADE_MS:     1200,

  LOG_DAYS:               10,

  // dB conversion tuning — we convert RMS amplitude to dBFS then add
  // a comfort offset so the number reads in a familiar human range
  // (quiet room ~30–40, speech ~55–70). Relative, not calibrated.
  DB_OFFSET:              85,
  DB_FLOOR:               -70,     // clamp silence below this dBFS

  // Dial ring circumference = 2π × 86 (the SVG circle's radius).
  // Cached because stroke-dashoffset animation reads it every frame.
  RING_CIRCUMFERENCE:     540.354,

  // Global output gain for all synthesized audio — one knob for volume
  AUDIO_MASTER_GAIN:      0.22,

  // ----- Voice notes / STT (v1.0) -----
  // Whisper expects 16 kHz mono Float32. We resample on the fly using a
  // simple ratio downsample (audio is already low-frequency speech).
  STT_SAMPLE_RATE:        16000,
  // How long each transcribed slice is, in seconds. Whisper's native
  // receptive field is 30s; we match that.
  STT_CHUNK_SECONDS:      30,
  // How often we drain the buffer and dispatch to the worker. Shorter
  // than the chunk length so we get progressive output. The first slice
  // sent will be padded if the buffer is short.
  STT_DISPATCH_INTERVAL_MS: 30 * 1000,
  // Drop transcripts under this character count — Whisper hallucinates
  // common stock phrases ("Thank you.", "you", ".") on near-silent input.
  STT_MIN_CHARS:          2,
};

// ============================================================
// 1b. Settings — user preferences, persisted to localStorage
// ============================================================
const SETTINGS_KEY = 'silence.settings.v1';
const DEFAULT_SETTINGS = {
  soundPack:  'cosmos',  // 'cosmos' | 'bell' | 'pulse' | 'off'
  haptics:    'on',      // 'on' | 'off'
  voiceNotes: 'ask',     // 'on' | 'ask' | 'off'  (Infinity mode only)
};
const SOUND_PACKS = ['cosmos', 'bell', 'pulse', 'off'];
const VOICE_NOTES_MODES = ['on', 'ask', 'off'];

const settings = {
  _data: null,

  load() {
    if (this._data) return this._data;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Validate and merge with defaults so we never crash on bad data
        this._data = {
          soundPack:  SOUND_PACKS.includes(parsed.soundPack) ? parsed.soundPack : DEFAULT_SETTINGS.soundPack,
          haptics:    parsed.haptics === 'off' ? 'off' : 'on',
          voiceNotes: VOICE_NOTES_MODES.includes(parsed.voiceNotes) ? parsed.voiceNotes : DEFAULT_SETTINGS.voiceNotes,
        };
        return this._data;
      }
    } catch (_) {}
    this._data = { ...DEFAULT_SETTINGS };
    return this._data;
  },

  save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._data)); } catch (_) {}
  },

  get(key) {
    return this.load()[key];
  },

  set(key, value) {
    this.load();
    this._data[key] = value;
    this.save();
  },
};

// ============================================================
// 1c. Haptics — Telegram WebApp HapticFeedback (works on iOS), then
//     Web Vibration API (Android Chrome), then silent no-op.
// ============================================================
//
// iOS Safari does NOT expose navigator.vibrate. iOS Chrome doesn't either
// (it's just a Safari skin on iOS). The only way to deliver real haptics
// on iPhone is through Telegram's WebApp.HapticFeedback bridge, which
// talks to the native iOS Taptic Engine.
//
// Strategy, in priority order:
//   1. Telegram WebApp.HapticFeedback (best — works iOS + Android in TG)
//   2. navigator.vibrate (Android Chrome / Firefox / Edge outside TG)
//   3. Silent no-op (iOS Safari, desktop, anywhere unsupported)
//
// Desktop returns true from navigator.vibrate but has no motor — that's
// expected and harmless. We just don't claim "haptics work" without a
// way to actually verify. The settings toggle is still a real switch.
const haptics = {
  // Telegram bridge if present. ready() just signals we've initialized;
  // safe to call multiple times.
  _tg() {
    const tg = (typeof window !== 'undefined') && window.Telegram && window.Telegram.WebApp;
    if (tg && tg.HapticFeedback) {
      try { tg.ready(); } catch (_) {}
      return tg.HapticFeedback;
    }
    return null;
  },

  // For diagnostics — what backend will we actually use right now?
  // Returns 'telegram' | 'vibrate' | 'none'.
  backend() {
    if (this._tg()) return 'telegram';
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') return 'vibrate';
    return 'none';
  },

  // Internal dispatcher — every named pattern routes through here.
  // 'kind' is one of: 'tap', 'short', 'medium', 'success'.
  fire(kind) {
    if (settings.get('haptics') !== 'on') return;
    const tg = this._tg();
    if (tg) {
      try {
        if (kind === 'success')      tg.notificationOccurred('success');
        else if (kind === 'tap')     tg.selectionChanged();
        else if (kind === 'short')   tg.impactOccurred('light');
        else if (kind === 'medium')  tg.impactOccurred('medium');
      } catch (_) {}
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      const pattern =
        kind === 'success' ? [40, 80, 40] :
        kind === 'tap'     ? 15 :
        kind === 'short'   ? 20 :
        kind === 'medium'  ? 40 : 0;
      try { navigator.vibrate(pattern); } catch (_) {}
    }
  },

  // Named callsites — never fire raw values from app code.
  tap()       { this.fire('tap'); },
  short()     { this.fire('short'); },
  medium()    { this.fire('medium'); },
  success()   { this.fire('success'); },
};

// ============================================================
// 2. State
// ============================================================
const state = {
  mode: 'unwind',
  duration: 20 * 60,

  running: false,
  paused: false,
  startedAt: null,
  elapsed: 0,                // silent seconds accumulated
  lastTickAt: null,

  // Sensing
  micEnabled: false,
  motionEnabled: false,
  audioCtx: null,
  analyser: null,
  micStream: null,
  currentLevel: 0,
  currentMotion: 0,
  motionSince: null,
  focusLostSince: null,

  // Pause tracking
  pausedAt: null,            // ms timestamp when paused
  pauseReason: null,         // 'tap' | 'motion' | 'focus'
  pauseTimeoutId: null,
  pausedTotalMs: 0,          // cumulative paused duration in ms, saved with session
  interruptionCount: 0,

  // Noise accumulators
  dbSum: 0,                  // sum of per-tick dB readings
  dbSamples: 0,              // count of readings
  dbPeak: -Infinity,

  // Steady night
  silenceContinuousSince: null,
  night: false,

  wakeLock: null,
  sensingFrame: null,
  currentSessionId: null,  // id of the session just completed, for rating update

  // Voice notes
  voiceNotesEnabled: false,  // true = transcribe during this session
  voiceNotesText:    '',     // appended-to by STT chunks

  // STT (v1.0) — Web Audio nodes for the worker tap, set in startMic
  micSourceNode:  null,     // MediaStreamSource for both analyser and STT
  sttProcessor:   null,     // ScriptProcessor pumping samples to whisper
  sttSink:        null,     // muted gain node so the processor actually fires
};

// ============================================================
// 3. DOM refs
// ============================================================
const $ = (id) => document.getElementById(id);
const dom = {
  modes:          $('modes'),
  dial:           $('dial'),
  dialBtn:        $('dialBtn'),
  dialLabel:      $('dialLabel'),
  dialTime:       $('dialTime'),
  ringProgress:   $('ringProgress'),
  startBtn:       $('startBtn'),
  stopBtn:        $('stopBtn'),
  status:         $('status'),
  statusDot:      $('statusDot'),
  statusText:     $('statusText'),

  night:          $('night'),
  nightSky:       $('nightSky'),

  permOverlay:    $('permOverlay'),
  permGrant:      $('permGrant'),
  permSkip:       $('permSkip'),

  logBtn:         $('logBtn'),
  logOverlay:     $('logOverlay'),
  logClose:       $('logClose'),
  logChart:       $('logChart'),
  logList:        $('logList'),
  logSub:         $('logSub'),
  totalWeek:      $('totalWeek'),
  totalSessions:  $('totalSessions'),
  longestSession: $('longestSession'),

  summaryOverlay:    $('summaryOverlay'),
  summaryModeIcon:   $('summaryModeIcon'),
  summaryTitle:      $('summaryTitle'),
  summarySub:        $('summarySub'),
  summaryDuration:   $('summaryDuration'),
  summaryInterrupted:$('summaryInterrupted'),
  summaryAvgDb:      $('summaryAvgDb'),
  summaryPeakDb:     $('summaryPeakDb'),
  ratingPrompt:      $('ratingPrompt'),
  ratingStars:       $('ratingStars'),
  ratingSkip:        $('ratingSkip'),

  soundPackChips:    $('soundPackChips'),
  hapticsToggle:     $('hapticsToggle'),
  hapticsHint:       $('hapticsHint'),

  voiceNotesChips:   $('voiceNotesChips'),
  vnConfirmOverlay:  $('vnConfirmOverlay'),
  vnYesSession:      $('vnYesSession'),
  vnAlwaysOn:        $('vnAlwaysOn'),
  vnNotThisTime:     $('vnNotThisTime'),
};

// NOTE: This file is the v1.0 build. Body continues below — full source is
// being committed in two parts due to MCP transport size limits. See the
// follow-up commit on this branch for sections 5 onward.
// PLACEHOLDER — DO NOT DEPLOY THIS COMMIT IN ISOLATION.
