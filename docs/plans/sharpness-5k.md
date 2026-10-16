# Sharpness target: Apple 5K/6K

**Draft, 16 Oct 2026. Docs only.** The owner's 15:05 note, section 1 (`docs/redesign-plan.md`, last section), is the target. This page carries it verbatim and then turns it into a checklist reviewers apply to every v25 and v26 screen PR. **The Opus audit of the code against this target (read-only, release/1 at 25c52104 and the open v25 branches, 16 Oct) is folded in as section 3.** No pricing, margins or vendor costs appear here (the repo is public).

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
   - *Audit finding (section 3, A1):* #748's large-screen scale is React Flow's viewport zoom (`translate(x,y) scale(k)` on `.react-flow__viewport`, k = 1.2 at 1728/1920, 1.6 at 2560, 1.88 at 3008), so every card's text, chips and 1px borders are drawn through a transform. The audit proposes keeping React Flow's zoom at 1 and scaling the layout itself with a `--bk` multiplier, **pending the owner's go** (it is the owner's question 1 and 3 below).

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
18. [ ] The **audit findings (section 3)** that apply to the PR are fixed or listed with a reason; the **must-do-before-demo list (section 3.7)** is checked for PRs on the demo path.

## 3. The audit, 16 Oct 2026 (folded in)

Read-only Opus audit. Covered `origin/release/1` at 25c52104 and the open v25 branches (`v25/c-rail` bd738204, `v25/e-preview` 7f8bd736, `v25/f-director` fb393ac4, `feat/v25-4-board-data` 7b7a33b0, `v25/f-brief-script` 5ce7023a, and the Home branch b7dd5d98, taken to be #795). No browser runs. Effort figures are the audit's estimates.

### 3.1 Transform or zoom on a subtree that has text

| # | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| A1 | `lib/v12/board/screen-scale.ts:12`; `BoardView.tsx:213, 226, 307, 319-323`; `BoardCanvas.tsx:198` | The large-screen scale is React Flow's viewport zoom, always on above 1440 px; all card text, chips and 1px borders go through it | Keep the zoom at 1 for "100%". Set `--bk: k` on `.v12-stage-canvas` and scale the layout: `GRID_CARD`, `GRID_GAP`, `GRID_ORIGIN` and group padding × k in `stage-grid.ts`, `gridDefs` and `placeBoard`; card CSS uses `calc(token * var(--bk))` for font size, padding, radius and icon size; borders stay 1px; the zoom pill loses `base`. Also round the viewport's x/y to whole device pixels in every `setViewport` | Rounding S (hours); layout conversion L, 2 to 3 days, including the `shots-v12` and `render-v12` specs |
| A2 | The person's own zoom (pinch, + and −, fit at 0.25 to 2k) | Also a transform on text, only while the person has zoomed | Inherent to any canvas (Figma works the same way); converting is XL and not recommended | **Owner question 1** |
| A3 | `v25/f-brief-script` `components/v12/board/TextStage.tsx:45, 75` | `style={{ zoom: scale }}` on the whole Brief/Script text page | Remove `zoom`: raise column width and font tokens with CSS `clamp()` and a container query (pure CSS), or a `--ts-k` multiplier. **Must be fixed before #802 merges** | S |
| A4 | `components/graphite/board/Presence.tsx:20` | Peer cursor labels at `translate() scale(1/zoom)` | Draw cursors in a separate overlay outside the viewport (not on the demo path) | S to M |
| A5 | #748 top bar (`header.css`, `brand-logo.css`) | No transform or zoom; the logo crop uses fractional offsets with negative % margins | With an SVG wordmark, crop through the SVG `viewBox` | S |
| A6 | "#762 zoom-to-fit rule" | #762 has no zoom; the only zoom-to-fit rule is #748's `screen-scale.ts` (A1) | none | none |
| A7 | Legacy workbench canvas (`workbench.css:93`, `desk.css:19`, `will-change: transform`) | JS-set transform on text; `will-change` can keep it as a bitmap | Can wait; at least drop `will-change` once settled | S |

Transient effects (press `scale(0.98)`, pop-ins, `scale(1.06)` on the blurred render source) have no lasting text and are fine.

### 3.2 The logo
- **Mark:** already vector (`public/brand/particl-mark-on-dark.svg`).
- **Wordmark:** PNG only (`particl-wordmark-on-dark@4x.png`, 1188×640); the header serves 128, 256 or 384 px through `/_next/image` for a 68 px box. Sharp at 2×, but not vector. **Lockups** (horizontal, stacked) on sign-in and marketing are also PNG only.
- **Needed from the owner or the brand designer:** SVG wordmark and lockups, on dark and on light, with outlined text. Tracing the PNG is not brand-safe. Then the change is `BrandLogo.tsx` plus the brand-assets guard (S).

### 3.3 Raster images
No surface that shows user media uses `srcset`; `next.config.ts` has no `images` block; `/api/media/[id]` and `/api/uploads/[id]` take no width and redirect to the original.
- **Renditions that exist:** the originals; one fixed 640 px webp thumbnail, images only (made with sharp, in memory, not stored: `app/api/workbench/preview/[kind]/[id]/route.ts:39`); client-captured video posters (`LazyMedia.tsx`, tiers 480 to 1920, localStorage); Topaz 4K upscales stored as a separate `generations` row (`task='upscale'`, `source_gen_id`, `lib/generationAdmission.ts:2360-2382`), which nothing finds for display.
- **Missing:** (1) a width-tier route (for example `?w=640|1280|1920|2560|3840`) with stored or edge-cached copies; (2) `srcset`/`sizes` on the v25 components; (3) server-stored video posters at tiers; (4) a take → 4K-rendition link on the version and preview model.

| Surface | File | Source today | 2× at 2560@2 / 3008@2? |
|---|---|---|---|
| v25 step card picture | `StepCard.tsx:63-65, 119` | plain `<img>`, the original | passes while originals ≥1000 px; wasteful |
| v25 full-screen preview, picture | `CardPreview.tsx:40-42, 154` | plain `<img>`, the original, never 4K | **fails** for 1672 px stills in a panel over 836 CSS px |
| v25 preview, video | `CardPreview.tsx:211` | `<video src=original poster=storyboard frame>` | the poster is a **different picture**; no 4K |
| v25 version thumbs (72×40) | `card-preview.css:79` | full originals | over-resolved (bandwidth) |
| Board cards via LazyMedia | `TakeCard.tsx:77`, `FrameTile.tsx:40`, `LookTile.tsx:18`, `CutCard.tsx:28` | image: original; video: client poster never wider than the clip | **fails** for the 640 px sample clip (needs 832 at 2560@2, 978 at 3008@2) |
| Home covers, wall | `YourBoards.tsx:36`, `Wall.tsx:47-49` | LazyMedia; the wall's video is a live `<video #t=0.1>` with no poster | same as the clip |
| Guest sample | `VisitorHome.tsx:70, 99` | `/campaign/*.webp`, 1672/1536 px | likely fails (card about 880 CSS px, limit 836) |
| Old board fallback and blocking frames | `FallbackCards.tsx:44`, `BlockingCard.tsx:20`, `ShotBlockingStrip.tsx:53`, `AssetPreview.tsx:12` | 640 px thumbnail | fails above 320 CSS px (off the v25 path) |
| Global previewer | `PreviewLayer.tsx:270` | original only, never 4K | fails at full screen on 5K/6K |
| Library tray, Make, Rig, Rounds, Review | various | raw originals | sharp but heavy |

### 3.4 Borders
- No hairline below 1px (no `0.5px` anywhere; hairline tokens in `app/graphite.css:29-38` are 1px).
- **1.5px borders** on the rail mark (`board.css:30`, branch `rail.css:31, 50`), `StateDot.tsx:24-27`, `Stepper.tsx:31`, `globals.css:646`, `shell.css:863`: crisp at DPR 2, soft at DPR 1. Fix: 1px or 2px (S).
- **Canvas borders scaled by the zoom:** at zoom 1.2 or 1.6 a 1px border is 2.4 or 3.2 device px at DPR 2 and blurs; fixed by A1.
- **Fractional viewport translate** (`viewportFor` and glides) blurs every border on the board even at zoom 1. Fix: round x/y (S, worth doing first).
- `translate(-50%)` on bordered or text elements gives half CSS pixels: soft only at DPR 1; can wait.

### 3.5 Screenshot tooling for six sizes
1. `playwright.redesign.config.ts`: sizes become `[w, h, dpr]`, ending `[2560, 1440, 2]` and `[3008, 1692, 2]`; project names get `@2x`; `use.deviceScaleFactor` is set.
2. `tests/helpers/redesignShots.ts` `captureBeside`: tag `${w}x${h}@2x`; JSON records `dpr`; the side-by-side canvas is sized in device pixels (`size.width * dpr * 2 + gap`, `size.height * dpr`), without which the composite throws at DPR 2.
3. `scripts/redesign/publish-shots.mjs`: the file filter must accept `(@2x)?`; a 6016×3384 PNG is about 15 to 30 MB and the side-by-side is 12k px wide, so add a downscaled WebP for the PR table and link the full PNG; the script pushes, so only the lead runs it.
4. Large-screen specs (`tests/board-large-screens-workbench.spec.ts`, `tests/helpers/brandLarge.ts`, the rail and card branches, `tests/redesign/*large*.shots.ts`): add 3008×1692; the last two sizes run in `browser.newContext({ deviceScaleFactor: 2 })` (`setViewportSize` cannot change DPR, so the single-page walk becomes one context per size); one shared `tests/helpers/ownerSizes.ts` replaces the five copied `SIZES` arrays; a unit asserts `screenScale(3008, 1692) === 1.88`.
5. Remove `SAMPLE_CLIP_WIDTH` (640) from board-large-screens' sharpness test: an upscaled picture is a must-fix, so the fixture needs a sample clip at least 2000 px wide, or the demo's real renders.

### 3.6 The automated `<img>` check (design)
**Rule (owner):** fail when an `<img>` is displayed larger than its natural size ÷ 2, that is `drawnCssWidth * 2 > fileWidth` (and the same for height). Helper `tests/helpers/sharpMedia.ts` exporting `expectSharpMedia(page, { exempt? })`:
- **Run at DPR 2** (`test.use({ deviceScaleFactor: 2 })` or its own context); assert `devicePixelRatio === 2` so a `srcset` picks its 2× candidate.
- **Use the file's real pixels, not `naturalWidth`:** with `srcset`, `naturalWidth` is divided by the candidate's density (the wordmark's 256 px file reads 128 and would fail falsely). Decode `currentSrc` in a plain `new Image()` with no `srcset`.
- **Skip vectors:** `.svg` and `data:image/svg`.
- **Drawn size follows `object-fit`:** `fill` the box size; `cover` `s = max(bw/fw, bh/fh)`; `contain` `s = min(...)`; the rect from `getBoundingClientRect` (so the canvas zoom counts); fail if `s > 0.5` (1% allowance).
- **Also check** `<video>` (`videoWidth`/`videoHeight` against the drawn box, and the `poster` URL probed the same way) and CSS `background-image` on media boxes.
- **Wait before measuring:** until images are complete and LazyMedia's poster upgrades have settled (about 10 s).
- **Exemptions only by an explicit attribute in product code** (for example `data-sharp-exempt="blurred-source"` on the render card's blurred picture), never by URL or size in the test.
- **Report** each failure as `src`, file px, drawn CSS px × 2.
- **Would fail today at DPR 2:** board-large-screens `sharp()` at 2560@2 and 3008@2 (the 640 px sample clip, which passes only because of the `SAMPLE_CLIP_WIDTH` excuse); card-v25-preview (the full-screen picture); the visitor/guest specs; old-board specs over 320 CSS px (off the v25 path). **Would pass:** the 8-shot stills at every size, the wordmark (measured by file pixels), Home covers with still covers.

### 3.7 The 31 Oct demo path: must-do before the demo, and what can wait
The demo path (Agent mode, house workspace; `tests/demo-path-workbench.spec.ts`): Home → New project (#795) → Brief/Script (#802) → Shots board → preview → Edit → MP4/SRT/PDF exports. It is likely shown on the owner's Studio Display (2560@2).

**Must-do before the demo:**
1. Round the board viewport's x/y to device pixels (S, today).
2. **Owner decision and conversion of the large-screen base zoom to real layout sizes (A1)**, L, 2 to 3 days, lane C. If not converted, the demo's board text is a 1.6× transform.
3. #802 TextStage: remove `zoom: scale` before merge (S).
4. Width-tier image route plus `srcset` on StepCard, CardPreview and YourBoards covers (M, about 1 day).
5. Preview: the 4K rendition when one exists (the `source_gen_id` + `task='upscale'` lookup on the version model) and a video poster taken from the take itself, not the storyboard frame (M, about 1 day).
6. A sample clip ≥2000 px for the fixtures and any demo sample, or the demo uses real 1080p+ renders.
7. SVG wordmark and lockups from the owner (owner action).
8. Screenshot tooling at six sizes with DPR 2, plus `expectSharpMedia` on the demo-path and v25 specs (S to M, about half a day).
9. Rail 1.5px borders → 1px or 2px (S).

**Can wait:** Presence cursor labels; the legacy workbench canvas; old-board 640 px thumbnails; Library, Make, Rig and Review raw originals; `translate(-50%)` half pixels (fine at DPR 2); the global PreviewLayer 4K; server-stored poster tiers (the client capture is enough for the demo).

### 3.8 Owner questions (from the audit)
1. Is the person's own pinch or + zoom on the board exempt from "never transform on text"?
2. Should the 2560 projects be DPR 2 only, or also DPR 1 (the owner's list replaces 2560@1)?
3. Can lane C spend 2 to 3 days on A1 before 31 Oct, or does the demo run with the rounding fix only? (The audit proposes the `--bk` multiplier, pending the owner's go.)

## 4. Where this meets other work
- The five-viewport large-screen rules of 15 Oct 22:30 are the base; this target adds 3008×1692 and the factor-2 shots, and replaces "attach all five" with "attach all six".
- `docs/plans/deck-editor.md` renders pages crisp at 3008×1692 @2× and keeps text as live text until a raster export.
- `docs/plans/editing-standard.md` item 13 requires these checks on every edit surface.
