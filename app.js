"use strict";

const MAX_WORK_WIDTH = 1400;
const CELL_PX = 60; // rectified cell size used for both processing and the annotated preview
const CORNER_LABELS = ["top-left", "top-right", "bottom-right", "bottom-left"];

const state = {
  cvReady: false,
  workCanvas: document.createElement("canvas"),
  viewCanvas: document.getElementById("viewCanvas"),
  regions: [], // { corners: [{x,y}x4], rows, cols, cellInk?: number[][], annoCanvas?: HTMLCanvasElement }
  picking: null, // { corners: [{x,y}...] } while adding a region
  threshold: 0.07,
};
state.workCtx = state.workCanvas.getContext("2d");
state.viewCtx = state.viewCanvas.getContext("2d");

const el = (id) => document.getElementById(id);

// ── OpenCV readiness ────────────────────────────────────────────────────────

window.addEventListener("opencv-ready", () => {
  state.cvReady = true;
  el("status").textContent = "Ready.";
  el("processBtn").disabled = state.regions.length === 0;
});

// ── Image loading ────────────────────────────────────────────────────────────

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

    state.regions = [];
    state.picking = null;
    el("pendingForm").hidden = true;
    el("pickingControls").hidden = false;
    el("resetBtn").disabled = false;
    el("regionsSection").hidden = true;
    el("resultsSection").hidden = true;
    updateRegionsTable();
    redraw();

    URL.revokeObjectURL(url);
  };
  img.src = url;
}

el("resetBtn").addEventListener("click", () => {
  state.regions = [];
  state.picking = null;
  el("fileInput").value = "";
  state.workCanvas.width = 0;
  state.workCanvas.height = 0;
  state.viewCanvas.width = 0;
  state.viewCanvas.height = 0;
  el("pickingControls").hidden = true;
  el("pendingForm").hidden = true;
  el("regionsSection").hidden = true;
  el("resultsSection").hidden = true;
  el("resetBtn").disabled = true;
});

// ── Corner picking ───────────────────────────────────────────────────────────

el("addRegionBtn").addEventListener("click", () => {
  state.picking = { corners: [] };
  el("undoCornerBtn").disabled = true;
  el("cancelRegionBtn").disabled = false;
  el("pendingForm").hidden = true;
  updatePickHint();
  redraw();
});

el("undoCornerBtn").addEventListener("click", () => {
  if (!state.picking) return;
  state.picking.corners.pop();
  el("undoCornerBtn").disabled = state.picking.corners.length === 0;
  updatePickHint();
  redraw();
});

el("cancelRegionBtn").addEventListener("click", () => {
  state.picking = null;
  el("undoCornerBtn").disabled = true;
  el("cancelRegionBtn").disabled = true;
  el("pendingForm").hidden = true;
  el("pickHint").textContent = "";
  redraw();
});

el("discardRegionBtn").addEventListener("click", () => {
  state.picking = null;
  el("pendingForm").hidden = true;
  el("cancelRegionBtn").disabled = true;
  el("pickHint").textContent = "";
  redraw();
});

el("confirmRegionBtn").addEventListener("click", () => {
  if (!state.picking || state.picking.corners.length !== 4) return;
  const rows = Math.max(1, parseInt(el("pendingRows").value, 10) || 1);
  const cols = Math.max(1, parseInt(el("pendingCols").value, 10) || 1);
  state.regions.push({ corners: state.picking.corners, rows, cols });
  state.picking = null;
  el("pendingForm").hidden = true;
  el("cancelRegionBtn").disabled = true;
  el("pickHint").textContent = "";
  updateRegionsTable();
  redraw();
});

state.viewCanvas.addEventListener("click", (evt) => {
  if (!state.picking || state.picking.corners.length >= 4) return;
  const { x, y } = getCanvasCoords(evt);
  state.picking.corners.push({ x, y });
  el("undoCornerBtn").disabled = false;
  updatePickHint();
  redraw();
  if (state.picking.corners.length === 4) {
    el("pendingForm").hidden = false;
  }
});

function getCanvasCoords(evt) {
  const rect = state.viewCanvas.getBoundingClientRect();
  const scaleX = state.viewCanvas.width / rect.width;
  const scaleY = state.viewCanvas.height / rect.height;
  return {
    x: Math.round((evt.clientX - rect.left) * scaleX),
    y: Math.round((evt.clientY - rect.top) * scaleY),
  };
}

function updatePickHint() {
  const n = state.picking ? state.picking.corners.length : 0;
  if (n >= 4) {
    el("pickHint").textContent = "4 corners placed — fill in rows/columns below.";
  } else {
    el("pickHint").textContent = `Click the ${CORNER_LABELS[n]} corner of the grid block (${n}/4).`;
  }
}

// ── Regions table ────────────────────────────────────────────────────────────

function updateRegionsTable() {
  const tbody = document.querySelector("#regionsTable tbody");
  tbody.innerHTML = "";
  state.regions.forEach((region, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${idx + 1}</td><td>${region.rows} × ${region.cols}</td><td>${region.rows * region.cols}</td><td></td>`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "link-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      state.regions.splice(idx, 1);
      updateRegionsTable();
      redraw();
    });
    tr.lastElementChild.appendChild(removeBtn);
    tbody.appendChild(tr);
  });
  el("regionsSection").hidden = state.regions.length === 0;
  el("processBtn").disabled = state.regions.length === 0 || !state.cvReady;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function redraw() {
  if (state.viewCanvas.width === 0) return;
  state.viewCtx.clearRect(0, 0, state.viewCanvas.width, state.viewCanvas.height);
  state.viewCtx.drawImage(state.workCanvas, 0, 0);

  state.regions.forEach((region, idx) => drawQuad(region.corners, "#2563eb", String(idx + 1)));

  if (state.picking) {
    drawPickingProgress(state.picking.corners);
  }
}

function drawQuad(corners, color, label) {
  const ctx = state.viewCtx;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();

  if (label) {
    const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
    const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
    ctx.fillStyle = color;
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pad = 14;
    ctx.beginPath();
    ctx.arc(cx, cy, pad, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.fillText(label, cx, cy + 1);
  }
}

function drawPickingProgress(corners) {
  const ctx = state.viewCtx;
  ctx.strokeStyle = "#dc2626";
  ctx.fillStyle = "#dc2626";
  ctx.lineWidth = 2;
  ctx.beginPath();
  corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (corners.length === 4) ctx.closePath();
  ctx.stroke();
  corners.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ── Processing ───────────────────────────────────────────────────────────────

el("thresholdSlider").addEventListener("input", (e) => {
  state.threshold = Number(e.target.value) / 100;
  el("thresholdValue").textContent = `${e.target.value}%`;
  if (state.regions.some((r) => r.cellInk)) renderResults();
});
state.threshold = Number(el("thresholdSlider").value) / 100;
el("thresholdValue").textContent = `${el("thresholdSlider").value}%`;

el("processBtn").addEventListener("click", () => {
  if (!state.cvReady) {
    alert("OpenCV is still loading — try again in a moment.");
    return;
  }
  el("processBtn").disabled = true;
  el("processBtn").textContent = "Processing…";
  // Let the UI repaint ("Processing…") before the synchronous CV work blocks the thread.
  setTimeout(() => {
    state.regions.forEach((region) => {
      const { cellInk, annoCanvas } = processRegion(region);
      region.cellInk = cellInk;
      region.annoCanvas = annoCanvas;
    });
    renderResults();
    el("processBtn").disabled = false;
    el("processBtn").textContent = "Count X's";
  }, 30);
});

function processRegion(region) {
  const { corners, rows, cols } = region;
  const dstW = cols * CELL_PX;
  const dstH = rows * CELL_PX;

  const src = cv.imread(state.workCanvas);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dstW, 0, dstW, dstH, 0, dstH]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

  const gray = new cv.Mat();
  cv.cvtColor(dst, gray, cv.COLOR_RGBA2GRAY);

  // Mean darkness per cell (not a binarize-then-count), validated to hold up
  // far better than an Otsu-threshold approach once corner clicks are even
  // slightly imprecise — Otsu's cutoff shifts per-run with the whole rectified
  // image's histogram, which is noisier than a plain average.
  const insetFrac = 0.18;
  const inset = Math.round(CELL_PX * insetFrac);
  const cellInk = [];
  for (let r = 0; r < rows; r++) {
    const rowArr = [];
    for (let c = 0; c < cols; c++) {
      const rectX = c * CELL_PX + inset;
      const rectY = r * CELL_PX + inset;
      const rectW = CELL_PX - 2 * inset;
      const rectH = CELL_PX - 2 * inset;
      const roi = gray.roi(new cv.Rect(rectX, rectY, rectW, rectH));
      const meanVal = cv.mean(roi)[0];
      roi.delete();
      rowArr.push(1 - meanVal / 255);
    }
    cellInk.push(rowArr);
  }

  const annoCanvas = document.createElement("canvas");
  annoCanvas.width = dstW;
  annoCanvas.height = dstH;
  cv.imshow(annoCanvas, dst);

  src.delete();
  srcTri.delete();
  dstTri.delete();
  M.delete();
  dst.delete();
  gray.delete();

  return { cellInk, annoCanvas };
}

function renderResults() {
  const container = el("regionResults");
  container.innerHTML = "";
  let grandTotal = 0;
  let anyProcessed = false;

  state.regions.forEach((region, idx) => {
    if (!region.cellInk) return;
    anyProcessed = true;
    const { count, canvas } = renderRegionOverlay(region);
    grandTotal += count;

    const card = document.createElement("div");
    card.className = "region-result-card";
    const h3 = document.createElement("h3");
    h3.textContent = `Region ${idx + 1}: ${count} / ${region.rows * region.cols} marked`;
    card.appendChild(h3);
    card.appendChild(canvas);
    container.appendChild(card);
  });

  if (anyProcessed) {
    el("totalResult").textContent = `Total X's: ${grandTotal}`;
    el("resultsSection").hidden = false;
  }
}

function renderRegionOverlay(region) {
  const { cellInk, annoCanvas, rows, cols } = region;
  const out = document.createElement("canvas");
  out.width = annoCanvas.width;
  out.height = annoCanvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(annoCanvas, 0, 0);

  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const marked = cellInk[r][c] >= state.threshold;
      if (marked) count++;
      const x0 = c * CELL_PX;
      const y0 = r * CELL_PX;
      ctx.strokeStyle = marked ? "#16a34a" : "rgba(0,0,0,0.12)";
      ctx.lineWidth = marked ? 3 : 1;
      ctx.strokeRect(x0 + 2, y0 + 2, CELL_PX - 4, CELL_PX - 4);
    }
  }
  return { count, canvas: out };
}
