/* ============================================================
   Silence · app.js  (v1.3.0 — refactor + diagnostics)
   ------------------------------------------------------------
   Single-file, no-build-step app logic. Organized in top-level
   modules, each is a plain object with a small well-defined API.

   Modules (in order):
     0.  CrashLog        — global uncaught-error capture
     1.  Config          — tunable constants
     1b. Settings        — user prefs, persisted
     1c. Haptics         — Telegram / Vibration
     2.  State           — single mutable session state
     3.  DOM refs        — cached element lookups
     4.  Utils           — formatters, date math, dB conv.
     5.  Icons           — SVG path constants + helpers
     6.  Audio           — synthesis (shared AudioContext)
     7.  Stars           — Steady Night canvas animation
     8.  DB              — IndexedDB session store
     9.  Sensing.Mic     — getUserMedia + RMS dB
     10. Sensing.Motion  — devicemotion accelerometer
     11. WakeLock        — screen-on while running
     12. Permissions     — first-run overlay
     13. Mode            — before/after/unwind/sleep/infinity
     14. Night           — UI fade-to-starfield transition
     15. Pause           — enter/exit pause
     16. Loop            — timer + sensing tick
     17. Session         — start / complete / close
     18. Summary         — post-session modal + rating
     19. Log             — stats panel render
     20. STT             — whisper tap glue
     21. Diagnostics     — comprehensive debug panel (NEW)
     22. Wire            — event handlers
     23. Boot            — init sequence

   v1.3.0 changes vs v1.2.2:
     - Single shared AudioContext between synth and mic.
     - Mic tracks are stopped on session end (was: leaked).
     - Timer uses Date.now() delta + setInterval backstop so it
       keeps counting while rAF is throttled (tab hidden / screen
       dimmed). rAF remains for smooth ring/time rendering.
     - Crash tracker uses a lazy state accessor so it cannot hit
       a TDZ if an error fires before state { } is evaluated.
     - dB sampling capped to ~10 Hz instead of per-frame.
     - RING_CIRCUMFERENCE derived from the actual SVG <circle r>.
     - Service-worker install failure surfaces in Diagnostics.
     - Permissions status queried via navigator.permissions and
       shown in Diagnostics with a "Re-request" affordance.
     - New Diagnostics panel under Settings (below Ideas diag).
     - SilenceDiag global exposed for console inspection.
   ============================================================ */
'use strict';

/* ============================================================
 * 0. Crash tracker
 * ============================================================
 * Installed BEFORE any other code so boot-time errors are caught.
 * Uses getState() lazy getter to avoid TDZ on 'state' const.
 * ============================================================ */
const CRASH_LOG_KEY = 'silence.crashlog.v1';
const CRASH_LOG_MAX = 20;
let __crashDropped = 0;
function __safeState() {
  try { return (typeof state !== 'undefined') ? state : null; }
  catch (_) { return null; }
}
const crashLog = {
  read() {
    try {
      const raw = localStorage.getItem(CRASH_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  },
  write(entries) {
    try { localStorage.setItem(CRASH_LOG_KEY, JSON.stringify(entries)); }
    catch (_) {}
  },
  record(entry) {
    const list = this.read();
    const s = __safeState();
    list.unshift({
      ts: Date.now(),
      mode: (s && s.mode) || null,
      running: (s && s.running) || false,
      elapsed: (s && s.elapsed) ? Math.round(s.elapsed) : 0,
      vnEnabled: (s && s.voiceNotesEnabled) || false,
      ...entry,
    });
    if (list.length > CRASH_LOG_MAX) __crashDropped += (list.length - CRASH_LOG_MAX);
    this.write(list.slice(0, CRASH_LOG_MAX));
  },
  clear() { this.write([]); __crashDropped = 0; },
  droppedCount() { return __crashDropped; },
};
window.addEventListener('error', (e) => {
  crashLog.record({
    kind: 'error',
    message: (e.error && e.error.message) || e.message || 'unknown error',
    stack: (e.error && e.error.stack) ? String(e.error.stack).split('\n').slice(0, 6).join('\n') : null,
    source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null,
    ua: navigator.userAgent,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  crashLog.record({
    kind: 'rejection',
    message: (r && r.message) ? r.message : String(r),
    stack: (r && r.stack) ? String(r.stack).split('\n').slice(0, 6).join('\n') : null,
    ua: navigator.userAgent,
  });
});

/* ============================================================ */
/* 1. Config                                                    */
/* ============================================================ */
const CONFIG = {
  MOTION_THRESHOLD: 0.35,
  MOTION_GRACE_MS: 500,
  FOCUS_GRACE_MS: 500,
  PAUSE_TIMEOUT_MS: 3 * 60 * 1000,
  INFINITY_CAP_SECONDS: 60 * 60,
  NIGHT_THRESHOLD_MS: 10000,
  NIGHT_EXIT_FADE_MS: 1200,
  LOG_DAYS: 10,
  DB_OFFSET: 85,
  DB_FLOOR: -70,
  RING_CIRCUMFERENCE: 540.354, // overridden at boot from SVG
  AUDIO_MASTER_GAIN: 0.22,
  STT_SAMPLE_RATE: 16000,
  STT_CHUNK_SECONDS: 30,
  STT_DISPATCH_INTERVAL_MS: 30 * 1000,
  STT_MIN_CHARS: 2,
  // v1.3: sample dB at this cadence instead of per-rAF-frame.
  DB_SAMPLE_INTERVAL_MS: 100,
  // v1.3: setInterval backstop for the session clock in case rAF
  // is throttled (hidden tab, dimmed screen).
  LOOP_BACKSTOP_MS: 500,
};
const APP_VERSION = 'v1.3.0';
const BUILD_TS = new Date().toISOString();

/* ============================================================ */
/* 1b. Settings                                                 */
/* ============================================================ */
const SETTINGS_KEY = 'silence.settings.v1';
const DEFAULT_SETTINGS = {
  soundPack: 'cosmos',
  haptics: 'on',
  voiceNotes: 'ask',
  voiceNotesLang: 'auto',
};
const SOUND_PACKS = ['cosmos', 'bell', 'pulse', 'off'];
const VOICE_NOTES_MODES = ['on', 'ask', 'off'];
const VOICE_NOTES_LANGS = ['auto', 'english', 'russian'];
const settings = {
  _data: null,
  load() {
    if (this._data) return this._data;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        this._data = {
          soundPack: SOUND_PACKS.includes(p.soundPack) ? p.soundPack : DEFAULT_SETTINGS.soundPack,
          haptics: p.haptics === 'off' ? 'off' : 'on',
          voiceNotes: VOICE_NOTES_MODES.includes(p.voiceNotes) ? p.voiceNotes : DEFAULT_SETTINGS.voiceNotes,
          voiceNotesLang: VOICE_NOTES_LANGS.includes(p.voiceNotesLang) ? p.voiceNotesLang : DEFAULT_SETTINGS.voiceNotesLang,
        };
        return this._data;
      }
    } catch (_) {}
    this._data = { ...DEFAULT_SETTINGS };
    return this._data;
  },
  save() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._data)); } catch (_) {} },
  get(k) { return this.load()[k]; },
  set(k, v) { this.load(); this._data[k] = v; this.save(); },
};

/* ============================================================ */
/* 1c. Haptics                                                  */
/* ============================================================ */
const haptics = {
  _tg() {
    const tg = (typeof window !== 'undefined') && window.Telegram && window.Telegram.WebApp;
    if (tg && tg.HapticFeedback) { try { tg.ready(); } catch (_) {} return tg.HapticFeedback; }
    return null;
  },
  backend() {
    if (this._tg()) return 'telegram';
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') return 'vibrate';
    return 'none';
  },
  fire(kind) {
    if (settings.get('haptics') !== 'on') return;
    const tg = this._tg();
    if (tg) {
      try {
        if (kind === 'success') tg.notificationOccurred('success');
        else if (kind === 'warning') tg.notificationOccurred('warning');
        else if (kind === 'tap') tg.impactOccurred('medium');
        else if (kind === 'short') tg.impactOccurred('medium');
        else if (kind === 'medium') tg.impactOccurred('heavy');
        else if (kind === 'heavy') tg.impactOccurred('heavy');
      } catch (_) {}
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      const p = kind === 'success' ? [40, 80, 40]
              : kind === 'warning' ? [60, 40, 60]
              : kind === 'tap' ? 25 : kind === 'short' ? 35
              : kind === 'medium' ? 60 : kind === 'heavy' ? 90 : 0;
      try { navigator.vibrate(p); } catch (_) {}
    }
  },
  tap() { this.fire('tap'); },
  short() { this.fire('short'); },
  medium() { this.fire('medium'); },
  heavy() { this.fire('heavy'); },
  success() { this.fire('success'); },
  warning() { this.fire('warning'); },
};

/* ============================================================ */
/* 2. State                                                     */
/* ============================================================ */
const state = {
  mode: 'unwind',
  duration: 20 * 60,
  running: false,
  paused: false,
  startedAt: null,
  elapsed: 0,
  lastTickAt: null,
  micEnabled: false,
  motionEnabled: false,
  audioCtx: null,                // single shared AudioContext
  analyser: null,
  micStream: null,
  currentLevel: 0,
  currentMotion: 0,
  motionSince: null,
  focusLostSince: null,
  pausedAt: null,
  pauseReason: null,
  pauseTimeoutId: null,
  pausedTotalMs: 0,
  interruptionCount: 0,
  dbSum: 0,
  dbSamples: 0,
  dbPeak: -Infinity,
  lastDbSampleAt: 0,             // v1.3 throttle
  silenceContinuousSince: null,
  night: false,
  wakeLock: null,
  sensingFrame: null,
  loopBackstopTimer: null,       // v1.3 setInterval backstop
  currentSessionId: null,
  voiceNotesEnabled: false,
  voiceNotesText: '',
  micSourceNode: null,
  sttProcessor: null,
  sttSink: null,
  // v1.3: diagnostic flags
  swRegistration: null,
  swError: null,
  lastWakeLockError: null,
  dbOpenError: null,
};

/* ============================================================ */
/* 3. DOM refs                                                  */
/* ============================================================ */
const $ = (id) => document.getElementById(id);
const dom = {
  modes: $('modes'),
  dial: $('dial'),
  dialBtn: $('dialBtn'),
  dialLabel: $('dialLabel'),
  dialTime: $('dialTime'),
  ringProgress: $('ringProgress'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  status: $('status'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  night: $('night'),
  nightSky: $('nightSky'),
  permOverlay: $('permOverlay'),
  permGrant: $('permGrant'),
  permSkip: $('permSkip'),
  logBtn: $('logBtn'),
  logOverlay: $('logOverlay'),
  logClose: $('logClose'),
  logChart: $('logChart'),
  logList: $('logList'),
  logSub: $('logSub'),
  totalWeek: $('totalWeek'),
  totalSessions: $('totalSessions'),
  longestSession: $('longestSession'),
  summaryOverlay: $('summaryOverlay'),
  summaryModeIcon: $('summaryModeIcon'),
  summaryTitle: $('summaryTitle'),
  summarySub: $('summarySub'),
  summaryDuration: $('summaryDuration'),
  summaryInterrupted: $('summaryInterrupted'),
  summaryAvgDb: $('summaryAvgDb'),
  summaryPeakDb: $('summaryPeakDb'),
  ratingPrompt: $('ratingPrompt'),
  ratingStars: $('ratingStars'),
  ratingSkip: $('ratingSkip'),
  soundPackChips: $('soundPackChips'),
  hapticsToggle: $('hapticsToggle'),
  hapticsHint: $('hapticsHint'),
  voiceNotesChips: $('voiceNotesChips'),
  voiceNotesLangChips: $('voiceNotesLangChips'),
  vnConfirmOverlay: $('vnConfirmOverlay'),
  vnYesSession: $('vnYesSession'),
  vnAlwaysOn: $('vnAlwaysOn'),
  vnNotThisTime: $('vnNotThisTime'),
  vnDownloadNotice: $('vnDownloadNotice'),
  dlBar: $('dlBar'),
  dlBarFill: $('dlBarFill'),
  dlBarPct: $('dlBarPct'),
  dlBarSub: $('dlBarSub'),
  modelStatus: $('modelStatus'),
  modelCheck: $('modelCheck'),
  modelStatusText: $('modelStatusText'),
  modelDlBtn: $('modelDlBtn'),
  modelDlConfirmOverlay: $('modelDlConfirmOverlay'),
  modelDlConfirmYes: $('modelDlConfirmYes'),
  modelDlConfirmNo: $('modelDlConfirmNo'),
  mumblesDebug: $('mumblesDebug'),
  dbgState: $('dbgState'),
  dbgProgress: $('dbgProgress'),
  dbgSession: $('dbgSession'),
  dbgTap: $('dbgTap'),
  dbgCtx: $('dbgCtx'),
  dbgRate: $('dbgRate'),
  dbgBuffer: $('dbgBuffer'),
  dbgChunks: $('dbgChunks'),
  dbgLast: $('dbgLast'),
  dbgAccum: $('dbgAccum'),
  dbgError: $('dbgError'),
  crashLogPanel: $('crashLogPanel'),
  crashLogList: $('crashLogList'),
  crashLogCount: $('crashLogCount'),
  crashLogCopy: $('crashLogCopy'),
  crashLogClear: $('crashLogClear'),
  // v1.3 Diagnostics panel refs (populated after panel is injected)
  diagPanel: null,
  diagGrid: null,
  diagMeter: null,
  diagMotionBar: null,
  diagCopyBtn: null,
  diagSelfTestBtn: null,
  diagRequestPermsBtn: null,
  diagRefreshBtn: null,
};

/* ============================================================ */
/* 4. Utils                                                     */
/* ============================================================ */
function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '∞';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
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
  const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime();
}
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d.getTime();
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
function levelToDb(level) {
  if (level <= 0) return CONFIG.DB_FLOOR + CONFIG.DB_OFFSET;
  const dbfs = 20 * Math.log10(level);
  const clamped = Math.max(CONFIG.DB_FLOOR, dbfs);
  return clamped + CONFIG.DB_OFFSET;
}

/* ============================================================ */
/* 5. Icons                                                     */
/* ============================================================ */
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
const STAR_PATH = 'M12 2.5l2.9 6.6 7.1 0.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-0.7z';
function starSVG(size, strokeWidth = 1.4) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`;
}
const STAR_SVG_INLINE = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 14 18" width="12" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="8" width="10" height="8" rx="1.5"/><path d="M4.5 8V5a2.5 2.5 0 0 1 5 0v3"/></svg>`;
const CIRCLE_SVG = `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><circle cx="7" cy="7" r="5.5"/></svg>`;
const NOTEBOOK_SVG_INLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6.5A1.5 1.5 0 0 1 5 19.5v-15z"/><path d="M9 7h7M9 11h7M9 15h4"/></svg>';
function populateStaticIcons() {
  document.querySelectorAll('.mode').forEach((btn) => {
    const mode = btn.dataset.mode;
    const slot = btn.querySelector('.mode-icon');
    if (slot) slot.innerHTML = modeIconSVG(mode, 28);
  });
  document.querySelectorAll('[data-icon="lock"]').forEach((el) => { el.innerHTML = LOCK_SVG; });
  document.querySelectorAll('[data-icon="circle"]').forEach((el) => { el.innerHTML = CIRCLE_SVG; });
  document.querySelectorAll('#ratingStars .rating-star').forEach((btn) => { btn.innerHTML = starSVG(32); });
}


/* ============================================================ */
/* 6. Audio                                                     */
/* ============================================================ */
/* Single shared AudioContext. The mic is connected to the SAME  */
/* context as the synth output. This avoids iOS Safari 'double   */
/* suspended context' bugs and halves the audio-thread cost.     */
/* ============================================================ */
const audio = {
  ctx: null,
  masterGain: null,
  async init() {
    if (this.ctx) return;
    this.ctx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx = this.ctx;
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
    const delay = this.ctx.createDelay(); delay.delayTime.value = 0.18;
    const feedback = this.ctx.createGain(); feedback.gain.value = 0.35;
    const wet = this.ctx.createGain(); wet.gain.value = 0.45;
    delay.connect(feedback); feedback.connect(delay);
    delay.connect(wet); wet.connect(this.masterGain);
    return { input: delay, output: wet };
  },
  async playStart() {
    const p = settings.get('soundPack');
    if (p === 'off') return;
    if (p === 'bell') return this._bellStart();
    if (p === 'pulse') return this._pulseStart();
    return this._cosmosStart();
  },
  async _cosmosStart() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const voices = [
      { f: 65.41,  gain: 0.30, harm: [1, 2, 3, 4] },
      { f: 98.00,  gain: 0.22, harm: [1, 2, 3] },
      { f: 130.81, gain: 0.26, harm: [1, 2, 3] },
    ];
    const attack = 1.2, sustain = 1.8, release = 1.8, total = attack + sustain + release;
    voices.forEach((v) => {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(v.gain, now + attack);
      g.gain.linearRampToValueAtTime(v.gain * 0.75, now + attack + sustain);
      g.gain.exponentialRampToValueAtTime(0.0001, now + total);
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(800, now);
      f.frequency.linearRampToValueAtTime(2400, now + attack);
      f.Q.value = 0.3;
      g.connect(f); f.connect(this.masterGain);
      v.harm.forEach((h, i) => {
        const o = this.ctx.createOscillator();
        o.type = i === 0 ? 'sine' : i === 1 ? 'triangle' : 'sine';
        o.frequency.value = v.f * h;
        const vg = this.ctx.createGain();
        vg.gain.value = 1 / (h * h * 0.6);
        o.connect(vg); vg.connect(g);
        o.start(now); o.stop(now + total + 0.1);
      });
    });
    [1046, 1568, 2093].forEach((f, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t0 = now + attack * 0.4 + i * 0.15;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.2);
      o.connect(g); g.connect(this.masterGain);
      o.start(t0); o.stop(t0 + 2.3);
    });
  },
  async _bellStart() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const rv = this.makeReverb();
    const f0 = 220;
    [{ r: 1.0, g: 0.30 }, { r: 2.76, g: 0.18 }, { r: 5.40, g: 0.10 }, { r: 8.93, g: 0.05 }]
      .forEach((p, i) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'sine'; o.frequency.value = f0 * p.r;
        const dec = 4.5 / (i * 0.6 + 1);
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(p.g, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dec);
        o.connect(g); g.connect(this.masterGain); g.connect(rv.input);
        o.start(now); o.stop(now + dec + 0.1);
      });
    const sub = this.ctx.createOscillator(), sg = this.ctx.createGain();
    sub.type = 'sine'; sub.frequency.value = 110;
    sg.gain.setValueAtTime(0, now);
    sg.gain.linearRampToValueAtTime(0.10, now + 0.04);
    sg.gain.exponentialRampToValueAtTime(0.0001, now + 3);
    sub.connect(sg); sg.connect(this.masterGain);
    sub.start(now); sub.stop(now + 3.1);
  },
  async _pulseStart() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 660;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    o.connect(g); g.connect(this.masterGain);
    o.start(now); o.stop(now + 0.3);
  },
  async playRating(n) {
    if (settings.get('soundPack') === 'off') return;
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    if (n === 1) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
      o.type = 'sine';
      o.frequency.setValueAtTime(180, now);
      o.frequency.exponentialRampToValueAtTime(110, now + 0.5);
      f.type = 'lowpass'; f.frequency.value = 280; f.Q.value = 2;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.30, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      o.connect(f); f.connect(g); g.connect(this.masterGain);
      o.start(now); o.stop(now + 0.6);
      return;
    }
    if (n === 2) {
      [196, 294].forEach((fr, i) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'triangle'; o.frequency.value = fr;
        const d = i * 0.03;
        g.gain.setValueAtTime(0, now + d);
        g.gain.linearRampToValueAtTime(0.13, now + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.7);
        o.connect(g); g.connect(this.masterGain);
        o.start(now + d); o.stop(now + d + 0.75);
      });
      return;
    }
    if (n === 3) {
      [440, 554].forEach((fr, i) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'sine'; o.frequency.value = fr;
        const d = i * 0.04;
        g.gain.setValueAtTime(0, now + d);
        g.gain.linearRampToValueAtTime(0.15, now + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.85);
        o.connect(g); g.connect(this.masterGain);
        o.start(now + d); o.stop(now + d + 0.9);
      });
      return;
    }
    if (n === 4) {
      const rv = this.makeReverb();
      [523, 659, 784].forEach((fr, i) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'sine'; o.frequency.value = fr;
        const d = i * 0.05;
        g.gain.setValueAtTime(0, now + d);
        g.gain.linearRampToValueAtTime(0.16, now + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + d + 1.1);
        o.connect(g); g.connect(this.masterGain); g.connect(rv.input);
        o.start(now + d); o.stop(now + d + 1.2);
      });
      return;
    }
    if (n === 5) {
      const rv = this.makeReverb();
      [[1046,0],[1318,0.06],[1568,0.12],[2093,0.2],[2637,0.28],[3136,0.36]].forEach(([fr, d]) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'sine'; o.frequency.value = fr;
        g.gain.setValueAtTime(0, now + d);
        g.gain.linearRampToValueAtTime(0.18, now + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + d + 1.6);
        o.connect(g); g.connect(this.masterGain); g.connect(rv.input);
        o.start(now + d); o.stop(now + d + 1.7);
        const h = this.ctx.createOscillator(), hg = this.ctx.createGain();
        h.type = 'sine'; h.frequency.value = fr * 2.0009;
        hg.gain.setValueAtTime(0, now + d);
        hg.gain.linearRampToValueAtTime(0.05, now + d + 0.04);
        hg.gain.exponentialRampToValueAtTime(0.0001, now + d + 1.0);
        h.connect(hg); hg.connect(this.masterGain);
        h.start(now + d); h.stop(now + d + 1.1);
      });
      return;
    }
  },
  async playZoomOut() {
    const p = settings.get('soundPack');
    if (p === 'off') return;
    if (p === 'bell') return this._bellZoomOut();
    if (p === 'pulse') return this._pulseZoomOut();
    return this._cosmosZoomOut();
  },
  async _cosmosZoomOut() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime, dur = 0.9;
    [{ a: 880, b: 220, g: 0.16 }, { a: 440, b: 110, g: 0.12 }].forEach((v) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
      o.type = 'sine';
      o.frequency.setValueAtTime(v.a, now);
      o.frequency.exponentialRampToValueAtTime(v.b, now + dur);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(3200, now);
      f.frequency.exponentialRampToValueAtTime(400, now + dur);
      f.Q.value = 0.7;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(v.g, now + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(f); f.connect(g); g.connect(this.masterGain);
      o.start(now); o.stop(now + dur + 0.05);
    });
  },
  async _bellZoomOut() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    o.type = 'sine';
    o.frequency.setValueAtTime(330, now);
    o.frequency.exponentialRampToValueAtTime(165, now + 0.6);
    f.type = 'lowpass'; f.frequency.value = 1200; f.Q.value = 1.5;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    o.connect(f); f.connect(g); g.connect(this.masterGain);
    o.start(now); o.stop(now + 0.75);
  },
  async _pulseZoomOut() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 330;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    o.connect(g); g.connect(this.masterGain);
    o.start(now); o.stop(now + 0.15);
  },
  async playZoomIn() {
    const p = settings.get('soundPack');
    if (p === 'off') return;
    if (p === 'bell') return this._bellZoomIn();
    if (p === 'pulse') return this._pulseZoomIn();
    return this._cosmosZoomIn();
  },
  async _cosmosZoomIn() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime, dur = 0.9;
    [{ a: 220, b: 880, g: 0.16 }, { a: 110, b: 440, g: 0.12 }].forEach((v) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
      o.type = 'sine';
      o.frequency.setValueAtTime(v.a, now);
      o.frequency.exponentialRampToValueAtTime(v.b, now + dur);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(400, now);
      f.frequency.exponentialRampToValueAtTime(3200, now + dur);
      f.Q.value = 0.7;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(v.g, now + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.2);
      o.connect(f); f.connect(g); g.connect(this.masterGain);
      o.start(now); o.stop(now + dur + 0.25);
    });
  },
  async _bellZoomIn() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(165, now);
    o.frequency.exponentialRampToValueAtTime(330, now + 0.5);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
    o.connect(g); g.connect(this.masterGain);
    o.start(now); o.stop(now + 0.9);
  },
  async _pulseZoomIn() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 660;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    o.connect(g); g.connect(this.masterGain);
    o.start(now); o.stop(now + 0.15);
  },
  async playFinish() {
    const p = settings.get('soundPack');
    if (p === 'off') return;
    if (p === 'bell') return this._bellFinish();
    if (p === 'pulse') return this._pulseFinish();
    return this._cosmosFinish();
  },
  async _cosmosFinish() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    const rv = this.makeReverb();
    [[1318, 0], [1046, 0.25], [880, 0.5]].forEach(([fr, d]) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.value = fr;
      g.gain.setValueAtTime(0, now + d);
      g.gain.linearRampToValueAtTime(0.22, now + d + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d + 2.2);
      o.connect(g); g.connect(this.masterGain); g.connect(rv.input);
      o.start(now + d); o.stop(now + d + 2.4);
    });
  },
  async _bellFinish() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime, rv = this.makeReverb(), f0 = 196;
    [{ r: 1.0, g: 0.32 }, { r: 2.76, g: 0.20 }, { r: 5.40, g: 0.10 }, { r: 8.93, g: 0.05 }]
      .forEach((p, i) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'sine'; o.frequency.value = f0 * p.r;
        const dec = 5.5 / (i * 0.5 + 1);
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(p.g, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dec);
        o.connect(g); g.connect(this.masterGain); g.connect(rv.input);
        o.start(now); o.stop(now + dec + 0.1);
      });
  },
  async _pulseFinish() {
    await this.init(); await this.resume();
    const now = this.ctx.currentTime;
    [[660, 0], [990, 0.18]].forEach(([fr, d]) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.value = fr;
      g.gain.setValueAtTime(0, now + d);
      g.gain.linearRampToValueAtTime(0.16, now + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.22);
      o.connect(g); g.connect(this.masterGain);
      o.start(now + d); o.stop(now + d + 0.25);
    });
  },
};

/* ============================================================ */
/* 7. Stars                                                     */
/* ============================================================ */
const stars = {
  canvas: null, ctx: null, dots: [], rafId: null, running: false,
  init() {
    this.canvas = dom.nightSky; if (!this.canvas) return;
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
    const w = window.innerWidth, h = window.innerHeight;
    const count = Math.floor((w * h) / 14000);
    this.dots = [];
    for (let i = 0; i < count; i++) {
      this.dots.push({
        x: Math.random() * w, y: Math.random() * h,
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
      const dt = (now - last) / 1000; last = now;
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
    const w = window.innerWidth, h = window.innerHeight;
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

/* ============================================================ */
/* 8. DB                                                        */
/* ============================================================ */
const db = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('silence', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('sessions')) {
          const s = d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('startedAt', 'startedAt');
        }
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = () => { state.dbOpenError = String(req.error); reject(req.error); };
    });
  },
  async add(session) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('sessions', 'readwrite');
      const r = tx.objectStore('sessions').add(session);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async update(session) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async getById(id) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('sessions', 'readonly');
      const r = tx.objectStore('sessions').get(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async getSince(ts) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('sessions', 'readonly');
      const s = tx.objectStore('sessions');
      const r = s.index('startedAt').getAll(IDBKeyRange.lowerBound(ts));
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  },
  async count() {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('sessions', 'readonly');
      const r = tx.objectStore('sessions').count();
      r.onsuccess = () => resolve(r.result || 0);
      r.onerror = () => reject(r.error);
    });
  },
};

/* ============================================================ */
/* 9. Sensing: microphone                                       */
/* ============================================================ */
async function startMic() {
  if (state.micEnabled) return true;
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    // Share the synth AudioContext. Creating a second context on iOS
    // Safari was the root cause of mic-level tracking sometimes freezing
    // after a playStart()/resume() cycle.
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    audio.ctx = state.audioCtx;
    if (!audio.masterGain) {
      audio.masterGain = audio.ctx.createGain();
      audio.masterGain.gain.value = CONFIG.AUDIO_MASTER_GAIN;
      audio.masterGain.connect(audio.ctx.destination);
    }
    const source = state.audioCtx.createMediaStreamSource(state.micStream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyser.smoothingTimeConstant = 0.85;
    source.connect(state.analyser);
    state.micSourceNode = source;
    state.micEnabled = true;
    return true;
  } catch (e) {
    console.warn('[silence] mic unavailable:', e.message);
    return false;
  }
}

// v1.3: stop the mic cleanly. Called on completeSession so the
// browser's "recording" indicator doesn't stay lit.
function stopMic() {
  try { if (state.analyser) state.analyser.disconnect(); } catch (_) {}
  try { if (state.micSourceNode) state.micSourceNode.disconnect(); } catch (_) {}
  if (state.micStream) {
    try { state.micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  }
  state.micStream = null;
  state.micSourceNode = null;
  state.analyser = null;
  state.micEnabled = false;
}

function attachSttTap() {
  if (!state.audioCtx || !state.micSourceNode) return;
  if (state.sttProcessor) return;
  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {});
  }
  const proc = state.audioCtx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (ev) => {
    if (!state.voiceNotesEnabled) return;
    if (state.paused) return;
    const ch = ev.inputBuffer.getChannelData(0);
    whisper.appendSamples(ch);
  };
  state.micSourceNode.connect(proc);
  const sink = state.audioCtx.createGain();
  sink.gain.value = 0;
  proc.connect(sink);
  sink.connect(state.audioCtx.destination);
  state.sttProcessor = proc;
  state.sttSink = sink;
}

function detachSttTap() {
  if (state.sttProcessor) {
    // v1.3: disconnect from the source specifically, then the processor's
    // own outputs, to avoid dangling graph edges on iOS Safari.
    try { state.micSourceNode && state.micSourceNode.disconnect(state.sttProcessor); } catch (_) {}
    try { state.sttProcessor.disconnect(); } catch (_) {}
    state.sttProcessor.onaudioprocess = null;
    state.sttProcessor = null;
  }
  if (state.sttSink) {
    try { state.sttSink.disconnect(); } catch (_) {}
    state.sttSink = null;
  }
}

function readMicLevel() {
  if (!state.analyser) return 0;
  const buf = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

/* ============================================================ */
/* 10. Sensing: motion                                          */
/* ============================================================ */
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
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
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

/* ============================================================ */
/* 11. Wake lock                                                */
/* ============================================================ */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (e) { state.lastWakeLockError = e && e.message || String(e); }
}
function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

/* ============================================================ */
/* 12. Permissions flow                                         */
/* ============================================================ */
function needsPermissionFlow() { return localStorage.getItem('silence.permSeen') !== '1'; }
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
// v1.3: query Permissions API for live status (where supported).
async function queryPermissionState(name) {
  if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
  try {
    const r = await navigator.permissions.query({ name });
    return r.state; // 'granted' | 'denied' | 'prompt'
  } catch (_) { return 'unknown'; }
}

/* ============================================================ */
/* 13. Mode selection                                           */
/* ============================================================ */
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

/* ============================================================ */
/* 14. Steady Night transitions                                 */
/* ============================================================ */
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

/* ============================================================ */
/* 15. Pause state machine                                      */
/* ============================================================ */
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
  haptics.medium();
  haptics.warning();
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
  if (state.pauseTimeoutId) { clearTimeout(state.pauseTimeoutId); state.pauseTimeoutId = null; }
  state.silenceContinuousSince = now;
  state.motionSince = null;
  state.focusLostSince = null;
  setRunningUI(true, false);
  audio.playZoomIn();
  haptics.medium();
}

/* ============================================================ */
/* 16. Timer + sensing loop                                     */
/* ============================================================ */
function updateRing() {
  const C = CONFIG.RING_CIRCUMFERENCE;
  let p = 0;
  if (state.duration > 0) p = Math.min(state.elapsed / state.duration, 1);
  else p = Math.min(state.elapsed / CONFIG.INFINITY_CAP_SECONDS, 1);
  dom.ringProgress.style.strokeDashoffset = C * (1 - p);
}
function updateDialTime() {
  if (state.duration === 0) dom.dialTime.textContent = fmtTime(state.elapsed);
  else {
    const rem = Math.max(0, state.duration - state.elapsed);
    dom.dialTime.textContent = fmtTime(rem);
  }
}
function setRunningUI(running, paused = false) {
  dom.dial.classList.toggle('running', running);
  dom.dial.classList.toggle('paused', paused);
  dom.startBtn.hidden = running;
  dom.stopBtn.hidden = !running;
  dom.status.hidden = !running;
  dom.status.classList.toggle('paused', paused);
  if (!running) dom.dialLabel.textContent = 'SILENCE';
  else if (paused) {
    dom.dialLabel.textContent = 'RESUME';
    dom.statusText.textContent = pauseStatusText();
  } else {
    dom.dialLabel.textContent = 'SILENCE';
    dom.statusText.textContent = 'Listening for silence…';
  }
}
function pauseStatusText() {
  const m = { tap: 'You tapped the screen', motion: 'Phone moved', focus: 'App in background' };
  const base = m[state.pauseReason] || 'Interrupted';
  if (state.pausedAt) {
    const left = Math.max(0, CONFIG.PAUSE_TIMEOUT_MS - (Date.now() - state.pausedAt));
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    return `${base} · resume within ${mins}:${String(secs).padStart(2, '0')}`;
  }
  return base;
}

// Model cache tracking
const MODEL_CACHED_KEY = 'silence.modelCached.v1';
function modelEverCached() {
  try { return localStorage.getItem(MODEL_CACHED_KEY) === '1'; } catch (_) { return false; }
}
function markModelCached() {
  try { localStorage.setItem(MODEL_CACHED_KEY, '1'); } catch (_) {}
}

let dlBarHideTimer = null;
function showDownloadBar() {
  if (!dom.dlBar) return;
  if (dlBarHideTimer) { clearTimeout(dlBarHideTimer); dlBarHideTimer = null; }
  dom.dlBar.hidden = false;
  dom.dlBar.classList.remove('done');
}
function updateDownloadBar(p) {
  if (!dom.dlBar || !dom.dlBarFill || !dom.dlBarPct) return;
  const pct = Math.max(0, Math.min(100, Math.round((p || 0) * 100)));
  dom.dlBarFill.style.width = pct + '%';
  dom.dlBarPct.textContent = pct + '%';
}
function finishDownloadBar() {
  if (!dom.dlBar) return;
  dom.dlBar.classList.add('done');
  if (dom.dlBarFill) dom.dlBarFill.style.width = '100%';
  if (dom.dlBarPct) dom.dlBarPct.textContent = 'Ready';
  if (dom.dlBarSub) dom.dlBarSub.textContent = 'Model cached on your device';
  dlBarHideTimer = setTimeout(() => { if (dom.dlBar) dom.dlBar.hidden = true; }, 2200);
  markModelCached();
  renderModelStatus();
}

function renderModelStatus() {
  if (!dom.modelStatus) return;
  const ready = whisper.ready, loading = whisper.loading, cached = modelEverCached();
  if (ready || cached) {
    dom.modelStatus.classList.add('installed');
    if (dom.modelCheck) dom.modelCheck.hidden = false;
    if (dom.modelStatusText) dom.modelStatusText.textContent = 'Installed';
    if (dom.modelDlBtn) dom.modelDlBtn.disabled = true;
  } else if (loading) {
    dom.modelStatus.classList.remove('installed');
    if (dom.modelCheck) dom.modelCheck.hidden = true;
    const pct = Math.round((whisper.loadProgress || 0) * 100);
    if (dom.modelStatusText) dom.modelStatusText.textContent = `Downloading… ${pct}%`;
    if (dom.modelDlBtn) dom.modelDlBtn.disabled = true;
  } else {
    dom.modelStatus.classList.remove('installed');
    if (dom.modelCheck) dom.modelCheck.hidden = true;
    if (dom.modelStatusText) dom.modelStatusText.textContent = 'Not installed';
    if (dom.modelDlBtn) {
      dom.modelDlBtn.disabled = false;
      dom.modelDlBtn.textContent = 'Download';
    }
  }
}

function triggerModelDownload() {
  if (whisper.ready) { renderModelStatus(); return; }
  whisper.preload((s) => {
    updateSttStatus(s);
    renderModelStatus();
  });
  renderModelStatus();
}

function updateSttStatus(s) {
  if (s.state === 'loading' && !modelEverCached()) {
    showDownloadBar();
    updateDownloadBar(s.progress || 0);
  } else if (s.state === 'ready') {
    if (dom.dlBar && !dom.dlBar.hidden) finishDownloadBar();
    else markModelCached();
  }
  if (!state.voiceNotesEnabled) return;
  if (state.paused) return;
  if (!dom.statusText) return;
  if (s.state === 'loading') {
    const pct = Math.round((s.progress || 0) * 100);
    dom.statusText.textContent = pct > 0 ? `Loading ideas… ${pct}%` : 'Loading ideas…';
  } else if (s.state === 'unsupported') dom.statusText.textContent = 'Ideas unsupported on this device';
  else if (s.state === 'ready') dom.statusText.textContent = 'Listening for silence…';
}
function clearSttStatus() { /* next setRunningUI(false) resets */ }

/* v1.3: sensingTick is now the rendering tick — it ALWAYS advances
   elapsed from Date.now() delta, so if rAF gets throttled the
   setInterval backstop still keeps the clock ticking. */
function sensingTick() {
  if (!state.running) return;
  const now = Date.now();

  // dB throttling — sample no faster than DB_SAMPLE_INTERVAL_MS
  if (state.micEnabled && !state.paused) {
    if (now - state.lastDbSampleAt >= CONFIG.DB_SAMPLE_INTERVAL_MS) {
      state.lastDbSampleAt = now;
      state.currentLevel = readMicLevel();
      const dbv = levelToDb(state.currentLevel);
      state.dbSum += dbv;
      state.dbSamples += 1;
      if (dbv > state.dbPeak) state.dbPeak = dbv;
    }
  }

  if (state.motionEnabled) {
    const moving = state.currentMotion > CONFIG.MOTION_THRESHOLD;
    if (moving) { if (!state.motionSince) state.motionSince = now; }
    else state.motionSince = null;
    const motionPause = state.motionSince && (now - state.motionSince > CONFIG.MOTION_GRACE_MS);
    if (motionPause && !state.paused) enterPause('motion');
  }

  if (document.hidden) {
    if (!state.focusLostSince) state.focusLostSince = now;
    const focusPause = (now - state.focusLostSince) > CONFIG.FOCUS_GRACE_MS;
    if (focusPause && !state.paused) enterPause('focus');
  } else state.focusLostSince = null;

  if (!state.paused && state.lastTickAt) {
    const dt = (now - state.lastTickAt) / 1000;
    state.elapsed += dt;
  }
  state.lastTickAt = now;

  if (!state.paused) {
    if (!state.silenceContinuousSince) state.silenceContinuousSince = now;
    const silentFor = now - state.silenceContinuousSince;
    if (!state.night && silentFor >= CONFIG.NIGHT_THRESHOLD_MS) enterNight();
  }
  if (state.paused) dom.statusText.textContent = pauseStatusText();

  updateDialTime();
  updateRing();

  if (state.duration > 0 && state.elapsed >= state.duration) { completeSession(true, 'complete'); return; }
  if (state.duration === 0 && state.elapsed >= CONFIG.INFINITY_CAP_SECONDS) { completeSession(true, 'infinity-cap'); return; }

  state.sensingFrame = requestAnimationFrame(sensingTick);
}

/* ============================================================ */
/* 17. Session lifecycle                                        */
/* ============================================================ */
function maybeAskVoiceNotes() {
  return new Promise((resolve) => {
    const pref = settings.get('voiceNotes');
    if (pref === 'on') return resolve(true);
    if (pref === 'off') return resolve(false);
    if (!dom.vnConfirmOverlay) return resolve(false);
    if (dom.vnDownloadNotice) dom.vnDownloadNotice.style.display = modelEverCached() ? 'none' : '';
    dom.vnConfirmOverlay.hidden = false;
    const cleanup = () => {
      dom.vnConfirmOverlay.hidden = true;
      dom.vnYesSession.removeEventListener('click', onYes);
      dom.vnAlwaysOn.removeEventListener('click', onAlways);
      dom.vnNotThisTime.removeEventListener('click', onNo);
    };
    const onYes = () => { haptics.tap(); cleanup(); resolve(true); };
    const onAlways = () => { haptics.tap(); settings.set('voiceNotes', 'on'); applySettingsUI(); cleanup(); resolve(true); };
    const onNo = () => { haptics.tap(); cleanup(); resolve(false); };
    dom.vnYesSession.addEventListener('click', onYes);
    dom.vnAlwaysOn.addEventListener('click', onAlways);
    dom.vnNotThisTime.addEventListener('click', onNo);
  });
}

async function startSession() {
  if (state.running) return;
  state.voiceNotesEnabled = false;
  state.voiceNotesText = '';
  if (state.mode === 'infinity') state.voiceNotesEnabled = await maybeAskVoiceNotes();
  if (!state.micEnabled) await startMic();
  if (!state.motionEnabled) await startMotion();
  await requestWakeLock();

  if (state.voiceNotesEnabled) {
    whisper.preload((s) => updateSttStatus(s));
    whisper.setLanguage(settings.get('voiceNotesLang'));
    whisper.startSession(
      state.audioCtx ? state.audioCtx.sampleRate : 48000,
      (text) => {
        state.voiceNotesText = state.voiceNotesText
          ? (state.voiceNotesText + ' ' + text) : text;
      }
    );
    attachSttTap();
  }

  state.running = true;
  state.paused = false;
  state.startedAt = Date.now();
  state.elapsed = 0;
  state.lastTickAt = Date.now();
  state.lastDbSampleAt = 0;
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
  haptics.heavy();
  setRunningUI(true);

  state.sensingFrame = requestAnimationFrame(sensingTick);
  // v1.3 backstop: keep the clock advancing even if rAF is throttled.
  if (!state.loopBackstopTimer) {
    state.loopBackstopTimer = setInterval(() => {
      if (!state.running) return;
      // If rAF hasn't fired recently, forcibly tick once.
      if (Date.now() - (state.lastTickAt || 0) > CONFIG.LOOP_BACKSTOP_MS * 1.5) {
        sensingTick();
      }
    }, CONFIG.LOOP_BACKSTOP_MS);
  }
}

async function completeSession(naturalFinish = false, reason = 'manual') {
  if (!state.running) return;
  state.running = false;
  state.paused = false;
  if (state.sensingFrame) cancelAnimationFrame(state.sensingFrame);
  state.sensingFrame = null;
  if (state.loopBackstopTimer) { clearInterval(state.loopBackstopTimer); state.loopBackstopTimer = null; }
  if (state.pauseTimeoutId) { clearTimeout(state.pauseTimeoutId); state.pauseTimeoutId = null; }

  if (state.voiceNotesEnabled) {
    detachSttTap();
    try { await whisper.endSession(); } catch (_) {}
    clearSttStatus();
  }

  const avgDb = state.dbSamples > 0 ? Math.round(state.dbSum / state.dbSamples) : null;
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
    avgDb, peakDb,
    rating: null,
  };
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
  // v1.3: stop the mic so the recording indicator clears.
  stopMic();
  if (state.night) exitNight();

  const modesWithChime = new Set(['before', 'after', 'unwind']);
  if (naturalFinish && modesWithChime.has(session.mode)) {
    audio.playFinish();
    haptics.success();
  }
  if (reason !== 'closed') showSummary(session);
}

function commitSessionOnUnload() {
  if (!state.running) return;
  if (state.sensingFrame) cancelAnimationFrame(state.sensingFrame);
  if (state.loopBackstopTimer) clearInterval(state.loopBackstopTimer);
  if (state.pauseTimeoutId) clearTimeout(state.pauseTimeoutId);
  if (state.voiceNotesEnabled) detachSttTap();

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
    avgDb, peakDb,
    rating: null,
  };
  if (state.voiceNotesText && state.voiceNotesText.trim()) {
    session.voiceNotes = state.voiceNotesText.trim();
  }
  try { db.add(session); } catch (_) {}
  // Best-effort stop mic synchronously.
  try { state.micStream && state.micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  state.running = false;
}

/* ============================================================ */
/* 18. Summary                                                  */
/* ============================================================ */
function showSummary(session) {
  dom.summaryModeIcon.innerHTML = modeIconSVG(session.mode, 24);
  const mins = Math.floor(session.silentSeconds / 60);
  const secs = session.silentSeconds % 60;
  const phrasing = mins > 0
    ? `${mins} minute${mins === 1 ? '' : 's'}${secs > 0 ? ' ' + secs + 's' : ''} of silence`
    : `${secs} seconds of silence`;
  let title = 'Session complete';
  if (session.endReason === 'manual') title = 'Session saved';
  if (session.endReason === 'pause-timeout') title = 'Session ended';
  dom.summaryTitle.textContent = title;
  dom.summarySub.textContent = phrasing;
  dom.summaryDuration.textContent = fmtDuration(session.silentSeconds);
  dom.summaryInterrupted.textContent = session.interrupted ? 'Yes' : 'No';
  dom.summaryInterrupted.className = 's-value ' + (session.interrupted ? 'yes' : 'no');
  dom.summaryAvgDb.textContent = session.avgDb != null ? `${session.avgDb} dB` : '—';
  dom.summaryPeakDb.textContent = session.peakDb != null ? `${session.peakDb} dB` : '—';
  dom.ratingStars.classList.remove('submitted');
  dom.ratingStars.querySelectorAll('.rating-star').forEach(s => s.classList.remove('lit'));
  dom.ratingPrompt.textContent = 'How did it feel?';
  dom.ratingSkip.style.display = '';
  dom.summaryOverlay.hidden = false;
}
async function submitRating(n) {
  dom.ratingStars.classList.add('submitted');
  dom.ratingStars.querySelectorAll('.rating-star').forEach((s, i) => s.classList.toggle('lit', i < n));
  audio.playRating(n);
  haptics.tap();
  dom.ratingPrompt.textContent = 'Saved.';
  dom.ratingSkip.style.display = 'none';
  if (state.currentSessionId != null) {
    try {
      const existing = await db.getById(state.currentSessionId);
      if (existing) { existing.rating = n; await db.update(existing); }
    } catch (e) { console.warn('[silence] rating save failed:', e); }
  }
  setTimeout(() => { dom.summaryOverlay.hidden = true; }, 900);
}

/* ============================================================ */
/* 19. Log render                                               */
/* ============================================================ */
async function renderLog() {
  const sinceTs = daysAgo(CONFIG.LOG_DAYS - 1);
  const sessions = await db.getSince(sinceTs);
  const days = [];
  for (let i = CONFIG.LOG_DAYS - 1; i >= 0; i--) {
    const ds = daysAgo(i);
    const de = ds + 86400000;
    const ss = sessions.filter(s => s.startedAt >= ds && s.startedAt < de);
    const total = ss.reduce((sum, s) => sum + s.silentSeconds, 0);
    days.push({ ts: ds, sessions: ss, total });
  }
  let totalSeconds = 0, longest = 0;
  sessions.forEach(s => { totalSeconds += s.silentSeconds; if (s.silentSeconds > longest) longest = s.silentSeconds; });
  dom.totalWeek.textContent = fmtTotal(totalSeconds);
  dom.totalSessions.textContent = String(sessions.length);
  dom.longestSession.textContent = fmtTotal(longest);
  const maxTotal = Math.max(...days.map(d => d.total), 60);
  const todayStart = startOfDay();
  dom.logChart.innerHTML = '';
  days.forEach((d) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.dataset.ts = d.ts;
    const rated = d.sessions.filter(s => s.rating != null);
    let avgRating = 0;
    if (rated.length > 0) avgRating = Math.round(rated.reduce((s, r) => s + r.rating, 0) / rated.length);
    const rr = document.createElement('div'); rr.className = 'bar-rating';
    for (let i = 1; i <= 5; i++) {
      const st = document.createElement('span');
      st.className = 'bar-rating-star' + (i <= avgRating ? ' lit' : '');
      st.innerHTML = STAR_SVG_INLINE;
      rr.appendChild(st);
    }
    col.appendChild(rr);
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('div'); fill.className = 'bar-fill';
    fill.style.height = ((d.total / maxTotal) * 100) + '%';
    bar.appendChild(fill);
    const label = document.createElement('div');
    label.className = 'bar-day' + (d.ts === todayStart ? ' today' : '');
    label.textContent = dayLabel(d.ts);
    col.appendChild(bar); col.appendChild(label);
    dom.logChart.appendChild(col);
  });
  const desc = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  if (desc.length === 0) {
    dom.logList.innerHTML = '<div class="log-empty">Your silence log will appear here.<br>Start a session to begin.</div>';
    dom.logSub.textContent = 'No sessions yet';
    return;
  }
  dom.logSub.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · last ${CONFIG.LOG_DAYS} days`;
  let html = ''; let lastDay = null;
  desc.forEach(s => {
    const dk = startOfDay(new Date(s.startedAt));
    if (dk !== lastDay) { html += `<div class="log-day">${fullDateLabel(s.startedAt)}</div>`; lastDay = dk; }
    const isPartial = !s.completed;
    const dot = s.interrupted ? '<span class="log-interrupted-dot" title="Interrupted"></span>' : '';
    const dbLabel = (s.avgDb != null) ? `<span class="log-db">${s.avgDb} dB</span>` : '';
    let ratingHTML = '';
    if (s.rating != null) {
      ratingHTML = '<div class="log-entry-rating">';
      for (let i = 1; i <= 5; i++) ratingHTML += `<span class="log-entry-rating-star${i <= s.rating ? ' lit' : ''}">${STAR_SVG_INLINE}</span>`;
      ratingHTML += '</div>';
    }
    let vnBadge = '', vnPanel = '';
    if (s.voiceNotes && s.id != null) {
      vnBadge = `<button type="button" class="log-vn-badge" data-vn-toggle="${s.id}" aria-expanded="false" aria-controls="vn-panel-${s.id}">${NOTEBOOK_SVG_INLINE}<span>Ideas</span></button>`;
      vnPanel = `
        <div class="log-vn-panel" id="vn-panel-${s.id}" data-vn-panel="${s.id}" hidden>
          <p class="log-vn-text">${escapeHTML(s.voiceNotes)}</p>
          <div class="log-vn-actions">
            <button type="button" class="log-vn-copy" data-vn-copy="${s.id}">Copy</button>
          </div>
        </div>`;
    }
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

/* ============================================================ */
/* 20. STT diagnostic (Ideas panel)                             */
/* ============================================================ */
let mumblesDebugTimer = null;
function setDbg(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = 'debug-v' + (cls ? ' ' + cls : '');
}
function updateMumblesDebug() {
  if (!dom.dbgState) return;
  try {
    const s = (window.whisper && typeof whisper.getStats === 'function') ? whisper.getStats() : null;
    if (!s) { setDbg(dom.dbgState, 'whisper not loaded', 'err'); return; }
    const cls = s.state === 'ready' ? 'ok' : s.state === 'loading' ? 'warn' : s.state === 'unsupported' ? 'err' : 'muted';
    setDbg(dom.dbgState, s.state, cls);
    if (s.state === 'ready') setDbg(dom.dbgProgress, '100% (cached)', 'ok');
    else if (s.state === 'loading') setDbg(dom.dbgProgress, Math.round((s.progress || 0) * 100) + '%', 'warn');
    else setDbg(dom.dbgProgress, '—', 'muted');
    setDbg(dom.dbgSession, s.sessionActive ? 'yes' : 'no', s.sessionActive ? 'ok' : 'muted');
    const tapOn = !!state.sttProcessor;
    setDbg(dom.dbgTap, tapOn ? 'connected' : 'detached', tapOn ? 'ok' : 'muted');
    if (state.audioCtx) { const cs = state.audioCtx.state; setDbg(dom.dbgCtx, cs, cs === 'running' ? 'ok' : cs === 'suspended' ? 'err' : 'warn'); }
    else setDbg(dom.dbgCtx, 'not created', 'muted');
    setDbg(dom.dbgRate, s.inputSampleRate ? s.inputSampleRate + ' Hz' : '—', s.inputSampleRate ? 'ok' : 'muted');
    setDbg(dom.dbgBuffer, s.bufferSamples + ' samp · ' + s.bufferSeconds.toFixed(1) + 's', s.bufferSamples > 0 ? 'ok' : 'muted');
    setDbg(dom.dbgChunks, s.chunksSent + ' / ' + s.chunksDone + ' / ' + s.chunksPending, s.chunksDone > 0 ? 'ok' : s.chunksPending > 0 ? 'warn' : 'muted');
    const last = (whisper.lastResult || '').trim();
    setDbg(dom.dbgLast, last || '—', last ? 'ok' : 'muted');
    const accum = (state.voiceNotesText || '').trim();
    if (accum) setDbg(dom.dbgAccum, (accum.length > 80 ? accum.slice(0, 80) + '…' : accum) + ' (' + accum.length + 'ch)', 'ok');
    else setDbg(dom.dbgAccum, '—', 'muted');
    setDbg(dom.dbgError, s.error || 'none', s.error ? 'err' : 'muted');
  } catch (err) { setDbg(dom.dbgError, 'panel error: ' + err.message, 'err'); }
}
function startMumblesDebugPolling() {
  if (mumblesDebugTimer) return;
  updateMumblesDebug();
  renderModelStatus();
  renderDiagnostics();
  mumblesDebugTimer = setInterval(() => {
    updateMumblesDebug();
    renderModelStatus();
    renderDiagnostics();
  }, 500);
}
function stopMumblesDebugPolling() {
  if (mumblesDebugTimer) { clearInterval(mumblesDebugTimer); mumblesDebugTimer = null; }
}

function renderCrashLog() {
  if (!dom.crashLogList) return;
  const list = crashLog.read();
  const dropped = crashLog.droppedCount();
  if (dom.crashLogCount) {
    if (list.length > 0) { dom.crashLogCount.textContent = `(${list.length})`; dom.crashLogCount.classList.add('has-crashes'); }
    else { dom.crashLogCount.textContent = ''; dom.crashLogCount.classList.remove('has-crashes'); }
  }
  if (list.length === 0) {
    dom.crashLogList.innerHTML = '<span style="color:var(--c-4);">No crashes recorded.</span>';
    return;
  }
  let html = '';
  if (dropped > 0) html += `<div class="cl-dropped">${dropped} older entr${dropped === 1 ? 'y' : 'ies'} dropped (keeping most recent ${CRASH_LOG_MAX}).</div>`;
  for (const e of list) {
    const d = new Date(e.ts);
    const when = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    const meta = [];
    if (e.mode) meta.push(e.mode);
    if (e.running) meta.push(`running ${e.elapsed}s`);
    if (e.vnEnabled) meta.push('ideas on');
    if (e.source) meta.push(e.source);
    html += `<div class="crashlog-entry">
      <div class="cl-head"><span class="cl-kind">${escapeHTML(e.kind)}</span><span>${escapeHTML(when)}</span></div>
      <div class="cl-msg">${escapeHTML(e.message || '(no message)')}</div>
      <div class="cl-meta">${escapeHTML(meta.join(' · '))}</div>
      ${e.stack ? `<pre>${escapeHTML(e.stack)}</pre>` : ''}
    </div>`;
  }
  dom.crashLogList.innerHTML = html;
}

function applySettingsUI() {
  const pack = settings.get('soundPack');
  const haptOn = settings.get('haptics') === 'on';
  const vn = settings.get('voiceNotes');
  if (dom.soundPackChips) dom.soundPackChips.querySelectorAll('.settings-chip').forEach((c) => {
    const sel = c.dataset.pack === pack; c.classList.toggle('selected', sel); c.setAttribute('aria-checked', String(sel));
  });
  if (dom.voiceNotesChips) dom.voiceNotesChips.querySelectorAll('.settings-chip').forEach((c) => {
    const sel = c.dataset.vn === vn; c.classList.toggle('selected', sel); c.setAttribute('aria-checked', String(sel));
  });
  if (dom.voiceNotesLangChips) {
    const l = settings.get('voiceNotesLang') || 'auto';
    dom.voiceNotesLangChips.querySelectorAll('.settings-chip').forEach((c) => {
      const sel = c.dataset.vnLang === l; c.classList.toggle('selected', sel); c.setAttribute('aria-checked', String(sel));
    });
  }
  if (dom.hapticsToggle) dom.hapticsToggle.setAttribute('aria-checked', String(haptOn));
  if (dom.hapticsHint) {
    if (!haptOn) dom.hapticsHint.textContent = 'Off';
    else {
      const b = haptics.backend();
      dom.hapticsHint.textContent = b === 'telegram' ? 'Native (Telegram)' : b === 'vibrate' ? 'Web Vibration API' : 'Not supported on this device';
    }
  }
}

/* ============================================================ */
/* 21. Diagnostics — comprehensive debug panel (NEW)            */
/* ============================================================ */
/* Injects a <details> block under Settings that shows live      */
/* readouts for every subsystem plus Copy-All-as-JSON and        */
/* Run Self-Test buttons. Polled while the log overlay is open. */
/* ============================================================ */
const Diag = {
  _perms: { microphone: 'unknown', accelerometer: 'unknown' },
  _sw: { registered: false, controller: false, cacheCount: null, cacheNames: [] },
  _lastSelfTest: null,

  async refreshStatic() {
    // Permissions (on-demand; state can change without event in all browsers)
    try {
      this._perms.microphone = await queryPermissionState('microphone');
    } catch (_) { this._perms.microphone = 'unknown'; }
    // accelerometer is almost never in Permissions API — we expose our own flag
    this._perms.accelerometer = state.motionEnabled
      ? 'granted'
      : (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
        ? 'prompt' : 'auto-or-unsupported';
    // Service worker + caches
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        this._sw.registered = !!reg;
        this._sw.controller = !!navigator.serviceWorker.controller;
        state.swRegistration = reg || null;
      }
      if ('caches' in window) {
        const names = await caches.keys();
        this._sw.cacheNames = names;
        let total = 0;
        for (const n of names) {
          try { const c = await caches.open(n); const keys = await c.keys(); total += keys.length; }
          catch (_) {}
        }
        this._sw.cacheCount = total;
      }
    } catch (e) {
      state.swError = e && e.message || String(e);
    }
  },

  ensurePanel() {
    if (dom.diagPanel) return;
    const anchor = dom.mumblesDebug || dom.crashLogPanel;
    if (!anchor || !anchor.parentNode) return;
    const det = document.createElement('details');
    det.className = 'settings-debug';
    det.id = 'diagPanel';
    det.innerHTML = `
      <summary>Diagnostics</summary>
      <div class="diag-wrap">
        <div class="diag-meter-wrap" id="diagMeterWrap">
          <div class="diag-meter-label">Live mic level</div>
          <div class="diag-meter"><div class="diag-meter-fill" id="diagMeter"></div></div>
          <div class="diag-meter-label">Live motion</div>
          <div class="diag-meter"><div class="diag-meter-fill motion" id="diagMotionBar"></div></div>
        </div>
        <div class="debug-grid" id="diagGrid"></div>
        <div class="diag-actions">
          <button type="button" class="settings-chip" id="diagRefreshBtn">Refresh</button>
          <button type="button" class="settings-chip" id="diagRequestPermsBtn">Re-request permissions</button>
          <button type="button" class="settings-chip" id="diagSelfTestBtn">Run self-test</button>
          <button type="button" class="settings-chip" id="diagCopyBtn">Copy all as JSON</button>
        </div>
        <div class="diag-selftest" id="diagSelfTest"></div>
      </div>
    `;
    anchor.parentNode.insertBefore(det, anchor.nextSibling);
    dom.diagPanel = det;
    dom.diagGrid = det.querySelector('#diagGrid');
    dom.diagMeter = det.querySelector('#diagMeter');
    dom.diagMotionBar = det.querySelector('#diagMotionBar');
    dom.diagCopyBtn = det.querySelector('#diagCopyBtn');
    dom.diagSelfTestBtn = det.querySelector('#diagSelfTestBtn');
    dom.diagRequestPermsBtn = det.querySelector('#diagRequestPermsBtn');
    dom.diagRefreshBtn = det.querySelector('#diagRefreshBtn');
    this._wireButtons(det);
    this.refreshStatic();
  },

  _wireButtons(det) {
    dom.diagRefreshBtn && dom.diagRefreshBtn.addEventListener('click', async () => {
      haptics.tap();
      await this.refreshStatic();
      renderDiagnostics();
    });
    dom.diagRequestPermsBtn && dom.diagRequestPermsBtn.addEventListener('click', async () => {
      haptics.tap();
      // Re-request mic and motion. If the user previously denied in the
      // browser this will typically still just read "denied" — we surface
      // that in the panel.
      await startMic();
      await startMotion();
      await this.refreshStatic();
      renderDiagnostics();
    });
    dom.diagCopyBtn && dom.diagCopyBtn.addEventListener('click', async () => {
      haptics.tap();
      const snapshot = await this.snapshot();
      const text = JSON.stringify(snapshot, null, 2);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy');
          document.body.removeChild(ta);
        }
        const orig = dom.diagCopyBtn.textContent;
        dom.diagCopyBtn.textContent = 'Copied';
        setTimeout(() => { dom.diagCopyBtn.textContent = orig; }, 1200);
      } catch (_) {}
    });
    dom.diagSelfTestBtn && dom.diagSelfTestBtn.addEventListener('click', () => {
      haptics.tap();
      this.runSelfTest();
    });
  },

  async snapshot() {
    await this.refreshStatic();
    return {
      app: {
        version: APP_VERSION,
        build: BUILD_TS,
        ua: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        telegram: !!(window.Telegram && window.Telegram.WebApp),
        standalone: (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || !!navigator.standalone,
      },
      permissions: this._perms,
      audio: {
        ctxExists: !!state.audioCtx,
        ctxState: state.audioCtx ? state.audioCtx.state : null,
        sampleRate: state.audioCtx ? state.audioCtx.sampleRate : null,
        masterGain: audio.masterGain ? audio.masterGain.gain.value : null,
      },
      mic: {
        enabled: state.micEnabled,
        streamActive: !!(state.micStream && state.micStream.active),
        tracks: state.micStream ? state.micStream.getTracks().map(t => ({ label: t.label, kind: t.kind, state: t.readyState, muted: t.muted })) : [],
        currentLevel: state.currentLevel,
        currentDb: levelToDb(state.currentLevel),
        avgDb: state.dbSamples > 0 ? state.dbSum / state.dbSamples : null,
        peakDb: isFinite(state.dbPeak) ? state.dbPeak : null,
        samples: state.dbSamples,
      },
      motion: {
        enabled: state.motionEnabled,
        current: state.currentMotion,
        threshold: CONFIG.MOTION_THRESHOLD,
        wouldPause: state.currentMotion > CONFIG.MOTION_THRESHOLD,
      },
      wakeLock: {
        supported: 'wakeLock' in navigator,
        held: !!state.wakeLock,
        lastError: state.lastWakeLockError,
      },
      serviceWorker: {
        supported: 'serviceWorker' in navigator,
        registered: this._sw.registered,
        controlled: this._sw.controller,
        cacheNames: this._sw.cacheNames,
        cacheEntries: this._sw.cacheCount,
        lastError: state.swError,
      },
      storage: {
        idbOpenError: state.dbOpenError,
      },
      session: {
        running: state.running, paused: state.paused, mode: state.mode,
        duration: state.duration, elapsed: Math.round(state.elapsed),
        interruptions: state.interruptionCount, pauseReason: state.pauseReason,
        night: state.night,
        silenceContinuousMs: state.silenceContinuousSince ? (Date.now() - state.silenceContinuousSince) : 0,
      },
      stt: (window.whisper && typeof whisper.getStats === 'function') ? whisper.getStats() : null,
      crashLog: { count: crashLog.read().length, dropped: crashLog.droppedCount() },
      selfTest: this._lastSelfTest,
    };
  },

  async runSelfTest() {
    const panel = document.getElementById('diagSelfTest');
    if (panel) panel.innerHTML = '<em>Running…</em>';
    const results = [];
    const log = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });
    // 1. Audio tone
    try {
      await audio.init(); await audio.resume();
      const now = audio.ctx.currentTime;
      const o = audio.ctx.createOscillator(), g = audio.ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.1, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      o.connect(g); g.connect(audio.masterGain);
      o.start(now); o.stop(now + 0.3);
      log('Audio tone (880 Hz, 250 ms)', true, 'ctx=' + audio.ctx.state + ', rate=' + audio.ctx.sampleRate + 'Hz');
    } catch (e) { log('Audio tone', false, e.message); }
    // 2. Haptic
    try {
      haptics.tap();
      log('Haptic (tap)', true, 'backend=' + haptics.backend());
    } catch (e) { log('Haptic', false, e.message); }
    // 3. Mic permission check
    log('Mic permission', this._perms.microphone === 'granted', 'state=' + this._perms.microphone);
    // 4. Mic level
    try {
      if (state.micEnabled && state.analyser) {
        const lvl = readMicLevel();
        log('Mic level read', lvl >= 0, 'rms=' + lvl.toFixed(5) + ' (' + levelToDb(lvl).toFixed(1) + ' dB)');
      } else log('Mic level read', false, 'mic not started');
    } catch (e) { log('Mic level', false, e.message); }
    // 5. IndexedDB round-trip
    try {
      const testSession = {
        startedAt: Date.now(), endedAt: Date.now(), mode: '__diag__',
        targetSeconds: 0, silentSeconds: 0, completed: false,
        endReason: 'self-test', interrupted: false, interruptionCount: 0,
        pausedTotalSeconds: 0, avgDb: null, peakDb: null, rating: null,
      };
      const id = await db.add(testSession);
      const read = await db.getById(id);
      // Remove it so it doesn't pollute the log
      try {
        const d = await db.open();
        const tx = d.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').delete(id);
        await new Promise(r => tx.oncomplete = r);
      } catch (_) {}
      log('IndexedDB round-trip', !!read, 'id=' + id);
    } catch (e) { log('IndexedDB round-trip', false, e.message); }
    // 6. Service worker / cache
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        log('Service worker registered', !!reg, reg ? ('scope=' + reg.scope) : 'no registration');
      } else log('Service worker', false, 'unsupported');
    } catch (e) { log('Service worker', false, e.message); }
    // 7. Wake lock capability (don't actually hold it)
    log('Wake Lock API', 'wakeLock' in navigator, 'wakeLock' in navigator ? 'available' : 'unsupported');
    // 8. localStorage write
    try {
      const key = '__diag_ls_test__';
      localStorage.setItem(key, 'ok');
      const ok = localStorage.getItem(key) === 'ok';
      localStorage.removeItem(key);
      log('localStorage', ok, ok ? 'read/write ok' : 'mismatch');
    } catch (e) { log('localStorage', false, e.message); }

    this._lastSelfTest = { ts: Date.now(), results };
    if (panel) {
      panel.innerHTML = results.map(r =>
        `<div class="diag-test-row ${r.ok ? 'ok' : 'err'}">
          <span class="diag-test-name">${r.ok ? '✓' : '✗'} ${escapeHTML(r.name)}</span>
          <span class="diag-test-detail">${escapeHTML(r.detail)}</span>
        </div>`
      ).join('');
    }
  },
};

function renderDiagnostics() {
  if (!dom.diagPanel) return;
  // Live meters (don't wait for snapshot)
  if (dom.diagMeter) {
    const pct = state.currentLevel > 0 ? Math.min(100, Math.round(levelToDb(state.currentLevel))) : 0;
    dom.diagMeter.style.width = Math.max(0, pct) + '%';
  }
  if (dom.diagMotionBar) {
    const mp = Math.min(100, Math.round((state.currentMotion / (CONFIG.MOTION_THRESHOLD * 2)) * 100));
    dom.diagMotionBar.style.width = mp + '%';
    dom.diagMotionBar.classList.toggle('over', state.currentMotion > CONFIG.MOTION_THRESHOLD);
  }
  if (!dom.diagGrid) return;
  const rows = [];
  const row = (k, v, cls) => rows.push(`<div class="debug-row"><span class="debug-k">${escapeHTML(k)}</span><span class="debug-v ${cls || ''}">${escapeHTML(String(v))}</span></div>`);

  // App
  row('App version', APP_VERSION, 'ok');
  row('UA', (navigator.userAgent || '').split(') ')[0].slice(0, 72));
  row('Viewport', `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}x`);
  row('Telegram WebApp', !!(window.Telegram && window.Telegram.WebApp) ? 'yes' : 'no');
  row('Display mode', (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone ? 'standalone' : 'browser');

  // Permissions
  const pm = Diag._perms.microphone, pa = Diag._perms.accelerometer;
  row('Mic permission', pm, pm === 'granted' ? 'ok' : pm === 'denied' ? 'err' : 'warn');
  row('Motion permission', pa, pa === 'granted' ? 'ok' : pa === 'denied' ? 'err' : 'warn');

  // Audio
  if (state.audioCtx) {
    row('AudioContext', state.audioCtx.state, state.audioCtx.state === 'running' ? 'ok' : 'err');
    row('Sample rate', state.audioCtx.sampleRate + ' Hz', 'ok');
  } else row('AudioContext', 'not created', 'muted');
  row('Master gain', audio.masterGain ? audio.masterGain.gain.value.toFixed(2) : '—', 'muted');

  // Mic
  row('Mic stream', state.micEnabled ? (state.micStream && state.micStream.active ? 'active' : 'ended') : 'off',
    state.micEnabled ? 'ok' : 'muted');
  if (state.micStream) {
    const tracks = state.micStream.getTracks();
    row('Mic tracks', tracks.length + ' (' + tracks.map(t => t.readyState).join(',') + ')',
      tracks.some(t => t.readyState === 'live') ? 'ok' : 'muted');
  }
  row('Current dB', isFinite(state.currentLevel) && state.currentLevel > 0 ? levelToDb(state.currentLevel).toFixed(1) + ' dB' : '—', 'muted');
  row('Session avg dB', state.dbSamples > 0 ? (state.dbSum / state.dbSamples).toFixed(1) + ' dB (' + state.dbSamples + ' samples)' : '—', 'muted');
  row('Session peak dB', isFinite(state.dbPeak) ? state.dbPeak.toFixed(1) + ' dB' : '—', 'muted');

  // Motion
  row('Motion current', state.currentMotion.toFixed(3) + ' (thresh ' + CONFIG.MOTION_THRESHOLD + ')',
    state.currentMotion > CONFIG.MOTION_THRESHOLD ? 'err' : 'ok');

  // Wake Lock
  row('Wake Lock API', 'wakeLock' in navigator ? 'supported' : 'unsupported',
    'wakeLock' in navigator ? 'ok' : 'muted');
  row('Wake lock held', state.wakeLock ? 'yes' : 'no', state.wakeLock ? 'ok' : 'muted');
  if (state.lastWakeLockError) row('Last wake lock err', state.lastWakeLockError, 'err');

  // Service Worker
  row('SW registered', Diag._sw.registered ? 'yes' : 'no', Diag._sw.registered ? 'ok' : 'warn');
  row('SW controlling', Diag._sw.controller ? 'yes' : 'no', Diag._sw.controller ? 'ok' : 'warn');
  row('Caches', Diag._sw.cacheNames.join(', ') || '(none)', Diag._sw.cacheNames.length ? 'ok' : 'muted');
  if (Diag._sw.cacheCount != null) row('Cached entries', String(Diag._sw.cacheCount), Diag._sw.cacheCount > 0 ? 'ok' : 'muted');
  if (state.swError) row('SW error', state.swError, 'err');

  // Storage
  if (state.dbOpenError) row('IDB error', state.dbOpenError, 'err');

  // Session
  row('Running', state.running ? 'yes' : 'no', state.running ? 'ok' : 'muted');
  row('Paused', state.paused ? 'yes (' + (state.pauseReason || '') + ')' : 'no', state.paused ? 'warn' : 'muted');
  row('Elapsed', Math.round(state.elapsed) + 's', 'muted');
  row('Interruptions', String(state.interruptionCount), state.interruptionCount > 0 ? 'warn' : 'muted');
  row('Night mode', state.night ? 'on' : 'off', 'muted');

  dom.diagGrid.innerHTML = rows.join('');
}

/* ============================================================ */
/* 22. Wire — event handlers                                    */
/* ============================================================ */
function wire() {
  dom.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (!btn || state.running) return;
    selectMode(btn.dataset.mode);
    haptics.tap();
  });

  const startHandler = async () => { if (state.running) return; await startSession(); };
  dom.dialBtn.addEventListener('click', startHandler);
  dom.startBtn.addEventListener('click', startHandler);

  dom.stopBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); completeSession(false, 'manual'); });
  dom.stopBtn.addEventListener('click', () => { if (state.running) completeSession(false, 'manual'); });

  dom.logBtn.addEventListener('click', async () => {
    dom.logOverlay.hidden = false;
    applySettingsUI();
    await renderLog();
    // v1.3: ensure Diagnostics panel is in the DOM
    Diag.ensurePanel();
    startMumblesDebugPolling();
    renderCrashLog();
    renderModelStatus();
    renderDiagnostics();
  });
  dom.logClose.addEventListener('click', () => {
    dom.logOverlay.hidden = true;
    stopMumblesDebugPolling();
  });

  if (dom.crashLogCopy) {
    dom.crashLogCopy.addEventListener('click', () => {
      const list = crashLog.read();
      const text = list.length === 0 ? 'No crashes recorded.'
        : list.map(e => {
          const d = new Date(e.ts).toISOString();
          const meta = [e.mode, e.running ? `running ${e.elapsed}s` : null, e.vnEnabled ? 'ideas on' : null, e.source]
            .filter(Boolean).join(' · ');
          return `[${d}] ${e.kind}: ${e.message}\n  ${meta}${e.stack ? '\n' + e.stack : ''}`;
        }).join('\n\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          const orig = dom.crashLogCopy.textContent;
          dom.crashLogCopy.textContent = 'Copied';
          dom.crashLogCopy.classList.add('copied');
          setTimeout(() => { dom.crashLogCopy.textContent = orig; dom.crashLogCopy.classList.remove('copied'); }, 1200);
        }).catch(() => {});
      }
      haptics.tap();
    });
  }
  if (dom.crashLogClear) {
    dom.crashLogClear.addEventListener('click', () => { crashLog.clear(); renderCrashLog(); haptics.tap(); });
  }

  if (dom.modelDlBtn) dom.modelDlBtn.addEventListener('click', () => {
    if (whisper.ready || modelEverCached()) return;
    if (!dom.modelDlConfirmOverlay) return;
    dom.modelDlConfirmOverlay.hidden = false;
    haptics.tap();
  });
  if (dom.modelDlConfirmYes) dom.modelDlConfirmYes.addEventListener('click', () => {
    if (dom.modelDlConfirmOverlay) dom.modelDlConfirmOverlay.hidden = true;
    haptics.tap(); triggerModelDownload();
  });
  if (dom.modelDlConfirmNo) dom.modelDlConfirmNo.addEventListener('click', () => {
    if (dom.modelDlConfirmOverlay) dom.modelDlConfirmOverlay.hidden = true;
    haptics.tap();
  });

  dom.ratingStars.addEventListener('click', (e) => {
    const btn = e.target.closest('.rating-star');
    if (!btn) return;
    if (dom.ratingStars.classList.contains('submitted')) return;
    const n = parseInt(btn.dataset.value, 10);
    if (!n || n < 1 || n > 5) return;
    submitRating(n);
  });
  dom.ratingStars.addEventListener('mouseover', (e) => {
    if (dom.ratingStars.classList.contains('submitted')) return;
    const btn = e.target.closest('.rating-star'); if (!btn) return;
    const n = parseInt(btn.dataset.value, 10);
    dom.ratingStars.querySelectorAll('.rating-star').forEach((s, i) => s.classList.toggle('lit', i < n));
  });
  dom.ratingStars.addEventListener('mouseleave', () => {
    if (dom.ratingStars.classList.contains('submitted')) return;
    dom.ratingStars.querySelectorAll('.rating-star').forEach(s => s.classList.remove('lit'));
  });
  dom.ratingSkip.addEventListener('click', () => { dom.summaryOverlay.hidden = true; });

  window.addEventListener('pointerdown', (e) => {
    if (!state.running) return;
    if (e.target.closest('#stopBtn')) return;
    if (state.night) { exitNight(); return; }
    if (state.paused) { if (e.target.closest('#dial')) exitPause(); return; }
    enterPause('tap');
  }, { passive: true });

  dom.night.addEventListener('pointerdown', () => { if (state.night) exitNight(); });
  dom.night.addEventListener('click', () => { if (state.night) exitNight(); });
  dom.night.addEventListener('mousedown', () => { if (state.night) exitNight(); });
  window.addEventListener('keydown', () => { if (state.night) exitNight(); });

  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      if (state.running && !state.wakeLock) await requestWakeLock();
    }
    if (document.hidden && state.night) exitNight();
  });
  window.addEventListener('pagehide', () => { if (state.running) commitSessionOnUnload(); });

  if (dom.soundPackChips) dom.soundPackChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.settings-chip'); if (!chip) return;
    const p = chip.dataset.pack; if (!p) return;
    settings.set('soundPack', p); applySettingsUI(); haptics.tap();
    if (p !== 'off') audio.playZoomIn();
  });
  if (dom.hapticsToggle) dom.hapticsToggle.addEventListener('click', () => {
    const next = settings.get('haptics') === 'on' ? 'off' : 'on';
    settings.set('haptics', next); applySettingsUI();
    if (next === 'on') haptics.tap();
  });
  if (dom.voiceNotesChips) dom.voiceNotesChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.settings-chip'); if (!chip) return;
    const m = chip.dataset.vn; if (!VOICE_NOTES_MODES.includes(m)) return;
    settings.set('voiceNotes', m); applySettingsUI(); haptics.tap();
  });
  if (dom.voiceNotesLangChips) dom.voiceNotesLangChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.settings-chip'); if (!chip) return;
    const l = chip.dataset.vnLang; if (!VOICE_NOTES_LANGS.includes(l)) return;
    settings.set('voiceNotesLang', l); applySettingsUI(); haptics.tap();
  });

  if (dom.logList) dom.logList.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-vn-toggle]');
    const copy = e.target.closest('[data-vn-copy]');
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
        setTimeout(() => { copy.classList.remove('copied'); copy.textContent = original; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopied).catch(() => {
          try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta); showCopied();
          } catch (_) {}
        });
      }
      haptics.tap();
    }
  });
}

/* ============================================================ */
/* 23. Boot                                                     */
/* ============================================================ */
async function boot() {
  populateStaticIcons();
  const vEl = document.getElementById('appVersion');
  if (vEl) vEl.textContent = APP_VERSION;
  // v1.3: derive ring circumference from the actual SVG circle.
  try {
    const c = document.querySelector('#ringProgress');
    if (c) {
      const r = parseFloat(c.getAttribute('r'));
      if (isFinite(r) && r > 0) CONFIG.RING_CIRCUMFERENCE = 2 * Math.PI * r;
    }
  } catch (_) {}

  wire();
  applySettingsUI();
  selectMode('unwind');
  stars.init();

  if (needsPermissionFlow()) await showPermissionOverlay();

  if ('serviceWorker' in navigator) {
    try {
      state.swRegistration = await navigator.serviceWorker.register('./sw.js');
    } catch (e) { state.swError = (e && e.message) || String(e); }
  }

  // Expose inspection hook.
  window.SilenceDiag = {
    snapshot: () => Diag.snapshot(),
    runSelfTest: () => Diag.runSelfTest(),
    state, CONFIG, APP_VERSION,
  };
}
document.addEventListener('DOMContentLoaded', boot);
