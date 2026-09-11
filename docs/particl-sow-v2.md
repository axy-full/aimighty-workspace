# particl v2 — scope of work

**Documents of record.** This SOW is the source of truth for scope, sequencing, architecture and acceptance. `docs/handoff/v2/README.md` is the design spec of record — tokens, primitives, per-board geometry — and `design-references/Particl v2 - Shots Rig Atomik.dc.html` is the visual reference (boards `11a 10a 9b 9c 8a 8b 7a 7b 6a 4a 3a 3b`; every other board is superseded history). **Below 768px**, `docs/handoff/v2-mobile/README.md` and `design-references/Particl v2 - Mobile.dc.html` (boards `M1–M10` at 390×844; M3, M5, M8 interactive) are the spec of record. Mobile is **responsive variants of the same routes, not separate pages** — same tokens, copy, data and rules; the mobile README covers only what changes. Where this SOW and the README disagree on a visual detail, the README wins; where they disagree on scope, data, money or sequencing, this SOW wins. Where either disagrees with shipped code, check the code and update the document. The earlier node-graph handoff (`docs/handoff/nodegraph/`) is superseded by v2 except where noted in §5.

Repo: **ark-video**, Next.js, `app/(app)/…` routes, `components/`, `lib/`. The v2 UI **replaces** the current UI route by route as each replacement lands; never run both.

---

## 1. Product and information architecture

**particl** (particl.app) is a **creator's studio** — a full alternative to conventional production that puts the power of a crew in the hands of one creator or a small team. It replaces the departments, not the craft: casting (characters with face, hair, wardrobe and voice that stay consistent across every shot), art department (locations, props, looks), camera and lighting (Setup rows and the camera bank — a director's vocabulary, not a prompt box), storyboards that become keyframes, performance (motion, lip-sync, identity), sound, editorial (filmstrip, approve, masters, EDL), and a production office (credits, caps, statements) so a creator can afford to finish. **Atomik** is the AD: it plans the day, runs the set, and stops before anything expensive.

**The moat is the whole film.** A creator can make a sixty-shot short with three characters who look the same in shot 60 as in shot 1, in the language of filmmaking, in one place, and walk out with masters and an edit. Cost-before-you-press and the approval trail are what make that survivable on a creator's budget — the production office, not the pitch.

Invite-only and multi-tenant at launch; teams and production houses are creators with a payroll and are served by the same product with guest seats and statements (§2, §7). Every workspace is a studio.

### Hierarchy: Productions › Projects › Media
- **Production** — the client job. Holds the assets (shared by every project inside it, via Rig), a cap, spend, status.
- **Project** — one deliverable inside a production (30s hero, 15s cutdown, 9:16 socials, key visuals). Each has its own six-step stepper **Brief · Shots · Boards · Takes · Approve · Deliver**, its own cap, its own "need you" count.
- **Media** — takes, stills, audio, masters. Belongs to the project that made it, grouped by shot. **Survives shot deletion and travels when a shot moves.**

### Top nav — four items
**Make · Productions · Rig · Library.** Usage and Settings live in the account menu. A `BALANCE 1,240 CR` readout sits left of the Atomik button on every screen. Below 768px the same four items become a **bottom dock** (`Make · PRODS · Rig · Library`); Usage and Settings stay behind the avatar; inside a production the header becomes `‹ Production name` + title and the dock stays.

- **Make** — free generation, nothing required. Everything it makes is *unfiled* until "File to shot".
- **Productions** — the structured path above.
- **Rig** — three tabs: **Canvas** (build a node board, free), **Recipes** (a board saved as a reusable stage pipeline with an engine and price per stage), **Run** (a recipe executing, with Atomik's checkpoints).
- **Library** — one collection, three lenses: **Assets** (cross-production roster), **References** (loose board), **Unfiled** (Make's output). Indexes project media; never duplicates it.
- **Atomik** — the production agent. Hidden behind one header button until clicked; a right rail (compact → expanded) on desktop, a sheet on mobile. Vocabulary: "Ask Atomik", never "AI", never "assistant".

### States
Take: **draft → picked → approved**. Run step: **queued → running → done**, plus **needs you** and **checkpoint**.

---

## 2. Engine map, credits and pricing

### Engine map — source of truth
| Provider | Models | Notes |
|---|---|---|
| **ByteDance** (BytePlus ModelArk) | Seedance 2.5 | Video default. Direct. |
| **Google** | Nano Banana Pro | Stills. Direct on Google's APIs. |
| **fal** | Kling 3.0, Kling 3.0 Motion, Topaz, Soul ID, Flux character | One adapter, several media models. `FAL_KEY` not yet set. **No LLMs through fal.** |
| **ElevenLabs** | Voice | Audio. |
| **Vercel API** | Claude, GPT | **Every LLM call** — Atomik's planning, the builders, prompt enhancement. Nothing else. |

Settings → Engines & rates reads from the adapter registry; the engine list and rates are **never typed**.

### Credits
**1 credit = US$0.10, fixed.** Sell price = engine cost × 1.5, rounded up to the next whole credit per job; batches multiply before rounding. Ledger keeps `engine_cost_usd`, `billed_credits`, `multiplier_applied`; margin is the gap, per engine, never shown. **Floor guard:** an engine whose rolling 7-day margin drops under 10% auto-restores 1.5× and alerts the platform admin.

The price appears in **exactly three places**: the production/project header (`spent of cap`), the one filled primary button on the screen, and Usage. Every button that spends shows its cost inline before it is pressed, and a `quote` resolves before the button enables.

**The aimighty workspace bills at cost.** Any workspace flagged `internal: true` (platform admin only) has multiplier 1.0 and no platform fee. Same ledger, same statements; excluded from margin reporting.

**Draft/hero split is a product default.** Recipes route boards to standard panels (1 cr), draft takes to Kling Standard or Wan (4–8 cr), hero takes to Seedance or Kling Pro (25–45 cr). The composer's model chip defaults from the shot's stage.

### Tiers, packs, guardrails
| Tier | Price | Included | Members |
|---|---|---|---|
| Invite | $0 | 50 cr once, 1 production | 3 |
| Studio | $49/mo | 400 cr, 250 standard panels, review links, exports, post tools | unlimited |
| Agency | $199/mo | 1,600 cr, 1,000 panels, priority queue, branded review links, statements | unlimited |
| Production | $999/mo | 9,000 cr, 3,000 panels, admin console, setup hours | unlimited |

Every tier is profitable at full use of its inclusions. Inclusions expire at cycle end. No seat fees. Annual 20% off. Auto-cancel after 60 days of no generation. Packs at $0.10/cr with bonus credits capped at 20%: 500/$50 · 2,200/$200 · 5,750/$500 · 24,000/$2,000. Guardrails in code: one-time free grant capped by `grant_budget_usd`; any workspace over 25% of monthly engine spend is flagged; any job over 200 cr fires the cost approval rule; included and purchased credits metered separately.

Volume rates (Phase B, ~$20–50k/mo engine spend) are a settings change: per-engine multipliers already exist; hold sell prices, let margin rise.

---

## 3. Ground rules

1. **Other people's money.** Never trigger a generation, training or upscale against a customer workspace. Mocked engines in development; real calls only in the internal workspace, cost stated, wait for a yes.
2. **Tenant isolation is the floor.** `workspace_id` on every table, every query, every Blob path, every signed URL. Assets, media, prompts, costs, rules and runs never cross a boundary.
3. **Nothing tied to one studio.** Learned rules, defaults and recipes are the **platform layer**, inherited and overridable per workspace. No client, workspace or person names in source, seed data or copy.
4. **One vocabulary, the README's.** Assets (not elements), "Made from" (not provenance), stale (not impact), "Ask Atomik". Ports and slots appear in Rig only.
5. **One filled primary per screen**, cost inline, quoted before enable. When a rail opens, the page's primary drops to outlined.
6. **Dark only. There is no light theme.** Accent appears only on approved / done / running / checkpoint.
7. **The Atomik ring is the only loading indicator.** No spinners, no skeletons, no progress bars except the 3px bar under a planning message.
8. **Five minutes.** A stranger with an invite gets from email to first render in five minutes without opening Rig, Settings or reading a paragraph.
9. **Two first-class surfaces.** Desktop is where work is made (Canvas building, Shots grid, review at speed, bulk actions); mobile is where it is judged and run (approve, Atomik checkpoints, Rig read-and-run, Make). Mobile is the same routes responsive, never a separate app inside the app. Playwright at 360×640, 390×844, 844×390, 1440×900, 1920×1080 on every change. Nothing under 11px desktop / 12px mobile; all mobile targets ≥ 44pt.
10. **Small PRs**, one concern each, in §6 order. Delete the old route when the replacement lands.
11. **Prose in the product is a cost.** Where a paragraph explains what the UI should make obvious, fix the UI and cut the paragraph.

---

## 4. Design system — non-negotiables

Exact values in README §2–3. What must not drift:

- **Tokens.** Ground `#0B0D11`, card `#12141A`, card-raised `#171A21`, ink `#F5F6F8`, ink-body `#B4B7BE` (never lower for prose), ink-muted `#8A8E96` (labels only), borders as ink alpha `.06 / .08 / .12–.14 / .22–.30`, selected `.12`, accent `oklch(75% 0.12 200)`, on-primary-cost `#4A4E56`. Placeholder and waveform stripes as specified. No shadows except a dragged object; the only ring is the 3px selected-node ring. No gradients other than stripes. No motion beyond Atomik's dot states.
- **Type.** Outfit 400/500/600 for everything readable; Kode Mono 500 11px uppercase 0.12em for eyebrows, IDs, costs, states, engine names, timestamps.
- **Primitives, built once in `components/ui/`:** shell header (56px), production header (64px, breadcrumb + format + stepper + spent-of-cap bar + need-you pill), segmented control, pill chip, primary and secondary buttons, state dot (7–9px, six states), media card with `PLAN | RENDERS` split footer, right rail (`#0F1116`), mobile sheet, **Loader** and **Ring** in `components/atomik/`.
- **Ring** (`Ring.tsx`) renders the 8-dot mark from data — `steps[]` or `mode` — at 14 / 18–20 / 36 / 64 / 88. **Loader** is the same ring in planning pulse at 88 / 36 / 20 / 14, ink on dark, ground inside a filled primary, never accent, nothing shown under 300ms. When step count is known, use Ring's determinate states instead.
- **Marks.** `particl-mark-*.svg` is the 7-dot trail (header). `atomik-ring-*.svg` is the static 8-dot fallback; render live from `Ring.tsx`. Both carry C2PA manifests — preserve them.
- **Mobile primitives** (mobile README, "What changes on mobile"): **dock** 52–56px + `env(safe-area-inset-bottom)` (the mocks use 22px; ship the env value), 22px line icons over 12px Kode Mono labels, active ink / inactive `#8A8E96`; **header** 52px with a 44px back link; **sheet** `#0F1116`, radius 24 top, 1px `.14` top border, 36×4 grabber, scrim `rgba(5,6,8,.55)` tap-to-close, × 34px, body scrolls, primary pinned with 26px safe-area padding, body scroll locked while open — every right rail becomes this; **pinned primary block** above the dock, 50–52px, radius 14, cost in `#4A4E56`, outlined while any sheet is open or the action is blocked, and every scroll container pads its bottom by the block's height + 10px; **segmented controls** fill the width (40px options in a 44px control); **filter and index pills** scroll horizontally and bleed to the edge (`margin:0 -16px; padding:0 16px`); **grids** are 2-up with the desktop card anatomy and the split footer written short (`4S · 19 CR` / `2 TK · 38 CR`); **strips** are `scroll-snap-type:x mandatory` with 8px gaps.

---

## 5. Data model

README §15 names are authoritative. Tenancy, ledger and provenance fields from the platform are added, not renamed.

```
workspace   { id, name, tier, credits, rateUsd: 0.10, multiplier, internal, engines[], roles[],
              storageQuotaBytes, concurrencyLimit, grantUsed }
engine      { id, name, does, rate, unit, connected, atomikMayPropose, multiplier }
production  { id, workspaceId, name, client, status, cap, spent }
project     { id, productionId, name, format, runtimeSecs, step, cap, spent, needYou }
shot        { id, projectId, order, desc, cast[], setup{size,angle,move,lens,lighting,hour,look,
              technique,mood,motion,sound,titles}, plannedSecs, state, slots[] }
take        { id, shotId, projectId, kind: video|still|audio|master, version, state, credits,
              engineCostUsd, model, by, url, madeFrom, createdAt }
asset       { id, workspaceId, productionId?, name, kind, locked, lockedBy, lockedAt,
              attributes[], plates[], views[], usedBy[], createdFrom{shotId,takeId}? }
attribute   { id, assetId, kind, versions[], currentVersionId, trained }
version     { id, label, thumbUrl, createdAt, usedByShotIds[] }
binding     { shotId, slot, assetId, attributeId, versionId, overridden }
board       { id, projectId, nodes[], wires[] }          recipe = board saved with stages[]
node        { id, kind, x, y, ports[], inputs[], output, settings, state, credits, staleSince }
wire        { from:{nodeId,portId}, to:{nodeId,slotId}, kind: inherited|override|filed|created }
run         { id, recipeId, projectId, steps[{n,name,engineId,credits,state,outputs[]}], spent,
              checkpointAt, planningCredits }
atomik      { state: closed|compact|expanded, context:{productionId,projectId,runId|shotId}, thread[] }
quote       { unitCredits, units, totalCredits }          resolved before any spending button enables
ledger      { jobId, workspaceId, projectId, shotId, engine, model, engineCostUsd, billedCredits,
              multiplierApplied, includedOrPurchased, duration, status, at }
```

**Three rules that make the model hold:**
- **Port identity is `assetId:attributeId:versionId`.** That triple is what a wire carries and what `madeFrom` records.
- **The image is the interchange format.** Trained weights never cross models; pixels do. A `version` is always a rendered still (or audio clip), never a pointer to weights. Assets are trained wherever training is best, rendered to canonical stills, and those stills are what every engine receives. Nano Banana Pro is the standing bridge for placing a trained face into new scenes zero-shot. Bound versions are immutable; face-similarity QA runs on every take.
- **Referenced, never copied.** An asset is one record with one id. It appears in Library, in `@Name` autocomplete, as a Canvas node, in a shot's slots and on every take's Made-from — by reference. Any surface that copies asset data is a bug. **Versions are additive:** a new version never alters an existing take; the swap is what costs.

**Carried from the nodegraph handoff, still valid:** the four-layer Setup inheritance (platform → workspace → project → shot, each row showing its source); elements created from takes; locks re-asserted at every stage.

---

## 6. Delivery plan — two tracks, one order

**Track A — platform** (invisible, load-bearing). **Track B — the v2 UI** in README §0 order. They interleave; the dependencies are the point.

| # | Work | Track | Depends on |
|---|---|---|---|
| 1 | Tokens + primitives (§4). Nothing visible changes. | B | — |
| 2 | **Metering layer + ledger + quote engine.** Every engine call stamped; `quote` resolves before any spending button enables; peak concurrency per engine sampled per minute. Multiplier per workspace then per engine; `internal` flag. | A | — |
| 3 | Tenancy hardening: `workspace_id` everywhere, Blob prefixing, signed URLs, fair-share queue (per-workspace slots in the global pool), kill switch per engine and per workspace. | A | 2 |
| 4 | Shell, account menu, Atomik header button (§7.1). | B | 1 |
| 5 | Atomik rail closed / compact / expanded (§7.2, §8) — plan messages only, no execution yet. | B | 4, LLM adapter |
| 6 | Engine adapters behind one interface: ModelArk, Google, ElevenLabs, **fal** (Kling 3.0, Kling Motion, Topaz, Soul ID, Flux), **Vercel** (LLM). Per-engine prompt compiler. `FAL_KEY` wired. | A | 2 |
| 7 | Productions → Projects → Media (§7.3) + production header. Migration: current `project` becomes `production`; each gets one default `project`; media re-parented. | B | 1, 3 |
| 8 | Shots grid + filmstrip + right-click / drag / drop (§7.4). | B | 7 |
| 9 | Credits, tiers, packs, top-up, statements, invite flow with one-time grant, platform admin console (§7.13). | A | 2, 3 |
| 10 | Rig · Canvas (§7.6); Rig · Recipes; Rig · Run + checkpoint (§7.7). Atomik run-with-checkpoints turns on here. | B | 5, 6, 8 |
| 11 | Make (§7.8) and the one composer; Library (§7.9). | B | 6, 7 |
| 12 | New asset sheet (§7.10) with priced training (Soul ID / Flux on fal). | B | 6, 11 |
| 13 | Boards pipeline (§7.5): panel generation, iteration, continuity check, promote to keyframe, animatic. | B | 6, 8 |
| 14 | Post tools on approved takes: reframe, Topaz upscale, Kling Motion, extend, outpaint / background removal. Outputs are takes. | A/B | 6, 10 |
| 15 | Approve (§7.5) compare view, one thread per shot, send-back; Media tab exports, review link, statements. | B | 8, 9 |
| 16 | Settings (§7.11); Usage (§7.12). | B | 9 |
| 17 | Mobile M1–M10 (§7.14) as responsive variants of rows 4–12, plus Approve responsive; push service. Do not ship a desktop route without its < 768px variant from this row onward. | B/A | 5, 15 |
| 18 | Atomik connectors, import (CLAUDE.md / skills / ChatGPT memory → workspace rules and recipes), scheduled runs. | A/B | 10 |
| 19 | Desktop depth: ⌘K palette, resizable persisted panes, review player with A/B wipe and pop-out, bulk actions, virtualised lists at 2,000 takes. | B | 15 |
| 20 | Native: Mac via Tauri (dock badge, menus, multi-window), then iOS via Capacitor (push, camera, share, no in-app purchases). | B | 17, 19 |

Two things may jump the queue because everything after them gets easier: the ⌘K palette and persisted panes.

---

## 7. Surfaces

Each entry: what it is, the rules it enforces, acceptance. Geometry and copy in the README section cited.

### 7.1 Shell and account menu — README §4
Four nav items. Balance mono readout. Atomik pill with the ring at 14px in its live state and a mono suffix (`CHECKPOINT · ⌘J`). Account menu: name + `ROLE · WORKSPACE`, **Usage** with month-to-date, **Settings** `⌘,`, Switch workspace, Sign out. **Acceptance:** Usage and Settings reachable only from the menu; balance visible on every route; the Atomik button reflects run state without opening the rail.

### 7.2 Atomik rail — README §5
State at app level, persisted per user: `closed | compact | expanded`; `⌘J` toggles closed ↔ last open; `Esc` closes. **Nothing of Atomik renders when closed — remove the left Rig strip.** Compact 300px shows one card (checkpoint, question, plan summary, receipt) with one filled button and a secondary pair; expanded 420px adds the conversation and the plan card with a `CHECKPOINT · YOU ARE HERE` row, and a pinned footer with the totals line (`95 CR TOTAL · 77 UNDER CAP · PLANNING 3 CR`) — planning credits are always their own item. The page grid reflows 5 → 4 → 3 columns; the page's primary drops to outlined. Four message types: **Plan**, **Checkpoint**, **Question**, **Done**. **Acceptance:** rail works on every route before any page ships; grid reflow is measurable; primary outlines while open.

### 7.3 Productions, and Project › Media — README §6
`/productions`: page header with mono totals, `Active · Delivered · All`, `New project in…`, `New production`. Production rows with `N PROJECTS`, need-you pill, spent-of-cap bar, `Rig · assets` pill, and a 5-column grid of project tiles (16:7 well with `N MEDIA`, stepper dots + step name, spent / cap + bar, dashed `+ Project`).
`/productions/[prod]/[project]/media`: sub-tabs `Shots · Boards · Approve · Media`; kind pills with counts; `BY SHOT`; primary `Download N masters · 0 CR`; one group per shot; 6-column media cards with kind chip, waveform for audio, `↓ 1080P` accent chip on masters. **Deliver lives here:** masters zip named `{production}_{shot}_{version}`, CSV shotlist, EDL/XML, and the **client review link** (tokenised, expiring, revocable, workspace-branded, comments write back to the shot thread). **Acceptance:** media survives shot deletion; moving a shot moves its media and its cost; masters download from Blob via signed URLs, never through a function.

### 7.4 Shots grid — README §7
`/productions/[prod]/[project]/shots`. `Grid | Filmstrip`, mono stats, `+ Shot`, primary `Render SH08–09 · 38 CR`. Media cards with `SH04` + position, state chip, `V2 ↓` accent master chip, `NO TAKE YET` / `TYPE ONLY` wells, 2-line description, `@Name` pills, `size · move · lens`, split footer `PLAN 4S · 19 CR | RENDERS 2 TAKES · 38 CR`. Filmstrip: player of approved takes in order, strip widths ∝ planned seconds, sequence list. **Interactions (all live in the reference):** context menu (Copy, Paste after, Rename, Open in Rig, Move to production ▸ with `TAKES GO TOO`, Delete with footnote), paste copies planning only (new ID, no takes, 0 cr), delete offers Undo, drag to reorder with a 3px insertion edge, drop on a production chip to move, double-click to rename, every action narrated in a bottom toast. Below 768px: 2-up cards, a 50px `+` square beside the primary, **long-press** opens the same context menu as a sheet (the move submenu is a second sheet), drag reorders. **Acceptance:** all seven interactions pass at 1440×900 and their touch equivalents at 390×844; type-only shots never render and never cost.

### 7.5 Boards and Approve — sub-tabs of a project
**Boards** (the pipeline): the board is the cheap draft of the shot and an approved panel becomes the keyframe. Every shot generates 2–3 panels from its description, Setup and cast on the standard stills engine, priced per scene before it runs; auto-pick by face similarity, alternates shown; iterate by nudge chips (tighter, wider, other side, different hour), re-roll, or replace with a reference; a continuity check flags crossing-the-line between consecutive shots; **Promote to keyframe** writes the shot's `KEYFRAME` binding and `madeFrom`. If a take is approved and the board no longer matches, the board updates from the take. **Animatic:** panels held for planned seconds, scratch VO from ElevenLabs, music bed, scrub bar, MP4 export. The review link can point at panels so a client approves the board before a credit is spent on video.
**Approve:** queue on the left (`N need you`), compare on the right — two to four sibling takes, synced playhead, A/B wipe for two; **one comment thread per shot**, entries tagged by take and timecode (this is the only note type in the product); Pick / Approve / Send back (send-back returns the shot to draft with the note attached, logged in the shot's history and in Usage). An approved shot is locked; rendering against it asks for a reason. **Acceptance:** boards ship after the stills engine is metered and don't wait for Rig; the animatic needs ElevenLabs; a panel at 1 cr and a take at 19 cr are both priced on their buttons.

### 7.6 Rig · Canvas — README §8
`/rig/canvas/[boardId]`. Sub-tabs `Canvas · Recipes · Run`; board chip; mono `N NODES · N RUN · N CR SPENT · BUILDING IS FREE`; collaborator avatars with live cursors; `Share`; `Save as recipe`. Dotted board + 300px inspector; floating `+ Add node ⌘K` listing node kinds. **Node kinds:** Asset (one 32px tile per port — `FACE v3`, `HAIR v1`, `WARDROBE v2`, `VOICE v1` — output dot per port, bundle port on a character's header), Shot (slot rows `CHARACTER · PROP · BACKGROUND · LOOK · PROMPT` with input dots, `SPEC` output, dashed `TAKES` input), Prompt (`FREE`), Generate Image / Video (outputs live *inside* the node; footer button with cost), Edit, Upscale, Audio, Voice, Compare, Note. Wires are cubic beziers output-dot → input-dot, four kinds by stroke (inherited, override, filed, created), **and a wire lands on a slot, not a node.** Inspector shows node, inputs, settings pills, output card, primary `Run node again · 19 CR`, footnote `FILES AS SH04 v5 · v4 STAYS`. **Rules:** building is free; a node prices itself before it runs; **changing anything upstream marks downstream nodes stale and never auto-reruns**; an output files to a shot as the next version; `Save as recipe` turns the board into a Recipe. **Changing a bound version** in the slot inspector reveals **Before you change this** — dependents as `7 shots · 3 approved · 4 draft` with a split bar and three priced subsets (all / approved only / leave existing) — and the apply button carries the chosen subset's price (`Apply v3 to approved · 57 CR`; outlined `Bound to v2 · PICK ANOTHER VERSION` otherwise). Stale marking and Before-you-change-this are the same quote engine from two entry points. **Acceptance:** wire endpoints hit slot dots within ±2px; outputs render in their node; filing writes a take to the shot; stale propagates on every upstream change.

### 7.7 Rig · Recipes and Rig · Run — README §9
**Recipes:** a board saved with `stages[]` — each stage an engine, a scope and a price — named, reusable across projects, shareable in the workspace, seeded at platform level, forkable. **Run** `/rig/run/[runId]`: sub-bar with `Production › Project · Run 02`, `RECIPE · … · 3 OF 8 STEPS`, `19 of 253 cr` bar. **Pinned checkpoint card** with the ring at 64px in checkpoint state, eyebrow `ATOMIK · CHECKPOINT · STOPPED BEFORE STEP 04`, the headline, one paragraph, `PLANNING · 3 CR · <model>`, primary `Continue · keyframes · 24 CR`, `Change engine` / `Stop here`. **Stage track:** 8 equal cards with number, name, state dot, result area, mono state, engine + cost; the checkpoint stage carries the selection ring. Below: **What just finished** (Atomik's picks, changeable) and **What's next**. A failed stage renders `NEEDS YOU` and expands in place with 2–3 priced fixes; **the run never restarts.** Caps and the approval rule apply to the run total. **Acceptance:** a run resumes from any failed stage; whole-run price shown before step 1; every stage names its engine.

### 7.8 Make and the one composer — README §10
`/make/video` (+ images, audio). Segmented `Video · Images · Audio`, mono `UNFILED · 9 TAKES · 117 CR · NOTHING REQUIRED`, search. Unfiled wall grouped by day; cards with `File to shot` / `Again`; empty state links to the demo production. **The one composer** (400px rail): prompt with `@Name` highlights, reference well, **model chip** with its one-line "what it's for" and rate that expands into the model list, pills `16:9 · 5s · ×1 · 1080P · Audio`, Setup rows (`NONE CARRIED · UNFILED` + `+ Row`), Cast chips, primary `Render · 19 CR · 5S · 1080P`, footnote. Images swaps duration for resolution and adds Loose / Exact; Audio becomes script, voice picker with sample play, language, duration. On touch the model list is a sheet, not a dropdown; the estimate is debounced; opening it commits no long task over 50ms. Below 768px the composer **docks** as a card above the pinned primary (eyebrow `COMPOSER · SEEDANCE 2.5 · 16:9 · 5S`, first prompt line, ↑) and tapping it opens the full composer as a sheet (M9); a take still rendering shows the 36px ring in its well. **Identical component everywhere the composer appears.** An unknown `@name` in a prompt opens the inline New-asset card (README board 3b) and Render stays outlined until the asset exists. **Acceptance:** one composer component; unfiled takes appear in Library › Unfiled by reference.

### 7.9 Library — README §11
`/library`. Segmented `Assets · References · Unfiled`; filters `Kind · Production · Locked`; search; primary `New asset · 0 CR`. Assets grid (3 columns, 4:3 canonical still, kind / lock / version chips, name, `ports · where-used`, locked on card-raised) and the References board (dotted, loose; selecting shows `Promote to asset · 0 CR`, `Use in Make`, `Add to Canvas`). **Library indexes; it never stores a second copy.** **Acceptance:** an asset created anywhere appears here without a write; where-used counts match bindings.

### 7.10 New asset sheet — README §12
760px modal from any screen with a `FROM <where it opened>` chip. Name + Kind chips; references well (Upload · A take · Make · Canvas); **What particl reads from these** — one tile per derived port marked `READY / LATER / OPTIONAL` (character: FACE, HAIR, WARDROBE, VOICE; prop: HERO, DETAIL, TURNTABLE; location: plates by hour; look: LOOK, GRAIN; voice: VOICE, LANGUAGE); a priced **train switch** (`Train the face now · 12 CR`, `Make a turntable now · 4 CR`, `Fill the missing hour · 2 CR`, `Apply to existing keyframes · 5 CR`, `Train the voice now · 8 CR`); footer consequence line, `Cancel`, primary `Create Iver · 12 CR` (or `0 CR` with the switch off). **Rules:** creating is free, learning costs; attributes are read from references, never typed; trained identities are workspace-scoped and never shared; the uploader confirms the right to train on that face and the confirmation is stored with the asset. Opens from Rig, a take (Promote), a Canvas selection, an unknown `@name`, and Atomik. **Acceptance:** 0 cr with the switch off; training runs async and shows in the run/queue; the same sheet from all five entry points.

### 7.11 Settings — README §13
`/settings`: 240px sticky index + card sections — **Workspace & credits** (balance, auto top-up, month-to-date, primary `Top up · 500 CR · $50` — the only place USD appears), **Team & roles** (Director, Producer, Artist, Editor, Admin; invite by email, pending invites visible; **no seat fees**), **Engines & rates** (per engine: status dot, what it does, rate from the registry, `ATOMIK MAY PROPOSE` switch), **Production defaults** (cap, warn at %, at the cap, who approves, who renders), **Atomik** (checkpoint rule, may create assets → propose only, planning model + rate, `NEVER WITHOUT YOU · SPEND · UNLOCK · DELETE · APPROVE`), **Rig & locks**, **Storage & masters** (naming convention, keep every take, quota), **Notifications**, **Account** (terms, privacy, retention, export workspace, delete workspace). Changes save on change. **Acceptance:** rates are never editable here; the engine list equals the adapter registry.

### 7.12 Usage
From the account menu. The headline is **which shot is taking the most takes**, per project; then by production, by person, by engine, by period; cap burn-down per project (spent / cap, projected finish from takes-per-shot so far); workspace balance and burn rate; send-backs as their own column; statements per workspace / month / project itemised in credits with one USD line for the pack, downloadable. Included and purchased credits shown separately.

### 7.13 Platform admin console — not in the README; platform-role gated route
Invite queue (approve → expiring code), workspace list with spend / balance / margin, `internal` flag, engine health and error rates, per-workspace suspend, content-policy flags, grant budget, vendor rate-limit alerts at 70%, and the platform-layer editor (default Setup, rules, recipes, default caps). Internal workspaces excluded from margin reporting.

### 7.14 Mobile — mobile README, boards M1–M10
Below 768px. Ten boards map one-to-one onto desktop routes:

| Board | Route | What changes |
|---|---|---|
| M1 Productions | `/productions` | Production rows stack; project tiles are 200px snap cards with `+ Project` at the end. |
| M2 Project › Media | `…/media` | Sticky header block (title, format, spent-of-cap 110px bar, current step only, need-you, sub-tabs); kind pills scroll; media 2-up per shot group; `Download N masters · 0 CR` pinned. |
| M3 Shots + Atomik sheet | `…/shots` | 2-up cards; long-press context menu as a sheet; drag reorder; Atomik sheet from the header button. |
| M4 Make · Video | `/make/video` | Segmented Video · Images · Audio; wall 2-up grouped by day; ring loader in a rendering well; **docked composer** above the pinned primary. |
| M5 Rig · Canvas | `/rig/canvas/[boardId]` | **Read-and-run.** The desktop board rendered as a vertical stack down one wire; tap a slot → inspector sheet with version cards and Before-you-change-this; no wire dragging; `Run node again · 19 CR` pinned under `BUILT ON DESKTOP · RUN AND FILE FROM HERE`. |
| M6 Rig · Run | `/rig/run/[runId]` | Checkpoint card first (ring 48), then the eight steps as rows with 72px thumbs; the checkpoint row carries the selection ring; Continue / Change engine / Stop here pinned. |
| M7 Library | `/library` | Segmented lenses; filter pills; 2-up asset cards; `New asset · 0 CR` pinned. |
| M8 New asset | modal | Full-height sheet from 44px; kind change swaps the derived-port tiles and the train switch's label and price. |
| M9 Composer sheet | from M4 | The one composer as a sheet, including the inline `NOT AN ASSET YET · @IVER` card; Render outlined until the asset exists. |
| M10 Settings | `/settings` | `‹ Back` header, index pills that scroll and anchor, credits card first. |

**Atomik sheet:** compact at 58% height — context line, one card (checkpoint headline, one sentence, `Continue · 24 CR` 52px, `Change engine` / `Stop here` 44px, `19 OF 253 CR · PLANNING 3 CR`), ask field; Expand ↑ to 92% adds the conversation and the plan card above the same checkpoint card; Compact ↓ returns; × closes. Opens from the header button on every screen.

**Approve on mobile** is not among M1–M10; build it as the responsive variant of the desktop Approve tab — queue then compare, two takes stacked, one playhead, swipe between siblings, Pick / Approve / Send back pinned, the shot's thread below — using the sheet and pinned-primary chrome above.

**Push:** take finished, cap at 80%, approval needed, balance low, checkpoint reached. **Acceptance (< 768px):** dock present on Make, Productions, Rig, Library and hidden inside sheets and the New asset sheet; Atomik opens compact, expands, compacts, closes, and the page primary outlines while open; every scroll container's last row is fully visible above its pinned block at max scroll; long-press opens the context menu sheet and drag reorders; slot tap opens the inspector sheet and a version change reveals the priced subsets and updates the apply button; kind change in New asset swaps tiles and the switch; the Phase 0 suite stays green (no overflow, no input under 16px, dock and sheets clear of the safe area).

---

## 8. Atomik — the production agent

The counterpart to Higgsfield Supercomputer, on a shot model. It plans, it prices, it runs with checkpoints, and it never spends without you.

**What it does, in order of trust**
1. **Plan.** From a brief, a logline, or "make a 30-second TVC for this handbag," Atomik proposes a recipe: shots, cast, engine per stage, and the full credit estimate per stage. Nothing runs. The Plan message ends with `Run to first checkpoint · N CR`.
2. **Run with checkpoints.** Every paid stage is a checkpoint by default: what finished, credits spent, what's next, its price, `Continue / Change engine / Stop`. A workspace loosens this per recipe in Settings ("auto-run boards, stop before video") — never per chat message. Caps and the approval rule apply to the run total.
3. **Ask, don't decide.** A **Question** is a decision with 2–3 priced options. Atomik never decides anything that spends, unlocks, deletes or approves. It picks takes; a person approves them.
4. **Route transparently.** Every stage names its engine; every planning message names its LLM and its cost (`PLANNING · 3 CR · <model>`). No hidden modes.
5. **Remember from data, not a notebook.** Memory is the workspace's rules, assets, Setup and recipes. Anything worth keeping becomes a workspace rule the user can see and switch off. No private state.
6. **Connect.** Briefs from Drive or Notion, references from Figma, delivery to Slack, Drive or a review link, using the tokens already in Settings. Every connector action is a checkpoint.
7. **Repeat.** Recipes are Atomik's skills. "Do last week's product-shot recipe on these six SKUs" is one message. Scheduled runs later.
8. **Import.** A CLAUDE.md, a skills folder or an exported ChatGPT memory becomes proposed workspace rules and recipes, shown for review before saving.

**Cost discipline.** Text credits are spent on planning and interpreting checkpoints only; execution runs recipes, which are deterministic and cost no tokens. Planning credits are metered and always shown as their own line. Target under 5% of a run's total; flag above 10%. Use structured output for the shot builder so Setup rows land as fields; prompt-cache the rule library and workspace Setup.

**Boundaries in Settings → Atomik:** checkpoint rule; may create assets → **propose only**; planning model and its rate; and the standing line `NEVER WITHOUT YOU · SPEND · UNLOCK · DELETE · APPROVE`. Per engine, `ATOMIK MAY PROPOSE` decides what it is allowed to put in a plan. Same content policy and workspace scoping as every other surface; never calls an engine outside the metering layer.

**Build:** rail and Plan messages first (needs the LLM adapter and the quote engine); run-with-checkpoints when Rig · Run ships; connectors, import and scheduling last.

---

## 9. Platform features carried forward

**Post tools on an approved take** (in order): Reframe (content-aware, new take, versioned) · Upscale via Topaz on fal · Motion control via Kling 3.0 Motion (a cast still or approved frame plus a reference video) · Extend / last-frame continuation · outpaint and background removal for stills. Each is a Canvas node kind and a button on the take; each prices itself before it runs; each output files as a take under the same shot.

**Identities.** Soul ID / Flux character on fal, end to end: references → train (priced, async, in the run/queue) → asset attribute `trained: true`. `@Name` resolves to the trained model for stills and to the canonical still for video. Workspace-scoped; consent stored.

**Queue.** Fair-share per workspace inside the global pool; per-workspace rate limits; concurrency shown against the limit; failed jobs say why (engine refused, engine error, cap hit, balance zero) and offer the right action (retry, edit, ask an admin, top up). Kill switch per engine and per workspace. Vendor spend alerts.

**Onboarding.** Request an invite → admin queue → expiring code → account → create or join a workspace → seeded with platform Setup, rules, recipes and the demo production → one-time grant (~50 cr) → first render. Timed against rule 8.

**Prompt compiler and rule library.** Setup rows are engine-neutral; the compiler renders each engine's dialect. Platform rules (one move per shot; niche terms as term + what happens; only subtitles and audio take a NO; time of day and lighting are separate rows; no all-caps headers in image prompts and always a no-lettering line; after two failed relative edits on Nano Banana offer a fresh regenerate; Kling for water, cloth and physics) plus workspace rules in plain sentences, each showing its source and switchable.

**Desktop depth** (after the surfaces ship): three breakpoints with resizable persisted panes; ⌘K command palette; review player with A/B wipe, filmstrip, timecoded notes and a pop-out window for a reference display; multi-select with a priced selection bar and bulk approve / send back / file / download; drag references into the composer, folders into Library, takes onto shots, plates onto slots; remembered download folder; virtualised lists — 2,000 takes at 60fps, first paint under 1.5s cold; masters tagged with colour space and delivery spec on the card.

**Native.** Mac first, via Tauri around the live URL: native menus carrying every shortcut, dock badge for running jobs and checkpoints, deep links, multi-window, background master downloads, signed and notarised `.dmg`. iOS via Capacitor pointing at the live site, with push, camera, share, filesystem, haptics; **nothing sold in the app** — credits are bought on the web by the workspace owner; a demo account with a seeded workspace for review.

**Hosting.** Vercel Pro. Engines are fire-and-poll, never awaited in a function; masters and platform assets in Blob behind signed URLs, never through main bandwidth; previews on Standard build machines with cancel-previous. Alerts at 80% of Blob egress, build minutes and Active CPU. Enterprise only when a customer's procurement requires an SLA.

---

## 10. Acceptance

**From README §16, verbatim in spirit:**
- Four nav items; Usage/Settings only in the account menu; balance always visible.
- Atomik renders nothing when closed; opens compact on click / ⌘J; expands; the grid behind reflows; page primary outlines while open.
- Exactly one filled primary per screen, cost inline, quoted before enable.
- Accent colour appears only on approved / done / running / checkpoint.
- Shots: grid + filmstrip, right-click menu, drag reorder, drop-to-move, inline rename, delete with undo, toast narration.
- Canvas: wires land on slot dots (±2px), outputs live in their node, filing writes a take to the shot.
- Media stays with its project on shot delete and moves with a shot.
- New asset: one sheet, derived-attribute preview, priced train switch, 0 cr without it.
- Nothing under 11px desktop / 12px mobile; all mobile targets ≥ 44pt.
- The only loading indicator anywhere is the Atomik ring loader.
- Below 768px, the six mobile acceptance items in §7.14.

**Platform:**
- No engine call outside the metering layer — a test asserts every adapter path stamps the ledger.
- `workspace_id` on every table; a cross-tenant read test fails loudly.
- `quote` resolves before any spending button enables; the button's cost equals the ledger's billed credits after the job.
- Internal workspaces bill at 1.0× and are excluded from margin reporting.
- Runs resume from any failed stage; no code path restarts a run.
- Playwright at the five viewports on every route: no horizontal overflow, no input under 16px, dock and sheets clear of safe-area insets, composer sheet's Close and primary in-viewport.
- Every asset surface reads by id; a duplicate-copy test on assets fails.

---

## 11. How to work

1. Confirm or correct §2 and §5 against the code before changing anything: where keys live, whether `workspace_id` is on every table, whether the metering layer exists and **which call paths bypass it**, and how the current `project` maps onto Productions › Projects. Report back.
2. Propose the migration to Productions › Projects › Media as two or three structures with what breaks; argue against the preferred one. Wait.
3. Then §6 in order, one PR per row. Each PR states what it costs a workspace to use, how engines are mocked, what changed in the compiler, where the code is workspace-scoped, and which old route it deleted.
4. After any schema-touching PR, diff the data model against §5 and update this document.
5. Any task that would spend real money on an engine: stop and ask.
6. When the README and the code disagree on a pixel, the README wins. When this SOW and the code disagree on scope, ask.

---

## 14. Phase 6 — The Crew

The reference is invideo's Agent Two: a crew of specialised agents — creative director, DOP, storyboard artist, casting, costume, production designer — each working independently while communicating with the rest, run in parallel, against a persistent production memory (Context), governed by standing rules (Playbooks), with hands-on control per generation (Notebooks), three intelligence tiers, and an always-ask mode that surfaces prompt and references before credits spend. It reads everything uploaded — scripts, PDFs, rough cuts — against Context, and a project five seasons deep can reach back to episode one.

particl's version is built on what already exists — **Atomik is the AD**, the production's Context is the data model (Brief, shots, assets, Setup, rules, recipes, takes, Made-from), and every crew member is an Atomik role with a department it owns. Nothing here is a second agent system; it is Atomik with a call sheet.

### 14.1 How the Crew works

- **Atomik is the AD and the context spine.** The AD reads the whole production, dispatches to crew members, sequences their work (shots before boards before takes), consolidates their proposals into one plan, and holds the checkpoints. A creator can talk only to the AD and never meet the crew — or open any crew member directly.
- **A crew member is a role with a department scope.** Each has: what it **owns** (the asset kinds and surfaces it may write to), its **skills** (the actions below), its **playbook** (standing rules for that role, in plain sentences, inherited from platform → workspace → production), its **tier** (planning model from the Vercel registry — Lite, Pro, Ultra mapped to concrete models and rates), its **checkpoint rule** (always-ask by default), and its own **thread** in the Atomik rail.
- **They communicate through Context, not through each other's chats.** A crew member reads the production and writes proposals into it (a casting proposal, a coverage set, a continuity flag). Other members see those the moment they land. No private state; anything a member learns becomes a rule the creator can see and switch off.
- **Parallel work.** Several members run at once — a DOP per scene, Casting and Art before a frame exists — bounded by the workspace's concurrency and the production's cap. The **call sheet** (§14.4) shows who is doing what and what it has cost.
- **Maker–checker.** Every department's output passes the Script Supervisor before it reaches a person: continuity, screen direction, wardrobe, props, time of day, cap. The Supervisor never approves; it flags. The creator approves.
- **Always-ask is the default.** Each paid action surfaces the compiled prompt, the references, the engine and the price before it runs; a member's rule can loosen this per skill (`auto-run boards, ask before video`). Never per message.
- **Uploads become Context.** A script (Fountain, PDF, Docx), a pitch deck, a rough cut, a reference film, a brand guide, links — parsed by the relevant member and filed: scenes and shots to Brief, characters to Library, visual rules to the playbook, a rough cut to Editorial's timeline. The upload is read against what the production already knows.
- **Memory across productions.** A workspace's crew remembers its cast, locations, looks, camera packages and rules across productions; a sequel starts with season one's Library and playbooks intact. Retrieval is by reference to versioned assets, never by re-uploading.
- **Multiplayer.** Live cursors already exist on Canvas; presence extends to threads and the call sheet so a director, a writer and an editor work in one room.
- **Cost discipline stays.** Crew planning credits are metered per member and shown on the call sheet; execution runs recipes. Target under 5% of a run's total on planning across the whole crew.

### 14.2 The roster

Each member: **Owns** · **Skills** · **Reads / writes** · **Checkpoint default** · **Accept**. Skills are the features from the creator's-studio list; every one of them lives here.

**AD — Atomik**
Owns the plan, the run and the call sheet. Skills: *Script in, shots out* (Fountain / PDF / Docx → scenes, shots, dialogue lines, cast tagged, Setup drafted per shot); dispatch and consolidation; *Overnight batch* (queue a night's renders under a cap and wake up to picks); checkpoints; receipts. Reads everything; writes Brief, Shots, runs. Checkpoint: every paid step. **Accept:** a script import produces a shot list with every line assigned to a character and a per-scene quote before anything renders.

**Writer**
Owns Brief and dialogue. Skills: structure notes (acts, scenes, beats); *Three reads* — every dialogue line generated at three deliveries (pace, emotion) to pick from; *Table read* — the cast reads the script in their own voices as a radio-play animatic before a frame is rendered; *Pitch deck* — treatment, boards and key art as a PDF a creator sends a brand or a financier. Reads Brief, cast; writes Brief, dialogue variants, decks. Checkpoint: before VO spend. **Accept:** a table read plays end to end with per-character voices; a pitch deck exports with the workspace's branding.

**Casting**
Owns characters and voices in Library. Skills: *Casting call* — six faces from a description with a one-line audition tape each, pick one and it becomes the character; *Character maker* — canonical set (front, three-quarter, profile, full-length) and trained identity; *Performance sheet* — expressions and emotional range pre-authored per character so takes draw from a consistent face; *Voice casting* — clones and reads; *Extras* — background people under rules, never a recognisable face. Reads Brief; writes characters, versions, performance sheets. Checkpoint: before training. **Accept:** a casting call yields six candidates for one quote; the chosen one appears in Library with four canonical versions and a performance sheet.

**Wardrobe**
Owns wardrobe and hair ports. Skills: outfit and hair variants per scene as versions; *Wardrobe continuity* — a tracker of which version dresses which scene, enforced by the compiler across every cut. Reads Brief, scenes, characters; writes versions, bindings per scene. Checkpoint: before generating a variant set. **Accept:** changing a scene's outfit rebinds every shot in that scene and no other; the Supervisor flags any shot bound to the wrong version.

**Production designer**
Owns locations, props and looks. Skills: *Location scout* — four options from a description, plates auto-generated for the hours the shot list needs, lock one; set dressing versions per scene; *Props to 3D* — turntable → Meshy / Trellis mesh so a hero prop holds its shape from every angle; looks and grain. Reads Brief, shot list hours; writes locations, plates, props, meshes, looks. Checkpoint: before plates. **Accept:** a scouted location has a plate for every hour in the shot list; a prop mesh renders consistently from four angles.

**DOP**
Owns Setup rows, camera packages and coverage. Skills: *Camera packages* — Alexa + Cooke, 16mm, iPhone — as Looks with lens tables the compiler understands; *Coverage* — from one master shot, generate wide, medium, close, OTS and insert from the same setup with reverse angles that respect the line; *Blocking view* — a top-down floor plan per scene with characters, camera and the line of action, feeding spatial language into the prompt; *Eyeline tool* — who looks at whom per shot. **Several DOPs per production are allowed — one per scene, or two on one scene for two readings.** Reads Brief, blocking, cast; writes Setup per shot, coverage sets, blocking. Checkpoint: before rendering a coverage set. **Accept:** a coverage set from one master lands as five shots with Setup filled and screen direction consistent; a second DOP on the same scene produces a distinct Setup proposal side by side.

**Storyboard artist**
Owns Boards. Skills: panels from shots, iteration by nudge, promote to keyframe, *animatic* with timing and scratch audio; reads Brief, Setup, cast; writes panels, keyframe bindings, animatic. Checkpoint: per scene. **Accept:** as §7.5.

**Performance director**
Owns motion and lip-sync. Skills: *Act it yourself* — a performance recorded on a phone → Kling Motion onto the character; lip-sync to the Writer's chosen read; three reads on video; movement continuity. Reads cast, dialogue, keyframes; writes takes. Checkpoint: before video spend. **Accept:** a phone recording becomes a take on the bound character with Made-from citing the reference clip.

**Sound**
Owns audio. Skills: VO and clones; *Sound design pass* — Foley and ambience per shot from the description, a music brief to licensed generation; stems (dialogue, effects, music) delivered separately; *Loudness to spec* — −23 LUFS broadcast, −14 social on export. Reads shots, dialogue, cut; writes tracks, stems, mixes. Checkpoint: before music generation. **Accept:** every master exports with three stems and passes loudness for its target.

**Editor**
Owns the cut room. Skills: *Cut room* — a timeline of approved takes with trims, cuts on the animatic's timing, three audio layers, titles, per-platform reframe, exporting the finished film; auto-cut from the animatic; versions of the cut with branching (alternate endings); captions (burned or SRT); *Critique pass* — upload or open a cut and get notes on pacing, sound gaps and emotional register, written into the shot threads with timecodes. Reads approved takes, animatic, stems; writes cuts, masters. Checkpoint: before export. **Accept:** a cut exports as a finished film in three aspects with captions; a critique pass writes timecoded notes into the right shots.

**Script supervisor**
Owns continuity. Skills: *Continuity checker* — a vision pass across consecutive shots for props, wardrobe, time of day, screen direction and eyeline; *Coverage checklist* — per scene, beats with no take yet; the checker in every maker–checker pass. Reads everything; writes flags into shot threads and the call sheet. Never generates, never approves. **Accept:** a fixture with a crossed line and a wrong outfit produces two flags on the right shots; nothing reaches Approve without a Supervisor pass.

**Production office**
Owns money and rights. Skills: quote per scene and per production from the shot list before rendering; caps and the approval rule; statements; *Rights ledger* — whose face trained what, consent on file, music licence per bed, exported as a rights report with the masters; QC and deliverables checklist (resolution, loudness, duration, label, C2PA); render order by dependency. Reads ledger, assets, cut; writes quotes, statements, rights reports. Checkpoint: none needed — it never spends. **Accept:** a rights report lists every trained identity and licensed track in the delivered cut.

**Publicist**
Owns the studio door. Skills: *Publish* — YouTube, Instagram, TikTok from Deliver with generated title, description, poster and thumbnail, captions and scheduling; poster and key art; a trailer cut; *Public reel* — a portfolio page per workspace from approved work; *How it was made* — Made-from published as a breakdown. Reads masters, cut, Brief; writes posts, posters, reel, breakdowns. Checkpoint: before anything leaves the workspace. **Accept:** a publish action posts with generated metadata and reports back the URL; the reel updates when a production is delivered.

### 14.3 Playbooks, tiers, always-ask

- **Playbooks** are rules scoped to a role: platform defaults per role (the DOP inherits the one-move-per-shot rule; the Storyboard artist inherits the no-lettering rule), workspace additions ("our DOP always proposes anamorphic first"), production overrides. Editable in Settings → Atomik → Crew, each rule showing its source and switchable.
- **Tiers** map to concrete models and rates from the Vercel registry: **Lite** (fast, cheap — enhancement, checks), **Pro** (default planning), **Ultra** (structure, coverage, critique). Set per role, overridable per task; the tier and its credits are named on every message.
- **Always-ask** per skill per role: `ask · auto-run under N cr · auto-run`. The platform floor: anything over 200 cr always asks; training, publishing and deleting always ask regardless of setting.

### 14.4 The call sheet

A production-level view (a **Crew** tab beside Brief · Shots · Boards · Takes · Approve · Deliver, and a mobile sheet): one row per crew member — role, tier, what it is doing now, what it proposed and is waiting on, credits spent (planning and execution separately), flags raised, and an `Open thread` action. The AD's row is the run's stage track in miniature. A `Hire` button adds a role (a second DOP, an extras coordinator); a `Wrap` button retires one. Presence shows which people are in which thread.

### 14.5 Data

```
crewMember  { id, workspaceId, productionId, role, name, tier, playbookRuleIds[], scope{ owns[], reads[], writes[] },
              checkpointRules{ skill: ask|autoUnderN|auto }, threadId, spentPlanning, spentExecution, active }
proposal    { id, crewMemberId, kind, targets[], payload, quote, state: proposed|accepted|rejected|superseded, by, at }
flag        { id, crewMemberId, shotId, kind: continuity|screenDirection|wardrobe|prop|hour|eyeline|coverage|cap, note, resolved }
callSheet   { productionId, rows[{ crewMemberId, now, waitingOn, flags, spent }] }
```
Proposals are the only way a crew member changes the production; acceptance writes the change and records Made-from. Flags attach to shots and to the call sheet. All workspace-scoped.

### 14.6 Build order
1. Roles as scoped Atomik threads with playbooks and tiers (no new skills yet); the call sheet; proposals and flags.
2. Script supervisor (checks only — it makes every later member safer) and Production office (quotes, rights ledger).
3. Casting, Wardrobe, Production designer — the Library-building roles.
4. DOP (coverage, blocking, packages) and Storyboard artist.
5. Performance director, Sound, Editor (cut room is the largest single item).
6. Writer (table read, pitch deck) and Publicist.
7. Uploads-as-Context, multi-DOP parallelism, memory across productions.

Every role ships on desktop and mobile; on a phone a crew member is a thread and a row on the call sheet, never a canvas.
