/* ============================================================
   Silence · v0.4 app.js
   ------------------------------------------------------------
   What changed since v0.3:
   - Noise no longer pauses the session. It's recorded (avg + peak dB).
   - Motion pauses. Taps pause. Tab-backgrounded pauses.
   - 3-minute pause timeout -> auto-end.
   - Page close (visibilitychange 'hidden' + pagehide) -> save session.
   - Session summary modal replaces the thin toast: duration,
     interrupted y/n, avg dB, peak dB.
   - Log entries show dB tag and interrupted indicator.
   ============================================================ */

'use strict';

// ============================================================
// Config
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
};

// ============================================================
// State
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
  pausedTotalMs: 0,          // cumulative paused duration (not used for summary yet, available)
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
};

// ============================================================
// DOM
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

  toast:          $('toast'),
  toastTitle:     $('toastTitle'),
  toastSub:       $('toastSub'),
};

// ============================================================
// Utilities
// ============================================================
function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '∞';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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

// ============================================================
// Audio synthesis (unchanged from v0.3)
// ============================================================
const audio = {
  ctx: null,
  masterGain: null,

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.22;
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

  async playStart() {
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

  // Rating sounds — distinct emotional register per star count.
  // 1 = dull low thud, 5 = bright crystalline glass.
  async playRating(n) {
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
  // A descending pitch glide with a filter closing down. Feels like
  // the UI retreating: sound pulls back with it.
  async playZoomOut() {
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

  // Zoom-in — played when a paused session resumes.
  // Mirror of zoom-out: pitch rising, filter opening up, volume
  // arriving rather than leaving. Feels like the UI returning.
  async playZoomIn() {
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

  async playFinish() {
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
};

// ============================================================
// Starfield (unchanged)
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
// IndexedDB
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
// Sensing: mic
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
// Sensing: motion
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
// Wake lock
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
// Permissions
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
// Mode selection
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
// Steady Night
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
// Pause state machine — NEW in v0.4
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
}

// ============================================================
// Timer + sensing loop
// ============================================================
function updateRing() {
  const C = 540.354;
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
  }  // Motion — pauses if threshold sustained past grace
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
// Session lifecycle
// ============================================================
async function startSession() {
  if (state.running) return;

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

  // Fire-and-forget save (browser may kill us before it completes; that's fine)
  try {
    db.add(session);
  } catch (_) {}

  state.running = false;
}

// ============================================================
// Summary modal
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

  // Play the rating sound
  audio.playRating(n);

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
// Toast (for lightweight messages)
// ============================================================
let toastTimer = null;
function showToast(title, sub) {
  dom.toastTitle.textContent = title;
  dom.toastSub.textContent = sub;
  dom.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3500);
}

// ============================================================
// Log rendering
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

  // Small filled-star SVG for mini displays (chart + log entries)
  const miniStarSVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M12 2.5l2.9 6.6 7.1 0.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.8 7.1-0.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

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
      st.innerHTML = miniStarSVG;
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
        ratingHTML += `<span class="log-entry-rating-star${i <= s.rating ? ' lit' : ''}">${miniStarSVG}</span>`;
      }
      ratingHTML += '</div>';
    }

    // Two-column layout: left = what + when + how loud, right = how long + how good
    html += `
      <div class="log-entry">
        <div class="log-mode-icon">${modeIconSVG(s.mode)}</div>
        <div class="log-meta">
          <span class="log-mode-name">${dot}${s.mode}</span>
          <span class="log-time">${timeOfDay(s.startedAt)}</span>
          ${dbLabel}
        </div>
        <div class="log-duration ${isPartial ? 'partial' : ''}">
          <span>${fmtDuration(s.silentSeconds)}</span>
          ${ratingHTML}
        </div>
      </div>`;
  });
  dom.logList.innerHTML = html;
}

// ============================================================
// Wire up
// ============================================================
function wire() {
  // Modes — only selectable when not running
  dom.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (!btn || state.running) return;
    selectMode(btn.dataset.mode);
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
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  wire();
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
