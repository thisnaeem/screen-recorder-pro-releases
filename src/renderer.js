'use strict';
/* Screen Recorder Pro — renderer. All work is local; no network calls. */
const $ = (id) => document.getElementById(id);
const api = window.electronAPI;
const fmt = (s) => {
  if (!isFinite(s)) return '00:00';
  s = Math.max(0, Math.floor(s));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const isTyping = () => /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');

const state = {
  sources: [], sourceId: null, sourceName: '',
  stream: null, micStream: null, webcamStream: null, sysAudioStream: null,
  recorder: null, chunks: [], recording: false, paused: false,
  recordedBlob: null, recordedUrl: null, recStart: 0, recElapsed: 0, timerId: null,
  compCanvas: null, compCtx: null, compRaf: 0,
  trimStart: 0, trimEnd: 0, speed: 1,
  keyframes: [], annotations: [], captions: [],
  focus: { x: 50, y: 50 }, lastRippleAt: -10,
  shot: { img: null, shapes: [], history: [], cropRect: null, drawing: null },
  library: [], settings: {}
};

try { state.library = JSON.parse(localStorage.getItem('srp-library') || '[]'); } catch (_e) { state.library = []; }
try { state.settings = JSON.parse(localStorage.getItem('srp-settings') || '{}'); } catch (_e) { state.settings = {}; }

function saveLibrary() { localStorage.setItem('srp-library', JSON.stringify(state.library)); }
function setStatus(t) { $('recStatus').textContent = t; }
function toast(msg) { setStatus(msg); }

/* ---------------- Sources & live preview ---------------- */
async function loadSources() {
  $('sourceList').innerHTML = '<p class="muted">Loading sources…</p>';
  try {
    state.sources = await api.getSources();
    if (!state.sources.length) { $('sourceList').innerHTML = '<p class="muted">No screens/windows found.</p>'; return; }
    $('sourceList').innerHTML = '';
    state.sources.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'source-item' + (s.id === state.sourceId ? ' selected' : '');
      b.innerHTML = `<img src="${s.thumbnail}" alt=""><span><b>${s.type === 'screen' ? '🖥️' : '🪟'}</b> ${escapeHtml(s.name)}</span>`;
      b.onclick = () => selectSource(s);
      $('sourceList').appendChild(b);
    });
  } catch (e) { $('sourceList').innerHTML = `<p class="muted">Could not list sources: ${escapeHtml(e.message)}</p>`; }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function selectSource(s) {
  state.sourceId = s.id; state.sourceName = s.name;
  document.querySelectorAll('.source-item').forEach((el, i) => el.classList.toggle('selected', state.sources[i] && state.sources[i].id === s.id));
  await startPreview();
}

async function desktopStream(extraAudio) {
  const fps = parseInt($('inpFps').value || '30', 10);
  return navigator.mediaDevices.getUserMedia({
    audio: extraAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: state.sourceId, minWidth: 1280, maxWidth: 1920, minFrameRate: fps, maxFrameRate: fps } }
  });
}

async function startPreview() {
  if (!state.sourceId) { toast('Pick a screen or window first'); return; }
  stopStreams(false);
  try {
    state.stream = await desktopStream(false);
    const v = $('previewVideo');
    v.srcObject = state.stream; v.muted = true;
    await v.play().catch(() => {});
    $('editorHint').classList.add('hidden');
    $('shotCanvas').classList.add('hidden'); v.classList.remove('hidden');
    setStatus('Preview: ' + state.sourceName);
  } catch (e) { setStatus('Preview failed: ' + e.message); }
}

function stopStreams(includePreview) {
  [state.stream, state.micStream, state.sysAudioStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
  state.stream = state.micStream = state.sysAudioStream = null;
  if (includePreview) { $('previewVideo').srcObject = null; }
  if (state.webcamStream) { state.webcamStream.getTracks().forEach((t) => t.stop()); state.webcamStream = null; $('webcamVideo').classList.add('hidden'); $('webcamVideo').srcObject = null; }
  if (state.compRaf) cancelAnimationFrame(state.compRaf);
}

/* ---------------- Recording ---------------- */
function pickMime() {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}
function countdown(seconds) {
  return new Promise((resolve) => {
    const ov = $('countdownOverlay');
    if (!seconds || seconds <= 0) return resolve();
    let n = seconds; ov.classList.remove('hidden'); ov.textContent = n;
    const id = setInterval(() => { n -= 1; if (n <= 0) { clearInterval(id); ov.classList.add('hidden'); resolve(); } else ov.textContent = n; }, 1000);
  });
}
function startTimer() {
  state.recStart = Date.now() - state.recElapsed * 1000;
  state.timerId = setInterval(() => { state.recElapsed = (Date.now() - state.recStart) / 1000; $('recTimer').textContent = fmt(state.recElapsed); }, 250);
}
function stopTimer() { if (state.timerId) clearInterval(state.timerId); state.timerId = null; }

function drawComposite() {
  const v = $('previewVideo'), wv = $('webcamVideo');
  const c = state.compCanvas, ctx = state.compCtx;
  if (!c || !v.videoWidth) { state.compRaf = requestAnimationFrame(drawComposite); return; }
  ctx.drawImage(v, 0, 0, c.width, c.height);
  if (state.webcamStream && wv.videoWidth) {
    const w = 320, h = 180, x = c.width - w - 16, y = c.height - h - 16;
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(x - 2, y - 2, w + 4, h + 4); ctx.drawImage(wv, x, y, w, h); ctx.restore();
  }
  state.compRaf = requestAnimationFrame(drawComposite);
}

async function startRecording() {
  if (!state.sourceId) { toast('Pick a screen or window first'); return; }
  if (state.recording) return;
  await countdown(parseInt($('inpCountdown').value || '3', 10));
  try {
    if (!state.stream) await startPreview();
    if ($('chkMic').checked) { try { state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch (e) { toast('Mic unavailable, continuing without it: ' + e.message); } }
    if ($('chkSysAudio').checked) { try { state.sysAudioStream = await desktopStream(true); } catch (_e) { toast('System audio not available on this OS/setup — continuing without it'); } }
    if ($('chkWebcam').checked) {
      try {
        state.webcamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
        $('webcamVideo').srcObject = state.webcamStream; $('webcamVideo').classList.remove('hidden');
        await $('webcamVideo').play().catch(() => {});
      } catch (e) { toast('Webcam unavailable, continuing without it: ' + e.message); }
    }
    const tracks = [...state.stream.getVideoTracks()];
    if (state.micStream) tracks.push(...state.micStream.getAudioTracks());
    if (state.sysAudioStream) tracks.push(...state.sysAudioStream.getAudioTracks());
    let recordStream;
    if (state.webcamStream) {
      state.compCanvas = document.createElement('canvas'); state.compCanvas.width = 1280; state.compCanvas.height = 720;
      state.compCtx = state.compCanvas.getContext('2d'); drawComposite();
      recordStream = state.compCanvas.captureStream(30);
      tracks.filter((t) => t.kind === 'audio').forEach((t) => recordStream.addTrack(t));
    } else {
      recordStream = new MediaStream(tracks);
    }
    state.chunks = [];
    state.recorder = new MediaRecorder(recordStream, pickMime() ? { mimeType: pickMime(), videoBitsPerSecond: 8000000 } : undefined);
    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
    state.recorder.onstop = onRecordingStopped;
    state.recorder.start(1000);
    state.recording = true; state.paused = false; state.recElapsed = 0; startTimer();
    $('btnRecord').disabled = true; $('btnPause').disabled = false; $('btnStop').disabled = false;
    setStatus('● Recording…');
  } catch (e) { setStatus('Recording failed: ' + e.message); }
}

function pauseRecording() {
  if (!state.recorder || !state.recording) return;
  if (state.paused) { state.recorder.resume(); state.paused = false; startTimer(); $('btnPause').textContent = 'Pause'; setStatus('● Recording…'); }
  else { state.recorder.pause(); state.paused = true; stopTimer(); $('btnPause').textContent = 'Resume'; setStatus('Paused'); }
}
function stopRecording() {
  if (!state.recorder || !state.recording) return;
  state.recording = false; stopTimer();
  try { state.recorder.stop(); } catch (_e) { /* already stopped */ }
  $('btnRecord').disabled = false; $('btnPause').disabled = true; $('btnStop').disabled = true; $('btnPause').textContent = 'Pause';
  if (state.compRaf) cancelAnimationFrame(state.compRaf);
  setStatus('Processing recording…');
}
function onRecordingStopped() {
  state.recordedBlob = new Blob(state.chunks, { type: state.recorder.mimeType || 'video/webm' });
  state.recordedUrl = URL.createObjectURL(state.recordedBlob);
  loadEditorVideo(state.recordedUrl);
  state.trimStart = 0; state.keyframes = []; state.annotations = []; state.captions = [];
  $('inpTrimStart').value = 0; renderKeyframes(); renderAnnotations(); renderCaptions();
  setStatus('Recording ready in the editor — trim, add zoom, then Export.');
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  if (state.sysAudioStream) { state.sysAudioStream.getTracks().forEach((t) => t.stop()); state.sysAudioStream = null; }
}
function loadEditorVideo(url) {
  const v = $('previewVideo');
  v.srcObject = null; v.src = url; v.muted = false; v.controls = false;
  v.onloadedmetadata = () => { state.trimEnd = v.duration || 0; $('inpTrimEnd').value = state.trimEnd.toFixed(1); $('tlTime').textContent = '00:00 / ' + fmt(v.duration); };
  v.play().catch(() => {});
}

/* ---------------- Screenshots ---------------- */
async function takeScreenshot() {
  if (!state.sourceId) { toast('Pick a screen or window first'); return; }
  try {
    const shot = await api.captureScreenshot(state.sourceId);
    const img = new Image();
    img.onload = () => {
      state.shot.img = img; state.shot.shapes = []; state.shot.history = []; state.shot.cropRect = null;
      const c = $('shotCanvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      $('previewVideo').classList.add('hidden'); c.classList.remove('hidden');
      drawShot(); switchTab('tabShot'); setStatus('Screenshot ready — draw on it, then Save.');
    };
    img.src = shot.dataUrl;
  } catch (e) { setStatus('Screenshot failed: ' + e.message); }
}
function drawShot() {
  const c = $('shotCanvas'), ctx = c.getContext('2d'); if (!state.shot.img) return;
  ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(state.shot.img, 0, 0);
  state.shot.shapes.forEach((s) => drawShape(ctx, s));
  if (state.shot.cropRect) { const r = state.shot.cropRect; ctx.save(); ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.restore(); }
}
function drawShape(ctx, s) {
  ctx.save(); ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.line; ctx.lineCap = 'round';
  if (s.type === 'rect') ctx.strokeRect(s.x, s.y, s.w, s.h);
  if (s.type === 'highlight') { ctx.globalAlpha = 0.35; ctx.fillRect(s.x, s.y, s.w, s.h); }
  if (s.type === 'arrow') {
    const ang = Math.atan2(s.y2 - s.y, s.x2 - s.x);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x2, s.y2); ctx.lineTo(s.x2 - 16 * Math.cos(ang - 0.4), s.y2 - 16 * Math.sin(ang - 0.4)); ctx.lineTo(s.x2 - 16 * Math.cos(ang + 0.4), s.y2 - 16 * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
  }
  if (s.type === 'text') { ctx.font = `bold ${Math.max(20, s.line * 6)}px system-ui`; ctx.fillText(s.text, s.x, s.y); }
  if (s.type === 'blur') { /* pixelated region, baked at creation time */ }
  ctx.restore();
}
function canvasPos(e) {
  const c = $('shotCanvas'), r = c.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
}
function pixelateRegion(x, y, w, h) {
  const c = $('shotCanvas'), ctx = c.getContext('2d');
  if (w < 4 || h < 4) return;
  const tmp = document.createElement('canvas'); tmp.width = Math.max(4, Math.floor(w / 16)); tmp.height = Math.max(4, Math.floor(h / 16));
  const tctx = tmp.getContext('2d'); tctx.drawImage(c, x, y, w, h, 0, 0, tmp.width, tmp.height);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h); ctx.imageSmoothingEnabled = true;
}
function initShotCanvasEvents() {
  const c = $('shotCanvas');
  c.addEventListener('mousedown', (e) => {
    if (!state.shot.img) return;
    const p = canvasPos(e); state.shot.drawing = { tool: $('shotTool').value, x: p.x, y: p.y, x2: p.x, y2: p.y };
  });
  c.addEventListener('mousemove', (e) => {
    if (!state.shot.drawing) return;
    const p = canvasPos(e); state.shot.drawing.x2 = p.x; state.shot.drawing.y2 = p.y;
    drawShot();
    const d = state.shot.drawing, x = Math.min(d.x, d.x2), y = Math.min(d.y, d.y2), w = Math.abs(d.x2 - d.x), h = Math.abs(d.y2 - d.y);
    if (d.tool === 'crop') state.shot.cropRect = { x, y, w, h };
    else drawShape(c.getContext('2d'), { type: d.tool === 'blur' ? 'rect' : d.tool, x, y, w, h, x2: d.x2, y2: d.y2, color: $('shotColor').value, line: parseInt($('shotLine').value || '4', 10), text: $('shotText').value || 'Text' });
    if (d.tool === 'crop') drawShot();
  });
  c.addEventListener('mouseup', () => {
    const d = state.shot.drawing; if (!d) return; state.shot.drawing = null;
    const x = Math.min(d.x, d.x2), y = Math.min(d.y, d.y2), w = Math.abs(d.x2 - d.x), h = Math.abs(d.y2 - d.y);
    if (d.tool === 'crop') { state.shot.cropRect = { x, y, w, h }; drawShot(); return; }
    if (d.tool === 'blur') { pixelateRegion(x, y, w, h); state.shot.history.push('blur'); drawShot(); return; }
    state.shot.history.push(JSON.stringify(state.shot.shapes));
    state.shot.shapes.push({ type: d.tool, x, y, w, h, x2: d.x2, y2: d.y2, color: $('shotColor').value, line: parseInt($('shotLine').value || '4', 10), text: $('shotText').value || 'Text' });
    drawShot();
  });
}
async function saveShot(format) {
  const c = $('shotCanvas'); if (!state.shot.img) { toast('No screenshot to save'); return; }
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const dataUrl = c.toDataURL(type, 0.92);
  const filePath = await api.showSaveDialog({ defaultPath: `screenshot-${Date.now()}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!filePath) return;
  await api.saveDataUrl(filePath, dataUrl);
  addToLibrary({ kind: 'screenshot', name: filePath.split(/[\\/]/).pop(), path: filePath, thumb: c.toDataURL('image/png'), date: new Date().toISOString() });
  setStatus('Screenshot saved: ' + filePath); $('exportStatus').textContent = 'Saved: ' + filePath;
}

/* ---------------- Video editor: zoom, overlays, timeline ---------------- */
function renderKeyframes() {
  const list = $('keyframeList'), track = $('keyframeTrack');
  list.innerHTML = state.keyframes.length ? '' : '<p class="muted small">No keyframes yet. Auto zoom creates them, or click the preview to set a focus point and add one.</p>';
  track.innerHTML = '';
  const dur = $('previewVideo').duration || 0;
  state.keyframes.slice().sort((a, b) => a.time - b.time).forEach((k, i) => {
    const row = document.createElement('div'); row.className = 'kf-item';
    row.innerHTML = `<span>${fmt(k.time)} · ${k.scale.toFixed(1)}× @ ${k.x}%, ${k.y}%${k.click ? ' · click' : ''}</span>`;
    const del = document.createElement('button'); del.className = 'btn'; del.textContent = '✕'; del.onclick = () => { state.keyframes.splice(state.keyframes.indexOf(k), 1); renderKeyframes(); };
    row.appendChild(del); list.appendChild(row);
    if (dur > 0) { const dot = document.createElement('div'); dot.className = 'kf-dot'; dot.style.left = (k.time / dur * 100) + '%'; dot.title = fmt(k.time) + ' ' + k.scale + '×'; dot.onclick = () => { $('previewVideo').currentTime = k.time; }; track.appendChild(dot); }
  });
}
function zoomAt(t) {
  const kfs = state.keyframes.slice().sort((a, b) => a.time - b.time);
  if (!kfs.length) return { scale: 1, x: 50, y: 50 };
  if (t <= kfs[0].time) return kfs[0];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.time && t <= b.time) {
      const raw = (t - a.time) / Math.max(0.001, b.time - a.time);
      const speed = parseFloat($('inpZoomSpeed').value || '0.6');
      const p = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2; // easeInOutQuad
      void speed;
      return { scale: a.scale + (b.scale - a.scale) * p, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    }
  }
  return kfs[kfs.length - 1];
}
function applyEditorFrame() {
  const v = $('previewVideo'); if (!v.duration) return;
  const t = v.currentTime, z = zoomAt(t);
  v.style.transformOrigin = `${z.x}% ${z.y}%`;
  v.style.transform = z.scale > 1.01 ? `scale(${z.scale})` : '';
  const hl = $('cursorHighlight');
  if ($('chkCursorHl').checked && z.scale > 1.01) {
    hl.classList.remove('hidden'); hl.style.left = z.x + '%'; hl.style.top = z.y + '%';
  } else hl.classList.add('hidden');
  if ($('chkRipple').checked) {
    const near = state.keyframes.find((k) => k.click && Math.abs(k.time - t) < 0.25 && Math.abs(k.time - state.lastRippleAt) > 1);
    if (near) { state.lastRippleAt = near.time; const r = $('clickRipple'); r.classList.remove('hidden'); r.style.left = near.x + '%'; r.style.top = near.y + '%'; r.style.animation = 'none'; void r.offsetWidth; r.style.animation = ''; setTimeout(() => r.classList.add('hidden'), 850); }
  }
  const ann = state.annotations.find((a) => t >= a.start && t <= a.end);
  const annEl = $('annotationOverlay'); if (ann) { annEl.textContent = ann.text; annEl.classList.remove('hidden'); } else annEl.classList.add('hidden');
  const cap = state.captions.find((a) => t >= a.start && t <= a.end);
  const capEl = $('captionOverlay'); if (cap) { capEl.textContent = cap.text; capEl.classList.remove('hidden'); } else capEl.classList.add('hidden');
  $('tlTime').textContent = fmt(t) + ' / ' + fmt(v.duration);
  if (v.duration) $('tlScrub').value = Math.floor(t / v.duration * 1000);
  if (t >= (state.trimEnd || v.duration)) v.pause();
}
function autoZoom() {
  const v = $('previewVideo'); if (!v.duration) { toast('Load a recording first'); return; }
  const level = parseFloat($('inpEditZoom').value || $('inpZoomLevel').value || '1.8');
  const d = v.duration, foci = [{ x: 50, y: 50 }, { x: 30, y: 35 }, { x: 70, y: 60 }, { x: 50, y: 40 }];
  const kfs = [{ time: 0, x: 50, y: 50, scale: 1, click: false }];
  foci.forEach((f, i) => {
    const t = d * (0.2 + i * 0.2);
    kfs.push({ time: t, x: f.x, y: f.y, scale: level, click: true });
    kfs.push({ time: Math.min(d, t + d * 0.1), x: 50, y: 50, scale: 1, click: false });
  });
  state.keyframes = kfs; renderKeyframes(); setStatus('Auto zoom keyframes created — play the video to preview the smooth zoom.');
}
function renderAnnotations() {
  $('annList').innerHTML = state.annotations.map((a, i) => `<div class="kf-item"><span>${escapeHtml(a.text)} (${fmt(a.start)}–${fmt(a.end)})</span><button class="btn" data-i="${i}">✕</button></div>`).join('');
  $('annList').querySelectorAll('button').forEach((b) => b.onclick = () => { state.annotations.splice(+b.dataset.i, 1); renderAnnotations(); });
}
function renderCaptions() {
  $('capList').innerHTML = state.captions.map((a, i) => `<div class="kf-item"><span>${escapeHtml(a.text)} (${fmt(a.start)}–${fmt(a.end)})</span><button class="btn" data-i="${i}">✕</button></div>`).join('');
  $('capList').querySelectorAll('button').forEach((b) => b.onclick = () => { state.captions.splice(+b.dataset.i, 1); renderCaptions(); });
}

/* ---------------- Export ---------------- */
function pickExportMime(format) {
  if (format === 'mp4') {
    for (const m of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/mp4;codecs=h264']) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return null; // caller falls back to WebM with a note
  }
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}
async function exportVideo() {
  const v = $('previewVideo');
  if (!state.recordedUrl && !v.src) { toast('No recording to export'); return; }
  const format = $('selExportFormat').value;
  let mime = pickExportMime(format);
  let note = '';
  if (format === 'mp4' && !mime) { mime = pickExportMime('webm'); note = 'MP4 codec not supported in this Chromium build — exported as WebM instead. '; }
  const start = state.trimStart || 0, end = state.trimEnd || v.duration || 0;
  if (end <= start) { toast('Trim end must be after trim start'); return; }
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const src = document.createElement('video'); src.src = state.recordedUrl || v.src; src.muted = true; src.playbackRate = state.speed;
  await new Promise((res) => { src.onloadedmetadata = res; src.load(); });
  src.currentTime = start;
  await new Promise((res) => { src.onseeked = res; });
  const chunks = [];
  const rec = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start(500);
  $('exportStatus').textContent = note + 'Exporting… (real-time render, please keep this window open)';
  await src.play().catch(() => {});
  const draw = () => {
    const t = src.currentTime;
    if ($('chkBlurBg').checked) { ctx.save(); ctx.filter = 'blur(24px) brightness(0.7)'; ctx.drawImage(src, -80, -45, 1440, 810); ctx.restore(); }
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1280, 720); }
    const z = zoomAt(t);
    const vw = 1280, vh = 720;
    const dw = vw * z.scale, dh = vh * z.scale;
    const dx = vw / 2 - (z.x / 100) * dw, dy = vh / 2 - (z.y / 100) * dh;
    ctx.drawImage(src, dx, dy, dw, dh);
    if ($('chkCursorHl').checked && z.scale > 1.01) {
      ctx.save(); ctx.strokeStyle = '#ffe600'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc((z.x / 100) * vw, (z.y / 100) * vh, 28, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    const ann = state.annotations.find((a) => t >= a.start && t <= a.end);
    if (ann) { ctx.save(); ctx.font = '800 42px system-ui'; ctx.textAlign = 'center'; ctx.shadowColor = '#000'; ctx.shadowBlur = 8; ctx.fillStyle = '#fff'; ctx.fillText(ann.text, 640, 120, 1200); ctx.restore(); }
    const cap = state.captions.find((a) => t >= a.start && t <= a.end);
    if (cap) { ctx.save(); ctx.font = '26px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(0,0,0,0.65)'; const w = ctx.measureText(cap.text).width + 24; ctx.fillRect(640 - w / 2, 640, w, 40); ctx.fillStyle = '#fff'; ctx.fillText(cap.text, 640, 670); ctx.restore(); }
    $('exportProgress').value = Math.min(100, ((t - start) / (end - start)) * 100);
    if (t < end && !src.ended && !src.paused) requestAnimationFrame(draw);
    else { try { rec.stop(); } catch (_e) {} }
  };
  src.ontimeupdate = () => { if (src.currentTime >= end) { src.pause(); } };
  draw();
  await done;
  const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
  const ext = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  const filePath = await api.showSaveDialog({ defaultPath: `edited-${Date.now()}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!filePath) { $('exportStatus').textContent = 'Export cancelled (video was rendered but not saved).'; return; }
  const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  await api.saveDataUrl(filePath, dataUrl);
  addToLibrary({ kind: 'video', name: filePath.split(/[\\/]/).pop(), path: filePath, thumb: '', date: new Date().toISOString() });
  $('exportProgress').value = 100;
  $('exportStatus').textContent = note + 'Exported: ' + filePath;
  setStatus('Exported: ' + filePath);
}
async function exportProject() {
  const project = { app: 'Screen Recorder Pro', version: 1, sourceName: state.sourceName, trimStart: state.trimStart, trimEnd: state.trimEnd, speed: state.speed, keyframes: state.keyframes, annotations: state.annotations, captions: state.captions, settings: state.settings, exportedAt: new Date().toISOString() };
  const filePath = await api.showSaveDialog({ defaultPath: `project-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!filePath) return;
  await api.saveDataUrl(filePath, 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(project, null, 2)))));
  setStatus('Project exported: ' + filePath);
}
async function saveRawRecording() {
  if (!state.recordedBlob) { toast('No recording yet'); return; }
  const ext = (state.recordedBlob.type || '').includes('mp4') ? 'mp4' : 'webm';
  const filePath = await api.showSaveDialog({ defaultPath: `recording-${Date.now()}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!filePath) return;
  const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(state.recordedBlob); });
  await api.saveDataUrl(filePath, dataUrl);
  addToLibrary({ kind: 'video', name: filePath.split(/[\\/]/).pop(), path: filePath, thumb: '', date: new Date().toISOString() });
  setStatus('Recording saved: ' + filePath);
}

/* ---------------- Library / settings / tabs ---------------- */
function addToLibrary(item) {
  state.library.unshift(item); state.library = state.library.slice(0, 60); saveLibrary(); renderLibrary();
}
function renderLibrary() {
  const el = $('libraryList');
  if (!state.library.length) { el.innerHTML = '<p class="muted small">Nothing saved yet.</p>'; return; }
  el.innerHTML = '';
  state.library.forEach((item) => {
    const b = document.createElement('button'); b.className = 'lib-item';
    b.innerHTML = `${item.thumb ? `<img src="${item.thumb}" alt="">` : '<span style="font-size:22px">🎬</span>'}<span><b>${escapeHtml(item.name)}</b><br><span class="muted">${item.kind} · ${new Date(item.date).toLocaleString()}</span></span>`;
    b.onclick = async () => {
      if (item.kind === 'screenshot') {
        const img = new Image(); img.onload = () => { state.shot.img = img; state.shot.shapes = []; const c = $('shotCanvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; $('previewVideo').classList.add('hidden'); c.classList.remove('hidden'); drawShot(); switchTab('tabShot'); }; img.src = await api.getFileUrl(item.path).then((u) => u);
      } else if (item.path) {
        const url = await api.getFileUrl(item.path); state.recordedUrl = url; loadEditorVideo(url);
      }
    };
    b.oncontextmenu = (e) => { e.preventDefault(); api.openInFolder(item.path); };
    el.appendChild(b);
  });
}
function switchTab(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === id));
}
async function initSettings() {
  const dir = await api.getDefaultSaveDir();
  $('inpSaveDir').value = state.settings.saveDir || dir;
  $('inpZoomLevel').value = state.settings.zoomLevel || 1.8;
  $('inpZoomSpeed').value = state.settings.zoomSpeed || 0.6;
  $('chkMic').checked = !!state.settings.mic;
  $('chkWebcam').checked = !!state.settings.webcam;
}

/* ---------------- Wiring ---------------- */
/* ---------------- Auto-update UI ---------------- */
let updateState = 'idle';
function showUpdateBanner(text, actionLabel) {
  const b = $('updateBanner'); if (!b) return;
  $('updateBannerText').textContent = text; b.classList.remove('hidden');
  const act = $('btnUpdateAction'); act.textContent = actionLabel || 'Download update'; act.style.display = actionLabel ? '' : 'none';
}
function hideUpdateBanner() { const b = $('updateBanner'); if (b) b.classList.add('hidden'); }
function initUpdates() {
  const apiU = window.electronAPI; if (!apiU || !apiU.getAppVersion) return;
  apiU.getAppVersion().then((v) => { const el = $('appVersion'); if (el) el.textContent = 'v' + v; }).catch(() => {});
  const autoChk = $('chkAutoUpdate');
  if (autoChk) autoChk.checked = localStorage.getItem('srp-auto-update') !== 'off';
  if (autoChk) autoChk.addEventListener('change', () => localStorage.setItem('srp-auto-update', autoChk.checked ? 'on' : 'off'));
  $('btnCheckUpdates').onclick = async () => {
    $('updateStatus').textContent = 'Checking for updates…';
    const r = await apiU.checkForUpdates().catch(() => null);
    if (r && r.status === 'dev') $('updateStatus').textContent = 'Dev run — updates only work in a packaged build (npm run build).';
    else $('updateStatus').textContent = 'Check sent — a banner will appear if a new version is available.';
  };
  $('btnUpdateDismiss').onclick = hideUpdateBanner;
  $('btnUpdateAction').onclick = async () => {
    if (updateState === 'downloaded') { await apiU.installUpdate(); return; }
    updateState = 'downloading'; $('btnUpdateAction').textContent = 'Downloading…';
    await apiU.downloadUpdate();
  };
  apiU.onUpdateEvent((ev) => {
    if (!ev) return;
    if (ev.type === 'available') { updateState = 'available'; showUpdateBanner(`New version ${ev.version} available.`, 'Download update'); $('updateStatus').textContent = `New version ${ev.version} available.`; }
    else if (ev.type === 'downloaded') { updateState = 'downloaded'; showUpdateBanner(`Version ${ev.version} downloaded — restart to install.`, 'Restart & install'); }
    else if (ev.type === 'progress') { $('updateBannerText').textContent = `Downloading update… ${ev.percent}%`; }
    else if (ev.type === 'not-available') { $('updateStatus').textContent = 'You are on the latest version.'; }
    else if (ev.type === 'error') { $('updateStatus').textContent = 'Update check failed: ' + (ev.message || ''); }
  });
  // Startup check, unless the user turned it off in Settings.
  if (localStorage.getItem('srp-auto-update') !== 'off') {
    setTimeout(() => apiU.checkForUpdates().catch(() => {}), 3000);
  }
}

function init() {
  loadSources(); initSettings(); renderLibrary(); initShotCanvasEvents(); initUpdates();
  $('btnRefreshSources').onclick = loadSources;
  $('btnRecord').onclick = startRecording;
  $('btnPause').onclick = pauseRecording;
  $('btnStop').onclick = stopRecording;
  $('btnScreenshot').onclick = takeScreenshot;
  $('btnApplyCrop').onclick = () => {
    const r = state.shot.cropRect; if (!r || !state.shot.img) return;
    const c = $('shotCanvas'), tmp = document.createElement('canvas'); tmp.width = Math.floor(r.w); tmp.height = Math.floor(r.h);
    tmp.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, tmp.width, tmp.height);
    c.width = tmp.width; c.height = tmp.height; c.getContext('2d').drawImage(tmp, 0, 0);
    state.shot.img = new Image(); state.shot.img.src = c.toDataURL(); state.shot.cropRect = null; state.shot.shapes = []; drawShot();
  };
  $('btnUndoShot').onclick = () => { state.shot.shapes.pop(); drawShot(); };
  $('btnClearShot').onclick = () => { state.shot.shapes = []; state.shot.cropRect = null; drawShot(); };
  $('btnSaveShot').onclick = () => saveShot('png');
  $('btnSaveShotJpg').onclick = () => saveShot('jpg');
  $('btnAutoZoom').onclick = autoZoom;
  $('btnAddKeyframe').onclick = () => {
    const v = $('previewVideo'); if (!v.duration) return;
    state.keyframes.push({ time: v.currentTime, x: state.focus.x, y: state.focus.y, scale: parseFloat($('inpEditZoom').value || '1.8'), click: true });
    renderKeyframes();
  };
  $('previewVideo').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect();
    state.focus = { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
    setStatus(`Zoom focus set: ${state.focus.x.toFixed(0)}%, ${state.focus.y.toFixed(0)}% — press “+ Keyframe here”.`);
  });
  $('previewVideo').addEventListener('timeupdate', applyEditorFrame);
  $('previewVideo').addEventListener('loadedmetadata', () => { if (!$('inpTrimEnd').value || $('inpTrimEnd').value === '0') $('inpTrimEnd').value = $('previewVideo').duration.toFixed(1); });
  $('tlScrub').addEventListener('input', (e) => { const v = $('previewVideo'); if (v.duration) v.currentTime = (e.target.value / 1000) * v.duration; });
  $('btnPlayEditor').onclick = () => { const v = $('previewVideo'); if (v.paused) { v.currentTime = Math.max(state.trimStart, Math.min(v.currentTime, state.trimEnd || v.duration)); v.play().catch(() => {}); $('btnPlayEditor').textContent = '⏸ Pause'; } else { v.pause(); $('btnPlayEditor').textContent = '▶ Play'; } };
  $('inpTrimStart').addEventListener('change', (e) => state.trimStart = parseFloat(e.target.value || '0'));
  $('inpTrimEnd').addEventListener('change', (e) => state.trimEnd = parseFloat(e.target.value || '0'));
  $('selSpeed').addEventListener('change', (e) => { state.speed = parseFloat(e.target.value); $('previewVideo').playbackRate = state.speed; });
  $('btnAddAnn').onclick = () => { const t = $('inpAnnText').value.trim(); if (!t) return; state.annotations.push({ text: t, start: parseFloat($('inpAnnStart').value || '0'), end: parseFloat($('inpAnnEnd').value || '5') }); $('inpAnnText').value = ''; renderAnnotations(); };
  $('btnAddCap').onclick = () => { const t = $('inpCapText').value.trim(); if (!t) return; state.captions.push({ text: t, start: parseFloat($('inpCapStart').value || '0'), end: parseFloat($('inpCapEnd').value || '5') }); $('inpCapText').value = ''; renderCaptions(); };
  $('btnExportVideo').onclick = exportVideo;
  $('btnExportProject').onclick = exportProject;
  $('btnSaveRecording').onclick = saveRawRecording;
  $('btnClearLibrary').onclick = () => { state.library = []; saveLibrary(); renderLibrary(); };
  $('btnPickSaveDir').onclick = async () => { const d = await api.showOpenDirectoryDialog(); if (d) $('inpSaveDir').value = d; };
  $('btnSaveSettings').onclick = () => {
    state.settings = { saveDir: $('inpSaveDir').value, zoomLevel: parseFloat($('inpZoomLevel').value || '1.8'), zoomSpeed: parseFloat($('inpZoomSpeed').value || '0.6'), mic: $('chkMic').checked, webcam: $('chkWebcam').checked };
    localStorage.setItem('srp-settings', JSON.stringify(state.settings));
    $('settingsMsg').textContent = 'Settings saved.';
  };
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
  document.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); if (state.recording) stopRecording(); else startRecording(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); pauseRecording(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); takeScreenshot(); }
    if (e.code === 'Space' && $('previewVideo').src && !state.recording) { e.preventDefault(); const v = $('previewVideo'); if (v.paused) v.play().catch(() => {}); else v.pause(); }
  });
}
document.addEventListener('DOMContentLoaded', init);
