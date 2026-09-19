# particl v2 — functionality scope of work (desktop + mobile)

The v2 surfaces exist in the repo. **As of 11 September they are not on production** — every v2 route on particl.app returns the 404 page and the shell is still v1 (see §0.1). This document is everything that has to *work* behind the v2 surfaces once they are live, plus the day-one fixes to what is live now. It is organised by capability, not by screen, because desktop and mobile are the same routes with the same data — **a capability is not done until it works at 1440×900 and at 390×844.** Design questions go to `docs/handoff/v2/README.md` (≥768px) and `docs/handoff/v2-mobile/README.md` (<768px); scope, data, money and sequencing are decided here.

Every capability below is written the same way: **Does** (behaviour) · **Powers** (surfaces, desktop and mobile) · **Data** (tables and fields, from `docs/particl-sow-v2.md` §5) · **Engine** (adapter or service) · **Accept** (what a test asserts).

---

## 0. Ground truth before anything runs

### 0.1 Day one — the production site as audited on 11 September
**Live and correct:** credits on the button (`Generate · 43 cr` — the 1.5× number), batch `× N`, Setup rows with `PLATFORM` source, Usage with by-production / by-person / by-engine / which-shot-most-takes / projected-at-this-rate / CSV, `/all` with state and person filters, Studio with Cast · Setup · Trained identities · Rules, Settings with Credits · Statements · Storage · Defaults & caps · Account, a real 404 page, dark by default.

**Not live:** everything v2 — `/make/*`, `/productions`, `/rig/*`, `/library`, the four-item nav, the dock, the Atomik button, the balance readout, the v2 tokens (`#0B0D11`; production is on `#1D1F24`). **First task: find where v2 is (branch / preview) and promote it, or say why it can't be.**

**Seven copy contradictions to fix on day one, whichever shell is live:**
1. Settings → Credits says the workspace pays vendors directly and there is nothing to top up. Wrong: platform keys, prepaid credits, packs, top-up.
2. Usage exposes vendor ledgers ("what each engine has been paid"). Workspaces see credits, never engine cost — that is the margin.
3. Usage → "Nano Banana Pro · Vercel AI Gateway." Engine strings must read from the registry; delete every hard-coded engine name.
4. Team & roles says everyone is admin or member and everyone approves. Roles are Director · Producer · Artist · Editor · Admin with the §13.1 matrix.
5. Atomik framed as a separate app ("the shot list arrives here", "written back to Atomik", a Prompt writer that "never renders"). Atomik is the agent; there is one database and no sync.
6. Login and welcome say "for the studio team" / "the studio's own room." Multi-tenant copy: for any team with an invite.
7. Delivery says masters download one shot at a time from the Canvas. Bulk download from Media; Canvas is Rig's build surface.

**Can be added now without v2:** balance readout and top-up; a queue strip (job states already exist); Approve as a compare view; bulk master download and the review link; `FAL_KEY` so Trained identities actually train; kill switch and vendor spend alerts, since real credits now flow.

### 0.2 Three rules the whole document assumes, restated so no PR can miss them:

1. **No engine call outside the metering layer.** Every adapter path stamps the ledger. A test enumerates adapter entry points and fails on any that don't.
2. **`workspace_id` on every table, every query, every Blob path, every signed URL.** A cross-tenant read test fails loudly.
3. **A `quote` resolves before any spending button enables, and the button's cost equals the ledger's `billedCredits` after the job.** On both viewports.

Roles (Settings → Team & roles): **Director, Producer, Artist, Editor, Admin.** Permission matrix in §13.

---

## 1. Foundations

### 1.1 Metering layer, ledger, quote engine
**Does.** One server-side function every engine call goes through: resolves the multiplier (workspace `internal` → 1.0; else engine multiplier, default 1.5), computes `billedCredits = ceil(engineCostUsd × multiplier / 0.10)` per job (batches multiply before rounding), writes the ledger row, debits the workspace, updates project and production `spent`, and samples in-flight jobs per engine every minute into `concurrency_samples`. `quote(engine, params)` returns `{ unitCredits, units, totalCredits }` without side effects and is what every button reads before enabling. **Floor guard:** a nightly job computes each engine's rolling 7-day margin; under 10% it raises the multiplier to restore 1.5× and alerts the admin console.
**Powers.** Every filled primary; production/project headers; Usage; Atomik plan totals; Before-you-change-this.
**Data.** `ledger`, `workspace.credits`, `workspace.multiplier`, `workspace.internal`, `engine.multiplier`, `concurrency_samples`, `project.spent`, `production.spent`.
**Accept.** Quote → job → ledger equality on 20 fixture jobs across every adapter; internal workspace bills at 1.0×; floor guard fires on a fixture; peak concurrency readable per engine per day.

### 1.2 Tenancy, auth, workspaces
**Does.** Accounts belong to many workspaces; a session carries one active workspace; **Switch workspace** in the account menu (desktop and mobile). Every server action derives `workspace_id` from the session, never from the request body. Blob paths are `/{workspaceId}/{productionId}/{projectId}/…`; URLs are signed per workspace with short expiry. Storage quota per workspace; usage on Settings → Storage.
**Powers.** Account menu, Settings, every route.
**Accept.** Cross-tenant read test fails; a signed URL from workspace A rejects in workspace B; quota enforced on upload.

### 1.3 Engine adapters and registry
**Does.** One interface — `quote`, `submit`, `poll`, `fetchMaster`, `cancel` — and one adapter per provider: **ModelArk** (Seedance 2.5), **Google** (Nano Banana Pro; Nano Banana fast for panels), **fal** (Kling 3.0, Kling 3.0 Motion, Topaz, Soul ID, Flux character, plus any open-weight draft model), **ElevenLabs**, **Vercel** (LLM, the only LLM path). Submissions are fire-and-poll; nothing awaits an engine inside a request. The **registry** (`engine` table) is what Settings → Engines & rates, the composer's model list and Atomik read: `name`, `does` (the one-liner), `rate`, `unit`, `connected`, `atomikMayPropose`, `multiplier`. Rates are read from adapters, never typed. `FAL_KEY` set; a health check per engine feeds the status dot.
**Powers.** Composer model chip (desktop rail, mobile sheet), Canvas node inspector, Settings → Engines, Atomik plans.
**Accept.** Every adapter runs a mocked round-trip in CI; the registry equals the adapter list; a disconnected engine shows its dot and is excluded from plans.

### 1.4 Prompt compiler and rule library
**Does.** Takes a shot's Setup (engine-neutral rows), cast bindings (rendered stills, never model references), the prompt and the rules in scope, and emits each engine's dialect. **Rules** are platform (seeded) + workspace (plain sentences in Settings), each with a source and an on/off. Seeded platform rules: one camera move per shot; niche terms as term + what happens; only subtitles and audio take a NO; time of day and lighting never both say golden hour; no all-caps headers in image prompts and always a no-lettering line; after two failed relative edits on Nano Banana offer a fresh regenerate; Kling for water, cloth and physics. Setup inherits **platform → workspace → project → shot**; the composer shows each row's source.
**Powers.** Every generation; Atomik's enhancement; Canvas prompt nodes.
**Accept.** Golden-file tests per engine dialect; switching a rule off changes the compiled prompt; inheritance resolves in the right order.

### 1.5 Queue
**Does.** A global pool bounded by vendor limits, with **fair-share per workspace** (per-workspace slots, priority lane for Agency and Production tiers), per-workspace rate limits, a kill switch per engine and per workspace, and vendor spend alerts. Job states `queued → running → done | failed`; failures carry a reason class (`refused`, `engine_error`, `cap_hit`, `balance_zero`, `quota`) and the right next action.
**Powers.** Rendering wells (ring loader), Run stage states, toasts, Needs-you pills.
**Accept.** One workspace's 40-job batch cannot starve another's single job (simulation test); kill switch drains within one poll cycle; every failure reason renders a distinct next action on both viewports.

### 1.6 Storage and masters
**Does.** Every take's master stored byte-for-byte in private Blob under the workspace prefix; `{production}_{shot}_{version}_{w}x{h}.{ext}` naming; masters tagged with colour space and delivery spec; C2PA manifest attached to every rendered output; keep every take (no auto-purge); user-initiated delete purges. Downloads always via signed URL, never through a function.
**Accept.** A master downloads named by convention; C2PA present; delete purges and the Library index updates.

---

## 2. Money

### 2.1 Credits, balance, top-up
**Does.** Prepaid balance per workspace at $0.10/cr; packs (500/$50, 2,200/$200, 5,750/$500, 24,000/$2,000 — bonus capped at 20%); Stripe (Razorpay for INR); auto top-up toggle with threshold; the top-up screen is the only place USD appears. At zero balance renders queue with "top up to release", admins and the owner notified, nothing silently dropped.
**Powers.** Balance readout (header, mobile header), Settings → Workspace & credits (M10 credits card), zero-balance state on every primary.
**Accept.** A pack credits the balance and the ledger; zero balance blocks and queues; auto top-up fires at threshold.

### 2.2 Tiers and inclusions
**Does.** Invite / Studio / Agency / Production as in SOW §2; included credits and panels metered separately from purchased and expiring at cycle end; no seat fees; annual at 20% off; auto-cancel after 60 days without a generation (owner told in advance); tier gates for review links, exports, post tools, priority queue, branded review, statements, admin console.
**Accept.** Inclusion consumption and expiry are visible on Usage; gates enforced server-side; auto-cancel job runs with a 7-day warning.

### 2.3 Caps and approval rule
**Does.** Per-project cap in credits; warn at N% (default 80) to Producers and Admins; at the cap, renders queue until a Producer or Admin unlocks; a per-workspace **cost approval rule** (`anyone renders` / `over N cr needs a Producer`), with a hard platform rule that any single job over 200 cr requires approval regardless. Runs apply the cap and the rule to the run total.
**Powers.** Project header bars, Needs-you pills, the composer's outlined primary with its reason, Atomik plan footer (`77 UNDER CAP`).
**Accept.** Cap hit queues and notifies; unlock releases; the 200-cr rule fires regardless of workspace setting.

### 2.4 Statements and Usage queries
**Does.** Per workspace / month / project statements itemised by shot and take in credits, included vs purchased separated, one USD line for the pack; CSV download. Usage answers: which shot is taking the most takes (headline, per project), by production, by person, by engine, by period, send-backs as a column, cap burn-down with projected finish, workspace burn rate.
**Powers.** Usage (account menu, both viewports); Settings → credits month-to-date.
**Accept.** Statement totals equal ledger sums for the period; projected finish recomputes on each take.

### 2.5 Invites, grant, onboarding
**Does.** Request-an-invite form → admin queue → approve → expiring code by email → account → create or join a workspace → seeded (platform Setup, rules, recipes, demo production) → one-time grant (~50 cr, capped by `grant_budget_usd`) → first render. Owners and Admins invite by email with a role; pending invites listed; links expire.
**Accept.** Timed test: invite email → first render under five minutes with no Rig, Settings or paragraph; grant issued once per workspace ever.

### 2.6 Internal workspaces
**Does.** `internal: true` set only from the admin console; multiplier 1.0, no platform fee, excluded from margin reporting, shown separately on the admin spend view.
**Accept.** aimighty workspace bills at cost on every engine; admin margin view excludes it.

---

## 3. Productions, projects, shots, media

### 3.1 Productions › Projects › Media
**Does.** CRUD for productions (client job: assets, cap, spend, status `Active · Delivered`) and projects (deliverable: format, runtime, six-step `step`, cap, spend, `needYou`). Media rows (`take` with `kind: video|still|audio|master`) belong to the project that made them, grouped by shot; **media survives shot deletion and moves with a shot.** `needYou` is derived: picked takes awaiting approval + checkpoints + failures needing a person.
**Powers.** Productions list and project tiles (7a / M1), Project › Media with kind filters and `BY SHOT` (7b / M2), production headers, breadcrumbs, need-you pills.
**Accept.** Delete a shot → its media remains and lists under the shot's last known title; move a shot → its media, cost and takes count move; `needYou` matches the Approve queue count.

### 3.2 Shots — CRUD and the seven interactions
**Does.** Shots with order, description, cast, Setup, planned seconds, state (derived from takes: none → draft → picked → approved), slots. The seven interactions, as server actions with optimistic UI and toast narration: **Copy** (planning only); **Paste after** (new ID, no takes, 0 cr); **Rename** (inline, Enter/Esc); **Open in Rig** (creates or opens the shot's board); **Move to production ▸** (moves the shot, its takes and its cost; toast `SH11 moved to Saltwater · 2 takes and 38 cr went with it`); **Delete** with **Undo** (soft delete for 30s, media never deleted); **Reorder** by drag (desktop) or drag after long-press (mobile), order persisted. Type-only shots never render and never cost. Filmstrip: approved takes in order, strip widths ∝ planned seconds.
**Powers.** Shots grid + filmstrip (10a / M3), context menu (desktop right-click, mobile long-press sheet).
**Accept.** All seven interactions round-trip through the server on both viewports; undo restores within 30s; filmstrip order equals shot order.

### 3.3 Setup and cast on a shot
**Does.** Setup rows editable per shot with the four-layer inheritance visible; cast is `@Name` chips resolving to assets; an unknown `@name` triggers the inline New-asset card (§5.1) and blocks Render until resolved.
**Accept.** A row overridden on a shot shows `SHOT` as its source and reverts on clear; an unknown mention blocks and then unblocks Render.

---

## 4. Generation

### 4.1 The one composer, end to end
**Does.** Prompt (with `@Name` highlights) → references (optional first frame / refs) → model chip (registry-driven list with one-liner and rate; defaults from the shot's stage or workspace default) → pills (aspect, duration, count, resolution, audio) → Setup rows → Cast → **quote** → primary enables with the cost → submit → job → poll → master to Blob → take filed (to the shot, or **unfiled** in Make) → wall updates; the well shows the ring until the take arrives. **Again** re-submits with the same spec and a new seed. Batch `×N` files N sibling takes. The estimate is debounced; opening the model list on touch commits no long task over 50ms. Identical behaviour from the desktop rail, the docked mobile card and the M9 sheet.
**Powers.** Make (8a / M4 / M9), a shot's composer, Canvas generate nodes, Atomik-initiated generations.
**Engine.** Any video/still/audio adapter via the metering layer; compiler from §1.4.
**Accept.** Quote equals billed on every path; a batch of 4 files 4 siblings under one shot; Again preserves spec and changes seed; mobile long-task assertion passes.

### 4.2 Make and unfiled
**Does.** Unfiled takes belong to the workspace (no project) and appear in Make grouped by day and in Library › Unfiled by reference. **File to shot** picks a production › project › shot (or creates one) and re-parents the take, assigning the next version number; cost moves to the project. Images swaps duration for resolution and adds Loose / Exact fidelity; Audio takes script, voice (with sample play), language and returns a waveform.
**Accept.** Filing an unfiled take moves its cost to the project's `spent` and it disappears from Unfiled; audio outputs carry a waveform strip.

### 4.3 Face-similarity QA
**Does.** Every take or panel rendered with a bound character is scored against the bound version's canonical still (InsightFace-class embedding distance); below threshold the take is marked `drift` with the score on its card; batches auto-pick the best-scoring sibling for the `PICKED` suggestion.
**Accept.** A fixture with a drifted face gets flagged; auto-pick chooses the highest score.

---

## 5. Assets

### 5.1 New asset sheet — create, derive, train
**Does.** Create (free): name, kind, references (Upload · A take · Make · Canvas). **Derive** the ports from references — character: FACE, HAIR, WARDROBE, VOICE; prop: HERO, DETAIL, TURNTABLE; location: plates by hour; look: LOOK, GRAIN; voice: VOICE, LANGUAGE — each `READY / LATER / OPTIONAL` based on what the references contain (a still per port is generated on demand from the references via Nano Banana Pro at 0 cr for READY ports that need a canonical crop). **Train** (priced switch): character face → Soul ID / Flux on fal; prop turntable; location missing hour; look apply-to-keyframes; voice → ElevenLabs clone. Training is an async job in the queue; the attribute flips `trained: true` on completion. Consent: the uploader confirms the right to train on that face; stored on the asset. Opens from Rig, a take (Promote), a Canvas selection, an unknown `@name`, and Atomik (propose only).
**Powers.** New asset sheet (3a / M8), inline card in the composer (3b / M9).
**Accept.** Same sheet from all five entry points; 0 cr with the switch off; kind change swaps derived ports and the switch's label and price; training completes and `@Name` resolves to the trained model for stills.

### 5.2 Versions, bindings, locks, where-used
**Does.** Versions are additive and immutable; every attribute has `currentVersionId`; a binding is `{shotId, slot, assetId, attributeId, versionId, overridden}`; where-used is computed from bindings; lock = `locked, lockedBy, lockedAt` with unlock logged; a locked asset re-asserts at every compile. **The image is the interchange format:** a version is always a rendered still or audio clip; engines receive pixels, never model references.
**Powers.** Library grid (8b / M7), asset nodes, slot inspector, Made-from.
**Accept.** Changing `currentVersionId` never alters an existing take; where-used equals binding count; a locked asset cannot be re-bound without unlock.

### 5.3 Library indexing and references board
**Does.** Assets lens reads assets; References lens reads a per-workspace loose board (items with position, source, `REF` chips); Unfiled lens reads unfiled takes — all by reference. **Promote to asset** opens §5.1 pre-filled; **Use in Make** pre-fills the composer's reference well; **Add to Canvas** creates a node.
**Accept.** Nothing in Library has a second copy; promote, use and add round-trip.

### 5.4 Made-from (provenance)
**Does.** Every take records `madeFrom`: bindings by triple, Setup values, engine and params, seed, rules in scope, credits, author, time. **Make another from exactly this** re-submits identical inputs with a new seed.
**Powers.** Take cards, Canvas inspector output card, Atomik receipts.
**Accept.** Made-from is complete for every take in the fixture set; make-another produces an identical compiled prompt.

---

## 6. Rig

### 6.1 Canvas persistence and node execution
**Does.** Boards persist `nodes[]` and `wires[]` per project; nodes of kinds Asset, Shot, Prompt, Generate Image / Video, Edit, Upscale, Audio, Voice, Compare, Note; wires `from {nodeId, portId} → to {nodeId, slotId}` of kinds inherited / override / filed / created. **Building is free.** Each executable node quotes itself from its inputs and settings; **Run node** submits through the metering layer; outputs land inside the node; **File** writes the output as the shot's next take version (`FILES AS SH04 v5 · v4 STAYS`). Any upstream change sets `staleSince` on every downstream node and **never auto-reruns**. Collaboration: presence and live cursors via a lightweight realtime channel (optimistic, last-write-wins on node position; edits to node settings are per-node atomic).
**Powers.** Canvas (6a) on desktop; **read-and-run** on mobile (M5) — the same board rendered as a vertical stack down one wire, tap a slot for the inspector sheet, no wire dragging, `Run node again` pinned.
**Accept.** Wire endpoints resolve to slot ids; running a node writes a ledger row and an in-node output; filing creates a take with Made-from; stale propagates transitively; a mobile session can run and file a node built on desktop.

### 6.2 Before you change this
**Does.** Selecting a different version for a bound slot computes dependents (`7 shots · 3 approved · 4 draft`), three priced subsets (re-render all / approved only / leave existing) from the quote engine, and the chosen subset drives the apply button. Apply rebinds and enqueues the chosen re-renders as a run.
**Powers.** Slot inspector (desktop 6a inspector, mobile M5 sheet), Library asset detail.
**Accept.** Subset prices equal the sum of per-shot quotes; "leave existing" rebinds without spending.

### 6.3 Recipes
**Does.** `Save as recipe` converts a board into `stages[]` (name, engine, scope, per-unit price); recipes are named, listed under Rig › Recipes, reusable across projects, shareable in the workspace, forkable, and seeded at platform level (the demo production's recipe, a 30s TVC recipe, a product-shot recipe). Per-recipe checkpoint rule (`every paid step` / `auto-run boards, stop before video`).
**Accept.** A saved recipe re-runs on a different project with the same stages and prices recomputed; platform recipes appear in every new workspace.

### 6.4 Run engine and checkpoints
**Does.** A `run` executes a recipe's steps in order: quote the whole run first; enforce cap and approval rule on the total; each step submits its jobs through the queue, collects outputs, auto-picks (with §4.3), and stops at a checkpoint when the rule says so — writing the Checkpoint message to Atomik. **Continue** resumes; **Change engine** re-quotes the next step and continues; **Stop here** ends with a receipt. A failed step becomes `needs you` with 2–3 priced fixes; **the run never restarts** — it resumes from the failed step after a fix. Run state drives the Atomik header button's state word and the ring.
**Powers.** Rig › Run (9b / M6), Atomik rail and sheet, header button, push.
**Accept.** Whole-run price before step 1; resume from any failed step; checkpoint rule per recipe honoured; the header button reflects `RUNNING` / `CHECKPOINT` within one poll.

---

## 7. Atomik

### 7.1 Rail state and message model
**Does.** `atomik.state` (closed / compact / expanded) persisted per user; `⌘J` toggles, `Esc` closes; **nothing renders when closed**; context derived from the route (production, project, run or shot). Threads per context. Four message types with strict schemas: **Plan** (steps, engines, per-step and total credits, `Run to first checkpoint`), **Checkpoint**, **Question** (2–3 priced options; never decides), **Done** (receipt by credit class, `N need you`). Planning credits metered as their own ledger class and shown as their own line.
**Powers.** Rail (10a), sheet (M3 and every screen), header button.
**Accept.** State survives reload; every message validates against its schema; a Question cannot be answered by Atomik itself.

### 7.2 Planning
**Does.** From a brief, a logline, or a request, the Vercel LLM adapter (planning model set in Settings, rate shown) produces, via **structured output**: a shot list with Setup rows as fields, cast tags (existing assets by id; unknown names proposed as New-asset cards, propose only), an engine per stage from the registry filtered by `atomikMayPropose`, and a recipe. The quote engine prices it. Prompt-cache the rule library and workspace Setup. The plan writes to the project's Brief and Shots on accept, never before.
**Accept.** A plan validates as a recipe; every engine in it has `atomikMayPropose`; total equals the sum of stage quotes; nothing is written until the user runs.

### 7.3 Boundaries
**Does.** Enforced server-side, not by prompt: Atomik never spends, unlocks, deletes or approves; it may pick; it may propose assets and rules; it calls engines only through the run engine and the metering layer; it reads memory from workspace rules, assets, Setup and recipes and keeps no private state; anything it learns becomes a proposed workspace rule the user can see and switch off.
**Accept.** Attempting a spend/unlock/delete/approve from an Atomik action returns a policy error and a Question instead.

### 7.4 Connectors, import, scheduling (last)
**Does.** Read a brief from Drive or Notion, references from Figma, a shot list from Sheets; deliver approved takes to Slack, Drive or a review link, using Settings → Connect-apps tokens; every connector action is a checkpoint. **Import** a CLAUDE.md, a skills folder or an exported ChatGPT memory into proposed rules and recipes for review. Scheduled runs (a weekly recipe) with a cap per schedule.
**Accept.** Each connector round-trips on a fixture; imports never save without review; a scheduled run stops at its cap.

---

## 8. Boards

### 8.1 Panel generation and iteration
**Does.** For every shot in a project (or a selected scene), generate 2–3 panels from description, Setup and cast on the standard stills engine (Nano Banana fast), quoted per scene before it runs (`12 shots × 3 panels · 15 cr`), auto-picked by §4.3 with alternates kept. Iterate: nudge chips (tighter, wider, other side, different hour) recompile and re-roll one panel; **Again**; replace with an uploaded reference. Panel history is versioned per shot. Included-panel allowances (tier) are consumed first.
**Powers.** Boards sub-tab (desktop and M2's Boards), Canvas image nodes, Atomik's boards stage.
**Accept.** A scene of 12 shots boards for the quoted price; a nudge changes exactly one panel; panel versions never overwrite.

### 8.2 Continuity check
**Does.** For consecutive shots, infer screen direction and eyeline from the panel (a lightweight vision call on the LLM adapter or a pose model) and flag crossing-the-line with a one-line reason. Start with screen direction only.
**Accept.** A fixture pair that crosses the line is flagged; a matched pair is not.

### 8.3 Promote to keyframe and board-from-take
**Does.** **Promote to keyframe** writes the shot's `KEYFRAME` binding to the panel's version and records `madeFrom`; the shot arrives in Shots with its first frame decided. When a take is approved and the board no longer matches, the board updates from the take's first frame (the board is the current truth of the shot).
**Accept.** Promotion creates the binding; approving a take with a different first frame updates the board and logs it.

### 8.4 Animatic
**Does.** Panels held for planned seconds, scratch VO from ElevenLabs (or an uploaded track), music bed, cuts on the beat, scrub bar, MP4 export. Runtime against the project's target is the same bar the Shots filmstrip shows.
**Accept.** Animatic duration equals the sum of planned seconds; MP4 exports and lists under Media as `kind: master` with `animatic: true`.

---

## 9. Approve

### 9.1 Queue and compare
**Does.** The Approve queue lists shots with picked takes awaiting approval plus checkpoints and failures needing a person, ordered by shot; compare loads two to four sibling takes with a synced playhead (A/B wipe for two on desktop; stacked with swipe on mobile). Frame-step, loop, in/out on desktop.
**Powers.** Approve sub-tab (desktop; mobile responsive variant), need-you pills, Needs-you counts in Productions.
**Accept.** Queue count equals `needYou`; playheads stay in sync across four takes at 1440; mobile swipe moves between siblings without reload.

### 9.2 State machine and locks
**Does.** `draft → picked → approved`; Pick and Approve are role-gated (§13); **Send back** returns the shot to draft with the note attached and logs it in the shot's history and Usage's sent-back column; an approved shot is locked and generating against it asks for a reason (logged); re-approval supersedes with history kept. Only approved reaches assembly, masters and export.
**Accept.** Transitions enforced server-side; a non-Producer cannot approve; sent-back count on Usage equals history entries.

### 9.3 One thread per shot
**Does.** Every note in the product — take notes, send-back notes, timecoded notes from the player, review-link comments — is an entry in the shot's single thread, tagged with take id and optional timecode, with `@person` mentions that notify.
**Accept.** A review-link comment appears in the same thread as an internal note; a timecoded note seeks the player on tap.

---

## 10. Deliver

### 10.1 Masters and bulk download
**Does.** Approved takes' masters download by signed URL, singly or as a zip per project or per selection, named by convention; `Download N masters · 0 CR` on Media (desktop and M2); background download and remembered folder on the Mac app later.
**Accept.** A zip of 12 masters completes without passing through a function; names match the convention.

### 10.2 Exports
**Does.** CSV shotlist (shot, take, version, engine, credits, prompt, Made-from summary), EDL and FCPXML in shot order with approved takes, the animatic MP4, and a PDF board (numbered panels with description, Setup line, duration, cast, workspace branding). Tier-gated.
**Accept.** The EDL opens in Resolve with the takes in order; the PDF paginates at 12 panels per page.

### 10.3 Client review link
**Does.** A tokenised, expiring, revocable link to a read-only page of a project's approved takes (or its boards) in shot order, carrying the workspace's name and logo and never particl's branding in front of their client; a comment box writing to the shot thread; a report button; view analytics (opened, by whom if they sign a name). Branded links are tier-gated.
**Accept.** Revocation invalidates within one request; comments land in the thread; a link to boards costs 0 cr to create.

---

## 11. Post tools on an approved take

**Does.** Buttons on an approved take and node kinds in Canvas, each quoted before it runs, each filing its output as the shot's next take version: **Reframe** (aspect change with content-aware fill), **Upscale** (Topaz on fal), **Motion control** (Kling 3.0 Motion — a cast still or approved frame plus a reference clip), **Extend** (last-frame continuation), **Outpaint** and **Background removal** for stills.
**Powers.** Take cards (desktop and mobile), Canvas Edit / Upscale nodes, Atomik's post stage.
**Engine.** fal (Topaz, Kling Motion), the shot's video engine for reframe and extend, Nano Banana Pro for outpaint and stills.
**Accept.** Each tool produces a new version under the same shot with Made-from; an upscale never replaces the original master.

---

## 12. Notifications and push

**Does.** Event bus: `take.finished`, `run.checkpoint`, `run.needsYou`, `shot.picked`, `shot.approved`, `shot.sentBack`, `cap.warn`, `cap.hit`, `balance.low`, `balance.zero`, `identity.trained`, `invite.pending`. Delivery channels: in-app toast and badge (the Atomik header state word, need-you pills), email digest, and push (APNs/FCM) with device tokens registered per user per workspace and per-user, per-workspace preferences in Settings → Notifications. `@person` mentions notify.
**Accept.** Every event renders somewhere on both viewports; a user in two workspaces receives only the active workspace's push unless opted in; token lifecycle survives logout and re-login.

---

## 13. Settings and permissions

### 13.1 Permission matrix
| Action | Director | Producer | Artist | Editor | Admin |
|---|---|---|---|---|---|
| Generate / board / post tools | ● | ● | ● | ● | ● |
| Pick | ● | ● | ● | ● | ● |
| Approve / send back | ● | ● | — | — | ● |
| Unlock a cap / change caps | — | ● | — | — | ● |
| Buy credits / statements | — | ● | — | — | ● |
| Invite / roles | — | ● | — | — | ● |
| Lock / unlock assets | ● | ● | — | — | ● |
| Delete shots / assets | ● | ● | — | — | ● |
| Engines, Atomik rules, workspace settings | — | — | — | — | ● |
| Export / review links | ● | ● | — | ● | ● |
Enforced server-side per action; the UI hides what the role cannot do. Owner is an Admin who cannot be removed.

### 13.2 Settings behaviours
**Does.** Workspace & credits (name, default model from the registry, default `16:9 · 5S · 1080P`, balance, auto top-up, month-to-date, top-up); Team & roles (invite, role dropdown, remove, pending); Engines & rates (registry read-only, `ATOMIK MAY PROPOSE` per engine); Production defaults (cap, warn at %, at the cap, who approves, who renders); Atomik (checkpoint rule, may create assets → propose only, planning model + rate, the standing `NEVER WITHOUT YOU` line); Rig & locks; Storage & masters (naming, keep every take, quota, usage); Notifications; Account (terms, privacy, retention, export workspace, delete workspace with purge). Changes save on change with a toast.
**Accept.** Every setting round-trips and takes effect on the next action; rates cannot be edited; workspace export produces a zip and a CSV; delete purges Blob and embeddings.

---

## 14. Platform admin console

**Does.** Platform-role gated route. Invite queue (approve → code), workspace list with tier, spend, balance, margin, `internal` flag, suspend; engine health, error rates and vendor rate-limit alerts at 70%; grant budget; content-policy flags and reports; margin view excluding internal workspaces; platform-layer editor (default Setup, rules, recipes, default caps, camera bank previews); floor-guard alerts.
**Accept.** A suspended workspace's jobs drain and its users see why; an approved invite issues one code; the margin view excludes `internal`.

---

## 15. Mobile-specific behaviour

**Does.** PWA: service worker caching the shell and fonts (never API responses for credits, queue or takes), offline screen, `beforeinstallprompt` on Android, manifest with `standalone`, per-scheme `theme-color`. Long-press → context menu sheet; drag reorder after long-press; native share sheet for review links; safe-area insets on dock, sheets and the pinned block; `atomik.state` persisted per user across devices. Push via web push now, APNs/FCM when the Capacitor shell ships. Sheets lock body scroll and restore position on close.
**Accept.** The Phase 0 suite stays green on every route; a review link shares via the OS sheet; a sheet closed by scrim tap restores scroll.

---

## 16. Security, compliance, content policy

**Does.** Content policy shown at signup and enforced by a pre-call moderation check on every prompt and reference (own classifier or a Hive-class service) plus the engines' refusals, both surfaced as `refused` with the reason; a report path on review links; per-workspace suspend; C2PA provenance on every rendered output and a visible synthetic-content label where required; DPDP-grade handling of face and voice data (explicit consent stored, region-pinned storage, user-triggered purge, retention limits on raw reference photos); rate limits per IP on public endpoints (invite form, review links); signed URLs with short expiry; secrets only in Vercel env, never in the client; audit log of approvals, unlocks, role changes, deletes, exports.
**Accept.** A refused prompt never reaches an engine; C2PA present on fixtures; purge removes embeddings; audit log covers the five actions.

---

## 17. Build order — dependencies first

| # | Capability | Depends on |
|---|---|---|
| 0 | **Day one:** promote v2 to production; the seven copy fixes; registry-driven engine strings; balance readout | — |
| 1 | §1.1 metering, ledger, quote; §1.2 tenancy hardening | — |
| 2 | §1.3 adapters + registry (`FAL_KEY`); §1.4 compiler + rules; §1.5 queue; §1.6 storage | 1 |
| 3 | §2.1–2.3 credits, top-up, tiers, caps; §2.6 internal flag | 1 |
| 4 | §3 productions › projects › shots › media, the seven interactions | 1 |
| 5 | §4 the one composer end to end, Make, unfiled, face QA | 2, 3, 4 |
| 6 | §5 assets: create/derive/train, versions and bindings, Library, Made-from | 2, 4 |
| 7 | §7.1–7.3 Atomik rail, planning, boundaries | 2, 3 |
| 8 | §6 Rig: canvas execution, Before-you-change-this, recipes, run engine + checkpoints | 5, 6, 7 |
| 9 | §8 boards; §9 approve; §12 notifications + push | 5, 6 |
| 10 | §10 deliver; §11 post tools; §2.4 statements + Usage; §13 settings + permissions | 8, 9 |
| 11 | §14 admin console; §2.5 invites + onboarding; §16 compliance hardening | 3, 10 |
| 12 | §7.4 connectors, import, scheduling; §15 PWA polish | 8, 10 |
| 13 | Desktop depth (⌘K, panes, review player, bulk); native Mac then iOS | 10, 12 |

Every row ships for both viewports or it doesn't ship. Rows 0–3 are invisible to users and are the ones that make every later number true.

---

## 18. Testing and acceptance summary

- **Ledger tests:** quote = billed on every adapter path; no adapter bypasses metering; internal at 1.0×; floor guard fires.
- **Tenancy tests:** cross-tenant read fails; signed URLs scoped; quota enforced.
- **State machines:** take states, run states, shot locks — invalid transitions rejected server-side; runs never restart.
- **Permissions:** the §13.1 matrix as a table-driven test.
- **Playwright at five viewports** on every route: no overflow, inputs ≥ 16px on touch, safe-area respected, one filled primary per screen, primary outlines while a sheet or rail is open, the ring is the only loader, accent only on approved / done / running / checkpoint, mobile last-row-visible above the pinned block.
- **Golden files:** compiled prompts per engine; Made-from completeness; export formats (CSV, EDL, FCPXML, PDF).
- **Mocked engines in CI; real calls only in the internal workspace with stated cost.**

---

## 19. How to work

1. **Day one, before anything else:** confirm where v2 actually is (branch, preview, production). If it's not on production, promote it or tell me why not. Then the seven copy fixes from the live-site audit, and make every engine string read from the registry.
2. Confirm §1 against the code: where keys live, `workspace_id` coverage, whether a metering layer exists and which paths bypass it. Report before changing anything.
3. Rows of §17 in order, one PR per capability, each PR stating: what it costs a workspace to use, how engines are mocked, what changed in the compiler, where the code is workspace-scoped, and which viewports it was verified on.
4. After any schema-touching PR, diff against `particl-sow-v2.md` §5 and update it.
5. Any task that would spend real money on an engine: stop and ask.
6. Design questions go to the two READMEs; scope, data and money questions come here; if this document and the code disagree, ask.
