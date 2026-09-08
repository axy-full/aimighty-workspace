# Handoff: particl studio + atomik — production pipeline redesign

## Overview

A redesign of every page of **particlstudio.com** (the studio's generation app) plus the four screens of its sibling **atomik** (idea → shot list), organised around one production pipeline:

```
ATOMIK (light)                                  PARTICL (dark)
01 Ideas → 02 Brief → 03 Treatment → 04 Breakdown → 05 Shot list  ⇄  06 Cast & identities → 07 Shot setup → 08 Generate → 09 Review → 10 Canvas → 11 Delivery → 12 Cost & usage
```

The shot list is the handoff going in (order, cast tags, setup, cap). State, take count, cost to date and the master link are the handoff coming back. Five roles: director (approves), producer (owns the cap), artist (renders), editor (sequences, downloads masters), admin (seats, keys).

Sample production used in every mock: **Northline**, a 30s car spot, 12 shots, cast @Cass and @Iver, locations @Workshop and @Coast road, prop @The Mule, look Bleach bypass. All names, costs, counts and job data are **placeholder** and must come from real APIs.

## About the design files

Everything in `design-references/` is a **design reference authored in HTML** — a prototype of the intended look and behaviour, not production code to lift. Recreate these screens in particlstudio.com's own environment (its existing Next/React components, routing and styling patterns). `support.js` is a preview-only runtime so the files open standalone in a browser; do not port it. Striped grey rectangles labelled in monospace (`render · SH04 · v2`, `board 04`, `FACE · CASS`) are **image placeholders** — in production they are real masters, stills, boards and photos.

Open `Pages Overview.dc.html` first: it shows every page live at half size in pipeline order. `Particl Workflow Map.dc.html` is the swimlane map the pages were built from.

## Fidelity

**High-fidelity.** Colours, type, spacing, radii, states and copy are final-intent; recreate pixel-accurately with the codebase's libraries. Interactive prototypes (filters, shot selection, the shot builder's prompt assembly) show the intended behaviour; their data is mock.

---

## Brand and design tokens

Both brands share one palette and type system (machine-readable copy in `design-tokens.json`). **No accent colour exists in the system** except one functional state colour (approved), listed below.

### Colour — dark (particl app)

| Token | Value | Use |
|---|---|---|
| page | `#1D1F24` | page background |
| panel | `#0B0D11` | header buttons, rails, cards, tables |
| panelRaised | `#0F1115`, `#12141A` | hover rows, raised cards |
| ink | `#F5F6F8` | primary text, marks, primary button fill |
| inkMuted | `#B4B7BE` | body copy, descriptions |
| muted | `#8A8E96` | secondary text, labels, inactive nav |
| faint | `#666A72` | disabled / empty-state text |
| hairline | `rgba(245,246,248,.06–.08)` | dividers |
| border | `rgba(245,246,248,.08–.10)` | card borders |
| borderStrong | `rgba(245,246,248,.14–.18)` | secondary buttons, inputs |
| borderHover | `rgba(245,246,248,.28–.40)` | hover on cards/buttons |
| selected fill | `rgba(245,246,248,.10–.12)` | active segmented option, active sub-tab |
| **approved** | `oklch(75% 0.12 200)` | the only colour: approved dot, approved card outline, approved timeline segment. Dark ground only. |

### Colour — light (atomik)

page `#ECEDEF` · panel `#FCFCFD` · panel-alt `#F4F4F6` · ink `#15171C` · muted `#666A72` · border `rgba(21,23,28,.10)` · borderStrong `rgba(21,23,28,.14–.16)` · selected fill `rgba(21,23,28,.08–.10)` · hover fill `rgba(21,23,28,.06)` · tag fill `rgba(21,23,28,.07)` · placeholder stripes `#E2E3E6 / #E9EAEC` · changed-row tint `#F7F5EC` · **approved** `oklch(55% 0.12 200)` (darker for contrast on light).

### Typography

Google Fonts: `Outfit` (400/500/600) and `Kode Mono` (400/500). No serif anywhere.

| Role | Spec |
|---|---|
| Wordmark particl | Outfit 600, tracking -0.03em, `partıcl` (dotless ı with ring tittle, see below) |
| Wordmark atomik | Outfit 500, tracking +0.005em, `at◯mık` — the ring mark set as the o |
| Page h1 | Outfit 600 30px/1.1, tracking -0.02em (34–40px on Welcome, Ideas, Workflow Map) |
| Section title | Outfit 600 15–18px/1 |
| Card title | Outfit 600 13.5–15px/1.1–1.2 |
| Body | Outfit 400 13–14px/1.4–1.5, `text-wrap:pretty` |
| Reading copy (Treatment) | Outfit 400 16.5px/1.65 |
| UI label / button | Outfit 500 12–13px/1 |
| Mono label | Kode Mono 500 10–11px/1, uppercase, letter-spacing 0.12–0.18em |
| Mono value (cost, ids, versions) | Kode Mono 500 11–12px/1, no extra tracking |
| Nav | Kode Mono 500 11px, uppercase, letter-spacing 0.12em |
| Stat numeral | Outfit 600 22–34px/1, tracking -0.02em |

### Radius

4 (thumbnails, tags) · 5 (small chips, segmented options) · 6 (buttons, chips) · 7 (inputs, segmented containers, primary CTA in tables) · 8 (cards, composer prompt, primary render button) · 9–10 (panels, project rows, settings sections) · 50% (avatars, state dots).

### Spacing

Header 52px · sub-nav 44–48px · page padding `36px 40px` (list pages) or `18–26px 20–28px` (workspace pages) · card grid `gap:12px` · card padding `9–12px 11–14px` · composer rail 400px · right detail rail 360–400px · left shot list (alt layout) 316px.

No shadows anywhere. Depth is 1px borders and background steps.

### Logo marks (both are dot fields on a `0 0 200 200` viewBox, single flat fill, no strokes)

**particl** — accelerating trail, 7 dots: `(38.7,120.8,r1.8) (50.9,100.5,r2.8) (69.8,86.3,r4) (92.7,80.1,r5.5) (116.2,83,r7.2) (136.9,94.5,r9.2) (151.7,112.9,r12)`. In headers it is cropped to `viewBox="30 68 140 64"` at 34×16px, followed by the wordmark at 17px, gap 9px.

**atomik** — the trail closed into a ring, 8 dots on a 62-unit circle, head at top: `(100,38,r16) (56.16,56.16,r11.9) (38,100,r8.8) (56.16,143.84,r6.5) (100,162,r4.8) (143.84,143.84,r3.6) (162,100,r2.7) (143.84,56.16,r2)`.

**atomik wordmark recipe (used in every atomik header, the map and the overview):** a flex row, `align-items:baseline`, Outfit 500, tracking 0.005em: `at` · the ring SVG cropped to `viewBox="20 22 160 145"`, `height:0.61em; width:0.67em; margin:0 0.03em`, `fill:currentColor` · `m` · a dotless `ı` in a `position:relative` span with the ring tittle (`0.17em` circle, `0.035em` border, `top:0.09em`, centred with `translateX(-50%)`) · `k` · optional sub-line `BY PARTICL` in Kode Mono 500 at 0.6× size, letter-spacing 0.3em, `margin-left:0.6em`, muted. **Never place the standalone ring next to the wordmark.** The standalone ring appears only as a badge beside an all-caps mono label (`ATOMIK`, `FROM ATOMIK`), 14–16px, and at 28px in Settings › Atomik connection.

Rules: never rotate, recolour per dot, stroke, gradient or add an accent to either mark.

### Placeholders

Image wells: `repeating-linear-gradient(135deg,#15181E 0 6px,#191C22 6px 12px)` (dark) or `#E2E3E6 / #E9EAEC` (light), 1px border, radius 4–8, mono caption. Waveforms (Audio): `repeating-linear-gradient(90deg,rgba(245,246,248,.34) 0 2px,transparent 2px 5px)` masked to a 22–78% band with a centre hairline.

---

## Shared components

### Particl app shell (every particl page)

- **Header** 52px, `border-bottom:1px hairline`, padding `0 16px 0 18px`, flex, gap 18px:
  1. Logo link (mark 34×16 + `partıcl` 17px) → `/` (Video).
  2. 1px vertical divider, 18px tall, `rgba(245,246,248,.14)`.
  3. **Project switcher**: panel-filled pill, 1px border, radius 6, padding `6px 10px`, `Northline` Outfit 500 13px + `30s car spot` muted 400 + `▼` 10px muted. Shows `All projects` on Projects, Library and Settings. Hover: border `.3`.
  4. **Nav** centred: `VIDEO IMAGES AUDIO | PROJECTS STUDIO USAGE SETTINGS`, Kode Mono 11px 0.12em, padding `0 12px`, full header height; active = ink + `box-shadow: inset 0 -2px 0 #F5F6F8`; inactive = muted, hover ink. Divider between the two groups.
  5. Right: **cap readout** `$57.20 OF $250 CAP` (Kode Mono 11px, value in ink, rest muted; `$612.40 THIS MONTH` on studio-level pages) → Usage; **avatar** 28px circle, panel fill, 1px border, initials Kode Mono 11px → Settings.
- **Project sub-nav** (Canvas, Studio): 44px row, items Outfit 500 12.5px, padding `7px 10px`, radius 5; active = `rgba(245,246,248,.1)` fill; right-aligned context text or atomik badge link.
- **Segmented filter**: container panel fill, 1px border, radius 7, padding 2px; options radius 5, padding `6px 10px`, Outfit 500 12px; active `rgba(245,246,248,.12)` fill + ink, inactive muted; counts in Kode Mono 11px at 70% opacity.
- **Primary button**: ink fill `#F5F6F8`, text `#0B0D11`, Outfit 600 13–14px, radius 7–8, height 38–46px; hover `#FFFFFF`. **The cost is always on the action**: right-aligned inside the button in Kode Mono 500 12px `#3A3E46`, e.g. `Render · $2.86 · 244.8k TOK`, `Generate 2 stills · $0.08 · 2 × $0.04`.
- **Secondary button**: transparent, 1px `borderStrong`, ink text, Outfit 500 12–13px, radius 6–7; hover border `.4`.
- **Dashed add button**: `1px dashed rgba(245,246,248,.22)`, muted text; hover border `.5` + ink.
- **Dropdown chip**: panel fill, 1px border, radius 6, padding `7px 10px`, Outfit 500 12px, `▼` 9px muted. Model chips carry a secondary mono value (`1080P 1920×1088`).
- **Toggle**: 22×12 pill, ink fill, 8px dark knob right (on).
- **Cast chip**: panel fill, 1px border, radius 6, padding `5px 9px 5px 5px`, 20px striped thumb, `@Name` Outfit 500 12px, kind in Kode Mono 10px muted (`CHAR / LOC / PROP / TRAINED / TRAINING`).
- **@mention in prompt text**: `rgba(245,246,248,.1)` fill, radius 4, padding `0 4px`, weight 500.
- **State dot** (8px; 7px in small rows): approved = filled `oklch(75% 0.12 200)`; picked = filled ink; draft = `1.5px solid #8A8E96` outline; no take yet = `1.5px dashed #8A8E96`; rendering = word "Rendering" + 3px progress bar at the bottom of the thumbnail (`rgba(245,246,248,.12)` track, ink fill). Approved **cards** also get a 1px `oklch(75% 0.12 200)` inset outline over the whole card.
- **Take card**: panel fill, 1px border, radius 8, hover border `.28`; 16:9 well with version badge top-left (`rgba(11,13,17,.85)`, radius 4, Kode Mono 11px) and duration/spec badge bottom-right; body `10px 12px 11px`: state row (dot + word, cost right in Kode Mono 12px) and meta row (`Seedance 2.5 · 1080P · 0:05` / `by TO`, muted 11.5px).
- **Search field**: panel fill, 1px border, radius 6, height 30px, `⌕` mono glyph, placeholder muted 12px.
- **Composer rail** (Video, Images, Audio): 400px, panel fill, `border-left` hairline; 52px title row (`Composer` + `FILED AGAINST SH04 ▼` chip); scrollable body, padding 16px, gap 18px; fixed footer with primary Render button (46px) and a mono filing line (`files as SH04 v4 · Seedance 2.5 · 5s · 1080P`).
  - **Prompt box**: `#1D1F24`, 1px border `.1`, radius 8, padding `12px 13px`, min-height 100–118px, Outfit 400 14px/1.55; hover border `.22`.
  - **Reference row**: 52px dashed `+ Add` tile, 52px striped reference tiles with mono captions, right-aligned muted note.
  - **Setup block**: title `Setup` + mono `CARRIED INTO EVERY SHOT` + `EDIT IN STUDIO →`; 2-column key/value list, rows `padding:4px 0`, hairline under each, key muted / value ink, Outfit 12.5px.
  - **Cast block**: title `Cast` + mono `WRITE @NAME IN ANY PROMPT`; wrapped cast chips + dashed `+ Add`.

### Atomik app shell (every atomik page)

Header 52px on `#FCFCFD`, `border-bottom 1px rgba(21,23,28,.1)`: `at◯mık BY PARTICL` wordmark (17px) → Ideas; divider; project switcher (`#ECEDEF` fill, 1px border `.12`); nav `IDEAS TREATMENT BREAKDOWN SHOT LIST` (active ink + inset 2px underline, inactive `#666A72`); right: `OPEN IN PARTICL →` with the 26×12 particl mark in `currentColor`, muted; avatar 28px. Primary button: `#15171C` fill, `#F5F6F8` text, hover `#000000`. Secondary: 1px `rgba(21,23,28,.16)`, hover `#15171C`. Tags: `rgba(21,23,28,.07)` fill, radius 4, Outfit 500 11px. Cards: `#FCFCFD`, 1px border `.1`, radius 9–10, hover border `.4`.

---

## Screens

### 00 · Welcome + Sign in — `Particl - Welcome.dc.html` (`/welcome`, `/login`)

Grid `minmax(0,1fr) 440px`, min-height 100vh. **Left** (`padding:56px 72px 44px 64px`, space-between): lockup — mark 112×51 + `partıcl` Outfit 600 64px with `STUDIO` Kode Mono 13px 0.36em right-aligned beneath; tagline Outfit 400 28px/1.3 max-width 640: "The studio's own room for making shots — and for knowing what they cost."; **2×2 feature grid** (1px gap over `rgba(245,246,248,.08)`, radius 10, max-width 820), each cell a link (`padding:22px 24px`, hover `#22252B`) with mono eyebrow (`01 · VIDEO · IMAGES · AUDIO`, `02 · STUDIO`, `03 · PROJECT`, `04 · USAGE`), Outfit 600 20px title (Generate / Studio / Canvas / Production) and the **verbatim site copy** (see Video/Studio/Canvas/Usage below); footer: infrastructure paragraph (muted 13px, verbatim: "particl studio runs Seedance on BytePlus ModelArk and Google's Nano Banana through Vercel AI Gateway. Masters are stored byte-for-byte and never compressed to suit an API.") and an atomik badge link `IDEA TO SHOT LIST · ATOMIK →` (ring 16px). **Right** (`#0B0D11`, `border-left` hairline, centred form, `padding:48px 44px`): h1 `Sign in` 30px; "Particl is for the studio team."; `EMAIL` / `PASSWORD` mono labels over 44px inputs (`#1D1F24`, 1px border `.12`, radius 7, focus border `.5`); 46px primary `Sign in`; footer row "Invitation only. Contact management" + `LOOK AROUND →` (signed-out browse of the real interface).

### 08 · Video — `Particl - Video.dc.html` (`/`)

Site copy: "A prompt, a model, a duration. The cost is on the button before you press it."

Grid `minmax(0,1fr) 400px`, height 100vh. **Wall** (left): 52px toolbar — `The wall` + mono `20 TAKES · 12 SHOTS` + `CANVAS →` `LIBRARY →`; segmented filter `All 20 / Draft 12 / Picked 2 / Approved 5` (live counts); right: `Group by shot ▼`, search (200px), grid/list toggle. Body scrolls (`padding:18px 20px 40px`, gap 26px): **one group per shot** — header row `SH04` (mono muted) + title Outfit 500 14px + meta `3 takes · $8.58` muted + hairline flex-fill + `OPEN SHOT →`; then take cards in `repeat(auto-fill,minmax(228px,1fr))`, gap 12. Filtering hides takes and drops empty groups. **Composer rail** as specified; chips row: `Seedance 2.5 ▼`, `16:9`, `1080P 1920×1088`, `5s`, `Audio` toggle, `More…`; Setup shows Shot size / Angle / Move / Lens / Lighting / Time of day / Look / Mood; Cast: @Cass CHAR, @Iver CHAR, @Workshop LOC, @The Mule PROP, `+ Add`; footer `Render · $2.86 · 244.8k TOK` / `files as SH04 v4 · Seedance 2.5 · 5s · 1080P`.

Alternate layout kept for reference: `Composer B - Split shot list.dc.html` — 316px shot list left (thumb, id, title, take count, state dot, spend; selected row `rgba(245,246,248,.09)`), large 16:9 preview with scrub bar, takes filmstrip (150px cards + dashed `+ v4 COMPOSE BELOW ↓`), composer docked bottom in a `1fr 320px` split. Not the chosen direction.

### 08 · Images — `Particl - Images.dc.html` (`/images`)

Same skeleton as Video. Toolbar: `Stills` + `18 STILLS · 12 SHOTS` + `CAST →`; filter `All / First frames / Cast stills / Loose`. Still cards (`minmax(200px,1fr)`): badge `S1` top-left; role badge top-right — `FIRST FRAME · V2` (ink fill, dark text) or a cast tag (`@CASS`, bordered); meta `Nano Banana · 2K` / `$0.04`; action row of three small bordered buttons `First frame` / `To cast` / `↓`. Composer: prompt with @mentions; references show identity stills (`CASS`, `IVER`) with note "identity stills carried from cast"; chips `Nano Banana ▼`, `16:9`, `2K 2048×1152`, `×2`; **USE AS** segmented `First frame / Cast still / Loose` with helper "A first frame is pinned to the shot and offered in the video composer for SH07."; Setup (6 rows); Cast (@Cass TRAINED, @Iver TRAINING, @Workshop LOC, @The Mule PROP); footer `Generate 2 stills · $0.08 · 2 × $0.04` / `files as SH07 · S1–S2 · Nano Banana · 2K`.

### 08 · Audio — `Particl - Audio.dc.html` (`/audio`)

Toolbar: `Tracks` + `8 TRACKS · 12 SHOTS`; filter `All / Ambient / Music / Dialogue`; right note "Seedance renders its own sound when Audio is on. Tracks here replace or layer it, per take." Track rows (not cards): grid `34px 110px 1fr 150px 70px 90px`, panel fill, radius 8, padding `10px 14px`: 34px round `▶`; type + `A1 · 0:05`; waveform placeholder 36px; attachment (`Attached to v2 (approved)` ink / `Loose` / `Loose · @Cass · no voice yet`) + model line muted; cost; `Attach` + `↓`. Composer: segmented `Ambient / Music / Dialogue`; prompt (plain, no mentions); chips `Audio model ▼`, `5s MATCHES SH04`, `Stereo`, `48 kHz`; **VOICE · DIALOGUE ONLY** row: `@Cass NO VOICE YET` chip (muted) + dashed `+ Voice`, helper "A voice is learned in Studio the way a face is, and cited the same way."; Setup shows Sound / Mood / Time of day / Titles; footer `Render · $0.18 · 5s` / `files as SH04 · A3 · ambient · 5s`.

### 09 · Projects — `Particl - Projects.dc.html` (`/projects`)

Page (`max-width:1360`, `padding:36px 40px 48px`): h1 `Projects` + sub "A production exists once, in both rooms. Its words live in Atomik; its renders live here."; right: secondary `Browse every render →` (Library) + primary `New project`. **Table** (panel fill, radius 10): mono header `PRODUCTION / STAGE / SHOTS · APPROVED / TOTAL / SPEND / CAP / TEAM / LAST ACTIVITY`, columns `minmax(260px,1.4fr) 150px 220px 200px 140px 150px`; rows are links (`padding:16px 18px`, hover `#12141A`): 72×40 thumb + name Outfit 600 15px + `kind · runtime`; stage with dot (Rendering = filled ink, In review = ink outline, Delivered = approved colour, Brief only = dashed); shots `3 / 12` + `2 picked` over a 3px approved-colour bar; spend `$57.20` / `of $250` over a 3px ink bar; overlapping 26px initials avatars (`margin-left:-6px`); last activity + origin mono (`FROM ATOMIK · SYNCED`). Footer line: privacy/cast-scope note + `4 PRODUCTIONS · 41 SHOTS · $612.40 THIS MONTH`. Rows: Northline (Rendering), Saltwater (In review), Half Light (Delivered), Meridian (Brief only → links to the atomik shot list).

### 09–11 · Canvas — `Particl - Canvas.dc.html` (`/projects/:id/canvas`)

Site copy: "The sequence on a wall, in order, next to the references it came from."

Sub-nav `Shots · Canvas · Cast · Cost` + right badge `SHOT LIST · ATOMIK · SYNCED 2 MIN AGO →`. Grid `1fr 360px`. **Sequence** (`padding:22px 24px 20px`): title `The sequence` + `12 SHOTS · 0:30 OF 0:30 · 3 APPROVED · 2 PICKED · 7 OPEN` + `▶ Play approved` / `Download 3 masters ↓`. Three labelled rows (labels 64px mono `REFS / WALL / TIME`), each a 12-column grid, gap 8: **REFS** — 16:9 striped boards per shot (`board 04`, `ref · rain`) from the atomik breakdown; **WALL** — one button per shot: 16:9 well (striped if it has a take, flat `#0B0D11` + `no take` if empty), footer `SH04` + state dot + `0:03`; border approved-colour when approved, dashed when empty, ink when selected (+ `0 0 0 2px rgba(245,246,248,.18)` ring); **TIME** — flex bar, segment width ∝ planned seconds, colours approved / ink (picked) / `.3` (draft) / `.08` (open), ticks `0:00 0:10 0:20 0:30`. Note under it: "Only approved takes play in the sequence. A picked take holds its slot and shows as a still; an open shot shows as a gap the length of its planned duration. References come from the Atomik breakdown and stay pinned to their shot." **Detail rail**: `SH04 · Cass enters the workshop`; 16:9 preview; 2-col facts (State, Planned, Takes, Cost so far); `CAST IN THIS SHOT` chips; `HISTORY` list (`now · TO rendering v3 · 62%`, `Sep 4 · TO picked v2 · awaiting MR`, sent-back notes in quotes); footer: secondary `Open takes` + primary contextual action (`Download master ↓` / `Approve take` / `Pick a take` / `Compose in Video`) and the master filename `northline_sh04_v2_1920x1088.mp4`.

### 09 · Library — `Particl - Library.dc.html` (`/all`)

Switcher `All projects`. Sub-bar 52px: tabs `All projects | Library`; filter dropdown chips `Project any`, `Type video · stills · audio`, `State any`, `Model any`, `Person anyone`; search 240px; `NEWEST FIRST`. **Unfiled** section first: dashed-border cards for renders made in All projects — "not filed against a shot — they have no version number and no name until they are." Each: `video · unfiled` well, spec badge, one-line prompt (ellipsis), `by · when`, bordered `File against a shot` button. Then **day groups** (`Today · Sep 5 · 9 renders · $28.66 · Northline`): standard take cards with a project badge top-left (`NORTHLINE`), `SH04 v3 · draft` state row, model/by meta; stills and audio link to their pages.

### 06 · Studio · Cast & identities — `Particl - Studio Cast.dc.html` (`/studio`)

Site copy: "Name a face, a place or a look once. Cite it by name in every shot after." Intro (verbatim): "The hard part isn't making one good shot, it's making the second one match. Train a face from photos and it comes back as itself; name a face, a place or a prop once and it comes back exactly in every prompt afterwards."

Sub-nav `Cast & identities | Camera & shot builder` + right note "You're in Northline — cast added here stays with this production." Grid `1fr 380px`. **Identities** — `a real face, learned from photos` + secondary `New identity`; cards `84px 1fr` grid: 84px face still, name, state (`Trained · 18 photos` approved dot / `Training on fal.ai · 62%` ink dot + 3px progress), usage line; dashed `Add an identity` card: "Ten to twenty photos of one person teach a small model that face. Gather the photos here; training runs when you press Train." **Cast and elements** — "A face, a place, a prop or a look, defined once. Open one to see everything made with it."; segmented `All / Character / Location / Prop / Look`; cards `minmax(200px,1fr)`: 4:3 still with kind badge (`CHARACTER`) and `IDENTITY` badge when trained, name, 2-line description, mono `6 SHOTS · 11 TAKES`; dashed `+ Add to cast` — "A still and a line of description, then write @TheirName in any prompt." **Detail rail** for the selected element: still, description, `Replace still / Edit description / Retrain`, `EVERYTHING MADE WITH @CASS` 3-column take thumbs, and an `IN THE PROMPT` explainer with the @tag highlighted. Selecting an identity or cast card sets the rail (border ink on the selected card).

### 07 · Studio · Camera & shot builder — `Particl - Studio Shot Builder.dc.html` (`/studio/shot`)

Right note "Building for SH04 · Cass enters the workshop · from the Atomik shot list". Grid `1fr 400px`. **The camera** — "The bank — every move, written so the engine can't mistake it. Where a render used one, it shows." Grid `minmax(128px,1fr)`, gap 6: bank tiles (panel fill, radius 7, padding `9px 10px`): name Outfit 500 12.5px, kind mono 9px (`MOVE` / `TECHNIQUE`), usage `7 TAKES` ink or `NO TAKE YET` faint; selected = `rgba(245,246,248,.1)` fill + ink border. 28 moves + 7 techniques (lists below). **The shot** — 12 rows (`200px 1fr`, hairline-separated, `padding:14px 0`): label Outfit 600 13.5px + helper muted 11.5px; chips `padding:6px 10px`, radius 6, 1px border `.12`; selected = ink fill, dark text. Exactly one pick per row; clicking the selected chip clears it (Titles can't be cleared). **The prompt rail**: `The prompt` + `11 OF 12 ROWS SET`; box with the shot's subject line (with @mentions) and, under a hairline, the **assembled line** rebuilt on every pick: `Medium wide, eye level. Push in, one move. 35mm. Practicals, dusk. Bleach bypass. Tense. Real time. Ambient only. No subtitles.` — a technique replaces the move sentence with `Technique — plain-language explanation.` (niche terms carry their own explanation); key/value summary of the 12 rows (unset = `—` faint); rules paragraph; footer: primary `Take it to Video · SH04 · V4`, secondary `Save as Northline setup`, mono note "nothing is rendered here — the composer keeps the model, duration and references".

Row options (verbatim from the live product):
- Shot size: Extreme close, Close-up, Medium close, Medium, Medium wide, Wide, Establishing, Over shoulder, POV, Insert — "How much of the subject the frame holds."
- Angle: Eye level, Low, High, Dutch, Top down, Ground level — "Where the camera sits relative to the subject."
- Camera move: Locked off, Push in, Pull out, Pan, Tilt, Tracking, Crane, Handheld, Orbit, Steadicam, Pan left, Tilt down, Truck left, Truck right, Pedestal up, Pedestal down, Zoom in, Zoom out, Crane down, Leading, Following, Chase, Low tracking, Top down, Snorricam, Motion control, Arc, Fly through — "One move per shot — engines blur when asked for two. A technique that travels overrides this row."
- Lens: 14mm, 24mm, 35mm, 50mm, 85mm, 135mm, Macro, Anamorphic — "Focal length changes the shape of a face and the depth of a street."
- Lighting: Natural, Soft, Hard, Practicals, Neon, Rim light, Backlit, Chiaroscuro, Firelight, Mixed colour — "The quality and source of the light — not the hour, which is its own row."
- Time of day: Dawn, Morning, Midday, Afternoon, Golden hour, Dusk, Blue hour, Night — "The hour lives here alone — golden hour is a time, not a lighting setup."
- Look: Clean digital, 16mm, 35mm film, VHS, Bleach bypass, Teal & orange, Black & white, Muted — "Stock and grade — how the image is finished."
- Technique: One-shot, Dolly zoom, Rack focus, Aerial, FPV, Bullet time, Whip pan, Crash zoom — "Named moves the engine knows by name. The niche ones carry their own explanation."
- Mood: Calm, Tense, Joyful, Epic, Intimate, Melancholy, Documentary · Motion: Real time, Slow motion, Speed ramp, Timelapse · Sound: Ambient only, Music-led, Dialogue-led, Silent · Titles: No subtitles — "Subtitles and audio are the only things the engine reliably takes a NO for — everything else should be described positively."

### 12 · Usage — `Particl - Usage.dc.html` (`/usage`)

Site copy: "What the job cost, who spent it, and which shot is taking the most takes."

h1 `Production`; period segmented `September / August / Quarter` + `Export CSV ↓`. **Four tiles** (panel, radius 10, `padding:18px 20px`): mono label, Outfit 600 34px numeral, muted line — `STUDIO · SEPTEMBER $612.40`, `NORTHLINE · OF $250 CAP $57.20` (+4px bar at 23%), `COST PER APPROVED SHOT $6.67`, `PROJECTED AT THIS RATE $182`. **Row 2** (`1.1fr 1fr`): *By production* — label / 16px bar (ink; `.35` for Unfiled tests) / mono cost, rows link to Canvas or Library; *Who spent it* — avatar + name + role, bar, cost, with the note "Anyone on the team renders; the cost is on the button before it is pressed. Change the rule in Settings." **Row 3**: *Which shot is taking the most takes* — table `SHOT / TAKES / STATE / SENT BACK / COST`; takes drawn as 22×12 blocks per take (approved colour / ink picked / `.3` draft / striped rendering / `.12` sent back) + count; note on SH03. Right: *By engine* stacked bar + legend (Seedance 2.5 · BytePlus ModelArk $54.32 · 20 takes · 4.9M tok; Audio model $2.16; Nano Banana · Vercel AI Gateway $0.72) and *Written back to Atomik* card → shot list.

### Settings — `Particl - Settings.dc.html` (`/settings`)

Grid `220px 1fr`, sticky left index (`Team & roles / Engines & keys / Storage & masters / Atomik connection / Defaults & caps`, active `rgba(245,246,248,.1)` fill). Sections are panel cards (radius 10, `padding:20px 22px`):
- **Team & roles** — table `PERSON / ROLE / CAN / LAST SEEN`; role is a dropdown chip (Director, Producer, Artist, Editor, Admin); CAN column states the permission set (Director: approve takes · send back with a note · download masters; Producer: set caps and deadlines · see every cost · unlock a capped production; Artist: render · train identities · pick a take · file against shots; Editor: order the canvas · download masters · notes on takes; Admin: seats · keys · model routing · Atomik connection). `Invite` secondary.
- **Engines & keys** — 2×2 cards (`#1D1F24`): name, what it does, status (`CONNECTED` approved-colour dot / `NOT ROUTED` muted), masked key row with `Rotate` / `Add key`, rate line. BytePlus ModelArk (Seedance 2.5, `$2.86 per 5s at 1080P (244.8k tok). 10s doubles.`), Vercel AI Gateway (Nano Banana, `$0.04 per still at 2K`), fal.ai (identity training, `FAL_KEY`, ~$1.20 per identity), Audio model (no key yet).
- **Storage & masters** — three cards: BUCKET `1.84 TB · particl-masters · eu-west · 2,318 files · every take kept, nothing pruned`; FILE NAMING `{project}_{shot}_{version}_{w}x{h}.{ext}` ("Filing against a shot is what gives a render its number and its name."); DELIVERY `Per shot` (editors and directors download; artists can't).
- **Atomik connection** — ring 28px + title; status `CONNECTED · BOTH WAYS`; two cards: *ARRIVES FROM ATOMIK →* (project and cap · shot list in order with planned durations · @cast tags with descriptions and stills · references per shot · setup defaults) and *← GOES BACK TO ATOMIK* (per shot: state · take count · cost to date · master link once approved; prompts and takes stay); `Sync now` + primary `Open Atomik →`.
- **Defaults & caps** — 2-col rows: Default model `Seedance 2.5 ▼`; Cost approval rule `Anyone renders ▼` (alternatives: Cap per shot, Producer approves); `5s · 1080P · 16:9`; Warn the producer at `80% OF CAP`; Seedance audio on new renders (toggle on); At the cap `Producer unlocks ▼`.

### 01 · Atomik · Ideas — `Atomik - Ideas.dc.html`

h1 `Ideas` 34px + sub "A logline, a tone, a few references. Pin the ones worth a brief. When one becomes a production it keeps its card, and the card keeps pointing at it."; segmented `All / Pinned / In production / Parked`; primary `New idea`. Card grid `minmax(300px,1fr)`, gap 14: card (`#FCFCFD`, radius 10, `padding:18px 20px 16px`; border approved-colour when in production): mono `#07 · Aug 20` + state (`PRODUCTION` approved dot / `PINNED` ink dot / `OPEN` outline / `PARKED` dashed); logline Outfit 400 17px/1.4; tone chips (bordered); 3 reference wells 16:10; footer `MR · 3 pins` + mono action (`NORTHLINE · 12 SHOTS → PARTICL`, `WRITE THE TREATMENT →`, `PIN IT`, `UNPARK`).

### 02–03 · Atomik · Treatment — `Atomik - Treatment.dc.html`

Grid `240px 1fr 300px`, height 100vh. **Outline rail**: `TREATMENT · DRAFT 3`, `Northline`, `30s · 5 scenes · MR · edited 40 min ago`; scene list (`n / title / 0:08`, active `rgba(21,23,28,.08)`); runtime bar (segments ∝ seconds; an over-length scene in `#666A72`) with note "Scene lengths are what the breakdown will have to fit. Scene 3 is a second over."; bottom primary `Break down into shots →`. **Document** (`max-width:680`, centred, `padding:40px 48px 80px`): h1 38px, logline 17px muted, setup-default chips (Tense · Practicals · Bleach bypass · 35mm · "Setup defaults → carried into every Particl shot"); five scenes: eyebrow `SCENE 1 · 0:08` + title 20px, prose 16.5px/1.65 with @mentions highlighted (`rgba(21,23,28,.08)` fill). **Right rail** (`#FCFCFD`): tabs `Cast found | Notes · 3`; helper "Every @name in the treatment becomes a cast entry. Give each a still and a line here, and Particl gets them with the shot list."; cast rows (40px still, `@Cass`, `Character · face · 4 mentions`, state `READY` approved / `TRAINING` ink / `NEEDS STILL` ink); margin notes with a 2px left rule (author + scene in mono, note text).

### 04 · Atomik · Breakdown — `Atomik - Breakdown.dc.html`

Sticky sub-bar (`#F4F4F6`): `Breakdown` + `12 SHOTS · 0:30 OF 0:30 · EST. $31.46 AT ONE TAKE EACH` + 220px runtime bar + note "Runtime is the sum of planned durations. Seedance bills 5s minimum, so every shot estimates at $2.86." + primary `Build the shot list →`. Per scene, grid `280px 1fr`: sticky scene card (`SCENE 1`, `0:08 / 0:08` — planned over scene length in `#666A72` when over; title; excerpt; cast tags; dashed `+ Shot in this scene`) and shot cards `minmax(280px,1fr)`: 16:7 board well with `SH01` ink badge and `3s` badge; description 14px; setup dropdown chips (`Establishing ▼ Eye level ▼ Locked off ▼ 24mm ▼`); footer cast tags + `$2.86` (or `TYPE ONLY · $0`). Scene 3 carries a producer's-note card about dropping the aerial.

### 05 · Atomik · Shot list — `Atomik - Shot List.dc.html`

h1 `Shot list` + "The contract with Particl. Order, cast tags, setup and the cap go across; state, takes, cost and the master link come back. The right half of every row is Particl's."; right: `Export CSV ↓`, primary `Send changes to Particl · 1 SHOT` (badge counts shots edited since last send), status `SYNCED 2 MIN AGO · BOTH WAYS`. Five stat tiles (`SHOTS · RUNTIME 12 · 0:30`, `ESTIMATE · ONE TAKE EACH $31.46`, `SPENT · FROM PARTICL $57.20 of $250`, `APPROVED · PICKED · OPEN 3 · 2 · 7`, `TAKES PER APPROVAL 2.3`). **Table** columns `52 / 1.5fr / 150 / 1.1fr / 52 / 60 / 20 / 110 / 60 / 80 / 90`: `# / SHOT / CAST / SIZE · ANGLE · MOVE · LENS / PLAN / EST. | PARTICL STATE / TAKES / SPENT / MASTER`, with a second header line `ATOMIK → GOES ACROSS` over the left six and `← PARTICL WRITES BACK` over the right four, separated by a 1px vertical rule in each row. State cell: dot + word (Approved / Picked / Draft / Rendering (striped dot) / No take yet (dashed) / Type only); master `V2 ↓` link in approved colour or `—`. Rows edited since last send tint `#F7F5EC` and read `edited since last send`. Footer: "A sent-back take returns its shot to Draft with the director's note attached. Type-only shots never render and never cost."

### Workflow map — `Particl Workflow Map.dc.html` (1920px artboard)

Swimlanes: rows = five roles, columns = 12 stages split by a `HANDOFF ⇄` gutter; atomik half on `#ECEDEF`, particl half on `#0B0D11`. Cell treatments: **owns** = ink-filled pill (inverted per ground), **reviews/approves** = 1px solid outline, **informed** = 1px dashed muted. Gutter labels: `SEND TO PARTICL →`, `← COST PER SHOT`, `← STATUS · MASTER`. A `FLOWS` row explains: the shot list is the contract; the retake loop; only approved takes reach the canvas; what returns to Atomik. Use as the product map, not a UI.

---

## Interactions & behaviour

- **Cost on the action, always.** Every render/generate/send button shows its price inline (`·`-separated mono, `#3A3E46` on ink). Quote the price *before* enabling the button.
- **Cost approval rule**: anyone renders (default). Settings offers `Cap per shot` and `Producer approves`; at the cap, the producer unlocks. Warn at 80%.
- **Take states**: `draft → picked → approved`. Artist picks (one per shot; picking another replaces); director approves or sends back with a note, which returns the shot to draft and lists the note in History and in Usage's `SENT BACK` column. Only approved takes play on the Canvas and can be downloaded as masters; a picked take holds the slot as a still.
- **Filing**: a render filed against a shot gets its version number (`v1…`, stills `S1…`, audio `A1…`) and its filename `{project}_{shot}_{version}_{w}x{h}.{ext}`. Unfiled renders live only in Library › Unfiled with a `File against a shot` action.
- **Filters** (Video/Images/Audio/Library/Cast/Ideas) are client-side, instant, and hide empty groups. Counts update live.
- **Selection** (Canvas shots, Cast cards, shot list rows in the alt layout) updates the right rail; selected = ink border (+ soft ring on Canvas).
- **Shot builder**: one pick per row; re-clicking clears (except Titles); the prompt line rebuilds on every change; a technique overrides the move sentence; camera-bank tiles and the Camera move row are the same selection.
- **Rendering**: a rendering take shows a 3px determinate bar and `RENDERING 62%`; it replaces itself in place on completion; the Canvas History shows `now · TO rendering v3 · 62%`.
- **Hover**: cards/buttons raise border alpha (`.08 → .28–.40` dark; `.1 → .4` light); primary buttons go `#FFFFFF` (dark) / `#000000` (light); nav and mono links go from muted to ink. No motion, no shadows.
- **Atomik ⇄ Particl sync**: on `Send changes to Particl` the shot list (order, planned durations, cast tags + stills + descriptions, references, setup defaults, cap) is pushed; Particl writes back per shot: state, take count, cost to date, master link. Edited-since-send rows are tinted until sent. Show `SYNCED n MIN AGO · BOTH WAYS`.
- **Identity training**: 10–20 photos → `Training on fal.ai · 62%` with progress → `Trained · 18 photos`; trained identities get the `IDENTITY` badge on their cast card and `TRAINED` on chips.
- **Responsive**: desktop only (min-width 1180px). Workspace pages are `height:100vh` with internal scroll regions; list pages scroll the document.

## State management

- `project` (id, name, kind, runtimeTarget, cap, spend, team[], stage: rendering | in-review | delivered | brief-only, origin: atomik).
- `shots[]` (id, sceneId, title, description, plannedSecs, cast[], setup{size, angle, move, lens, lighting, hour, look, technique, mood, motion, sound, titles}, refs[], takes[], state: none | draft | picked | approved, syncDirty).
- `takes[]` (id, shotId, kind: video | still | audio, version, model, spec, durationSecs, costUsd, tokens, by, createdAt, state, rendering{progress}, sentBackNote, masterUrl, role for stills: first-frame | cast | loose; attachment for audio).
- `cast[]` (name, kind: character | location | prop | look, description, stillUrl, identity{status: none | training | trained, photos, progress, costUsd}, scope: project | all).
- `setupDefaults` per project (carried into every composer).
- `quote` per composer (model × duration × resolution → usd, tokens) fetched before render is enabled.
- `usage` (byProduction[], byPerson[], byShot[], byEngine[], period).
- `settings` (team[] with roles, engines[] with key status and rate, storage, atomikConnection{status, lastSync}, defaults{model, duration, resolution, ratio, audio, capWarnPct, approvalRule, atCap}).
- `filters` per page, `selection` per page (shotId / castName), `library.unfiled[]`.
- Atomik: `ideas[]` (logline, tone[], refs[], state: open | pinned | production | parked, pins, by), `treatment` (scenes[] with prose, mentions[], notes[]), `breakdown` (scenes → shots), `shotList` (rows + writeback fields + dirty flags, lastSyncAt).

## Assets

- `assets/particl-mark-on-dark.svg`, `-on-light.svg`, `particl-app-icon-dark.svg`, `-light.svg` — the 7-dot trail.
- `assets/atomik-mark-on-dark.svg`, `-on-light.svg`, `atomik-app-icon-dark.svg`, `-light.svg` — the 8-dot ring (shipped mark).
- Wordmarks are live type (Outfit + Kode Mono, Google Fonts) built from the recipes above; no wordmark images.
- No photography or renders are included; every striped well is a placeholder for a real master, still, board or photo.

## Files

```
README.md                                   this document
design-tokens.json                          machine-readable tokens (shared with the brand handoff)
assets/                                     marks + app icons, both brands, SVG
design-references/
  Pages Overview.dc.html                    every page live at half size, pipeline order — start here
  Particl Workflow Map.dc.html              swimlane map: roles × stages × handoffs
  Particl - Welcome.dc.html                 /welcome + /login combined
  Particl - Video.dc.html                   / — wall grouped by shot + composer rail (chosen layout A)
  Particl - Images.dc.html                  /images
  Particl - Audio.dc.html                   /audio
  Particl - Projects.dc.html                /projects
  Particl - Canvas.dc.html                  /projects/:id/canvas
  Particl - Library.dc.html                 /all
  Particl - Studio Cast.dc.html             /studio
  Particl - Studio Shot Builder.dc.html     /studio/shot
  Particl - Usage.dc.html                   /usage
  Particl - Settings.dc.html                /settings
  Atomik - Ideas.dc.html                    atomik · 01
  Atomik - Treatment.dc.html                atomik · 02–03
  Atomik - Breakdown.dc.html                atomik · 04
  Atomik - Shot List.dc.html                atomik · 05
  Composer B - Split shot list.dc.html      alternate Video layout, not chosen — reference only
  support.js                                preview runtime only — do not port
```

Open any `.dc.html` directly in a browser (keep `support.js` beside it). Interactive elements (filters, selection, the shot builder) work in the previews.
