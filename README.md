# Count X

Upload a photo of a grid of boxes (like a bingo card, attendance sheet, or
survey form) and count how many are marked with an X. Runs entirely in your
browser — nothing gets uploaded anywhere.

**Live site:** https://hadaromer.github.io/count-x/

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

Make sure the whole grid is visible in the photo (not cropped at the edge)
and reasonably well-lit — it needs to see every box's full border to find
it.

## How it works

No server, no accounts, no file uploads — it's a static page.

The default **Grid scan** works the way bubble-sheet / OMR scanners do (see
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

Cells drawn with dashed outlines were placed from the grid rather than seen
directly. If no usable grid is found, it falls back to the older method and
says so.

Two older methods are still in the dropdown for comparison. **Box ink**
classifies each connected blob that looks box-sized by how much of its
bounding box is inked; **X-shape matching** looks for crossing diagonal
strokes (Hough lines) plus green blobs. On a realistic synthetic form
(perspective, shadow, printed numbers, hand-drawn X's) they found 285 and
120 of 800 boxes versus 800 for the grid scan.

### Testing

`omr.js` has no DOM dependency, so it's tested against the real OpenCV.js
build in Node on synthetic forms with ground truth: 800 boxes in 8 blocks,
numbers printed above each box, hand-jittered X's, translucent highlighter,
random perspective, up to ~5° rotation, a diagonal shadow band, blur, noise
and JPEG compression, plus lower-resolution, fainter-pen and denser variants.
All come out at 800/800 positions with at most 2 mark errors. Known weak
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
