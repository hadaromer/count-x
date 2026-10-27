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
   "foreground," blank paper doesn't) — using a local, per-neighborhood
   threshold (`cv.adaptiveThreshold`) by default rather than one value for
   the whole photo. A real photographed page is rarely lit perfectly evenly;
   a single global threshold tuned for the brighter side can fail to tell
   border lines from paper at all on a shadowed side. Confirmed on a
   synthetic page with a left-to-right lighting gradient: a global threshold
   found 487 of 800 boxes (89 on the shadowed side vs. 398 on the bright
   side); the adaptive one found all 800. Classification has the same
   problem one level up — a single page-wide "blank vs. marked" split can't
   tell "darker because shadowed" apart from "darker because marked" —
   solved by computing that split per spatial region instead of once
   globally (see step 5).
2. Finds every closed shape in that mask as a contour
   (`cv.findContours`, via [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html)),
   using `RETR_CCOMP` and keeping each box's enclosed interior (a "hole" in
   the border mesh) rather than its own outer ring. On a densely packed
   form, adjacent boxes' borders often touch after the photo is resized —
   that can fuse the whole grid into one connected blob under a simpler
   "each box's own outer ring" approach, which catastrophically
   undercounts. A box's hole stays correctly segmented even when the
   surrounding mesh is fully fused, so this holds up regardless of how
   tightly packed the boxes are.
3. Keeps only the candidates big enough to plausibly be a box a person
   could mark with a pen (a fixed minimum size relative to the photo) —
   printed reference numbers/labels often contain characters like 0, 8, 9,
   or 6 that have their own enclosed hole, identical in shape to a
   checkbox's; this is what tells them apart, since a label's internal
   counter is reliably much smaller than a real box, no matter how many of
   them there are (which also makes a false positive only slightly more
   likely to be filtered, not fundamentally fixed, by just excluding
   outliers from the overall median). Among what's left: closeness to the
   remaining pool's median size, a reasonable aspect ratio, and a high fill
   ratio (contour area vs. its own bounding box — a hollow border rectangle
   has that; a disconnected ink blob or a clipped fragment doesn't).
4. For each box kept, crops an inset region (avoiding its own border) and
   measures how dark it is on average.
5. Finds the natural split between "blank" and "marked" scores via Otsu
   applied to the array of per-cell darkness scores (not pixels, and not a
   fixed cutoff against pure white) — self-calibrating to whatever a blank
   box actually looks like (non-white cell fills, shadows, scan tint all
   handled) and to whatever fraction of boxes are actually marked. Computed
   per spatial tile across the photo rather than once for the whole page,
   for the lighting-unevenness reason in step 1 — a small or simple photo
   just reduces to one tile, i.e. one global split.

This is a "how dark is it" measurement, not real OCR — it doesn't care
whether the mark is an X, a checkmark, or a scribble, just whether there's
visible ink in the box. Validated against synthetic ground-truth grids
across varied pen widths, cell sizes, rotation, mark density from 5%-70%,
non-white cell fills, near-zero-gap touching borders, printed reference
numbers with their own enclosed holes sitting next to every box, and a
simulated lighting gradient across an 800-box page.

**Known trade-off**: the adaptive threshold that fixes uneven lighting is
very slightly worse than a single global threshold at the most extreme
case of literally zero pixels between two boxes' borders (in testing, 94
boxes found out of 100 vs. 100/100). If you give a known total, the app
tries both methods and keeps whichever one actually matches your photo.

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
