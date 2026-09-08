# Handoff: particl — node-graph surfaces (recipes, credits, provenance)

## Overview

Seven surfaces for the graph layer of **particl**, a production tool for AI filmmaking. A *recipe* is a graph of production stages; a *run* executes it; every stage and every swap has a price in credits, and the price is always on the button before it is pressed.

**1 credit = 10¢.** Every number in these designs is placeholder data from one sample production (**Northline**, 30s car spot, 12 shots, @Cass, @Workshop, @The Mule, Bleach bypass look).

Two turns, both in one reference file (`design-references/Particl Node Graph.dc.html`), newest first:

| id | Surface | Size | What it answers |
|---|---|---|---|
| 2a | Canvas · asset layer | 1440 × 900 | How characters, elements and backgrounds actually connect |
| 2b | Character attributes | 390 × 844 | A character is four versioned attributes, not one asset |
| 2c | Shot bindings | 390 × 844 | What one shot points at, and what changing it costs |
| 1a | Run view | 390 × 844 | Watching a recipe run; fixing a failed stage in place |
| 1b | Impact panel | 390 × 844 | Editing a shared element with existing takes downstream |
| 1c | Provenance card | 390 × 844 | Exactly what produced a finished take |
| 1d | Canvas · stage layer | 1440 × 900 | The recipe as an editable stage graph, chat alongside |

## About the design file

`design-references/Particl Node Graph.dc.html` is a **design reference authored in HTML** — a prototype of the intended look and behaviour, not production code. Recreate these surfaces in the ark-video Next.js codebase. `support.js` is a preview-only runtime; do not port it. Open the file directly in a browser (keep `support.js` beside it) — the interactive parts are live: the fix options on 1a, the three choices on 1b, node selection on 1d, the attribute rows on 2b and the plate picker on 2c.

Every striped grey rectangle with a monospace caption is an **image placeholder**. In production these are real frames: keyframes, take thumbnails, reference photos, location plates, turntable views. The whole point of 2a is that they are pictures, so do not ship it with text where a thumbnail belongs.

`DESKTOP-README.md` carries the shared design system (full token tables, both app shells, the other twelve screens, the state model, the Atomik ⇄ Particl sync contract). Read it for anything this document does not restate.

## Fidelity

**High-fidelity.** Colours, type, spacing, radii, copy and geometry are final-intent. The graph geometry in 2a and 1d is exact: node positions, port centres and wire endpoints were measured and match. Keep the port-to-slot alignment when you rebuild — a wire that misses its port breaks the one idea the screen exists to show.

---

## Tokens used here (light mode)

Full tables in `DESKTOP-README.md` and `design-tokens.json`. What these surfaces rely on:

| Token | Value |
|---|---|
| page | `#ECEDEE` |
| card | `#FFFFFF` |
| card · locked | `#F3F4F5` |
| card · needs-you tint | `#F7F5EC` |
| ink | `#15171C` |
| muted | `#666A72` |
| faint | `#8A8E96` |
| hairline | `rgba(21,23,28,.07–.08)` |
| border | `rgba(21,23,28,.12)` |
| border · strong | `rgba(21,23,28,.16–.20)` |
| selected border | `#15171C` + `0 0 0 3px rgba(21,23,28,.12)` |
| **accent (only one)** | `oklch(55% 0.12 200)` — done, approved, running progress. Nothing else. |
| primary button | `#15171C` fill, `#FFFFFF` text, cost in `#9A9DA3` |
| placeholder image | `repeating-linear-gradient(135deg,#E2E3E6 0 6px,#E9EAEC 6px 12px)` |
| placeholder waveform | `repeating-linear-gradient(90deg,rgba(21,23,28,.34) 0 2px,transparent 2px 5px)` |

Type: `Outfit` 400/500/600 for everything readable; `Kode Mono` 500 uppercase with 0.06–0.16em tracking for eyebrows, ids, versions and credit values. **No text below 12px on the mobile surfaces**; desktop node internals bottom out at 10px for port tags and 10.5px for ids. Radii: 4–6 badges and thumbs, 8 tiles, 10–12 buttons and nodes, 14 sheets and mobile buttons, 16 mobile cards, 24 mobile artboard. No shadows anywhere except a dragged object.

Tap targets on mobile ≥ 44px (buttons 48–56, list rows 60–64).

## Rules the surfaces enforce

1. **The price is on the action.** Every button that spends credits shows its cost inline, right-aligned, in mono: `Render · 29 cr`, `Bind plate 03 · 29 CR`, `Re-render approved · 174 cr`. Quote before you enable.
2. **State vocabulary.** `queued → running → done`, plus `needs you` for a failure and `locked` for a pinned element. Dots: done/running = accent (running is a 2.5px ring, done is filled), queued = dashed muted outline, needs-you = filled ink on a `#F7F5EC` card, locked = no dot, a lock glyph instead.
3. **Take states** are `draft → picked → approved` (from the main app). Only approved takes reach assembly.
4. **A failure never restarts a run.** It offers fixes in place, each priced.
5. **Nothing re-renders silently.** Any edit to a shared element opens the impact panel first.
6. **A wire lands on a slot, not on a node.** Ports are the unit of connection.
7. **Versions are additive.** A new attribute version never alters an existing take; it is the *swap* that costs.

---

## 2a · Canvas, asset layer (1440 × 900) — the mechanism

Three columns: `288px` chat · flexible graph · `272px` inspector. Header 60px: mark + wordmark, project name, `Assets | Stages | Runs` pills, right side `2 LOCKED · 1 OVERRIDE · 1 CREATED` and a `New element · 12 CR` primary.

**Chat (left).** Every wire was made here; the panel states that under its eyebrow. Messages: user bubbles are ink-filled and right-aligned, particl replies are white cards left-aligned, each reply followed by mono chips naming what it touched (`SH03 CHAR`, `WARDROBE v1`, `0 CR`). Composer is a 48px field + 48px ink send button.

**Graph (centre).** Toolbar 48px: `LIBRARY → SHOTS → STAGES` + one line of instruction. Scrollable area holding a 1040 × 770 graph. Wires are a single `<svg>` layer under the nodes, three styles:

- `rgba(21,23,28,.28)` 1.5px — inherited current version
- `#15171C` 2.5px — an override set on one shot
- `rgba(21,23,28,.35)` 1.5px dashed — created from a take
- `#15171C` 2px dashed — the wire currently being dragged

**Node anatomy — thumbnails carry the meaning.**

*Asset node* (190 wide): a 28px header (name 13px + four-letter kind in mono + lock glyph; 40px when it carries an origin line like `CREATED FROM SH03 v2`), then one **40px-tall full-width image tile per port**, 5px apart. Each tile has a white tag chip top-left (`FACE`, `PLATE 02`, `TURNTABLE`) and its version bottom-right (`v3`, `interior`, `8 views`). Unused ports drop to 50% opacity with a dashed port dot. Port dots sit on the right edge at each tile's centre; a character also has a **bundle port** on its header meaning "all current versions".

Four asset nodes, at graph coordinates:
- **Cass** · character · locked · x 16 y 16 — ports FACE v3 (centre y 64), HAIR v1 (109), WARDROBE v2 (154), VOICE v1 (199, idle, drawn as a waveform); bundle port at y 32.
- **Workshop** · location · x 16 y 243 — PLATE 01 wide (291), PLATE 02 interior (336), PLATE 03 night (381, idle).
- **The Mule** · element · x 16 y 425 · origin `CREATED FROM SH03 v2` — TURNTABLE 8 views (485), DETAIL 2 views (530, idle).
- **Bleach bypass** · look · locked · x 16 y 574 — LOOK v2 (622).

*Shot node* (220 wide): 40px header (id in mono + title), then **the keyframe as a 112px 16:9 image** with a white chip on it (`SH04 S2 · KEYFRAME`), then four 40px slot rows — each a 54 × 34 thumbnail, a mono tag (`CHAR` / `BG` / `ELEM` / `LOOK`) and a version, with an ink port dot on the node's left edge. An overridden slot gets an `OVR` badge and its tag goes ink. Footer 32px: state in mono + the shot's credit estimate.

- **SH04** · x 280 y 16 — slot port centres 199 / 239 / 279 / 319. BG is the drop target: 2px ink ring around the row, value text dropped, `29 CR` badge in its place.
- **SH03** · x 280 y 390 — port centres 573 / 613 / 653 / 693. CHAR is `wardrobe v1` with `OVR`.

*Stage node* (190 wide): 28px header (number + name + state dot), a 96px result image with a white chip (`12 STILLS · 2K`, `3 OF 12 · 0:05` — Motion burns its progress bar into the bottom of the frame), 28px footer (engine + credits). The takes node shows three take thumbs with the approved one outlined in accent and a `Promote v2 to element` button beneath. Stages 06–08 collapse into one dashed `#F3F4F5` chip reading `COLLAPSED · 17 CR`.

Positions: Keyframes x 560 y 16, Motion x 560 y 195, Takes x 560 y 456, collapsed stages x 800 y 250.

**Wire list** (verbatim from the reference; keep these endpoints):

```
inherited   206,32  → 280,199    (Cass bundle → SH04 CHAR)
inherited   206,336 → 280,239    (plate 02 → SH04 BG)
inherited   206,291 → 280,613    (plate 01 → SH03 BG)
inherited   206,485 → 280,279    (turntable → SH04 ELEM)
inherited   206,485 → 280,653    (turntable → SH03 ELEM)
inherited   206,622 → 280,319    (look → SH04 LOOK)
inherited   206,622 → 280,693    (look → SH03 LOOK)
override    206,154 → 280,573    (WARDROBE v2 port → SH03 CHAR, as v1)
inherited   500,195 → 560,92     (SH04 → Keyframes)
inherited   655,168 → 655,195    (Keyframes → Motion)
inherited   500,569 → 560,520    (SH03 → Takes)
inherited   750,271 → 800,292    (Motion → collapsed stages)
created     750,520 → … → 111,566  (Takes → The Mule, long dashed loop)
dragging    206,381 → 280,239    (plate 03 → SH04 BG)
```

The dashed creation loop is annotated `SH03 v2 CREATED THE MULE` at graph 16,731 — on the wire's vertical run, clear of the nodes.

**Inspector (right, 272px).** Scoped to the slot under the cursor, not the node: eyebrow `SLOT · SH04 BACKGROUND`, title `Workshop`, and the sentence that explains the model — a location holds plates, the shot binds to a plate. Then the three plates as 16:9 image cards: plate 01 tagged with the shot using it, plate 02 with a 2px ink border and a `BOUND` badge, plate 03 with a dashed ink border and `DRAGGING`. A dashed `Add a plate · 0.4 cr` button. Footer: `Bind plate 03 · 29 CR` primary and `SH04 ONLY · OTHER SHOTS KEEP PLATE 01`.

**Known trade-off:** with the chat panel restored the graph viewport is ~878px against the 1040px graph, so ~162px scrolls off the right at rest and the collapsed 06–08 node is partly cut. Acceptable for a scrollable canvas; if it needs to read at rest, pull the column x-positions in ~120px or narrow the inspector to 240px.

## 2b · Character attributes (390 × 844)

Header 56px: back, `Cass`, `CHARACTER · USED BY 14 SHOTS`, lock glyph. A 4-up row of 3:4 reference thumbs (fourth reads `+14`). The sentence that sets the rule: any prompt citing `@Cass` gets these versions, and a shot can override one attribute without leaving the character.

**ATTRIBUTES · 4 PORTS** in one white card, a 64px row each: 40px thumbnail, mono attribute name, current version, lock glyph, and a meta line (`Trained from 18 photos · used by 14 shots`, `8 shots on v2 · 6 held on v1`). Tapping a row expands it in place (row tints `#F3F4F5`) into a horizontal strip of 112px 3:4 version cards — the in-use one bordered ink — plus a dashed `+ New version` card and the rule in mono: a new version never changes existing takes; swapping one opens the impact panel.

Rows: FACE v3 (locked), HAIR v1 (locked), WARDROBE v2 (open by default, versions `v1 waxed coat · 6 shots` and `v2 overalls · in use`), VOICE v1 (locked).

**WIRED INTO** card: `Keyframes · Motion → FACE · HAIR · WARDROBE`, `Audio → VOICE`, `SH03 only → WARDROBE v1 · OVERRIDE` (the override line in ink).

Footer: `Unlock` secondary + `Add a version · 12 cr` primary.

## 2c · Shot bindings (390 × 844)

Header: back, `SH03`, `THE MULE, LOW TRACKING · APPROVED`. The take as a 16:9 image with `v2 APPROVED · 0:03 · 29 CR` on it. One sentence: five slots, each pointing at a version in the library; change a slot and only this shot moves.

Five 64px binding rows in one card — 44 × 32 thumb, mono slot name, value, detail line, badge, chevron:

| Slot | Value | Detail | Badge |
|---|---|---|---|
| CHARACTER | Cass | face v3 · hair v1 · wardrobe v1 | OVERRIDE |
| BACKGROUND | Workshop · plate 01 | 1 of 3 plates | — |
| ELEMENT | The Mule · turntable | created from SH03 v2 | CREATED |
| LOOK | Bleach bypass v2 | locked with the brief | LOCKED |
| KEYFRAME | SH03 S3 | the frame Motion starts from | — |

The BACKGROUND row is expanded into a **plate picker**: three 16:10 image cards with their name as a chip (selected card gets an ink chip, ink border and a soft ring) and a one-line description. Selecting a different plate flips the row's detail to `changed from plate 01`, adds a `CHANGED` badge, changes the mono line to `CHANGING THE PLATE RE-RENDERS THIS SHOT · 29 CR`, and moves the footer primary from `0 cr` to `29 cr`.

Then **THIS SHOT MADE AN ELEMENT**: The Mule, `Promoted from v2 · 8 turntable views · now bound in 6 shots`. Footer: `Revert` + `Re-render this shot · {cost}`.

## 1a · Run view (390 × 844) — the primary screen

Header 56px: back, `Run 04`, `NORTHLINE · STARTED 14:02`, overflow. 

**Cost header card:** eyebrow `SPENT OF RUN ESTIMATE`, `74` at 40px + `of 118 credits` + `$11.80` right, a 6px ink bar, then `4 of 8 stages complete` / `1 stage needs you`. Below it, one line in ink when something is wrong: *One stage needs you. The rest of the run is holding, not lost.*

**Eight stage cards**, 16px radius, 14px padding: a 60 × 38 well (striped once the stage has output, dashed and `—` before), name 16px, a sub line (`12 shots · Seedance 2.5`), then right-aligned state (dot + word) over the credit cost. Running stages add an accent progress bar with `3 OF 12 SHOTS · 62%` / `~4 MIN LEFT`. Stages and costs: Brief 2 · Scene 3 · Shot list 4 · Keyframes 5 · Motion 87 (running, shows `54 / 87 cr`) · Post 6 (failed) · Audio 9 · Assembly 2.

**The failed stage is fixed in place.** Its card tints `#F7F5EC` with an ink border and opens a block under a hairline: the real reason (*The upscaler refused SH07 — it returned a 1088px height and Post expects 1080. Nothing downstream has started.*) and three 48px radio rows, each with a consequence and a price — `Set Post height to 1088 · 0 cr`, `Re-render SH07 at 1080 · 29 cr`, `Skip Post on SH07 · 0 cr` — closing with `FIXED IN PLACE · THE RUN CONTINUES FROM HERE`. The selection drives the bottom bar.

Footer: `Pause` secondary + `Fix and continue · {selected cost}` primary. With no failure the primary becomes `Approve run · 118 cr`.

## 1b · Impact panel (390 × 844)

A sheet over the dimmed edit screen (scrim `rgba(21,23,28,.42)`, sheet radius 24 top, max-height 88%, 38 × 4 grabber). Eyebrow `IMPACT · CASS'S LOOK`, headline *You changed a look 14 shots are using.*, and the reassurance that nothing has been re-rendered yet.

Summary card: `Used by 14 shots` / `6 approved · 8 draft`, a split bar (accent / `rgba(21,23,28,.2)`), and a scrolling row of shot pills each with its state dot.

Three choice cards (16px radius, 20px radio, cost in mono, consequence indented under the label), priced at 29 cr per shot:
- `Re-render all 14 · 406 cr` — the 6 approved takes return to draft for re-approval.
- `Re-render approved only · 174 cr` — the 8 drafts keep the old look until you render them. *(default)*
- `Leave existing takes · 0 cr` — nothing already made changes; only new renders use the new look.

Footer primary mirrors the choice (`Keep existing takes` for the third), with a mono footnote restating the consequence (`174 CR · $17.40 · 8 DRAFTS LEFT ON V3`).

## 1c · Provenance card (390 × 844)

Header: back, `SH04 v2`, `APPROVED · 4 SEP 16:41`. The take as a 16:9 image with a white chip. Then **PRODUCED BY** — five 60px tappable rows, each a 36px icon tile (striped for visual inputs, outlined for the rest), mono kind, value, version and chevron: CHARACTER Cass v3 · LOOK Bleach bypass v2 · LOCATION Workshop v1 · ENGINE Seedance 2.5 (ModelArk) · RULES IN SCOPE 3 rules.

**SETUP · 12 VALUES CARRIED IN** as chips. **EXACT CONDITIONS** as a key/value list: `1920 × 1088`, `0:05`, seed `41822`, `ONE MOVE · NO TITLES · PRACTICALS`, `29 CR · $2.90`, `TO · 4 SEP 16:41`.

One primary: `Make another from exactly this · 29 cr`, footnoted *Same character version, look, Setup and rules. New seed.*

## 1d · Canvas, stage layer (1440 × 900)

Same three-column shell as 2a. The recipe as eight stage nodes wired left to right in a 860 × 530 graph: Brief → Scene → Shot list → Keyframes → Motion → Post, with Audio branching off Shot list and Assembly taking Post + Audio. Three locked elements (Cass, her look, her voice) sit in a top band on `#F3F4F5` with lock glyphs, wired down into Keyframes, Motion and Audio with dashed wires.

Node (126 wide): number + lock/state dot, name 13px, engine in mono, footer with inputs and the credit estimate. Selected node gets an ink border and a soft ring. A 150 × 92 minimap sits bottom-left with a viewport rectangle.

Inspector switches with the selection: `INSPECTOR · STAGE 05` / name / a plain-language blurb, an engine dropdown with its rate, an inputs list (locked inputs get an ink dot and read `locked`), parameters as chips, an estimate card (`87 cr` over `3 SHOTS × 29 CR · 9 SHOTS QUEUED`), and a footer action. Selecting a **locked** element instead shows a `LOCKED FOR THIS RECIPE` card naming who locked it and what unlocking would mean, plus `Unlock for this recipe`.

Toolbar: zoom cluster, `Fit`, and `8 STAGES · 3 LOCKED · 1 BRANCH`.

---

## Data model these surfaces imply

Additions to the model in `DESKTOP-README.md`:

```
recipe        { id, projectId, draft, stages[], estimateCredits }
stage         { id, num, name, engineId, params{}, inputs[ref], state, credits, perUnit, results[] }
run           { id, recipeId, startedAt, state, spentCredits, estimateCredits,
                stageRuns[{ stageId, state, progress, spent, failure }] }
failure       { stageId, unit, reason, fixes[{ id, label, note, credits, kind }] }
element       { id, kind: character|location|prop|look|voice, name, locked, lockedBy, lockedAt,
                attributes[], plates[], views[], createdFrom{ shotId, takeId } | null }
attribute     { id, elementId, kind: face|hair|wardrobe|voice, versions[], currentVersionId, locked }
version       { id, label, thumbUrl, createdAt, usedByShotIds[] }
binding       { shotId, slot: character|background|element|look|keyframe,
                elementId, versionId, overridden: bool }
provenance    { takeId, bindings[], setup{}, engineId, engineParams{}, seed, rules[], credits, by, at }
impact        { elementId, versionId, dependents[{shotId,state}], options[{key,shotCount,credits,consequence}] }
quote         { unitCredits, units, totalCredits }   // resolved before any action enables
credits       { balance, rateUsd: 0.10 }
```

Conventions: costs are integers in credits, formatted `N cr` (lowercase in body, `N CR` in mono eyebrows); currency is derived (`credits × 0.10`) and shown as a secondary. Port identity is `elementId:attributeId:versionId` — that triple is what a wire carries and what provenance records.

## Files

```
README.md                                    this document
DESKTOP-README.md                            shared design system + the other twelve screens
design-tokens.json                           machine-readable tokens
assets/                                      particl mark, light and dark, SVG
design-references/
  Particl Node Graph.dc.html                 all seven surfaces, turn 2 above turn 1
  support.js                                 preview runtime only — do not port
```
