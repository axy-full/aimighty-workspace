# Handoff: Particl Suites — Graphite shell, four suites, Higgsfield composers

Target repo: `axy-full/aimighty-workspace` (Next.js app router, React, TypeScript). Reference API: `higgsfield-ai` (CLI + skills, model catalogue, prompt enhancer).

## Overview
One desktop shell replaces the 24-page, four-suite maze. The user lands on a **Studio** with eight production stages, hops between **Business** (Higgsfield Marketing Studio only), **Viral** (Higgsfield Genjutsu only) and **Atomik** (the supercomputer/agent), and reaches a single **Gen** composer from anywhere. A **Library** (Tools | Assets) sits on the left of every stage and an **Inspector** on the right, so assets are visible and draggable on every page. There is one credit balance, one prompt enhancer (provider selectable), a `⌘K` palette, a right-click menu everywhere, and a node **Rig** with typed ports, wiring and lasso selection.

## About the design files
`Particl Suites.dc.html` (with `support.js` + `image-slot.js` beside it) is a **click-through design reference built in HTML** — it shows the intended look and behaviour, it is *not* production code. Recreate it inside the Next.js app with the existing component libraries (`components/workbench/ui/*`, `components/ui/*`), the existing routes/actions/pricing, and TypeScript. All state in the prototype is client-side and simulated (renders "complete" on a timer); wire each action to the real endpoints listed under **Backend contracts**.

Open the prototype in any browser. Every screen is reachable by clicking; no URL params needed. `⌘K` (or Ctrl-K) opens the palette, `⌘J` toggles the Inspector, right-click opens the context menu, `Esc` closes everything.

The `reference/` folder holds the earlier Graphite exploration (per-surface prototypes, deep-linkable, plus a phone version) and its two source-of-truth docs. Use it for visual detail and copy of screens this shell does not re-render (auth, pricing page, mobile). Where the two disagree on IA, **this README and `Particl Suites.dc.html` win**.

## Fidelity
**High-fidelity** for visual design, layout, tokens, copy and interaction structure. **Data is sample data** (project *Dune Studies*, *Northline*; assets `a1…c2`; credits 2,000). Prices are the repo's rate card (`CLAUDE.md`) and Higgsfield public pricing where the repo has none — treat every number as a placeholder for the live quote.

---

## Information architecture

```
Header (56px)           particl mark · Studio | Gen | Business | Viral | Atomik   ⌘K search   [credits] [avatar ▾]
Stage strip (46px)      per-suite pages, numbered 01…, grouped by hairline gaps
Body                    [Library 280px] | [Stage 1fr] | [Inspector 320px]   (1px hairline gutters; panels #0D0D10 on #000)
```

| Suite | Pages (in order) | Kind | Source of truth |
|---|---|---|---|
| **Studio** | 01 Brief · 02 Boards · 03 Cast · 04 Astra · 05 Rig · 06 Takes · 07 Edit · 08 Deliver | cards / graph+list / grid | `lib/suites.ts` PAGES.particl, `components/workspace/pages/*`, `production-graph.tsx` |
| **Business** | 01 Ads (Marketing Studio) · 02 Image ads (DTC) · 03 Setup | composer / composer / list | Higgsfield `marketing_studio_video`, `dtc-ads`, setup-items (products, avatars, hooks, settings, ad-references, brand-kits) |
| **Viral** | 01 Motion Transfer · 02 Object Swap · 03 History | composer / composer / grid | Higgsfield `genjutsu/motion-transfer/v1.0`, `genjutsu/object-swap/v1.0`; `docs/subatomik-genjutsu.md` |
| **Atomik** | 01 Agent · 02 Runs · 03 Approvals · 04 Budget · 05 Models · 06 Skills | agent / list ×5 | `lib/workspace/pages.ts` PAGES.atomik; skills = `higgsfield-ai/skills` packs |
| **Gen** | one composer (Video · Images · Audio · 3D) + Results | composer | `components/make/*`, `GenerateComposer.tsx`, `lib/workspace/composer.ts` |
| **Workspace** | General · People · Plans & credits · Usage · Engines · Security | forms/lists | `app/(app)/settings`, `team`, `usage`, `billing`, `management/*` |

Rules that simplify the old app — keep them:
1. **One composer.** Every "app"/tool in the old Moleculr/Subatomik suites is a *preset* that opens Gen (or the page's own composer) pre-configured. Never a second interface.
2. **One balance.** No "workspace credits vs connected account" toggle anywhere. Quotes are shown in `cr`.
3. **Assets everywhere.** Library › Assets is on every stage; every tile is draggable (`text/plain` = asset id) onto any reference well or Rig node.
4. **Every card is a button.** Cards, tool rows and list rows route somewhere: a Gen preset, another stage, or a detail in the Inspector (`act()` in the prototype). Nothing dead-ends in a toast alone.

---

## Design tokens (Graphite)

**Colour** — root `#000000`; panel `#0D0D10`; card `#17171B` + `1px solid rgba(255,255,255,0.10)`; input/tile `#1B1B1F` + `rgba(255,255,255,0.08)`, hover `#26262B`; segment track `#1C1C20` (`padding:3px`, radius 6), selected pill `#3A3A40` (radius 4); hairline strong `rgba(255,255,255,0.09)` (1px gaps between panels), hairline `rgba(255,255,255,0.08)`, dashed drop zones `rgba(255,255,255,0.16)`; text `#F5F5F7`, secondary `rgba(235,235,245,0.6)`, tertiary `.45`, eyebrow `.4`, placeholder `.35`; accent `#0A84FF` (hover `#2D95FF`), accent text `#6EB4FF`, tint `rgba(10,132,255,0.14)` + border `rgba(10,132,255,0.35)`, selection ring `0 0 0 2px #0A84FF, 0 0 0 5px rgba(10,132,255,0.22)`; status dots: done `#30D158`, progress `#0A84FF`, waiting `#FF9F0A`, failed `#FF453A`, idle `rgba(235,235,245,0.35)`; danger text `#FF453A`. Sample thumbnails: flat two-stop gradients (no patterns).

**Type** — `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Geist, system-ui, sans-serif` (Geist loaded from Google Fonts as fallback); mono `ui-monospace, "SF Mono", Menlo, monospace`. Page h1 26/600/−0.03em · panel title 15/600 · body 13/400 lh 1.45 · control 12.5–13/500 (primary 600) · meta 11–12 · eyebrow 10–11/500–600/+0.1–0.14em uppercase · mono numerals 10–12.

**Radii** — panels 0 · cards/popovers/menus 8 · buttons/inputs/chips 6 · segment inner 4 · toggles 999.

**Spacing** — page padding 20 · card padding 16–18 · gaps 6 (chips) / 8–12 (rows) / 14–18 (sections).

**Motion** — easing `cubic-bezier(.2,.7,.2,1)`; page enter fade + 6px rise 400ms (`om-in`); popovers/menus scale .97→1 150–300ms (`om-pop`); segment thumb opacity 200ms; toggle knob 200ms; running-dot pulse 1.4s.

**Controls** — header buttons 32px tall, radius 6; stage-strip tabs 30px, radius 6, selected = tint bg + `#6EB4FF` text, number in mono 11px; chips 28px; primary button `#0A84FF` white text 600, 40px in composers / 32px in headers; toggles 34×20 track `#1C1C20`, knob 14 (`#0A84FF` on, `rgba(235,235,245,0.4)` off).

---

## Screens

### Shell (every screen)
- **Header**: particl trail mark (7 growing dots, `viewBox 30 68 140 64`, fill `#F5F5F7`, 30×14) + wordmark 15/600 → Studio. Suite tabs as a segmented control. Search field (flex 0 1 460px, inset look) opens the `⌘K` palette. Right: running-jobs pill (blue pulsing dot, only while jobs run → Atomik › Runs), credits pill (mono 600, → Workspace › Plans & credits), avatar/workspace menu.
- **Stage strip**: pages of the active suite as `01 Label` tabs; hairline gap before group starts (Studio: after 02 and 05; Business: after 02; Viral: after 02; Atomik: after 01 and 04). Hidden in Gen and Workspace.
- **Project head** (Studio/Business/Viral/Atomik/Gen): `[DS] Dune Studies ▾` project switcher (list + *New project*), meta "Fashion film · Concept 01", page title (26/600) + hint, right side: page view segment (Rig: Canvas | List; Takes/History: All | Uploads | Generations), primary action button, on narrow widths *Library* / *Inspector* toggles.
- **Library** (left, 280px; overlay `min(320px,86vw)` below 1280px): tabs *Tools (n)* | *Assets (n)*. Tools = the page's cards grouped, each row `[2-letter tag] name / sub` → routes via `act()`. Assets = search "Search this project", chips All · Images · Video · Audio · Uploads, 2-up tiles (4:3 thumb, kind badge, play glyph for video/audio, `NEW` badge for fresh renders, `+` = use as reference, tile is `draggable`). Footer: "Everything this project has made or uploaded, on every page. + sends it into Create as a reference."
- **Inspector** (right, 320px; `⌘J`): kind eyebrow (Asset · Take · Run · Node · Item · Stage), title, tabs Controls | Inputs | Versions, key/value rows, actions list. Content depends on selection (see State).
- **Toast**: bottom-centre pill, 2.6s.
- **Context menu**: see Interactions.

### Studio › Brief (cards)
Two columns (`1.2fr 1fr`). Left: *Brief* textarea (sample copy), "76 words · saved", buttons *Draft script from brief · quoted* → Atomik agent with prefilled request, *Import screenplay · PDF / OCR*. Right: *Script · 3 scenes*, scene rows `SC 1 · INT/EXT slug · body · n shots`, *Coverage check*, *Breakdown → Cast*.

### Studio › Boards (cards)
*Look* strip (4 ref thumbs + palette swatches sand·clay·ivory·steel·ink) above a frame grid (16:9 thumbs, scene badge, name, camera note). *Add frame* tile → Gen preset `nano_banana_2` "Boards · new frame · 1 cr".

### Studio › Cast (cards)
Cards per identity/element: 4:3 thumb, group badge CAST/ELEMENT, name, role, status dot + label (*Identity ready* / *Continuity note* / *Selected*), action (*Render with identity* → Gen preset `soul_2`; *Build identity · 54 cr*). *Add cast or element* tile.

### Studio › Astra (cards)
16:9 viewport placeholder with grid + framing rectangle + mono eyebrow "3D RUNTIME · SHOT 02 · 35MM · 1.6 M"; right panel Scene objects list; *Export layout → Rig* primary. Finishing group: Video upscale (Astra) / Image upscale (Topaz) → Gen presets.

### Studio › Rig (graph | list) — the node editor
Canvas 900×640 inside a scrollable panel (dot grid `radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px) 22px`). Nodes are absolutely positioned cards (`#17171B`, radius 8, 1px border; selected border `#0A84FF` + ring). Each node: eyebrow `KIND` + `n in · n out`, image slot or value sliders, title, description, owner. Sample nodes: Look board, World & element, Character (inputs none, output Image) → Scene (in Look/World/Character/Brief, out Frame(Image)/Scene(Text)) → Direction (in Scene, out Note) · Colour (in Frame, out Grade) → Generate/Take (in Frame, Direction, Grade, Sound; out Take).

**Ports** (Autodesk-style): 14px circles on the node's left (inputs) / right (outputs) edge at `top = 42 + 20·i`, ring colour by type — Image `#0A84FF`, Direction/Text `#F5F5F7`, Colour `#FF9F0A`, Take `#30D158`, Audio `#BF5AF2`; filled dot when wired. Legend row above the canvas.
**Wiring**: click an output → "Wiring image from Look board › Look — click a matching input" banner; click a type-matching input to connect (replaces any existing edge on that input); mismatched type → toast refusal; `Esc` cancels; clicking a wired input with no pending wire unplugs it. Edges = cubic Béziers (`stroke-width 1.6`), coloured by type when either end is selected, else `rgba(235,235,245,0.28)`.
**Lasso**: pointer-down on empty canvas + drag draws a marquee (`1px dashed #0A84FF`, fill tint, radius 4); intersecting nodes become the multi-selection; `⇧` adds; plain click on canvas clears; selected count pill offers *Group*, *Bypass*, *Clear*. `⇧`-click on a node toggles membership.
**Drop**: dragging an asset onto a node binds it as a reference (to all selected nodes if the target is in the multi-selection).
**List view**: shot rows `01 · thumb · name · status dot + "n refs" · engine · [Generate a new take · 43 cr]`.

### Studio › Takes (grid) · Viral › History (grid)
`auto-fill minmax(180px,1fr)` tiles: 16:9 thumb, kind badge, duration, play glyph, `NEW`, name, `model · cost cr` / `Upload · original`, `+` reference. Filter segment in the head.

### Studio › Edit (cards)
Assembly panel: five lanes (Picture, Dialogue, Effects, Ambience, Music) 40px tall with positioned clips; ruler 00:00 · 00:10 · 00:20 · 00:30. Right: *Sound stems* rows with an action each (Generate line · 1 cr → Gen `eleven_speech`, Add cue · 2 cr → `eleven_sfx`, Extend → `eleven_sfx`, New sketch · 4 cr → `eleven_music`, *Mix on this device · free*).

### Studio › Deliver (cards)
*Spec check* rows (Aspect 16:9 ✓, Frame rate 24 fps ✓, Duration ✓, Loudness −23 LUFS pending); *Package* buttons Master (MP4/WebM, on device), Social cuts (9:16 · 1:1 reframe → Gen preset), Handoff (EDL + originals + manifest ZIP). Note: "Encoding runs on this device with native codecs; nothing is uploaded and no credits are spent."

### Business › Ads — Marketing Studio composer
Max width 760. Intro line. Fields as chip rows with an eyebrow label + right-aligned note:
- **Mode** (default `ugc`): UGC · Tutorial (`ugc_how_to`) · Unboxing (`ugc_unboxing`) · Product showcase · Product review · TV spot · Wild card · UGC try-on (`ugc_virtual_try_on`) · Pro try-on (`virtual_try_on`).
- **Product**: saved products + *From URL…* (reveals a *Click-to-Ad · product URL* input).
- **Avatar**: None · auto (backend synthesises a Soul Character) · presets · custom.
- **Hook** and **Setting**: enabled only for UGC-family modes (`ugc, ugc_how_to, ugc_unboxing, product_review, ugc_virtual_try_on`) and never together with an **Ad reference**; disabled chips at 40% opacity with a tooltip explaining why. Choosing an ad reference disables hook/setting and vice-versa (reference-driven vs block-composed — never both).
- **Aspect** auto · 21:9 · 16:9 · 4:3 · 1:1 · 3:4 · 9:16 (default 9:16) · **Duration** 15 s · 30 s · **Resolution** 480p · 720p · **Audio** On/Off.
- **Prompt** with *Auto* enhancer toggle + *Enhance* button; enhanced text appears in a tinted card with *Use this* / *Keep mine*.
- **Reference stills · optional** drop well (dashed) — roles `image · start_image · end_image`, click the role pill to cycle, up to 14.
- Primary `Generate ad · 40 cr` (disabled with the blocking reason shown beside it: "Write the prompt." / "Paste the product URL."). Quote ≈ 40 cr @720p/15 s, 28 @480p, ×2 for 30 s.

### Business › Image ads — DTC composer
Fields: **Ad format** (required, no default: Headline · Bullet points · Us vs them · Testimonial · Before/after), **Brand kit** (must be *completed*), **Product** (max 1), **Avatar** (max 1), **Aspect** 1:1 · 3:2 · 2:3 · 4:3 · 3:4 · 16:9 · 9:16 · 21:9 · auto, **Resolution** 1k · 2k · 4k, **Quality** low · medium · high, **Batch** 1 · 2 · 4 · 8 (1–20). Prompt + enhancer, reference well (≤14). Primary `Generate n images · x cr`; blocked until a format and a prompt exist.

### Business › Setup (list)
Rows for every setup item with type in the meta: products (fetched from URL · created from uploads), avatars (preset · custom · from Production identity), hooks, settings, ad references (video · bound to product/avatar), brand kits (completed · colours · fonts). Primary *Fetch from URL* → Ads composer with product = URL.

### Viral › Motion Transfer / Object Swap — Genjutsu composers
Fields: **Resolution** 480p · 720p · 1080p. Media well: exactly **one source video (4–30 s)** + up to **30 ordered reference images** (order preserved). Prompt optional (*Creative direction* / *What to replace*). Primary `Transfer motion · 22 cr` / `Swap object · 22 cr`, blocked until a video and ≥1 image are attached (reason shown). Refs are cleared when leaving the page so Gen and Genjutsu never share media. Head primary *Open motion library* (external Higgsfield motion library).

### Atomik › Agent
Chat column: user bubble, plan card (eyebrow "Plan · 4 steps · 62 cr", steps with status dots + price, *Approve · 62 cr* / *Edit steps*), composer textarea "Describe the outcome…" + *Plan*. Right column: tabs (Runs · Approvals · Budget · Models · Skills) as lists — the same lists the stage pages show. Every Studio card that says "draft/coverage/breakdown/plan" lands here with the request prefilled.

### Atomik › Runs · Approvals · Budget · Models · Skills (lists)
Rows: status dot · name · meta · action (*Approve* for waiting rows freezes inputs, wallet and price; *Open* selects the row into the Inspector with *Run with Atomik · quoted*, *Open in Gen*, *Mark complete*). Skills rows are the `higgsfield-ai/skills` packs (generate, soul-id, brandkit, product-photoshoot, youtube-thumbnail, video-explainer, websites, marketplace-cards); *Install skill* opens the repo.

### Gen
Left card: **Video | Images | Audio | 3D** segment; `02 / Model` picker button (tag · name · one-line "best for") → model sheet (two groups: *Studio engines*, *Higgsfield catalogue*; each row tag · name · provider · best · roles · from-price · ✓); `01 / Direction` prompt (placeholder per mode; `@name` citations; `raw:` prefix bypasses the enhancer) with *Auto* + *Enhance*; **References** dashed drop well (roles cycle per model: Start frame · End frame · Reference · Video · Audio; prompt-only models hide it); **Aspect** chips (per model); **Resolution** chips; **Length**: a `<select>` of **every second from 4 s to 30 s** for any video model (custom chevron, `#1B1B1F`); **Generate audio** toggle (models that support it); **Takes** stepper 1–4; primary `Generate · 43 cr` (full width, 40px); footer line "1 take · 16:9 · 5 s · Saved to your takes · enhanced first (1 cr)". Right: **Results** grid (running jobs as conic progress rings + name/meta, then finished takes) with All · Images · Video · Audio filter.

### Workspace
Tabs General · People · Plans & credits · Usage · Engines · Security (max-width 1040). **General**: workspace name, region (read-only), default delivery spec, cost-approval threshold, **Prompt enhancer** segmented control *Higgsfield | Claude | OpenAI* with a note line, *Save*. **People**: member rows (initials, name, meta, role pill, Promote/Unlock), *Invite · one-time link*. **Plans & credits**: balance (40px mono), plan line, statements links, four packs (Starter $50 500 cr · Team $200 2,000+200 · Studio $500 5,000+750 · Agency $2,000 20,000+4,000). **Usage**: bars per engine (settled only). **Engines**: connection rows (ModelArk · Higgsfield · fal · ElevenLabs · OpenAI) with *Verify*/*Connect*. **Security**: sessions, password policy, media access, audit.

---

## Interactions & behaviour

- **Navigation**: header segment → suite (restores that suite's last page; falls back to its first page if stale); stage strip → page; `⌘K` palette lists Generate, suites, every page, Workspace, models, assets and "Ask Atomik: …" (Enter runs the top hit, Esc closes). Page enter animates `om-in`.
- **Project switcher**: popover under the pill, ✓ on current, *New project*. Switching filters assets to that project and clears selection.
- **Drag & drop**: `dragstart` sets `text/plain` = asset id on every tile (Library, Takes, History, Results, Boards). Drop targets: Gen reference well, composer media wells, Rig nodes. Drop → `addRef(asset)` with model/page validation (kind accepted, role, max count, one source video) and a toast naming the role.
- **Prompt enhancer**: *Enhance* sends the prompt to the selected provider (Workspace › General; default Higgsfield). Result card with *Use this* (replaces prompt) / *Keep mine*. *Auto* toggle means the enhanced text is what gets submitted when present. `raw:` prefix is never enhanced. Cost 1 cr, shown on the card. Enhancer instruction (all providers): rewrite into one concrete prompt ordered *subject + setting + style; camera (lens, angle, motion verbs for video); lighting; medium*, keep `@Image1/@Video1/@name` citations verbatim, < 80 words, phrase negatives positively, output only the prompt.
- **Generate**: submits a job → running pill in header, progress ring in Results; on completion the take is prepended to assets with `NEW`, a toast "… saved to Takes · x cr settled", credits debited. Composer pages (Ads, DTC, Genjutsu) do the same with their own quote and land in History/Takes. Blocked states show the reason inline, never a silent disabled button.
- **Rig**: as described above — port click wiring with type check, `Esc` cancel, unplug, lasso, ⇧ multi-select, group/bypass, drop to bind, Inspector › Inputs lists each input port with its source ("unplugged — wire or drop an asset"), › Versions lists v1/v0/pin/branch/compare.
- **Right-click menu** (anywhere; suppressed inside inputs): items Copy `⌘C` · Cut `⌘X` · Paste `⌘V` · Duplicate `⌘D` · — · [asset: Use as reference · Open in Inspector] [node: Bypass · Unplug all inputs] · Move to… · Retry `⌘R` · — · Delete `⌫` (red) · Undo `⌘Z`; on empty space also Generate here… · Open Library · Toggle Inspector. Target is the nearest `[data-ctx="asset:id|node:id"]`, else the current selection. Paste of a cut asset moves it, of a copied asset creates "name · copy"; Delete an asset removes it (server keeps originals 30 days) and from refs; Delete a node hides it and its wires; Move toggles the asset's project; Retry a generation opens Gen with the same inputs. Every mutation pushes an inverse onto a 20-deep undo stack. Menu is positioned at the cursor, flipped/clamped to the viewport, closes on click-away/Esc. Keyboard shortcuts work without the menu when focus is not in a field.
- **Responsive**: ≥1280 three columns; below, Library/Inspector become overlays toggled from the project head; composers reflow to one column; header search shrinks.
- **Keyboard**: `⌘K` palette · `⌘J` inspector · `Esc` close/cancel · `⌘C/X/V/D/Z/R`, `⌫` on the selection.

## State (client)
`view` (suite | gen | workspace) · `suite` · `pages{suite→page}` · `rigView` · `libTab`, `libOpen`, `inspOpen`, `inspector`, `inspTab` · `sel` (asset id), `selNode`, `selRow`, `multi[]`, `lasso`, `wire`, `edges[]` (`[fromNode, outIdx, toNode, inIdx]`), `hidden[]` · `projectName`, `projectsOpen` · `mode`, `chosen{mode→modelId}`, `prompt`, `enhanced`, `enhancing`, `autoEnhance`, `enhancer` (higgsfield | claude | openai), `refs[{id, role}]`, `ratio`, `res`, `dur` (4–30), `audio`, `count`, `preset` · `cx{}` (composer field values), `cxUrl` · `jobs[]`, `assets[]`, `credits`, `taken` · `palette`, `query`, `models`, `ctx`, `clip`, `undo[]`, `toast`, `vw`.

## Backend contracts (map to real endpoints)
- **Gen / Rig Generate** → existing `app/api/generate` composer path with `lib/workspace/composer.ts` clamping; `dur` must be accepted per second (4–30) for video engines — clamp server-side to what each engine supports and show the clamped value.
- **Prompt enhancer** → new `POST /api/prompt/enhance { prompt, provider, model, mode }` routing to Higgsfield `enhance_prompt` (connected account), Anthropic, or OpenAI per `workspace.settings.enhancer`; 1 cr; never enhances `raw:` prompts.
- **Marketing Studio** → Higgsfield `marketing_studio_video` (`mode`, `product_ids`, `avatar_id`, `hook_id`, `setting_id`, `ad_reference_id`, `aspect_ratio`, `duration`, `resolution`, `generate_audio`, `input_images[{url, role}]`, optional `product_url` for Click-to-Ad). Enforce: hooks/settings only for UGC-family modes; ad reference excludes hooks/settings.
- **DTC ads** → Higgsfield `dtc-ads generate` (`prompt`, `format` required, `brand_kit_id` completed, `product_id`, `avatar_id`, `aspect_ratio`, `resolution`, `quality`, `batch_size`, `input_images` ≤14).
- **Setup items** → `products fetch --url` / `products create`, `avatars`, `hooks`, `settings`, `ad-references create --video-input`, `brand-kits fetch --url`.
- **Genjutsu** → `genjutsu/motion-transfer/v1.0` and `genjutsu/object-swap/v1.0` (`video_input` 4–30 s, `image_inputs[]` ordered ≤30, `resolution`, `prompt`); live estimate required before submit; a stale/missing estimate blocks.
- **Atomik** → existing runs/approvals/budget/models pages; skills list from `higgsfield-ai/skills`.
- **Assets** → existing library; uploads byte-identical (sha256), originals retained; `project` field for Move; soft delete 30 days.
- **Credits** → single workspace balance; quotes live; failed renders not billed.

## Assets
- particl trail mark — inline SVG (7 circles) in the header; Atomik mark — 8-dot ring (Inspector eyebrow / palette). No raster assets; thumbnails in the prototype are placeholder gradients — replace with real media.
- Geist via Google Fonts as a fallback for SF.

## Screenshots
`screenshots/` — one JPEG per screen, captured from the prototype at **924px wide** (the preview pane), so they show the *narrow* layout: Library and Inspector as overlay toggles in the project head instead of fixed side columns. Above 1280px the same screens render as three columns (see Shell). Files: `studio-rig-canvas.jpg` · `gen-composer-blank.jpg` · `studio-brief.jpg` · `studio-boards.jpg` · `studio-cast.jpg` · `studio-astra.jpg` · `studio-takes.jpg` · `studio-edit.jpg` · `studio-deliver.jpg` · `business-ads-marketing-studio.jpg` · `business-dtc-image-ads.jpg` · `business-setup.jpg` · `viral-motion-transfer.jpg` · `viral-history.jpg` · `atomik-agent.jpg` · `atomik-runs.jpg` · `atomik-approvals.jpg` · `atomik-skills.jpg` · `workspace-plans-credits.jpg` · `workspace-general-enhancer.jpg` · `workspace-engines.jpg` · `gen-composer-prompt-enhancer.jpg` · `gen-library-overlay.jpg` · `gen-inspector-overlay.jpg` · `palette-cmd-k.jpg`.

## Files
- `Particl Suites.dc.html` — the deliverable (template + logic in one file; open directly). `support.js`, `image-slot.js` — runtime, must sit beside it.
- `github.md` — repo ↔ screen map and sync history.
- `reference/graphite-README.md`, `reference/particl-feature-map.md` — token sheet, verbatim copy inventory and repo→surface map from the earlier exploration.
- `reference/Particl.dc.html`, `Particl Gen.dc.html`, `Particl Workspace.dc.html` (auth + pricing via `?screen=`), `Particl iPhone.dc.html` (mobile) — earlier Graphite prototypes for surfaces this shell does not re-render; `support.js` + `ios-frame.jsx` beside them.

## Suggested build order
1. Shell + tokens (header, suite/page strips, three-column body, Library, Inspector, palette, toast, context menu, undo).
2. Gen composer + model sheet + per-second length + enhancer endpoint + Results.
3. Assets: drag sources/targets, `addRef` validation, Library on every page.
4. Studio stages (cards) with `act()` routing; Rig graph (ports, wiring, lasso, drop, Inspector Inputs/Versions).
5. Business composers + Setup; Viral composers + History.
6. Atomik lists + agent; Workspace tabs incl. enhancer selector.
