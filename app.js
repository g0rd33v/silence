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

  // Voice notes (v0.9 UI-only; STT arrives in v1.0)
  voiceNotesEnabled: false,  // true = transcribe during this session
  voiceNotesText:    '',     // appended-to by STT in v1.0; stays '' in v0.9
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

// ============================================================
// 5. Utilities
// ============================================================
function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '∞';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Strict HTML-escape for user-captured text (voice notes). We build log
// entry markup via template strings, so raw transcript text must be escaped
// before it hits innerHTML. Covers the five characters that matter.
function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Notebook glyph used in the log-entry voice notes badge.
const NOTEBOOK_SVG_INLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6.5A1.5 1.5 0 0 1 5 19.5v-15z"/><path d="M9 7h7M9 11h7M9 15h4"/></svg>';

function fmtDuration(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function fmtTotal(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ts) {
  const d = new Date(ts);
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return days[d.getDay()];
}

function fullDateLabel(ts) {
  const d = new Date(ts);
  const today = startOfDay();
  const yesterday = today - 86400000;
  const thisDay = startOfDay(d);
  if (thisDay === today) return 'Today';
  if (thisDay === yesterday) return 'Yesterday';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function timeOfDay(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Convert normalized audio level (0..1) to relative dB.
// 0 -> returns DB_FLOOR (silence)
// 1 -> returns ~90 dB
function levelToDb(level) {
  if (level <= 0) return CONFIG.DB_FLOOR + CONFIG.DB_OFFSET;
  const dbfs = 20 * Math.log10(level);
  const clamped = Math.max(CONFIG.DB_FLOOR, dbfs);
  return clamped + CONFIG.DB_OFFSET;
}

// ============================================================
// 4. SVG assets (single source, populated into empty HTML slots at boot)
// ============================================================
function modeIconSVG(mode, size = 20) {
  const common = `viewBox="0 0 32 32" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"`;
  switch (mode) {
    case 'before':
      return `<svg ${common}><path d="M10 18a6 6 0 0 1 12 0"/><line x1="16" y1="7" x2="16" y2="10"/><line x1="8" y1="10" x2="10" y2="12"/><line x1="22" y1="12" x2="24" y2="10"/><line x1="5" y1="18" x2="8" y2="18"/><line x1="24" y1="18" x2="27" y2="18"/><line x1="4" y1="22" x2="28" y2="22"/></svg>`;
    case 'after':
      return `<svg ${common}><path d="M10 19a6 6 0 0 1 12 0"/><line x1="16" y1="10" x2="16" y2="13"/><line x1="9" y1="13" x2="11" y2="15"/><line x1="21" y1="15" x2="23" y2="13"/><line x1="6" y1="19" x2="8" y2="19"/><line x1="24" y1="19" x2="26" y2="19"/><line x1="4" y1="22" x2="28" y2="22"/><line x1="4" y1="25" x2="28" y2="25" opacity=".5"/></svg>`;
    case 'unwind':
      return `<svg ${common}><circle cx="16" cy="16" r="10.5"/><circle cx="16" cy="16" r="7"/><circle cx="16" cy="16" r="3.5"/><circle cx="16" cy="16" r="1" fill="currentColor" stroke="none"/></svg>`;
    case 'sleep':
      return `<svg ${common}><path d="M24 19a9 9 0 1 1-10-13 7 7 0 0 0 10 13z"/></svg>`;
    case 'infinity':
      return `<svg ${common}><path d="M22.5 20c-2 0-3.2-1.6-4-3l-3-5c-.8-1.4-2-3-4-3a4 4 0 0 0 0 8c2 0 3.2-1.6 4-3l3-5c.8-1.4 2-3 4-3a4 4 0 0 1 0 8z"/></svg>`;
    default:
      return '';
  }
}

// ----- Single source for the star icon (used in rating UI, bar chart, log entries)
const STAR_PATH = 'M12 2.5l2.9 6.6 7.1 0.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-0.7z';

function starSVG(size, strokeWidth = 1.4) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`;
}

// 100%-sized version for the small inline star spans (bar chart, log entries)
const STAR_SVG_INLINE = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

// Small glyphs used in the mode row (Sleep lock, Infinity circle)
const LOCK_SVG = `<svg viewBox="0 0 14 18" width="12" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="8" width="10" height="8" rx="1.5"/><path d="M4.5 8V5a2.5 2.5 0 0 1 5 0v3"/></svg>`;
const CIRCLE_SVG = `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><circle cx="7" cy="7" r="5.5"/></svg>`;

// Inject static icons once at boot, using the single source above. The
// HTML ships with empty slots — JS fills them. Keeps copy-paste out of
// the markup.
function populateStaticIcons() {
  // Mode buttons: each .mode has an empty .mode-icon that we fill.
  document.querySelectorAll('.mode').forEach((btn) => {
    const mode = btn.dataset.mode;
    const slot = btn.querySelector('.mode-icon');
    if (slot) slot.innerHTML = modeIconSVG(mode, 28);
  });

  // Sleep lock + Infinity circle glyphs in the mode-time row
  document.querySelectorAll('[data-icon="lock"]').forEach((el) => {
    el.innerHTML = LOCK_SVG;
  });
  document.querySelectorAll('[data-icon="circle"]').forEach((el) => {
    el.innerHTML = CIRCLE_SVG;
  });

  // Five rating stars in the summary modal
  document.querySelectorAll('#ratingStars .rating-star').forEach((btn) => {
    btn.innerHTML = starSVG(32);
  });
}

// ============================================================
// 6. Audio synthesis — all sounds generated on demand, no assets
// ============================================================
const audio = {
  ctx: null,
  masterGain: null,

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = CONFIG.AUDIO_MASTER_GAIN;
    this.masterGain.connect(this.ctx.destination);
  },

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }
  },

  makeReverb() {
    const delay = this.ctx.createDelay();
    delay.delayTime.value = 0.18;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.35;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.45;
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(this.masterGain);
    return { input: delay, output: wet };
  },

  // Dispatcher — picks an implementation based on the user's sound pack.
  // 'off' returns immediately. Each pack-named impl is async so we await
  // init/resume the same way regardless of pack.
  async playStart() {
    const pack = settings.get('soundPack');
    if (pack === 'off') return;
    if (pack === 'bell')   return this._bellStart();
    if (pack === 'pulse')  return this._pulseStart();
    return this._cosmosStart();
  },

  async _cosmosStart() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;

    // Pipe-organ-inspired swell. Stacked low fundamentals with slow attack
    // and long release, plus a quiet high shimmer on top. Cinematic,
    // ceremonial — weight rather than sparkle.
    //
    // Root chord: C2 (65.41), G2 (98.00), C3 (130.81) — open fifth + octave.
    // Harmonics per voice add organ character.
    const voices = [
      { f: 65.41,  gain: 0.30, harm: [1, 2, 3, 4] }, // C2
      { f: 98.00,  gain: 0.22, harm: [1, 2, 3] },    // G2
      { f: 130.81, gain: 0.26, harm: [1, 2, 3] },    // C3
    ];

    const attack  = 1.2;   // slow swell in
    const sustain = 1.8;   // hold
    const release = 1.8;   // slow fade
    const total   = attack + sustain + release;

    voices.forEach((v) => {
      const gainNode = this.ctx.createGain();
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(v.gain, now + attack);
      gainNode.gain.linearRampToValueAtTime(v.gain * 0.75, now + attack + sustain);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + total);

      // Lowpass to soften the organ stack so it feels warm, not thin
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, now);
      filter.frequency.linearRampToValueAtTime(2400, now + attack);
      filter.Q.value = 0.3;

      gainNode.connect(filter);
      filter.connect(this.masterGain);

      // Build organ-style harmonic stack for this voice
      v.harm.forEach((h, idx) => {
        const osc = this.ctx.createOscillator();
        osc.type = idx === 0 ? 'sine' : idx === 1 ? 'triangle' : 'sine';
        osc.frequency.value = v.f * h;
        const voiceGain = this.ctx.createGain();
        // Each successive harmonic quieter
        voiceGain.gain.value = 1 / (h * h * 0.6);
        osc.connect(voiceGain);
        voiceGain.connect(gainNode);
        osc.start(now);
        osc.stop(now + total + 0.1);
      });
    });

    // High airy whisper on top — like the shimmer in Interstellar's
    // "Cornfield Chase" or "No Time For Caution", kept very quiet.
    const shimmerFreqs = [1046, 1568, 2093]; // C6, G6, C7
    shimmerFreqs.forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const shimmerStart = now + attack * 0.4 + i * 0.15;
      g.gain.setValueAtTime(0, shimmerStart);
      g.gain.linearRampToValueAtTime(0.05, shimmerStart + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, shimmerStart + 2.2);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(shimmerStart);
      osc.stop(shimmerStart + 2.3);
    });
  },

  // Bell pack START — Tibetan-style singing bowl. A single struck tone
  // with rich inharmonic partials and very long decay. Contemplative.
  async _bellStart() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const reverb = this.makeReverb();

    // Fundamental + bell-like inharmonic partials (singing bowl ratios)
    const fundamental = 220; // A3
    const partials = [
      { ratio: 1.0,   gain: 0.30 },
      { ratio: 2.76,  gain: 0.18 },
      { ratio: 5.40,  gain: 0.10 },
      { ratio: 8.93,  gain: 0.05 },
    ];

    partials.forEach((p, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = fundamental * p.ratio;
      // Higher partials decay faster (acoustic realism)
      const decay = 4.5 / (i * 0.6 + 1);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(p.gain, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(g);
      g.connect(this.masterGain);
      g.connect(reverb.input);
      osc.start(now);
      osc.stop(now + decay + 0.1);
    });

    // Soft low warmth underneath
    const sub = this.ctx.createOscillator();
    const sg = this.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = 110; // A2
    sg.gain.setValueAtTime(0, now);
    sg.gain.linearRampToValueAtTime(0.10, now + 0.04);
    sg.gain.exponentialRampToValueAtTime(0.0001, now + 3);
    sub.connect(sg);
    sg.connect(this.masterGain);
    sub.start(now);
    sub.stop(now + 3.1);
  },

  // Pulse pack START — minimalist, single short tone. A modern marker.
  async _pulseStart() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.3);
  },

  // Rating sounds — distinct emotional register per star count.
  // 1 = dull low thud, 5 = bright crystalline glass.
  // These are shared across packs (they're emotional feedback, not ambient
  // atmosphere), but the 'off' pack silences them too.
  async playRating(n) {
    if (settings.get('soundPack') === 'off') return;
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;

    if (n === 1) {
      // Low muffled thud — disappointed
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.5);
      filter.type = 'lowpass';
      filter.frequency.value = 280;
      filter.Q.value = 2;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.30, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.6);
      return;
    }

    if (n === 2) {
      // Soft flat low tone
      const freqs = [196, 294]; // G3 + D4 (perfect fifth, slightly dull)
      freqs.forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = f;
        const delay = i * 0.03;
        g.gain.setValueAtTime(0, now + delay);
        g.gain.linearRampToValueAtTime(0.13, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.7);
        osc.connect(g);
        g.connect(this.masterGain);
        osc.start(now + delay);
        osc.stop(now + delay + 0.75);
      });
      return;
    }

    if (n === 3) {
      // Neutral mid chime — no emotion, just an acknowledgment
      const freqs = [440, 554]; // A4 + C#5 (major third)
      freqs.forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        const delay = i * 0.04;
        g.gain.setValueAtTime(0, now + delay);
        g.gain.linearRampToValueAtTime(0.15, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.85);
        osc.connect(g);
        g.connect(this.masterGain);
        osc.start(now + delay);
        osc.stop(now + delay + 0.9);
      });
      return;
    }

    if (n === 4) {
      // Warm major triad — pleasant
      const reverb = this.makeReverb();
      const freqs = [523, 659, 784]; // C5, E5, G5
      freqs.forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        const delay = i * 0.05;
        g.gain.setValueAtTime(0, now + delay);
        g.gain.linearRampToValueAtTime(0.16, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.1);
        osc.connect(g);
        g.connect(this.masterGain);
        g.connect(reverb.input);
        osc.start(now + delay);
        osc.stop(now + delay + 1.2);
      });
      return;
    }

    if (n === 5) {
      // Bright crystalline glass — uplifting, harmonic rich
      const reverb = this.makeReverb();
      // C major arpeggio rising + high harmonic shimmer
      const notes = [
        [1046, 0.00], // C6
        [1318, 0.06], // E6
        [1568, 0.12], // G6
        [2093, 0.20], // C7
        [2637, 0.28], // E7
        [3136, 0.36], // G7 — final bell
      ];
      notes.forEach(([f, delay]) => {
        // Fundamental
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, now + delay);
        g.gain.linearRampToValueAtTime(0.18, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.6);
        osc.connect(g);
        g.connect(this.masterGain);
        g.connect(reverb.input);
        osc.start(now + delay);
        osc.stop(now + delay + 1.7);

        // Harmonic shimmer — 2.0009 ratio gives a glass-like beat
        const harm = this.ctx.createOscillator();
        const hg = this.ctx.createGain();
        harm.type = 'sine';
        harm.frequency.value = f * 2.0009;
        hg.gain.setValueAtTime(0, now + delay);
        hg.gain.linearRampToValueAtTime(0.05, now + delay + 0.04);
        hg.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.0);
        harm.connect(hg);
        hg.connect(this.masterGain);
        harm.start(now + delay);
        harm.stop(now + delay + 1.1);
      });
      return;
    }
  },

  // Zoom-out — played when a session pauses (tap or motion).
  async playZoomOut() {
    const pack = settings.get('soundPack');
    if (pack === 'off') return;
    if (pack === 'bell')   return this._bellZoomOut();
    if (pack === 'pulse')  return this._pulseZoomOut();
    return this._cosmosZoomOut();
  },

  // Cosmos zoom-out: descending pitch glide with filter closing down.
  // Feels like the UI retreating: sound pulls back with it.
  async _cosmosZoomOut() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const dur = 0.9;

    // Two detuned sine voices — an octave apart, both sliding down
    const voices = [
      { fStart: 880, fEnd: 220, gain: 0.16 },
      { fStart: 440, fEnd: 110, gain: 0.12 },
    ];

    voices.forEach((v) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(v.fStart, now);
      osc.frequency.exponentialRampToValueAtTime(v.fEnd, now + dur);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3200, now);
      filter.frequency.exponentialRampToValueAtTime(400, now + dur);
      filter.Q.value = 0.7;

      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(v.gain, now + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      osc.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + dur + 0.05);
    });
  },

  // Bell zoom-out: muted struck tone with quick decay. The bowl is hushed.
  async _bellZoomOut() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(330, now);
    osc.frequency.exponentialRampToValueAtTime(165, now + 0.6);
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 1.5;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.75);
  },

  // Pulse zoom-out: single short low click.
  async _pulseZoomOut() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 330;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.15);
  },

  // Zoom-in — played when a paused session resumes.
  async playZoomIn() {
    const pack = settings.get('soundPack');
    if (pack === 'off') return;
    if (pack === 'bell')   return this._bellZoomIn();
    if (pack === 'pulse')  return this._pulseZoomIn();
    return this._cosmosZoomIn();
  },

  // Cosmos zoom-in: mirror of cosmos zoom-out, pitch rising, filter
  // opening, volume arriving rather than leaving.
  async _cosmosZoomIn() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const dur = 0.9;

    const voices = [
      { fStart: 220, fEnd: 880, gain: 0.16 },
      { fStart: 110, fEnd: 440, gain: 0.12 },
    ];

    voices.forEach((v) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(v.fStart, now);
      osc.frequency.exponentialRampToValueAtTime(v.fEnd, now + dur);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(400, now);
      filter.frequency.exponentialRampToValueAtTime(3200, now + dur);
      filter.Q.value = 0.7;

      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(v.gain, now + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.2);

      osc.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + dur + 0.25);
    });
  },

  // Bell zoom-in: brief warm tone, the room gathering itself back.
  async _bellZoomIn() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(165, now);
    osc.frequency.exponentialRampToValueAtTime(330, now + 0.5);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.9);
  },

  // Pulse zoom-in: single short high click — a marker, mirror of zoom-out.
  async _pulseZoomIn() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.15);
  },

  async playFinish() {
    const pack = settings.get('soundPack');
    if (pack === 'off') return;
    if (pack === 'bell')   return this._bellFinish();
    if (pack === 'pulse')  return this._pulseFinish();
    return this._cosmosFinish();
  },

  async _cosmosFinish() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const reverb = this.makeReverb();
    const notes = [[1318, 0.00], [1046, 0.25], [880, 0.50]];
    notes.forEach(([freq, delay]) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(0.22, now + delay + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 2.2);
      osc.connect(gain);
      gain.connect(this.masterGain);
      gain.connect(reverb.input);
      osc.start(now + delay);
      osc.stop(now + delay + 2.4);
    });
  },

  // Bell pack FINISH — single struck bowl, longer than start, ascending
  // partial decay so the room "breathes out".
  async _bellFinish() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const reverb = this.makeReverb();
    const fundamental = 196; // G3 — slightly lower than start, downward resolve
    const partials = [
      { ratio: 1.0,   gain: 0.32 },
      { ratio: 2.76,  gain: 0.20 },
      { ratio: 5.40,  gain: 0.10 },
      { ratio: 8.93,  gain: 0.05 },
    ];
    partials.forEach((p, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = fundamental * p.ratio;
      const decay = 5.5 / (i * 0.5 + 1);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(p.gain, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(g);
      g.connect(this.masterGain);
      g.connect(reverb.input);
      osc.start(now);
      osc.stop(now + decay + 0.1);
    });
  },

  // Pulse pack FINISH — two short ascending ticks, no reverb. Modern.
  async _pulseFinish() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    [[660, 0.00], [990, 0.18]].forEach(([f, d]) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, now + d);
      g.gain.linearRampToValueAtTime(0.16, now + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.22);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now + d);
      osc.stop(now + d + 0.25);
    });
  },
};

// ============================================================
// 7. Starfield — Steady Night canvas animation
// ============================================================
const stars = {
  canvas: null,
  ctx: null,
  dots: [],
  rafId: null,
  running: false,

  init() {
    this.canvas = dom.nightSky;
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.seed();
  },

  resize() {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.scale(dpr, dpr);
  },

  seed() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const count = Math.floor((w * h) / 14000);
    this.dots = [];
    for (let i = 0; i < count; i++) {
      this.dots.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.2 + 0.3,
        baseAlpha: Math.random() * 0.65 + 0.2,
        phase: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.7,
      });
    }
  },

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      const dt = (now - last) / 1000;
      last = now;
      this.draw(now / 1000, dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  },

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  },

  draw(t, dt) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.clearRect(0, 0, w, h);
    for (const d of this.dots) {
      d.phase += dt * d.speed;
      const twinkle = 0.5 + 0.5 * Math.sin(d.phase);
      const alpha = d.baseAlpha * (0.4 + 0.6 * twinkle);
      this.ctx.beginPath();
      this.ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      this.ctx.fill();
      d.x += dt * 1.5 * (0.5 - (d.x / w));
    }
  }
};

// ============================================================
// 8. IndexedDB — session persistence
// ============================================================
const db = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('silence', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('sessions')) {
          const store = d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          store.createIndex('startedAt', 'startedAt');
        }
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async add(session) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('sessions', 'readwrite');
      const req = tx.objectStore('sessions').add(session);
      req.onsuccess = () => resolve(req.result); // id
      req.onerror = () => reject(req.error);
    });
  },
  async update(session) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async getById(id) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getSince(ts) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const range = IDBKeyRange.lowerBound(ts);
      const req = store.index('startedAt').getAll(range);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
};

// ============================================================
// 9. Sensing: microphone
// ============================================================
async function startMic() {
  if (state.micEnabled) return true;
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioCtx.createMediaStreamSource(state.micStream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyser.smoothingTimeConstant = 0.85;
    source.connect(state.analyser);
    state.micEnabled = true;
    return true;
  } catch (e) {
    console.warn('[silence] mic unavailable:', e.message);
    return false;
  }
}

function readMicLevel() {
  if (!state.analyser) return 0;
  // Time-domain float data gives us true audio amplitude (-1..1).
  // RMS over the buffer is a stable measure of loudness.
  const buf = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    sumSq += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sumSq / buf.length);
  return rms; // roughly 0..1
}

// ============================================================
// 10. Sensing: motion
// ============================================================
let lastAccel = { x: 0, y: 0, z: 0 };

function motionHandler(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a || a.x == null) return;
  const dx = (a.x || 0) - lastAccel.x;
  const dy = (a.y || 0) - lastAccel.y;
  const dz = (a.z || 0) - lastAccel.z;
  const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);
  state.currentMotion = state.currentMotion * 0.7 + delta * 0.3;
  lastAccel = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
}

async function startMotion() {
  if (state.motionEnabled) return true;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') return false;
    }
    window.addEventListener('devicemotion', motionHandler);
    state.motionEnabled = true;
    return true;
  } catch (e) {
    console.warn('[silence] motion unavailable:', e.message);
    return false;
  }
}

// ============================================================
// 11. Wake lock
// ============================================================
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (_) {}
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

// ============================================================
// 12. Permissions flow
// ============================================================
function needsPermissionFlow() {
  return localStorage.getItem('silence.permSeen') !== '1';
}

async function showPermissionOverlay() {
  dom.permOverlay.hidden = false;
  await new Promise((resolve) => {
    dom.permGrant.onclick = async () => {
      dom.permGrant.disabled = true;
      dom.permGrant.textContent = 'Requesting…';
      await Promise.all([startMic(), startMotion()]);
      localStorage.setItem('silence.permSeen', '1');
      dom.permOverlay.hidden = true;
      dom.permGrant.disabled = false;
      dom.permGrant.textContent = 'Grant access';
      resolve();
    };
    dom.permSkip.onclick = () => {
      localStorage.setItem('silence.permSeen', '1');
      dom.permOverlay.hidden = true;
      resolve();
    };
  });
}

// ============================================================
// 13. Mode selection
// ============================================================
function selectMode(mode) {
  state.mode = mode;
  dom.modes.querySelectorAll('.mode').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
  });
  const minutes = parseInt(
    dom.modes.querySelector(`.mode[data-mode="${mode}"]`).dataset.minutes, 10
  );
  state.duration = minutes * 60;
  if (!state.running) {
    dom.dialTime.textContent = minutes === 0 ? '∞' : `${String(minutes).padStart(2, '0')}:00`;
  }
}

// ============================================================
// 14. Steady Night transitions
// ============================================================
function enterNight() {
  if (state.night) return;
  state.night = true;
  document.body.classList.add('night-active');
  dom.night.classList.add('active');
  stars.start();
}

function exitNight() {
  if (!state.night) return;
  state.night = false;
  document.body.classList.remove('night-active');
  dom.night.classList.remove('active');
  setTimeout(() => { if (!state.night) stars.stop(); }, CONFIG.NIGHT_EXIT_FADE_MS);
}

// ============================================================
// 15. Pause state machine
// ============================================================
function enterPause(reason) {
  if (!state.running || state.paused) return;
  state.paused = true;
  state.pausedAt = Date.now();
  state.pauseReason = reason;
  state.interruptionCount += 1;
  state.silenceContinuousSince = null;

  if (state.night) exitNight();

  setRunningUI(true, true);
  audio.playZoomOut();
  haptics.short();

  // 3-min auto-end timeout
  state.pauseTimeoutId = setTimeout(() => {
    if (state.paused && state.running) {
      completeSession(false, 'pause-timeout');
    }
  }, CONFIG.PAUSE_TIMEOUT_MS);
}

function exitPause() {
  if (!state.paused) return;
  const now = Date.now();
  state.pausedTotalMs += (now - state.pausedAt);
  state.paused = false;
  state.pausedAt = null;
  state.pauseReason = null;
  if (state.pauseTimeoutId) {
    clearTimeout(state.pauseTimeoutId);
    state.pauseTimeoutId = null;
  }
  state.silenceContinuousSince = now;
  state.motionSince = null;
  state.focusLostSince = null;
  setRunningUI(true, false);
  audio.playZoomIn();
  haptics.medium();
}

// ============================================================
// 16. Timer + sensing loop
// ============================================================
function updateRing() {
  const C = CONFIG.RING_CIRCUMFERENCE;
  let progress = 0;
  if (state.duration > 0) {
    progress = Math.min(state.elapsed / state.duration, 1);
  } else {
    // Infinity — progress against the 60-minute cap
    progress = Math.min(state.elapsed / CONFIG.INFINITY_CAP_SECONDS, 1);
  }
  dom.ringProgress.style.strokeDashoffset = C * (1 - progress);
}

function updateDialTime() {
  if (state.duration === 0) {
    dom.dialTime.textContent = fmtTime(state.elapsed);
  } else {
    const remaining = Math.max(0, state.duration - state.elapsed);
    dom.dialTime.textContent = fmtTime(remaining);
  }
}

function setRunningUI(running, paused = false) {
  dom.dial.classList.toggle('running', running);
  dom.dial.classList.toggle('paused', paused);
  dom.startBtn.hidden = running;
  dom.stopBtn.hidden = !running;
  dom.status.hidden = !running;
  dom.status.classList.toggle('paused', paused);

  if (!running) {
    dom.dialLabel.textContent = 'SILENCE';
  } else if (paused) {
    dom.dialLabel.textContent = 'RESUME';
    dom.statusText.textContent = pauseStatusText();
  } else {
    dom.dialLabel.textContent = 'SILENCE';
    dom.statusText.textContent = 'Listening for silence…';
  }
}

function pauseStatusText() {
  const reasonMap = {
    'tap':    'You tapped the screen',
    'motion': 'Phone moved',
    'focus':  'App in background',
  };
  const base = reasonMap[state.pauseReason] || 'Interrupted';
  if (state.pausedAt) {
    const left = Math.max(0, CONFIG.PAUSE_TIMEOUT_MS - (Date.now() - state.pausedAt));
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    return `${base} · resume within ${mins}:${String(secs).padStart(2, '0')}`;
  }
  return base;
}

function sensingTick() {
  if (!state.running) return;
  const now = Date.now();

  // Mic — sample only when not paused. A paused session's noise is the
  // noise of an interruption (e.g. a phone call), not the ambient the
  // user chose to sit with.
  if (state.micEnabled && !state.paused) {
    state.currentLevel = readMicLevel();
    const db = levelToDb(state.currentLevel);
    state.dbSum += db;
    state.dbSamples += 1;
    if (db > state.dbPeak) state.dbPeak = db;
  }

  // Motion — pauses if threshold sustained past grace
  if (state.motionEnabled) {
    const tooMoving = state.currentMotion > CONFIG.MOTION_THRESHOLD;
    if (tooMoving) {
      if (!state.motionSince) state.motionSince = now;
    } else {
      state.motionSince = null;
    }
    const motionPause = state.motionSince && (now - state.motionSince > CONFIG.MOTION_GRACE_MS);
    if (motionPause && !state.paused) enterPause('motion');
  }

  // Focus — pauses after grace (short blips for notifications don't count)
  if (document.hidden) {
    if (!state.focusLostSince) state.focusLostSince = now;
    const focusPause = (now - state.focusLostSince) > CONFIG.FOCUS_GRACE_MS;
    if (focusPause && !state.paused) enterPause('focus');
  } else {
    state.focusLostSince = null;
  }

  // Accumulate elapsed only when not paused
  if (!state.paused && state.lastTickAt) {
    const dt = (now - state.lastTickAt) / 1000;
    state.elapsed += dt;
  }
  state.lastTickAt = now;

  // Steady night tracking — only accrues while not paused
  if (!state.paused) {
    if (!state.silenceContinuousSince) state.silenceContinuousSince = now;
    const silentFor = now - state.silenceContinuousSince;
    if (!state.night && silentFor >= CONFIG.NIGHT_THRESHOLD_MS) {
      enterNight();
    }
  }

  // Keep paused-status countdown fresh
  if (state.paused) {
    dom.statusText.textContent = pauseStatusText();
  }

  updateDialTime();
  updateRing();

  // Session end conditions:
  // - Timer mode: elapsed hits the target duration
  // - Infinity (duration 0): elapsed hits INFINITY_CAP_SECONDS, ends silently
  if (state.duration > 0 && state.elapsed >= state.duration) {
    completeSession(true, 'complete');
    return;
  }
  if (state.duration === 0 && state.elapsed >= CONFIG.INFINITY_CAP_SECONDS) {
    completeSession(true, 'infinity-cap');
    return;
  }

  state.sensingFrame = requestAnimationFrame(sensingTick);
}

// ============================================================
// 17. Session lifecycle
// ============================================================
// ============================================================
// 17b. Voice notes — confirmation flow (Infinity mode only)
// ============================================================
// Resolves to true (transcribe) or false (don't).
// Called from startSession() before Infinity runs. Non-Infinity modes
// skip this entirely.
function maybeAskVoiceNotes() {
  return new Promise((resolve) => {
    const pref = settings.get('voiceNotes');
    if (pref === 'on')  return resolve(true);
    if (pref === 'off') return resolve(false);

    // 'ask' — show overlay
    if (!dom.vnConfirmOverlay) return resolve(false);
    dom.vnConfirmOverlay.hidden = false;

    const cleanup = () => {
      dom.vnConfirmOverlay.hidden = true;
      dom.vnYesSession.removeEventListener('click', onYes);
      dom.vnAlwaysOn.removeEventListener('click', onAlways);
      dom.vnNotThisTime.removeEventListener('click', onNo);
    };
    const onYes = () => {
      haptics.tap();
      cleanup();
      resolve(true);
    };
    const onAlways = () => {
      haptics.tap();
      settings.set('voiceNotes', 'on');
      applySettingsUI();
      cleanup();
      resolve(true);
    };
    const onNo = () => {
      haptics.tap();
      cleanup();
      resolve(false);
    };

    dom.vnYesSession.addEventListener('click', onYes);
    dom.vnAlwaysOn.addEventListener('click', onAlways);
    dom.vnNotThisTime.addEventListener('click', onNo);
  });
}

async function startSession() {
  if (state.running) return;

  // Voice notes decision — Infinity only. Runs before mic/motion so the
  // user can back out without us having grabbed sensors yet.
  state.voiceNotesEnabled = false;
  state.voiceNotesText    = '';
  if (state.mode === 'infinity') {
    state.voiceNotesEnabled = await maybeAskVoiceNotes();
  }

  if (!state.micEnabled)    await startMic();
  if (!state.motionEnabled) await startMotion();
  await requestWakeLock();

  // Reset all state
  state.running = true;
  state.paused  = false;
  state.startedAt = Date.now();
  state.elapsed = 0;
  state.lastTickAt = Date.now();
  state.motionSince = null;
  state.focusLostSince = null;
  state.pausedAt = null;
  state.pauseReason = null;
  state.pausedTotalMs = 0;
  state.interruptionCount = 0;
  state.dbSum = 0;
  state.dbSamples = 0;
  state.dbPeak = -Infinity;
  state.silenceContinuousSince = Date.now();

  dom.dial.classList.add('starting');
  setTimeout(() => dom.dial.classList.remove('starting'), 2600);
  audio.playStart();
  haptics.medium();

  setRunningUI(true);
  state.sensingFrame = requestAnimationFrame(sensingTick);
}

async function completeSession(naturalFinish = false, reason = 'manual') {
  if (!state.running) return;

  // Mark not-running IMMEDIATELY to prevent re-entry (e.g. pause-timeout
  // firing while an awaited db.add() is in flight).
  state.running = false;
  state.paused  = false;

  if (state.sensingFrame) cancelAnimationFrame(state.sensingFrame);
  state.sensingFrame = null;
  if (state.pauseTimeoutId) {
    clearTimeout(state.pauseTimeoutId);
    state.pauseTimeoutId = null;
  }

  const avgDb  = state.dbSamples > 0 ? Math.round(state.dbSum / state.dbSamples) : null;
  const peakDb = state.dbSamples > 0 && isFinite(state.dbPeak) ? Math.round(state.dbPeak) : null;

  const session = {
    startedAt: state.startedAt,
    endedAt: Date.now(),
    mode: state.mode,
    targetSeconds: state.duration,
    silentSeconds: Math.floor(state.elapsed),
    completed: naturalFinish,
    endReason: reason,
    interrupted: state.interruptionCount > 0,
    interruptionCount: state.interruptionCount,
    pausedTotalSeconds: Math.round(state.pausedTotalMs / 1000),
    avgDb: avgDb,
    peakDb: peakDb,
    rating: null,   // set later when user taps a star on the summary modal
  };

  // Attach voice notes transcript only when present. v0.9 never writes
  // non-empty text (no STT yet), so this is a no-op until v1.0.
  if (state.voiceNotesText && state.voiceNotesText.trim()) {
    session.voiceNotes = state.voiceNotesText.trim();
  }

  try {
    const id = await db.add(session);
    session.id = id;
    state.currentSessionId = id;
  } catch (e) { console.warn('[silence] save failed:', e); }

  setRunningUI(false);
  selectMode(state.mode);
  releaseWakeLock();
  if (state.night) exitNight();

  const modesWithChime = new Set(['before', 'after', 'unwind']);
  if (naturalFinish && modesWithChime.has(session.mode)) {
    audio.playFinish();
    haptics.success();
  }

  if (reason !== 'closed') {
    showSummary(session);
  }
}

// A synchronous variant used in pagehide — best-effort, can't await
function commitSessionOnUnload() {
  if (!state.running) return;
  // Clean up timers
  if (state.sensingFrame) cancelAnimationFrame(state.sensingFrame);
  if (state.pauseTimeoutId) clearTimeout(state.pauseTimeoutId);

  const avgDb = state.dbSamples > 0 ? Math.round(state.dbSum / state.dbSamples) : null;
  const peakDb = state.dbSamples > 0 && isFinite(state.dbPeak) ? Math.round(state.dbPeak) : null;

  const session = {
    startedAt: state.startedAt,
    endedAt: Date.now(),
    mode: state.mode,
    targetSeconds: state.duration,
    silentSeconds: Math.floor(state.elapsed),
    completed: false,
    endReason: 'closed',
    interrupted: true,
    interruptionCount: state.interruptionCount + 1,
    pausedTotalSeconds: Math.round(state.pausedTotalMs / 1000),
    avgDb: avgDb,
    peakDb: peakDb,
    rating: null,
  };

  if (state.voiceNotesText && state.voiceNotesText.trim()) {
    session.voiceNotes = state.voiceNotesText.trim();
  }

  // Fire-and-forget save (browser may kill us before it completes; that's fine)
  try {
    db.add(session);
  } catch (_) {}

  state.running = false;
}

// ============================================================
// 18. Summary modal
// ============================================================
function showSummary(session) {
  dom.summaryModeIcon.innerHTML = modeIconSVG(session.mode, 24);

  const mins = Math.floor(session.silentSeconds / 60);
  const secs = session.silentSeconds % 60;
  const phrasing = mins > 0
    ? `${mins} minute${mins === 1 ? '' : 's'}${secs > 0 ? ` ${secs}s` : ''} of silence`
    : `${secs} seconds of silence`;

  let title = 'Session complete';
  if (session.endReason === 'manual')        title = 'Session saved';
  if (session.endReason === 'pause-timeout') title = 'Session ended';

  dom.summaryTitle.textContent = title;
  dom.summarySub.textContent = phrasing;
  dom.summaryDuration.textContent = fmtDuration(session.silentSeconds);

  dom.summaryInterrupted.textContent = session.interrupted ? 'Yes' : 'No';
  dom.summaryInterrupted.className = 's-value ' + (session.interrupted ? 'yes' : 'no');

  dom.summaryAvgDb.textContent  = session.avgDb  != null ? `${session.avgDb} dB`  : '—';
  dom.summaryPeakDb.textContent = session.peakDb != null ? `${session.peakDb} dB` : '—';

  // Reset rating UI — fresh state for each session
  dom.ratingStars.classList.remove('submitted');
  dom.ratingStars.querySelectorAll('.rating-star').forEach(s => s.classList.remove('lit'));
  dom.ratingPrompt.textContent = 'How did it feel?';
  dom.ratingSkip.style.display = '';

  dom.summaryOverlay.hidden = false;
}

// Apply rating to the just-completed session and close the summary.
async function submitRating(n) {
  // Lit all stars up to n; mark the group as submitted
  dom.ratingStars.classList.add('submitted');
  const stars = dom.ratingStars.querySelectorAll('.rating-star');
  stars.forEach((s, i) => {
    s.classList.toggle('lit', i < n);
  });

  // Play the rating sound + tactile feedback
  audio.playRating(n);
  haptics.tap();

  // Acknowledge + update the stored session
  dom.ratingPrompt.textContent = 'Saved.';
  dom.ratingSkip.style.display = 'none';

  if (state.currentSessionId != null) {
    try {
      const existing = await db.getById(state.currentSessionId);
      if (existing) {
        existing.rating = n;
        await db.update(existing);
      }
    } catch (e) { console.warn('[silence] rating save failed:', e); }
  }

  // Close after a beat so the user hears the sound + sees the confirmation
  setTimeout(() => {
    dom.summaryOverlay.hidden = true;
  }, 900);
}

// ============================================================
// 19. Log rendering
// ============================================================
async function renderLog() {
  const sinceTs = daysAgo(CONFIG.LOG_DAYS - 1);
  const sessions = await db.getSince(sinceTs);

  const days = [];
  for (let i = CONFIG.LOG_DAYS - 1; i >= 0; i--) {
    const dayStart = daysAgo(i);
    const dayEnd = dayStart + 86400000;
    const daySessions = sessions.filter(s => s.startedAt >= dayStart && s.startedAt < dayEnd);
    const total = daySessions.reduce((sum, s) => sum + s.silentSeconds, 0);
    days.push({ ts: dayStart, sessions: daySessions, total });
  }

  let totalSeconds = 0, longest = 0;
  sessions.forEach(s => {
    totalSeconds += s.silentSeconds;
    if (s.silentSeconds > longest) longest = s.silentSeconds;
  });
  dom.totalWeek.textContent     = fmtTotal(totalSeconds);
  dom.totalSessions.textContent = String(sessions.length);
  dom.longestSession.textContent = fmtTotal(longest);

  const maxTotal = Math.max(...days.map(d => d.total), 60);
  const todayStart = startOfDay();
  dom.logChart.innerHTML = '';

  days.forEach((d) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.dataset.ts = d.ts;

    // Daily average rating — stars above the bar
    // Only count sessions that actually have a rating (not null)
    const rated = d.sessions.filter(s => s.rating != null);
    let avgRating = 0;
    if (rated.length > 0) {
      avgRating = Math.round(rated.reduce((sum, s) => sum + s.rating, 0) / rated.length);
    }
    const ratingRow = document.createElement('div');
    ratingRow.className = 'bar-rating';
    for (let i = 1; i <= 5; i++) {
      const st = document.createElement('span');
      st.className = 'bar-rating-star' + (i <= avgRating ? ' lit' : '');
      st.innerHTML = STAR_SVG_INLINE;
      ratingRow.appendChild(st);
    }
    col.appendChild(ratingRow);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.height = ((d.total / maxTotal) * 100) + '%';
    bar.appendChild(fill);
    const label = document.createElement('div');
    label.className = 'bar-day' + (d.ts === todayStart ? ' today' : '');
    label.textContent = dayLabel(d.ts);
    col.appendChild(bar);
    col.appendChild(label);
    dom.logChart.appendChild(col);
  });

  const allDescending = [...sessions].sort((a, b) => b.startedAt - a.startedAt);

  if (allDescending.length === 0) {
    dom.logList.innerHTML = '<div class="log-empty">Your silence log will appear here.<br>Start a session to begin.</div>';
    dom.logSub.textContent = 'No sessions yet';
    return;
  }

  dom.logSub.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · last ${CONFIG.LOG_DAYS} days`;

  let html = '';
  let lastDay = null;
  allDescending.forEach(s => {
    const dayKey = startOfDay(new Date(s.startedAt));
    if (dayKey !== lastDay) {
      html += `<div class="log-day">${fullDateLabel(s.startedAt)}</div>`;
      lastDay = dayKey;
    }
    const isPartial = !s.completed;
    const dot = s.interrupted ? '<span class="log-interrupted-dot" title="Interrupted"></span>' : '';
    const dbLabel = (s.avgDb != null) ? `<span class="log-db">${s.avgDb} dB</span>` : '';

    // Inline rating display — 5 mini-stars, filled up to s.rating
    let ratingHTML = '';
    if (s.rating != null) {
      ratingHTML = '<div class="log-entry-rating">';
      for (let i = 1; i <= 5; i++) {
        ratingHTML += `<span class="log-entry-rating-star${i <= s.rating ? ' lit' : ''}">${STAR_SVG_INLINE}</span>`;
      }
      ratingHTML += '</div>';
    }

    // Voice notes badge — only when session has non-empty transcript.
    // Uses session id for unique panel reference (data-vn-id).
    let vnBadge = '';
    let vnPanel = '';
    if (s.voiceNotes && s.id != null) {
      vnBadge = `<button type="button" class="log-vn-badge" data-vn-toggle="${s.id}" aria-expanded="false" aria-controls="vn-panel-${s.id}">${NOTEBOOK_SVG_INLINE}<span>Notes</span></button>`;
      vnPanel = `
        <div class="log-vn-panel" id="vn-panel-${s.id}" data-vn-panel="${s.id}" hidden>
          <p class="log-vn-text">${escapeHTML(s.voiceNotes)}</p>
          <div class="log-vn-actions">
            <button type="button" class="log-vn-copy" data-vn-copy="${s.id}">Copy</button>
          </div>
        </div>`;
    }

    // Two-column layout: left = what + when + how loud, right = how long + how good
    html += `
      <div class="log-entry">
        <div class="log-mode-icon">${modeIconSVG(s.mode)}</div>
        <div class="log-meta">
          <span class="log-mode-name">${dot}${s.mode}</span>
          <span class="log-time">${timeOfDay(s.startedAt)}</span>
          ${dbLabel}
          ${vnBadge}
        </div>
        <div class="log-duration ${isPartial ? 'partial' : ''}">
          <span>${fmtDuration(s.silentSeconds)}</span>
          ${ratingHTML}
        </div>
      </div>${vnPanel}`;
  });
  dom.logList.innerHTML = html;
}

// ============================================================
// 20. Wire — event handlers
// ============================================================
// Sync the settings UI (chips + toggle) to whatever's currently in storage.
// Called at boot, when the log panel opens, and after every settings change.
function applySettingsUI() {
  const pack    = settings.get('soundPack');
  const haptOn  = settings.get('haptics') === 'on';
  const vnMode  = settings.get('voiceNotes');

  // Sound pack chips — mark the current one as selected
  if (dom.soundPackChips) {
    dom.soundPackChips.querySelectorAll('.settings-chip').forEach((chip) => {
      const isSelected = chip.dataset.pack === pack;
      chip.classList.toggle('selected', isSelected);
      chip.setAttribute('aria-checked', String(isSelected));
    });
  }

  // Voice notes chips — Always / Ask / Never
  if (dom.voiceNotesChips) {
    dom.voiceNotesChips.querySelectorAll('.settings-chip').forEach((chip) => {
      const isSelected = chip.dataset.vn === vnMode;
      chip.classList.toggle('selected', isSelected);
      chip.setAttribute('aria-checked', String(isSelected));
    });
  }

  // Haptics toggle — set aria-checked, CSS handles visual state
  if (dom.hapticsToggle) {
    dom.hapticsToggle.setAttribute('aria-checked', String(haptOn));
  }

  // Hint — show which haptic backend will actually fire, so users know
  // why they may not feel anything (e.g. desktop, or iOS Safari outside Telegram).
  if (dom.hapticsHint) {
    if (!haptOn) {
      dom.hapticsHint.textContent = 'Off';
    } else {
      const backend = haptics.backend();
      if (backend === 'telegram')      dom.hapticsHint.textContent = 'Native (Telegram)';
      else if (backend === 'vibrate')  dom.hapticsHint.textContent = 'Web Vibration API';
      else                              dom.hapticsHint.textContent = 'Not supported on this device';
    }
  }
}

function wire() {
  // Modes — only selectable when not running
  dom.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (!btn || state.running) return;
    selectMode(btn.dataset.mode);
    haptics.tap();
  });

  // Start (dial or start button)
  const startHandler = async () => {
    if (state.running) return;
    await startSession();
  };
  dom.dialBtn.addEventListener('click', startHandler);
  dom.startBtn.addEventListener('click', startHandler);

  // Stop — respond to pointerdown directly (more reliable than click in
  // environments where the window-level pointerdown listener might swallow
  // the event, or on touch devices where click can be debounced).
  dom.stopBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    completeSession(false, 'manual');
  });
  dom.stopBtn.addEventListener('click', (e) => {
    // Fallback if pointerdown wasn't supported
    if (state.running) completeSession(false, 'manual');
  });

  // Log open/close
  dom.logBtn.addEventListener('click', async () => {
    dom.logOverlay.hidden = false;
    applySettingsUI();
    await renderLog();
  });
  dom.logClose.addEventListener('click', () => { dom.logOverlay.hidden = true; });

  // Rating — each star click plays its own sound and persists the rating.
  dom.ratingStars.addEventListener('click', (e) => {
    const btn = e.target.closest('.rating-star');
    if (!btn) return;
    if (dom.ratingStars.classList.contains('submitted')) return;
    const n = parseInt(btn.dataset.value, 10);
    if (!n || n < 1 || n > 5) return;
    submitRating(n);
  });
  // Hover preview — light up stars up to the hovered one
  dom.ratingStars.addEventListener('mouseover', (e) => {
    if (dom.ratingStars.classList.contains('submitted')) return;
    const btn = e.target.closest('.rating-star');
    if (!btn) return;
    const n = parseInt(btn.dataset.value, 10);
    dom.ratingStars.querySelectorAll('.rating-star').forEach((s, i) => {
      s.classList.toggle('lit', i < n);
    });
  });
  dom.ratingStars.addEventListener('mouseleave', () => {
    if (dom.ratingStars.classList.contains('submitted')) return;
    dom.ratingStars.querySelectorAll('.rating-star').forEach(s => s.classList.remove('lit'));
  });
  // Skip — just close without rating
  dom.ratingSkip.addEventListener('click', () => {
    dom.summaryOverlay.hidden = true;
  });

  // Tap interactions — v0.5:
  //   Running + not paused: any tap pauses (except STOP button)
  //   Running + paused: tap on dial resumes; other taps do nothing
  //   Night active: first tap exits night (without pausing or resuming)
  window.addEventListener('pointerdown', (e) => {
    if (!state.running) return;
    // STOP button has its own handler above; let it manage itself
    if (e.target.closest('#stopBtn')) return;

    // Night mode: first pointer input exits night
    if (state.night) {
      exitNight();
      return;
    }

    // If paused, only the dial resumes the session; other taps are ignored
    if (state.paused) {
      if (e.target.closest('#dial')) {
        exitPause();
      }
      return;
    }

    // Running normally: any tap pauses
    enterPause('tap');
  }, { passive: true });

  // Belt-and-suspenders: explicit listener on the Night layer itself.
  // This covers desktop Chrome quirks where the window-level pointerdown
  // might miss synthetic or trusted-only events targeted at the canvas.
  dom.night.addEventListener('pointerdown', () => {
    if (state.night) exitNight();
  });
  dom.night.addEventListener('click', () => {
    if (state.night) exitNight();
  });
  dom.night.addEventListener('mousedown', () => {
    if (state.night) exitNight();
  });

  // Key input also exits night
  window.addEventListener('keydown', () => {
    if (state.night) exitNight();
  });

  // Visibility -> focus-based pause + wake lock reacquire
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      if (state.running && !state.wakeLock) await requestWakeLock();
    }
    // Pause triggers in sensingTick handle focus loss with grace period.
    // But if the tab becomes hidden we also immediately fall out of night.
    if (document.hidden && state.night) exitNight();
  });

  // Page close / tab close — best-effort save
  window.addEventListener('pagehide', () => {
    if (state.running) commitSessionOnUnload();
  });

  // ----- Settings: sound pack chips
  if (dom.soundPackChips) {
    dom.soundPackChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.settings-chip');
      if (!chip) return;
      const pack = chip.dataset.pack;
      if (!pack) return;
      settings.set('soundPack', pack);
      applySettingsUI();
      haptics.tap();
      // Audible preview so the user immediately hears their choice.
      // Skipped for 'off' — the silence IS the preview.
      if (pack !== 'off') audio.playZoomIn();
    });
  }

  // ----- Settings: haptics toggle
  if (dom.hapticsToggle) {
    dom.hapticsToggle.addEventListener('click', () => {
      const next = settings.get('haptics') === 'on' ? 'off' : 'on';
      settings.set('haptics', next);
      applySettingsUI();
      // If they just turned it ON, demonstrate. If OFF, no preview.
      if (next === 'on') haptics.tap();
    });
  }

  // ----- Settings: voice notes chips (Always / Ask / Never)
  if (dom.voiceNotesChips) {
    dom.voiceNotesChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.settings-chip');
      if (!chip) return;
      const mode = chip.dataset.vn;
      if (!VOICE_NOTES_MODES.includes(mode)) return;
      settings.set('voiceNotes', mode);
      applySettingsUI();
      haptics.tap();
    });
  }

  // ----- Log list: voice notes expand/collapse + copy
  if (dom.logList) {
    dom.logList.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-vn-toggle]');
      const copy   = e.target.closest('[data-vn-copy]');

      if (toggle) {
        const id = toggle.getAttribute('data-vn-toggle');
        const panel = dom.logList.querySelector(`[data-vn-panel="${id}"]`);
        if (!panel) return;
        const isOpen = !panel.hidden;
        panel.hidden = isOpen;
        toggle.classList.toggle('expanded', !isOpen);
        toggle.setAttribute('aria-expanded', String(!isOpen));
        haptics.tap();
        return;
      }

      if (copy) {
        const id = copy.getAttribute('data-vn-copy');
        const panel = dom.logList.querySelector(`[data-vn-panel="${id}"]`);
        const textEl = panel && panel.querySelector('.log-vn-text');
        if (!textEl) return;
        const text = textEl.textContent || '';
        const showCopied = () => {
          copy.classList.add('copied');
          const original = copy.textContent;
          copy.textContent = 'Copied';
          setTimeout(() => {
            copy.classList.remove('copied');
            copy.textContent = original;
          }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(showCopied).catch(() => {
            // Fallback for older WebViews
            try {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              showCopied();
            } catch (_) {}
          });
        }
        haptics.tap();
      }
    });
  }
}

// ============================================================
// 21. Boot
// ============================================================
async function boot() {
  populateStaticIcons();
  wire();
  applySettingsUI();
  selectMode('unwind');
  stars.init();

  if (needsPermissionFlow()) {
    await showPermissionOverlay();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
