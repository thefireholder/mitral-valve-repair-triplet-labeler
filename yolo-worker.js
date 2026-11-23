/* In-browser YOLOv8-seg inference (onnxruntime-web, WebGPU with WASM fallback).
   Protocol:
     -> {type:'init', modelUrl, metaUrl}
     <- {type:'progress', loaded, total} ... {type:'ready', ep, names} | {type:'error', message}
     -> {type:'run', id, frame, bitmap, srcW, srcH, conf}   (bitmap = frame already resized to fit the model input)
     <- {type:'result', id, frame, ms, instances:[{cls, name, conf, box:[x1,y1,x2,y2] (0-1 of frame), mask:{x,y,w,h,data}}], grid:[MW,MH]}
   Masks are binary, on an MW x MH grid covering the original frame, cropped to the instance box. */
'use strict';
const ORT_VER = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
importScripts(ORT_BASE + 'ort.webgpu.min.js');
ort.env.wasm.wasmPaths = ORT_BASE;
ort.env.wasm.numThreads = 1; // GitHub Pages can't enable cross-origin isolation (needed for threads)

const IOU = 0.7, MAX_DET = 100, MASK_W = 640;
let session = null, meta = null, IH = 544, IW = 960, names = {};
let canvas = null, ctx = null;

async function fetchModel(url) {
  // keep the model in Cache Storage so later visits don't download it again
  let cache = null;
  try { cache = await caches.open('triplet-yolo-v1'); } catch { /* unavailable */ }
  if (cache) { const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader(); const chunks = []; let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); loaded += value.length;
    if (loaded - last > 2e6) { last = loaded; postMessage({ type: 'progress', loaded, total }); }
  }
  const buf = new Uint8Array(loaded); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (cache) { try { await cache.put(url, new Response(buf.slice().buffer)); } catch { /* quota */ } }
  return buf;
}

async function init(msg) {
  meta = await (await fetch(msg.metaUrl)).json();
  [IH, IW] = meta.input; names = meta.names;
  const model = await fetchModel(msg.modelUrl);
  let ep = null, lastErr = null;
  const eps = msg.forceWasm ? ['wasm'] : (self.navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']);
  for (const e of eps) {
    try {
      session = await ort.InferenceSession.create(model, { executionProviders: [e], graphOptimizationLevel: 'all' });
      ep = e;
      // warm-up (compiles GPU shaders)
      await session.run({ images: new ort.Tensor('float32', new Float32Array(3 * IH * IW), [1, 3, IH, IW]) });
      break;
    } catch (err) { lastErr = err; session = null; }
  }
  if (!session) throw lastErr || new Error('no execution provider available');
  canvas = new OffscreenCanvas(IW, IH); ctx = canvas.getContext('2d', { willReadFrequently: true });
  postMessage({ type: 'ready', ep, names, input: [IH, IW] });
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
}

async function run(msg) {
  const t0 = performance.now();
  const { bitmap, srcW, srcH } = msg;
  // letterbox: same as ultralytics (scale to fit, centered, gray 114 padding)
  const r = Math.min(IH / srcH, IW / srcW);
  const nw = Math.round(srcW * r), nh = Math.round(srcH * r);
  const px = (IW - nw) / 2, py = (IH - nh) / 2;
  const left = Math.round(px - 0.1), top = Math.round(py - 0.1);
  ctx.fillStyle = 'rgb(114,114,114)'; ctx.fillRect(0, 0, IW, IH);
  ctx.drawImage(bitmap, left, top, nw, nh);
  bitmap.close();
  const px8 = ctx.getImageData(0, 0, IW, IH).data;
  const n = IH * IW, input = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    input[i] = px8[j] / 255; input[i + n] = px8[j + 1] / 255; input[i + 2 * n] = px8[j + 2] / 255;
  }
  const out = await session.run({ images: new ort.Tensor('float32', input, [1, 3, IH, IW]) });
  const o0 = out.output0, o1 = out.output1;
  const pred = o0.data, C = o0.dims[1], N = o0.dims[2], nm = o1.dims[1], nc = C - 4 - nm;
  const protos = o1.data, PH = o1.dims[2], PW = o1.dims[3];
  const tInfer = performance.now() - t0;

  // candidates
  const cand = [];
  for (let a = 0; a < N; a++) {
    let best = -1, bc = 0;
    for (let c = 0; c < nc; c++) { const s = pred[(4 + c) * N + a]; if (s > best) { best = s; bc = c; } }
    if (best < msg.conf) continue;
    const cx = pred[a], cy = pred[N + a], w = pred[2 * N + a], h = pred[3 * N + a];
    cand.push({ a, cls: bc, conf: best, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
  }
  cand.sort((p, q) => q.conf - p.conf);
  // per-class NMS
  const keep = [];
  for (const d of cand) {
    if (keep.length >= MAX_DET) break;
    if (keep.every(k => k.cls !== d.cls || iou(k.box, d.box) <= IOU)) keep.push(d);
  }

  // masks on an MW x MH grid over the original frame
  const MW = MASK_W, MH = Math.round(MASK_W * srcH / srcW);
  const sx = PW / IW, sy = PH / IH; // input px -> proto px
  const instances = [];
  const transfer = [];
  for (const d of keep) {
    // box in original-frame pixels
    const bx = [(d.box[0] - px) / r, (d.box[1] - py) / r, (d.box[2] - px) / r, (d.box[3] - py) / r];
    const b = [Math.max(0, bx[0]), Math.max(0, bx[1]), Math.min(srcW, bx[2]), Math.min(srcH, bx[3])];
    // grid crop
    const gx0 = Math.max(0, Math.floor(b[0] / srcW * MW)), gy0 = Math.max(0, Math.floor(b[1] / srcH * MH));
    const gx1 = Math.min(MW, Math.ceil(b[2] / srcW * MW)), gy1 = Math.min(MH, Math.ceil(b[3] / srcH * MH));
    const gw = gx1 - gx0, gh = gy1 - gy0;
    let mask = null;
    if (gw > 0 && gh > 0) {
      // proto-space region covering the box (+1 px margin for bilinear)
      const pbx0 = Math.max(0, Math.floor(d.box[0] * sx) - 1), pby0 = Math.max(0, Math.floor(d.box[1] * sy) - 1);
      const pbx1 = Math.min(PW - 1, Math.ceil(d.box[2] * sx) + 1), pby1 = Math.min(PH - 1, Math.ceil(d.box[3] * sy) + 1);
      const rw = pbx1 - pbx0 + 1, rh = pby1 - pby0 + 1;
      const coef = new Float32Array(nm);
      for (let k = 0; k < nm; k++) coef[k] = pred[(4 + nc + k) * N + d.a];
      const logit = new Float32Array(rw * rh);
      for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
        const p = (pby0 + yy) * PW + (pbx0 + xx); let s = 0;
        for (let k = 0; k < nm; k++) s += coef[k] * protos[k * PH * PW + p];
        logit[yy * rw + xx] = s;
      }
      const data = new Uint8Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) {
        const Y = (gy0 + gy + 0.5) / MH * srcH;           // original px
        if (Y < b[1] || Y > b[3]) continue;                // crop to box
        const py_ = (Y * r + py) * sy - 0.5 - pby0;        // proto coords (pixel centers)
        const y0 = Math.max(0, Math.min(rh - 1, Math.floor(py_))), y1 = Math.min(rh - 1, y0 + 1), fy = Math.max(0, Math.min(1, py_ - y0));
        for (let gx = 0; gx < gw; gx++) {
          const X = (gx0 + gx + 0.5) / MW * srcW;
          if (X < b[0] || X > b[2]) continue;
          const px_ = (X * r + px) * sx - 0.5 - pbx0;
          const x0 = Math.max(0, Math.min(rw - 1, Math.floor(px_))), x1 = Math.min(rw - 1, x0 + 1), fx = Math.max(0, Math.min(1, px_ - x0));
          const v = (logit[y0 * rw + x0] * (1 - fx) + logit[y0 * rw + x1] * fx) * (1 - fy)
                  + (logit[y1 * rw + x0] * (1 - fx) + logit[y1 * rw + x1] * fx) * fy;
          if (v > 0) data[gy * gw + gx] = 1;               // sigmoid(v) > 0.5
        }
      }
      mask = { x: gx0, y: gy0, w: gw, h: gh, data };
      transfer.push(data.buffer);
    }
    instances.push({
      cls: d.cls, name: names[d.cls] ?? String(d.cls), conf: Math.round(d.conf * 1000) / 1000,
      box: [b[0] / srcW, b[1] / srcH, b[2] / srcW, b[3] / srcH], mask,
    });
  }
  postMessage({
    type: 'result', id: msg.id, frame: msg.frame, instances, grid: [MW, MH],
    ms: Math.round(performance.now() - t0), msInfer: Math.round(tInfer),
  }, transfer);
}

let queue = Promise.resolve();
onmessage = e => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg).catch(err => postMessage({ type: 'error', message: String(err && err.message || err) }));
  } else if (msg.type === 'run') {
    queue = queue.then(() => run(msg)).catch(err => postMessage({ type: 'runError', id: msg.id, frame: msg.frame, message: String(err && err.message || err) }));
  }
};
