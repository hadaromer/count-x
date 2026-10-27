"use strict";

const MAX_WORK_WIDTH = 1600;

const state = {
  cvReady: false,
  workCanvas: document.createElement("canvas"),
  viewCanvas: document.getElementById("viewCanvas"),
  cells: null, // [{x,y,w,h,ink}] in workCanvas pixel coordinates, after detection
  threshold: 0.07,
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
  state.threshold = Number(e.target.value) / 100;
  el("thresholdValue").textContent = `${e.target.value}%`;
  if (state.cells) renderResult();
});
state.threshold = Number(el("thresholdSlider").value) / 100;
el("thresholdValue").textContent = `${el("thresholdSlider").value}%`;

// ── Detection ────────────────────────────────────────────────────────────────

function detectAndClassify() {
  el("status").textContent = "Finding boxes…";
  el("resultsSection").hidden = true;
  // Let "Finding boxes…" paint before the synchronous CV work blocks the thread.
  setTimeout(() => {
    try {
      state.cells = findCells(state.workCanvas);
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
    renderResult();
  }, 30);
}

// Finds every bordered box in the image and scores how "inked" its interior
// is, fully automatically — no corners or grid size from the user.
//
// Approach: threshold the photo to a binary foreground mask (ink + borders
// both count as foreground, background paper doesn't), find each box's
// border as its own connected-component contour, then keep only the
// contours that actually look like a box: roughly the same size as the
// other candidates (real cells all tend to be close to the same size;
// stray text or noise usually isn't), a reasonable aspect ratio, and a high
// fill ratio (contour area close to its own bounding-box area — a hollow
// border rectangle has that; a thin partial fragment or a disconnected ink
// blob like an X doesn't, which is what keeps X marks from being
// mistaken for extra boxes). Validated against synthetic ground-truth
// grids across varied pen widths, cell sizes, rotation, and mark density.
function findCells(canvas) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const candidates = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const rect = cv.boundingRect(cnt);
    const rectArea = rect.width * rect.height;
    if (rectArea > 0) {
      const area = cv.contourArea(cnt);
      candidates.push({
        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
        rectArea, fillRatio: area / rectArea,
        aspect: rect.height > 0 ? rect.width / rect.height : 0,
      });
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
      c.fillRatio >= 0.6
    );
  }

  for (const c of cells) {
    const insetX = Math.round(c.w * 0.2);
    const insetY = Math.round(c.h * 0.2);
    const rw = c.w - 2 * insetX;
    const rh = c.h - 2 * insetY;
    if (rw <= 0 || rh <= 0) { c.ink = 0; continue; }
    const roi = gray.roi(new cv.Rect(c.x + insetX, c.y + insetY, rw, rh));
    const meanVal = cv.mean(roi)[0];
    roi.delete();
    c.ink = 1 - meanVal / 255;
  }

  src.delete(); gray.delete(); blurred.delete(); binary.delete();
  contours.delete(); hierarchy.delete();

  return cells;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderResult() {
  state.viewCtx.clearRect(0, 0, state.viewCanvas.width, state.viewCanvas.height);
  state.viewCtx.drawImage(state.workCanvas, 0, 0);

  let count = 0;
  for (const c of state.cells) {
    const marked = c.ink >= state.threshold;
    if (marked) count++;
    state.viewCtx.strokeStyle = marked ? "#16a34a" : "rgba(37,99,235,0.35)";
    state.viewCtx.lineWidth = marked ? 3 : 1.5;
    state.viewCtx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
  }

  el("totalResult").textContent = `${count} marked`;
  el("detectedNote").textContent = `${state.cells.length} boxes found — ${count} look marked, ${state.cells.length - count} blank.`;
}
