'use strict';
/* Triplet Labeler (online / static version).
   - videos are opened from a local folder (File System Access API) and never uploaded
   - YOLO runs in the browser (yolo-worker.js, onnxruntime-web)
   - labels are saved to a Google Sheet through an Apps Script web app (or kept in this browser)
   Frame numbers are the source of truth: frame f is shown during [f/fps, (f+1)/fps); we seek to its middle. */

const $ = (s, el = document) => el.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TOOL_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6', '#d37295'];
const CLASS_COLORS = {
  'aorta': '#ff4d4d', 'diaphragm': '#ffb000', 'lung': '#4da6ff', 'pericardium': '#b266ff',
  'port': '#00e0c0', 'right atrium': '#ff66cc', 'robot-arm': '#a8b3c2', 'suture': '#7dff6a',
};
const EXTRA_COLORS = ['#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#8338ec', '#fb5607'];
const STEPS = [
  { l: '1 frame', f: 1 }, { l: '5 frames', f: 5 }, { l: '0.5 s', s: 0.5 }, { l: '1 s', s: 1 }, { l: '2 s', s: 2 },
  { l: '5 s', s: 5 }, { l: '10 s', s: 10 }, { l: '30 s', s: 30 }, { l: '1 min', s: 60 }, { l: '5 min', s: 300 },
];
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
const COLS = ['tool', 'action', 'target'];
const TL = { RULER: 20, TH: 60, GAP: 6, LANE: 18, LGAP: 3 };
const MIN_FPP = 1 / 24; // max zoom: 24 px per frame
const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi'];
const DEFAULT_FPS = [30000, 1001];
const CONFIG = window.TRIPLET_CONFIG || {}; // config.js: pre-filled sheet URL / secret

const settings = Object.assign(
  { stepIdx: 5, speedIdx: 4, conf: 0.25, opacity: 0.45, auto: true, labels: true, defLen: 5, hidden: [], muted: true },
  store.get('tl.settings', {}));
const saveSettings = () => store.set('tl.settings', settings);

const S = {
  vocab: { tool: [], action: [], target: [] }, model: { status: 'loading', classes: {}, device: '' },
  videos: [], video: null, fps: 30, N: 1, frame: 0, playing: false, objectUrl: null,
  draft: { start: 0, end: 0 }, editId: null, stash: null,
  pick: { tool: null, action: null, target: null }, col: 0, note: '',
  segments: [], layout: { lane: new Map(), n: 2 }, undo: [], redo: [], last: store.get('tl.last', null), loop: false,
  seekTarget: 0, seekIssued: null, seekBusy: false, seekAt: 0,
  segCache: new Map(), segPending: new Set(), segShow: false, segErr: null, dwell: null,
  view: { start: 0, fpp: 1 }, thumbs: null, sprite: null, thumbStatus: '', thumbJob: null,
  dirty: false, saving: false, saveAgain: false, saveTimer: null, syncBlocked: false, raf: 0,
  hover: null, drag: null, panelKey: '', curKey: '', sheetIndex: {}, folderName: '', ready: false,
};

const video = $('#video'), overlay = $('#overlay'), tl = $('#tl'), ov = $('#overview');

/* ------------------------------------------------------------------ utils */
function fmtTime(sec) {
  const cs = Math.round(sec * 100), p2 = n => String(n).padStart(2, '0');
  const h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000), s = Math.floor(cs % 6000 / 100), c = cs % 100;
  return h ? `${h}:${p2(m)}:${p2(s)}.${p2(c)}` : `${m}:${p2(s)}.${p2(c)}`;
}
const fTime = f => fmtTime(f / S.fps);
const fEnd = f => fmtTime((f + 1) / S.fps); // end time of an inclusive end frame
const stepFrames = () => { const st = STEPS[settings.stepIdx]; return st.f || Math.max(1, Math.round(st.s * S.fps)); };
const defLenFrames = () => Math.max(1, Math.round(settings.defLen * S.fps));
const newId = () => 's_' + Math.random().toString(16).slice(2, 10);
const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';
const segById = id => S.segments.find(s => s.id === id);
const toolColor = t => { const i = S.vocab.tool.indexOf(t); return i < 0 ? '#777' : TOOL_COLORS[i % TOOL_COLORS.length]; };
function classColor(name) {
  const k = String(name).toLowerCase();
  if (CLASS_COLORS[k]) return CLASS_COLORS[k];
  const ids = Object.values(S.model.classes || {});
  return EXTRA_COLORS[Math.max(0, ids.indexOf(name)) % EXTRA_COLORS.length];
}
const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
function requestRender() { if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; render(); }); }

/* ------------------------------------------------------------------ IndexedDB (remembers the folder) */
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('triplet-labeler', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    } catch { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
    } catch { /* ignore */ }
  },
};

/* ------------------------------------------------------------------ backend: Google Sheet or this browser */
const Backend = {
  mode: null, // 'sheet' | 'local'
  cfg: CONFIG.sheetUrl && CONFIG.secret ? { url: CONFIG.sheetUrl, secret: CONFIG.secret } : store.get('tl.sheet', null), // {url, secret}
  async call(action, body = {}) {
    let r;
    try {
      // text/plain body = "simple" request, so Apps Script needs no CORS preflight
      r = await fetch(this.cfg.url, { method: 'POST', body: JSON.stringify({ secret: this.cfg.secret, action, ...body }) });
    } catch (e) { throw new Error('network error: could not reach the Apps Script URL'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let j;
    try { j = await r.json(); } catch { throw new Error('unexpected reply. Check the URL and that the deployment allows "Anyone"'); }
    if (j.error) throw new Error(j.error);
    return j;
  },
  async connect(url, secret) {
    const prev = this.cfg;
    this.cfg = { url: url.trim(), secret };
    try {
      const j = await this.call('ping');
      store.set('tl.sheet', this.cfg); store.set('tl.mode', 'sheet');
      this.mode = 'sheet';
      return j;
    } catch (e) { this.cfg = prev; throw e; }
  },
  useLocal() { this.mode = 'local'; store.set('tl.mode', 'local'); },
  async load(vid) {
    if (this.mode === 'sheet') return (await this.call('load', { video: vid })).segments || [];
    return store.get('tl.local.' + vid, []);
  },
  async save(vid, meta, segments) {
    if (this.mode === 'sheet') return this.call('save', { video: vid, meta, segments });
    store.set('tl.local.' + vid, segments);
    return { ok: true };
  },
  async addVocab(cat, val) {
    if (this.mode === 'sheet') return (await this.call('addVocab', { category: cat, value: val })).vocab;
    const v = JSON.parse(JSON.stringify(S.vocab));
    if (!v[cat].includes(val)) v[cat].push(val);
    store.set('tl.vocab', v);
    return v;
  },
};

/* ------------------------------------------------------------------ YOLO worker client */
const Yolo = {
  worker: null, pending: new Map(), nextId: 1, input: [544, 960],
  init() {
    try {
      this.worker = new Worker('yolo-worker.js');
    } catch (e) { setModel('error: ' + e.message); return; }
    this.worker.onmessage = e => this.onMsg(e.data);
    this.worker.onerror = e => setModel('error: ' + (e.message || 'worker failed'));
    this.worker.postMessage({ type: 'init', modelUrl: 'model/yolo-seg.onnx', metaUrl: 'model/meta.json' });
  },
  onMsg(m) {
    if (m.type === 'progress') setModel('loading', m.total ? `downloading model ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB` : `downloading model ${(m.loaded / 1e6).toFixed(0)} MB`);
    else if (m.type === 'ready') {
      this.input = m.input; S.model.classes = m.names; S.model.device = m.ep === 'webgpu' ? 'GPU' : 'CPU';
      setModel('ready', m.ep === 'webgpu' ? 'ready (GPU, WebGPU)' : 'ready (CPU only: slow, a few seconds per frame)');
      if (!S.playing) scheduleSeg();
    } else if (m.type === 'error') setModel('error: ' + m.message);
    else if (m.type === 'result' || m.type === 'runError') {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      m.type === 'result' ? p.res(m) : p.rej(new Error(m.message));
    }
  },
  run(frame, bitmap, srcW, srcH, conf) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.worker.postMessage({ type: 'run', id, frame, bitmap, srcW, srcH, conf }, [bitmap]);
    });
  },
};
function setModel(status, text) {
  S.model.status = status;
  S.model.text = text || status;
  const b = $('#modelBadge');
  b.className = 'badge ' + (status === 'ready' ? 'ok' : status.startsWith('error') ? 'err' : 'warn');
  b.textContent = status === 'ready' ? `YOLO ready (${S.model.device})` : status.startsWith('error') ? 'YOLO error' : 'YOLO loading…';
  b.title = S.model.text;
  $('#modelStatus').textContent = S.model.text;
  $('#modelStatus').className = 'small ' + (status === 'ready' ? 'ok-text' : status.startsWith('error') ? 'err-text' : 'muted');
  S.panelKey = ''; requestRender();
}

/* ------------------------------------------------------------------ MP4 metadata (exact fps / frame count) */
const str4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
async function readMp4Meta(file) {
  const rd = async (pos, len) => new DataView(await file.slice(pos, pos + len).arrayBuffer());
  let pos = 0, moov = null;
  for (let guard = 0; pos + 8 <= file.size && guard < 1000; guard++) {
    const h = await rd(pos, 16);
    let size = h.getUint32(0); const type = str4(h, 4);
    if (size === 1) size = Number(h.getBigUint64(8)); else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') { moov = await rd(pos, size); break; }
    pos += size;
  }
  if (!moov) return null;
  const boxes = (s, e) => {
    const out = []; let p = s;
    while (p + 8 <= e) {
      let sz = moov.getUint32(p), hdr = 8; const t = str4(moov, p + 4);
      if (sz === 1) { sz = Number(moov.getBigUint64(p + 8)); hdr = 16; } else if (sz === 0) sz = e - p;
      if (sz < 8) break;
      out.push({ t, s: p + hdr, e: p + sz }); p += sz;
    }
    return out;
  };
  const find = (b, t) => b && boxes(b.s, b.e).find(x => x.t === t);
  for (const trak of boxes(8, moov.byteLength).filter(b => b.t === 'trak')) {
    const mdia = find(trak, 'mdia'), hdlr = find(mdia, 'hdlr');
    if (!hdlr || str4(moov, hdlr.s + 8) !== 'vide') continue;
    const mdhd = find(mdia, 'mdhd'), v1 = moov.getUint8(mdhd.s) === 1;
    const timescale = moov.getUint32(mdhd.s + (v1 ? 20 : 12));
    const duration = v1 ? Number(moov.getBigUint64(mdhd.s + 24)) : moov.getUint32(mdhd.s + 16);
    const stts = find(find(find(mdia, 'minf'), 'stbl'), 'stts');
    if (!stts) continue;
    const n = moov.getUint32(stts.s + 4); let count = 0; const deltas = {};
    for (let i = 0; i < n; i++) {
      const c = moov.getUint32(stts.s + 8 + i * 8), d = moov.getUint32(stts.s + 12 + i * 8);
      count += c; deltas[d] = (deltas[d] || 0) + c;
    }
    const delta = +Object.entries(deltas).sort((a, b) => b[1] - a[1])[0][0];
    const g = gcd(timescale, delta);
    return { fps_num: timescale / g, fps_den: delta / g, fps: timescale / delta, n_frames: count, duration: duration / timescale, vfr: Object.keys(deltas).length > 1 };
  }
  return null;
}

/* ------------------------------------------------------------------ video folder */
async function scanDir(dir, prefix = '', out = []) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') await scanDir(h, prefix + name + '/', out);
    else if (VIDEO_EXTS.some(e => name.toLowerCase().endsWith(e))) out.push(videoEntry(prefix + name, () => h.getFile()));
  }
  return out;
}
function videoEntry(id, getFile) {
  const i = id.lastIndexOf('/');
  return { id, name: id.slice(i + 1), patient: i < 0 ? '(top folder)' : id.slice(0, i), getFile };
}
async function useFolderHandle(handle) {
  const vids = await scanDir(handle);
  vids.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  S.videos = vids; S.folderName = handle.name;
  await idb.set('dir', handle);
  folderReady();
}
function useFileList(files) {
  const vids = [];
  for (const f of files) {
    if (!VIDEO_EXTS.some(e => f.name.toLowerCase().endsWith(e)) || f.name.startsWith('.')) continue;
    const parts = (f.webkitRelativePath || f.name).split('/');
    S.folderName = parts.length > 1 ? parts[0] : '';
    vids.push(videoEntry(parts.length > 1 ? parts.slice(1).join('/') : f.name, async () => f));
  }
  vids.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  S.videos = vids;
  folderReady();
}
function folderReady() {
  const n = S.videos.length;
  $('#folderStatus').innerHTML = n ? `<span class="ok-text">✓ ${esc(S.folderName)}: ${n} video${n > 1 ? 's' : ''}</span>`
    : `<span class="err-text">no videos found in ${esc(S.folderName)}</span>`;
  $('#folderReopen').classList.add('hidden');
  updateSetupDone();
}

/* ------------------------------------------------------------------ setup flow */
async function init() {
  bindUI();
  applySettingsUI();
  Yolo.init();
  try { S.vocab = store.get('tl.vocab', null) || await (await fetch('labels.json')).json(); } catch { S.vocab = { tool: [], action: [], target: [] }; }
  renderPicker();
  if (Backend.cfg) { $('#sheetUrl').value = Backend.cfg.url; $('#sheetSecret').value = Backend.cfg.secret; }
  else if (CONFIG.secret) $('#sheetSecret').value = CONFIG.secret;

  // backend: a complete config.js connects to the sheet automatically and
  // reduces the "Google Sheet" setup step to a status line
  const embedded = !!(CONFIG.sheetUrl && CONFIG.secret);
  const mode = embedded ? 'sheet' : store.get('tl.mode', null);
  setSheetEmbedded(embedded);
  if (mode === 'sheet' && Backend.cfg) {
    $('#sheetStatus').textContent = 'connecting…';
    try { onConnected(await Backend.connect(Backend.cfg.url, Backend.cfg.secret)); }
    catch (e) {
      $('#sheetStatus').innerHTML = `<span class="err-text">${esc(e.message)}</span>`;
      setSheetEmbedded(false); // show the fields so the connection can be fixed or retried
    }
  } else if (mode === 'local') { Backend.useLocal(); onLocal(); }

  // folder
  const handle = await idb.get('dir');
  if (handle) {
    let perm = 'prompt';
    try { perm = await handle.queryPermission({ mode: 'read' }); } catch { }
    if (perm === 'granted') { try { await useFolderHandle(handle); } catch (e) { console.error(e); } }
    else {
      const b = $('#folderReopen'); b.textContent = `Reopen “${handle.name}”`; b.classList.remove('hidden');
      b.onclick = async () => {
        try {
          if (await handle.requestPermission({ mode: 'read' }) === 'granted') { await useFolderHandle(handle); maybeStart(); }
        } catch (e) { toast('Could not open folder: ' + e.message, 4000); }
      };
    }
  }
  if (!maybeStart()) openSetup();
}
function setSheetEmbedded(on) {
  $('#sheetSection').classList.toggle('embedded', on);
  $('#stepFolder').textContent = on ? '1' : '2';
  $('#stepModel').textContent = on ? '2' : '3';
}
function onConnected(j) {
  S.vocab = j.vocab;
  S.sheetIndex = {}; for (const v of j.videos || []) S.sheetIndex[v.video] = v;
  $('#sheetStatus').innerHTML = `<span class="ok-text">✓ connected to “${esc(j.title)}”</span>`;
  setSaveStatus('saved');
  renderPicker(); buildVideoSelect(); updateSetupDone();
}
function onLocal() {
  $('#sheetStatus').innerHTML = '<span class="muted">labels kept in this browser only (use Backup JSON)</span>';
  setSaveStatus('local'); updateSetupDone();
}
function updateSetupDone() { $('#setupDone').disabled = !(Backend.mode && S.videos.length); }
function openSetup() { $('#setup').classList.remove('hidden'); }
function maybeStart() {
  if (!(Backend.mode && S.videos.length)) return false;
  $('#setup').classList.add('hidden');
  buildVideoSelect();
  if (!S.video || !S.videos.find(v => v.id === S.video.id)) {
    const last = store.get('tl.lastVideo', null);
    const v = S.videos.find(x => x.id === last) || S.videos[0];
    openVideo(v.id);
  }
  return true;
}

function buildVideoSelect() {
  const sel = $('#videoSelect'); sel.innerHTML = '';
  const groups = {};
  for (const v of S.videos) (groups[v.patient] = groups[v.patient] || []).push(v);
  for (const [g, vs] of Object.entries(groups)) {
    const og = document.createElement('optgroup'); og.label = g;
    for (const v of vs) { const o = document.createElement('option'); o.value = v.id; o.textContent = videoLabel(v); og.appendChild(o); }
    sel.appendChild(og);
  }
  if (S.video) sel.value = S.video.id;
}
function videoLabel(v) {
  const ix = S.sheetIndex[v.id];
  if (Backend.mode === 'sheet') return ix ? `${v.name}  —  ${ix.n_segments || 0} seg · ${ix.labeled_pct || 0}%` : `${v.name}  —  not started`;
  const segs = store.get('tl.local.' + v.id, null);
  return segs ? `${v.name}  —  ${segs.length} seg` : v.name;
}

async function openVideo(id) {
  if (S.video) { await flushSave(); persistVideoState(); }
  if (S.playing) pause();
  const v = S.videos.find(x => x.id === id); if (!v) return;
  let file;
  try { file = await v.getFile(); } catch (e) { toast('Could not read ' + v.name + ': ' + e.message, 5000); return; }
  let meta = null;
  try { meta = await readMp4Meta(file); } catch (e) { console.warn('mp4 parse failed', e); }
  if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
  S.objectUrl = URL.createObjectURL(file);
  S.seekBusy = false;
  video.src = S.objectUrl;
  await once(video, 'loadedmetadata');
  if (!meta) {
    meta = { fps_num: DEFAULT_FPS[0], fps_den: DEFAULT_FPS[1], fps: DEFAULT_FPS[0] / DEFAULT_FPS[1], duration: video.duration };
    meta.n_frames = Math.floor(video.duration * meta.fps + 1e-6);
    toast('Could not read the frame rate from this file; assuming 29.97 fps', 5000);
  }
  meta.width = video.videoWidth; meta.height = video.videoHeight;
  v.meta = meta;
  S.video = v; S.fps = meta.fps; S.N = meta.n_frames;
  store.set('tl.lastVideo', id);
  $('#videoSelect').value = id;
  $('#vidInfo').textContent = `${meta.width}×${meta.height} · ${meta.fps.toFixed(3)} fps · ${meta.n_frames} frames · ${fmtTime(meta.duration)}${meta.vfr ? ' · variable frame rate!' : ''}`;

  // labels
  S.syncBlocked = false;
  let segs = [];
  const pending = store.get('tl.pending.' + id, null);
  try {
    segs = await Backend.load(id);
  } catch (e) {
    S.syncBlocked = true; // never overwrite the sheet with a partial copy
    toast('Could not load labels from the sheet: ' + e.message + '. Changes are kept in this browser; reload to retry.', 8000);
    setSaveStatus('blocked');
  }
  if (pending && pending.segments) {
    segs = pending.segments;
    toast(`Restored ${segs.length} segments with changes that hadn't reached the sheet yet`, 5000);
  }
  S.segments = segs.map(s => ({
    id: s.id || newId(), start_frame: +s.start_frame, end_frame: +s.end_frame, tool: s.tool, action: s.action,
    target: s.target, note: s.note || '', created: s.created || nowIso(), updated: s.updated || nowIso(),
  }));
  S.undo = []; S.redo = []; S.editId = null; S.stash = null;
  S.segCache.clear(); S.segPending.clear(); S.segErr = null;
  const st = store.get('tl.state.' + id, null);
  const lastEnd = S.segments.reduce((m, s) => Math.max(m, s.end_frame), -1);
  const ns = clamp(lastEnd + 1, 0, S.N - 1);
  S.draft = st && st.draft ? st.draft : { start: ns, end: Math.min(S.N - 1, ns + defLenFrames() - 1) };
  S.frame = clamp(st && st.frame != null ? st.frame : S.draft.start, 0, S.N - 1);
  resetPick();
  segmentsChanged(false);
  if (pending && !S.syncBlocked) scheduleSave();
  video.playbackRate = SPEEDS[settings.speedIdx];
  video.muted = settings.muted;
  resizeStage();
  fitView();
  seekFrame(S.frame);
  buildThumbs(S.objectUrl, id);
  renderAll();
}

function persistVideoState() {
  if (S.video) store.set('tl.state.' + S.video.id, { frame: S.frame, draft: S.editId && S.stash ? S.stash.draft : S.draft });
}

/* thumbnails: seek a hidden <video> through the file and draw small frames into a sprite canvas */
async function buildThumbs(url, id) {
  if (S.thumbJob) S.thumbJob.cancel = true;
  const job = { cancel: false }; S.thumbJob = job;
  const tw = 128, th = 72, cols = 25;
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = url;
  try { await once(v, 'loadedmetadata'); } catch { return; }
  const interval = Math.max(2, v.duration / 400); // seconds
  const n = Math.floor(v.duration / interval) + 1, rows = Math.ceil(n / cols);
  const canvas = document.createElement('canvas'); canvas.width = tw * cols; canvas.height = th * rows;
  const ctx = canvas.getContext('2d');
  S.thumbs = { w: tw, h: th, cols, frames: [], spacing: Math.round(interval * S.fps) };
  S.sprite = canvas; S.thumbStatus = '';
  for (let i = 0; i < n; i++) {
    while (S.playing && !job.cancel) await sleep(250); // don't compete with playback
    if (job.cancel || !S.video || S.video.id !== id) break;
    const f = Math.min(S.N - 1, Math.round(i * interval * S.fps));
    v.currentTime = (f + 0.5) / S.fps;
    await once(v, 'seeked');
    if (job.cancel) break;
    ctx.drawImage(v, (i % cols) * tw, Math.floor(i / cols) * th, tw, th);
    S.thumbs.frames.push(f);
    if (i % 8 === 0) requestRender();
  }
  v.removeAttribute('src'); v.load();
  requestRender();
}

/* ------------------------------------------------------------------ video / frames */
function seekFrame(f, opt = {}) {
  f = clamp(Math.round(f), 0, S.N - 1);
  S.frame = f; S.seekTarget = f;
  if (S.seekBusy && performance.now() - S.seekAt > 1500) S.seekBusy = false; // safety net
  if (!S.seekBusy) issueSeek();
  if (opt.reveal !== false) reveal(f);
  frameChanged();
}
function issueSeek() {
  S.seekBusy = true; S.seekIssued = S.seekTarget; S.seekAt = performance.now();
  video.currentTime = (S.seekIssued + 0.5) / S.fps;
}
video.addEventListener('seeked', () => {
  if (S.seekTarget !== S.seekIssued) { issueSeek(); return; }
  S.seekBusy = false;
  if (!S.playing) frameSettled();
});
video.addEventListener('ended', () => { S.playing = false; S.frame = S.N - 1; updatePlayBtn(); requestRender(); });

function frameChanged() { clearTimeout(S.dwell); drawOverlay(); requestRender(); }
function frameSettled() { drawOverlay(); scheduleSeg(); requestRender(); }

function play() {
  if (S.playing || !S.video) return;
  if (S.loop && (S.frame < S.draft.start || S.frame >= S.draft.end)) seekFrame(S.draft.start);
  if (S.frame >= S.N - 1) seekFrame(0);
  S.playing = true; clearTimeout(S.dwell); drawOverlay();
  video.play().catch(() => { S.playing = false; updatePlayBtn(); });
  tick(); updatePlayBtn();
}
function pause() {
  if (!S.playing) return;
  S.playing = false; video.pause();
  seekFrame(S.frame, { reveal: false }); // snap exactly to the frame that was on screen
  updatePlayBtn();
}
const togglePlay = () => (S.playing ? pause() : play());
function tick() {
  if (!S.playing) return;
  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback((now, md) => { onPlayFrame(Math.round(md.mediaTime * S.fps)); tick(); });
  } else {
    requestAnimationFrame(() => { onPlayFrame(Math.floor(video.currentTime * S.fps)); tick(); });
  }
}
function onPlayFrame(f) {
  if (!S.playing) return;
  f = clamp(f, 0, S.N - 1);
  if (S.loop && f > S.draft.end) { f = S.draft.start; video.currentTime = (f + 0.5) / S.fps; }
  S.frame = f;
  const vis = tlWidth() * S.view.fpp;
  if (f > S.view.start + vis * 0.95 || f < S.view.start) { S.view.start = f - vis * 0.1; clampView(); }
  requestRender();
}
function updatePlayBtn() { $('#playBtn').textContent = S.playing ? '❚❚' : '▶'; }
function stepBy(df) { seekFrame(S.frame + df); }

/* ------------------------------------------------------------------ segmentation */
function scheduleSeg() {
  clearTimeout(S.dwell);
  if (S.model.status !== 'ready' || S.playing || !S.video) return;
  if (S.segCache.has(S.frame) || S.segPending.has(S.frame)) return;
  if (!settings.auto && !S.segShow) return;
  const f = S.frame;
  S.dwell = setTimeout(() => runSeg(f), S.segShow ? 300 : 1000);
}
async function runSeg(f) {
  if (S.playing || S.seekBusy || video.seeking || S.frame !== f || S.model.status !== 'ready') return;
  if (S.segCache.has(f) || S.segPending.has(f) || !video.videoWidth) return;
  const vid = S.video.id, W0 = video.videoWidth, H0 = video.videoHeight;
  const [IH, IW] = Yolo.input, r = Math.min(IH / H0, IW / W0);
  S.segPending.add(f); requestRender();
  try {
    const bmp = await createImageBitmap(video, { resizeWidth: Math.round(W0 * r), resizeHeight: Math.round(H0 * r), resizeQuality: 'high' });
    const res = await Yolo.run(f, bmp, W0, H0, 0.05);
    if (!S.video || S.video.id !== vid) return;
    S.segCache.set(f, res); S.segErr = null;
    if (S.segCache.size > 300) S.segCache.delete(S.segCache.keys().next().value);
  } catch (e) {
    S.segErr = e.message; console.error(e);
  } finally {
    S.segPending.delete(f);
  }
  if (S.frame === f) drawOverlay();
  S.panelKey = ''; requestRender();
}
function toggleSeg() {
  S.segShow = !S.segShow;
  if (S.segShow && !S.playing && !S.segCache.has(S.frame)) {
    if (S.model.status !== 'ready') toast('YOLO model is still loading…');
    else { clearTimeout(S.dwell); runSeg(S.frame).then(() => { if (!S.segCache.has(S.frame)) scheduleSeg(); }); }
  }
  drawOverlay(); requestRender();
}

function resizeStage() {
  const wrap = $('#stageWrap').getBoundingClientRect();
  const ar = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
  let w = wrap.width, h = w / ar;
  if (h > wrap.height) { h = wrap.height; w = h * ar; }
  const st = $('#stage'); st.style.width = w + 'px'; st.style.height = h + 'px';
  const dpr = devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  drawOverlay();
}
let maskCanvas;
function drawOverlay() {
  const ctx = overlay.getContext('2d'), W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  if (!S.segShow || S.playing) return;
  const r = S.segCache.get(S.frame); if (!r) return;
  const dpr = devicePixelRatio || 1;
  const items = r.instances.filter(it => it.conf >= settings.conf && !settings.hidden.includes(it.name));
  // paint masks into a small grid image, then scale it onto the overlay
  const [MW, MH] = r.grid;
  maskCanvas = maskCanvas || document.createElement('canvas');
  if (maskCanvas.width !== MW || maskCanvas.height !== MH) { maskCanvas.width = MW; maskCanvas.height = MH; }
  const mctx = maskCanvas.getContext('2d');
  const img = mctx.createImageData(MW, MH), d = img.data;
  const fillA = Math.round(settings.opacity * 255);
  for (const it of [...items].reverse()) { // most confident painted last (on top)
    const m = it.mask; if (!m) continue;
    const [cr, cg, cb] = hexRgb(classColor(it.name));
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (!m.data[y * m.w + x]) continue;
      const edge = x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1 ||
        !m.data[y * m.w + x - 1] || !m.data[y * m.w + x + 1] || !m.data[(y - 1) * m.w + x] || !m.data[(y + 1) * m.w + x];
      const k = ((m.y + y) * MW + m.x + x) * 4;
      d[k] = cr; d[k + 1] = cg; d[k + 2] = cb; d[k + 3] = edge ? 255 : fillA;
    }
  }
  mctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskCanvas, 0, 0, W, H);
  for (const it of items) {
    if (it.mask) continue; // no mask: draw its box
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = classColor(it.name);
    ctx.strokeRect(it.box[0] * W, it.box[1] * H, (it.box[2] - it.box[0]) * W, (it.box[3] - it.box[1]) * H);
  }
  if (!settings.labels) return;
  ctx.font = `${12 * dpr}px ui-monospace, Menlo, monospace`; ctx.textBaseline = 'top';
  for (const it of items) {
    const txt = `${it.name} ${it.conf.toFixed(2)}`, tw = ctx.measureText(txt).width;
    const x = clamp(it.box[0] * W, 0, W - tw - 8 * dpr), y = clamp(it.box[1] * H, 0, H - 18 * dpr);
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x, y, tw + 8 * dpr, 17 * dpr);
    ctx.fillStyle = classColor(it.name); ctx.fillText(txt, x + 4 * dpr, y + 2 * dpr);
  }
}

/* ------------------------------------------------------------------ labeling */
function resetPick() { S.pick = { tool: null, action: null, target: null }; S.col = 0; S.note = ''; $('#note').value = ''; }
const firstMissing = () => COLS.findIndex(c => !S.pick[c]);

function choose(c, val) {
  const cat = COLS[c];
  S.pick[cat] = val;
  // Picking never saves: the segment is saved only with "Save segment" / Enter.
  if (S.editId) {
    updateEditing({ [cat]: val });
    S.col = Math.min(c + 1, 2);
  } else {
    const m = firstMissing();
    const after = COLS.findIndex((k, i) => i > c && !S.pick[k]);
    S.col = after >= 0 ? after : (m >= 0 ? m : c);
  }
  renderPicker();
}
function chooseIdx(i) {
  const vals = S.vocab[COLS[S.col]] || [];
  if (i < vals.length) choose(S.col, vals[i]);
}
function backspacePick() {
  if (S.editId) { S.col = Math.max(0, S.col - 1); renderPicker(); return; }
  const cat = COLS[S.col];
  if (S.pick[cat]) S.pick[cat] = null;
  else if (S.col > 0) { S.col--; S.pick[COLS[S.col]] = null; }
  renderPicker();
}

function commit() {
  if (S.editId) { finishEdit(); return; }
  const { tool, action, target } = S.pick;
  if (!tool || !action || !target) { S.col = Math.max(0, firstMissing()); renderPicker(); toast('Pick tool, action and target first'); return; }
  let { start, end } = S.draft; if (end < start) [start, end] = [end, start];
  pushUndo();
  const t = nowIso();
  S.segments.push({ id: newId(), start_frame: start, end_frame: end, tool, action, target, note: S.note.trim(), created: t, updated: t });
  S.last = { tool, action, target }; store.set('tl.last', S.last);
  segmentsChanged();
  toast(`Saved: ${tool} · ${action} · ${target}  (${fTime(start)}–${fEnd(end)})`);
  // advance IN/OUT to the next segment
  const ns = Math.min(end + 1, S.N - 1);
  let ne = Math.min(S.N - 1, ns + defLenFrames() - 1);
  const nextSeg = S.segments.filter(s => s.start_frame > ns).sort((a, b) => a.start_frame - b.start_frame)[0];
  if (nextSeg) ne = Math.max(ns, Math.min(ne, nextSeg.start_frame - 1));
  S.draft = { start: ns, end: ne };
  resetPick();
  seekFrame(ns);
  if (frameToX(ne + 1) > tlWidth()) { S.view.start = ns - tlWidth() * S.view.fpp * 0.2; clampView(); }
  renderPicker();
}
function repeatLast() {
  if (!S.last) { toast('No previous triplet yet'); return; }
  if (S.editId) { updateEditing({ ...S.last }); S.pick = { ...S.last }; renderPicker(); return; }
  S.pick = { ...S.last }; S.col = 2; renderPicker();
  toast('Filled with the last triplet. Press Save segment / Enter to save');
}

function editSegment(id) {
  const s = segById(id); if (!s) return;
  if (!S.editId) S.stash = { draft: { ...S.draft }, pick: { ...S.pick }, note: S.note, col: S.col };
  S.editId = id;
  S.draft = { start: s.start_frame, end: s.end_frame };
  S.pick = { tool: s.tool, action: s.action, target: s.target };
  S.note = s.note || ''; $('#note').value = S.note; S.col = 0;
  if (S.playing) pause();
  seekFrame(s.start_frame, { reveal: false });
  showRange(s.start_frame, s.end_frame);
  renderAll();
  const li = $(`#segList li[data-id="${id}"]`); if (li) li.scrollIntoView({ block: 'nearest' });
}
function finishEdit() {
  if (!S.editId) return;
  const s = segById(S.editId);
  if (s && S.note.trim() !== (s.note || '')) updateEditing({ note: S.note.trim() });
  S.editId = null;
  finishEditRestore();
  renderAll();
}
function finishEditRestore() {
  const st = S.stash; S.stash = null;
  if (st) { S.draft = st.draft; S.pick = st.pick; S.note = st.note; S.col = st.col; $('#note').value = S.note; }
}
function updateEditing(patch) {
  const s = segById(S.editId); if (!s) return;
  pushUndo();
  Object.assign(s, patch, { updated: nowIso() });
  if (s.start_frame > s.end_frame) [s.start_frame, s.end_frame] = [s.end_frame, s.start_frame];
  segmentsChanged();
}
function deleteSegment(id) {
  const s = segById(id); if (!s) return;
  pushUndo();
  S.segments = S.segments.filter(x => x.id !== id);
  if (S.editId === id) { S.editId = null; finishEditRestore(); }
  segmentsChanged(); renderAll();
  toast(`Deleted ${s.tool} · ${s.action} · ${s.target} (⌘/Ctrl+Z to undo)`);
}

function setIn() {
  const f = S.frame;
  S.draft.start = f;
  if (S.draft.end < f) S.draft.end = Math.min(S.N - 1, f + defLenFrames() - 1);
  afterDraftChange();
}
function setOut() {
  const f = S.frame;
  S.draft.end = f;
  if (S.draft.start > f) S.draft.start = f;
  afterDraftChange();
}
function afterDraftChange() {
  if (S.editId) updateEditing({ start_frame: S.draft.start, end_frame: S.draft.end });
  requestRender();
}
function nextGap() {
  const iv = S.segments.map(s => [s.start_frame, s.end_frame]).sort((a, b) => a[0] - b[0]);
  const covered = f => iv.find(([a, b]) => f >= a && f <= b);
  let f = 0, guard = 0;
  for (const startAt of [S.frame, 0]) { // search from the playhead; wrap around once
    f = startAt;
    while (f < S.N && guard++ < 100000) { const c = covered(f); if (!c) break; f = c[1] + 1; }
    if (f < S.N) break;
  }
  if (f >= S.N) { toast('No unlabeled frames left 🎉'); return; }
  const nxt = iv.find(([a]) => a > f);
  const gapEnd = nxt ? nxt[0] - 1 : S.N - 1;
  if (S.editId) finishEdit();
  S.draft = { start: f, end: Math.min(gapEnd, f + defLenFrames() - 1) };
  seekFrame(f);
  toast(`Unlabeled gap ${fTime(f)} – ${fEnd(gapEnd)} (${gapEnd - f + 1} frames)`);
}
function jumpBoundary(dir) {
  const b = new Set([0, S.N - 1, S.draft.start, S.draft.end + 1]);
  for (const s of S.segments) { b.add(s.start_frame); b.add(s.end_frame + 1); }
  const arr = [...b].filter(x => x >= 0 && x < S.N).sort((a, c) => a - c);
  const t = dir > 0 ? arr.find(x => x > S.frame) : [...arr].reverse().find(x => x < S.frame);
  if (t != null) seekFrame(t);
}
function goToPrompt() {
  const s = prompt('Go to frame number (e.g. 1234), time (e.g. 1:23.45) or seconds (e.g. 83.4s):');
  if (!s) return;
  const t = s.trim();
  let f;
  if (t.includes(':')) { let sec = 0; for (const p of t.split(':').map(Number)) sec = sec * 60 + p; f = Math.floor(sec * S.fps + 1e-6); }
  else if (/s$/i.test(t)) f = Math.floor(parseFloat(t) * S.fps + 1e-6);
  else f = parseInt(t, 10);
  if (Number.isFinite(f)) seekFrame(f); else toast('Could not parse ' + t);
}

/* undo / redo */
function pushUndo() { S.undo.push(JSON.stringify(S.segments)); if (S.undo.length > 300) S.undo.shift(); S.redo = []; }
function undo() {
  if (!S.undo.length) { toast('Nothing to undo'); return; }
  S.redo.push(JSON.stringify(S.segments)); S.segments = JSON.parse(S.undo.pop()); afterHistory(); toast('Undo');
}
function redo() {
  if (!S.redo.length) { toast('Nothing to redo'); return; }
  S.undo.push(JSON.stringify(S.segments)); S.segments = JSON.parse(S.redo.pop()); afterHistory(); toast('Redo');
}
function afterHistory() {
  if (S.editId) {
    const s = segById(S.editId);
    if (!s) { S.editId = null; finishEditRestore(); }
    else { S.draft = { start: s.start_frame, end: s.end_frame }; S.pick = { tool: s.tool, action: s.action, target: s.target }; }
  }
  segmentsChanged(); renderAll();
}

/* ------------------------------------------------------------------ saving */
function segmentsChanged(save = true) {
  const segs = sortedSegs();
  const ends = [], lane = new Map();
  for (const s of segs) {
    let i = ends.findIndex(e => e < s.start_frame);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = s.end_frame; lane.set(s.id, i);
  }
  S.layout = { lane, n: Math.max(2, ends.length) };
  renderList();
  requestRender();
  if (save) {
    // keep a copy in this browser until the sheet confirms it
    if (Backend.mode === 'sheet' && S.video) store.set('tl.pending.' + S.video.id, { segments: S.segments, t: Date.now() });
    scheduleSave();
  }
}
function coverage(segs = S.segments) {
  const iv = segs.map(s => [s.start_frame, s.end_frame]).sort((a, b) => a[0] - b[0]);
  let cov = 0, cur = null;
  for (const [a, b] of iv) {
    if (!cur || a > cur[1] + 1) { if (cur) cov += cur[1] - cur[0] + 1; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) cov += cur[1] - cur[0] + 1;
  return cov;
}
/** Segment rows as stored (frames are the truth; times are derived). */
function segRecords(segs, fps) {
  const ft = f => fmtTime(f / fps);
  return [...segs].sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame).map(s => ({
    id: s.id, tool: s.tool, action: s.action, target: s.target,
    start_frame: s.start_frame, end_frame: s.end_frame, n_frames: s.end_frame - s.start_frame + 1,
    start_time: ft(s.start_frame), end_time: ft(s.end_frame + 1),
    start_sec: +(s.start_frame / fps).toFixed(4), end_sec: +((s.end_frame + 1) / fps).toFixed(4),
    note: s.note || '', created: s.created, updated: s.updated,
  }));
}
function videoMeta(v, segs) {
  const m = v.meta;
  return {
    fps: m.fps, fps_rational: `${m.fps_num}/${m.fps_den}`, n_frames: m.n_frames, duration_sec: m.duration,
    width: m.width, height: m.height, labeled_frames: coverage(segs), n_segments: segs.length,
  };
}
function setSaveStatus(s) {
  const b = $('#saveBadge');
  const sheet = Backend.mode === 'sheet';
  b.className = 'badge ' + ({ saved: 'ok', local: 'ok', saving: 'warn', unsaved: 'warn', error: 'err', blocked: 'err' }[s] || '');
  b.textContent = {
    saved: sheet ? 'saved to sheet ✓' : 'saved in browser ✓', local: 'browser only', saving: 'saving…', unsaved: 'unsaved',
    error: 'sheet save failed, retrying', blocked: 'not syncing (kept in browser)',
  }[s];
}
function scheduleSave() {
  if (!S.video) return;
  S.dirty = true;
  if (S.syncBlocked) { setSaveStatus('blocked'); return; }
  setSaveStatus('unsaved');
  clearTimeout(S.saveTimer); S.saveTimer = setTimeout(doSave, Backend.mode === 'sheet' ? 1200 : 200);
}
async function doSave() {
  if (S.saving) { S.saveAgain = true; return; }
  if (!S.dirty || !S.video || S.syncBlocked) return;
  S.saving = true; S.dirty = false; setSaveStatus('saving');
  const v = S.video, segs = JSON.parse(JSON.stringify(S.segments));
  let failed = false;
  try {
    const meta = videoMeta(v, segs);
    await Backend.save(v.id, meta, segRecords(segs, v.meta.fps));
    if (Backend.mode === 'sheet') {
      const pend = store.get('tl.pending.' + v.id, null);
      if (pend && JSON.stringify(pend.segments) === JSON.stringify(segs)) store.del('tl.pending.' + v.id);
      S.sheetIndex[v.id] = Object.assign(S.sheetIndex[v.id] || {}, {
        n_segments: segs.length, labeled_pct: Math.round(1000 * meta.labeled_frames / meta.n_frames) / 10,
      });
    }
    const o = [...$('#videoSelect').options].find(x => x.value === v.id); if (o) o.textContent = videoLabel(v);
  } catch (e) {
    console.error(e); failed = true; S.dirty = true;
    toast('Saving failed: ' + e.message + '. Will retry; your changes are kept in this browser.', 4000);
  } finally {
    S.saving = false;
  }
  if (failed) { setSaveStatus('error'); clearTimeout(S.saveTimer); S.saveTimer = setTimeout(doSave, 5000); return; }
  if (S.saveAgain || S.dirty) { S.saveAgain = false; S.dirty = true; doSave(); return; }
  setSaveStatus('saved');
}
async function flushSave() {
  clearTimeout(S.saveTimer);
  if (S.dirty && !S.syncBlocked) await doSave();
  for (let i = 0; S.saving && i < 300; i++) await sleep(50);
}
window.addEventListener('beforeunload', e => {
  persistVideoState();
  if (S.dirty && Backend.mode === 'sheet') { e.preventDefault(); e.returnValue = ''; }
});
setInterval(persistVideoState, 5000);

function downloadBackup() {
  if (!S.video) return;
  const v = S.video, doc = {
    video: v.id, ...videoMeta(v, S.segments),
    convention: 'frames are 0-indexed; start_frame and end_frame are inclusive; start_sec = start_frame/fps; end_sec = (end_frame+1)/fps',
    exported: nowIso(), segments: segRecords(S.segments, v.meta.fps),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  a.download = v.id.replace(/\//g, '__').replace(/\.[^.]+$/, '') + '.labels.json';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------------ timeline geometry */
const tlWidth = () => tl.clientWidth || 800;
const frameToX = f => (f - S.view.start) / S.view.fpp;
const xToFrame = x => S.view.start + x * S.view.fpp;
const maxFpp = () => Math.max(MIN_FPP, S.N / tlWidth() * 1.05);
function clampView() {
  S.view.fpp = clamp(S.view.fpp, MIN_FPP, maxFpp());
  const vis = tlWidth() * S.view.fpp;
  S.view.start = clamp(S.view.start, -vis * 0.02, Math.max(-vis * 0.02, S.N - vis * 0.98));
}
function fitView() { S.view.fpp = S.N / (tlWidth() * 0.995); S.view.start = 0; clampView(); requestRender(); }
function showRange(a, b) {
  const len = b - a + 1, W = tlWidth();
  if (len / S.view.fpp > W * 0.9 || len / S.view.fpp < 30) S.view.fpp = clamp(len / (W * 0.6), MIN_FPP, maxFpp());
  S.view.start = (a + b) / 2 - W * S.view.fpp / 2; clampView(); requestRender();
}
function reveal(f) {
  const vis = tlWidth() * S.view.fpp;
  if (f < S.view.start || f > S.view.start + vis) { S.view.start = f - vis * 0.3; clampView(); }
}
function zoomBy(k, centerFrame) {
  const W = tlWidth(), c = centerFrame ?? S.frame, x = frameToX(c);
  S.view.fpp = clamp(S.view.fpp * k, MIN_FPP, maxFpp());
  S.view.start = c - (x >= 0 && x <= W ? x : W / 2) * S.view.fpp;
  clampView(); requestRender();
}
function nearestThumb(f) {
  const a = S.thumbs.frames; if (!a.length) return -1;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= f) lo = m; else hi = m - 1; }
  if (lo + 1 < a.length && Math.abs(a[lo + 1] - f) < Math.abs(a[lo] - f)) lo++;
  return Math.abs(a[lo] - f) <= S.thumbs.spacing * 1.5 ? lo : -1; // not built yet
}

/* ------------------------------------------------------------------ rendering */
function render() {
  if (!S.video) return;
  drawTimeline(); drawOverviewBar(); updateTransport(); updateSidePanels();
}
function renderAll() {
  document.body.classList.toggle('editing', !!S.editId);
  renderList(); renderPicker(); S.panelKey = ''; requestRender();
}

function drawTimeline() {
  const dpr = devicePixelRatio || 1, W = tlWidth();
  const laneTop = TL.RULER + TL.TH + TL.GAP;
  const H = laneTop + S.layout.n * (TL.LANE + TL.LGAP) + 4;
  if (tl.width !== Math.round(W * dpr) || tl.height !== Math.round(H * dpr)) {
    tl.width = Math.round(W * dpr); tl.height = Math.round(H * dpr); tl.style.height = H + 'px';
  }
  const ctx = tl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#12151b'; ctx.fillRect(0, 0, W, H);
  const fpp = S.view.fpp, ppf = 1 / fpp;
  const x0 = frameToX(0), xN = frameToX(S.N);

  ctx.fillStyle = '#0a0b0e';
  if (x0 > 0) ctx.fillRect(0, 0, x0, H);
  if (xN < W) ctx.fillRect(xN, 0, W - xN, H);

  // ruler: whole frames when zoomed in, whole seconds otherwise
  ctx.fillStyle = '#1a1e26'; ctx.fillRect(Math.max(0, x0), 0, Math.min(W, xN) - Math.max(0, x0), TL.RULER);
  const cands = [1, 2, 5, 10, 15].map(f => ({ f, fr: true }))
    .concat([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200].map(s => ({ f: s * S.fps, sec: s, fr: false })));
  const tick = cands.find(c => c.f * ppf >= (c.fr ? 120 : 70)) || cands[cands.length - 1];
  ctx.font = '10.5px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top';
  const k0 = Math.max(0, Math.floor(S.view.start / tick.f));
  for (let k = k0; ; k++) {
    const fx = k * tick.f, x = Math.round(frameToX(fx)) + 0.5;
    if (x > W || fx > S.N) break;
    ctx.strokeStyle = '#4a5160'; ctx.beginPath(); ctx.moveTo(x, TL.RULER - 8); ctx.lineTo(x, TL.RULER); ctx.stroke();
    for (let m = 1; m < 5; m++) {
      const xm = Math.round(frameToX(fx + m * tick.f / 5)) + 0.5;
      ctx.strokeStyle = '#2f3542'; ctx.beginPath(); ctx.moveTo(xm, TL.RULER - 4); ctx.lineTo(xm, TL.RULER); ctx.stroke();
    }
    ctx.fillStyle = '#8b93a3';
    ctx.fillText(tick.fr ? `f${fx} ${fTime(fx)}` : fmtTime(k * tick.sec).replace(/\.00$/, ''), x + 3, 3);
  }

  // thumbnails
  const ty = TL.RULER, th = TL.TH;
  ctx.save(); ctx.beginPath(); ctx.rect(Math.max(0, x0), ty, Math.min(W, xN) - Math.max(0, x0), th); ctx.clip();
  ctx.fillStyle = '#1b1f27'; ctx.fillRect(0, ty, W, th);
  if (S.sprite && S.thumbs && S.thumbs.frames.length) {
    const tw = th * S.thumbs.w / S.thumbs.h, df = tw * fpp;
    for (let k = Math.floor(S.view.start / df); ; k++) {
      const f = k * df, x = frameToX(f);
      if (x > W) break;
      if (f + df < 0 || f > S.N) continue;
      const ti = nearestThumb(f + df / 2), cols = S.thumbs.cols;
      if (ti < 0) continue;
      ctx.drawImage(S.sprite, (ti % cols) * S.thumbs.w, Math.floor(ti / cols) * S.thumbs.h, S.thumbs.w, S.thumbs.h, x, ty, tw + 0.5, th);
    }
  } else {
    ctx.fillStyle = '#6b7383'; ctx.font = '12px system-ui'; ctx.textBaseline = 'middle';
    ctx.fillText(S.thumbStatus || 'building thumbnails…', Math.max(8, x0 + 8), ty + th / 2);
  }
  ctx.restore();

  // segment lanes
  ctx.textBaseline = 'middle'; ctx.font = '11px system-ui, sans-serif';
  for (const s of S.segments) {
    const xa = frameToX(s.start_frame), xb = frameToX(s.end_frame + 1);
    if (xb < 0 || xa > W) continue;
    const lane = S.layout.lane.get(s.id) || 0, y = laneTop + lane * (TL.LANE + TL.LGAP);
    const w = Math.max(2, xb - xa), sel = s.id === S.editId;
    ctx.fillStyle = toolColor(s.tool); ctx.globalAlpha = sel ? 1 : 0.85;
    ctx.fillRect(xa, y, w, TL.LANE); ctx.globalAlpha = 1;
    if (sel) { ctx.lineWidth = 2; ctx.strokeStyle = '#f5b942'; ctx.strokeRect(xa + 1, y + 1, w - 2, TL.LANE - 2); }
    else { ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.strokeRect(xa + 0.5, y + 0.5, w - 1, TL.LANE - 1); }
    if (w > 30) {
      ctx.save(); ctx.beginPath(); ctx.rect(xa + 3, y, w - 6, TL.LANE); ctx.clip();
      ctx.fillStyle = '#0b0d12'; ctx.fillText(`${s.tool} · ${s.action} · ${s.target}`, Math.max(xa + 4, 4), y + TL.LANE / 2 + 0.5);
      ctx.restore();
    }
  }

  // draft IN/OUT region
  const xs = frameToX(S.draft.start), xe = frameToX(S.draft.end + 1), editing = !!S.editId;
  ctx.fillStyle = editing ? 'rgba(245,185,66,.14)' : 'rgba(76,159,254,.16)';
  ctx.fillRect(xs, TL.RULER, xe - xs, H - TL.RULER);
  drawBar(ctx, xs, H, editing ? '#f5b942' : '#2ecc71', 'IN', true);
  drawBar(ctx, xe, H, editing ? '#f5b942' : '#ff5c5c', 'OUT', false);

  // hover
  if (S.hover != null && !S.drag) {
    const hf = clamp(Math.floor(xToFrame(S.hover)), 0, S.N - 1);
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.moveTo(S.hover + 0.5, TL.RULER); ctx.lineTo(S.hover + 0.5, H); ctx.stroke();
    const txt = `${fTime(hf)}  f${hf}`; ctx.font = '10.5px ui-monospace, Menlo, monospace';
    const w = ctx.measureText(txt).width + 8, bx = clamp(S.hover + 6, 0, W - w);
    ctx.fillStyle = 'rgba(20,23,30,.92)'; ctx.fillRect(bx, TL.RULER + 2, w, 15);
    ctx.fillStyle = '#cfd5df'; ctx.textBaseline = 'top'; ctx.fillText(txt, bx + 4, TL.RULER + 4);
  }

  // playhead (centered on the frame cell when zoomed in)
  const px = Math.round(frameToX(S.frame) + (ppf > 3 ? ppf / 2 : 0)) + 0.5;
  if (ppf > 3) { ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(frameToX(S.frame), TL.RULER, ppf, H); }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 1;
}
function drawBar(ctx, x, H, col, label, isIn) {
  x = Math.round(x) + 0.5;
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, TL.RULER); ctx.lineTo(x, H); ctx.stroke(); ctx.lineWidth = 1;
  ctx.font = 'bold 10px system-ui'; const w = ctx.measureText(label).width + 8;
  const bx = isIn ? x : x - w;
  ctx.fillStyle = col; ctx.fillRect(bx, TL.RULER, w, 14);
  ctx.fillStyle = '#0b0d12'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + 4, TL.RULER + 7.5);
}
function drawOverviewBar() {
  const dpr = devicePixelRatio || 1, W = ov.clientWidth || 800, H = 14;
  if (ov.width !== Math.round(W * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
  const ctx = ov.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1b1f27'; ctx.fillRect(0, 0, W, H);
  const k = W / S.N;
  for (const s of S.segments) { ctx.fillStyle = toolColor(s.tool); ctx.fillRect(s.start_frame * k, 3, Math.max(1, (s.end_frame - s.start_frame + 1) * k), H - 6); }
  ctx.fillStyle = S.editId ? 'rgba(245,185,66,.5)' : 'rgba(76,159,254,.55)';
  ctx.fillRect(S.draft.start * k, 0, Math.max(2, (S.draft.end - S.draft.start + 1) * k), 3);
  const vs = S.view.start * k, vw = tlWidth() * S.view.fpp * k;
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.strokeRect(vs + 0.5, 0.5, Math.max(3, vw) - 1, H - 1);
  ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(S.frame * k), 0, 1.5, H);
}

function updateTransport() {
  $('#frameText').textContent = `f ${S.frame} / ${S.N - 1}   ${fTime(S.frame)} / ${fmtTime(S.N / S.fps)}`;
  $('#stepText').textContent = STEPS[settings.stepIdx].l;
  $('#speedText').textContent = SPEEDS[settings.speedIdx] + '×';
  $('#loopBtn').classList.toggle('on', S.loop);
  $('#muteBtn').textContent = settings.muted ? '🔇' : '🔊';
  const d = S.draft, n = d.end - d.start + 1;
  $('#draftText').textContent = `${fTime(d.start)} → ${fEnd(d.end)}  (f${d.start}–f${d.end}, ${n} fr, ${(n / S.fps).toFixed(2)} s)`;
  $('#draftInfo').textContent = `f${d.start}–f${d.end}`;
  const vis = tlWidth() * S.view.fpp;
  $('#zoomText').textContent = `window ${fmtTime(vis / S.fps)} · ${(1 / S.view.fpp).toFixed(S.view.fpp > 1 ? 2 : 1)} px/frame`;
  const hud = [`<span>f ${S.frame} · ${fTime(S.frame)}</span>`];
  if (S.segShow) hud.push('<span class="seg-on">SEG</span>');
  if (S.segPending.has(S.frame)) hud.push('<span class="busy">segmenting…</span>');
  if (S.editId) hud.push('<span class="busy">editing</span>');
  if (S.loop) hud.push('<span>loop</span>');
  const h = hud.join('');
  if (h !== S.hudHtml) { $('#hud').innerHTML = h; S.hudHtml = h; }
  const cur = S.segments.filter(s => S.frame >= s.start_frame && S.frame <= s.end_frame).map(s => s.id).join(',');
  if (cur !== S.curKey) {
    S.curKey = cur; const set = new Set(cur.split(','));
    for (const li of document.querySelectorAll('#segList li')) li.classList.toggle('cur', set.has(li.dataset.id));
  }
}

function updateSidePanels() {
  const r = S.segCache.get(S.frame), pend = S.segPending.has(S.frame);
  const key = [S.frame, !!r, pend, S.model.status, S.model.text, S.segErr, settings.conf, settings.hidden.join('|'), S.col, S.editId].join(';');
  if (key === S.panelKey) return;
  S.panelKey = key;
  let st;
  if (S.model.status !== 'ready') st = S.model.status.startsWith('error') ? 'model error' : (S.model.text || 'model loading…');
  else if (pend) st = 'segmenting…';
  else if (r) st = `${r.instances.filter(i => i.conf >= settings.conf).length} objects · ${r.ms} ms`;
  else if (S.segErr) st = 'error: ' + S.segErr;
  else st = settings.auto ? 'waits 1 s on a frame' : 'press Space';
  $('#segStatus').textContent = st;
  const names = Object.values(S.model.classes || {});
  const det = {};
  if (r) for (const it of r.instances) if (it.conf >= settings.conf) {
    const d = det[it.name] || (det[it.name] = { n: 0, c: 0 }); d.n++; d.c = Math.max(d.c, it.conf);
  }
  $('#classList').innerHTML = names.map(n => {
    const d = det[n], off = settings.hidden.includes(n);
    return `<div class="cls ${off ? 'off' : ''} ${d ? 'det' : ''}" data-name="${esc(n)}" title="click to show/hide">
      <span class="sw" style="background:${classColor(n)}"></span>${esc(n)}<span class="n">${d ? (d.n > 1 ? d.n + '× ' : '') + d.c.toFixed(2) : '–'}</span></div>`;
  }).join('');
  S.suggest = {};
  for (const [n, d] of Object.entries(det)) S.suggest[n.toLowerCase()] = d.c;
  renderPicker();
}

function renderPicker() {
  document.body.classList.toggle('editing', !!S.editId);
  $('#modeTitle').textContent = S.editId ? `Editing segment #${segIndex(S.editId) + 1}` : 'New segment';
  COLS.forEach((cat, c) => {
    const col = $('#col-' + cat);
    col.classList.toggle('active', S.col === c);
    const vals = S.vocab[cat] || [];
    col.querySelector('.opts').innerHTML = vals.map((v, i) => {
      const k = i < 9 ? i + 1 : i === 9 ? 0 : '';
      const sug = cat === 'target' && S.suggest && S.suggest[v.toLowerCase()] != null
        ? `<span class="sug" title="detected by YOLO in this frame">${S.suggest[v.toLowerCase()].toFixed(2)}</span>` : '';
      return `<button class="opt ${S.pick[cat] === v ? 'sel' : ''}" data-c="${c}" data-i="${i}" title="${esc(v)}">
        <span class="k">${S.col === c ? k : ''}</span><span class="t">${esc(v)}</span>${sug}</button>`;
    }).join('') + `<button class="opt add" data-add="${cat}" title="Add a new ${cat}">+ add</button>`;
  });
  $('#lastText').textContent = S.last ? `last: ${S.last.tool} · ${S.last.action} · ${S.last.target}` : '';
}
const sortedSegs = () => [...S.segments].sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame);
const segIndex = id => sortedSegs().findIndex(s => s.id === id);

function renderList() {
  const q = $('#filter').value.trim().toLowerCase();
  const html = [];
  sortedSegs().forEach((s, i) => {
    if (q && !`${s.tool} ${s.action} ${s.target} ${s.note || ''}`.toLowerCase().includes(q)) return;
    const n = s.end_frame - s.start_frame + 1;
    html.push(`<li data-id="${s.id}" class="${s.id === S.editId ? 'sel' : ''}" style="--c:${toolColor(s.tool)}">
      <div class="trip"><span class="idx">#${i + 1}</span>${esc(s.tool)} · ${esc(s.action)} · ${esc(s.target)}</div>
      <div class="rng mono">${fTime(s.start_frame)} – ${fEnd(s.end_frame)} · f${s.start_frame}–${s.end_frame} · ${(n / S.fps).toFixed(1)}s</div>
      ${s.note ? `<div class="nt">${esc(s.note)}</div>` : ''}
      <button class="del" data-del="${s.id}" title="Delete">✕</button></li>`);
  });
  $('#segList').innerHTML = html.join('');
  $('#listEmpty').classList.toggle('hidden', S.segments.length > 0);
  $('#segStats').textContent = `${S.segments.length} · ${S.N ? (100 * coverage() / S.N).toFixed(1) : 0}% labeled`;
  S.curKey = '';
}

function applySettingsUI() {
  $('#confRange').value = settings.conf; $('#confVal').textContent = (+settings.conf).toFixed(2);
  $('#opRange').value = settings.opacity; $('#opVal').textContent = (+settings.opacity).toFixed(2);
  $('#autoChk').checked = settings.auto; $('#labelsChk').checked = settings.labels;
  $('#defLen').value = settings.defLen;
}

/* ------------------------------------------------------------------ UI bindings */
function bindUI() {
  // setup dialog
  $('#setupBtn').onclick = openSetup;
  $('#sheetConnect').onclick = async () => {
    const url = $('#sheetUrl').value.trim(), secret = $('#sheetSecret').value;
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { $('#sheetStatus').innerHTML = '<span class="err-text">That does not look like an Apps Script web app URL</span>'; return; }
    $('#sheetStatus').textContent = 'connecting…';
    try {
      const prevMode = Backend.mode;
      onConnected(await Backend.connect(url, secret));
      if (prevMode !== 'sheet' && S.video) { const id = S.video.id; S.video = null; openVideo(id); }
    } catch (e) { $('#sheetStatus').innerHTML = `<span class="err-text">${esc(e.message)}</span>`; }
  };
  $('#sheetLocal').onclick = () => { Backend.useLocal(); onLocal(); };
  $('#folderPick').onclick = async () => {
    if (!window.showDirectoryPicker) { $('#folderInput').click(); return; }
    try { await useFolderHandle(await window.showDirectoryPicker({ id: 'videos', mode: 'read' })); }
    catch (e) { if (e.name !== 'AbortError') toast('Could not open folder: ' + e.message, 4000); }
  };
  $('#folderInput').addEventListener('change', e => useFileList(e.target.files));
  $('#setupDone').onclick = () => { if (!maybeStart()) toast('Connect a sheet (or choose browser-only) and choose a folder first'); };
  $('#backupBtn').onclick = downloadBackup;

  $('#videoSelect').addEventListener('change', e => { e.target.blur(); openVideo(e.target.value); });
  const moveVid = d => {
    const i = S.videos.findIndex(v => v.id === S.video?.id);
    const n = S.videos[i + d]; if (n) openVideo(n.id);
  };
  $('#prevVid').onclick = () => moveVid(-1);
  $('#nextVid').onclick = () => moveVid(1);
  $('#helpBtn').onclick = () => $('#help').classList.remove('hidden');
  $('#helpClose').onclick = () => $('#help').classList.add('hidden');
  $('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').classList.add('hidden'); });

  $('#playBtn').onclick = togglePlay;
  $('#backBtn').onclick = () => stepBy(-stepFrames());
  $('#fwdBtn').onclick = () => stepBy(stepFrames());
  $('#stepDown').onclick = () => changeStep(-1);
  $('#stepUp').onclick = () => changeStep(1);
  $('#speedDown').onclick = () => changeSpeed(-1);
  $('#speedUp').onclick = () => changeSpeed(1);
  $('#loopBtn').onclick = toggleLoop;
  $('#muteBtn').onclick = toggleMute;
  $('#inBtn').onclick = setIn;
  $('#outBtn').onclick = setOut;
  $('#commitBtn').onclick = commit;
  $('#repeatBtn').onclick = repeatLast;
  $('#doneBtn').onclick = finishEdit;
  $('#deleteBtn').onclick = () => S.editId && deleteSegment(S.editId);
  $('#zoomIn').onclick = () => zoomBy(0.5);
  $('#zoomOut').onclick = () => zoomBy(2);
  $('#zoomFit').onclick = fitView;
  $('#zoomSel').onclick = () => showRange(S.draft.start, S.draft.end);

  $('#picker').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.add) {
      const cat = b.dataset.add, val = prompt(`New ${cat} name:`);
      if (!val || !val.trim()) return;
      try { S.vocab = await Backend.addVocab(cat, val.trim()); renderPicker(); toast(`Added ${cat}: ${val.trim()}`); }
      catch (err) { toast('Could not add: ' + err.message); }
      return;
    }
    const c = +b.dataset.c; S.col = c; choose(c, S.vocab[COLS[c]][+b.dataset.i]);
  });
  $('#note').addEventListener('input', e => { S.note = e.target.value; });
  $('#note').addEventListener('change', e => { if (S.editId) updateEditing({ note: e.target.value.trim() }); });

  $('#segList').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteSegment(del.dataset.del); return; }
    const li = e.target.closest('li'); if (li) editSegment(li.dataset.id);
  });
  $('#filter').addEventListener('input', renderList);

  $('#classList').addEventListener('click', e => {
    const el = e.target.closest('.cls'); if (!el) return;
    const n = el.dataset.name, i = settings.hidden.indexOf(n);
    if (i >= 0) settings.hidden.splice(i, 1); else settings.hidden.push(n);
    saveSettings(); S.panelKey = ''; drawOverlay(); requestRender();
  });
  $('#confRange').addEventListener('input', e => { settings.conf = +e.target.value; $('#confVal').textContent = settings.conf.toFixed(2); saveSettings(); drawOverlay(); requestRender(); });
  $('#opRange').addEventListener('input', e => { settings.opacity = +e.target.value; $('#opVal').textContent = settings.opacity.toFixed(2); saveSettings(); drawOverlay(); });
  $('#autoChk').addEventListener('change', e => { settings.auto = e.target.checked; saveSettings(); S.panelKey = ''; requestRender(); if (settings.auto) scheduleSeg(); });
  $('#labelsChk').addEventListener('change', e => { settings.labels = e.target.checked; saveSettings(); drawOverlay(); });
  $('#defLen').addEventListener('change', e => { settings.defLen = Math.max(0.1, +e.target.value || 5); saveSettings(); });

  // drop focus from buttons / sliders after use so Space & arrows keep driving the labeler
  document.addEventListener('click', e => { const b = e.target.closest('button, input[type=checkbox]'); if (b) b.blur(); });
  for (const r of document.querySelectorAll('input[type=range]')) r.addEventListener('change', () => r.blur());

  window.addEventListener('keydown', onKey);
  new ResizeObserver(() => { resizeStage(); clampView(); requestRender(); }).observe($('#stageWrap'));
  new ResizeObserver(() => { clampView(); requestRender(); }).observe(tl);
  bindTimeline();
}

function changeStep(d) { settings.stepIdx = clamp(settings.stepIdx + d, 0, STEPS.length - 1); saveSettings(); toast('Step: ' + STEPS[settings.stepIdx].l, 900); requestRender(); }
function changeSpeed(d) {
  settings.speedIdx = clamp(settings.speedIdx + d, 0, SPEEDS.length - 1); saveSettings();
  video.playbackRate = SPEEDS[settings.speedIdx]; toast('Speed: ' + SPEEDS[settings.speedIdx] + '×', 900); requestRender();
}
function toggleLoop() { S.loop = !S.loop; toast(S.loop ? 'Loop IN–OUT on' : 'Loop off', 900); requestRender(); }
function toggleMute() { settings.muted = !settings.muted; video.muted = settings.muted; saveSettings(); requestRender(); }

function onKey(e) {
  const t = e.target, tag = t.tagName;
  const typing = (tag === 'INPUT' && !['range', 'checkbox'].includes(t.type)) || tag === 'TEXTAREA' || tag === 'SELECT';
  if (typing) {
    if (e.key === 'Escape' || (e.key === 'Enter' && t.id !== 'filter')) { t.blur(); e.preventDefault(); }
    return;
  }
  if (tag === 'INPUT') t.blur();
  if (!$('#setup').classList.contains('hidden')) return;
  const help = $('#help');
  if (!help.classList.contains('hidden')) { if (e.key === 'Escape' || e.key === '?') help.classList.add('hidden'); return; }
  if (!S.video) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (mod) {
    if (k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (k.toLowerCase() === 's') { e.preventDefault(); flushSave().then(() => toast('Saved')); }
    return;
  }
  let handled = true;
  switch (k) {
    case 'p': case 'P': if (!e.repeat) togglePlay(); break;
    case ' ': if (!e.repeat) toggleSeg(); break;
    case 'ArrowLeft': stepBy(e.shiftKey ? -1 : -stepFrames()); break;
    case 'ArrowRight': stepBy(e.shiftKey ? 1 : stepFrames()); break;
    case 'ArrowUp': jumpBoundary(-1); break;
    case 'ArrowDown': jumpBoundary(1); break;
    case ',': case '<': stepBy(-1); break;
    case '.': case '>': stepBy(1); break;
    case '[': changeStep(-1); break;
    case ']': changeStep(1); break;
    case '-': case '_': changeSpeed(-1); break;
    case '=': case '+': changeSpeed(1); break;
    case 'i': setIn(); break;
    case 'o': setOut(); break;
    case 'I': seekFrame(S.draft.start); break;
    case 'O': seekFrame(S.draft.end); break;
    case 'Tab': S.col = (S.col + (e.shiftKey ? 2 : 1)) % 3; renderPicker(); break;
    case 'Backspace': case 'Delete':
      // Delete (the Mac ⌫ key is "Backspace") removes the selected segment;
      // with no segment selected, Backspace clears the last triplet pick.
      if (S.editId) deleteSegment(S.editId);
      else if (k === 'Delete' || e.shiftKey) toast('Click a segment first to delete it');
      else backspacePick();
      break;
    case 'Enter': commit(); break;
    case 'Escape': if (S.editId) finishEdit(); else { resetPick(); renderPicker(); } break;
    case 'r': case 'R': repeatLast(); break;
    case 'l': case 'L': toggleLoop(); break;
    case 'n': case 'N': nextGap(); break;
    case 'g': case 'G': goToPrompt(); break;
    case 'm': case 'M': toggleMute(); break;
    case 'z': showRange(S.draft.start, S.draft.end); break;
    case 'Z': fitView(); break;
    case '?': case 'h': case 'H': help.classList.remove('hidden'); break;
    default:
      if (/^[0-9]$/.test(k)) chooseIdx(k === '0' ? 9 : +k - 1);
      else handled = false;
  }
  if (handled) e.preventDefault();
}

function bindTimeline() {
  const pos = e => { const r = tl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const laneTop = () => TL.RULER + TL.TH + TL.GAP;
  const hitSeg = (x, y) => {
    const lane = Math.floor((y - laneTop()) / (TL.LANE + TL.LGAP));
    const f = xToFrame(x), tol = 3 * S.view.fpp;
    return S.segments.find(s => (S.layout.lane.get(s.id) || 0) === lane && f >= s.start_frame - tol && f <= s.end_frame + 1 + tol);
  };
  const barAt = x => {
    const ds = Math.abs(x - frameToX(S.draft.start)), de = Math.abs(x - frameToX(S.draft.end + 1));
    if (Math.min(ds, de) > 7) return null;
    return ds <= de ? 'start' : 'end';
  };
  tl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !S.video) return;
    const { x, y } = pos(e);
    let mode = barAt(x);
    if (!mode) {
      if (y >= laneTop()) { const s = hitSeg(x, y); if (s) { editSegment(s.id); return; } }
      mode = 'scrub';
    }
    if (S.playing) pause();
    tl.setPointerCapture(e.pointerId);
    S.drag = { mode, orig: { ...S.draft } };
    dragTo(x);
  });
  tl.addEventListener('pointermove', e => {
    if (!S.video) return;
    const { x, y } = pos(e);
    S.hover = x;
    if (S.drag) dragTo(x);
    else tl.style.cursor = barAt(x) ? 'ew-resize' : (y >= laneTop() && hitSeg(x, y) ? 'pointer' : 'crosshair');
    requestRender();
  });
  const end = () => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    if (d.mode !== 'scrub' && S.editId && (d.orig.start !== S.draft.start || d.orig.end !== S.draft.end))
      updateEditing({ start_frame: S.draft.start, end_frame: S.draft.end });
    requestRender();
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);
  tl.addEventListener('pointerleave', () => { S.hover = null; requestRender(); });
  tl.addEventListener('wheel', e => {
    e.preventDefault();
    if (!S.video) return;
    const { x } = pos(e);
    if (e.ctrlKey || e.metaKey) {
      const f = xToFrame(x);
      S.view.fpp = clamp(S.view.fpp * Math.exp(clamp(e.deltaY, -60, 60) * 0.01), MIN_FPP, maxFpp());
      S.view.start = f - x * S.view.fpp;
    } else {
      S.view.start += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * S.view.fpp;
    }
    clampView(); requestRender();
  }, { passive: false });

  function dragTo(x) {
    const W = tlWidth();
    if (x > W - 12) { S.view.start += 12 * S.view.fpp; clampView(); }
    if (x < 12) { S.view.start -= 12 * S.view.fpp; clampView(); }
    const f = xToFrame(x), d = S.drag;
    if (d.mode === 'start') {
      S.draft.start = clamp(Math.floor(f), 0, S.draft.end);
      seekFrame(S.draft.start, { reveal: false });
    } else if (d.mode === 'end') {
      S.draft.end = clamp(Math.round(f) - 1, S.draft.start, S.N - 1);
      seekFrame(S.draft.end, { reveal: false });
    } else {
      seekFrame(Math.floor(f), { reveal: false });
    }
  }

  let ovDrag = false;
  const ovMove = e => {
    const r = ov.getBoundingClientRect(), f = (e.clientX - r.left) / r.width * S.N;
    S.view.start = f - tlWidth() * S.view.fpp / 2; clampView(); seekFrame(f, { reveal: false });
  };
  ov.addEventListener('pointerdown', e => { if (!S.video) return; ovDrag = true; ov.setPointerCapture(e.pointerId); if (S.playing) pause(); ovMove(e); });
  ov.addEventListener('pointermove', e => { if (ovDrag) ovMove(e); });
  ov.addEventListener('pointerup', () => { ovDrag = false; });
}

init().catch(e => { console.error(e); toast('Failed to start: ' + e.message, 8000); });
