# particl v2 — replace the current UI with this design language

You are working in the **ark-video** Next.js repo (`app/(app)/…` routes, `components/`, `lib/`). Replace the current UI with the design in `design-references/Particl v2 - Shots Rig Atomik.dc.html`. This document is the spec; the file is the visual reference. Open the file in a browser (keep `support.js` beside it) and find each board by its id badge — `11a`, `10a`, `9b`, `9c`, `8a`, `8b`, `7a`, `7b`, `6a`, `4a`, `3a`, `3b`. Ignore every other board in the file (turns 1, 2, 5 and 4b are superseded iterations kept for history).

The reference is **HTML authored as a design prototype**, not code to lift. Rebuild it with the repo's components and conventions. Striped grey rectangles with monospace captions are **image placeholders** — real frames, stills, boards and photos in production. All names, costs and counts are placeholder data.

---

## 0. Order of work

1. Tokens + primitives (§2, §3) — one PR, nothing visible changes yet.
2. Shell: top nav, account menu, Atomik button (§4).
3. Atomik rail: closed / compact / expanded (§5, board 10a) — it must work on every route before the pages ship.
4. Productions → Projects → Media (§6, board 7a) and the shared production header.
5. Shots grid (§7, the grid inside 10a) with right-click / drag / drop.
6. Rig · Canvas (§8, board 6a); Rig · Run + checkpoint (§9, board 9b).
7. Make (§10, board 8a); Library (§11, board 8b).
8. New asset sheet (§12, boards 3a, 3b).
9. Settings (§13, board 4a).
10. Mobile: every shipped screen below 768px (§14, boards M1–M10 in `Particl v2 - Mobile.dc.html`).

Delete the old UI route by route as each replacement lands; do not run both.

---

## 1. Information architecture

**Top nav — four items:** Make · Productions · Rig · Library. Usage and Settings live in the **account menu** (avatar, top right). A **balance** readout (`BALANCE 1,240 CR`) sits left of the Atomik button on every screen.

**Productions › Projects › Media.** A production is the client job. A project is a deliverable inside it (30s hero, 15s cutdown, 9:16 socials, key visuals), each with its own six-step stepper — Brief · Shots · Boards · Takes · Approve · Deliver — its own cap and its own "need you" count. All projects in a production share the production's assets in Rig. Media (takes, stills, audio, masters) belongs to the project that made it, grouped by shot; it survives shot deletion and travels when a shot moves.

**Rig — three tabs:** Canvas (build), Recipes (a board saved as a reusable stage pipeline with an engine and price per stage), Run (a recipe executing, with Atomik's checkpoints).

**Make** is free generation with nothing required; everything it makes is *unfiled* until "File to shot".

**Library** is one collection, three lenses: Assets (cross-production roster), References (loose board), Unfiled (Make's takes). It never duplicates project media; it indexes it.

**Atomik** is the production agent. Hidden behind one header button until clicked; opens as a right rail (compact → expanded) on desktop, a sheet on mobile. Vocabulary: "Ask Atomik", never "AI" or "assistant".

**Credits.** 1 cr = 10¢. Prices are read from engines, never typed. The price appears in exactly three places: the production/project header (spent of cap), the one filled primary button on the screen, and Usage. Every button that spends shows its cost inline before it is pressed.

**Take states:** draft → picked → approved. **Run step states:** queued → running → done, plus *needs you* and *checkpoint*.

---

## 2. Tokens (dark only — there is no light theme)

```
--ground        #0B0D11
--card          #12141A       one step lighter than ground
--card-raised   #171A21       locked assets, hover rows
--ink           #F5F6F8
--ink-body      #B4B7BE       secondary body; never lower than this for prose
--ink-muted     #8A8E96       eyebrows, mono labels, states (labels only, not prose)
--hairline      rgba(245,246,248,.06)
--border        rgba(245,246,248,.08)   cards
--border-mid    rgba(245,246,248,.12–.14) buttons, inputs, chips
--border-hover  rgba(245,246,248,.22–.30) hover raises border alpha only
--selected      rgba(245,246,248,.12)   segmented active, selected row fill
--accent        oklch(75% 0.12 200)     ONLY for approved, done, running progress, checkpoint ring
--on-primary-cost #4A4E56              the cost text inside a filled primary button
--placeholder   repeating-linear-gradient(135deg,#1A1D24 0 6px,#20242B 6px 12px)
--waveform      repeating-linear-gradient(90deg,rgba(245,246,248,.32) 0 2px,transparent 2px 5px)
```

Radii: 4 (badges), 6 (small chips), 8–10 (buttons, tiles, rows), 12 (cards, nodes, rails), 14 (mobile buttons, pinned cards), 999 (pills). **No shadows** except a dragged object; the only "ring" is `box-shadow: 0 0 0 3px rgba(245,246,248,.12)` on a selected node. No gradients other than the placeholder stripes. No motion beyond Atomik's dot-state changes.

Type (Google Fonts):
- `Outfit` 400/500/600 — everything readable. h1 32/1.05 -0.025em; page title 20; section title 16; card title 13.5–15; body 13–14.5; UI label 12.5–14.
- `Kode Mono` 500 **11px uppercase, letter-spacing 0.12em** — eyebrows, IDs (`SH04`), costs (`19 CR`), states (`PICKED`), engine names, timestamps. Costs inside mono strings use 0.08em. Nothing below 11px on desktop; **nothing below 12px on mobile**.

---

## 3. Primitives (build once, in `components/ui/`)

- **Shell header** 56px: mark + `partıcl` wordmark (Outfit 600 16px, -0.03em; dotless ı), nav links (14px, active = ink + `inset 0 -2px 0 ink`), right: balance mono, Atomik button, 32px avatar.
- **Production header** 64px: `Production › Project` breadcrumb (production 15px `--ink-body`, project 17px 600), format line in mono, the six-step **stepper** (9px dots joined by 26px hairlines; done = filled ink, current = filled ink + 600 label, upcoming = 1.5px outline), `spent of cap` as `228 of 400 cr` over a 180×3 bar, `3 need you` pill.
- **Segmented control**: `--card` pill container, 2px padding; options 999 radius, active `--selected`.
- **Pill chip**: 1px `--border-mid`, 999 radius, 12–13px.
- **Primary button**: ink fill, ground text, Outfit 600 13–16px, cost right-aligned in mono `--on-primary-cost`. **One per screen.** When a rail opens, the page's primary drops to outlined.
- **Secondary button**: transparent, 1px `--border-mid`.
- **State dot** 7–9px: approved/done = accent fill; picked = ink fill; running = 2px accent ring; draft = 1.5px muted outline; queued / no take = 1.5px dashed muted; needs-you = ink fill with a ground stroke.
- **Media card**: 16:9 well (placeholder or media), ID chip top-left, state chip top-right (both `rgba(11,13,17,.85)` on 4px radius), body, and a **split footer** — `PLAN` left / `RENDERS` right, mono.
- **Rail** (right): `#0F1116`, 1px `--border-mid` left edge, 52px header, scroll body, pinned footer.
- **Sheet** (mobile): `--card`, radius 24 top, 36×4 grabber, scrim `rgba(5,6,8,.55)`.
- **Loader** (`components/atomik/Loader.tsx`, board 11a): the ring is the only loading indicator in the product — no spinners, no skeletons. Same 8 dots as `Ring`; each dot animates `opacity .22 → 1 → .22` with `atomikPulse 1.6s cubic-bezier(.4,0,.2,1) infinite` and `animation-delay: i × 0.2s` (head first, around to the tail). Size and position never change. Sizes: 88 (page load, centred, with one mono line of what is loading), 36 (inside a node output well or a media card well while a take arrives — no skeleton), 20 (Atomik message header while planning, with a 3px indeterminate bar beneath), 14 (inside a button: the label goes present-tense, the ring sits at its left, width and price stay). Ink on dark; ground-colour inside a filled primary; never the accent. Show nothing for waits under 300ms. When the number of steps is known, use `Ring` in its determinate Running/Checkpoint states instead.
- **Atomik ring** (`components/atomik/Ring.tsx`): the 8-dot mark rendered from data. Base dots on a 200×200 viewBox: `(100,38,r16) (56.16,56.16,11.9) (38,100,8.8) (56.16,143.84,6.5) (100,162,4.8) (143.84,143.84,3.6) (162,100,2.7) (143.84,56.16,2)`. Props: `steps: Array<'done'|'running'|'checkpoint'|'queued'|'needsYou'>` (length ≤ 8, mapped head-first) or `mode: 'idle'|'listening'|'planning'|'done'`. Rendering per dot: done = ink fill; running = accent fill; checkpoint = hollow accent ring (r−2, stroke 4); queued = outline (r−1.5, stroke 3, 35% ink); needsYou = ink fill r+3 with 3px ground stroke; idle = all ink; done-mode = all accent; listening = head ink, trail 65%→35%; planning = opacity cycles head→tail every 1.6s (the only animation in the product). Sizes: 14 (header button), 18–20 (rail header, message header), 36 (compact), 64 (pinned checkpoint), 88 (mobile sheet, spec card).

---

## 4. Shell + account menu (board 4a header)

Account menu (220px, `--card`, radius 12, 6px padding): name + `ROLE · WORKSPACE` mono; divider; **Usage** (with `612 CR · SEPT`), **Settings** (`⌘,`), Switch workspace ▸; divider; Sign out. Hover rows `rgba(245,246,248,.08)`.

Atomik header button: pill, 36px, ring at 14px in its **live state**, label `Atomik`, mono suffix with the state and shortcut (`CHECKPOINT · ⌘J`, `RUNNING · ⌘J`, `⌘J`). Border `.14` when closed, `.35` + `--selected` fill when open.

---

## 5. Atomik rail — closed / compact / expanded (board 10a, live in the reference)

State lives at app level (`atomik.state: 'closed'|'compact'|'expanded'`, persisted per user; `⌘J` toggles closed↔last open state; `Esc` closes). Nothing else of Atomik is rendered when closed — **remove the left Rig strip.**

- **Compact — 300px.** Header 52px: ring 18, `Atomik`, `Expand ⇤`, `×`. Body: context chip (`30S HERO · RUN 02 · 3 OF 8`), **one card** — the current thing: checkpoint, question, plan summary or receipt — with its one filled button (`Continue · 24 CR`) and secondary pair (`Change engine` / `Stop`). Footer: `Ask Atomik…` field + send.
- **Expanded — 420px.** Header adds `PRODUCTION AGENT` and swaps `Expand` for `Compact ⇥`. Body scrolls: context chip, conversation (user bubbles ink-filled right-aligned; Atomik bubbles `--card` left-aligned; both radius 12, 13.5px), then the **plan card**: rows of 46–48px — number · stage · scope · engine (mono) · cost — with a `CHECKPOINT · YOU ARE HERE` row (2px accent ring dot) where the run is stopped. Pinned footer: one mono line `95 CR TOTAL · 77 UNDER CAP · PLANNING 3 CR` (planning credits are always their own item), then the filled button `Continue · keyframes · 24 CR`. Composer below.
- The page grid **reflows** to the remaining width: 5 → 4 → 3 columns for the Shots grid. The page's own primary button becomes outlined while the rail is open.

Atomik's four message types (board 9a, kept for reference): **Plan** (steps, engines, total, `Run to first checkpoint · N CR`), **Checkpoint** (what finished · cr spent · what's next · price · Continue / Change engine / Stop · planning line), **Question** (a decision with 2–3 priced options; Atomik never decides anything that spends, unlocks, deletes or approves), **Done** (receipt: steps, credits by class, "N need you" link to Approve).

---

## 6. Productions (board 7a) and Project › Media (board 7b in the same section — build it too)

Route `/productions`. Page header 64px: `Productions` 20px + mono totals (`4 PRODUCTIONS · 9 PROJECTS · 8 NEED YOU · 808 OF 1,550 CR`), segmented `Active · Delivered · All`, right: `New project in…` secondary + `New production` primary.

**Production row** (`--card`, radius 12, padding 14 16 16): name 16px + client/status line; `N PROJECTS` mono; `N need you` pill; `spent of cap` + 160×3 bar; `Rig · assets` pill. Beneath, **project tiles** in a 5-column grid: 16:7 media well with `41 MEDIA` chip and need-you chip; name 13.5px 600; `format · N SHOTS`; six stepper dots + current step name in mono; `spent / cap CR` + percentage + 3px bar. Last cell: dashed `+ Project`.

**Project › Media** (`/productions/[prod]/[project]/media`): production header with breadcrumb; sub-tabs `Shots · Boards · Approve · Media`; kind filter pills (`All · 41`, `Takes · 22`, `Stills · 12`, `Audio · 5`, `Masters · 2`); search; `BY SHOT ▾`; primary `Download N masters · 0 CR`. Body: one group per shot (`SH01 · title · N items · N cr · OPEN SHOT →`), 6-column media cards: kind chip (`TAKE / STILL / AUDIO / MASTER`), waveform strip for audio, `↓ 1080P` accent chip on masters; footer: id + state dot/word, `model · cost · by`.

Data: `production { id, name, client, status, cap, spent, projectIds[] }`, `project { id, productionId, name, format, runtime, step, shots, cap, spent, needYou, mediaCount }`, `media { id, projectId, shotId, kind, version, state, credits, model, by, url }`.

---

## 7. Shots grid (the grid on 10a; interactions from board 4b)

Route `/productions/[prod]/[project]/shots`. Toolbar: `Grid | Filmstrip` segmented, mono stats, `+ Shot` secondary, primary `Render SH08–09 · 38 CR`.

**Grid**: 5 columns of media cards (§3). Image chips: `SH04` + position `04`; state; master `V2 ↓` in accent bottom-right; empty wells read `NO TAKE YET` / `TYPE ONLY`. Body: description clamped to 2 lines (36px min), cast `@Name` pills, `size · move · lens` line. Split footer `PLAN 4S · 19 CR` / `RENDERS 2 TAKES · 38 CR`.

**Filmstrip** view: player of approved takes in order + a strip where each shot's width ∝ planned seconds (approved = placeholder with accent underline, picked = `--selected` fill, open = dashed) + sequence list.

**Right-click, drag, drop** (all in the reference, live): context menu 228px (`Copy ⌘C`, `Paste after ⌘V` — disabled until something is copied, `Rename ↵`, `Open in Rig ⌘R`, divider, `Move to production ▸` submenu listing other productions with `TAKES GO TOO`, divider, `Delete ⌫`, footnote "Takes and masters are never deleted with a shot; they stay in Library."). Paste copies planning only (new ID, no takes, 0 cr). Delete offers **Undo** in a toast. Drag a card onto another to reorder (insertion edge = 3px ink inset on the target); drop it on a production chip in the toolbar to move it. Double-click a title to rename inline (Enter commits, Esc cancels). Every action narrates in a bottom toast: `SH11 moved to Saltwater · 2 takes and 38 cr went with it`.

---

## 8. Rig · Canvas (board 6a)

Route `/rig/canvas/[boardId]`. Sub-tabs `Canvas · Recipes · Run`; board chip (`Handbag TVC · SH04 board`); mono `9 NODES · 2 RUN · 27 CR SPENT · BUILDING IS FREE`; right: collaborator avatars (live cursors with `TO · ADDING A COMPARE NODE` labels), `Share`, `Save as recipe`. Layout: board (flex) + 300px inspector. Dotted board (`radial-gradient(rgba(245,246,248,.07) 1px, transparent 1px)`, 24px), floating `+ Add node ⌘K` pill top-left with the node kinds listed beside it.

**Node kinds** (all `--card`, radius 12, 32px header with a 9.5px mono kind tag `AST / SHOT / TXT / IMG / VID / EDT / UPS / AUD / VOX / CMP / NTE`):
- **Asset** 200px: name, kind, lock glyph; **one 32px image tile per port** (`FACE v3`, `HAIR v1`, `WARDROBE v2`, `VOICE v1` as a waveform; `HERO`, `DETAIL`; `PLATE 01`, `PLATE 02`; `LOOK`), each with an output dot on the right edge; idle ports at 50%. A character has a bundle port on its header ("all current").
- **Shot** 250px: `SH04 · title`; **slot rows** 40px (`CHARACTER · PROP · BACKGROUND · LOOK · PROMPT`) each with a 54×32 thumb, an input dot on the left edge; footer `3 TAKES · 57 CR · v4 NEW`; a `SPEC` output dot on the right edge; a dashed `TAKES` input dot on the bottom edge.
- **Prompt** 200px: text with `@Name` highlights, `FREE`.
- **Generate** (Image 250px / Video 180px): inputs (`SPEC`, `REFS · 4`, `IMAGE`, inline `MOTION` prompt), **outputs inside the node** (image: 2×2 variants with `OUT` on the chosen one; video: 16:9 with play, `DONE` accent chip, `0:05 · 1080P`), footer button with cost (`Again ×4 · 8 CR`, `Generate · 24 CR`, `Filed · SH04 v4 · 19 CR`).
- Wires: cubic beziers from output dot to input dot; `rgba(245,246,248,.3)` 1.5px inherited, ink 2.5px for a per-shot override, dashed `.35` for "filed back to shot"/"created from", ink 2px for the selected path. **A wire lands on a slot, not a node.**
- Inspector (300px): `NODE · VIDEO · SEEDANCE 2.5`, inputs list, settings pills (`5s`, `1080P`, `16:9`, `Audio on`, `SEED 41822`), output card (`OUTPUT` / `DONE · 4 MIN`, `Open in Shots`, `Promote frame`), primary `Run node again · 19 CR`, footnote `FILES AS SH04 v5 · v4 STAYS`.
- Rules: building is free; a node prices itself before it runs; changing anything upstream marks downstream nodes **stale** (never auto-reruns); an output files to a shot as the next version; `Save as recipe` turns the board into a Recipe.

Graph data: `node { id, kind, x, y, ports[], inputs[], output, settings, state, credits, staleSince }`, `wire { from: {nodeId, portId}, to: {nodeId, slotId}, kind: inherited|override|filed|created }`.

## 9. Rig · Run + checkpoint (board 9b)

Route `/rig/run/[runId]`. Sub-bar: tabs, `Production › Project · Run 02` chip, mono `RECIPE · … · 3 OF 8 STEPS`, `19 of 253 cr` bar.

**Pinned checkpoint card** (top, `--card`, 1px `.3` border, radius 14): ring at 64px in checkpoint state · eyebrow `ATOMIK · CHECKPOINT · STOPPED BEFORE STEP 04` · 20px headline *Boards done · 12 cr spent. Next: keyframes on Nano Banana Pro · 24 cr.* · one paragraph · `PLANNING · 3 CR · CLAUDE SONNET 4.5` · right column: primary `Continue · keyframes · 24 CR`, then `Change engine` / `Stop here`.

**Stage track**: 8 equal cards — number, name, state dot; result area (thumbnails as they arrive, text-result placeholder for brief/shots, dashed empty for queued); `DONE / CHECKPOINT / QUEUED` in mono (done accent, checkpoint ink, queued muted); engine + cost (queued costs muted). The checkpoint stage carries the selection ring.

Below: **What just finished** (boards 6-up with `PICKED` chips — Atomik's picks, changeable) and **What's next** (engine, per-unit cost, ETA, the next checkpoint's price). A failed stage renders `NEEDS YOU` and expands in place with 2–3 priced fixes (see §5 Question card); the run never restarts.

## 10. Make (board 8a)

Route `/make/video` (+ `/images`, `/audio`). Left: `Video · Images · Audio` segmented, mono `UNFILED · 9 TAKES · 117 CR · NOTHING REQUIRED`, search. **Unfiled wall** grouped by day (`Today · 5 takes · 71 cr`), 4-column cards: kind/spec chip, cost chip, prompt (2-line clamp), `model · by · time`, buttons `File to shot` / `Again`. Empty state links to the demo production.

Right: **the one composer** (400px rail, `#0F1116`): prompt (14.5px, `@Name` highlights, caret), reference well (`+ Ref`, first frame optional), **model chip** with its one-line "what it's for" and rate — expands into the model list (`Seedance 2.5 · Cinematic motion with native sound. The default for shots. · 19 CR / 5S`; `Kling 3.0 · Stronger physics, slower. Use for hands and cloth. · 24 CR / 5S`; `Veo 3.1 · Dialogue-led scenes with lip sync. · 28 CR / 8S`), pills `16:9 · 5s · ×1 · 1080P · Audio`, Setup rows (`NONE CARRIED · UNFILED` + `+ Row`), Cast chips + `+ Add`, primary `Render · 19 CR · 5S · 1080P`, footnote `LANDS ON THE WALL UNFILED · FILE TO A SHOT ANY TIME`. Images swaps duration for resolution and adds a reference well + Loose/Exact; Audio becomes script, voice picker with sample play, language, duration readout. **Identical component everywhere the composer appears.**

## 11. Library (board 8b)

Route `/library`. Header: `Library` + mono totals; segmented `Assets · References · Unfiled`; filters `Kind · Production · Locked`; search; primary `New asset · 0 CR`. Two panes: **Assets grid** (3 columns; 4:3 canonical still, kind chip, lock chip, version chip; name; `ports · where-used`; locked assets on `--card-raised`) and the **References board** (dotted, loose; items with `REF · …` chips; selecting one shows `Promote to asset · 0 CR`, `Use in Make`, `Add to Canvas`; `Open full board`). Library indexes project media; it never stores a second copy.

## 12. New asset sheet (boards 3a, 3b)

A 760px modal over any screen (scrim `rgba(5,6,8,.55)`): header `New asset` + `NAME · KIND · REFERENCES · THAT'S IT` + `FROM <where it opened>` chip. Row 1: **Name** (48px field, 20px 600, eyebrow `NAME · YOU'LL TYPE IT AS @IVER`) + **Kind** chips (`Character · Prop · Location · Look · Voice`, 48px). Row 2: **references well** (dashed, 64px thumbs, `+N`, sources `Upload · A take · Make · Canvas`). Row 3: **What particl reads from these** — one tile per derived port with `READY / LATER / OPTIONAL` (character: FACE, HAIR, WARDROBE, VOICE; prop: HERO, DETAIL, TURNTABLE; location: plates by hour; look: LOOK, GRAIN; voice: VOICE, LANGUAGE). Row 4: a **train switch** with its price (`Train the face now · 12 CR`; prop `Make a turntable now · 4 CR`; location `Fill the missing hour · 2 CR`; look `Apply to existing keyframes · 5 CR`; voice `Train the voice now · 8 CR`). Footer: mono consequence line, `Cancel`, primary `Create Iver · 12 CR` (or `0 CR` with the switch off). Rules: creating is free, learning costs; attributes are read from references, never typed; the same sheet opens from Rig, a take (Promote), a Canvas selection, an unknown `@name` in a prompt (**3b**: inline card in the composer — `NOT AN ASSET YET · @Iver`, three refs from the prompt, kind guess, `Create @Iver · 0 CR` / `Pick existing`, Render stays outlined until he exists), and Atomik.

## 13. Settings (board 4a)

Route `/settings`. 240px sticky index + one scrolling column of `--card` sections: **Workspace & credits** (name, default model, `16:9 · 5S · 1080P`, take states; credits card with balance, auto top-up, month-to-date, primary `Top up · 500 CR · $50`), **Team & roles** (3-column member cards with a role dropdown: Director, Producer, Artist, Editor, Admin; `Invite`), **Engines & rates** (per engine: status dot, what it does, rate, `ATOMIK MAY PROPOSE` switch), **Production defaults** (cap, warn at %, at the cap, who approves, who renders), **Atomik** (checkpoint rule, may create assets → propose only, planning model + rate, `NEVER WITHOUT YOU · SPEND · UNLOCK · DELETE · APPROVE`), **Rig & locks**, **Storage & masters** (`{production}_{shot}_{version}`, keep every take), **Notifications**, **Account**. Changes save on change.

## 14. Mobile — below 768px (reference: `design-references/Particl v2 - Mobile.dc.html`, boards M1–M10)

Same tokens, copy, data and rules as desktop. What changes, and only this:

- **Dock** replaces the top nav: Make · Productions · Rig · Library, 22px line icons over 12px Kode Mono labels (PRODS for Productions), 52–56px tall, 22px safe-area padding (`env(safe-area-inset-bottom)` in production). Usage and Settings stay behind the avatar. Inside a production the header becomes `‹ Production name` + title; the dock stays.
- **Header** 52px: mark + wordmark (or back link), balance mono, Atomik button (ring 14 in its live state + `Atomik` + state word), avatar 32.
- **Every right rail becomes a bottom sheet**: `#0F1116`, radius 24 top, 36×4 grabber, scrim `rgba(5,6,8,.55)`, × top right, primary pinned at the bottom with the 26px safe area. Atomik sheet: compact = 58% height (context line, one checkpoint card, Continue / Change engine / Stop, ask field) → expanded = 92% (conversation + plan card above the same checkpoint card). Slot inspector, composer and new asset are sheets too.
- **One primary, pinned**: the screen's filled button lives in a bottom block above the dock, 50–52px, cost right-aligned; it outlines while a sheet is open.
- **M1 Productions**: production rows stack; project tiles become a horizontal snap strip (200px tiles, `+ Project` at the end).
- **M2 Project › Media**: sticky header (title, format line, spent/cap 110px bar, stepper dots with only the current step named, need-you pill, sub-tabs); kind pills scroll horizontally; media 2-up per shot; `Download N masters · 0 CR` pinned.
- **M3 Shots**: 2-up media cards (16:9, ID chip, state dot, 2-line description, split PLAN / RENDERS footer); `+` square + `Render SH08–09 · 38 CR` pinned. Long-press opens the same context menu as desktop right-click; drag to reorder; the move-to-production submenu becomes a sheet.
- **M4 Make**: Video/Images/Audio segmented; unfiled wall 2-up by day with `File to shot / Again` split footers; the **composer docks** as a card above the primary (`COMPOSER · SEEDANCE 2.5 · 16:9 · 5S` + first prompt line) and opens as the sheet in **M9** (prompt, inline "not an asset yet" card for an unknown @name, ref well, model card with one-liner and rate, pills, Setup, Cast, outlined Render until the asset exists).
- **M5 Rig · Canvas**: read-and-run. The board is a vertical stack down one wire — assets strip node, shot node with 44px slot rows, image node with 4 variants, video node with the take — 390 wide, 1040 tall, scrolls. Tap a slot → inspector sheet with versions, "Before you change this" subsets and the priced apply button. No wire dragging on a phone; building happens on desktop. `Run node again · 19 CR` pinned.
- **M6 Rig · Run**: checkpoint card pinned first (ring 48, headline, next step, planning line), then the 8 steps stacked as rows (number, 72px thumb, name, engine, state dot + word, cost); Continue + Change engine / Stop here pinned.
- **M7 Library**: Assets / References / Unfiled segmented, filter pills scroll, 2-up asset cards (kind chip, lock, version, ports · where-used), `New asset · 0 CR` pinned above the dock.
- **M8 New asset**: full-height sheet — name field, kind pills (44px), reference well, derived-port grid (READY / LATER / OPTIONAL), train switch with price, `Create Iver · N CR` pinned.
- **M10 Settings**: back header, index pills scroll horizontally and anchor to sections; credits card first (balance, month to date, auto top-up, `Top up · 500 CR · $50`), then workspace rows, team rows with role dropdowns, Atomik rules.
- Nothing below 12px anywhere on mobile (mono labels, dock labels and node kind tags are all 12px); every target ≥ 44pt (segmented options are 40px inside a 44px control).

---

## 15. Data model (add or align)

```
workspace   { credits, rateUsd: 0.10, engines[], roles[] }
engine      { id, name, does, rate, unit, connected, atomikMayPropose }
production  { id, name, client, status, cap, spent }
project     { id, productionId, name, format, runtimeSecs, step, cap, spent, needYou }
shot        { id, projectId, order, desc, cast[], setup{size,move,lens,...}, plannedSecs, state, slots[] }
take        { id, shotId, kind: video|still|audio|master, version, state, credits, model, by, url, madeFrom }
asset       { id, name, kind, locked, lockedBy, attributes[], plates[], views[], usedBy[] }
attribute   { id, assetId, kind, versions[], currentVersionId, trained }
binding     { shotId, slot, assetId, attributeId, versionId, overridden }
board       { id, projectId, nodes[], wires[] }        recipe = board saved with stages[]
run         { id, recipeId, projectId, steps[{ n, name, engineId, credits, state, outputs[] }], spent, checkpointAt }
atomik      { state: closed|compact|expanded, context: {productionId, projectId, runId|shotId}, thread[] }
quote       { unitCredits, units, totalCredits }        resolved before any spending button enables
```

## 16. Acceptance

- Four nav items; Usage/Settings only in the account menu; balance always visible.
- Atomik renders nothing when closed; opens compact on click / ⌘J; expands; the grid behind reflows; page primary outlines while open.
- Exactly one filled primary per screen, cost inline, quoted before enable.
- Accent colour appears only on approved/done/running/checkpoint.
- Shots: grid + filmstrip, right-click menu, drag reorder, drop-to-move, inline rename, delete with undo, toast narration.
- Canvas: wires land on slot dots (±2px), outputs live in their node, filing writes a take to the shot.
- Media stays with its project on shot delete and moves with a shot.
- New asset: one sheet, derived-attribute preview, priced train switch, 0 cr without it.
- Nothing under 11px desktop / 12px mobile; all mobile targets ≥ 44pt.
- The only loading indicator anywhere is the Atomik ring loader; no spinner, no skeleton, no progress bar except under the planning message.

## Files

```
README.md                                     this spec
design-references/Particl v2 - Shots Rig Atomik.dc.html   all boards; use 11a 10a 9b 9c 8a 8b 7a 7b 6a 4a 3a 3b
design-references/Particl v2 - Mobile.dc.html   the same screens at 390×844; boards M1–M10
design-references/support.js                  preview runtime only — do not port
assets/particl-mark-*.svg                     the 7-dot trail (header mark)
assets/atomik-ring-*.svg                      the 8-dot ring (static fallback; render live from Ring.tsx)
```
