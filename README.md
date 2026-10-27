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

No server, no accounts, no file uploads — it's a static page. It does
**not** try to reconstruct the grid of boxes first and then inspect each
one — several versions did, built around finding each box's border as a
closed shape (a "hole" in the thresholded image). That approach kept
fighting itself: marking a box is specifically what damages its border's
hole, so detection and classification were working against each other,
and every fix for one side tended to let through false positives from a
form's printed labels. Measuring how inked each blob in the photo actually
is, directly, turned out to be both simpler and far more accurate. For the
photo you upload, it:

1. Thresholds it to a binary foreground mask (ink and borders both count as
   "foreground," blank paper doesn't).
2. Takes every connected blob in that mask as a candidate
   (`cv.connectedComponentsWithStats`, via [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html))
   — no contour-hierarchy or hole reasoning at all. A blank box's blob is
   just its thin border ring: a low fraction of its own bounding box is
   actually inked. A marked box's blob includes whatever's inside it — a
   highlighter fill or an X — so a much higher fraction of it is inked.
   That fill ratio (blob area vs. its own bounding box) is the core
   signal, and empirically separates blank from marked far more cleanly
   than measuring interior darkness after trying to locate a border first.
3. Excludes blobs that are too small or too large to plausibly be a box a
   person could mark with a pen — a generous range, since the photo's
   *actual* box size is then found from the mode of blob widths within
   that range, rather than assumed in advance or anchored on a median a
   form's printed labels could contaminate (real boxes are far more
   uniform in size than scattered label text, so they form a sharp peak
   even when label-sized blobs outnumber them).
4. For each box kept, crops an inset region (avoiding its own border) and
   measures a second, independent signal: how much the average color
   leans green — for highlighter-style marks that are barely darker than
   blank paper and so don't move the fill ratio much. A box's mark score
   is the stronger of the two signals.
5. Finds the natural split between "blank" and "marked" scores via a
   cell-level Otsu threshold over all the boxes' mark scores (not a fixed
   cutoff) — self-calibrates to whatever a blank box actually looks like
   in this specific photo and to whatever fraction of boxes are actually
   marked.

This is a "how inked/colored is it" measurement, not real OCR — it doesn't
care whether the mark is an X, a checkmark, a scribble, or a highlighter
fill, just whether there's visible ink or color in the box. Validated
against a synthetic ground-truth form built to stress the hardest part of
this specific problem: a dense grid with a real printed reference number
(actual rendered digit glyphs) sitting right next to every box — across
several random mark layouts, zero false positives and zero misclassified
boxes.

Open gap: this doesn't yet correct for unevenly lit photos (a strong
shadow or glare across part of the page) — adaptive thresholding and
illumination normalization were both tried and both broke the fill-ratio
classification worse than the shadow itself did, so for now a very uneven
photo may still undercount in the affected region.

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
