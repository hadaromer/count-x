# Count X

Upload a photo of a grid of boxes (like a bingo card, attendance sheet, or
survey form) and count how many are marked with an X. Runs entirely in your
browser — nothing gets uploaded anywhere.

**Live site:** https://hadaromer.github.io/count-x/

## How to use it

1. Upload a photo. That's it — it finds every box and counts the marked
   ones automatically.
2. If you happen to know the total number of boxes (a ballot, an
   attendance sheet with a fixed roster, etc.), enter it — optional, but it
   helps the detector calibrate, especially on forms with small printed
   text (reference numbers, labels) right next to each box.
3. The photo shows every box it found outlined: thick green for boxes it
   thinks are marked, thin blue for blank ones. Check it against the
   actual photo.
4. If it's getting some wrong, drag the **sensitivity** slider — results
   update instantly, no reprocessing.

Make sure the whole grid is visible in the photo (not cropped at the edge)
and reasonably well-lit — it needs to see every box's full border to find
it.

## How it works

No server, no accounts, no file uploads — it's a static page. For the
photo you upload, it:

1. Thresholds it to a binary foreground mask (ink and borders both count as
   "foreground," blank paper doesn't).
2. Strips that mask down to thin strokes only, via `cv.distanceTransform`
   (each foreground pixel's distance to the nearest background pixel —
   low for a thin printed border or pen line, high for a solid interior
   fill or thick ink). A marked box's own ink — a highlighter fill, or an
   X whose diagonals touch the border at several points — otherwise
   destroys or fragments that box's enclosed hole, which would make a
   marked box invisible to hole-based detection rather than just
   misclassified. Thinning first recovers the border, and its hole,
   regardless of what's marked inside it.
3. Finds every closed shape in the thinned mask as a contour
   (`cv.findContours`, via [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html)),
   using `RETR_CCOMP` and keeping each box's enclosed interior (a "hole" in
   the border mesh) rather than its own outer ring. On a densely packed
   form, adjacent boxes' borders often touch after the photo is resized —
   that can fuse the whole grid into one connected blob under a simpler
   "each box's own outer ring" approach, which catastrophically
   undercounts. A box's hole stays correctly segmented even when the
   surrounding mesh is fully fused, so this holds up regardless of how
   tightly packed the boxes are.
4. Keeps only the candidates big enough to plausibly be a box a person
   could mark with a pen, with a high fill ratio (contour area vs. its own
   bounding box) and a close-to-square aspect ratio. A real box hole after
   thinning is a near-complete rectangle; a printed label character's hole
   (0, 6, 8, 9 all have one) almost never reaches that fill ratio even
   when its size happens to overlap a small box's — fill ratio and shape
   turn out to separate the two far more reliably than size alone,
   especially at low photo resolution where a dense form's label text and
   its checkboxes can be close in size.
5. Handles boxes whose hole got sliced into several undersized fragments
   by a mark that touches the border at multiple points (e.g. an X corner
   to corner): groups leftover fragments by actual spatial adjacency
   (bounding boxes touching or overlapping within a tight tolerance, far
   smaller than the real gap between adjacent boxes) rather than by
   `findContours`' own parent index, which turned out not to be reliable
   evidence of belonging to the same cell. A group's combined footprint is
   accepted as one cell if it's plausibly box-shaped and sized — but a
   *lone* low-fill fragment is left alone rather than merged, since on its
   own it's more likely a digit than a sliced-open box.
6. For each box kept, crops an inset region (avoiding its own border) and
   measures two independent signals: grayscale darkness (pen/pencil ink)
   and "greenness" (how much the average color leans green — for
   highlighter-style marks that are barely darker than blank paper and so
   are invisible to a pure darkness score). A box's mark score is the
   stronger of the two.
7. Finds the natural split between "blank" and "marked" scores via a
   second, cell-level Otsu threshold over all the boxes' mark scores (not
   a fixed cutoff against pure white) — self-calibrates to whatever a
   blank box actually looks like in this specific photo (handles non-white
   cell fills, shadows, scan tint) and to whatever fraction of boxes are
   actually marked.

This is a "how dark/colored is it" measurement, not real OCR — it doesn't
care whether the mark is an X, a checkmark, a scribble, or a highlighter
fill, just whether there's visible ink or color in the box. Validated
against synthetic ground-truth grids across varied pen widths, cell sizes,
rotation, mark density from 5%-70%, non-white cell fills, zero-gap touching
borders, printed reference numbers with their own enclosed holes sitting
next to every box, and marks that fully fill or fragment a box's hole
(highlighter fills, corner-touching X's).

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
