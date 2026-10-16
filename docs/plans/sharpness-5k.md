# Sharpness target: Apple 5K/6K

**Draft, 16 Oct 2026. Docs only.** The owner's 15:05 note, section 1 (`docs/redesign-plan.md`, last section), is the target. This page carries it verbatim and then turns it into a checklist reviewers apply to every v25 and v26 screen PR. **An Opus audit of the code against this target is running; its findings are not here yet and will be folded in** (marked below as "audit: pending"). No pricing, margins or vendor costs appear here (the repo is public).

## 1. The owner's text (verbatim)

> **1) SHARPNESS TARGET: APPLE 5K/6K.** Screenshots for every v25/v26 screen PR at 1280×800, 1440×900, 1728×1117, 1920×1080, 2560×1440 and 3008×1692, the last two with deviceScaleFactor 2 (Studio Display, Pro Display XDR). Canvas scaling uses real layout sizes, never CSS transform/zoom on text (if #748 uses zoom, convert it). All UI and the logo vector; borders snapped to device pixels; every image served at ≥2× its displayed size via srcset; full-screen preview uses the 4K rendition when one exists; video posters at the same density. Any soft text, blurry border or upscaled image in those screenshots is a must-fix. Add an automated check that fails when an <img> is displayed larger than its natural size ÷ 2.

## 2. Reviewer checklist

Apply to every v25/v26 screen PR. Tick each, or write why it does not apply. A failing item is a **must-fix**.

### Screenshots
1. [ ] The PR attaches screenshots at all six sizes: **1280×800, 1440×900, 1728×1117, 1920×1080, 2560×1440, 3008×1692**.
2. [ ] The **2560×1440 and 3008×1692** screenshots are taken with **deviceScaleFactor 2** (they stand for Studio Display and Pro Display XDR); the smaller four at the default factor the existing five-viewport specs use (state it).
3. [ ] The reviewer zooms the 2560 and 3008 shots to 200% on text, borders, the logo and every picture and finds **no soft text, no blurry border and no upscaled image**. Any such finding is a must-fix.
4. [ ] The large-screen checks from the owner's 22:30 rule still hold at 2560×1440: no stranded cards, no text under 12 px, no dead space below the cards, the three bars centred, no horizontal scroll.

### Scaling
5. [ ] **Canvas scaling uses real layout sizes**, never a CSS `transform: scale()` or the CSS `zoom` property **on text**. Cards, text and chips are laid out at their final size, not scaled up from a smaller one.
6. [ ] If the PR scales the canvas by any transform or zoom (the owner named #748: "if #748 uses zoom, convert it"), it is **converted to real layout sizes** or the PR says exactly which element is transformed and shows that its text is not.
   - *Open point (audit: pending):* the lane/Opus note of 16 Oct on #748 said the scale must be React Flow's own viewport zoom so drag, drop and selection keep working. React Flow applies the viewport as a transform. Whether text inside it stays sharp at 3008×1692 @2×, and how to keep drag and selection while laying text out at real sizes, is to be settled with the owner; do not assume either way.

### Vector and borders
7. [ ] **All UI and the logo are vector** (SVG or live text), never bitmaps at any size. The wordmark exists only as PNG in `public/brand/` today; an SVG from the owner's brand files is needed, and until then a PNG logo is a must-fix in each PR (UNKNOWN when it arrives).
8. [ ] **Borders are snapped to device pixels**: hairlines are 1 device pixel (`1px` at factor 1, `0.5px` or a snapped equivalent at factor 2), not blurred across two; positions that carry a border land on whole device pixels.
9. [ ] Icons are SVG; no icon font renders text-sized glyphs through a scaled bitmap.

### Images, previews and posters
10. [ ] **Every image is served at ≥2× its displayed size** through `srcset` and `sizes`; the displayed size is the layout size, so a 3008-wide display at factor 2 can ask for 2× the CSS size.
11. [ ] **No image is shown larger than its natural size ÷ 2** (that is, the file has at least 2× the pixels it is drawn at). This is the automated check below.
12. [ ] **Full-screen preview uses the 4K rendition when one exists**, and falls back to the best rendition otherwise, never upscaling past real pixels.
13. [ ] **Video posters are at the same density** as the images: a poster is ≥2× its displayed size, and a poster is never an upscaled low-resolution frame.
14. [ ] Thumbnails, frames, stills and previews on the board follow the same rule; a stand-in sample (for example a 640 px starter clip) is flagged where it would be upscaled.
15. [ ] Originals are never altered to meet this (renditions are derived; the original stays byte-identical).

### The automated check (to build)
16. [ ] A browser test visits each screen at 1440×900 (factor 1) and at 3008×1692 (factor 2), reads every displayed `<img>` (and poster, and CSS background image where measurable), and **fails when an `<img>` is displayed larger than its natural size ÷ 2**, that is, when `naturalWidth` < 2 × the displayed CSS width (or the same for height). It lists the offenders (screen, selector, displayed size, natural size). It is a guard test: it is added, never weakened, and an exception needs the owner's word.
17. [ ] A second check fails on a raster logo or raster icon in the shell, and a third on a `transform: scale` or `zoom` applied to an element containing text on the board (an allow-list of reviewed exceptions, each with a reason).

### Audit
18. [ ] **Audit: pending.** The lead's Opus audit of the existing code against items 5 to 15 will be folded in here: a table of file, finding and fix. Until it lands, reviewers apply items 1 to 17 to the screens in their PR only.

## 3. Where this meets other work
- The five-viewport large-screen rules of 15 Oct 22:30 are the base; this target adds 3008×1692 and the factor-2 shots, and replaces "attach all five" with "attach all six".
- `docs/plans/deck-editor.md` renders pages crisp at 3008×1692 @2× and keeps text as live text until a raster export.
- `docs/plans/editing-standard.md` item 13 requires these checks on every edit surface.
