# Count X

Upload a photo of a grid of boxes (like a bingo card, attendance sheet, or
survey form) and count how many are marked with an X. Runs entirely in your
browser — nothing gets uploaded anywhere.

**Live site:** _(set after first GitHub Pages deploy — see below)_

## How to use it

1. Upload a photo.
2. Click **+ Add region**, then click the four corners of one grid block, in
   order: top-left → top-right → bottom-right → bottom-left. You don't need
   to be pixel-perfect — a photo taken at a slight angle, with a bit of
   imprecision in where you click, still works fine.
3. Enter how many rows and columns that block has, and confirm.
4. Repeat for any other blocks on the same photo (useful for sheets with
   several separate grids, like the 1–100/101–200/… layout some forms use).
5. Click **Count X's**. Each region gets an annotated preview — green
   borders mark cells it thinks are X'd.
6. If it's getting some wrong, drag the **sensitivity** slider — results
   update immediately without reprocessing the image.

## How it works

No server, no accounts, no file uploads — it's a static page. For each
region you define, it:

1. Perspective-corrects (rectifies) that quadrilateral into a flat,
   straight-on grid image, using the four corner points you clicked
   ([`cv.getPerspectiveTransform`](https://docs.opencv.org/4.x/) +
   `cv.warpPerspective`, via [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html)).
2. Divides that rectified image evenly into your specified rows × columns.
3. For each cell, crops an inset region (avoiding the cell's own border
   lines) and measures how dark it is on average.
4. Cells darker than the sensitivity threshold are counted as marked.

This is a "how dark is it" measurement, not real OCR — it doesn't care
whether the mark is an X, a checkmark, or a scribble, just whether there's
visible ink in the box.

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
