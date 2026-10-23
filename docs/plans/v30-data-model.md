# v30 Phase A data model (plan, 17 Oct 2026; updated 18 and 19 Oct 2026)

The schema under the v30 interface, for Phase A items 1, 2, 3, 5 and 6 of the owner's 17 Oct brief. It is brought to:
- his answers of 17 Oct;
- his 18 Oct data-model and money decisions;
- his 19 Oct answers to Q12–Q26, with the ten final step lists.

The sources are in `docs/redesign-plan.md`: "Owner, 17 Oct 2026 …", "Owner, 18 Oct 2026, ~23:00 IST" and "Owner, 19 Oct 2026, ~00:20 IST". Docs only: no product code changes with this file. Read from `origin/release/1` at `85cb7a07`. What #818 (A1) and #820 (A5) built was re-read at `c6f90813` and is marked **as built** where it differs from the plan. The list of readers of "approved" (§2.8) was taken at `b77296a2`.

**Changes on 19 Oct** (the owner's answers replace the 18 Oct recommendations where they differ)
1. **§2.8 rewritten for Q12: Keep is a separate mark**, `generations.kept_at` / `kept_by`, not today's approved.
   - Today's approved is a commit, and in v30 the commit is Sent.
   - The one predicate every reader of "approved" moves to follows Sent on output steps and Kept on Look and Elements.
   - Every reader found in the code is listed with file:line, as the list each PR must name.
   - The 18 Oct `approved_via` is withdrawn.
2. **§2.6 and §2.9 rewritten for Q15: one card per shot.**
   - A beat makes one plate in Storyboard and one in Shots ("from Script · beat 4").
   - A Storyboard sheet is a make-node output whose panels become frames inside the shot cards.
3. **§2.10 replaced with the owner's final lists** (the "+" tile, Treatment on or off by default, Pitch deck folded into Treatment).
   - A third surface is added for the Treatment step: `deck` (Q19). No deck pages are canvas cards, so `deck_page` leaves the canvas output list (§2.9).
4. **§2.7: Q14** (rejections are takes sent back, with the reason given), **Q25** (both may mark, each shown with who, with Undo) and **Q26** (one reading per file; no shot triggers a reading).
5. **§4: Q23** (questions are free and write no job; a plan is a Writing job, quoted first) and **Q24** (Script revision: Writing; Deck page: one quoted job per page covering its words and pictures; nothing built before the spike).
   - The 19 Oct money answers are added, with no figures: Enhance is priced as it costs and shown before pressing, and only the quote path is built.
   - A press (#815) is refused at the quote, with the pause card, when its total would pass the workspace cap.
6. **Q13, Q20, Q21, Q22 placed** (§2.8, §2.10).
7. **§7, §8, §9 updated.** Q12–Q26 move to the answered table; three readings of the answers that need the lead's or owner's confirmation are listed in §9.2.

**Changes on 18 Oct**
1. **§2.7 (new): the production record**, what Atomik carries forward per production. A read model over the existing rows plus one table of pins and removals; no content is copied (18 Oct, data-model (a)).
2. **§2.8 (new): Kept and Sent.** It replaces §2.3's derived "kept = picked or approved" (Q2 is answered: 17 Oct #12). Keep maps onto today's approved state, so draft → picked → approved stays (ground rule 4). The tension is flagged, and the choice is owner question Q12. Sent is a filing with its step (18 Oct (b)). *(Superseded 19 Oct: Keep is a separate mark; see Changes on 19 Oct.)*
3. **§2.9 (new): make nodes typed by output**, with frames and variants as children of the one shot card, card groups, and inputs as rows. §2.3's `kind` list and §2.5's roles are reconciled with it (18 Oct (c)).
4. **§2.6 rewritten: beats are `script_beats` rows under the Script**, and `shots.beat_id` gives one beat several shots (17 Oct #13, 18 Oct (d)). Q3 is answered.
5. **§2.10 (new): proposed step lists for the ten film types** (17 Oct #11, with 18 Oct (d) applied), with the ambiguities as Q16–Q22.
6. **§4.1: a preflight is stored on the job before its quote.** An Options chip is one job with several takes and one approval. Reading, Research, Analysis and Writing jobs carry their band (18 Oct money).
7. **§4.2–§4.5 and §5: the 18 Oct money rules.**
   - Plans are quoted jobs. Atomik's own check is never a job.
   - Enhance has no Undo.
   - Refunds stay internal (17 Oct, 18:00 #4).
   - History backfills from the meter (17 Oct #15) and shows one line per Agent command.
8. **§4.6: only the workspace owner raises or removes the monthly limit, and a pause lifts when the new UTC month starts** (17 Oct update two #5; 18:00 #3).
9. **§6.1: a trained likeness is `uploaded`; anything made from it is `generated`** (18 Oct #7). #820 files it as `generated`; the code fix is listed.
10. **As built:** §2.1 and §2.2 (#818), §6 (#820).
11. **§7, §8 and §9 are updated.**
    - Q1–Q11 are answered, with where each answer lands.
    - Q12–Q26 were new, and were answered on 19 Oct.

**What this plan holds to**
- **Extend, don't replace** (ground rule 4). Every v30 concept below names the existing table it extends, or says why it needs a new one.
- **One source of truth per fact.** Where a v30 table has to hold something an older row also holds, the plan names which one is the truth, who writes the other one, and the test that keeps them equal.
- **`meter_events` stays the money truth.** No v30 table stores what was charged or what a vendor cost.
- **No visible change, no change to any charge.** Every PR sits behind a flag that is OFF. Until launch, each flag is on only in the house workspace (`lib/newInterface.ts` rule).
- **No figures.** No prices, margins or vendor costs anywhere in this plan or its PRs. Tests use synthetic values built in the test.

---

## 0. How data is stored today (what every table below follows)

| Fact | Where on release/1 |
|---|---|
| **One database per workspace.** `db()` throws when no workspace is in scope. | `lib/db.ts:9-45`, `lib/tenant.ts` |
| **Platform tables** (accounts, workspaces, `meter_events`, reservations) carry `workspace_id`, and every query filters on it. | `lib/platform.ts:155-199`, `lib/generationRequests.ts:354-368` |
| **Newer per-workspace stores also carry `workspace_id`**, leading every key, and the store is built with `requireTenant().id`. | `lib/pipeline/store.ts:110-130` |
| **Tables are created lazily** by the store's own `…Ready()`, with `CREATE TABLE IF NOT EXISTS`, memoised per client. | `lib/workbench/team-canvas.ts:22-40`, `lib/generationRequests.ts:46-60` |
| **Columns are added with `columnInstaller` → `addColumn(table, decl, backfill)`**. The column and its one-time backfill commit in one batch. | `lib/schemaInitialization.ts`, `lib/db.ts:917-1159` |
| **"Production" in the code is a `projects` row.** The team canvas, its Liveblocks room, Rig runs and lock events all key on `projects.id` and call it `production_id`. The `productions` table is the client job above it. | `lib/workbench/team-canvas.ts:63,78-88`, `lib/db.ts:82-93` |

**Rules for every new table in this plan**
- It lives in the **workspace's own database** unless marked *platform*.
- It carries `workspace_id TEXT NOT NULL` as the first column of its primary key and of every index (the `lib/pipeline/store.ts` idiom; CLAUDE.md rule 2). Its store refuses a row whose `workspace_id` is not `requireTenant().id`.
- `production_id` means `projects.id`, never `productions.id`.
- Nothing is erased (rule 13): rows get `removed_at` / `removed_by`, and Undo clears them.
- It is created lazily by its store's `…Ready()`, which only flag-on code calls. With the flag off, no production database gains the table.
  - **As built (#818, #820):** A1 follows this rule; its two `projects` columns are added in its store's `ready()`, reached only with the switch on. A5 does not: its seven columns (`elements` ×4, `uploads` ×3) are added at boot in `lib/db.ts` on every workspace database. They are nullable and read by nothing while `V30_LIBRARY` is off; only the fill and the unique handle index wait for the switch. That is safe (additive, no backfill at boot) and is recorded here rather than changed.

---

## 1. Names

The brief's words are kept in the interface. Table and column names avoid words the code already uses for something else (rule 5; CLAUDE.md's warning on `tier`, `allowance`, `panel`).

| Brief's word | Name here | Why not the obvious name |
|---|---|---|
| step, frame | `production_steps` (a canvas step's frame is the `frame_*` columns on its row) | `frame` already means a video frame (keyframes, `workbench_edit_versions.frames`, link role "frame"). `stage` is taken by `projects.stage` and `recipe_stages`. |
| node, card, plate, make node | `canvas_nodes`; a make node (17 Oct: plate) is `kind='plate'` with an **`output_kind`** | `nodes` is the JSON column on `boards`. `card` is UI-only. `make` is the Make panel and its tools; a `make` kind would read as the panel. |
| bundle (of cards) | **`kind='group'`**, members carry `group_id` | `bindings` already calls an element's whole set of current attributes its *bundle* (`attribute_id IS NULL`, `lib/db.ts` bindings comment). |
| frame of a shot, variant | `canvas_nodes.frame_of`, `variant_of` (children of one card) | `variants` is the team canvas's ad-variant list (`lib/workbench/studio-schema.ts`); it lives in another store and never meets these columns. |
| link (node → plate, with a role) | **`plate_inputs`**, column `input_role` | `role` already means a member's role and a reference's role (`reference_image`). |
| link (gen ↔ production and step) | **`take_filings`** | "Take" is the product's word for a generation (rule 4). "Filed" is how the code already says a take sits on a shot. |
| Sent (→ step), the commit | a `take_filings` row with `filed_as='sent'` | A send puts a take in another step, which is what a filing already records. |
| Kept | **`generations.kept_at`, `kept_by`** (§2.8; Q12, 19 Oct) | `approved` is today's commit, and in v30 the commit is Sent; a Keep is not a commit. |
| committed (what "approved" readers ask) | one predicate, `committedSql(alias)` (§2.8) | Each reader names one rule instead of its own mix of `review_state`, Sent and Kept. |
| the "+" tile (steps offered, not opened) | `opened` on a film type's step in config (§2.10) | `optional` would hide that the step exists in the list and has a place in its order. |
| deck (Treatment) | surface `deck` on `production_steps` (§2.10) | `document` means `production_documents`; the treatment is a deck kept in `treatments`. |
| jobs | `quoted_jobs` | `lib/jobs.ts` (the take listing), the `JOBS` purpose list (`lib/takeJob.ts`) and the header's "jobs tray" already use "job". No job is spent without its quote (brief rule 4). |
| Preflight (card) | columns `preflight`, `preflight_at` on `quoted_jobs` | It belongs to the quote it precedes and is free; a table would hold rows nobody is charged for or reads alone. |
| Options (chip) | `quoted_jobs.options` (how many takes one job makes) | `variant` is a card child, above. |
| band (Reading · Research · Analysis · Writing) | `quoted_jobs.band` | `tier` is a resolution band in the vendor rate table (`RateTier`, `TableTier`). |
| commands | `agent_commands` | `lib/board/commands.ts` is the ⌘K and right-click command list. |
| mode (Agent · Director) | column `decider` (`agent` \| `director`) | `atomik_chats.agent_mode` and `rig_agent_runs.mode` already mean Ask \| Auto. `agent:*` is also an actor id (`lib/security/people-only`). An Agent-mode job can be started by a person. |
| receipt | no table: a read model, `stepReceipt()` | `credit_receipts`, `meter_credit_receipts` and `soul_training_receipts` already exist. |
| documents | `production_documents`, `document_versions`, `document_changes`, `document_imports` | Asset kind `document` already exists on the canvas. |
| beat (the Script's Beats view; was Breakdown) | **`script_beats`**, and `shots.beat_id` | Music video's "Beat map" step means a track's musical beats, and the draft's beat sheet (`lib/production/beats.ts`, inside `workbench_projects.body`) is another store. The table name says whose beats. |
| production record | a read model `productionRecord()`, and **`production_record_items`** for pins and removals | `record` alone is too wide (`take_provenance.recorded`). |
| reading notes | `reading_notes` | `atomik_memory` holds what a person chose to keep; notes are a billed job's output, kept whole. |
| library element | `elements` (extended) | Already the Library's thing (`lib/elements.ts`). |

---

## 2. Item 1: production model

### 2.1 Productions: extend `projects`
| Column (additive, nullable) | Meaning |
|---|---|
| `film_type TEXT` | Closed list: the ten film types (Q1, answered 17 Oct #11). NULL means a production from before v30. It is separate from `kind` (free text, "30s car spot") and from `category` (genre). |
| `canvas_store TEXT` | `team` (NULL reads as `team`) or `v30`. This says **which store is the truth for this production's canvas** (see 2.4). **As built (#818):** with `CHECK(canvas_store IN ('team','v30'))`; nothing writes it yet. |

- **Step lists by film type** are defaults, not a table, and no workspace or client name appears in them. **As built (#818):** the owner's ten film types are the shipped default in code (`FILM_TYPES_DEFAULT`, `lib/productionModel/filmTypes.ts`). The deployment setting `V30_FILM_TYPES` (JSON, strict schema) replaces the whole list when it is set; a setting that is set but unreadable is refused, and the error names its path, never its value. A step's kind is its label in snake case (`Pitch deck` → `pitch_deck`, `Swap-ins` → `swap_ins`). They move to a **platform-layer** key (`platform_layer`, `lib/platformLayer.ts`) with a workspace override (rule 3) in a later PR, because adding a layer key changes the admin platform-layer response, which Phase A must not.
- **The default changes before the switch goes on** (owner, 18 Oct: "#818's lists change to this before its switch goes on"). The owner gave the final lists on 19 Oct ("final for A1b"; §2.10). The code change is A1b, which covers:
  - `FILM_TYPES_DEFAULT`;
  - an `opened` flag per step;
  - the `deck` surface;
  - `add()` placing a step at its list position.
- `projects.step` (0–5 on the six old steps) is left alone. It keeps meaning what it means for productions from before v30.

### 2.2 Steps and frames: new `production_steps`
```
production_steps(
  workspace_id, id, production_id,
  page_id      TEXT NOT NULL,     -- stable link id, see below
  kind         TEXT NOT NULL,     -- the step's kind from the film type's list (brief, script, look, cast, storyboard, shots, deliver …)
  surface      TEXT NOT NULL CHECK(surface IN ('document','canvas','table','deck')),   -- 'deck' added 19 Oct (Q19), A1b
  label        TEXT NOT NULL,     -- the name a person may rename; page_id never follows it
  position     INTEGER NOT NULL,  -- order on the rail
  frame_x REAL, frame_y REAL, frame_w REAL, frame_h REAL,   -- the frame, canvas steps only
  created_by, created_at, updated_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id),
  UNIQUE(workspace_id, production_id, page_id))
INDEX (workspace_id, production_id, position)
```
- **One row per step.** A canvas step's frame is its four `frame_*` columns, so "one frame per canvas step" holds by construction. A document step (Brief, Script), a table step (Deliver) and a deck step (Treatment) have no frame.
- **Adding `deck` to the CHECK (A1b).** SQLite cannot alter a CHECK.
  - On a database that already has `production_steps`, A1b rebuilds it in one transaction: a new table with the four-surface CHECK, every row copied, the trigger and index recreated. The old table is renamed aside, not dropped (nothing is erased).
  - Only flag-on databases have the table (at most the house), so the risk is low. A test runs the rebuild over a fixture database and compares rows.
- **`page_id` is the stable page id.** It is made once from the kind (`script`; a second Shots step is `shots-2`), it is unique per production, and it never changes on a rename. It is never reused after Undo-able removal. A later route `/<production>/<page_id>` can rely on it.
- The rows are created from the film type's list when a v30 production is made. Adding, renaming or reordering a step changes only this production's rows. **A production keeps the steps it was made with when the default list changes** (§2.10).

**As built (#818, `lib/productionModel/steps.ts`)**, where it differs from or adds to the above:
- `surface` has a third value, **`table`** (Deliver: "Deliver is a table", owner 17 Oct #11). Two CHECKs hold the frame rule: a canvas step always has a frame with a positive size; a document or table step never has one.
- A trigger refuses any update to `workspace_id`, `production_id`, `page_id`, `kind` or `surface`, so only the label, position and frame can change.
- `created_by TEXT NOT NULL DEFAULT ''`.
- `ensureSteps` gives a production its film type's steps once and is idempotent, removed steps included. It refuses a second film type with 409.
- `add` accepts only a kind the production's film type lists. Restore puts a step back at the end of the rail. New frames are laid out left to right.
- The switch is `V30_PRODUCTION_MODEL === "1"` **and** `newInterfaceFor(workspace)`, which covers the house workspace and any workspace the platform owner lists. Off, the factory answers 404 before the database is touched.

### 2.3 Nodes: new `canvas_nodes`
```
canvas_nodes(
  workspace_id, id, production_id,
  step_id      TEXT NOT NULL,          -- the frame it sits in
  kind         TEXT NOT NULL CHECK(kind IN ('still','clip','audio','text','document','plate','detail','element','group')),
  output_kind  TEXT CHECK(output_kind IN ('image','storyboard_sheet','video','audio','lip_sync','script_revision','upscale','layers')),   -- no deck_page: deck pages are not canvas cards (Q19)
  x REAL, y REAL, w REAL, h REAL, z INTEGER,   -- relative to its frame, so moving a frame is one row
  title, text,
  shot_id      TEXT,   -- the shot card (and its children) (§2.9)
  beat_id      TEXT,   -- a storyboard sheet made for a beat (§2.6)
  take_id      TEXT,   -- the current take shown on the card (generations.id)
  element_id   TEXT,   -- element cards
  document_id  TEXT,   -- document cards
  frame_of     TEXT,   -- canvas_nodes.id of the shot card this is a frame of (§2.9)
  frame_role   TEXT CHECK(frame_role IN ('start','end','key')),
  variant_of   TEXT,   -- canvas_nodes.id of the card this is a variant of (§2.9)
  group_id     TEXT,   -- canvas_nodes.id of the group card it belongs to (§2.9)
  detail_type  TEXT CHECK(detail_type IN ('angle','camera_move','lighting','action','note')),
  detail_value TEXT,   -- JSON: a Setup option id, or words
  revision INTEGER NOT NULL DEFAULT 1,
  created_by, created_at, updated_at, removed_at, removed_by,
  CHECK ((kind = 'plate') = (output_kind IS NOT NULL)),
  CHECK (frame_of IS NULL OR variant_of IS NULL),
  CHECK ((frame_of IS NULL) = (frame_role IS NULL)),
  PRIMARY KEY(workspace_id, id))
INDEX (workspace_id, production_id, step_id)
INDEX (workspace_id, shot_id)   INDEX (workspace_id, take_id)   INDEX (workspace_id, element_id)
INDEX (workspace_id, frame_of)  INDEX (workspace_id, variant_of)  INDEX (workspace_id, group_id)
UNIQUE (workspace_id, step_id, shot_id) WHERE shot_id IS NOT NULL AND frame_of IS NULL AND variant_of IS NULL AND removed_at IS NULL
```
- **Kinds (17 Oct, reconciled with 18 Oct (c)).** The 17 Oct list stays: still · clip · audio · text · document · plate · detail · element. One kind is added, `group`. A **plate is the make node**: it is typed by what it makes (`output_kind`, §2.9) and must have one. `still`, `clip` and `audio` are cards that show something not made in that card, such as an upload or a take brought from the Library.
- **One card per shot** (18 Oct (c); Q15, 19 Oct): the last UNIQUE allows one top-level card per shot per step. Its frames and variants are children (§2.9), never cards of their own.
- **Takes as versions.**
  - The plan adds `generations.node_id TEXT` (additive, nullable, indexed). It is written at admission in the same insert as the take, the way `shot_id` is today.
  - A card's versions are `generations WHERE node_id=? ORDER BY created_at`. Takes made before v30 have no `node_id`; for those, a shot card reads `WHERE shot_id=? AND node_id IS NULL`, numbered by the existing `generations.version`.
  - There is no copy of the version list.
- **Status is derived, not stored** (**changed 18 Oct; Kept changed again 19 Oct**, replacing the 17 Oct "kept = picked or approved"). A pure `nodeStatusOf(currentTake, filings)` returns three things:
  - **state**, which is one of:
    - `failed`: the take failed;
    - `kept`: `generations.kept_at` is set (§2.8);
    - `draft`: anything else (a picked take is still `draft`: picking is "a step on the way", 17 Oct #12).
  - **sent**: the step the take was last sent to, from its live `take_filings` row with `filed_as='sent'` (§2.8), or none. It is shown beside the state: a card shows both, "Kept · Sent → Edit" (Q13).
  - **finish**: `4k` (an upscale), `final` (`finalOf`, job label `shot_final`) or none. These are the 17 Oct `final` and `4k`, kept as labels on the take, not as states.

  Storing any of these would make a second truth beside `generations.status`, `kept_at`, the filings and the draft/final link. Text, document, detail, group and empty plate cards have no status.
- **Detail nodes are a fifth Setup layer**, above the shot's. Setup today has four layers: platform, workspace, production, shot (`lib/setup.ts`).
  - A detail card linked to a plate supplies its `detail_type`'s Setup key: `angle`→`angle`, `camera_move`→`move`, `lighting`→`light`.
  - `action` and `note` add words to the prompt and set no Setup key.
  - `shots.setup` stays the shot's own layer and is never rewritten by a detail card. So "Setup carried into every shot" holds, with no second copy.

### 2.4 One canvas truth per production (reconciling the team canvas)
- Today a production's canvas is one JSON row, `workbench_team_canvas.body`, edited live over Liveblocks (`lib/workbench/team-canvas.ts`). Wires are each node's `linked` array (`lib/workbench/studio-schema.ts:71-172`).
- **`projects.canvas_store` decides which store is the truth**, per production:
  - `team`: the JSON row, exactly as today. The v30 tables hold nothing for this production.
  - `v30`: the tables. The JSON row is kept, read-only, as it was at the switch.
- **A one-way import** (flag on, house workspace only) copies a team canvas into `canvas_nodes` and `plate_inputs`.
  - It keeps node ids and stamps the JSON revision it read. In the same write it sets `canvas_store='v30'`. After that, a team-canvas patch for that production is refused with 409.
  - This is the same shape as the old-board import (`boards.imported_at`, `imported_to`; `lib/workbench/board-import.ts`), which never rewrites its source.
  - The same import copies the draft's beat sheet (`project.production.beats`, `lib/production/beats.ts`) into `script_beats` (§2.6), and never rewrites the draft.
- The Liveblocks room is unchanged (`teamRoomFor(workspaceId, productionId)`).

### 2.5 Node → plate links: new `plate_inputs`
```
plate_inputs(
  workspace_id, id, production_id,
  plate_id     TEXT NOT NULL,   -- canvas_nodes.id, kind plate
  from_id      TEXT NOT NULL,   -- canvas_nodes.id (never a group: see below)
  input_role   TEXT NOT NULL CHECK(input_role IN ('cast','frame','angle','camera_move','environment','prop','brand','product','look','source','audio','text','panel')),
  ordinal      INTEGER NOT NULL DEFAULT 0,
  via_group_id TEXT,            -- the group card this row came in with, when a whole group was wired
  binding_id   TEXT,            -- bindings.id when the source is an element and the plate has a shot
  created_by, created_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, plate_id, input_role, ordinal) WHERE removed_at IS NULL
INDEX (workspace_id, from_id)   INDEX (workspace_id, via_group_id)
```
- **Four roles are added** for the new outputs:
  - from 18 Oct (c):
    - `source`: the take (or, for a Script revision, the document) a make node works on: Upscale, Layers, Lip-sync;
    - `audio`: a voice or a track;
    - `text`: words a Script revision works from;
  - from 19 Oct (Q15): `panel`, a shot card a Storyboard sheet draws, with `ordinal` = its panel's place on the sheet.

  Which roles each output accepts is in §2.9; the store refuses any other.
- **Inputs are rows, one per input.** Wiring a group writes one row per member, each with its own role and `via_group_id`. Unwiring the group removes exactly those rows, in one write.
- **Reconciling `bindings`** (shot, slot, ordinal → element, attribute, version: `lib/db.ts:506-562`):
  - When an element card feeds a plate that has a shot, the `plate_inputs` row and the `bindings` row are written **in the same transaction**.
  - `plate_inputs` holds only the wire and its role. `bindings` stays the only truth for which version the shot uses (follow or pin).
  - Role → slot: `cast`→`character`, `environment`→`background`, `prop`/`brand`/`product`→`element`, `look`→`look`, `frame`→`keyframe`.
  - `angle` and `camera_move` come from detail cards and set no binding (2.3). Neither do `source`, `audio`, `text` or `panel`, which point at a take, an upload, a document or a shot card, not an element.

### 2.6 Beats, under the Script: new `script_beats`, and `shots.beat_id`
**Changed 18 Oct.** On 17 Oct "a beat is a `shots` row". The owner has since decided:
- "Yes, one beat can become several shots; a shot belongs to one beat" (17 Oct #13).
- "Breakdown renamed Beats and folded into Script as views" (18 Oct (d)).

So a beat is its own row, under the Script document, and there is no Beats step.
```
script_beats(
  workspace_id, id, production_id,
  document_id       TEXT NOT NULL,   -- production_documents.id, kind 'script'
  source_version_id TEXT,            -- the document_versions row it was broken down from (NULL: written by hand)
  source_start INTEGER, source_end INTEGER,   -- its character range in that version's Fountain
  scene_key TEXT, scene_heading TEXT,         -- the scene it sits in (Feature groups the board by scene)
  position INTEGER NOT NULL,         -- order within the Script
  text TEXT NOT NULL,
  job_id TEXT,                       -- quoted_jobs.id of the Analysis job that broke it down (NULL: by hand)
  created_by, created_at, updated_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id))
INDEX (workspace_id, document_id, position)
```
- **`shots.beat_id TEXT`** (additive, nullable, indexed). A beat has any number of shots; a shot belongs to at most one beat, because there is one column. Shots of a production with no Script (Product video, Social …) have no beat.
  - The shots store refuses a `beat_id` from another production, or a removed beat.
  - Removing a beat does not remove its shots: they keep the `beat_id` and read as "beat removed", and Undo brings the beat back.
- **The Beats view is a view of the Script, not a step.** It reads `script_beats` with their shots (`shots WHERE beat_id=?` by `position`). The Script step's page shows it; no `production_steps` row exists for it (§2.10).
- **A beat makes plates: one card per shot** (Q15, 19 Oct: "one card per shot, not one sheet per beat: a beat makes one plate in Storyboard and one in Shots ('from Script · beat 4')"). Making a beat's plates writes the following in one write:
  - its first `shots` row (`beat_id` = the beat), unless it already has shots;
  - one plate in the Storyboard step for that shot (`output_kind='image'`, the shot's `shot_id`). Its takes are the shot's storyboard frames;
  - one plate in the Shots step for that shot (`output_kind='video'`, the same `shot_id`): the shot card.

  Each plate's origin line, "from Script · beat 4", is derived from `shots.beat_id` → `script_beats.position`, not stored. When a beat becomes several shots (17 Oct #13), each new shot gets its own pair of plates the same way.
  - The two cards of one shot are linked by the shared `shot_id`; the beat by the shot's `beat_id`. No extra link row.
  - The UNIQUE in §2.3 keeps it to one card per shot per step. "Dashed" is derived: a plate with no take yet.
  - Making plates spends nothing.
- **A Storyboard sheet is a make-node output, not the beat's card** (Q15). A `storyboard_sheet` plate in the Storyboard step takes the shots it draws as inputs (role `panel`, ordinal = panel order; §2.5, §2.9) and makes one sheet image. Each panel then becomes a **frame inside that shot's card**:
  - a crop of the sheet, stored as its own upload row (`derived_from_gen` = the sheet's take, `derivation` the panel rectangle; §6.4);
  - shown as a `frame_of` child (`frame_role='key'`) of the shot's card in Shots, the card that holds its takes. The shot's Storyboard card shows the same frame through the shared `shot_id`, with no copy.

  Which of the shot's two cards the owner meant is a reading, flagged in §9.2 (R2).

  Cutting panels is free: an upload and a crop are never billed (brief rule 3).
- **Breaking a Script into beats is a billed Analysis job** (a `quoted_jobs` row, product `analysis`; §4.5). Writing beats by hand is never billed.
- **Today's beat sheet** (`lib/production/beats.ts`, inside the person's draft JSON) keeps working for productions on the team canvas. It is copied into `script_beats` only by the one-way import (§2.4).
- **M5 changes accordingly:** `shots` gains only `beat_id`. The source-range columns the 17 Oct plan put on `shots` live on `script_beats`.

### 2.7 The production record: what Atomik carries forward (18 Oct (a))
The owner, 18 Oct: "the production record: what Atomik carries forward (brief, script and what changed, beats, treatment, look pack, elements with handles, uploads with reading notes, keeps and rejections), pinned or removed per item, free." Every shot and every Atomik job in the production reads it instead of asking again (CLAUDE.md rule 13: what the brief sets "carries into every shot and is not asked again").

**The record is a read model, `productionRecord(productionId)`, over rows that already hold each fact.** It copies no content. The one new table holds the only facts that have no home today: a person's (or Atomik's) pin or removal of an item, and items added by hand.

| Item | The truth it reads | Carried by default |
|---|---|---|
| Brief | `production_documents` (kind `brief`) → its current `document_versions` row | yes, following the current version |
| Script | the same, kind `script` | yes |
| What changed in the Script | `document_changes` with `state='accepted'` whose `result_version_id` is the current version or one after the version a pin holds | yes |
| Beats | `script_beats` (live), with their shots | yes |
| Treatment | `treatments` + `treatment_versions` (current) | yes |
| Look pack | the production's `elements` with `library_kind='reference'` (Q8, answered 17 Oct #16: "Reference, in the Look pack") | yes |
| Elements with handles | the production's `elements`, plus workspace-wide ones bound to its shots (`bindings`) or wired into its plates (`plate_inputs`) | yes |
| Uploads with reading notes | `project_library_uploads` → `uploads`, with the newest `reading_notes` row per upload (below) | yes |
| Keeps | the production's takes (home or filing, §6.5) with `kept_at` set (§2.8) | yes |
| Rejections | **only takes sent back, with the reason given** (Q14, 19 Oct): `review_state='changes'`, and the reason, which is the `notes` row the Reject wrote (below) | yes |
| Memory | `atomik_memory` entries, `active` only (the production's and the workspace's), as today | yes |
| Setup | **not an item.** The four `lib/setup.ts` layers and the detail layer (§2.3), resolved as today | always; cannot be removed |

```
production_record_items(
  workspace_id, id, production_id,
  item_kind TEXT NOT NULL CHECK(item_kind IN ('brief','script','script_change','beat','treatment','look','element','upload','reading','keep','rejection','memory')),
  ref       TEXT NOT NULL,      -- '<table>:<id>' of the item's truth, e.g. 'elements:<id>', 'reading_notes:<id>'
  source    TEXT NOT NULL CHECK(source IN ('derived','person','atomik')),   -- how it entered the record
  source_job_id TEXT,           -- quoted_jobs.id when a paid job produced the item (a reading, a breakdown)
  pinned_at INTEGER, pinned_by TEXT,
  pinned_version TEXT,          -- documents, treatment and element items: hold this version instead of following the current one
  removed_at INTEGER, removed_by TEXT,
  created_at, updated_at,
  PRIMARY KEY(workspace_id, id),
  UNIQUE(workspace_id, production_id, ref))
INDEX (workspace_id, production_id, item_kind)

reading_notes(                           -- written once, never updated
  workspace_id, id, production_id,
  upload_id TEXT NOT NULL, import_id TEXT,   -- uploads.id; document_imports.id when it came through import
  source_sha256 TEXT NOT NULL,               -- the bytes it read
  job_id TEXT NOT NULL,                      -- quoted_jobs.id, product 'reading': the billed reading that wrote it
  body TEXT NOT NULL,
  created_by, created_at,
  PRIMARY KEY(workspace_id, id))
INDEX (workspace_id, production_id, upload_id, created_at)
UNIQUE (workspace_id, source_sha256)        -- once per file (Q26): the same bytes are read once in the workspace
```
- **A row exists only when an item was touched.** That means pinned, removed, or added by hand: a workspace element Atomik should carry, or a memory entry. An item derived from the production's own rows and never touched has no row and is carried.
  - So nothing has to be kept in step: a new Brief version, beat or keep is in the record the moment its own row exists.
  - **Removed** = `removed_at` set: not carried, still listed, and Undo clears it.
  - **Pinned** = always carried, and held at `pinned_version` when one is set.
- **"Source"** is shown per item. Derived items give their truth (for example "Brief v3", or "brandbook.pdf, read 18 Oct"); added ones give who added them. A paid item names its job, so the record can say which reading or breakdown it came from, without a price.
- **Free to read** (owner: "free").
  - `productionRecord()` calls no model and writes nothing.
  - Viewing it, and Atomik loading it into a job, adds no job row and no meter row.
  - Reading an upload for understanding stays a billed Reading job (brief rule 3). Its output is kept in `reading_notes` (Q26, 19 Oct: "once per file; no shot triggers a reading"):
    - one reading per file (`source_sha256`) in the workspace; `production_id` names where it was read, and every production holding that upload carries the same notes;
    - a shot, and any job a shot starts, only reads `reading_notes` and never starts a Reading job;
    - the reading store refuses a second Reading job for the same SHA-256 (the UNIQUE). A fresh reading of a changed file is a new file, with a new SHA-256;
    - a test asserts that composing a shot over an unread upload starts no job.
  - A test runs the read model over a fixture production and asserts that every table in both databases is row-for-row unchanged.
- **Setup is not copied.**
  - The production's Setup stays `projects.setup` (written by `setProductionSetup`, `lib/setup.ts`), and its format stays `projects.format`.
  - The record shows them, but it does not hold them and cannot remove them. That is rule 13's "what the brief sets carries into every shot", with no second copy.
  - `treatments.setup` is read only as part of the Treatment item, never as a Setup layer. Accepting what it proposes writes `projects.setup` through the one writer.
- **Tenancy.**
  - Both tables live in the workspace database with `workspace_id` first in every key.
  - A `ref` resolves only in that database, and one that does not resolve reads as gone.
  - Reading the record needs `mayReachProject(…, "read")`; pinning, removing and adding need `"admit"`. A production the person may not reach answers as one that does not exist.
- **Who marks (Q25, 19 Oct: "both, each shown with who, with Undo").** A person or Atomik may pin, remove or add. Each mark is shown with who made it (`pinned_by`, `removed_by`, read through `readableActors`), and Undo clears it. None is a money action (rule 11).
- **The reason a take was sent back (Q14).** Today the board's Reject writes the `changes` mark (PATCH `/api/jobs/:id`) and then the reason as a `notes` row on the take (POST `/api/notes`, `components/graphite/board/cards/take/use-judge.ts:17-18,74-83`). These are two requests with no link between the two rows.
  - v30's Reject writes both in one server write, plus one additive column, `generations.review_note_id` (the `notes.id` of the reason), so the record reads the exact reason.
  - Takes sent back before v30 read their newest note by the person who sent them back, written at or after `reviewed_at`, and say "reason not linked" when there is none.
  - The reason codes in `lib/rejectReasons.ts` are not stored anywhere yet; storing them is a separate PR.

### 2.8 Kept, Sent, and the commit (17 Oct #12; 18 Oct (b); Q12 and Q13, 19 Oct)
The owner:
- 17 Oct #12: "Kept means the user pressed Keep on a take. Picked is choosing among options and is a step on the way; approved is not a separate state."
- 18 Oct: "Sent status with its step (Draft · Kept · Sent → step), distinct from Kept".
- 19 Oct, Q12: "Keep is a separate mark (kept_at, kept_by), not today's approved. Today's approved is a commit; the commit is Sent. Every reader of 'approved' (export, review links, shot locks) follows Sent on output steps and Kept on Look and Elements. Name each reader in its PR."
- 19 Oct, Q13: "yes and yes: Send does not need Keep; a card shows both."

**What the code records today.** `generations` has `review_state` ('' \| `picked` \| `approved` \| `changes`), with `picked_by`/`picked_at` and `approved_by`/`approved_at`, each written with its own moment (`app/api/jobs/[id]/route.ts:232-251`). Approving is people-only (route line 113), and only a person can undo an approval (line 165). There is no Keep press and no `kept_at` anywhere in `lib/` or `app/`.

**Ground rule 4, and how this extends rather than replaces.** Rule 4 keeps "draft → picked → approved". The owner's answer keeps all three, and gives each its v30 meaning:
- **draft** is draft;
- **picked** is "choosing among options … a step on the way" (the chosen take of an Options job, §4.1);
- **approved is the commit, and in v30 the commit is Sent.**

Keep is a new, separate mark beside them. Nothing is renamed and no column is rewritten. Productions on the team canvas keep reading and writing `review_state` exactly as today; only `canvas_store='v30'` productions use the v30 marks (§2.4). The 18 Oct proposal (Keep = approved, plus `approved_via`) is withdrawn.

**Kept: `generations.kept_at INTEGER`, `kept_by TEXT`** (additive, nullable).
- **Keep** sets both: the person, and the moment.
- **Undo, or Keep pressed again,** clears both. Kept means a person said "this one", which is a mark, not a thing made, so clearing it erases nothing that was made (rule 13). The take's activity line still says who kept it and when.
- **Keep is a person's alone**, as the owner's words say ("the user pressed Keep"). `agent:*`, API and MCP tokens are refused on the server, and Atomik can prepare and explain a Keep. It moves no money.
- **Keep writes nothing else.** It does not touch `review_state`, `picked_*` or `approved_*`, and it never writes a filing.
- Takes kept before v30 do not exist: no take has `kept_at` until a v30 Keep.

**Sent: a filing with its step, and the commit.**
- `take_filings` (§6.5) gains `filed_as TEXT NOT NULL DEFAULT 'filed' CHECK(filed_as IN ('filed','sent'))` and `from_step_id TEXT`.
- A send writes one filing row with `filed_as='sent'` and the target `step_id`. The card shows "Sent → <step label>" from its newest live sent filing.
- **Send does not need Keep, and a card shows both** (Q13): "Kept · Sent → Edit". The send path never writes `kept_*`.
- **Send is a person's alone (changed 19 Oct).** It is today's approval under its v30 meaning, and approval is people-only today (route line 113). `agent:*`, API and MCP callers are refused, and Atomik can prepare a send. The 18 Oct draft let Atomik send; that is withdrawn with Q12.
- **Undo** stamps `removed_at` on the filing.
- The take's home stays `generations.project_id` / `shot_id` (§6.5). Sending to a step in another production needs `"admit"` on both.

**The commit: one predicate, `committedSql(alias)`** (a new pure SQL helper, the only place the rule is written). A take is committed when:
- its production is on the team canvas (`canvas_store` NULL or `team`) **and** `review_state='approved'`, which is today's rule, unchanged; or
- its production is `v30`, **and** either:
  - its card sits in an **output step** and it has a live `sent` filing; or
  - its card sits in a **Look or Elements step** (step kinds `look`, `elements`) and `kept_at` is set.

A step's role comes from the film-type config: each step there carries `commit: 'kept' | 'sent'`, with `kept` for `look` and `elements` and `sent` for all others. Which of the other input-like steps count with Look and Elements (Product, Creator, Set map, Swap-ins, Track, Source) is a reading, flagged in §9.2 (R3).

**Every reader of "approved" or "picked" on takes** (`origin/release/1` at `b77296a2`). Each reader's PR names its line(s) here and moves it to `committedSql` (or, for "picked", says what it reads in v30). None changes for a team-canvas production.

| Reader | file:line | What it reads today |
|---|---|---|
| Selects export | `app/api/export/selects/route.ts:35` | `review_state = 'approved'` |
| Review link: the take set | `lib/security/review-link.ts:112` | approved; `review` scope also picked |
| Review link: one take's state | `lib/security/review-link.ts:139,165` | `review_state` → approved \| review |
| Review page | `app/api/review/[token]/route.ts:42` | approved |
| Review media | `app/api/review/[token]/media/[genId]/route.ts:34-36` | approved; `review` scope also picked |
| Review notes | `app/api/review/[token]/notes/route.ts:29` | the set above (`takeInSet`) |
| Shot lock: the shot's approved take | `lib/shots.ts:163-171` | approved, newest `approved_at` |
| Re-render impact | `lib/impact.ts:200-201`, `lib/impactChoice.ts:59` | approved ("Re-render approved only") |
| Attribute change clears approvals (a writer) | `app/api/rig/attributes/[id]/current/route.ts:124-130` | sets approved → '' |
| House style | `lib/housestyle.ts:62` | approved |
| Project list counts and activity | `app/api/projects/route.ts:68,71,93,108` | approved; picked |
| Productions "needs you" | `lib/productions.ts:99` | picked |
| Shot list state | `app/api/shots/route.ts:70-82` | approved, picked |
| Binding versions order | `app/api/rig/bindings/[id]/route.ts:65-86` | approved first, then picked |
| Provenance | `app/api/rig/provenance/[id]/route.ts:25,43` | `review_state` |
| Take listing | `lib/jobs.ts:227-234` | `review_state`, picked and approved marks |
| Recorded demo | `lib/demo/recorded.server.ts:46,57` | approved |
| Starter production (writers) | `lib/starter.ts:125-128`, `lib/workbench/starter-draft.ts:98,106` | writes and reads approved |
| Take status words (client) | `lib/workspace/takes.ts:103` | `reviewState` |
| Board take card and judge (client) | `components/graphite/board/cards/take/take-model.ts:152,290,311`, `use-judge.ts:59-62` | approved; one approved per shot |
| Cut, review, crew, phone (client) | `components/graphite/board/cards/cut/cut-model.ts:53`, `components/graphite/board/review/review-model.ts:43`, `components/graphite/board/review/crew-model.ts:51`, `components/graphite/phone/cut-model.ts:25`, `components/graphite/phone/PhoneCutScreen.tsx:60`, `components/GenCard.tsx:134` | approved |
| The review write itself | `app/api/jobs/[id]/route.ts:113,160-165,232-259` | writes `review_state` and its marks |

Not readers of a take's approval, and so left alone: plan and spend approvals (`lib/workbench/plan-approval.ts`, `rig-agent*`, `lib/control-room/approvals.server.ts`) and top-up requests (`lib/topups.ts`).

**Picked readers in v30.** "Picked" keeps its meaning (the chosen option). Readers that use "picked" to mean "waiting for a decision" (`lib/productions.ts:99`, `app/api/projects/route.ts:71`, the review link's `review` scope) read, in v30, "kept and not yet sent". Each PR says so.

### 2.9 Make nodes typed by output, children, groups (18 Oct (c); Q15, Q19, Q24, 19 Oct)
The owner, 18 Oct: "make nodes typed by output (Image · Storyboard sheet · Video · Audio · Lip-sync · Script revision · Deck page · Upscale · Layers) with inputs as rows, bundles of cards, and the shot as the card that holds its takes".

**A make node is a plate (`kind='plate'`) with an `output_kind`.** What it makes decides the following:

| `output_kind` | Its versions are | Accepted `input_role`s | `quoted_jobs.product` |
|---|---|---|---|
| `image` | takes (`generations`, kind image) | cast, frame, angle, camera_move, environment, prop, brand, product, look, text | `generation` |
| `storyboard_sheet` | takes (kind image, job label `storyboard`); each panel becomes a frame inside its shot's card (§2.6) | panel, plus the image roles | `generation` |
| `video` (a shot card when it has `shot_id`) | takes (kind video) | as image, plus audio | `generation` |
| `audio` | takes (kind audio) | text, audio, cast | `generation` |
| `lip_sync` | takes (kind video) | source, audio, cast | `generation` |
| `upscale` | takes (`task='upscale'`) | source | `upscale` |
| `layers` | takes (proposed: a take with `task='layers'`, like an upscale; confirmed when the Layers engine is chosen) | source | `layers` |
| `script_revision` | proposed `document_changes` on the Script (with a new `document_changes.job_id`) | text, source (a document) | `writing` (Q24, 19 Oct) |

- **The store refuses a role an output does not accept**, so a wire that cannot be used is never written.
- **Deck page is not a canvas output (Q19, Q24, 19 Oct).** "No deck pages as canvas cards": a deck page is made inside the Treatment step's `deck` surface (§2.10).
  - It is **one quoted job per page, covering its words and its pictures**: one `quoted_jobs` row with `node_id` NULL and `source_ref` naming the treatment version and page. Its pictures are not separate image jobs.
  - Its product is not named by the owner, and it waits with the rest: **nothing is built for deck pages before the Polotno spike**, which settles the page format (one JSON per page).
- **The shot is the one card that holds its takes, frames and variants.** Children are `canvas_nodes` rows drawn inside their parent, never as cards of their own:
  - **frame** (`frame_of` = the shot card, `frame_role` start \| end \| key): a still that sets a frame of the shot. It is `kind='still'` for an upload, a Library take or a Storyboard sheet's panel (a crop, §2.6), or a plate with `output_kind='image'` when it is made there. It also feeds the shot through a `plate_inputs` row with role `frame`, the slot `keyframe` in `bindings`.
  - **variant** (`variant_of` = the parent card): a branch of the same shot developed alongside it ("the same shot, wider"). It is a plate with the parent's `output_kind` and `shot_id`, with its own takes (`generations.node_id` = the variant).
  - **Options are not variants.** An Options chip is one job whose takes are versions of the same card (§4.1).
  - Children are one level deep: a child has no children, and the store refuses one.
  - The UNIQUE in §2.3 allows one top-level card per shot per step. A frame or variant can never become a second shot card.
- **Groups (the brief's "bundles of cards").**
  - A `kind='group'` card has a title and a place. Its members carry `group_id`.
  - A card is in at most one group. A group is never in a group, and a child (frame or variant) is never a member of one.
  - Wiring a group into a plate writes one input row per member (§2.5).
  - Removing a group removes nothing inside it: its members lose `group_id` in the same write, and Undo puts them back.

### 2.10 Step lists per film type: the owner's final lists (19 Oct, "final for A1b")
The owner, 19 Oct: "every Script has the Beats view; Sound, Edit and Deliver sit behind + where they are not opened by default". His Q16–Q22 answers:
- Sound comes after Shots in every type with Shots and Edit, "reached from the + tile (Sound · Edit · Deliver)", and "does not change what a new production shows".
- Treatment is on by default for Ad film, Feature, Short film and Music video. For UGC, Product video, Microdrama, Pre-vis, Trend clip and Social it is off by default, on the + tile's list.
- Pitch deck folds into Treatment: "One deck per production."
- Treatment is a third surface, `deck`.
- Pre-vis gets a Script opened on the Beats view.
- Microdrama is unchanged in Phase A.
- Format breakdown and Beat map are untouched.

**The two parts of a list.**
- **Opened** steps are the ones a new production shows: `ensureSteps` creates their rows.
- **"+"** steps are listed in the film type, in their place, but not opened. A person (or Atomik) opens one from the + tile, and that creates its row.

In config, each step gains **`opened: boolean`** (default `true`) and **`commit: 'kept' | 'sent'`** (§2.8). `add()` already accepts only a kind the film type lists. A1b changes it to put the new step at **its list position**: after the nearest earlier listed step the production has, instead of at the end of the rail.

| Film type | Opened in a new production | Behind the + tile (not opened) |
|---|---|---|
| Ad film | Brief · Script · Treatment · Look · Elements · Storyboard · Shots | Sound · Edit · Deliver |
| Feature | Brief · Script · Treatment · Look · Elements · Storyboard · Shots | Sound · Edit · Deliver |
| Short film | Brief · Script · Treatment · Look · Elements · Storyboard · Shots | Sound · Edit · Deliver |
| Music video | Track · Beat map · Treatment · Look · Elements · Storyboard · Animatic · Shots | Sound · Edit · Deliver |
| Product video | Brief · Product · Look · Storyboard · Shots | Sound · Edit · Deliver; Treatment |
| UGC | Brief · Creator · Hook · Script · Shots · Captions · Deliver | Treatment |
| Microdrama | Series bible · Episodes · Elements · Storyboard · Shots | Sound · Edit · Deliver; Treatment |
| Pre-vis | Brief · Script · Set map · Elements · Storyboard · Animatic · Shots · Handoff | Treatment |
| Trend clip | Source · Format breakdown · Swap-ins · Copy · Shots · Captions · Deliver | Treatment |
| Social | Deliverables · Hook · Copy · Design · Visuals · Captions · Deliver | Treatment |

- **Surfaces.** Brief and Script are `document`; Treatment is **`deck`**; Deliver is `table`; every other step is `canvas` (Handoff included).
- **"+ Sound · Edit · Deliver" is read as all three behind the + tile**, from the owner's sentence above and Q16's "+ tile (Sound · Edit · Deliver)". If he meant only Sound behind +, with Edit and Deliver opened, only the `opened` flags change. Flagged in §9.2 (R1).
- **Where an optional Treatment goes when it is opened.** The lists name Treatment as optional but give it no place.
  - In UGC and Pre-vis it goes right after Script ("Treatment as its own step after Script", 18 Oct (d)).
  - In types with no Script (Product video, Microdrama, Trend clip, Social), the plan puts it right after the first step, the client's material. Flagged in §9.2 (R1).
- **Every Script has the Beats view** (UGC and Pre-vis included). Beats live under the Script (§2.6), and no type has a Breakdown or Beats step. **Pre-vis's Breakdown becomes Script** (Q20).
- **Untouched:** Trend clip's Format breakdown and Music video's Beat map (Q22); Microdrama's Episodes (Q21).
- **Pitch deck is gone from Ad film (Q18).** Its deck is the Treatment step, "with the ad film's section library". **One deck per production** is already enforced by `treatments.project_id UNIQUE` (`lib/db.ts` treatments). The section library is per-film-type deck config, settled with the Polotno spike, and names no workspace or client (rule 3).
- **The `deck` surface (Q19).**
  - The Treatment step's content stays in `treatments` + `treatment_versions`, the only truth. The step row only gives it a place on the rail.
  - It has no frame, and its pages are not canvas cards. The page format, one JSON per page, is settled by the Polotno spike.
  - A deck page is made by one quoted job per page (§2.9).
  - This supersedes 17 Oct #14's "the deck inside Look".
- **Where it is enforced:**
  - `FILM_TYPES_DEFAULT` (and `V30_FILM_TYPES` where a deployment sets it, whose schema gains `opened` and `commit`);
  - `STEP_SURFACES` and the steps table's CHECK, which gain `deck` (§2.2);
  - `add()` placing a step at its list position.
- **Productions that already have steps keep them.** `ensureSteps` never rewrites a production's rows, so a production made from the 17 Oct list keeps its Breakdown and Pitch deck steps until a person removes them. The switch is off everywhere but the house, so this is at most the house's test productions. A test asserts it.

---

## 3. Item 2: Brief and Script documents (tables only)

Today a script lives inside a person's private draft (`workbench_projects.body`). Its published form is `workbench_bibles(project_id, version)`. The uploaded original is kept untouched as an upload with its SHA-256 (`docs/screenplay-import.md`). `treatments` + `treatment_versions` hold Atomik's treatment, one per production. None of these is a shared, versioned Brief or Script, so the documents are new tables. Nothing is moved out of the old ones in Phase A.

```
production_documents(
  workspace_id, id, production_id, step_id,
  kind TEXT NOT NULL CHECK(kind IN ('brief','script')),
  title, current_version_id,             -- the pointer, like element_attributes.current_id
  created_by, created_at, updated_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, production_id, kind) WHERE removed_at IS NULL

document_versions(                        -- immutable: written once, never updated
  workspace_id, id, document_id,
  number INTEGER NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('fountain','markdown')),   -- Script: Fountain, the internal format
  body TEXT NOT NULL, sha256 TEXT NOT NULL,
  parent_version_id TEXT, import_id TEXT, change_id TEXT,         -- where it came from
  created_by, created_at,
  PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, document_id, number))

document_changes(                         -- tracked changes, diffed by us
  workspace_id, id, document_id,
  base_version_id TEXT NOT NULL,
  span_start INTEGER NOT NULL, span_end INTEGER NOT NULL,
  before_text TEXT NOT NULL,              -- must equal the base's slice; checked on write
  after_text  TEXT NOT NULL,
  author TEXT NOT NULL,                   -- a person, or agent:atomik
  command_id TEXT,                        -- agent_commands.id when Atomik proposed it
  job_id TEXT,                            -- quoted_jobs.id of the Writing job that proposed it (a Script revision node, §2.9)
  state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','stale')),
  decided_by, decided_at, result_version_id,
  created_at, PRIMARY KEY(workspace_id, id))
INDEX (workspace_id, document_id, state)

document_imports(
  workspace_id, id, production_id, document_id,
  upload_id TEXT NOT NULL,                -- the original, stored untouched
  converter TEXT NOT NULL CHECK(converter IN ('docx','pdf_text','fdx','pptx','xlsx','image_ocr','fountain','text')),
  state TEXT NOT NULL CHECK(state IN ('queued','converting','done','failed')),
  run_ref TEXT,                           -- the Inngest run, when the pipeline lands
  result_version_id TEXT, error TEXT,
  created_by, created_at, updated_at, PRIMARY KEY(workspace_id, id))
```
- **Accepting a change makes a new version.** Nothing edits a version in place. If the current version is no longer the base, the change is re-placed by finding `before_text` again; if that fails, it becomes `stale`. Undo is accepting the reverse.
- **Converting a file is free** (an upload is never billed). **Reading it for understanding is a billed job**: a `quoted_jobs` row with product `reading`, whose `source_ref` names the import (section 4). Its output is a `reading_notes` row (§2.7).
- **A person's own edits are never billed** (brief rule 3). A change with a person as author has no `job_id`.
- **The Script's Beats view** reads `script_beats` (§2.6); it is part of the Script document, not a document of its own.
- Sizes: a long feature script is a few hundred KB per version, which is fine as a row for Phase A. Moving bodies to storage later is an additive change.
- **Q4, answered (17 Oct #14):** "The Brief is new: a document step for the client's material." The treatment is not the Brief. Since 18 Oct it has its own step after Script (§2.10).

---

## 4. Item 3: jobs, commands, receipts, spend limit

**The 18 Oct money behaviour this section supports** (owner, 18 Oct: "decided 18 Oct, supersedes 16–17 Oct"):
- a Preflight card before every quote;
- everything Atomik makes is charged and quoted first, including plans, research, analysis and text revisions, as Reading · Research · Analysis · Writing bands;
- the quote and the Preflight card are free;
- Atomik's own check of its work is free and never a line;
- Enhance has no Undo; since 19 Oct it is priced as it costs and shown before pressing (below);
- "Options" is a priced chip;
- Agent History has one line per command;
- no engine name appears anywhere in Agent mode, History included.

The tables support these rules; no figure is in this plan.

### 4.1 `quoted_jobs` (new, workspace database)
```
quoted_jobs(
  workspace_id, id,
  production_id, step_id, node_id, command_id,
  decider TEXT NOT NULL CHECK(decider IN ('agent','director')),
  product TEXT NOT NULL CHECK(product IN ('generation','reading','research','analysis','writing','layers','enhance','render','upscale')),
  band    TEXT,                 -- reading/research/analysis/writing, and enhance (19 Oct): the band key from the pricing config it was quoted in; NULL otherwise
  engine  TEXT,                 -- PRIVATE: read only by lib/jobView.ts (4.4)
  options INTEGER NOT NULL DEFAULT 1 CHECK(options >= 1),   -- takes this one job makes (an Options chip is >1)
  preflight    TEXT NOT NULL,   -- JSON: the Preflight card's checks, below
  preflight_at INTEGER NOT NULL,
  quote_tenths INTEGER,         -- credits x 10, the price shown before it ran; credit workspaces
  quote_usd    REAL,            -- only where credits do not apply (the house, own keys); never sent to a credit workspace
  quoted_at INTEGER NOT NULL,
  approved_by TEXT, approved_at INTEGER,   -- a person's approval of this job on its own (Director, an Options chip); NULL when its command's approval covers it
  meter_id TEXT,                -- meter_events.id, for a job that is not a take (enhance, reading …)
  take_id  TEXT,                -- generations.id, for a job of exactly one take (see Options)
  source_ref TEXT,              -- the product's own row: paid_text_jobs:<id>, workbench_development_jobs:<id>, document_imports:<id> …
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  refund_status TEXT CHECK(refund_status IN ('billed','refunded','not_charged','unknown')),   -- NULL until it fails or is cancelled; INTERNAL
  error_public TEXT,            -- the sentence a person sees; never a vendor's words for an Agent job
  created_by, created_at, started_at, finished_at, updated_at,
  CHECK (preflight_at <= quoted_at),
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, meter_id) WHERE meter_id IS NOT NULL
INDEX (workspace_id, production_id, created_at)   INDEX (workspace_id, command_id)
INDEX (workspace_id, step_id)   INDEX (workspace_id, take_id)   INDEX (workspace_id, created_by, created_at)
```
**Preflight before every quote (18 Oct; new).**
- The Preflight card is computed first. Its result is stored on the job in the same insert as the quote, so no job exists without the preflight it was quoted after (`CHECK preflight_at <= quoted_at`).
- `preflight` is JSON. It holds one entry per check, each `pass` \| `warn` \| `stop` with a plain sentence:
  - **inputs**: every input the output needs (§2.9) is present and readable;
  - **consent**: every real person's face or voice among the inputs has consent recorded (`identities.consent_at`, `soul_identities.consent_at`). Recording consent is a person's alone (rule 11);
  - **resolution**: the resolution and length the job will make, listed;
  - **balance**: whether the balance covers the quote, as enough or short, never the balance itself. Rule 14: checked before it starts, with Top up offered then, never halfway;
  - **cap** (19 Oct, #815): whether the job's whole total would pass a workspace cap, as within or over, never the cap's figure.
    - For a press of several shots (#815's batch press), the total is the press's sum, not each shot's quote.
    - Over is a `stop`, shown with the pause card, and no shot starts (owner, 19 Oct: "If a press's total would pass the workspace cap, refuse at the quote with the pause card; no shot starts").
    - Which caps apply is what #815 already judges per shot; this check judges the same caps on the sum, at the quote.
- **A preflight with any `stop` writes no job and gets no quote.** It is returned to the card only. Nothing is spent, so nothing is recorded.
- **The preflight and the quote are free.** Computing either writes no meter row, no reservation and no receipt. A test runs them and compares every table in both databases.
- **No engine in an Agent job's preflight.** It goes through `lib/jobView.ts` like every other field (4.4).
- **Where it is enforced:** the job store refuses an insert without `preflight`. Admission (A10) refuses a spending action whose job has no quote, or whose preflight has a `stop` (brief rule 4, extended).

**Options is one job, one approval (18 Oct; changed).**
- An Options chip is one `quoted_jobs` row with `options` = N, one quote for the whole chip, and one approval: `approved_*` on the job, or its command's approval.
- Its takes all carry the job in **`generations.job_id`** (new, additive, indexed). That column is the truth for which job made which take, many per job.
- `take_id` is kept only for a one-take job. It is written in the same admission write as the take, and a test asserts it equals the take's `job_id`.
- For a job's takes, `meter_id` stays NULL: each take is metered under its own id, as today, and the job's actual is the sum of their receipts.
- Admission refuses take N+1 of a job in the same write that counts its takes.
- Picking one option writes today's `picked` (§2.8).

**Approval is a person's.**
- `approved_by`/`approved_at` are written only by a person, and the job store refuses `agent:*`, API and MCP callers, as `rig_plan_approvals` does (`lib/workbench/plan-approval.ts`).
- An Agent job under a command is covered by the command's approval (4.2), and its own columns stay NULL.
- Guardrail 4 and `askBeforeEveryTake` (4.6) apply as they say.

**What is not on the row, and where it is read from**

| Brief's field | Truth | Why not on `quoted_jobs` |
|---|---|---|
| actual | `meter_events.billed_credits`, read in the workspace through its replica `credit_receipts(event_id, credits)` (`lib/creditReceipts.ts`: "the meter remains authoritative"); for a job of takes, the sum over `generations WHERE job_id=?` | The meter is the money truth. |
| vendor cost | `meter_events.engine_cost_usd` (platform database, admin desk only) | A customer never receives a vendor cost (CLAUDE.md § Pricing). |

**Fields that another row also holds** (the job is upstream; the other row is written from it in the same write):
- **`quote`**: a take already keeps its quote in `generations.params.quote` (`quoteSnapshot`, `lib/generationAdmission.ts:230`; step-0 plan item 4).
  - With the wiring flag on, admission writes `params.quote` from the job's quote in the same batch as the take insert. Both are in the same database, so they cannot disagree.
  - Read models read the job. They read `params.quote` only for takes that have no job (made before v30).
- **`engine`**: `generations.model` and `meter_events.model` are written from the job's engine at admission, as today.
- **`refund_status`**: a projection of the provider's billing state, `BILLING_STATES` in `lib/providerOutcome.ts`, the same four values.
  - It is written once, at settlement, by one mapping function, from the same `ProviderOutcome` that `meter()` and `generations.provider_outcome` receive.
  - **It is internal** (owner, 17 Oct 18:00 #4: "A refunded failure shows 0 cr on the receipt and the word refund never appears; vendor refunds stay internal"). No customer read model carries it or the word "refund". `provider_outcome` stays for the admin desk and today's take card.
  - A test asserts the two agree for every settled fixture.
- **`status`**: for a generation job, it follows `generations.status`. An `AFTER UPDATE OF status` trigger on `generations` sets it, the same idiom as `gen_settled_on_status` (`lib/db.ts:1215-1229`). The trigger is installed only by the wiring PR. For other products, the job's writer sets it.

**Money behaviour does not change.** `refund_status` records what the vendor did. Today's billing of failed and cancelled jobs stays exactly as it is. Making the bill follow the refund status (brief rule 3: "0 when the vendor refunds it") is a later money change that needs sign-off (Q11, answered: "Agreed, not yet").

**A3 (open, not merged) and these changes.** A3's table has `take_id`, a NOT NULL quote and a trigger that fixes the quote. The 18 Oct columns (`band`, `options`, `preflight`, `preflight_at`, `approved_by`, `approved_at`) and `generations.job_id` go in as one follow-up PR:
- into A3's `CREATE TABLE` if A3 has not merged;
- else by `addColumn`, nullable, with the job store refusing an insert that lacks them.

### 4.2 `agent_commands` (new, workspace database)
```
agent_commands(
  workspace_id, id, production_id, step_id,
  instruction TEXT NOT NULL,        -- the person's words
  quote_tenths INTEGER, quote_usd REAL,   -- the total shown before it ran (the plan's total)
  approval_ref TEXT,                -- rig_plan_approvals.id when a plan was approved
  run_ref TEXT,                     -- rig_agent_runs.id / atomik_chats.id that carried it out
  state TEXT NOT NULL CHECK(state IN ('quoted','approved','running','done','failed','cancelled','declined')),
  created_by, created_at, updated_at, PRIMARY KEY(workspace_id, id))
INDEX (workspace_id, production_id, created_at)   INDEX (workspace_id, created_by, created_at)
```
- **The total is never stored.** It is the sum of its jobs' `credit_receipts`.
- **The plan is one of its jobs (18 Oct; Q23, 19 Oct: "questions are free and write no job; a plan is a Writing job, quoted first").** Atomik's plan for a command is a `quoted_jobs` row under the command, product `writing`, quoted before it is made, like any other job.
  - Atomik's questions before a plan write no job and no meter row. A test asks questions on a mocked command and asserts that nothing was written.
- **Atomik's own check of its work is never a job (18 Oct).**
  - The product list has no value for it, and the command's total is the sum of its jobs, so it cannot appear as a line.
  - A test runs a mocked command with a self-check and asserts that the check added no job row and no receipt line.
  - Where today's code bills a step that this rule makes free, the charge stays until sign-off (owner, 17 Oct #8: "a charge going away is still a money change") and is listed for the money PR.
- **The approval stays in `rig_plan_approvals`**, the person-only row with its guard triggers (`lib/workbench/plan-approval.ts`). A command points at it and copies nothing from it.
- **The executor's copy:** `rig_agent_runs.goal` stays as the executor's working input. History reads the command.

### 4.3 Receipts per step (a read model, no table)
`stepReceipt(productionId, stepId)` returns one line per job:
- the product (and band);
- the quote;
- the actual (from `credit_receipts`);
- the status;
- the card it made.

Its total is the sum of the actuals.
- It is built through `lib/jobView.ts`, so Agent lines carry no engine.
- **It carries no refund status and never the word "refund"** (owner, 17 Oct 18:00 #4). A failure that was not billed shows its actual, which is 0. A failure that was billed shows what it cost (rule 14).
- Atomik's own check never appears (4.2).
- **Enhance (18 Oct: no Undo; 19 Oct: "price as it costs, shown before pressing").** An Enhance job is quoted from the prompt before the press, like every other job.
  - The quote comes from the prompt's own size, in the pricing config's enhance bands, stored in `band`. A longer prompt, or one in a heavier script, can quote more.
  - The owner: "No byte cap on the prompt, no lower reasoning allowance." So the quote path never trims the prompt to fit a price.
  - **The quote path is built; the number is not.** "The final figure comes from the business manager." Until then the bands are named placeholders in server config, and today's Enhance charge stays exactly as it is.
  - No Undo is offered for it, because the charge stands. The text it replaced is not erased (rule 13).

### 4.4 Rule 1 (an Agent job never shows its engine): where it is enforced
- **One serializer, `lib/jobView.ts › publicJob(row, joins)`.** It is the only code that turns a `quoted_jobs` row (with its take, provenance, preflight and receipt) into JSON, CSV or a sentence. Every v30 read model uses it: History (Agent and Director), aggregates, CSV export, step receipts, preflight cards, error lines, and the "recreate" recipe.
  - `decider='agent'`: no engine, model or provider. No engine-named settings (`params.model`, `take_provenance.recorded.engine/model/provider`). Failure lines get `provider: null`, so `billingSentence` (`lib/errors.ts`) says "The provider" and never a name. The recipe's engine is empty, so Recreate hands Director an empty engine (brief rule 6).
  - `decider='director'`: everything it chose (engine label, settings, inputs, prompt).
  - **Rows backfilled from before History** (§5) have no decider. They are served with the Agent rule, so they show no engine (owner, 18 Oct: "no engine name in Agent mode anywhere, History included").
- **Tests**
  1. *Response test:* synthetic Agent and Director jobs whose engine values are sentinel strings made in the test. Every read model and the CSV are run over them. The Agent rows never contain the sentinel or any model id in `lib/models.ts`. The Director rows do contain it.
  2. *New source guard (stricter only):* no file but `lib/jobView.ts` and the job store may name `quoted_jobs.engine` in SQL.
- **Leaks that exist today and need the serializer once Agent jobs exist** (Phase B, listed so nothing is missed):
  - `lib/jobs.ts` `listGenerations` (model);
  - `lib/exportRows.ts` (the `engine` column, and the default filename template's `{model}`, `lib/settings.ts`);
  - MCP `get_render` / `list_renders`;
  - the provenance card;
  - `lib/errors.ts` `billingSentence` (it names the provider);
  - the jobs tray;
  - Usage `byEngine`;
  - `lib/workspaceExport.ts` (it exports `generations.*`, model included, and `take_provenance.recorded` with engine, model and provider for every take). Must use the serializer before A10 (A3 review, 17 Oct).

### 4.5 Which existing paths would write a job row (later, flag `V30_JOB_WIRING`, OFF)

| Path | Product | `meter_id` / takes |
|---|---|---|
| Generation admission (`lib/generationAdmission.ts` → `reserveGenerationSpend`) | `generation` (`upscale` when `task='upscale'`) | takes by `generations.job_id`; `take_id` for a one-take job |
| Enhance (`app/api/prompt/enhance/route.ts` → `lib/paidText.ts runPaidText`, kind `enhance`) | `enhance`, quoted from the prompt (19 Oct) | the `paid_text_jobs` id |
| Deck page (after the Polotno spike) | one job per page, words and pictures together (Q24) | new |
| Atomik's plan (`lib/workbench/rig-agent.ts` `planEvent`; chat turns `lib/atomik.ts:1052`) | `writing` (Q23, 19 Oct); **charged and quoted (18 Oct)**, superseding 17 Oct #8's "free in v30". Questions write no job | the meter id it already writes |
| Script breakdown into beats, and development (`lib/workbench/development-server.ts`) | `analysis` / `writing` | its job id |
| Document reading for understanding (new) | `reading` | new; output in `reading_notes` |
| Research (new) | `research` | new |
| Exports (the `export_jobs` work from #700; not on release/1 at `85cb7a07`) | `render`, if an export is billed | its id |

- **The rule for the wiring PR:** the job row, with its preflight and quote, is written before the reservation. Nothing in `meter_events`, `generation_reservations` or the billing ledger changes.
- **Its test:** the same fixtures run with the flag on and off produce identical meter rows, reservations, balances and refusals.
- **When:** after 31 Oct (Q9, answered 17 Oct #18).

### 4.6 Monthly spend limit and paused state (workspace settings; no behaviour in Phase A)
**As built in A4, with the owner's 17 Oct answers (items 3 and 17; update two #5; 18:00 #3).** Three keys in the workspace's own `settings` table, **not** in `lib/settings.ts DEFAULTS`: `GET /api/settings` sends `DEFAULTS` to every member, and the general admin PATCH accepts any `DEFAULTS` key with no audit line. They have their own route, `app/api/settings/spend`, and are listed in `INTERNAL_SETTING_KEYS`.

| Key | Values | Default |
|---|---|---|
| `monthlySpendLimitCredits` | whole credits; `''` = no limit; the period is the calendar month in UTC, like the house cap | `''` |
| `spendPause` | `''` = running, else JSON `{at, by, reason: 'admin'\|'limit'}` | `''` |
| `askBeforeEveryTake` | `'on'` \| `'off'` | `'off'` (owner: approval happens once per step, on the quote) |

- **A person's alone.** Members, API and MCP tokens, `agent:*`, `server`, disabled users and no user are refused on the server (rules 11 and 14).
  - **Only the workspace owner may raise the limit, and removing it counts as raising it** (owner: update two #5, 18:00 #3). An admin may lower it, pause and resume.
  - A4 must match this before it merges. The session's `owner` flag (`lib/auth.ts`) is the check.
- **A pause for `limit` lifts by itself when the new calendar month starts, UTC** (update two #5). Nothing in Phase A enforces it; the later money PR does.
- **Each change writes an audit line** in the same batch. Five new actions go on `lib/securityAudit.ts`'s closed list: the limit, pause, resume, and ask on and off.
- **This is not the platform's walls.** `workspaces.allowance_usd` (`lib/allowance.ts`) and `workspaces.suspended_at` (`lib/platform.ts`) are the platform owner's. These keys are the workspace's own, in credits, set by its people. A pause reason of `limit` is written by the server; `admin` by a person.
- **Enforcement is a later money PR** (owner item 17): reaching the limit finishes the running job, starts nothing new, and shows Paused with Continue (the limit is raised) and Stop. The reservation would read the keys inside its own write, with an Opus money review and sign-off. Guardrail 4 applies whatever these say.
- **CLAUDE.md rule 14 says Ask is the default today.** When `askBeforeEveryTake` gets behaviour, the rule's text (and the SOW) must be amended to the owner's 17 Oct answer. The owner's 18 Oct note asks for a docs PR that brings CLAUDE.md to the 18 Oct money behaviour, not to the 16–17 Oct wording.

---

## 5. Item 5: history read models (what they read from)

All of them go through `lib/jobView.ts` (4.4), are read-only, sit behind flag `V30_HISTORY`, and read the workspace database only. The money comes from `credit_receipts` (call `syncCreditReceipts()` first, as `lib/exportRows.ts` does).

| Read model | Reads | Row links to |
|---|---|---|
| **Agent**: **one line per command** (18 Oct): instruction, production, step, date, total credits, the cards it made. Its plan job is inside the total, not a line of its own. | `agent_commands` ⟕ `quoted_jobs` (by `command_id`) ⟕ `credit_receipts` (by `meter_id`, and by take for jobs of takes) ⟕ `canvas_nodes` / `generations` (by `generations.job_id`, `node_id`) | the step's `page_id` and the node id |
| **Director**: itemised, with engine, settings, inputs, prompt | `quoted_jobs WHERE decider='director'` ⟕ `generations` (prompt, params) ⟕ `take_provenance.recorded` (engine, setup, ports = inputs) ⟕ `take_ports` ⟕ `credit_receipts` | the take's card |
| **Aggregates**: by production, member, month | `quoted_jobs` ⟕ `credit_receipts`, grouped by `production_id`, `created_by`, and month from `created_at` | the filtered History |
| **CSV** | the rows above, through `lib/csvCell.ts` and the same serializer; no refund column | — |

- **No engine in Agent mode anywhere, History included** (18 Oct). That covers the Agent lines, their CSV, their aggregates and their error sentences (4.4).
- Prompt text and instructions are shown to the workspace's own members. Product analytics read ids and timings only (rule 17).
- **Earlier work is included (Q7, answered 17 Oct #15):** "backfill from the meter records; rows missing a field show 'before History'".
  - The read model unions the workspace's settled meter rows that have no job (through `credit_receipts`) as rows with no decider, instruction or step. Each missing field reads "before History".
  - They follow the Agent engine rule (4.4).
  - Nothing is written to back-fill them: they are read where they are.
- Indexes: the `quoted_jobs` and `agent_commands` indexes in section 4, and `generations.job_id`, cover every filter above.

---

## 6. Item 6: Library

### 6.1 Extend `elements` (additive, nullable; backfilled once)
| Column | Values | Backfill |
|---|---|---|
| `handle TEXT` | `[a-z][a-z0-9_]{0,31}` | see 6.3 |
| `library_kind TEXT` | `character`, `environment`, `prop`, `wardrobe`, `brand`, `product`, `reference`, `audio` | from `kind`, see 6.2 |
| `origin TEXT` | `generated` \| `uploaded`, written once and never rewritten | `from_gen_id` set → `generated`; else the first version's source: `upload_id` → `uploaded`, **`identity_id` → `uploaded`** (changed 18 Oct), `gen_id` → `generated`; none → `uploaded` |
| `library_status TEXT` | `active` \| `draft` | `active`: every element is usable today |

Indexes: `UNIQUE (LOWER(handle)) WHERE handle IS NOT NULL` (the database is the workspace's, so this is unique per workspace) and `(library_kind)`.

**Origin of a trained likeness (owner, 18 Oct #7): "a trained likeness is 'uploaded' (a real person, carries the consent tick); anything made from it is 'generated'."**
- An element whose first version is an identity (`attribute_versions.identity_id`) is `uploaded`. Its consent is the identity's own (`identities.consent_by`/`consent_at`), read, not copied.
- A take made with that likeness, or an element promoted from such a take (`from_gen_id`, or a first version with `gen_id`), is `generated`.
- **As built (#820), this differs:** `originOf()` in `lib/elementLibrary.ts` returns `generated` for a first version with `identity_id`. The fix is one line in `originOf()` and its test, in a small PR before `V30_LIBRARY` goes on anywhere.
  - Rows already filled keep what they were given ("written once"). If the fill has run in any workspace with the switch on, those rows need a one-time correction limited to identity-first elements. That is the one rewrite of `origin`, and it would be named in the fix PR. Whether the fill has run outside tests is for the lead to check; it is not settled here.

**Also as built (#820), recorded:**
- The fill (`fillLibrary`, `lib/elementLibrary.server.ts`) is the backfill and the catch-up for elements made since. It only fills NULLs, so an element made after a fill gets its columns on the next fill, not at creation.
- It runs only with `V30_LIBRARY === "1"` and `newInterfaceFor(workspace)`.
- The unique handle index is created in the same batch as the fill's updates, after them. A handle clash with a concurrent fill is retried once.

### 6.2 Kinds: why `elements.kind` is not rewritten
- `elementKind()` (`lib/rig.ts:68`) reads any value it does not know as `character`. Writing `environment` into `kind` would make today's Rig bind every location as a character.
- So `library_kind` is the v30 kind, and `kind` becomes a compatibility value. One writer function sets both, and `kind` is never set on its own. **As built (#820):** nothing writes `kind` yet. `compatKindOf()` is the mapping that writer will use, and the fill never touches `kind`.

| Today's `kind` | → `library_kind` | Note |
|---|---|---|
| `character` | `character` | |
| `location` | `environment` | |
| `prop` | `prop` | |
| `voice` | `audio` | |
| `look` (and the cast's `style`) | **`reference`** | **Q8, answered 17 Oct #16:** "Reference, in the Look pack. Not wardrobe." It feeds plates in the `look` role and is the production record's look pack (§2.7). As built (#820): `LOOK_LIBRARY_KIND = 'reference'`, and `style` maps there too. |

New kinds take the nearest compatibility `kind`:
- `wardrobe`, `brand`, `product` → `prop`;
- `reference` → `look`;
- `environment` → `location`;
- `audio` → `voice`.

### 6.3 @handle: unique per workspace, without changing how @Name resolves
- **Today:** `expandCast` resolves `@Name` against `cast_members.name`, case-insensitive, within the production plus workspace-wide (`lib/cast.ts:44-56,104-146`). Its token grammar is `@[A-Za-z][A-Za-z0-9_]{0,31}`.
- **The handle grammar matches that grammar.** That is why the suffix is `_2`, not `-2`: `@maya-2` would be read as `@maya` followed by "-2".
- **Reserved handles:** `image<N>`, `video<N>` and `audio<N>`, because the engines' own citations are left alone. **As built (#820):** the bare words `image`, `video` and `audio` are reserved too (stricter).
- **Backfill rule** (once, in code, inside one write; idempotent: it only fills NULLs, so a crash is finished on the next run):
  1. Make the base: lowercase the name and turn each run of other characters into `_`, trimmed to 32 characters. A name that does not start with a letter gets its kind as a prefix (`prop_1920s_radio`). **As built:** accents are dropped first (NFKD), and a name with nothing usable in it is its kind alone.
  2. Order: workspace-wide elements first, then by `created_at`, then `id`.
  3. The first holder of a base keeps it (`@maya`). Later ones get `@maya_2`, `@maya_3`, … in that order.
  4. Create the unique index after the backfill, in the same batch.
- **Resolution does not change.** `expandCast` keeps resolving names exactly as today. A test runs `expandCast` over a fixture roster before and after the backfill and gets identical output. Resolving `@handle` comes in a later flagged PR, and only where the handle and the name point at the same member.

### 6.4 The original untouched, the crop separate: extend `uploads`
- `uploads` already keeps the master untouched, with an API-fit derivative beside it (`derivative_url`, `lib/db.ts:934-941`). That derivative keeps its meaning.
- **A crop is its own upload row**, stored at its own workspace-prefixed path, with new additive columns:
  - `derived_from_upload TEXT` or `derived_from_gen TEXT` (exactly one set);
  - `derivation TEXT` (JSON `{op:'crop', x, y, w, h, source_sha256}`).
- The element's version points at the crop through the existing `attribute_versions.upload_id`. The original is never rewritten or deleted.
- **As built (#820):** the three columns, and `cropDerivation()`, which checks one source, a whole-pixel rectangle and the source's SHA-256. Storing the cut bytes is a later change.

### 6.5 Any take ↔ any production and step: new `take_filings`
```
take_filings(
  workspace_id, id,
  take_id TEXT,            -- generations.id; NULL while it is still being made
  job_id  TEXT,            -- quoted_jobs.id, for a filing made before the take exists
  production_id TEXT NOT NULL,
  step_id TEXT NOT NULL DEFAULT '',   -- '' = the production as a whole (a NULL would defeat UNIQUE)
  filed_as TEXT NOT NULL DEFAULT 'filed' CHECK(filed_as IN ('filed','sent')),   -- 'sent': a person sent it to this step, the commit (§2.8)
  from_step_id TEXT,       -- the step it was sent from
  filed_by, filed_at, removed_at, removed_by,
  CHECK (take_id IS NOT NULL OR job_id IS NOT NULL),
  CHECK (filed_as = 'filed' OR step_id <> ''),
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, take_id, production_id, step_id) WHERE take_id IS NOT NULL AND removed_at IS NULL
INDEX (workspace_id, production_id, step_id)   INDEX (workspace_id, job_id)
```
- **Before, during, after:** a filing can name a job before its take exists. When the job's take is written, `take_id` is set in the same write. For an Options job, each of its takes gets its own filing in the write that makes it.
- **The take's home stays `generations.project_id` / `shot_id`.** Filings are extra places it appears, never a second home. "Takes in production P" = its home OR a filing.
- **Sent is a filing to a step, and the commit; a person's alone** (§2.8). A take sent to a step where it is already filed turns that filing into `sent`; it is never a second row (the UNIQUE).
- Uploads already have their own many-to-many, `project_library_uploads` (`lib/workbench/project-library.ts`), which stays.

---

## 7. Migration list

Every item is additive. Tables are created by their store's `…Ready()` (`CREATE TABLE IF NOT EXISTS`, memoised), called only by flag-on code. Columns are added by `columnInstaller`'s `addColumn`, with the backfill in the same batch.

| # | Change | Database | How | Risk on an existing database |
|---|---|---|---|---|
| M1 | `projects.film_type`, `projects.canvas_store` | workspace | `addColumn` in the steps store's `ready()` | Low: nullable; SQLite adds a column without rewriting the table. **Landed in #818.** |
| M2 | `production_steps` (surface incl. `table`, frame CHECKs, fixed-column trigger); **A1b: the CHECK gains `deck`**, by a rebuild where the table exists (§2.2) | workspace | `CREATE TABLE IF NOT EXISTS`; A1b: new table, rows copied, old one renamed aside, in one transaction | None until used. **Landed in #818.** A1b's rebuild: Low (only flag-on databases have the table) |
| M3 | `canvas_nodes` (with `output_kind` (no `deck_page`), `frame_of`, `frame_role`, `variant_of`, `group_id`, `beat_id`), `plate_inputs` (with `via_group_id` and the 18–19 Oct roles, `panel` included) | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M4 | `generations.node_id`, `generations.job_id`, **`generations.kept_at`, `kept_by`** (Q12; replaces the 18 Oct `approved_via`), `generations.review_note_id` (Q14) + indexes on `node_id` and `job_id` | workspace | `addColumn`, then `addIndex` | Low: a hot table, but metadata-only; each index build is one pass over takes (thousands per workspace) |
| M5 | `script_beats`; `shots.beat_id` + index (**changed 18 Oct**: the source-range columns are on `script_beats`, not `shots`) | workspace | `CREATE TABLE IF NOT EXISTS`; `addColumn` | Low |
| M6 | `production_documents`, `document_versions`, `document_changes` (with `job_id`), `document_imports` | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M7 | `quoted_jobs` (with the 18 Oct columns, 4.1), `agent_commands` | workspace | `CREATE TABLE IF NOT EXISTS`, or `addColumn` if A3 merged first | None until used |
| M8 | Settings keys `monthlySpendLimitCredits`, `spendPause`, `askBeforeEveryTake`; 5 audit actions | workspace | rows in the workspace's `settings` table through `app/api/settings/spend` (not `DEFAULTS`, 4.6); no DDL | None: a missing key reads its default |
| M9 | `elements.handle`, `library_kind`, `origin`, `library_status` + fill + unique handle index | workspace | **As built (#820):** columns at boot in `lib/db.ts`; the fill and index on first flag-on use | **Medium:** it writes every element row once, and the unique index fails if the fill is incomplete. The fill is idempotent and the index comes after it, so a failure retries on the next call. **Landed in #820**; the origin fix (6.1) follows. |
| M10 | `uploads.derived_from_upload`, `derived_from_gen`, `derivation` | workspace | `addColumn` at boot (#820) | Low. **Landed in #820.** |
| M11 | `take_filings` (with `filed_as`, `from_step_id`) | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M12 | Status trigger `generations` → `quoted_jobs` (wiring only) | workspace | `CREATE TRIGGER IF NOT EXISTS`, installed only after M7 exists | **Medium:** a trigger on the take table. It touches only rows that have a job, and it is installed only by the wiring PR (after the freeze). |
| M13 | `production_record_items`, `reading_notes` (once per file: `UNIQUE (workspace_id, source_sha256)`) | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |

No platform-database change in Phase A.

---

## 8. PR order

One concern per PR. Each one has tenant-isolation tests for every new table:
- written in workspace A, invisible from B (two databases through `runInTenant`, as `tests/unit/tenantClient.spec.ts` does);
- a store built for B on A's database refuses A's rows (the `workspace_id` check, as `tests/unit/pipelineStore.spec.ts` does);
- a member of B asking for A's production gets the same 404 as for one that does not exist (`requireProduction`).

None of these PRs changes the interface, so the rule-7 viewport runs do not apply. Each states that in its body.

| PR | Concern | Size | Needs | Flag | Opus money review | Tests beyond isolation |
|---|---|---|---|---|---|---|
| **A1** | Steps and frames: M1, M2, film-type step lists, the store, `page_id` | S | — | `V30_PRODUCTION_MODEL` | no | **Merged (#818).** |
| **A1b** | Step lists, final (§2.10): `FILM_TYPES_DEFAULT` with `opened` and `commit`, the `deck` surface and the table rebuild, `add()` at list position | S | A1 | `V30_PRODUCTION_MODEL` | no | each type's opened and + steps as the owner listed them; an opened + step lands at its list position; a production made from the 17 Oct list keeps its steps; the rebuild keeps every row |
| **A2** | Nodes and plate inputs: M3, M4 (`node_id`), `nodeStatusOf`, outputs and accepted roles, children, groups, the `bindings` pairing | M | A1 | `V30_PRODUCTION_MODEL` | no | status derivation table; one top-level shot card per step; a child never has children; a refused role; plate-input and binding rows written together or not at all; a group wire writes and removes its member rows in one write |
| **A3** | Jobs and commands: M7, the store, `lib/jobView.ts`, the engine guard | M | — | `V30_JOBS` | **yes** | the response test and the source guard (4.4); the refund-status mapping; no charge path touched (open) |
| **A3b** | Preflight, Options, bands, job approval: the 18 Oct columns on `quoted_jobs`, `generations.job_id` | S | A3 | `V30_JOBS` | **yes** | no job without a preflight; a `stop` writes nothing; preflight and quote write no money row; only a person approves; no engine in an Agent preflight |
| **A4** | Spend limit, pause, ask-before-every-take: M8, owner-only raise, audit actions | S | — | `V30_SPEND_LIMIT` | **yes** | member, admin raise, `agent:*`, MCP and token writes are refused; owner raises; writes are audited; no reservation reads the keys |
| **A5** | Library columns and handles: M9, M10, the kind map, crop rows | M | — | `V30_LIBRARY` | no | **Merged (#820).** |
| **A5b** | Library origin: a trained likeness is `uploaded` (6.1) | S | A5 | `V30_LIBRARY` | no | identity-first → uploaded; a take made from it → generated; consent read from the identity |
| **A6** | Documents: M6, the version, change and import stores | M | A1 | `V30_DOCUMENTS` | no | an accepted change makes a new version; a stale base marks the change stale; the original upload's SHA-256 is unchanged |
| **A7** | Beats → plates: M5, a beat's shots → one Storyboard plate and one Shots card per shot; a sheet's panels → frames in the shot cards | S | A2, A6 | `V30_PRODUCTION_MODEL` | no | several shots per beat, one beat per shot; one card per shot per step; panels become crop uploads and frame children; making plates and cutting panels spend nothing |
| **A8** | Take filings and Sent (people-only send): M11 | S | A1, A3 | `V30_LIBRARY` | no | a filing before the take exists gets its take id in the same write; the home is unchanged; send never writes `kept_*` or `review_state`; `agent:*`, MCP and token sends refused |
| **A9** | History read models and CSV (read-only API), with the meter backfill | M | A3, A8 | `V30_HISTORY` | **yes** | the totals equal the `credit_receipts` sums; Agent rows and backfilled rows have no engine; one line per command; CSV through `csvCell`, no refund column |
| **A10** | Job wiring (admission, Enhance, plan, exports): M12 | L | A3, A3b, A8 | `V30_JOB_WIRING` | **yes** | flag on and off give identical meter rows, reservations, balances and refusals |
| **A11** | The production record: M13, `productionRecord()`, pins and removals, reading notes | M | A1, A6, A7 | `V30_PRODUCTION_MODEL` | no | reading it writes nothing anywhere; a removed item is not carried and Undo brings it back; a pinned version holds; Setup cannot be removed; a ref from another workspace never resolves |
| **A12** | Keep (`kept_at`, `kept_by`, people-only, Undo) and `committedSql` (§2.8) | S | A1, A8 | `V30_PRODUCTION_MODEL` | no | Keep writes only `kept_*`; `agent:*`, MCP and token Keep refused; `committedSql` gives today's answer for every team-canvas fixture and the Sent/Kept answer by step for v30 ones. Each reader in §2.8's table moves in its own PR, which names its line(s) |

**What can realistically merge by Thu 22**
- A1 (#818) and A5 (#820) merged on 18 Oct. Deploy #8 on Fri 23 is the last feature deploy; the freeze is Tue 27.
- The owner's fix-lane order of 18 Oct ends with "#818's step lists" (A1b). The lists are final since 19 Oct, so A1b can start; R1 (§9.2) changes only `opened` flags and one position.
- The data-model work of 18 Oct ((a)–(d): A11, A12, A2's outputs, A7) is "start now, in lanes, behind switches, no interface". Only what passes CI first time rides deploy #8. The rest lands after the freeze.
- **After 31 Oct:** A10 (Q9, answered 17 Oct #18).

---

## 9. Owner questions

### 9.1 Answered (17–19 Oct), and where each answer lands

| # | Question | The owner's answer | Lands in |
|---|---|---|---|
| Q1 | Which film types, and each one's steps? | 17 Oct #11: ten types (list in `docs/redesign-plan.md`); changed 18 Oct (d) | §2.1 (as built, #818), §2.10 |
| Q2 | Is "kept" picked or approved? | 17 Oct #12: "Kept means the user pressed Keep on a take. Picked is choosing among options and is a step on the way; approved is not a separate state." | §2.3, §2.8, Q12 |
| Q3 | Can one beat become several shots? | 17 Oct #13: "Yes, one beat can become several shots; a shot belongs to one beat." | §2.6 |
| Q4 | Is the Brief new, or is the treatment the Brief? | 17 Oct #14: the Brief is new; the treatment was "the deck inside Look", and is its own step after Script since 18 Oct (d) | §3, §2.10 |
| Q5 | Is Atomik's planning turn free or billed? | 17 Oct #8: free in v30, behind a switch, billing unchanged until sign-off. **Superseded 18 Oct:** "everything Atomik makes is charged and quoted first, including plans" | §4.2, §4.5, Q23 |
| Q6 | Ask before every take by default? | 17 Oct #3: off by default; approval once per step, on the quote | §4.6 |
| Q7 | Does History include earlier work? | 17 Oct #15: yes, backfilled from the meter; missing fields show "before History" | §5 |
| Q8 | Today's looks: reference or wardrobe? | 17 Oct #16: "Reference, in the Look pack. Not wardrobe." | §6.2 (as built, #820), §2.7 |
| Q9 | Job wiring before or after the freeze? | 17 Oct #18: "After 31 Oct" | §4.5, §8 |
| Q10 | Spend limit: which period, and what stops? | 17 Oct #17: calendar month, UTC; finishes the running job, starts nothing new. Update two #5 and 18:00 #3: owner-only raise (removing counts); a pause lifts at the new month | §4.6 |
| Q11 | A refunded failure costs 0? | 17 Oct #4 and 18:00 #4: store the refund status now; "Agreed, not yet"; refunds stay internal | §4.1, §4.3 |
| Q12 | Keep: today's approved, or a separate mark? | 19 Oct: "Keep is a separate mark (kept_at, kept_by), not today's approved. Today's approved is a commit; the commit is Sent. Every reader of 'approved' (export, review links, shot locks) follows Sent on output steps and Kept on Look and Elements. Name each reader in its PR." | §2.8 (the readers' table), §2.3, M4, A12 |
| Q13 | Send without Keep? Show both? | 19 Oct: "yes and yes: Send does not need Keep; a card shows both." | §2.8, §2.3 |
| Q14 | What is a rejection in the record? | 19 Oct: "only takes sent back, with the reason given." | §2.7 (`review_note_id`) |
| Q15 | A sheet per beat, or a card per shot? | 19 Oct: "one card per shot, not one sheet per beat: a beat makes one plate in Storyboard and one in Shots ('from Script · beat 4'). A Storyboard sheet is a make-node output whose panels become frames inside the shot cards." | §2.6, §2.9, §2.5 (`panel`), A7 |
| Q16 | Sound after Shots: where? | 19 Oct: in every type with Shots and Edit (Ad film, Feature, Short film, Music video, Product video, Microdrama), reached from the + tile; a new production shows no change | §2.10 |
| Q17 | Which types get Treatment? | 19 Oct: on by default for Ad film, Feature, Short film, Music video; off by default, on the + tile's list, for UGC, Product video, Microdrama, Pre-vis, Trend clip, Social | §2.10 |
| Q18 | Pitch deck and Treatment? | 19 Oct: "fold: Pitch deck is gone from Ad film; its deck is the Treatment step, with the ad film's section library. One deck per production." | §2.10 |
| Q19 | Treatment's surface? | 19 Oct: "neither canvas nor document: a third surface, deck. Content stays in treatments and treatment_versions; the page format is settled by the Polotno spike (one JSON per page). No deck pages as canvas cards." | §2.2, §2.9, §2.10, M2 |
| Q20 | Pre-vis beats? | 19 Oct: "yes, Pre-vis gets Script opened on the Beats view." | §2.10 |
| Q21 | Microdrama Episodes as scripts? | 19 Oct: "later; unchanged in Phase A." | §2.10 |
| Q22 | Format breakdown and Beat map? | 19 Oct: "untouched." | §2.10 |
| Q23 | Questions before a plan; a plan's band? | 19 Oct: "questions are free and write no job; a plan is a Writing job, quoted first." | §4.2, §4.5 |
| Q24 | Script revision and Deck page bands? | 19 Oct: "Script revision: Writing. Deck page: one quoted job per page covering its words and its pictures; nothing built before the spike." | §2.9, §4.5 |
| Q25 | Who pins and removes in the record? | 19 Oct: "both, each shown with who, with Undo." | §2.7 |
| Q26 | Read an upload once? | 19 Oct: "once per file; no shot triggers a reading." | §2.7 (`reading_notes` UNIQUE), M13 |

**The 19 Oct money answers, placed** (no figures here):
- Enhance is "price as it costs, shown before pressing … build the quote path, not the number". See §4.3 and `band`.
- #815: "If a press's total would pass the workspace cap, refuse at the quote with the pause card; no shot starts." See §4.1 (the preflight's `cap` check).

### 9.2 Readings to confirm (no open owner questions; these are how the plan read three answers)

| # | The plan's reading | The other reading | What changes if it is the other |
|---|---|---|---|
| R1 | "Shots · + Sound · Edit · Deliver" puts all three behind the + tile (Q16 names the tile "Sound · Edit · Deliver"). Optional Treatment, which the lists do not place, goes after Script, or after the first step where there is no Script. | Only Sound is behind +, and Edit and Deliver open as before; Treatment's place is somewhere else. | Only `opened` flags and one position in `FILM_TYPES_DEFAULT` (A1b). |
| R2 | A Storyboard sheet's panels become frame children of the shot's card in **Shots**; its Storyboard card shows them through the shared shot. | The panels sit inside the shot's **Storyboard** card. | Which card `frame_of` points at (A7). |
| R3 | Only `look` and `elements` steps commit by Kept; every other step commits by Sent. | Input-like steps (Product, Creator, Set map, Swap-ins, Track, Source) also commit by Kept. | The `commit` value of those steps in config (A1b). |
