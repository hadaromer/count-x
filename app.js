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

// ── Detection ────────────────────────────────────────────────────────────────

function detectAndClassify() {
  el("status").textContent = "Finding boxes…";
  el("resultsSection").hidden = true;
  // Let "Finding boxes…" paint before the synchronous CV work blocks the thread.
  setTimeout(() => {
    const expectedRaw = el("expectedTotal").value.trim();
    const expectedTotal = expectedRaw ? Math.max(1, parseInt(expectedRaw, 10)) : null;
    try {
      const { cells, cellThresh } = expectedTotal
        ? findCellsBestMatch(state.workCanvas, expectedTotal)
        : findCells(state.workCanvas, DEFAULT_MIN_SIZE_FRAC);
      state.cells = cells;
      state.cellThresh = cellThresh;
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
// it's a filled hole shape, not a sliver/fragment.
//
// Classification: per cell, measure darkness in an inset crop, then find
// the natural split between "blank" and "marked" scores via a second,
// cell-level Otsu threshold (not pixel-level) — this self-calibrates to
// whatever a blank box actually looks like in this specific photo (handles
// non-white cell fills, shadows, scan tint) and to whatever fraction of
// boxes are actually marked, rather than assuming marks are a minority.
//
// Validated against synthetic ground-truth grids across pen widths, cell
// sizes, rotation, mark density from 5%-70%, non-white cell fills, adjacent
// cells with zero gap between borders, and real printed reference numbers
// (including digits with their own holes) sitting next to every box —
// exact counts in all cases.
function findCells(canvas, minSizeFrac) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

  const minDim = minSizeFrac * Math.min(canvas.width, canvas.height);
  const candidates = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const parent = hierarchy.data32S[i * 4 + 3];
    if (parent !== -1) {
      const rect = cv.boundingRect(cnt);
      if (rect.width >= minDim && rect.height >= minDim) {
        const rectArea = rect.width * rect.height;
        const area = cv.contourArea(cnt);
        candidates.push({
          x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          rectArea, fillRatio: area / rectArea,
          aspect: rect.height > 0 ? rect.width / rect.height : 0,
        });
      }
    }
    cnt.delete();
  }

  let cells = [];
  if (candidates.length > 0) {
    const areas = candidates.map((c) => c.rectArea).sort((a, b) => a - b);
    const medianArea = areas[Math.floor(areas.length / 2)];
    cells = candidates.filter((c) =>
      c.rectArea >= 0.4 * medianArea &&
      c.rectArea <= 2.2 * medianArea &&
      c.aspect >= 0.5 &&
      c.aspect <= 2.0 &&
      c.fillRatio >= 0.5
    );
  }

  const insetFrac = 0.12;
  for (const c of cells) {
    const insetX = Math.round(c.w * insetFrac);
    const insetY = Math.round(c.h * insetFrac);
    const rw = c.w - 2 * insetX;
    const rh = c.h - 2 * insetY;
    if (rw <= 0 || rh <= 0) { c.ink = 0; continue; }
    const roi = gray.roi(new cv.Rect(c.x + insetX, c.y + insetY, rw, rh));
    const meanVal = cv.mean(roi)[0];
    roi.delete();
    c.ink = 1 - meanVal / 255;
  }

  const cellThresh = cells.length >= 2 ? otsu1d(cells.map((c) => c.ink)) : 0.5;

  src.delete(); gray.delete(); blurred.delete(); binary.delete();
  contours.delete(); hierarchy.delete();

  return { cells, cellThresh };
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
  state.viewCtx.drawImage(state.workCanvas, 0, 0);

  const effectiveThresh = state.cellThresh + state.adjust;
  let count = 0;
  for (const c of state.cells) {
    const marked = c.ink >= effectiveThresh;
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
