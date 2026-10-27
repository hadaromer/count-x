# Count X

Upload a photo of a grid of boxes (like a bingo card, attendance sheet, or
survey form) and count how many are marked with an X. Runs entirely in your
browser — nothing gets uploaded anywhere.

**Live site (Hebrew):** https://hadaromer.github.io/count-x/ · **English:** https://hadaromer.github.io/count-x/en.html

## How to use it

1. Upload a photo. That's it — it finds every box and counts the marked
   ones automatically.
2. If you happen to know the total number of boxes (a ballot, an
   attendance sheet with a fixed roster, etc.), enter it — optional, shown
   next to the result as a sanity check, doesn't change detection.
3. The photo shows every box it found outlined: thick green for boxes it
   thinks are marked, thin blue for blank ones. Check it against the
   actual photo.
4. If it's getting some wrong, drag the **sensitivity** slider — results
   update instantly, no reprocessing.
5. Fix individual boxes by hand: **tap a box** on the photo to flip it
   between marked and blank, or **tap empty space** to add a mark the scan
   missed (tap an added mark to remove it). Edited boxes turn orange, the
   count updates, and "Clear my edits" undoes them all.

Make sure the whole grid is visible in the photo (not cropped at the edge)
and reasonably well-lit — it needs to see every box's full border to find
it.

## How it works

No server, no accounts, no file uploads — it's a static page.

**Grid scan** works the way bubble-sheet / OMR scanners do (see
e.g. [OMRChecker](https://github.com/Udayraj123/OMRChecker)): it doesn't try
to recognise each box by its own shape — that's exactly what a mark ruins —
it finds the lattice the boxes sit on and measures the ink at every position
on it. The pipeline (`omr.js`, runs identically in the browser and in Node):

1. **Normalize lighting.** Divide the photo by a heavily smoothed copy of
   itself, so paper is a known level everywhere and a shadow or glare can't
   change what counts as ink. Ink is anything noticeably darker than that
   paper level.
2. **Anchors.** Boxes that are still clean closed squares (the blank ones,
   typically most of them) show up as holes in the thresholded image. Their
   typical size is the mode of hole widths — real boxes are far more uniform
   than printed labels, so they form a sharp peak.
3. **Lattice.** From the anchors, work out the grid's rotation and pitch,
   then walk outward cell by cell, giving every position integer grid
   indices. A position with no anchor (a marked box whose outline got
   damaged) is re-placed from a local affine fit of the real anchors around
   it and accepted only if a box outline is actually present there and the
   lattice continues on at least two sides. Tiny stray lattices (printed
   text, barcodes, markers) are discarded.
4. **Measure.** For every lattice cell, take an inset region (staying off
   its own outline) and measure how much dark ink is in it, plus how green
   it is (highlighter), both against the normalized paper level.
5. **Classify.** Blank cells cluster tightly near zero, so the cut sits just
   above that cluster (with 1-D Otsu to find it) — faint marks still count,
   and the sensitivity slider moves the cut.

Printed titles, big digits and letters can't join the grid: a box has to sit
on the lattice, and a position the scan couldn't see directly is only
believed once two already-believed neighbours back it (a row of title text
above a block can fake an outline, but never has two real boxes beside it).
Lattices far smaller than the main blocks are dropped as text.

Cells drawn with dashed outlines were placed from the grid rather than seen
directly. If no usable grid is found it says so rather than guessing.

### Testing

`omr.js` has no DOM dependency, so it's tested against the real OpenCV.js
build in Node on synthetic forms with ground truth: 800 boxes in 8 blocks,
numbers printed above each box, hand-jittered X's, translucent highlighter,
random perspective, up to ~5° rotation, a diagonal shadow band, blur, noise
and JPEG compression, plus lower-resolution, fainter-pen and denser variants, and forms with big
block titles ("700-601"), large margin digits, rows of 0/6/8/9 and circles.
All come out at ~800/800 positions, zero spurious cells and at most 3 mark errors. Known weak
spots: very tightly packed boxes (gap between boxes under ~8px) and layouts
where printed numbers touch the neighbouring block's boxes.

## Running locally

No build step — it's plain HTML/CSS/JS plus OpenCV.js loaded from a CDN.

```bash
python3 -m http.server 8080
# or: npx serve
```

Then open `http://localhost:8080`.

## Deploying

Pushed to `main` on GitHub with Pages enabled on the repo root — see repo
Settings → Pages. Any push to `main` goes live within a minute or two.

## Hebrew version

`index.html` (+ `he.css`) is the main page: a right-to-left Hebrew page for counting votes in
elections, with a plain-language explanation of how it works and how to spot
and remove wrong detections. It runs the same `omr.js` / `app.js`; the page
sets `window.COUNTX_LANG = "he"` before `app.js` loads, which switches the
status messages and notes to Hebrew. The English version is `en.html`
(`he.html` just redirects to the main page).
