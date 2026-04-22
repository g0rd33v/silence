/* ============================================================
   Silence · app.js
   Core logic: sensing engine (mic + motion + touch), timer,
   history store (IndexedDB), UI state machine.

   Design principle: the timer only ticks when the world is
   actually silent. Anything else pauses it.
   ============================================================ */

'use strict';

// ============================================================
// Config
// ============================================================
const CONFIG = {
  // dB threshold below which we consider the room "silent"
  // Values are normalized 0..1 from getByteFrequencyData average
  SILENCE_THRESHOLD: 0.08,      // roughly ~room-quiet

  // Motion threshold — movement magnitude above which we pause
  // Based on devicemotion accelerationIncludingGravity delta
  MOTION_THRESHOLD: 0.6,

  // Grace period before pause triggers (ms)
  // Prevents a single sneeze or bump from ending the session
  NOISE_GRACE_MS: 1500,
  MOTION_GRACE_MS: 800,

  // History: keep full data on device, show only 7 days in free tier
  FREE_TIER_DAYS: 7,

  // Tick rate
  TICK_MS: 100,
};

// ============================================================
// State
// ============================================================
const state = {
  mode: 'unwind',       // before | after | unwind | sleep | infinity
  duration: 20 * 60,    // seconds (0 = infinity)

  running: false,
  paused: false,
  startedAt: null,      // ms epoch
  elapsed: 0,           // seconds of *silence* accumulated
  lastTickAt: null,

  // Sensing
  micEnabled: false,
  motionEnabled: false,
  audioCtx: null,
  analyser: null,
  micStream: null,
  currentLevel: 0,      // 0..1
  currentMotion: 0,
  noiseSince: null,
  motionSince: null,

  wakeLock: null,
  tickInterval: null,
  sensingFrame: null,
};

// ============================================================
// DOM
// ============================================================
const $ = (id) => document.getElementById(id);

const dom = {
  app:            $('app'),
  modes:          $('modes'),
  dial:           $('dial'),
  dialBtn:        $('dialBtn'),
  dialLabel:      $('dialLabel'),
  dialTime:       $('dialTime'),
  dialHint:       $('dialHint'),
  ringProgress:   $('ringProgress'),
  stopBtn:        $('stopBtn'),
  status:         $('status'),
  statusDot:      $('statusDot'),
  statusText:     $('statusText'),
  tagline:        $('tagline'),

  permOverlay:    $('permOverlay'),
  permGrant:      $('permGrant'),
  permSkip:       $('permSkip'),

  historyBtn:     $('historyBtn'),
  historyOverlay: $('historyOverlay'),
  historyClose:   $('historyClose'),
  chart:          $('chart'),
  totalWeek:      $('totalWeek'),
  totalSessions: $('totalSessions'),
  longestSession: $('longestSession'),

  toast:          $('toast'),
  toastTitle:     $('toastTitle'),
  toastSub:       $('toastSub'),

  stars:          $('stars'),
};

// ============================================================
// Utilities
// ============================================================
function fmtTime(seconds) {
  if (seconds === Infinity || seconds < 0) return '∞';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtMinutes(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h ${rem}m`;
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
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[d.getDay()];
}

// ============================================================
// Starfield — generate stars once
// ============================================================
function makeStars() {
  const n = 60;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    const big = Math.random() > 0.9;
    const tiny = Math.random() > 0.85;
    s.className = 'star' + (big ? ' big' : tiny ? ' tiny' : '');
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 70 + '%';
    s.style.animationDelay = (Math.random() * 4) + 's';
    s.style.setProperty('--base', (0.3 + Math.random() * 0.7).toFixed(2));
    frag.appendChild(s);
  }
  dom.stars.appendChild(frag);
}

// ============================================================
// History store (IndexedDB)
// ============================================================
const db = {
  _db: null,

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('silence', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
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
// Sensing: microphone
// ============================================================
async function startMic() {
  if (state.micEnabled) return true;
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
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
    console.warn('[silence] microphone denied or unavailable:', e);
    state.micEnabled = false;
    return false;
  }
}

function readMicLevel() {
  if (!state.analyser) return 0;
  const buf = new Uint8Array(state.analyser.frequencyBinCount);
  state.analyser.getByteFrequencyData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const avg = sum / buf.length / 255; // 0..1
  return avg;
}

function stopMic() {
  if (state.micStream) {
    state.micStream.getTracks().forEach(t => t.stop());
    state.micStream = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  state.analyser = null;
  state.micEnabled = false;
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
  // Smooth out the reading
  state.currentMotion = state.currentMotion * 0.7 + delta * 0.3;
  lastAccel = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
}

async function startMotion() {
  if (state.motionEnabled) return true;
  try {
    // iOS 13+ requires explicit permission request
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') { state.motionEnabled = false; return false; }
    }
    window.addEventListener('devicemotion', motionHandler);
    state.motionEnabled = true;
    return true;
  } catch (e) {
    console.warn('[silence] motion unavailable:', e);
    state.motionEnabled = false;
    return false;
  }
}

function stopMotion() {
  window.removeEventListener('devicemotion', motionHandler);
  state.motionEnabled = false;
}

// ============================================================
// Wake lock (keep screen on during session)
// ============================================================
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (e) {
    console.warn('[silence] wake lock failed:', e);
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

// ============================================================
// Permissions flow
// ============================================================
function needsPermissionFlow() {
  // Show on first run only
  return localStorage.getItem('silence.permSeen') !== '1';
}

function markPermissionSeen() {
  localStorage.setItem('silence.permSeen', '1');
}

async function showPermissionOverlay() {
  dom.permOverlay.hidden = false;

  dom.permGrant.onclick = async () => {
    dom.permGrant.disabled = true;
    dom.permGrant.textContent = 'Requesting…';
    const [mic, motion] = await Promise.all([startMic(), startMotion()]);
    markPermissionSeen();
    dom.permOverlay.hidden = true;
    dom.permGrant.disabled = false;
    dom.permGrant.textContent = 'Grant access';
    if (!mic && !motion) {
      showToast('Sensing unavailable', 'Sessions will run as simple timers.');
    }
  };

  dom.permSkip.onclick = () => {
    markPermissionSeen();
    dom.permOverlay.hidden = true;
  };
}

// ============================================================
// Mode selection
// ============================================================
function selectMode(mode) {
  state.mode = mode;

  const btns = dom.modes.querySelectorAll('.mode');
  btns.forEach(b => {
    const pressed = b.dataset.mode === mode;
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  });

  const minutes = parseInt(
    dom.modes.querySelector(`.mode[data-mode="${mode}"]`).dataset.minutes,
    10
  );

  state.duration = minutes * 60;

  if (!state.running) {
    dom.dialTime.textContent = minutes === 0 ? '∞' : `${String(minutes).padStart(2, '0')}:00`;
  }
}

// ============================================================
// Timer + sensing loop
// ============================================================
function updateRing() {
  const C = 578.053;
  let progress = 0;
  if (state.duration > 0) {
    progress = Math.min(state.elapsed / state.duration, 1);
  } else {
    // Infinity — slowly fill then reset
    progress = (state.elapsed % 600) / 600;
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
  dom.stopBtn.hidden = !running;
  dom.status.hidden = !running;
  dom.status.classList.toggle('paused', paused);

  if (!running) {
    dom.dialLabel.textContent = 'SILENCE';
    dom.dialHint.textContent = 'Tap to start';
  } else if (paused) {
    dom.dialLabel.textContent = 'PAUSED';
    dom.statusText.textContent = pauseReason();
  } else {
    dom.dialLabel.textContent = state.mode.toUpperCase();
    dom.statusText.textContent = 'Listening for silence…';
  }
}

function pauseReason() {
  const reasons = [];
  if (state.noiseSince && Date.now() - state.noiseSince > CONFIG.NOISE_GRACE_MS) reasons.push('noise detected');
  if (state.motionSince && Date.now() - state.motionSince > CONFIG.MOTION_GRACE_MS) reasons.push('motion detected');
  if (!document.hasFocus() || document.hidden) reasons.push('focus lost');
  return reasons.length > 0 ? ('Paused · ' + reasons[0]) : 'Paused';
}

function sensingTick() {
  if (!state.running) return;

  const now = Date.now();

  // Read sensors
  if (state.micEnabled) {
    state.currentLevel = readMicLevel();
  }

  // Check triggers
  const tooLoud = state.micEnabled && state.currentLevel > CONFIG.SILENCE_THRESHOLD;
  const tooMoving = state.motionEnabled && state.currentMotion > CONFIG.MOTION_THRESHOLD;

  // Update "since" timestamps
  if (tooLoud) {
    if (!state.noiseSince) state.noiseSince = now;
  } else {
    state.noiseSince = null;
  }

  if (tooMoving) {
    if (!state.motionSince) state.motionSince = now;
  } else {
    state.motionSince = null;
  }

  // Determine pause state with grace periods
  const noisePause = state.noiseSince && (now - state.noiseSince > CONFIG.NOISE_GRACE_MS);
  const motionPause = state.motionSince && (now - state.motionSince > CONFIG.MOTION_GRACE_MS);

  const shouldPause = noisePause || motionPause;

  if (shouldPause && !state.paused) {
    state.paused = true;
    setRunningUI(true, true);
  } else if (!shouldPause && state.paused) {
    state.paused = false;
    setRunningUI(true, false);
  }

  // Accumulate elapsed only when not paused
  if (!state.paused && state.lastTickAt) {
    const dt = (now - state.lastTickAt) / 1000;
    state.elapsed += dt;
  }
  state.lastTickAt = now;

  updateDialTime();
  updateRing();

  // Check completion
  if (state.duration > 0 && state.elapsed >= state.duration) {
    completeSession(true);
  }

  state.sensingFrame = requestAnimationFrame(sensingTick);
}

// ============================================================
// Session lifecycle
// ============================================================
async function startSession() {
  if (state.running) return;

  // Ensure sensing is active (if permitted)
  if (!state.micEnabled) await startMic();
  if (!state.motionEnabled) await startMotion();

  await requestWakeLock();

  state.running = true;
  state.paused = false;
  state.startedAt = Date.now();
  state.elapsed = 0;
  state.lastTickAt = Date.now();
  state.noiseSince = null;
  state.motionSince = null;

  setRunningUI(true);
  state.sensingFrame = requestAnimationFrame(sensingTick);
}

async function completeSession(naturalFinish = false) {
  if (!state.running) return;

  if (state.sensingFrame) cancelAnimationFrame(state.sensingFrame);
  state.sensingFrame = null;

  const session = {
    startedAt: state.startedAt,
    endedAt: Date.now(),
    mode: state.mode,
    targetSeconds: state.duration,
    silentSeconds: Math.floor(state.elapsed),
    completed: naturalFinish,
  };

  try { await db.add(session); } catch (e) { console.warn('[silence] history save failed:', e); }

  state.running = false;
  state.paused = false;
  setRunningUI(false);
  selectMode(state.mode); // reset display to target

  releaseWakeLock();

  // Show toast
  const mins = Math.floor(session.silentSeconds / 60);
  const secs = session.silentSeconds % 60;
  const phrasing = mins > 0
    ? `${mins} minute${mins === 1 ? '' : 's'}${secs > 0 ? ` ${secs}s` : ''} of real silence`
    : `${secs} seconds of silence`;
  showToast(naturalFinish ? 'Session complete' : 'Session saved', phrasing);
}

// ============================================================
// Toast
// ============================================================
let toastTimer = null;
function showToast(title, sub) {
  dom.toastTitle.textContent = title;
  dom.toastSub.textContent = sub;
  dom.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3800);
}

// ============================================================
// History view
// ============================================================
async function renderHistory() {
  const since = daysAgo(6);
  const sessions = await db.getSince(since);

  // Totals
  let totalSeconds = 0, longest = 0;
  sessions.forEach(s => {
    totalSeconds += s.silentSeconds;
    if (s.silentSeconds > longest) longest = s.silentSeconds;
  });

  dom.totalWeek.textContent = fmtMinutes(totalSeconds);
  dom.totalSessions.textContent = String(sessions.length);
  dom.longestSession.textContent = fmtMinutes(longest);

  // Chart — 7 days, today on right
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = daysAgo(i);
    const dayEnd = dayStart + 86400000;
    const daySessions = sessions.filter(s => s.startedAt >= dayStart && s.startedAt < dayEnd);
    days.push({ ts: dayStart, sessions: daySessions });
  }

  // Find max for scaling
  const dayTotals = days.map(d => d.sessions.reduce((sum, s) => sum + s.silentSeconds, 0));
  const maxTotal = Math.max(...dayTotals, 60); // minimum 1 min for scale

  // Render bars
  dom.chart.innerHTML = '';
  const todayStart = startOfDay();

  days.forEach((d) => {
    const col = document.createElement('div');
    col.className = 'bar-col';

    const bar = document.createElement('div');
    bar.className = 'bar';

    // Stack sessions bottom-up
    d.sessions.forEach(s => {
      const seg = document.createElement('div');
      seg.className = `bar-seg ${s.mode}`;
      const h = (s.silentSeconds / maxTotal) * 100;
      seg.style.height = h + '%';
      bar.appendChild(seg);
    });

    const label = document.createElement('div');
    label.className = 'bar-day' + (d.ts === todayStart ? ' today' : '');
    label.textContent = dayLabel(d.ts);

    col.appendChild(bar);
    col.appendChild(label);
    dom.chart.appendChild(col);
  });
}

// ============================================================
// Wire up
// ============================================================
function wire() {
  // Mode buttons
  dom.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (!btn) return;
    if (state.running) return; // don't switch modes mid-session
    selectMode(btn.dataset.mode);
  });

  // Dial — start
  dom.dialBtn.addEventListener('click', () => {
    if (state.running) return;
    startSession();
  });

  // Stop button
  dom.stopBtn.addEventListener('click', () => {
    completeSession(false);
  });

  // History
  dom.historyBtn.addEventListener('click', async () => {
    dom.historyOverlay.hidden = false;
    await renderHistory();
  });
  dom.historyClose.addEventListener('click', () => {
    dom.historyOverlay.hidden = true;
  });

  // Re-acquire wake lock on tab visibility return
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && state.running && !state.wakeLock) {
      await requestWakeLock();
    }
  });

  // Touch/interaction during session — pause signal
  // (Tapping anywhere on the screen during a session briefly interrupts it)
  // We let dialBtn through so user can interact post-finish; Stop handled separately.
  // Simplicity v0.1: we don't aggressively pause on touch. Stop is explicit.
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  makeStars();
  wire();
  selectMode('unwind'); // default from the mockup

  if (needsPermissionFlow()) {
    await showPermissionOverlay();
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
