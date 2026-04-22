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

  NIGHT_THRESHOLD_MS:     30000,
  NIGHT_EXIT_FADE_MS:     1200,

  LOG_DAYS:               10,

  // dB conversion tuning — we shift dBFS up by this offset so the
  // number reads in a familiar range (ambient room ~35–45, speech ~55–65).
  // It's a relative scale, NOT an absolute SPL reading.
  DB_OFFSET:              90,
  DB_FLOOR:               -60,     // below this dBFS we clamp
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
  summaryClose:      $('summaryClose'),

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
    const reverb = this.makeReverb();
    const notes = [
      [1760, 0.00], [2217, 0.08], [2637, 0.16], [3136, 0.28],
      [3520, 0.42], [2637, 0.58], [1760, 0.72],
    ];
    notes.forEach(([freq, delay]) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const det = this.ctx.createOscillator();
      const detGain = this.ctx.createGain();
      det.type = 'sine';
      det.frequency.value = freq * 2.0009;
      detGain.gain.value = 0.0;
      det.connect(detGain);
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(0.18, now + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.4);
      detGain.gain.setValueAtTime(0, now + delay);
      detGain.gain.linearRampToValueAtTime(0.04, now + delay + 0.04);
      detGain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.9);
      osc.connect(gain);
      gain.connect(this.masterGain);
      gain.connect(reverb.input);
      detGain.connect(this.masterGain);
      osc.start(now + delay);
      osc.stop(now + delay + 1.5);
      det.start(now + delay);
      det.stop(now + delay + 1.0);
    });
  },

  async playPause() {
    await this.init();
    await this.resume();
    const now = this.ctx.currentTime;
    const freqs = [220, 277];
    freqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12 - i * 0.03, now + 0.5);
      gain.gain.linearRampToValueAtTime(0.12 - i * 0.03, now + 1.0);
      gain.gain.linearRampToValueAtTime(0, now + 1.8);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600;
      filter.Q.value = 0.5;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 2.0);
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
      tx.objectStore('sessions').add(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
  const buf = new Uint8Array(state.analyser.frequencyBinCount);
  state.analyser.getByteFrequencyData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length / 255;
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
  audio.playPause();

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

  // Mic — always sample when running, for dB recording. Never pauses.
  if (state.micEnabled) {
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
  };

  try { await db.add(session); } catch (e) { console.warn('[silence] save failed:', e); }

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
    interruptionCount: state.interruptionCount + 1, // close counts as one more
    pausedTotalSeconds: Math.round(state.pausedTotalMs / 1000),
    avgDb: avgDb,
    peakDb: peakDb,
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

  dom.summaryOverlay.hidden = false;
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

  days.forEach((d) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.dataset.ts = d.ts;
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
    html += `
      <div class="log-entry">
        <div class="log-mode-icon">${modeIconSVG(s.mode)}</div>
        <div class="log-meta">
          <span class="log-mode-name">${dot}${s.mode}</span>
          <span class="log-time">${timeOfDay(s.startedAt)}</span>
        </div>
        <div class="log-duration ${isPartial ? 'partial' : ''}">
          <span>${fmtDuration(s.silentSeconds)}</span>
          ${dbLabel}
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

  // Stop
  dom.stopBtn.addEventListener('click', () => completeSession(false, 'manual'));

  // Log open/close
  dom.logBtn.addEventListener('click', async () => {
    dom.logOverlay.hidden = false;
    await renderLog();
  });
  dom.logClose.addEventListener('click', () => { dom.logOverlay.hidden = true; });

  // Summary close
  dom.summaryClose.addEventListener('click', () => { dom.summaryOverlay.hidden = true; });

  // Tap interactions — v0.5:
  //   Running + not paused: any tap pauses (except STOP button)
  //   Running + paused: tap on dial resumes; other taps do nothing
  //   Night active: first tap exits night (without pausing or resuming)
  window.addEventListener('pointerdown', (e) => {
    if (!state.running) return;
    // STOP button always reaches its own handler
    if (e.target.closest('#stopBtn')) return;

    // Night mode: first tap exits night
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
