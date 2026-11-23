/**
 * @OnlyCurrentDoc
 * (Limits this script's access to the one spreadsheet it is attached to, instead of all your sheets.)
 *
 * Triplet Labeler: Google Sheets backend (Google Apps Script web app).
 *
 * Setup (once):
 *   1. Create a Google Sheet (personal Gmail account), then Extensions → Apps Script.
 *   2. Replace the default code with this file. Change SECRET below to a long random password.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as: Me      Who has access: Anyone
 *      Copy the Web app URL (ends in /exec).
 *   4. In the labeler, open Setup and paste the URL and the SECRET.
 *
 * After editing this code, publish the change with Deploy → Manage deployments → edit (pencil) →
 * Version: New version. That keeps the same URL.
 *
 * Sheet layout
 *   _videos : one row per video (progress overview)
 *   _vocab  : the tool / action / target lists (edit freely; one value per cell)
 *   <video> : one tab per video, one row per labeled segment
 */
const SECRET = 'p983n4fppy3ngwnhlieghc3p48u9cmyw348ywpm34tw34h'; // must match config.js

const DEFAULT_VOCAB = {
  tool: ['forceps', 'long tip forceps', 'scissors', 'needle driver', 'robotic retractor', 'electrocautery'],
  action: ['grasp', 'retract', 'suture', 'dissect', 'mobilize', 'clamp'],
  target: ['aorta', 'pericardium', 'right atrium', 'lung', 'diaphragm', 'coronary cusp'],
};
const SEG_HEADERS = ['segment_id', 'tool', 'action', 'target', 'start_frame', 'end_frame', 'n_frames',
  'start_time', 'end_time', 'start_sec', 'end_sec', 'note', 'created', 'updated'];
const TEXT_COLS = ['segment_id', 'tool', 'action', 'target', 'start_time', 'end_time', 'note', 'created', 'updated'];
const INDEX_HEADERS = ['video', 'tab', 'n_segments', 'labeled_frames', 'labeled_pct', 'n_frames', 'fps',
  'fps_rational', 'duration_sec', 'width', 'height', 'updated'];
const INDEX = '_videos', VOCAB = '_vocab';

function doGet() {
  return json_({ ok: true, message: 'Triplet labeler endpoint is running. The app talks to it with POST.' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad request' }); }
  if (req.secret !== SECRET) return json_({ error: 'wrong secret' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    switch (req.action) {
      case 'ping': return json_({ ok: true, title: ss_().getName(), vocab: getVocab_(), videos: listVideos_() });
      case 'load': return json_(Object.assign({ ok: true }, loadVideo_(req.video)));
      case 'save': return json_(Object.assign({ ok: true }, saveVideo_(req.video, req.meta || {}, req.segments || [])));
      case 'addVocab': return json_({ ok: true, vocab: addVocab_(req.category, req.value) });
      default: return json_({ error: 'unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------- helpers */
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function nowIso_() { return new Date().toISOString().slice(0, 19) + 'Z'; }

function sheet_(name, headers) {
  let sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    if (headers) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function readTable_(sh) {
  const last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 1 || cols < 1) return { headers: [], rows: [] };
  const v = sh.getRange(1, 1, last, cols).getValues();
  return { headers: v[0].map(String), rows: v.slice(1) };
}

/** Sheet tab names can't contain : \ / ? * [ ] and are limited to 100 characters. */
function tabName_(video) {
  let base = String(video).replace(/\.[^./]+$/, '').replace(/\//g, ' » ').replace(/[:\\?*\[\]]/g, '_');
  if (base.charAt(0) === '_') base = 'v' + base;
  if (base.length > 90) base = base.slice(0, 60) + '…' + base.slice(-29);
  return base;
}

/* ---------------------------------------------------------------- index */
function findIndexRow_(video) {
  const sh = sheet_(INDEX, INDEX_HEADERS);
  const t = readTable_(sh);
  for (let i = 0; i < t.rows.length; i++) if (String(t.rows[i][0]) === video) return { sh: sh, row: i + 2, values: t.rows[i] };
  return { sh: sh, row: -1, values: null };
}

function listVideos_() {
  const t = readTable_(sheet_(INDEX, INDEX_HEADERS));
  return t.rows.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    const o = {}; INDEX_HEADERS.forEach(function (h, i) { o[h] = r[i]; }); return o;
  });
}

/* ---------------------------------------------------------------- segments */
function loadVideo_(video) {
  const idx = findIndexRow_(video);
  const tab = idx.values ? String(idx.values[1]) : tabName_(video);
  const sh = ss_().getSheetByName(tab);
  if (!sh) return { video: video, segments: [], updated: null };
  const t = readTable_(sh);
  const col = {}; t.headers.forEach(function (h, i) { col[h] = i; });
  const num = function (v) { return v === '' || v === null ? null : Number(v); };
  const segs = t.rows.filter(function (r) { return r[col.start_frame] !== '' && r[col.start_frame] !== undefined; }).map(function (r) {
    return {
      id: String(r[col.segment_id] || ''), tool: String(r[col.tool] || ''), action: String(r[col.action] || ''),
      target: String(r[col.target] || ''), start_frame: num(r[col.start_frame]), end_frame: num(r[col.end_frame]),
      note: String(r[col.note] || ''), created: String(r[col.created] || ''), updated: String(r[col.updated] || ''),
    };
  });
  return { video: video, segments: segs, updated: idx.values ? String(idx.values[INDEX_HEADERS.indexOf('updated')]) : null };
}

function saveVideo_(video, meta, segments) {
  const idx = findIndexRow_(video);
  const tab = idx.values ? String(idx.values[1]) : tabName_(video);
  const sh = sheet_(tab, SEG_HEADERS);
  // rewrite the whole tab (simple and safe for a single labeler)
  sh.clearContents();
  const rows = [SEG_HEADERS].concat(segments.map(function (s) {
    return SEG_HEADERS.map(function (h) { return h === 'segment_id' ? s.id : (s[h] === undefined || s[h] === null ? '' : s[h]); });
  }));
  // keep times like 0:16.55 as text (otherwise Sheets turns them into clock times)
  TEXT_COLS.forEach(function (h) { sh.getRange(1, SEG_HEADERS.indexOf(h) + 1, rows.length, 1).setNumberFormat('@'); });
  sh.getRange(1, 1, rows.length, SEG_HEADERS.length).setValues(rows);
  sh.getRange(1, 1, 1, SEG_HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);

  const updated = nowIso_();
  const nFrames = Number(meta.n_frames) || 0, labeled = Number(meta.labeled_frames) || 0;
  const rec = {
    video: video, tab: tab, n_segments: segments.length, labeled_frames: labeled,
    labeled_pct: nFrames ? Math.round(1000 * labeled / nFrames) / 10 : 0, n_frames: nFrames, fps: meta.fps || '',
    fps_rational: meta.fps_rational || '', duration_sec: meta.duration_sec || '', width: meta.width || '',
    height: meta.height || '', updated: updated,
  };
  const line = INDEX_HEADERS.map(function (h) { return rec[h]; });
  const ish = idx.sh;
  const row = idx.row > 0 ? idx.row : Math.max(2, ish.getLastRow() + 1);
  ish.getRange(row, INDEX_HEADERS.indexOf('fps_rational') + 1, 1, 1).setNumberFormat('@');
  ish.getRange(row, 1, 1, INDEX_HEADERS.length).setValues([line]);
  return { tab: tab, updated: updated, n_segments: segments.length };
}

/* ---------------------------------------------------------------- vocab */
function getVocab_() {
  let sh = ss_().getSheetByName(VOCAB);
  if (!sh) {
    sh = sheet_(VOCAB, ['tool', 'action', 'target']);
    const n = Math.max(DEFAULT_VOCAB.tool.length, DEFAULT_VOCAB.action.length, DEFAULT_VOCAB.target.length);
    const rows = [];
    for (let i = 0; i < n; i++) rows.push([DEFAULT_VOCAB.tool[i] || '', DEFAULT_VOCAB.action[i] || '', DEFAULT_VOCAB.target[i] || '']);
    sh.getRange(2, 1, n, 3).setValues(rows);
  }
  const t = readTable_(sh);
  const out = { tool: [], action: [], target: [] };
  ['tool', 'action', 'target'].forEach(function (k) {
    const c = t.headers.indexOf(k);
    if (c < 0) return;
    t.rows.forEach(function (r) { const v = String(r[c]).trim(); if (v && out[k].indexOf(v) < 0) out[k].push(v); });
  });
  return out;
}

function addVocab_(category, value) {
  const v = String(value || '').trim();
  const vocab = getVocab_();
  if (!vocab[category]) throw new Error('bad category');
  if (!v || vocab[category].indexOf(v) >= 0) return vocab;
  const sh = ss_().getSheetByName(VOCAB);
  const c = readTable_(sh).headers.indexOf(category) + 1;
  sh.getRange(vocab[category].length + 2, c).setValue(v);
  vocab[category].push(v);
  return vocab;
}
