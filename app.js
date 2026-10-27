"use strict";

const MAX_WORK_WIDTH = 1600;
// Bounds (relative to the photo's shorter side) a checkbox-sized connected
// component must fall within to even be considered — wide enough to cover
// everything from a cramped ballot grid to a loose attendance sheet,
// narrow enough to exclude single printed characters and whole fused
// multi-box blobs. The real size is then found per-photo from the mode of
// what falls inside this range (see findCells).
const MIN_BOX_FRAC = 0.008, MAX_BOX_FRAC = 0.05;

const state = {
  cvReady: false,
  workCanvas: document.createElement("canvas"),
  viewCanvas: document.getElementById("viewCanvas"),
  method: "blob",  // "blob" (default: classify every box by ink content) or "xshape" (experimental: find X's and green blobs directly)
  cells: null,     // [{x,y,w,h,fill,green,score}] in workCanvas pixel coordinates, after detection
  cellThresh: 0.5, // auto-computed split point between "blank" and "marked" scores
  adjust: 0,       // user's slider offset from cellThresh, -0.15..+0.15
  pipeline: null,  // stage counts from the most recent detection run, for diagnostics
  expectedTotal: null,
  maskCanvas: null,  // the binary threshold mask detection actually ran on, for visual debugging
  showingMask: false,
};
state.workCtx = state.workCanvas.getContext("2d");
state.viewCtx = state.viewCanvas.getContext("2d");

const el = (id) => document.getElementById(id);

// ── OpenCV readiness ─────────────────────────────────────────────────────────

window.addEventListener("opencv-ready", () => {
  state.cvReady = true;
  el("status").textContent = "Ready. Choose a photo to get started.";
});

// ── Image loading → auto-detect ──────────────────────────────────────────────

el("fileInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) loadImageFile(file);
});

function loadImageFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const scale = Math.min(1, MAX_WORK_WIDTH / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    state.workCanvas.width = w;
    state.workCanvas.height = h;
    state.workCtx.drawImage(img, 0, 0, w, h);
    state.viewCanvas.width = w;
    state.viewCanvas.height = h;
    state.viewCtx.drawImage(state.workCanvas, 0, 0);

    el("canvasWrap").hidden = false;
    el("resetBtn").disabled = false;
    el("resultsSection").hidden = true;
    state.showingMask = false;
    el("showMaskBtn").textContent = "Show detection mask";
    URL.revokeObjectURL(url);

    if (!state.cvReady) {
      el("status").textContent = "Waiting for OpenCV to finish loading…";
      const onReady = () => {
        window.removeEventListener("opencv-ready", onReady);
        detectAndClassify();
      };
      window.addEventListener("opencv-ready", onReady);
    } else {
      detectAndClassify();
    }
  };
  img.src = url;
}

el("resetBtn").addEventListener("click", () => {
  state.cells = null;
  state.adjust = 0;
  el("thresholdSlider").value = 0;
  el("thresholdValue").textContent = "auto";
  el("fileInput").value = "";
  state.workCanvas.width = 0;
  state.workCanvas.height = 0;
  state.viewCanvas.width = 0;
  state.viewCanvas.height = 0;
  el("canvasWrap").hidden = true;
  el("resultsSection").hidden = true;
  el("resetBtn").disabled = true;
  el("status").textContent = "Ready. Choose a photo to get started.";
});

el("thresholdSlider").addEventListener("input", (e) => {
  state.adjust = Number(e.target.value) / 100;
  const v = Number(e.target.value);
  el("thresholdValue").textContent = v === 0 ? "auto" : (v > 0 ? `+${v}%` : `${v}%`);
  if (state.cells) renderResult();
});

el("expectedTotal").addEventListener("change", () => {
  // Detection no longer depends on this — it's just shown for context —
  // so just update the note rather than redoing all the CV work.
  const raw = el("expectedTotal").value.trim();
  state.expectedTotal = raw ? Math.max(1, parseInt(raw, 10)) : null;
  if (state.cells) renderResult(state.expectedTotal);
});

el("methodSelect").addEventListener("change", (e) => {
  state.method = e.target.value;
  el("methodHint").textContent = state.method === "xshape"
    ? "Experimental: looks for X-shaped crossing strokes and green highlighter directly, without locating boxes first. In testing this missed more marks and had more false positives than the default — here to compare against your own photo."
    : "Finds every box, measures how inked it is. Catches X's, checkmarks, and highlighter fills alike.";
  if (state.cells) detectAndClassify();
});

el("copyDiagnosticsBtn").addEventListener("click", copyDiagnostics);

el("showMaskBtn").addEventListener("click", () => {
  state.showingMask = !state.showingMask;
  el("showMaskBtn").textContent = state.showingMask ? "Show normal view" : "Show detection mask";
  renderResult(state.expectedTotal);
});

// ── Detection ────────────────────────────────────────────────────────────────

function detectAndClassify() {
  el("status").textContent = "Finding marks…";
  el("resultsSection").hidden = true;
  // Let "Finding marks…" paint before the synchronous CV work blocks the thread.
  setTimeout(() => {
    const expectedRaw = el("expectedTotal").value.trim();
    const expectedTotal = expectedRaw ? Math.max(1, parseInt(expectedRaw, 10)) : null;
    state.expectedTotal = expectedTotal;
    try {
      const { cells, cellThresh, pipeline, maskCanvas } = state.method === "xshape"
        ? findXShapeMarks(state.workCanvas)
        : findCells(state.workCanvas);
      state.cells = cells;
      state.cellThresh = cellThresh;
      state.pipeline = pipeline;
      state.maskCanvas = maskCanvas;
    } catch (err) {
      console.error(err);
      el("status").textContent = "Something went wrong analyzing that photo — try a different one.";
      return;
    }
    if (state.cells.length === 0) {
      el("status").textContent = "Couldn't find any boxes in this photo. Make sure the whole grid is visible and well-lit.";
      return;
    }
    el("status").textContent = "";
    el("resultsSection").hidden = false;
    state.adjust = 0;
    el("thresholdSlider").value = 0;
    el("thresholdValue").textContent = "auto";
    renderResult(expectedTotal);
  }, 30);
}

// Finds every marked box in the image directly — not by first reconstructing
// the grid of boxes and then inspecting each one, but by measuring how
// "inked" every connected blob in the photo is and keeping the ones that
// look like a box. This replaced an approach built around finding each
// box's border first (contour holes, with increasingly elaborate handling
// for marks that damage a hole): that whole direction kept being undermined
// by the fact that marking a box is specifically what breaks its hole, so
// detection and classification were fighting each other. Measuring "how
// inked is this blob" directly sidesteps that entirely.
//
// Detection: threshold the photo to a binary foreground mask (ink and
// borders both count as foreground, blank paper doesn't), then take every
// connected blob (`cv.connectedComponentsWithStats`) as a candidate — no
// hole/contour-hierarchy reasoning at all. A blank box's blob is just its
// thin border ring, low fill ratio (contour area vs. its own bounding box).
// A marked box's blob includes whatever's inside it — a highlighter fill or
// an X — so its fill ratio is substantially higher. That's the whole
// classification signal, and it turns out to separate blank from marked
// far more cleanly than measuring interior darkness ever did, because it's
// reading the box's actual ink content instead of trying to infer it from
// a hole that marking itself damages.
//
// A printed reference number/label next to each box (e.g. "0", "8", "9")
// is its own small blob with its own fill ratio — sometimes close to a
// real mark's, so size is still needed to exclude it, but size alone
// doesn't need to be exact: real boxes are far more uniform in size than
// scattered label text, so the photo's actual box size is found from the
// *mode* of blob widths in a generous plausible range (MIN_BOX_FRAC to
// MAX_BOX_FRAC of the photo's shorter side) rather than assumed in advance
// or sized against a contaminated median.
function findCells(canvas) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  // Keep a viewable copy of the exact mask detection runs on — lets a user
  // screenshot what the algorithm actually sees and share that back, since
  // there's no way to read a photo shared in chat directly.
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  cv.imshow(maskCanvas, binary);

  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const numLabels = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);

  const minDim = MIN_BOX_FRAC * Math.min(canvas.width, canvas.height);
  const maxDim = MAX_BOX_FRAC * Math.min(canvas.width, canvas.height);
  const pipeline = { rawComponents: numLabels - 1, plausibleSized: 0, modeWidth: 0, afterShapeFilter: 0 };

  const comps = [];
  for (let i = 1; i < numLabels; i++) { // label 0 is background
    const x = stats.data32S[i * 5 + 0], y = stats.data32S[i * 5 + 1];
    const w = stats.data32S[i * 5 + 2], h = stats.data32S[i * 5 + 3];
    const area = stats.data32S[i * 5 + 4];
    comps.push({ x, y, w, h, area });
  }
  labels.delete(); stats.delete(); centroids.delete();

  const plausible = comps.filter((c) => c.w >= minDim && c.w <= maxDim && c.h >= minDim && c.h <= maxDim);
  pipeline.plausibleSized = plausible.length;

  let cells = [];
  if (plausible.length > 0) {
    const bucketWidth = 2;
    const hist = new Map();
    for (const c of plausible) {
      const bucket = Math.round(c.w / bucketWidth) * bucketWidth;
      hist.set(bucket, (hist.get(bucket) || 0) + 1);
    }
    let modeWidth = 0, modeCount = 0;
    for (const [bucket, count] of hist) {
      if (count > modeCount) { modeCount = count; modeWidth = bucket; }
    }
    pipeline.modeWidth = modeWidth;

    cells = comps
      .filter((c) =>
        c.w >= 0.5 * modeWidth && c.w <= 2.2 * modeWidth &&
        c.h >= 0.5 * modeWidth && c.h <= 2.2 * modeWidth &&
        c.w / c.h >= 0.5 && c.w / c.h <= 2.0
      )
      .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, fill: c.area / (c.w * c.h) }));
  }
  pipeline.afterShapeFilter = cells.length;

  // Green highlighter is often too light to show up in the fill ratio
  // above (it's a mask over the grayscale-thresholded image, and
  // highlighter is barely darker than blank paper). Measure it directly as
  // a second signal — how much an inset crop's average color leans green
  // (G channel vs. the other two) — and count a box as marked if either
  // signal is strong.
  const insetFrac = 0.12;
  for (const c of cells) {
    const insetX = Math.round(c.w * insetFrac);
    const insetY = Math.round(c.h * insetFrac);
    const rw = c.w - 2 * insetX;
    const rh = c.h - 2 * insetY;
    if (rw <= 0 || rh <= 0) { c.green = 0; c.score = c.fill; continue; }
    const roiColor = src.roi(new cv.Rect(c.x + insetX, c.y + insetY, rw, rh));
    const meanColor = cv.mean(roiColor);
    roiColor.delete();
    const greenDiff = meanColor[1] - (meanColor[0] + meanColor[2]) / 2;
    c.green = Math.max(0, Math.min(1, greenDiff / 50));
    c.score = Math.max(c.fill, c.green);
  }

  const cellThresh = cells.length >= 2 ? otsu1d(cells.map((c) => c.score)) : 0.5;

  src.delete(); gray.delete(); blurred.delete(); binary.delete();

  return { cells, cellThresh, maskCanvas, pipeline: { ...pipeline, imageW: canvas.width, imageH: canvas.height } };
}

// Experimental alternative to findCells: instead of locating every box and
// measuring how inked it is, look for marks directly — X-shaped crossing
// strokes (two diagonal line segments whose bounding boxes overlap, found
// via Hough line detection) and green-highlighter blobs (a direct color
// mask, not anchored to any box). No box/border reasoning at all.
//
// Tested in Python against the same stress-test form findCells is
// validated against: 67-80% recall on actual X marks (vs. findCells'
// 100%), some false positives from printed characters whose glyphs
// contain their own diagonal strokes (e.g. "4", "7"), and — the bigger
// problem — zero recall on marks that are highlighter-only with no X
// stroke, which this specific form turned out to have plenty of. Kept as
// a selectable mode rather than discarded so it can be compared directly
// against a real photo instead of just my synthetic one.
function findXShapeMarks(canvas) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  cv.imshow(maskCanvas, binary);

  const minDim = MIN_BOX_FRAC * Math.min(canvas.width, canvas.height);
  const maxDim = MAX_BOX_FRAC * Math.min(canvas.width, canvas.height);
  const pipeline = { xCandidates: 0, greenCandidates: 0, afterShapeFilter: 0 };

  // ── X-shape matches: pair up diagonal Hough line segments ──
  const lines = new cv.Mat();
  cv.HoughLinesP(binary, lines, 1, Math.PI / 180, 12, Math.max(6, minDim * 0.5), 2);
  const diagA = [], diagB = []; // ~45° and ~135°, since an X is two opposing diagonals
  for (let i = 0; i < lines.rows; i++) {
    const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1];
    const x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length < minDim * 0.5 || length > maxDim * 1.2) continue;
    const angle = ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 180) % 180;
    const seg = { x0: Math.min(x1, x2), y0: Math.min(y1, y2), x1: Math.max(x1, x2), y1: Math.max(y1, y2) };
    if (angle >= 25 && angle <= 65) diagA.push(seg);
    else if (angle >= 115 && angle <= 155) diagB.push(seg);
  }
  lines.delete();

  const xMarks = [];
  const usedB = new Set();
  for (const a of diagA) {
    let best = -1, bestScore = -1;
    for (let j = 0; j < diagB.length; j++) {
      if (usedB.has(j)) continue;
      const b = diagB[j];
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox <= 0 || oy <= 0) continue; // the two diagonals must actually cross, not just sit nearby
      const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0);
      const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
      const w = x1 - x0, h = y1 - y0;
      if (w < minDim || w > maxDim || h < minDim || h > maxDim) continue;
      const aspect = h > 0 ? w / h : 0;
      if (aspect < 0.5 || aspect > 2.0) continue;
      const score = Math.min(ox, oy);
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best !== -1) {
      usedB.add(best);
      const b = diagB[best];
      const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0);
      const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
      xMarks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: 0.8, kind: "x" });
    }
  }
  pipeline.xCandidates = xMarks.length;

  // ── Green blobs: direct color mask, not anchored to any box ──
  const channels = new cv.MatVector();
  cv.split(src, channels);
  const avgRB = new cv.Mat();
  cv.addWeighted(channels.get(0), 0.5, channels.get(2), 0.5, 0, avgRB);
  const greenDiff = new cv.Mat();
  cv.subtract(channels.get(1), avgRB, greenDiff);
  const greenMask = new cv.Mat();
  cv.threshold(greenDiff, greenMask, 15, 255, cv.THRESH_BINARY);
  channels.delete(); avgRB.delete(); greenDiff.delete();

  const gLabels = new cv.Mat(), gStats = new cv.Mat(), gCentroids = new cv.Mat();
  const gNumLabels = cv.connectedComponentsWithStats(greenMask, gLabels, gStats, gCentroids, 8, cv.CV_32S);
  greenMask.delete(); gLabels.delete(); gCentroids.delete();
  const greenMarks = [];
  for (let i = 1; i < gNumLabels; i++) {
    const w = gStats.data32S[i * 5 + 2], h = gStats.data32S[i * 5 + 3];
    if (w < minDim || w > maxDim || h < minDim || h > maxDim) continue;
    const aspect = h > 0 ? w / h : 0;
    if (aspect < 0.5 || aspect > 2.0) continue;
    const area = gStats.data32S[i * 5 + 4];
    greenMarks.push({
      x: gStats.data32S[i * 5], y: gStats.data32S[i * 5 + 1], w, h,
      score: Math.min(1, area / (w * h) + 0.3), kind: "green",
    });
  }
  gStats.delete();
  pipeline.greenCandidates = greenMarks.length;

  // Union the two signals, dropping an X match that's basically on top of
  // an already-found green blob (same mark, found twice).
  const cells = greenMarks.slice();
  for (const m of xMarks) {
    const dup = cells.some((c) => Math.abs(c.x - m.x) < minDim * 0.5 && Math.abs(c.y - m.y) < minDim * 0.5);
    if (!dup) cells.push(m);
  }
  pipeline.afterShapeFilter = cells.length;

  src.delete(); gray.delete(); blurred.delete(); binary.delete();

  return { cells, cellThresh: 0.4, maskCanvas, pipeline: { ...pipeline, imageW: canvas.width, imageH: canvas.height } };
}

// Otsu's method applied to an arbitrary array of continuous values instead
// of an 8-bit pixel histogram — finds the threshold that best separates the
// array into two clusters by maximizing between-cluster variance.
function otsu1d(values, nbins = 256) {
  const vmin = Math.min(...values);
  const vmax = Math.max(...values);
  if (vmax <= vmin) return vmin;
  const hist = new Array(nbins).fill(0);
  const binWidth = (vmax - vmin) / nbins;
  for (const v of values) {
    const b = Math.min(nbins - 1, Math.floor((v - vmin) / binWidth));
    hist[b]++;
  }
  const total = values.length;
  let sumTotal = 0;
  for (let t = 0; t < nbins; t++) sumTotal += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, bestBin = 0;
  for (let t = 0; t < nbins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumTotal - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) ** 2;
    if (varBetween > maxVar) { maxVar = varBetween; bestBin = t; }
  }
  return vmin + (bestBin + 1) * binWidth;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderResult(expectedTotal) {
  state.viewCtx.clearRect(0, 0, state.viewCanvas.width, state.viewCanvas.height);

  if (state.showingMask && state.maskCanvas) {
    state.viewCtx.drawImage(state.maskCanvas, 0, 0);
    el("totalResult").textContent = "Detection mask";
    el("detectedNote").textContent = "White = what the algorithm treats as ink/border. This is the exact image box-finding runs on — screenshot it if something looks off.";
    return;
  }

  state.viewCtx.drawImage(state.workCanvas, 0, 0);

  const effectiveThresh = state.cellThresh + state.adjust;
  let count = 0;
  for (const c of state.cells) {
    const marked = c.score >= effectiveThresh;
    if (marked) count++;
    state.viewCtx.strokeStyle = marked ? "#16a34a" : "rgba(37,99,235,0.35)";
    state.viewCtx.lineWidth = marked ? 3 : 1.5;
    state.viewCtx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
  }

  el("totalResult").textContent = `${count} marked`;
  let note = state.method === "xshape"
    ? `${count} marks found directly (X-shapes and green blobs) — this mode doesn't locate blank boxes.`
    : `${state.cells.length} boxes found — ${count} look marked, ${state.cells.length - count} blank.`;
  if (expectedTotal) {
    const against = state.method === "xshape" ? count : state.cells.length;
    if (against !== expectedTotal) {
      note += ` (You said ${expectedTotal} total — found ${against}, off by ${Math.abs(against - expectedTotal)}.)`;
    }
  }
  el("detectedNote").textContent = note;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────
// Lets a user paste real data back to the developer when something's off,
// since Claude Code has no way to read photos shared in conversation.

function buildDiagnosticsText() {
  const cells = state.cells;
  const W = state.workCanvas.width, H = state.workCanvas.height;
  const effectiveThresh = state.cellThresh + state.adjust;

  // combined mark-score histogram, 20 buckets 0..1
  const bucketCount = 20;
  const buckets = new Array(bucketCount).fill(0);
  for (const c of cells) {
    const b = Math.min(bucketCount - 1, Math.max(0, Math.floor(c.score * bucketCount)));
    buckets[b]++;
  }
  const histLines = buckets.map((n, i) => {
    const lo = (i / bucketCount).toFixed(2);
    const marker = (i / bucketCount) <= effectiveThresh && effectiveThresh < ((i + 1) / bucketCount) ? "  <- threshold" : "";
    return `  ${lo}: ${"#".repeat(Math.min(50, n))} (${n})${marker}`;
  });

  // coarse 10x8 spatial density grid, to spot whole missing regions
  const gridCols = 10, gridRows = 8;
  const density = Array.from({ length: gridRows }, () => new Array(gridCols).fill(0));
  for (const c of cells) {
    const gx = Math.min(gridCols - 1, Math.floor(((c.x + c.w / 2) / W) * gridCols));
    const gy = Math.min(gridRows - 1, Math.floor(((c.y + c.h / 2) / H) * gridRows));
    density[gy][gx]++;
  }
  const densityLines = density.map((row) => row.map((n) => String(n).padStart(3)).join(" "));

  const widths = cells.map((c) => c.w).sort((a, b) => a - b);
  const heights = cells.map((c) => c.h).sort((a, b) => a - b);
  const med = (arr) => arr[Math.floor(arr.length / 2)];

  const sample = cells.slice(0, 25).map((c) => {
    const extra = state.method === "xshape"
      ? `kind=${c.kind}`
      : `fill=${c.fill.toFixed(3)} green=${c.green.toFixed(3)}`;
    return `  x=${c.x} y=${c.y} w=${c.w} h=${c.h} ${extra} score=${c.score.toFixed(3)} marked=${c.score >= effectiveThresh}`;
  });

  return [
    `Count X diagnostics — ${new Date().toISOString()}`,
    ``,
    `Image: ${W}x${H}`,
    `Expected total given: ${state.expectedTotal ?? "(none)"}`,
    `Method: ${state.method}`,
    state.method === "xshape"
      ? `Pipeline (last run): xCandidates=${state.pipeline.xCandidates} greenCandidates=${state.pipeline.greenCandidates} afterShapeFilter=${state.pipeline.afterShapeFilter}`
      : `Pipeline (last run): rawComponents=${state.pipeline.rawComponents} plausibleSized=${state.pipeline.plausibleSized} modeWidth=${state.pipeline.modeWidth} afterShapeFilter=${state.pipeline.afterShapeFilter}`,
    `Detected cells: ${cells.length}`,
    `Cell size: width min=${widths[0]} median=${med(widths)} max=${widths[widths.length - 1]} | height min=${heights[0]} median=${med(heights)} max=${heights[heights.length - 1]}`,
    `Classification threshold (auto + slider adjust): ${effectiveThresh.toFixed(3)} (auto=${state.cellThresh.toFixed(3)}, slider adjust=${state.adjust.toFixed(3)})`,
    `Marked: ${cells.filter((c) => c.score >= effectiveThresh).length} / ${cells.length}`,
    ``,
    `Mark-score histogram (0=blank, 1=marked; score = max of blob fill ratio and greenness):`,
    ...histLines,
    ``,
    `Spatial density (cells found per region, image divided into a ${gridCols}x${gridRows} grid, top-left to bottom-right):`,
    ...densityLines,
    ``,
    `First 25 detected cells (raw):`,
    ...sample,
  ].join("\n");
}

async function copyDiagnostics() {
  if (!state.cells) return;
  const text = buildDiagnosticsText();
  try {
    await navigator.clipboard.writeText(text);
    el("diagnosticsStatus").textContent = "Copied — paste it in chat.";
  } catch {
    // Clipboard API can be blocked in some contexts; fall back to a visible,
    // selectable textarea the user can copy from manually.
    const ta = el("diagnosticsFallback");
    ta.value = text;
    ta.hidden = false;
    ta.focus();
    ta.select();
    el("diagnosticsStatus").textContent = "Couldn't copy automatically — select all the text below and copy it.";
  }
}
