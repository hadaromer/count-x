"use strict";

const MAX_WORK_WIDTH = 1600;
const DEFAULT_MIN_SIZE_FRAC = 0.015;
// Swept when the user gives an expected total, to find whichever size floor
// lands closest to it.
const MIN_SIZE_FRAC_SWEEP = [0.006, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025, 0.03, 0.04];

const state = {
  cvReady: false,
  workCanvas: document.createElement("canvas"),
  viewCanvas: document.getElementById("viewCanvas"),
  cells: null,     // [{x,y,w,h,ink}] in workCanvas pixel coordinates, after detection
  cellThresh: 0.5, // auto-computed split point between "blank" and "marked" ink scores
  adjust: 0,       // user's slider offset from cellThresh, -0.15..+0.15
  pipeline: null,  // stage counts from the most recent detection run, for diagnostics
  expectedTotal: null,
  maskCanvas: null,  // the binary threshold image findContours actually ran on, for visual debugging
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
  if (state.cells) detectAndClassify(); // re-run detection using the new target
});

el("copyDiagnosticsBtn").addEventListener("click", copyDiagnostics);

el("showMaskBtn").addEventListener("click", () => {
  state.showingMask = !state.showingMask;
  el("showMaskBtn").textContent = state.showingMask ? "Show normal view" : "Show detection mask";
  renderResult(state.expectedTotal);
});

// ── Detection ────────────────────────────────────────────────────────────────

function detectAndClassify() {
  el("status").textContent = "Finding boxes…";
  el("resultsSection").hidden = true;
  // Let "Finding boxes…" paint before the synchronous CV work blocks the thread.
  setTimeout(() => {
    const expectedRaw = el("expectedTotal").value.trim();
    const expectedTotal = expectedRaw ? Math.max(1, parseInt(expectedRaw, 10)) : null;
    state.expectedTotal = expectedTotal;
    try {
      const { cells, cellThresh, pipeline, maskCanvas } = expectedTotal
        ? findCellsBestMatch(state.workCanvas, expectedTotal)
        : findCells(state.workCanvas, DEFAULT_MIN_SIZE_FRAC);
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

// Tries a spread of size-floor settings (see findCells' minSizeFrac) and
// keeps whichever gets the detected box count closest to a total the user
// already knows — useful for forms with a known, fixed box count (ballots,
// attendance sheets), and a good fallback if the default floor is a bit off
// for an unusually small- or large-boxed form.
function findCellsBestMatch(canvas, expectedTotal) {
  let best = null;
  for (const frac of MIN_SIZE_FRAC_SWEEP) {
    const result = findCells(canvas, frac);
    const diff = Math.abs(result.cells.length - expectedTotal);
    if (!best || diff < best.diff) best = { ...result, diff };
    if (diff === 0) break;
  }
  return best;
}

// Finds every bordered box in the image and scores how "inked" its interior
// is, fully automatically — no corners or grid size from the user.
//
// Detection: threshold the photo to a binary foreground mask (ink + borders
// both count as foreground, blank paper doesn't), then find contours with
// RETR_CCOMP and keep only the HOLE contours (those with a parent) — each
// box's enclosed interior is a hole inside its border. This matters because
// on a densely packed real form, adjacent boxes' borders routinely touch or
// come within a pixel of each other after the photo's resized/thresholded;
// that can fuse the whole grid into one connected blob under a simpler
// "take each box's own outer ring" approach (RETR_EXTERNAL), which
// catastrophically undercounts. Each box's hole stays correctly segmented
// by the border mesh even when the mesh itself is fully fused, so this is
// robust either way.
//
// Before contour-finding, strip the mask down to thin strokes only, via
// distanceTransform (each foreground pixel's distance to the nearest
// background pixel — low for a thin printed border or pen line, high for
// a solid interior fill or thick ink). A MARKED box's interior ink — a
// highlighter fill, or an X whose diagonals touch the border at multiple
// points — destroys that box's hole entirely or slices it into undersized
// fragments; without this step, a marked box simply disappears from
// detection rather than being misclassified. Stripping out everything but
// thin strokes first recovers the border (and its hole) regardless of
// what's marked inside it.
//
// A real form's printed reference numbers/labels (e.g. "0", "8", "9", "6")
// have their own enclosed holes topologically identical to a checkbox's —
// findContours can't tell a hollow digit apart from a hollow box by shape
// alone. What does tell them apart: a box a person can physically mark with
// a pen occupies a non-trivial fraction of the page, while a printed
// label's internal counter never does — regardless of how many such label
// holes exist, which also makes it unsafe to anchor "typical cell size" on
// a simple median/mode of all candidates (label holes can easily outnumber
// real boxes). So minSizeFrac is applied as an absolute floor *before* the
// median is computed, not as part of the relative size filter below it.
//
// Among the survivors, keep ones close in size to that filtered pool's
// median (real cells cluster at one size), a reasonable aspect ratio, and a
// fill ratio (contour area vs. its own bounding-box area) that confirms
// it's a filled hole shape, not a sliver/fragment. A second pass handles
// boxes whose hole got sliced into several undersized fragments (an X
// touching the border at multiple points): fragments that share a parent
// border and whose *combined* footprint is cell-sized are merged into one
// candidate — but only when none of that parent's fragments were already
// cell-sized alone, so a genuinely fused mesh of many separate blank boxes
// (which legitimately share one parent) is never merged into a single
// giant box.
//
// Classification: per cell, measure two independent signals in an inset
// crop — grayscale darkness (pen ink, pencil) and "greenness" (G channel
// vs. the other two, for highlighter-style marks that are barely darker
// than blank paper and so are invisible to a pure darkness score). A cell's
// mark score is the stronger of the two. Then find the natural split
// between "blank" and "marked" scores via a second, cell-level Otsu
// threshold (not pixel-level) — this self-calibrates to whatever a blank
// box actually looks like in this specific photo (handles non-white cell
// fills, shadows, scan tint) and to whatever fraction of boxes are
// actually marked, rather than assuming marks are a minority.
function findCells(canvas, minSizeFrac) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const dist = new cv.Mat();
  cv.distanceTransform(binary, dist, cv.DIST_L2, 3);
  const thinRaw = new cv.Mat();
  cv.threshold(dist, thinRaw, 2.2, 255, cv.THRESH_BINARY_INV);
  const thin = new cv.Mat();
  thinRaw.convertTo(thin, cv.CV_8U);
  cv.bitwise_and(thin, binary, thin); // THRESH_BINARY_INV also marks background (dist=0) — restrict back to foreground
  dist.delete(); thinRaw.delete();

  // Keep a viewable copy of the exact mask findContours runs on — lets a
  // user screenshot what the algorithm actually sees and share that back,
  // since there's no way to read a photo shared in chat directly.
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  cv.imshow(maskCanvas, thin);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(thin, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

  const minDim = minSizeFrac * Math.min(canvas.width, canvas.height);
  const pipeline = { rawContours: contours.size(), holeContours: 0, afterMinSize: 0, mergedFragments: 0, afterShapeFilter: 0 };

  const byParent = new Map(); // parentIdx -> [{x,y,w,h,area}]
  const pass1 = [];
  const coveredParents = new Set();
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const parent = hierarchy.data32S[i * 4 + 3];
    if (parent !== -1) {
      pipeline.holeContours++;
      const rect = cv.boundingRect(cnt);
      const area = cv.contourArea(cnt);
      if (rect.width >= 4 && rect.height >= 4) {
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, area });
      }
      if (rect.width >= minDim && rect.height >= minDim) {
        pipeline.afterMinSize++;
        const rectArea = rect.width * rect.height;
        pass1.push({
          x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          rectArea, fillRatio: area / rectArea,
          aspect: rect.height > 0 ? rect.width / rect.height : 0,
        });
        coveredParents.add(parent);
      }
    }
    cnt.delete();
  }

  const pass1Areas = pass1.map((c) => c.rectArea).sort((a, b) => a - b);
  const medianArea = pass1Areas.length > 0 ? pass1Areas[Math.floor(pass1Areas.length / 2)] : 0;

  // Fragment merge: only for parents none of whose children individually
  // qualified — i.e. every fragment there is undersized, consistent with
  // one cell's hole having been sliced up, not a fused mesh of real boxes
  // (those already have legitimately cell-sized individual holes above).
  const pass2 = [];
  for (const [parent, kids] of byParent) {
    if (coveredParents.has(parent)) continue;
    const x0 = Math.min(...kids.map((k) => k.x));
    const y0 = Math.min(...kids.map((k) => k.y));
    const x1 = Math.max(...kids.map((k) => k.x + k.w));
    const y1 = Math.max(...kids.map((k) => k.y + k.h));
    const w = x1 - x0, h = y1 - y0;
    const rectArea = w * h;
    const totalArea = kids.reduce((s, k) => s + k.area, 0);
    pass2.push({
      x: x0, y: y0, w, h, rectArea,
      fillRatio: rectArea > 0 ? totalArea / rectArea : 0,
      aspect: h > 0 ? w / h : 0,
    });
  }
  pipeline.mergedFragments = pass2.length;

  const candidates = pass1.concat(pass2);
  let cells = [];
  if (candidates.length > 0 && medianArea > 0) {
    cells = candidates.filter((c) =>
      c.rectArea >= 0.4 * medianArea &&
      c.rectArea <= 2.2 * medianArea &&
      c.aspect >= 0.5 &&
      c.aspect <= 2.0 &&
      c.fillRatio >= 0.3
    );
  }
  pipeline.afterShapeFilter = cells.length;

  const insetFrac = 0.12;
  for (const c of cells) {
    const insetX = Math.round(c.w * insetFrac);
    const insetY = Math.round(c.h * insetFrac);
    const rw = c.w - 2 * insetX;
    const rh = c.h - 2 * insetY;
    if (rw <= 0 || rh <= 0) { c.ink = 0; c.green = 0; c.score = 0; continue; }
    const rect = new cv.Rect(c.x + insetX, c.y + insetY, rw, rh);

    const roi = gray.roi(rect);
    const meanVal = cv.mean(roi)[0];
    roi.delete();
    c.ink = 1 - meanVal / 255;

    // Marks on this form aren't just dark pen ink — many are a green
    // highlighter, which grayscale darkness barely registers (highlighter
    // is light) and can't tell apart from the form's own printed grid
    // lines/shadow anyway. Measure how much the interior's average color
    // leans green (G channel vs. the other two) as a second, independent
    // signal; a cell counts as marked if *either* signal is strong.
    const roiColor = src.roi(rect);
    const meanColor = cv.mean(roiColor);
    roiColor.delete();
    const greenDiff = meanColor[1] - (meanColor[0] + meanColor[2]) / 2;
    c.green = Math.max(0, Math.min(1, greenDiff / 50));

    c.score = Math.max(c.ink, c.green);
  }

  const cellThresh = cells.length >= 2 ? otsu1d(cells.map((c) => c.score)) : 0.5;

  src.delete(); gray.delete(); blurred.delete(); binary.delete(); thin.delete();
  contours.delete(); hierarchy.delete();

  return { cells, cellThresh, maskCanvas, pipeline: { ...pipeline, minSizeFrac, imageW: canvas.width, imageH: canvas.height } };
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
  let note = `${state.cells.length} boxes found — ${count} look marked, ${state.cells.length - count} blank.`;
  if (expectedTotal && state.cells.length !== expectedTotal) {
    note += ` (You said ${expectedTotal} total — closest match found, off by ${Math.abs(state.cells.length - expectedTotal)}. Check the photo covers every box clearly.)`;
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

  const sample = cells.slice(0, 25).map((c) =>
    `  x=${c.x} y=${c.y} w=${c.w} h=${c.h} ink=${c.ink.toFixed(3)} green=${c.green.toFixed(3)} score=${c.score.toFixed(3)} marked=${c.score >= effectiveThresh}`
  );

  return [
    `Count X diagnostics — ${new Date().toISOString()}`,
    ``,
    `Image: ${W}x${H}`,
    `Expected total given: ${state.expectedTotal ?? "(none)"}`,
    `Pipeline (last run): rawContours=${state.pipeline.rawContours} holeContours=${state.pipeline.holeContours} afterMinSize=${state.pipeline.afterMinSize} mergedFragments=${state.pipeline.mergedFragments} afterShapeFilter=${state.pipeline.afterShapeFilter} minSizeFrac=${state.pipeline.minSizeFrac}`,
    `Detected cells: ${cells.length}`,
    `Cell size: width min=${widths[0]} median=${med(widths)} max=${widths[widths.length - 1]} | height min=${heights[0]} median=${med(heights)} max=${heights[heights.length - 1]}`,
    `Classification threshold (auto + slider adjust): ${effectiveThresh.toFixed(3)} (auto=${state.cellThresh.toFixed(3)}, slider adjust=${state.adjust.toFixed(3)})`,
    `Marked: ${cells.filter((c) => c.score >= effectiveThresh).length} / ${cells.length}`,
    ``,
    `Mark-score histogram (0=blank, 1=marked; score = max of grayscale ink and greenness):`,
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
