# Count X

Upload a photo of a grid of boxes (like a bingo card, attendance sheet, or
survey form) and count how many are marked with an X. Runs entirely in your
browser — nothing gets uploaded anywhere.

**Live site:** https://hadaromer.github.io/count-x/

## How to use it

1. Upload a photo. That's it — it finds every box and counts the marked
   ones automatically.
2. The photo shows every box it found outlined: thick green for boxes it
   thinks are marked, thin blue for blank ones. Check it against the
   actual photo.
3. If it's getting some wrong, drag the **sensitivity** slider — results
   update instantly, no reprocessing.

Make sure the whole grid is visible in the photo (not cropped at the edge)
and reasonably well-lit — it needs to see every box's full border to find
it.

## How it works

No server, no accounts, no file uploads — it's a static page. For the
photo you upload, it:

1. Thresholds it to a binary foreground mask (ink and borders both count as
   "foreground," blank paper doesn't).
2. Finds every closed shape in that mask as its own contour
   (`cv.findContours`, via [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html)).
3. Keeps only the contours that actually look like a box: close to the
   same size as the other candidates (real cells cluster around one size;
   stray text or noise usually doesn't), a reasonable aspect ratio, and a
   high fill ratio — a hollow border rectangle's contour area is close to
   its own bounding-box area, which is what tells a real box apart from a
   disconnected ink blob like an X (low fill ratio) or a partial fragment
   clipped at the photo's edge (also low).
4. For each box kept, crops an inset region (avoiding its own border) and
   measures how dark it is on average.
5. Boxes darker than the sensitivity threshold are counted as marked.

This is a "how dark is it" measurement, not real OCR — it doesn't care
whether the mark is an X, a checkmark, or a scribble, just whether there's
visible ink in the box. Validated against synthetic ground-truth grids
across varied pen widths, cell sizes, rotation, and mark density before
shipping.

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
