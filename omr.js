"use strict";

// Template-free optical mark recognition, the way bubble-sheet scanners work:
// don't trust each box's own shape (a mark ruins it), find the lattice the
// boxes sit on and measure the ink inside every lattice position.
//
//  1. Normalize lighting (divide by a heavily smoothed copy of the photo), so
//     a shadow or glare doesn't change what "paper" and "ink" mean.
//  2. Anchors: boxes that are still clean closed squares (blank ones) are
//     found reliably as holes in the thresholded image.
//  3. Lattice: from the anchors, work out the grid's orientation and pitch,
//     then grow the lattice outward from them. A grid position with no anchor
//     (a marked box whose shape was damaged) is accepted if a box outline is
//     actually present there - its border is still there under the mark.
//  4. Measure each lattice cell's interior against the normalized paper
//     level (dark ink fraction + green-highlighter tint) and split blank from
//     marked with a 1-D Otsu over all cells.
//
// `cv` is passed in so this runs identically in the browser and in Node.

const OMR = {};

OMR.otsu1d = function (values, nbins = 128) {
  let vmin = Infinity, vmax = -Infinity;
  for (const v of values) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  if (!(vmax > vmin)) return { thresh: vmin, mid: vmin, sep: 0 };
  const hist = new Array(nbins).fill(0);
  const bw = (vmax - vmin) / nbins;
  for (const v of values) hist[Math.min(nbins - 1, Math.floor((v - vmin) / bw))]++;
  const total = values.length;
  let sumTotal = 0;
  for (let t = 0; t < nbins; t++) sumTotal += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, bestBin = 0, bestMB = 0, bestMF = 0;
  for (let t = 0; t < nbins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumTotal - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > maxVar) { maxVar = v; bestBin = t; bestMB = mB; bestMF = mF; }
  }
  return { thresh: vmin + (bestBin + 1) * bw, mid: vmin + ((bestMB + bestMF) / 2 + 0.5) * bw, sep: (bestMF - bestMB) * bw };
};

const median = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Returns { cells, cellThresh, pipeline, maskMat }. cells: [{x,y,w,h,cx,cy,ink,green,score,virtual}]
// `src` is an RGBA cv.Mat. The caller owns `src`; maskMat (if returned) is the caller's to delete.
OMR.analyze = function (cv, src, opts = {}) {
  const W = src.cols, H = src.rows;
  const minSide = Math.min(W, H);
  const dbg = opts.debug ? [] : null;
  const pipeline = { anchors: 0, virtual: 0, components: 0, keptCells: 0, boxSize: 0, theta: 0, pitchU: 0, pitchV: 0 };

  // 1. lighting normalization -------------------------------------------------
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  let bg = null, norm = null, blurred = null, binary = null, bin = null;
  let paperLevel = 255, inkCut = 0, normK = 0, holes = [];
  const minDim = 0.006 * minSide, maxDim = 0.3 * minSide;

  // Normalize lighting with a closing of size k (removes dark features smaller
  // than k, leaving the paper brightness), then find the square-ish holes.
  // k must exceed the box size, or big filled boxes get "normalized away".
  const prepare = (k) => {
    if (bg) { bg.delete(); norm.delete(); blurred.delete(); binary.delete(); }
    normK = k;
    // estimate at reduced size so a big k stays cheap
    const f = Math.max(1, Math.floor(k / 20));
    let small = gray;
    if (f > 1) { small = new cv.Mat(); cv.resize(gray, small, new cv.Size(Math.round(W / f), Math.round(H / f)), 0, 0, cv.INTER_AREA); }
    const kk = Math.max(3, Math.round(k / f) | 1);
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kk, kk));
    const closed = new cv.Mat();
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
    const smooth = new cv.Mat();
    cv.GaussianBlur(closed, smooth, new cv.Size(0, 0), Math.max(8, minSide * 0.02) / f);
    bg = new cv.Mat();
    if (f > 1) cv.resize(smooth, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); else smooth.copyTo(bg);
    kernel.delete(); closed.delete(); smooth.delete(); if (small !== gray) small.delete();
    norm = new cv.Mat();
    cv.divide(gray, bg, norm, 255, cv.CV_8U);

    blurred = new cv.Mat();
    cv.GaussianBlur(norm, blurred, new cv.Size(3, 3), 0);
    // Thin printed outlines are faint after blur/JPEG; Otsu is dominated by dark
    // marks and backgrounds and misses them. After normalization "paper" is a
    // known level, so cut just below it: anything noticeably darker is ink.
    const levelHist = new Array(256).fill(0);
    for (let i = 0; i < blurred.data.length; i++) levelHist[blurred.data[i]]++;
    let acc = 0;
    paperLevel = 255;
    for (let v = 0; v < 256; v++) { acc += levelHist[v]; if (acc >= blurred.data.length / 2) { paperLevel = v; break; } }
    inkCut = Math.round(paperLevel * 0.94);
    binary = new cv.Mat();
    cv.threshold(blurred, binary, inkCut, 255, cv.THRESH_BINARY_INV);
    bin = binary.data; // 255 = ink/border

    // 2. anchors: clean closed squares --------------------------------------
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
    holes = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      if (hierarchy.data32S[i * 4 + 3] !== -1) {
        const r = cv.boundingRect(cnt);
        if (r.width >= minDim && r.width <= maxDim && r.height >= minDim && r.height <= maxDim) {
          const ra = r.width * r.height;
          const fill = cv.contourArea(cnt) / ra;
          const asp = r.width / r.height;
          if (fill >= 0.6 && asp >= 0.75 && asp <= 1.34) holes.push({ x: r.x, y: r.y, w: r.width, h: r.height, area: ra });
        }
      }
      cnt.delete();
    }
    contours.delete(); hierarchy.delete();
  };

  // Typical box size: the densest cluster of hole widths (boxes are far more
  // uniform than printed labels). Relative buckets so it works for any size.
  const modeOf = () => {
    const cnt = new Map();
    for (const h of holes) { const b = Math.round(Math.log(h.w) / Math.log(1.07)); cnt.set(b, (cnt.get(b) || 0) + 1); }
    let bestB = null, bestN = 0;
    for (const b of cnt.keys()) {
      const n = (cnt.get(b - 1) || 0) + cnt.get(b) + (cnt.get(b + 1) || 0);
      if (n > bestN) { bestN = n; bestB = b; }
    }
    if (bestB === null) return 0;
    return median(holes.filter((h) => Math.abs(Math.round(Math.log(h.w) / Math.log(1.07)) - bestB) <= 1).map((h) => h.w));
  };

  prepare(Math.max(15, Math.round(minSide * 0.02) | 1));
  let modeW = modeOf();
  if (modeW && modeW * 1.6 > normK) { prepare(Math.round(modeW * 2) | 1); modeW = modeOf(); }
  pipeline.paperLevel = paperLevel;
  pipeline.normKernel = normK;
  if (!modeW) { cleanup(); return { cells: [], cellThresh: 0.5, pipeline, maskMat: null }; }
  // Big squares can't be mistaken for text, so small grids are believable.
  const bigBox = modeW >= 0.03 * minSide;
  holes = holes.filter((h) => h.w >= 0.75 * modeW && h.w <= 1.3 * modeW && h.h >= 0.75 * modeW && h.h <= 1.3 * modeW);
  // dedupe holes that are the same box
  holes.sort((a, b) => b.area - a.area);
  let anchors = [];
  for (const h of holes) {
    const cx = h.x + h.w / 2, cy = h.y + h.h / 2;
    if (!anchors.some((a) => Math.abs(a.cx - cx) < modeW * 0.5 && Math.abs(a.cy - cy) < modeW * 0.5)) {
      anchors.push({ cx, cy, virtual: false, comp: -1, lu: null, lv: null });
    }
  }
  pipeline.anchors = anchors.length;
  pipeline.boxSize = modeW;
  if (anchors.length < (bigBox ? 4 : 6)) { cleanup(); return { cells: [], cellThresh: 0.5, pipeline, maskMat: null }; }

  // 3a. grid orientation + pitch from anchor-to-anchor vectors ------------------
  const nn = [];
  for (const a of anchors) {
    const d = [];
    for (const b of anchors) {
      if (a === b) continue;
      const dx = b.cx - a.cx, dy = b.cy - a.cy, dist = Math.hypot(dx, dy);
      if (dist < modeW * 4.5) d.push({ dx, dy, dist });
    }
    d.sort((p, q) => p.dist - q.dist);
    for (const v of d.slice(0, 4)) nn.push(v);
  }
  const folded = nn.map((v) => {
    let ang = (Math.atan2(v.dy, v.dx) * 180) / Math.PI; // -180..180
    ang = ((ang % 90) + 90) % 90;                        // 0..90
    return ang > 45 ? ang - 90 : ang;                    // -45..45
  });
  const theta = (median(folded) * Math.PI) / 180;
  pipeline.theta = (theta * 180) / Math.PI;
  const ux = Math.cos(theta), uy = Math.sin(theta), vx = -Math.sin(theta), vy = Math.cos(theta);
  const pu = [], pv = [];
  for (const v of nn) {
    const along = v.dx * ux + v.dy * uy, across = v.dx * vx + v.dy * vy;
    if (Math.abs(across) < v.dist * 0.35 && along > 0) pu.push(along);
    else if (Math.abs(along) < v.dist * 0.35 && across > 0) pv.push(across);
  }
  const pitchU = median(pu), pitchV = median(pv);
  pipeline.pitchU = pitchU; pipeline.pitchV = pitchV;
  if (!(pitchU > modeW * 0.9) || !(pitchV > modeW * 0.9)) { cleanup(); return { cells: [], cellThresh: 0.5, pipeline, maskMat: null }; }
  const U0 = [ux * pitchU, uy * pitchU], V0 = [vx * pitchV, vy * pitchV];

  // 3b. does a box outline exist at (cx,cy)? refine position within +-3px ----------
  const half = modeW / 2 + Math.max(1.5, modeW * 0.03);
  const tol = Math.max(2, Math.round(modeW * 0.06));
  const sideScore = (cx, cy) => {
    const sides = [0, 0, 0, 0];
    const n = Math.max(4, Math.round(modeW) - 3);
    for (let s = 0; s < 4; s++) {
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const t = -half + 2.5 + (i * (2 * half - 5)) / (n - 1);
        let px, py, nx, ny;
        if (s === 0) { px = cx + t; py = cy - half; nx = 0; ny = 1; }
        else if (s === 1) { px = cx + t; py = cy + half; nx = 0; ny = 1; }
        else if (s === 2) { px = cx - half; py = cy + t; nx = 1; ny = 0; }
        else { px = cx + half; py = cy + t; nx = 1; ny = 0; }
        let hit = false;
        for (let o = -tol; o <= tol && !hit; o++) {
          const xx = Math.round(px + nx * o), yy = Math.round(py + ny * o);
          if (xx >= 0 && xx < W && yy >= 0 && yy < H && bin[yy * W + xx]) hit = true;
        }
        if (hit) hits++;
      }
      sides[s] = hits / n;
    }
    return sides;
  };
  // Look for an outline within +-range px of (cx,cy); among near-equal best
  // placements prefer the one closest to where we expected it, so repeated
  // snapping can't walk toward nearby text.
  const validate = (cx, cy, range, loose) => {
    const cand = [];
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const sides = sideScore(cx + dx, cy + dy);
        cand.push({ total: sides[0] + sides[1] + sides[2] + sides[3], sides, cx: cx + dx, cy: cy + dy, off: Math.hypot(dx, dy) });
      }
    }
    const top = Math.max(...cand.map((c) => c.total));
    const best = cand.filter((c) => c.total >= top - 0.2).sort((p, q) => p.off - q.off)[0];
    if (loose) {
      // already placed by the lattice fit; just confirm there's some outline
      // there (a thick X can hide much of it). Confirmation by neighbours
      // below is what keeps fake cells out.
      const some = best.sides.filter((v) => v >= 0.55).length;
      return some >= 2 && best.total >= 2.2 ? best : null;
    }
    const strong = best.sides.filter((v) => v >= 0.75).length;
    return strong >= 3 && best.total >= 3.2 ? best : null;
  };

  // 3c. grow the lattice from the anchors ----------------------------------------
  const cellsAll = anchors.slice();
  const grid = new Map(); // spatial hash of all cells
  const gs = modeW * 1.5;
  const key = (cx, cy) => `${Math.floor(cx / gs)},${Math.floor(cy / gs)}`;
  const addToGrid = (c) => { const k2 = key(c.cx, c.cy); if (!grid.has(k2)) grid.set(k2, []); grid.get(k2).push(c); };
  const nearest = (px, py, r) => {
    let best = null, bd = r;
    const gx = Math.floor(px / gs), gy = Math.floor(py / gs);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      const lst = grid.get(`${ix},${iy}`);
      if (!lst) continue;
      for (const c of lst) { const d = Math.hypot(c.cx - px, c.cy - py); if (d < bd) { bd = d; best = c; } }
    }
    return best;
  };
  for (const a of anchors) addToGrid(a);

  // Pass A: walk outward from each anchor, giving every cell integer grid
  // indices (i,j). Positions of gap cells here are only provisional.
  const comps = [];
  const maxVirtual = 5000;
  let virtualCount = 0;
  for (const seed of anchors) {
    if (seed.comp !== -1) continue;
    const comp = comps.length;
    const members = [seed];
    seed.comp = comp; seed.lu = U0.slice(); seed.lv = V0.slice(); seed.i = 0; seed.j = 0;
    const queue = [seed];
    while (queue.length) {
      const c = queue.shift();
      for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const base = dir[0] !== 0 ? c.lu : c.lv;
        const sgn = dir[0] !== 0 ? dir[0] : dir[1];
        const px = c.cx + sgn * base[0], py = c.cy + sgn * base[1];
        const r = 0.25 * Math.hypot(base[0], base[1]);
        const e = nearest(px, py, r);
        if (e) {
          if (e.comp !== -1) continue;
          e.comp = comp; e.i = c.i + dir[0]; e.j = c.j + dir[1];
          e.lu = c.lu.slice(); e.lv = c.lv.slice();
          const obs = [sgn * (e.cx - c.cx), sgn * (e.cy - c.cy)];
          if (dir[0] !== 0) e.lu = obs; else e.lv = obs;
          members.push(e); queue.push(e);
        } else if (virtualCount < maxVirtual) {
          const ok = validate(px, py, Math.max(3, Math.round(modeW * 0.1)));
          if (!ok) continue;
          if (nearest(ok.cx, ok.cy, modeW * 0.6)) continue;
          const e2 = { cx: ok.cx, cy: ok.cy, virtual: true, comp, i: c.i + dir[0], j: c.j + dir[1], lu: c.lu.slice(), lv: c.lv.slice() };
          cellsAll.push(e2); addToGrid(e2); members.push(e2); queue.push(e2); virtualCount++;
        }
      }
    }
    comps.push(members);
  }

  // Pass B: re-place every gap cell from a local affine fit of the *real*
  // anchors around it (index -> position), then require an outline there.
  // Provisional positions from pass A can drift; the fit can't.
  const fitAffine = (pts) => {
    // least squares for pos = a0 + a1*i + a2*j, per axis
    let n = 0, si = 0, sj = 0, sii = 0, sjj = 0, sij = 0;
    for (const p of pts) { n++; si += p.i; sj += p.j; sii += p.i * p.i; sjj += p.j * p.j; sij += p.i * p.j; }
    const det = n * (sii * sjj - sij * sij) - si * (si * sjj - sij * sj) + sj * (si * sij - sii * sj);
    if (Math.abs(det) < 1e-6) return null;
    const solve = (get) => {
      let sv = 0, svi = 0, svj = 0;
      for (const p of pts) { const v = get(p); sv += v; svi += v * p.i; svj += v * p.j; }
      // Cramer's rule on [[n,si,sj],[si,sii,sij],[sj,sij,sjj]]
      const d0 = sv * (sii * sjj - sij * sij) - si * (svi * sjj - sij * svj) + sj * (svi * sij - sii * svj);
      const d1 = n * (svi * sjj - sij * svj) - sv * (si * sjj - sij * sj) + sj * (si * svj - svi * sj);
      const d2 = n * (sii * svj - svi * sij) - si * (si * svj - svi * sj) + sv * (si * sij - sii * sj);
      return [d0 / det, d1 / det, d2 / det];
    };
    return { x: solve((p) => p.cx), y: solve((p) => p.cy) };
  };
  for (const members of comps) {
    const real = members.filter((c) => !c.virtual);
    for (const v of members) {
      if (!v.virtual) continue;
      // Fit from the closest real anchors: widen the window only until there are
      // enough, since a wide window averages in perspective curvature.
      const need = bigBox ? 3 : 6;
      let pts = [], f = null;
      for (const win of [1, 2, 3]) {
        pts = real.filter((a) => Math.abs(a.i - v.i) <= win && Math.abs(a.j - v.j) <= win);
        if (pts.length >= need) { f = fitAffine(pts); if (f) break; }
      }
      if (!f) { v.dead = true; if (dbg) dbg.push({ why: 'fit', x: v.cx, y: v.cy, n: pts.length }); continue; }
      // the fit must agree with the anchors it was made from
      if (pts.length > 3) {
        const resid = pts.map((a) => Math.hypot(f.x[0] + f.x[1] * a.i + f.x[2] * a.j - a.cx, f.y[0] + f.y[1] * a.i + f.y[2] * a.j - a.cy));
        if (median(resid) > 0.18 * modeW) { v.dead = true; if (dbg) dbg.push({ why: 'fitres', x: v.cx, y: v.cy }); continue; }
      }
      const px = f.x[0] + f.x[1] * v.i + f.x[2] * v.j, py = f.y[0] + f.y[1] * v.i + f.y[2] * v.j;
      const ok = validate(px, py, Math.max(2, Math.round(modeW * 0.06)), true);
      if (!ok) { v.dead = true; if (dbg) dbg.push({ why: 'ringB', x: px, y: py }); continue; }
      v.cx = ok.cx; v.cy = ok.cy;
      v.lu = [f.x[1], f.y[1]]; v.lv = [f.x[2], f.y[2]];
    }
    // two chains can resolve to the same real box
    const alive = members.filter((c) => !c.dead);
    alive.sort((p, q) => (p.virtual ? 1 : 0) - (q.virtual ? 1 : 0));
    const placed = [];
    for (const c of alive) {
      if (placed.some((o) => Math.hypot(o.cx - c.cx, o.cy - c.cy) < modeW * 0.6)) c.dead = true;
      else placed.push(c);
    }
  }

  // A gap cell is believed only once two neighbours that are themselves
  // believed (real anchors, or already-confirmed gap cells) back it up.
  // Merely having neighbours isn't enough: a row of title text above a block
  // can produce a whole row of mutually-supporting fake cells, but each has
  // only one real box next to it, so none of them ever gets confirmed.
  const confirmed = new Set(cellsAll.filter((c) => !c.virtual && !c.dead));
  const gridConf = new Map();
  const addConf = (c) => { const k2 = key(c.cx, c.cy); if (!gridConf.has(k2)) gridConf.set(k2, []); gridConf.get(k2).push(c); };
  for (const c of confirmed) addConf(c);
  const hasConf = (px, py, r) => {
    const gx = Math.floor(px / gs), gy = Math.floor(py / gs);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      const lst = gridConf.get(`${ix},${iy}`);
      if (lst) for (const c of lst) if (Math.hypot(c.cx - px, c.cy - py) < r) return true;
    }
    return false;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cellsAll) {
      if (!c.virtual || c.dead || confirmed.has(c)) continue;
      let sup = 0;
      for (const [vec, sg] of [[c.lu, 1], [c.lu, -1], [c.lv, 1], [c.lv, -1]]) {
        if (hasConf(c.cx + sg * vec[0], c.cy + sg * vec[1], 0.35 * Math.hypot(vec[0], vec[1]))) sup++;
      }
      if (sup >= 2) { confirmed.add(c); addConf(c); grew = true; }
    }
  }
  for (const c of cellsAll) if (c.virtual && !confirmed.has(c) && !c.dead) { c.dead = true; if (dbg) dbg.push({ why: 'unconfirmed', x: c.cx, y: c.cy }); }
  if (dbg) pipeline.dbg = dbg;
  for (const c of cellsAll) if (c.dead) c.comp = -2;
  const MIN_COMP = bigBox ? 4 : 12;
  const keep = new Set();
  let nComps = 0;
  // Real blocks are all about the same size, so a lattice far smaller than the
  // biggest one is almost certainly printed text, a barcode or a marker.
  const compSizes = comps.map((m) => m.filter((c) => !c.dead).length);
  const biggest = Math.max(0, ...compSizes);
  const minKeep = Math.max(MIN_COMP, biggest >= 40 ? Math.round(biggest * 0.15) : 0);
  compSizes.forEach((n, i) => { if (n >= minKeep) { keep.add(i); nComps++; } });
  pipeline.compSizes = compSizes.filter((n) => n > 0).sort((a, b) => b - a).slice(0, 16).join(",");
  let cells = cellsAll.filter((c) => keep.has(c.comp));
  pipeline.components = nComps;
  pipeline.virtual = cells.filter((c) => c.virtual).length;
  pipeline.keptCells = cells.length;

  // 4. measure each cell against the normalized paper level -----------------------
  const nd = norm.data;
  const sd = src.data; // RGBA
  const inset = Math.max(2, Math.round(modeW * 0.17));
  const rIn = Math.max(2, Math.round(modeW / 2 - inset));
  for (const c of cells) {
    const x0 = Math.round(c.cx - rIn), x1 = Math.round(c.cx + rIn);
    const y0 = Math.round(c.cy - rIn), y1 = Math.round(c.cy + rIn);
    // Paper level right around this box (upper quartile of a ring just outside
    // its outline), so a shadow the lighting correction missed doesn't read as ink.
    const ringIn = Math.round(modeW / 2 + Math.max(3, modeW * 0.08)), ringOut = ringIn + Math.max(3, Math.round(modeW * 0.12));
    const ringVals = [];
    for (let y = Math.max(0, Math.round(c.cy - ringOut)); y <= Math.min(H - 1, Math.round(c.cy + ringOut)); y++) {
      for (let x = Math.max(0, Math.round(c.cx - ringOut)); x <= Math.min(W - 1, Math.round(c.cx + ringOut)); x++) {
        const m = Math.max(Math.abs(x - c.cx), Math.abs(y - c.cy));
        if (m >= ringIn && m <= ringOut) ringVals.push(nd[y * W + x]);
      }
    }
    ringVals.sort((a, b) => a - b);
    const localPaper = ringVals.length ? ringVals[Math.floor(ringVals.length * 0.75)] : paperLevel;
    const cut = Math.round(localPaper * 0.9);
    let n = 0, dark = 0, gsum = 0, lsum = 0;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        const v = nd[y * W + x];
        n++; lsum += v;
        if (v < cut) dark += cut - v; // ink "mass": how far below local paper, not just whether
        const p = (y * W + x) * 4;
        const lum = Math.max(40, bg.data[y * W + x]);
        gsum += ((sd[p + 1] - (sd[p] + sd[p + 2]) / 2) / lum) * 255;
      }
    }
    c.inkFrac = n ? dark / n : 0; // mean darkness below the paper cut, 0..~200
    c.greenRaw = n ? gsum / n : 0;
    c.meanNorm = n ? lsum / n : 255;
    c.w = c.h = Math.round(modeW + 2); c.x = Math.round(c.cx - c.w / 2); c.y = Math.round(c.cy - c.h / 2);
  }
  // paper tint differs per photo: green is measured relative to the typical cell
  const greenBase = median(cells.map((c) => c.greenRaw));
  for (const c of cells) {
    c.ink = Math.min(1, c.inkFrac / 10);
    c.green = Math.max(0, Math.min(1, (c.greenRaw - greenBase) / 22));
    c.score = Math.max(c.ink, c.green);
  }
  let cellThresh = 0.4;
  if (cells.length >= 6) {
    const o = OMR.otsu1d(cells.map((c) => c.score));
    // only trust the automatic split when the two groups are genuinely separate
    if (o.sep > 0.25) {
      // Otsu lands midway between blank and *strong* marks and would lose faint
      // ones. Blank cells cluster tightly near zero, so cut just above them.
      const blank = cells.map((c) => c.score).filter((v) => v < o.mid).sort((a, b) => a - b);
      const p98 = blank.length ? blank[Math.min(blank.length - 1, Math.floor(blank.length * 0.98))] : 0;
      cellThresh = Math.min(o.mid, Math.max(0.2, p98 * 1.4));
    }
  }

  const maskMat = binary.clone();
  cleanup();
  return { cells, cellThresh, pipeline, maskMat };

  function cleanup() {
    gray.delete(); bg.delete(); norm.delete(); blurred.delete(); binary.delete();
  }
};

if (typeof module !== "undefined") module.exports = OMR;
