"use strict";

const MAX_WORK_WIDTH = 1600;


// ── Language ─────────────────────────────────────────────────────────────────
// The Hebrew page sets window.COUNTX_LANG = "he" before loading this script.
const LANG = window.COUNTX_LANG === "he" ? "he" : "en";
const STRINGS = {
  en: {
    ready: "Ready. Choose a photo to get started.",
    waitingCv: "Waiting for OpenCV to finish loading…",
    finding: "Finding marks…",
    failed: "Something went wrong analyzing that photo — try a different one.",
    noBoxes: "Couldn't find any boxes in this photo. Make sure the whole grid is visible and well-lit.",
    showMask: "Show detection mask",
    showNormal: "Show normal view",
    auto: "auto",
    maskTitle: "Detection mask",
    maskNote: "White = what the algorithm treats as ink/border. This is the exact image box-finding runs on — screenshot it if something looks off.",
    marked: (n) => `${n} marked`,
    notePlain: (n, c) => `${n} boxes found — ${c} look marked, ${n - c} blank.`,
    noteVirtual: (v) => ` (${v} boxes were placed from the grid rather than seen directly — dashed outlines.)`,
    noteExpected: (e, f, d) => ` (You said ${e} total — found ${f}, off by ${d}.)`,
    noteEdited: (n) => ` ${n} edited by hand (orange).`,
    copied: "Copied — paste it in chat.",
    copyFailed: "Couldn't copy automatically — select all the text below and copy it.",
  },
  he: {
    ready: "מוכן! בחרו תמונה כדי להתחיל 📷",
    waitingCv: "ממתין לטעינת מנוע הזיהוי…",
    finding: "מחפש תיבות וסימונים…",
    failed: "משהו השתבש בניתוח התמונה — נסו תמונה אחרת.",
    noBoxes: "לא נמצאו תיבות בתמונה. ודאו שכל הדף נראה בתמונה והתאורה טובה.",
    showMask: "הצג מה שהאתר רואה",
    showNormal: "חזרה לתמונה",
    auto: "אוטומטי",
    maskTitle: "מה שהאתר רואה",
    maskNote: "לבן = מה שהאתר מחשיב כדיו או קווים. אם משהו נראה לא תקין, אפשר לצלם מסך ולשלוח.",
    marked: (n) => `${n}`,
    notePlain: (n, c) => `נמצאו ${n} תיבות — ${c} מסומנות, ${n - c} ריקות.`,
    noteVirtual: (v) => ` (${v} תיבות הושלמו לפי הרשת ולא נראו ישירות — מסגרת מקווקוות.)`,
    noteExpected: (e, f, d) => ` (ציינתם ${e} תיבות — נמצאו ${f}, הפרש של ${d}. ${f > e ? "ייתכן שמספרים או אותיות זוהו בטעות כתיבות — לחצו על מסגרת שגויה כדי להסיר אותה." : "ייתכן שחלק מהדף חתוך או לא ברור בתמונה."})`,
    noteEdited: (n) => ` ${n} תוקנו ידנית (כתום).`,
    copied: "הועתק — אפשר להדביק ולשלוח.",
    copyFailed: "ההעתקה האוטומטית לא עבדה — סמנו את כל הטקסט שלמטה והעתיקו אותו.",
  },
};
const S = STRINGS[LANG];

// Anonymous, cookie-free usage counts (GoatCounter). Only an event name is
// ever sent — never the photo, the results, or anything about the sheet.
// Silently does nothing if the script is blocked or not loaded.
function track(name) {
  try {
    if (window.goatcounter && window.goatcounter.count) {
      window.goatcounter.count({ path: name, title: name, event: true });
    }
  } catch (_) { /* analytics must never break the tool */ }
}

const state = {
  cvReady: false,
  workCanvas: document.createElement("canvas"),
  viewCanvas: document.getElementById("viewCanvas"),
  cells: null,     // [{x,y,w,h,fill,green,score}] in workCanvas pixel coordinates, after detection
  cellThresh: 0.5, // auto-computed split point between "blank" and "marked" scores
  adjust: 0,       // user's slider offset from cellThresh, -0.15..+0.15
  pipeline: null,  // stage counts from the most recent detection run, for diagnostics
  expectedTotal: null,
  editTracked: false, // report only the first hand edit per photo
  maskCanvas: null,  // the binary threshold mask detection actually ran on, for visual debugging
  showingMask: false,
};
state.workCtx = state.workCanvas.getContext("2d");
state.viewCtx = state.viewCanvas.getContext("2d");

const el = (id) => document.getElementById(id);

// ── OpenCV readiness ─────────────────────────────────────────────────────────

window.addEventListener("opencv-ready", () => {
  state.cvReady = true;
  el("status").textContent = S.ready;
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
    el("showMaskBtn").textContent = S.showMask;
    URL.revokeObjectURL(url);

    if (!state.cvReady) {
      el("status").textContent = S.waitingCv;
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
  el("thresholdValue").textContent = S.auto;
  el("fileInput").value = "";
  state.workCanvas.width = 0;
  state.workCanvas.height = 0;
  state.viewCanvas.width = 0;
  state.viewCanvas.height = 0;
  el("canvasWrap").hidden = true;
  el("resultsSection").hidden = true;
  el("resetBtn").disabled = true;
  el("status").textContent = S.ready;
});

el("thresholdSlider").addEventListener("input", (e) => {
  state.adjust = Number(e.target.value) / 100;
  const v = Number(e.target.value);
  el("thresholdValue").textContent = v === 0 ? S.auto : (v > 0 ? `+${v}%` : `${v}%`);
  if (state.cells) renderResult();
});

el("expectedTotal").addEventListener("change", () => {
  // Detection no longer depends on this — it's just shown for context —
  // so just update the note rather than redoing all the CV work.
  const raw = el("expectedTotal").value.trim();
  state.expectedTotal = raw ? Math.max(1, parseInt(raw, 10)) : null;
  if (state.cells) renderResult(state.expectedTotal);
});

el("copyDiagnosticsBtn").addEventListener("click", copyDiagnostics);

el("showMaskBtn").addEventListener("click", () => {
  state.showingMask = !state.showingMask;
  el("showMaskBtn").textContent = state.showingMask ? S.showNormal : S.showMask;
  renderResult(state.expectedTotal);
});

// ── Detection ────────────────────────────────────────────────────────────────

function detectAndClassify() {
  el("status").textContent = S.finding;
  el("resultsSection").hidden = true;
  // Let "Finding marks…" paint before the synchronous CV work blocks the thread.
  setTimeout(() => {
    const expectedRaw = el("expectedTotal").value.trim();
    const expectedTotal = expectedRaw ? Math.max(1, parseInt(expectedRaw, 10)) : null;
    state.expectedTotal = expectedTotal;
    state.editTracked = false;
    try {
      const result = findGridCells(state.workCanvas);
      const { cells, cellThresh, pipeline, maskCanvas } = result;
      state.cells = cells;
      state.cellThresh = cellThresh;
      state.pipeline = pipeline;
      state.maskCanvas = maskCanvas;
    } catch (err) {
      console.error(err);
      track("analysis-error");
      el("status").textContent = S.failed;
      return;
    }
    if (state.cells.length === 0) {
      track("no-grid-found");
      el("status").textContent = S.noBoxes;
      return;
    }
    track("photo-analyzed");
    el("status").textContent = "";
    el("resultsSection").hidden = false;
    state.adjust = 0;
    el("thresholdSlider").value = 0;
    el("thresholdValue").textContent = S.auto;
    renderResult(expectedTotal);
  }, 30);
}

// Grid scan (see omr.js): find the lattice the boxes sit on and measure every
// position on it. Browser wrapper around the DOM-free core.
function findGridCells(canvas) {
  const src = cv.imread(canvas);
  let res;
  try {
    res = OMR.analyze(cv, src);
  } finally {
    src.delete();
  }
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  if (res.maskMat) { cv.imshow(maskCanvas, res.maskMat); res.maskMat.delete(); }
  return { cells: res.cells, cellThresh: res.cellThresh, maskCanvas, pipeline: { ...res.pipeline, imageW: canvas.width, imageH: canvas.height } };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderResult(expectedTotal) {
  state.viewCtx.clearRect(0, 0, state.viewCanvas.width, state.viewCanvas.height);

  if (state.showingMask && state.maskCanvas) {
    state.viewCtx.drawImage(state.maskCanvas, 0, 0);
    el("totalResult").textContent = S.maskTitle;
    el("detectedNote").textContent = S.maskNote;
    return;
  }

  state.viewCtx.drawImage(state.workCanvas, 0, 0);

  let count = 0, edited = 0;
  for (const c of state.cells) {
    const marked = isMarked(c);
    if (marked) count++;
    if (c.override !== undefined || c.manual) edited++;
    state.viewCtx.strokeStyle = (c.override !== undefined || c.manual)
      ? "#f59e0b"
      : marked ? "#16a34a" : "rgba(37,99,235,0.35)";
    state.viewCtx.lineWidth = marked ? 3 : 1.5;
    state.viewCtx.setLineDash(c.virtual ? [4, 3] : []);
    state.viewCtx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
    state.viewCtx.setLineDash([]);
  }

  el("totalResult").textContent = S.marked(count);
  const found = state.cells.filter((c) => !c.manual).length;
  const virtualCount = state.cells.filter((c) => c.virtual).length;
  let note = S.notePlain(found, count);
  if (virtualCount) note += S.noteVirtual(virtualCount);
  if (expectedTotal) {
    if (found !== expectedTotal) note += S.noteExpected(expectedTotal, found, Math.abs(found - expectedTotal));
  }
  if (edited) note += S.noteEdited(edited);
  el("detectedNote").textContent = note;
  el("clearEditsBtn").hidden = edited === 0;
}

// A box counts as marked by the scan unless the user has flipped it.
function isMarked(c) {
  if (c.override !== undefined) return c.override;
  return c.score >= state.cellThresh + state.adjust;
}

// Tap a box to flip it; tap empty space to add a mark the scan missed.
// Tapping a hand-added mark removes it.
el("viewCanvas").addEventListener("click", (e) => {
  if (!state.cells || state.showingMask) return;
  const canvas = state.viewCanvas;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((e.clientY - rect.top) / rect.height) * canvas.height;

  let hit = null, best = Infinity;
  for (const c of state.cells) {
    const slack = 3;
    if (px >= c.x - slack && px <= c.x + c.w + slack && py >= c.y - slack && py <= c.y + c.h + slack) {
      const d = Math.hypot(px - (c.x + c.w / 2), py - (c.y + c.h / 2));
      if (d < best) { best = d; hit = c; }
    }
  }
  if (hit) {
    if (hit.manual) {
      state.cells.splice(state.cells.indexOf(hit), 1);
    } else {
      hit.override = !isMarked(hit);
      // flipping back to what the scan said is no longer an edit
      if (hit.override === (hit.score >= state.cellThresh + state.adjust)) delete hit.override;
    }
  } else {
    const sizes = state.cells.map((c) => c.w).sort((p, q) => p - q);
    const s = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 18;
    state.cells.push({ x: Math.round(px - s / 2), y: Math.round(py - s / 2), w: s, h: s, score: 1, manual: true, override: true });
  }
  if (!state.editTracked) { state.editTracked = true; track("hand-edit"); }
  renderResult(state.expectedTotal);
});

el("clearEditsBtn").addEventListener("click", () => {
  if (!state.cells) return;
  state.cells = state.cells.filter((c) => !c.manual);
  for (const c of state.cells) delete c.override;
  renderResult(state.expectedTotal);
});

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
    const extra = c.manual
      ? "manual"
      : `ink=${c.ink.toFixed(3)} green=${c.green.toFixed(3)} virtual=${!!c.virtual}`;
    return `  x=${c.x} y=${c.y} w=${c.w} h=${c.h} ${extra} score=${c.score.toFixed(3)} marked=${isMarked(c)}${c.override !== undefined ? " (edited)" : ""}${c.manual ? " (added)" : ""}`;
  });

  return [
    `Count X diagnostics — ${new Date().toISOString()}`,
    ``,
    `Image: ${W}x${H}`,
    `Expected total given: ${state.expectedTotal ?? "(none)"}`,
    `Grid: anchors=${state.pipeline.anchors} virtual=${state.pipeline.virtual} components=${state.pipeline.components} cells=${state.pipeline.keptCells} boxSize=${state.pipeline.boxSize} paperLevel=${state.pipeline.paperLevel} componentSizes=[${state.pipeline.compSizes}] rotation=${(state.pipeline.theta || 0).toFixed(1)}deg pitch=${(state.pipeline.pitchU || 0).toFixed(1)}x${(state.pipeline.pitchV || 0).toFixed(1)}`,
    `Detected cells: ${cells.length}`,
    `Cell size: width min=${widths[0]} median=${med(widths)} max=${widths[widths.length - 1]} | height min=${heights[0]} median=${med(heights)} max=${heights[heights.length - 1]}`,
    `Classification threshold (auto + slider adjust): ${effectiveThresh.toFixed(3)} (auto=${state.cellThresh.toFixed(3)}, slider adjust=${state.adjust.toFixed(3)})`,
    `Marked: ${cells.filter(isMarked).length} / ${cells.length} (hand edits: ${cells.filter((c) => c.override !== undefined || c.manual).length})`,
    ``,
    `Mark-score histogram (0=blank, 1=marked; score = max of ink and greenness):`,
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
    el("diagnosticsStatus").textContent = S.copied;
  } catch {
    // Clipboard API can be blocked in some contexts; fall back to a visible,
    // selectable textarea the user can copy from manually.
    const ta = el("diagnosticsFallback");
    ta.value = text;
    ta.hidden = false;
    ta.focus();
    ta.select();
    el("diagnosticsStatus").textContent = S.copyFailed;
  }
}
