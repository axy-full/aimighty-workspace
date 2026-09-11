# particl v2 — mobile interface (M1–M10)

The mobile layer of the particl v2 design language. Ten screens at **390 × 844** in `design-references/Particl v2 - Mobile.dc.html`, each with an id badge M1–M10. Open the file in a browser (keep `support.js` beside it); M3, M5 and M8 are interactive.

`DESKTOP-README.md` is the full v2 spec — tokens (§2), primitives (§3), routes and page rules (§4–§13), data model (§15), acceptance (§16). This document covers only what mobile changes. Same tokens, copy, data and rules; **responsive variants of the same routes, not separate pages.** Breakpoint: below 768px.

The file is a design prototype in HTML, not code to lift — rebuild with the repo's components. Striped grey rectangles are image placeholders. All data is placeholder.

## The ten screens

| Board | Screen | Route | Desktop board |
|---|---|---|---|
| M1 | Productions | `/productions` | 7a |
| M2 | Project › Media | `/productions/[prod]/[project]/media` | 7b |
| M3 | Shots + Atomik sheet (live) | `/productions/[prod]/[project]/shots` | 10a |
| M4 | Make · Video with docked composer | `/make/video` | 8a |
| M5 | Rig · Canvas, read-and-run (live slot sheet) | `/rig/canvas/[boardId]` | 6a |
| M6 | Rig · Run with pinned checkpoint | `/rig/run/[runId]` | 9b |
| M7 | Library | `/library` | 8b |
| M8 | New asset sheet (live kind switch) | modal from any screen | 3a |
| M9 | Composer sheet + "not an asset yet" | opens from M4's docked bar | 8a · 3b |
| M10 | Settings | `/settings` (from the avatar) | 4a |

## What changes on mobile

**Dock instead of top nav.** Bottom dock: Make · Library · Productions (labelled PRODS) · Rig (CR1 §9 order) — 22px line icons (1.6 stroke, round caps) over 12px Kode Mono labels, 52–56px tall, plus the safe area (`env(safe-area-inset-bottom)`; the mocks use 22px). Active = ink, inactive = `#8A8E96`. Usage and Settings stay behind the avatar. Inside a production the header becomes `‹ Production name` + title; the dock stays.

**Header** 52px: mark + wordmark or the back link (44px tall), balance in mono, Atomik button (44px pill, ring at 14 in its live state, `Atomik` + state word such as CHECKPOINT), avatar 32.

**Every right rail becomes a bottom sheet.** `#0F1116`, radius 24 top, 1px `.14` top border, 36×4 grabber, scrim `rgba(5,6,8,.55)` (tap to close), × top right (34px), body scrolls, primary pinned at the bottom with 26px safe-area padding. Lock body scroll while open.
- Atomik: compact = 58% height — context line, **one card** (checkpoint headline, one sentence of what's next, `Continue · 24 CR` 52px, `Change engine` / `Stop here` 44px, `19 OF 253 CR · PLANNING 3 CR`), ask field. Expand ↑ → 92%: conversation and the plan card (48px rows, `CHECKPOINT · YOU ARE HERE`) above the same checkpoint card. Compact ↓ returns; × closes. Opens from the header button on every screen.
- Slot inspector (M5), composer (M9), new asset (M8, full height from 44px) use the same chrome.

**One primary, pinned.** The screen's single filled button lives in a bottom block above the dock, 50–52px, radius 14, cost right-aligned in mono `#4A4E56`. It **outlines** (`.2` border, `#B4B7BE` text) while any sheet is open or while an action is blocked (M9: Render is outlined until @Iver exists). Scroll containers pad their bottom by the pinned block's height + 10px so the last row is always reachable.

**Segmented controls** fill the width: 2px container, options 40px tall inside a 44px control. **Filter and index pills** scroll horizontally, bleeding to the screen edge (`margin:0 -16px; padding:0 16px`), 36–40px tall.

**Grids** are 2-up (shots, media, unfiled takes, library assets) with the desktop card anatomy at reduced padding: ID chip top-left, state dot top-right, 2-line clamped description, split PLAN / RENDERS footer written short (`4S · 19 CR` / `2 TK · 38 CR`).

**Strips** (project tiles on M1, assets on M5's board node, cast chips) are horizontal, `scroll-snap-type:x mandatory`, 8px gaps, edge-bleeding.

## Per-screen notes

- **M1** — production rows stack (name, client, need-you pill, spent-of-cap line + 3px bar, project count); project tiles are 200px snap cards (16:7 well with media count and need-you, name, stepper dots + current step, spent / cap) with `+ Project` at the end.
- **M2** — sticky header block: title + format line, spent of cap with a 110px bar, stepper dots naming only the current step, `3 need you`, sub-tabs Shots · Boards · Approve · Media. Kind pills scroll. Media 2-up per shot group. `Download 2 masters · 0 CR` pinned.
- **M3** — 2-up shot cards; `+` square (50px) beside `Render SH08–09 · 38 CR`. Long-press opens the desktop context menu as a sheet (Copy, Paste after, Rename, Open in Rig, Move to production ▸, Delete with undo); drag to reorder; the move submenu is a second sheet. Tap Atomik for the sheet described above.
- **M4** — Video / Images / Audio segmented; `UNFILED · 9 TAKES · 117 CR`; wall grouped by day, 2-up cards with spec and cost chips, prompt clamp, model · by · time, split `File to shot / Again` footer (40px). A take still rendering shows the ring loader (36px) in its well. The **composer docks** as a card above the primary: eyebrow `COMPOSER · SEEDANCE 2.5 · 16:9 · 5S`, first prompt line, ↑; tapping it opens M9. `Render · 19 CR · 5S · 1080P` pinned, then the dock.
- **M5** — Rig on a phone is **read-and-run**: the board built on desktop is shown as a vertical stack down one wire (assets strip node → shot node with 44px slot rows → image node with 4 variants and `Again ×4 · 8 CR` → video node with the take and `Filed · SH04 v4 · 19 CR`), 390 wide, scrolls. Tap a slot → sheet: slot name, sentence, three version cards (BOUND badge), and when a different version is picked, **Before you change this** (7 shots · 3 approved · 4 draft, split bar, three priced subsets) driving the pinned apply button (`Apply v3 to approved · 57 CR`; outlined `Bound to v2 · PICK ANOTHER VERSION` otherwise). No wire dragging. `Run node again · 19 CR` pinned under `BUILT ON DESKTOP · RUN AND FILE FROM HERE`.
- **M6** — checkpoint card first (ring 48 in checkpoint state, `ATOMIK · CHECKPOINT · BEFORE STEP 04`, headline, next step + price, planning line), then the 8 steps as rows: number · 72px thumb (striped when done, dashed when queued) · name + engine · state dot/word · cost (queued costs muted); the checkpoint row carries the selection ring. `Continue · keyframes · 24 CR` + `Change engine` / `Stop here` pinned.
- **M7** — (amended by CR1 §5: the segmented became index pills — Characters · Locations · Props · Looks · Voices · References · Unfiled — over labelled 2-up sections; one Filter pill holds Production · Locked · Trained) Assets · References · Unfiled segmented; filter pills (Kind, Production, Locked, Search); 2-up asset cards (4:3 still, kind chip, lock chip, version chip, name, `4 PORTS · 14 SHOTS`; locked on `#171A21`). `New asset · 0 CR` pinned above the dock.
- **M8** — full-height sheet: `NAME · YOU'LL TYPE IT AS @IVER` field (52px, 20px type, caret), kind pills (44px, selected = ink fill), references well (64px thumbs + Add; sources Upload · A take · Make · Canvas), **What particl reads from these** 2-up derived-port tiles (READY accent / LATER / OPTIONAL — set changes with the kind), train switch (52×32) with its price and note, pinned `Create Iver · 12 CR` (0 CR with the switch off) under the consequence line.
- **M9** — the one composer as a sheet: prompt (15px, @mentions), the inline **NOT AN ASSET YET · @IVER** card (two refs + add, kind dropdown, `Create @Iver · 0 CR` / `Pick existing`), ref well with note, model card (name, one-liner, `19 CR / 5S ▾`), pills 16:9 · 5s · ×1 · 1080P · Audio (40px), Setup (`NONE CARRIED · UNFILED` · + ROW), Cast chips incl. `@Iver · new` dashed; Render outlined with `CREATE @IVER FIRST · LANDS ON THE WALL UNFILED`.
- **M10** — `‹ Back` header with `MARA · ADMIN`; index pills scroll and anchor; credits card first (balance + USD, month to date, auto top-up toggle, `Top up · 500 CR · $50`), workspace rows (48px, value ▾), team rows (30px avatar, name, role ▾, `Invite`), Atomik rules (`EVERY PAID STEP`, `PROPOSE ONLY`, `NEVER WITHOUT YOU · SPEND · UNLOCK · DELETE · APPROVE`).

## Rules that hold on mobile

- Nothing below **12px** anywhere; every target **≥ 44pt** (segmented options 40px inside a 44px control).
- One filled primary per screen, cost inline, quoted before it enables; outlined while a sheet is open.
- Accent `oklch(75% 0.12 200)` only for approved / done / running / checkpoint.
- The Atomik ring is the only loader (36px in wells, 14px in buttons) — no spinners, no skeletons.
- No shadows, no gradients beyond the placeholder stripes, no motion beyond the ring.
- Media belongs to its project; Library indexes, never duplicates.

## Acceptance (add to DESKTOP-README §16 for < 768px)

- Dock present on Make, Productions, Rig, Library; hidden inside sheets and on the New asset sheet.
- Atomik opens compact from the header button, expands, compacts, closes; the page primary outlines while open.
- Every scroll container's last row is fully visible above its pinned block at max scroll.
- Long-press on a shot card opens the context menu sheet; drag reorders.
- Slot tap on the Rig board opens the inspector sheet; changing the version reveals the priced subsets and updates the apply button.
- Kind change in New asset swaps the derived-port tiles and the train switch's label and price.

## Files

```
README.md                                       this document (mobile)
DESKTOP-README.md                               full v2 spec: tokens, primitives, routes, data model, acceptance
design-references/Particl v2 - Mobile.dc.html   M1–M10 at 390×844, three of them interactive
design-references/support.js                    preview runtime only — do not port
assets/particl-mark-on-dark.svg                 header mark
assets/atomik-ring-on-dark.svg                  static ring fallback; render live from Ring.tsx
```
