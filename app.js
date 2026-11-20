'use strict';

/* =========================================================
 * マイコンカー ラップタイマー
 *  - カメラ映像上の計測ラインの輝度変化で通過を検知
 *  - 1回目の通過で計測開始、以降は通過ごとにラップ記録
 *  - 検知後は一定時間（クールダウン）再検知しない
 * ========================================================= */

const $ = (s) => document.querySelector(s);

const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const videoWrap = $('#videoWrap');
const placeholder = $('#placeholder');
const flashEl = $('#flash');
const meterBar = $('#meterBar');
const meterThreshold = $('#meterThreshold');
const statusEl = $('#status');
const currentEl = $('#current');
const lapCountEl = $('#lapCount');
const bestEl = $('#best');
const totalEl = $('#total');
const lapList = $('#lapList');
const emptyMsg = $('#emptyMsg');
const btnCamera = $('#btnCamera');
const btnArm = $('#btnArm');
const btnReset = $('#btnReset');

// 解析用の縮小キャンバス（処理を軽くするため）
const PROC_W = 320;
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

/* ---------------- 設定 ---------------- */
const DEFAULTS = {
  sensitivity: 12,   // ライン上の画素のうち何%が変化したら通過とみなすか
  threshold: 28,     // 背景との輝度差がこれ以上なら「変化した画素」
  cooldown: 1,       // 検知後に再検知しない秒数
  thickness: 3,      // ラインの太さ（解析画素）
  sound: true,
  vibrate: true,
  lockLine: false,
  facing: 'environment',
  // 0〜1 の正規化座標。車は画面の横方向から来ることが多いので縦線を初期値にする
  line: { x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8 },
  version: 2,
};

const settings = loadJSON('laptimer.settings', DEFAULTS);
settings.line = Object.assign({}, DEFAULTS.line, settings.line);

// 旧バージョンの初期値（横線・3秒）のまま保存されていたら新しい初期値に置き換える
let stored = null;
try { stored = JSON.parse(localStorage.getItem('laptimer.settings')); } catch (_) { /* ignore */ }
if (stored && !(stored.version >= 2)) {
  const l = settings.line;
  if (l.x1 === 0.2 && l.y1 === 0.5 && l.x2 === 0.8 && l.y2 === 0.5) settings.line = { ...DEFAULTS.line };
  if (settings.cooldown === 3) settings.cooldown = DEFAULTS.cooldown;
  settings.version = 2;
  try { localStorage.setItem('laptimer.settings', JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v && typeof v === 'object') return Object.assign(structuredClone(fallback), v);
  } catch (_) { /* ignore */ }
  return structuredClone(fallback);
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
}
const saveSettings = () => saveJSON('laptimer.settings', settings);

/* ---------------- 状態 ---------------- */
// phase: 'idle'(待機していない) | 'armed'(最初の通過待ち) | 'timing'(計測中)
const state = {
  stream: null,
  phase: 'idle',
  startTime: 0,     // 計測開始時刻 (performance.now 基準, ms)
  lapStart: 0,      // 現在のラップ開始時刻
  lastTrigger: -Infinity,
  needClear: false, // 検知後、ラインが空くまで次を受け付けない
  laps: loadJSON('laptimer.laps', { list: [] }).list, // ms の配列
  bg: null,         // ライン上の背景輝度
  bgMean: 0,        // 背景時の画面全体の平均輝度
  samples: null,    // ライン上のサンプル画素インデックス
  sampleKey: '',
  ratio: 0,
  frameLoopId: 0,
  audio: null,
  wakeLock: null,
};

/* ---------------- 時間表示 ---------------- */
function fmt(ms) {
  if (!isFinite(ms) || ms < 0) return '--';
  const cs = Math.round(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
function fmtDiff(ms) {
  const sign = ms >= 0 ? '+' : '-';
  return sign + (Math.abs(ms) / 1000).toFixed(2);
}

/* ---------------- カメラ ---------------- */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('このブラウザではカメラが使えません。HTTPS（GitHub Pages など）で開いてください。');
    return;
  }
  stopCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: settings.facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
    });
    // 60fps を強めに要求（非対応の端末ではそのまま）
    const track = stream.getVideoTracks()[0];
    try {
      if ((track.getSettings().frameRate || 0) < 59) {
        await track.applyConstraints({ frameRate: { exact: 60 } });
      }
    } catch (_) { /* 60fps 非対応 */ }
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    placeholder.classList.add('hidden');
    btnCamera.textContent = 'カメラ停止';
    btnArm.disabled = false;
    state.bg = null;
    layoutVideo();
    startFrameLoop();
    requestWakeLock();
    updateStatus();
  } catch (err) {
    console.error(err);
    alert('カメラを起動できませんでした: ' + err.message);
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  placeholder.classList.remove('hidden');
  btnCamera.textContent = 'カメラ起動';
  btnArm.disabled = true;
  if (state.phase !== 'idle') setPhase('idle');
  releaseWakeLock();
  updateStatus();
}

const landscapeMQ = window.matchMedia('(orientation: landscape) and (min-width: 640px)');
if (landscapeMQ.addEventListener) landscapeMQ.addEventListener('change', () => requestAnimationFrame(layoutVideo));

// 映像の縦横比に合わせて表示領域を決める（座標変換を単純にするため）
function layoutVideo() {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const aspect = vw / vh;
  const maxW = videoWrap.parentElement.clientWidth;
  // 横画面ではカメラを大きく（ボタン分だけ残す）、縦画面では画面の約4割
  const maxH = landscapeMQ.matches
    ? Math.max(160, window.innerHeight - (window.innerHeight <= 500 ? 100 : 130))
    : Math.max(200, window.innerHeight * 0.42);
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) { h = maxH; w = h * aspect; }
  videoWrap.style.width = `${Math.round(w)}px`;
  videoWrap.style.height = `${Math.round(h)}px`;
  meterBar.parentElement.style.width = `${Math.round(w)}px`;

  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);

  proc.width = PROC_W;
  proc.height = Math.max(1, Math.round(PROC_W / aspect));
  state.sampleKey = '';
  drawOverlay();
}

video.addEventListener('loadedmetadata', layoutVideo);
video.addEventListener('resize', layoutVideo);
window.addEventListener('resize', layoutVideo);
window.addEventListener('orientationchange', () => setTimeout(layoutVideo, 300));

/* ---------------- 画面スリープ防止 ---------------- */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (_) { /* ignore */ }
}
function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.stream) requestWakeLock();
});

/* ---------------- ライン上のサンプル点 ---------------- */
function buildSamples() {
  const W = proc.width, H = proc.height;
  const { x1, y1, x2, y2 } = settings.line;
  const key = [W, H, x1, y1, x2, y2, settings.thickness].join(',');
  if (key === state.sampleKey) return;
  state.sampleKey = key;

  const ax = x1 * W, ay = y1 * H, bx = x2 * W, by = y2 * H;
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(len));
  const nx = len ? -(by - ay) / len : 0;
  const ny = len ? (bx - ax) / len : 1;
  const half = Math.floor(settings.thickness / 2);
  const seen = new Set();
  const idx = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = ax + (bx - ax) * t;
    const cy = ay + (by - ay) * t;
    for (let o = -half; o <= half; o++) {
      const px = Math.round(cx + nx * o);
      const py = Math.round(cy + ny * o);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const k = py * W + px;
      if (!seen.has(k)) { seen.add(k); idx.push(k); }
    }
  }
  state.samples = Int32Array.from(idx);
  state.bg = null; // ラインが変わったら背景を取り直す
}

/* ---------------- フレームレート表示 ---------------- */
const fpsEl = $('#fps');
const fpsCounter = { start: 0, frames: 0 };
function countFps(now) {
  if (!fpsCounter.start) fpsCounter.start = now;
  fpsCounter.frames++;
  const el = now - fpsCounter.start;
  if (el >= 1000) {
    const fps = Math.round((fpsCounter.frames * 1000) / el);
    fpsEl.textContent = `${fps} fps`;
    fpsEl.classList.toggle('low', fps < 50);
    fpsCounter.start = now;
    fpsCounter.frames = 0;
  }
}

/* ---------------- フレーム解析ループ ---------------- */
function startFrameLoop() {
  const loopId = ++state.frameLoopId;
  fpsCounter.start = 0;
  fpsCounter.frames = 0;
  fpsEl.textContent = '';
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  const onFrame = (now, meta) => {
    if (loopId !== state.frameLoopId || !state.stream) return;
    // captureTime があればカメラが撮影した時刻を使う（より正確）
    let t = now;
    if (meta && typeof meta.captureTime === 'number' && meta.captureTime > 0
        && Math.abs(meta.captureTime - performance.now()) < 1000) {
      t = meta.captureTime;
    }
    countFps(now);
    processFrame(t);
    schedule();
  };
  const schedule = () => {
    if (useRVFC) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((now) => onFrame(now, null));
  };
  schedule();
}

const lumBuf = { cur: null };

function processFrame(t) {
  if (video.readyState < 2 || !proc.width) return;
  buildSamples();
  const S = state.samples;
  if (!S || S.length < 4) return;

  pctx.drawImage(video, 0, 0, proc.width, proc.height);
  const data = pctx.getImageData(0, 0, proc.width, proc.height).data;

  const n = S.length;
  if (!lumBuf.cur || lumBuf.cur.length !== n) {
    lumBuf.cur = new Float32Array(n);
  }
  const cur = lumBuf.cur;
  for (let i = 0; i < n; i++) {
    const p = S[i] * 4;
    cur[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // 画面全体の平均輝度（自動露出などによる全体的な明るさ変化の補正用）
  let sum = 0, cnt = 0;
  for (let p = 0; p < data.length; p += 4 * 7) {
    sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    cnt++;
  }
  const frameMean = sum / cnt;

  if (!state.bg || state.bg.length !== n) {
    state.bg = Float32Array.from(cur);
    state.bgMean = frameMean;
    return;
  }
  const bg = state.bg;
  const shift = frameMean - state.bgMean;
  state.bgMean += shift * 0.08;

  const thr = settings.threshold;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(cur[i] - bg[i] - shift);
    if (d > thr) {
      changed++;
      bg[i] += (cur[i] - bg[i]) * 0.005; // 物体部分はほぼ更新しない
    } else {
      bg[i] += (cur[i] - bg[i]) * 0.08;  // 背景はゆっくり追従
    }
  }
  const ratio = changed / n;
  state.ratio = ratio;

  const trig = settings.sensitivity / 100;
  if (ratio < trig * 0.5) state.needClear = false;

  if (ratio >= trig && state.phase !== 'idle') {
    const sinceLast = t - state.lastTrigger;
    if (sinceLast >= settings.cooldown * 1000 && !state.needClear) {
      onCross(t);
    }
  }

  updateMeter();
  drawOverlay();
}

/* ---------------- 通過時の処理 ---------------- */
function onCross(t) {
  state.lastTrigger = t;
  state.needClear = true;

  if (state.phase === 'armed') {
    state.startTime = t;
    state.lapStart = t;
    setPhase('timing');
    feedback(true);
  } else if (state.phase === 'timing') {
    const lap = t - state.lapStart;
    state.lapStart = t;
    state.laps.push(lap);
    saveJSON('laptimer.laps', { list: state.laps });
    renderLaps(true);
    feedback(false);
  }
  updateStatus();
}

function feedback(isStart) {
  flashEl.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => flashEl.classList.remove('on')));
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(isStart ? [80, 60, 80] : 120);
  if (settings.sound) beep(isStart ? 1320 : 880, isStart ? 0.25 : 0.15);
}

function ensureAudio() {
  if (!state.audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) state.audio = new AC();
  }
  if (state.audio && state.audio.state === 'suspended') state.audio.resume();
}

function beep(freq, dur) {
  const ac = state.audio;
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.25, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + dur);
}

/* ---------------- 計測状態 ---------------- */
function setPhase(phase) {
  state.phase = phase;
  if (phase === 'armed') {
    state.lastTrigger = -Infinity;
    state.needClear = false;
    state.startTime = 0;
    state.lapStart = 0;
  }
  btnArm.textContent = phase === 'idle' ? '計測待機' : '計測停止';
  btnArm.classList.toggle('primary', phase === 'idle');
  btnArm.classList.toggle('danger', phase !== 'idle');
  updateStatus();
}

function updateStatus() {
  let text, cls = '';
  if (!state.stream) {
    text = 'カメラ停止中';
  } else if (state.phase === 'idle') {
    text = 'ラインを合わせて「計測待機」';
  } else if (state.phase === 'armed') {
    text = 'スタート待ち：ライン通過で計測開始';
    cls = 'armed';
  } else {
    const remain = settings.cooldown * 1000 - (performance.now() - state.lastTrigger);
    if (remain > 0) {
      text = `計測中（再検知まで ${(remain / 1000).toFixed(1)}秒）`;
      cls = 'cooldown';
    } else {
      text = '計測中';
      cls = 'timing';
    }
  }
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

function renderLaps(isNew) {
  const laps = state.laps;
  lapList.innerHTML = '';
  emptyMsg.classList.toggle('hidden', laps.length > 0);
  lapCountEl.textContent = String(laps.length);
  if (!laps.length) {
    bestEl.textContent = '--';
    return;
  }
  const best = Math.min(...laps);
  bestEl.textContent = fmt(best);
  const frag = document.createDocumentFragment();
  for (let i = laps.length - 1; i >= 0; i--) {
    const li = document.createElement('li');
    const isBest = laps[i] === best;
    if (isBest) li.classList.add('best');
    if (isNew && i === laps.length - 1) li.classList.add('new');
    li.innerHTML =
      `<span class="no">LAP ${i + 1}</span>` +
      `<span class="time">${fmt(laps[i])}</span>` +
      `<span class="diff">${isBest ? 'BEST' : fmtDiff(laps[i] - best)}</span>`;
    frag.appendChild(li);
  }
  lapList.appendChild(frag);
}

/* ---------------- タイマー表示ループ ---------------- */
function tick() {
  const now = performance.now();
  if (state.phase === 'timing') {
    currentEl.textContent = fmt(now - state.lapStart);
    totalEl.textContent = fmt(now - state.startTime);
  } else if (state.phase === 'armed') {
    currentEl.textContent = fmt(0);
  }
  if (state.stream) updateStatus();
  requestAnimationFrame(tick);
}

/* ---------------- 検知レベル表示 ---------------- */
function updateMeter() {
  const scale = 100 / Math.max(settings.sensitivity * 2, 20); // しきい値がメーター中央付近に来るよう表示
  const w = Math.min(100, state.ratio * 100 * scale);
  meterBar.style.width = `${w}%`;
  meterBar.classList.toggle('over', state.ratio * 100 >= settings.sensitivity);
  meterThreshold.style.left = `${Math.min(100, settings.sensitivity * scale)}%`;
}

/* ---------------- オーバーレイ（ライン描画・ドラッグ） ---------------- */
const HANDLE_R = 16; // CSS px

function drawOverlay() {
  const W = overlay.width, H = overlay.height;
  const dpr = window.devicePixelRatio || 1;
  octx.clearRect(0, 0, W, H);
  if (!state.stream) return;
  const { x1, y1, x2, y2 } = settings.line;
  const ax = x1 * W, ay = y1 * H, bx = x2 * W, by = y2 * H;

  let color = '#ffd23f';
  if (state.ratio * 100 >= settings.sensitivity) color = '#ff5c5c';
  else if (state.phase === 'timing' && performance.now() - state.lastTrigger < settings.cooldown * 1000) color = '#ff9f43';
  else if (state.phase !== 'idle') color = '#3ddc84';

  octx.lineCap = 'round';
  octx.strokeStyle = 'rgba(0,0,0,.6)';
  octx.lineWidth = 7 * dpr;
  octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(bx, by); octx.stroke();
  octx.strokeStyle = color;
  octx.lineWidth = 3.5 * dpr;
  octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(bx, by); octx.stroke();

  if (!settings.lockLine) {
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      octx.beginPath();
      octx.arc(x, y, HANDLE_R * dpr * 0.7, 0, Math.PI * 2);
      octx.fillStyle = 'rgba(255,255,255,.25)';
      octx.fill();
      octx.lineWidth = 2.5 * dpr;
      octx.strokeStyle = color;
      octx.stroke();
    }
  }
}

let drag = null; // { which: 1|2|'both', startX, startY, line }

function pointerPos(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
}

overlay.addEventListener('pointerdown', (e) => {
  if (!state.stream || settings.lockLine) return;
  const { x, y, r } = pointerPos(e);
  const l = settings.line;
  const d1 = Math.hypot((x - l.x1) * r.width, (y - l.y1) * r.height);
  const d2 = Math.hypot((x - l.x2) * r.width, (y - l.y2) * r.height);
  const hit = HANDLE_R * 2.2;
  let which = null;
  if (d1 < hit || d2 < hit) which = d1 <= d2 ? 1 : 2;
  else if (distToSegment(x * r.width, y * r.height, l.x1 * r.width, l.y1 * r.height, l.x2 * r.width, l.y2 * r.height) < HANDLE_R * 1.5) which = 'both';
  if (!which) return;
  drag = { which, startX: x, startY: y, line: { ...l } };
  overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});

overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { x, y } = pointerPos(e);
  const c = (v) => Math.min(1, Math.max(0, v));
  const l = settings.line;
  if (drag.which === 1) { l.x1 = c(x); l.y1 = c(y); }
  else if (drag.which === 2) { l.x2 = c(x); l.y2 = c(y); }
  else {
    const dx = x - drag.startX, dy = y - drag.startY;
    l.x1 = c(drag.line.x1 + dx); l.y1 = c(drag.line.y1 + dy);
    l.x2 = c(drag.line.x2 + dx); l.y2 = c(drag.line.y2 + dy);
  }
  drawOverlay();
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  saveSettings();
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* ---------------- 設定 UI ---------------- */
function bindRange(id, key, outId, fmtFn = (v) => v) {
  const input = $('#' + id);
  const out = $('#' + outId);
  input.value = settings[key];
  out.textContent = fmtFn(settings[key]);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    out.textContent = fmtFn(settings[key]);
    if (key === 'thickness') state.sampleKey = '';
    updateMeter();
    saveSettings();
  });
}
bindRange('sens', 'sensitivity', 'sensOut');
bindRange('thr', 'threshold', 'thrOut');
bindRange('cool', 'cooldown', 'coolOut', (v) => Number(v).toFixed(1));
bindRange('thick', 'thickness', 'thickOut');

function bindCheck(id, key, onChange) {
  const input = $('#' + id);
  input.checked = !!settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    saveSettings();
    if (onChange) onChange();
  });
}
bindCheck('sound', 'sound', ensureAudio);
bindCheck('vibrate', 'vibrate');
bindCheck('lockLine', 'lockLine', drawOverlay);

/* ---------------- ボタン ---------------- */
btnCamera.addEventListener('click', () => {
  ensureAudio();
  if (state.stream) stopCamera(); else startCamera();
});

btnArm.addEventListener('click', () => {
  ensureAudio();
  if (state.phase === 'idle') {
    setPhase('armed');
    currentEl.textContent = fmt(0);
    totalEl.textContent = '--';
  } else {
    setPhase('idle');
  }
});

btnReset.addEventListener('click', () => {
  if (state.laps.length && !confirm('ラップ記録をすべて消去しますか？')) return;
  state.laps = [];
  saveJSON('laptimer.laps', { list: [] });
  renderLaps(false);
  currentEl.textContent = fmt(0);
  totalEl.textContent = '--';
  if (state.phase !== 'idle') setPhase('armed');
});

$('#btnLine').addEventListener('click', () => {
  settings.line = { ...DEFAULTS.line };
  saveSettings();
  drawOverlay();
});

$('#btnFlip').addEventListener('click', () => {
  settings.facing = settings.facing === 'environment' ? 'user' : 'environment';
  saveSettings();
  if (state.stream) startCamera();
});

$('#btnTest').addEventListener('click', () => {
  ensureAudio();
  if (state.phase === 'idle') {
    alert('先に「計測待機」を押してください');
    return;
  }
  onCross(performance.now());
});

$('#btnCopy').addEventListener('click', async () => {
  if (!state.laps.length) return;
  const best = Math.min(...state.laps);
  const total = state.laps.reduce((a, b) => a + b, 0);
  const lines = state.laps.map((l, i) => `LAP ${i + 1}\t${fmt(l)}${l === best ? '\tBEST' : ''}`);
  lines.push(`BEST\t${fmt(best)}`, `TOTAL\t${fmt(total)}`);
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    alert('コピーしました');
  } catch (_) {
    prompt('コピーしてください', text);
  }
});

/* ---------------- 初期化 ---------------- */
renderLaps(false);
setPhase('idle');
layoutVideo();
updateMeter();
requestAnimationFrame(tick);

// テスト・デバッグ用
window.__laptimer = { state, settings, onCross };
