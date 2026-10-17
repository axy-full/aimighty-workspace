# v30 Phase A data model (plan, 17 Oct 2026)

The schema under the v30 interface, for Phase A items 1, 2, 3, 5 and 6 of the owner's 17 Oct brief (`docs/redesign-plan.md`, last entry). Docs only: no product code changes with this file. Read from `origin/release/1` at `85cb7a07`.

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

---

## 1. Names

The brief's words are kept in the interface. Table and column names avoid words the code already uses for something else (rule 5; CLAUDE.md's warning on `tier`, `allowance`, `panel`).

| Brief's word | Name here | Why not the obvious name |
|---|---|---|
| step, frame | `production_steps` (a canvas step's frame is the `frame_*` columns on its row) | `frame` already means a video frame (keyframes, `workbench_edit_versions.frames`, link role "frame"). `stage` is taken by `projects.stage` and `recipe_stages`. |
| node, card, plate | `canvas_nodes` | `nodes` is the JSON column on `boards`. `card` is UI-only. |
| link (node → plate, with a role) | **`plate_inputs`**, column `input_role` | `role` already means a member's role and a reference's role (`reference_image`). |
| link (gen ↔ production and step) | **`take_filings`** | "Take" is the product's word for a generation (rule 4). "Filed" is how the code already says a take sits on a shot. |
| jobs | `quoted_jobs` | `lib/jobs.ts` (the take listing), the `JOBS` purpose list (`lib/takeJob.ts`) and the header's "jobs tray" already use "job". A row exists only once it has a quote (brief rule 4). |
| commands | `agent_commands` | `lib/board/commands.ts` is the ⌘K and right-click command list. |
| mode (Agent · Director) | column `decider` (`agent` \| `director`) | `atomik_chats.agent_mode` and `rig_agent_runs.mode` already mean Ask \| Auto. `agent:*` is also an actor id (`lib/security/people-only`). An Agent-mode job can be started by a person. |
| receipt | no table: a read model, `stepReceipt()` | `credit_receipts`, `meter_credit_receipts` and `soul_training_receipts` already exist. |
| documents | `production_documents`, `document_versions`, `document_changes`, `document_imports` | Asset kind `document` already exists on the canvas. |
| breakdown, beat | `shots` (extended) | Already "the breakdown's half of a shot" (`lib/db.ts:1122-1134`). |
| library element | `elements` (extended) | Already the Library's thing (`lib/elements.ts`). |

---

## 2. Item 1: production model

### 2.1 Productions: extend `projects`
| Column (additive, nullable) | Meaning |
|---|---|
| `film_type TEXT` | Closed list (owner question Q1). NULL means a production from before v30. It is separate from `kind` (free text, "30s car spot") and from `category` (genre). |
| `canvas_store TEXT` | `team` (NULL reads as `team`) or `v30`. This says **which store is the truth for this production's canvas** (see 2.4). |

- **Step lists by film type** are defaults, not a table, and no workspace or client name appears in them. **Interim (lead, 17 Oct):** until the owner gives the film types (Q1), A1 reads them from server config (`V30_FILM_TYPES`, with a flagged placeholder), the same for every workspace. They move to a **platform-layer** key (`platform_layer`, `lib/platformLayer.ts`) with a workspace override (rule 3) in a later PR, because adding a layer key changes the admin platform-layer response, which Phase A must not.
- `projects.step` (0–5 on the six old steps) is left alone. It keeps meaning what it means for productions from before v30.

### 2.2 Steps and frames: new `production_steps`
```
production_steps(
  workspace_id, id, production_id,
  page_id      TEXT NOT NULL,     -- stable link id, see below
  kind         TEXT NOT NULL,     -- the step's kind from the film type's list (brief, script, look, cast, storyboard, shots, deliver …)
  surface      TEXT NOT NULL CHECK(surface IN ('document','canvas')),
  label        TEXT NOT NULL,     -- the name a person may rename; page_id never follows it
  position     INTEGER NOT NULL,  -- order on the rail
  frame_x REAL, frame_y REAL, frame_w REAL, frame_h REAL,   -- the frame, canvas steps only
  created_by, created_at, updated_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id),
  UNIQUE(workspace_id, production_id, page_id))
INDEX (workspace_id, production_id, position)
```
- **One row per step.** A canvas step's frame is its four `frame_*` columns, so "one frame per canvas step" holds by construction. A document step (Brief, Script) has no frame.
- **`page_id` is the stable page id.** It is made once from the kind (`script`; a second Shots step is `shots-2`), it is unique per production, and it never changes on a rename. It is never reused after Undo-able removal. A later route `/<production>/<page_id>` can rely on it.
- The rows are created from the film type's list when a v30 production is made. Adding, renaming or reordering a step changes only this production's rows.

### 2.3 Nodes: new `canvas_nodes`
```
canvas_nodes(
  workspace_id, id, production_id,
  step_id      TEXT NOT NULL,          -- the frame it sits in
  kind         TEXT NOT NULL CHECK(kind IN ('still','clip','audio','text','document','plate','detail','element')),
  x REAL, y REAL, w REAL, h REAL, z INTEGER,   -- relative to its frame, so moving a frame is one row
  title, text,
  shot_id      TEXT,   -- plates (and stills/clips made for a shot)
  take_id      TEXT,   -- the current take shown on the card (generations.id)
  element_id   TEXT,   -- element cards
  document_id  TEXT,   -- document cards
  detail_type  TEXT CHECK(detail_type IN ('angle','camera_move','lighting','action','note')),
  detail_value TEXT,   -- JSON: a Setup option id, or words
  revision INTEGER NOT NULL DEFAULT 1,
  created_by, created_at, updated_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id))
INDEX (workspace_id, production_id, step_id)
INDEX (workspace_id, shot_id)   INDEX (workspace_id, take_id)   INDEX (workspace_id, element_id)
```
- **Takes as versions.** A node's versions are its takes. The plan adds `generations.node_id TEXT` (additive, nullable, indexed), written at admission in the same insert as the take, the way `shot_id` is today. Versions = `generations WHERE node_id=? ORDER BY created_at`. For a plate, they are also `WHERE shot_id=?`, numbered by the existing `generations.version`. There is no copy of the version list.
- **Status (draft · final · 4k · kept · failed) is derived, not stored.** A pure `nodeStatusOf(currentTake)`:
  - `failed`: the take failed;
  - `4k`: it is an upscale;
  - `final`: it is a final (`finalOf`, job label `shot_final`);
  - `kept`: it was picked or approved;
  - `draft`: anything else.
  Storing it would make a second truth beside `generations.status`, `review_state`, `picked_at` and the draft/final link (rule 4: draft → picked → approved stays). Text, document, detail and empty plate cards have no status. **Owner question Q2:** does "kept" mean picked or approved?
- **Detail nodes are a fifth Setup layer**, above the shot's. Setup today has four layers: platform, workspace, production, shot (`lib/setup.ts`). A detail card linked to a plate supplies its `detail_type`'s Setup key: `angle`→`angle`, `camera_move`→`move`, `lighting`→`light`. `action` and `note` add words to the prompt and set no Setup key. `shots.setup` stays the shot's own layer and is never rewritten by a detail card. So "Setup carried into every shot" holds, with no second copy.

### 2.4 One canvas truth per production (reconciling the team canvas)
- Today a production's canvas is one JSON row, `workbench_team_canvas.body`, edited live over Liveblocks (`lib/workbench/team-canvas.ts`). Wires are each node's `linked` array (`lib/workbench/studio-schema.ts:71-172`).
- **`projects.canvas_store` decides which store is the truth**, per production:
  - `team`: the JSON row, exactly as today. The v30 tables hold nothing for this production.
  - `v30`: the tables. The JSON row is kept, read-only, as it was at the switch.
- **A one-way import** (flag on, house workspace only) copies a team canvas into `canvas_nodes` and `plate_inputs`. It keeps node ids and stamps the JSON revision it read. In the same write it sets `canvas_store='v30'`. After that, a team-canvas patch for that production is refused with 409. This is the same shape as the old-board import (`boards.imported_at`, `imported_to`; `lib/workbench/board-import.ts`), which never rewrites its source.
- The Liveblocks room is unchanged (`teamRoomFor(workspaceId, productionId)`).

### 2.5 Node → plate links: new `plate_inputs`
```
plate_inputs(
  workspace_id, id, production_id,
  plate_id     TEXT NOT NULL,   -- canvas_nodes.id, kind plate
  from_id      TEXT NOT NULL,   -- canvas_nodes.id
  input_role   TEXT NOT NULL CHECK(input_role IN ('cast','frame','angle','camera_move','environment','prop','brand','product','look')),
  ordinal      INTEGER NOT NULL DEFAULT 0,
  binding_id   TEXT,            -- bindings.id when the source is an element and the plate has a shot
  created_by, created_at, removed_at, removed_by,
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, plate_id, input_role, ordinal) WHERE removed_at IS NULL
INDEX (workspace_id, from_id)
```
- **Reconciling `bindings`** (shot, slot, ordinal → element, attribute, version: `lib/db.ts:506-562`):
  - When an element card feeds a plate that has a shot, the `plate_inputs` row and the `bindings` row are written **in the same transaction**.
  - `plate_inputs` holds only the wire and its role. `bindings` stays the only truth for which version the shot uses (follow or pin).
  - Role → slot: `cast`→`character`, `environment`→`background`, `prop`/`brand`/`product`→`element`, `look`→`look`, `frame`→`keyframe`.
  - `angle` and `camera_move` come from detail cards and set no binding (2.3).

### 2.6 Breakdown and beats → dashed plates: extend `shots`
- **A beat is a `shots` row.** The breakdown already writes shots (`ideas`/`treatments` comment, `lib/db.ts:318-322`). It already carries `planned`, `setup`, `cast`, `kind`, `engine`, `dirty` and `synced_at` (`lib/db.ts:1125-1134`).
- New columns (additive, nullable):

| Column | Meaning |
|---|---|
| `source_version_id TEXT` | the `document_versions` row (the Script) it was broken down from |
| `source_start INTEGER`, `source_end INTEGER` | its character range in that version's Fountain |
| `beat_position INTEGER` | its order within the breakdown (`position` keeps its present meaning) |

- **A beat creates two dashed plates**: one in the Storyboard step and one in the Shots step, both `canvas_nodes` with `kind='plate'` and the beat's `shot_id`. That shared `shot_id` is what keeps them linked. "Dashed" is derived: a plate whose shot has no take yet. No flag column.
- Making plates spends nothing.
- **Owner question Q3:** can one beat become several shots? If yes, a later additive `shots.beat_id` covers it.

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
- **Converting a file is free** (an upload is never billed). **Reading it for understanding is a billed job**: a `quoted_jobs` row with product `reading`, whose `source_ref` names the import (section 4).
- Sizes: a long feature script is a few hundred KB per version, which is fine as a row for Phase A. Moving bodies to storage later is an additive change.
- **Owner question Q4:** is the Brief a new document, or is today's treatment the Brief?

---

## 4. Item 3: jobs, commands, receipts, spend limit

### 4.1 `quoted_jobs` (new, workspace database)
```
quoted_jobs(
  workspace_id, id,
  production_id, step_id, node_id, command_id,
  decider TEXT NOT NULL CHECK(decider IN ('agent','director')),
  product TEXT NOT NULL CHECK(product IN ('generation','reading','research','analysis','writing','layers','enhance','render','upscale')),
  engine  TEXT,                 -- PRIVATE: read only by lib/jobView.ts (4.4)
  quote_tenths INTEGER,         -- credits x 10, the price shown before it ran; credit workspaces
  quote_usd    REAL,            -- only where credits do not apply (the house, own keys); never sent to a credit workspace
  quoted_at INTEGER NOT NULL,
  meter_id TEXT,                -- meter_events.id: the money truth
  take_id  TEXT,                -- generations.id, when it made a take
  source_ref TEXT,              -- the product's own row: paid_text_jobs:<id>, workbench_development_jobs:<id>, document_imports:<id> …
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  refund_status TEXT CHECK(refund_status IN ('billed','refunded','not_charged','unknown')),   -- NULL until it fails or is cancelled
  error_public TEXT,            -- the sentence a person sees; never a vendor's words for an Agent job
  created_by, created_at, started_at, finished_at, updated_at,
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, meter_id) WHERE meter_id IS NOT NULL
INDEX (workspace_id, production_id, created_at)   INDEX (workspace_id, command_id)
INDEX (workspace_id, step_id)   INDEX (workspace_id, take_id)   INDEX (workspace_id, created_by, created_at)
```
**What is not on the row, and where it is read from**

| Brief's field | Truth | Why not on `quoted_jobs` |
|---|---|---|
| actual | `meter_events.billed_credits`, read in the workspace through its replica `credit_receipts(event_id, credits)` (`lib/creditReceipts.ts`: "the meter remains authoritative") | The meter is the money truth. |
| vendor cost | `meter_events.engine_cost_usd` (platform database, admin desk only) | A customer never receives a vendor cost (CLAUDE.md § Pricing). |

**Fields that another row also holds** (the job is upstream; the other row is written from it in the same write):
- **`quote`**: a take already keeps its quote in `generations.params.quote` (`quoteSnapshot`, `lib/generationAdmission.ts:230`; step-0 plan item 4).
  - With the wiring flag on, admission writes `params.quote` from the job's quote in the same batch as the take insert. Both are in the same database, so they cannot disagree.
  - Read models read the job. They read `params.quote` only for takes that have no job (made before v30).
- **`engine`**: `generations.model` and `meter_events.model` are written from the job's engine at admission, as today.
- **`refund_status`**: a projection of the provider's billing state, `BILLING_STATES` in `lib/providerOutcome.ts`, the same four values.
  - It is written once, at settlement, by one mapping function, from the same `ProviderOutcome` that `meter()` and `generations.provider_outcome` receive.
  - Customer read models read this column. `provider_outcome` stays for the admin desk and today's take card.
  - A test asserts the two agree for every settled fixture.
- **`status`**: for a generation job, it follows `generations.status`. An `AFTER UPDATE OF status` trigger on `generations` sets it, the same idiom as `gen_settled_on_status` (`lib/db.ts:1215-1229`). The trigger is installed only by the wiring PR. For other products, the job's writer sets it.

**Money behaviour does not change.** `refund_status` records what the vendor did. Today's billing of failed and cancelled jobs stays exactly as it is. Making the bill follow the refund status (brief rule 3: "0 when the vendor refunds it") is a later money change that needs sign-off.

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
- **The approval stays in `rig_plan_approvals`**, the person-only row with its guard triggers (`lib/workbench/plan-approval.ts`). A command points at it and copies nothing from it.
- **The executor's copy:** `rig_agent_runs.goal` stays as the executor's working input. History reads the command.

### 4.3 Receipts per step (a read model, no table)
`stepReceipt(productionId, stepId)` returns one line per job: product, quote, actual (from `credit_receipts`), refund status, status and the card it made. Its total is the sum of the actuals. It is built through `lib/jobView.ts`, so Agent lines carry no engine.

### 4.4 Rule 1 (an Agent job never shows its engine): where it is enforced
- **One serializer, `lib/jobView.ts › publicJob(row, joins)`.** It is the only code that turns a `quoted_jobs` row (with its take, provenance and receipt) into JSON, CSV or a sentence. Every v30 read model uses it: History (Agent and Director), aggregates, CSV export, step receipts, error lines, and the "recreate" recipe.
  - `decider='agent'`: no engine, model or provider. No engine-named settings (`params.model`, `take_provenance.recorded.engine/model/provider`). Failure lines get `provider: null`, so `billingSentence` (`lib/errors.ts`) says "The provider" and never a name. The recipe's engine is empty, so Recreate hands Director an empty engine (brief rule 6).
  - `decider='director'`: everything it chose (engine label, settings, inputs, prompt).
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

| Path | Product | `meter_id` / `take_id` |
|---|---|---|
| Generation admission (`lib/generationAdmission.ts` → `reserveGenerationSpend`) | `generation` (`upscale` when `task='upscale'`) | the generation's id, both |
| Enhance (`app/api/prompt/enhance/route.ts` → `lib/paidText.ts runPaidText`, kind `enhance`) | `enhance` | the `paid_text_jobs` id |
| Atomik planning turn (`lib/workbench/rig-agent.ts` `planEvent`; chat turns `lib/atomik.ts:1052`) | **owner question Q5** | the meter id it already writes |
| Script breakdown and development (`lib/workbench/development-server.ts`) | `analysis` / `writing` | its job id |
| Document reading for understanding (new) | `reading` | new |
| Exports (the `export_jobs` work from #700; not on release/1 at `85cb7a07`) | `render`, if an export is billed | its id |

- **The rule for the wiring PR:** the job row is written before the reservation (that is when the quote is stored). Nothing in `meter_events`, `generation_reservations` or the billing ledger changes.
- **Its test:** the same fixtures run with the flag on and off produce identical meter rows, reservations, balances and refusals.

### 4.6 Monthly spend limit and paused state (workspace settings; no behaviour in Phase A)
**As built in A4, with the owner's 17 Oct answers (items 3 and 17).** Three keys in the workspace's own `settings` table, **not** in `lib/settings.ts DEFAULTS`: `GET /api/settings` sends `DEFAULTS` to every member, and the general admin PATCH accepts any `DEFAULTS` key with no audit line. They have their own route, `app/api/settings/spend`, and are listed in `INTERNAL_SETTING_KEYS`.

| Key | Values | Default |
|---|---|---|
| `monthlySpendLimitCredits` | whole credits; `''` = no limit; the period is the calendar month in UTC, like the house cap | `''` |
| `spendPause` | `''` = running, else JSON `{at, by, reason: 'admin'\|'limit'}` | `''` |
| `askBeforeEveryTake` | `'on'` \| `'off'` | `'off'` (owner: approval happens once per step, on the quote) |

- **Admin-only, a person's alone.** Members, API and MCP tokens, `agent:*`, `server`, disabled users and no user are refused on the server (rules 11 and 14).
- **Each change writes an audit line** in the same batch. Five new actions on `lib/securityAudit.ts`'s closed list (the limit, pause, resume, and ask on and off).
- **This is not the platform's walls.** `workspaces.allowance_usd` (`lib/allowance.ts`) and `workspaces.suspended_at` (`lib/platform.ts`) are the platform owner's. These keys are the workspace's own, in credits, set by its admin. A pause reason of `limit` is written by the server; `admin` by a person.
- **Enforcement is a later money PR** (owner item 17): reaching the limit finishes the running job, starts nothing new, and shows Paused with Continue (the limit is raised) and Stop. The reservation would read the keys inside its own write, with an Opus money review and sign-off. Guardrail 4 applies whatever these say.
- **CLAUDE.md rule 14 says Ask is the default today.** When `askBeforeEveryTake` gets behaviour, the rule's text (and the SOW) must be amended to the owner's 17 Oct answer.

---

## 5. Item 5: history read models (what they read from)

All of them go through `lib/jobView.ts` (4.4), are read-only, sit behind flag `V30_HISTORY`, and read the workspace database only. The money comes from `credit_receipts` (call `syncCreditReceipts()` first, as `lib/exportRows.ts` does).

| Read model | Reads | Row links to |
|---|---|---|
| **Agent**: one row per command: instruction, production, step, date, total credits, the cards it made | `agent_commands` ⟕ `quoted_jobs` (by `command_id`) ⟕ `credit_receipts` (by `meter_id`) ⟕ `canvas_nodes` / `generations` (by `take_id`, `node_id`) | the step's `page_id` and the node id |
| **Director**: itemised, with engine, settings, inputs, prompt | `quoted_jobs WHERE decider='director'` ⟕ `generations` (prompt, params) ⟕ `take_provenance.recorded` (engine, setup, ports = inputs) ⟕ `take_ports` ⟕ `credit_receipts` | the take's card |
| **Aggregates**: by production, member, month | `quoted_jobs` ⟕ `credit_receipts`, grouped by `production_id`, `created_by`, and month from `created_at` | the filtered History |
| **CSV** | the rows above, through `lib/csvCell.ts` and the same serializer | — |

- Prompt text and instructions are shown to the workspace's own members. Product analytics read ids and timings only (rule 17).
- Work from before the flag stays in today's Usage page and export. It is not back-filled into v30 History (owner question Q7).
- Indexes: the `quoted_jobs` and `agent_commands` indexes in section 4 cover every filter above.

---

## 6. Item 6: Library

### 6.1 Extend `elements` (additive, nullable; backfilled once)
| Column | Values | Backfill |
|---|---|---|
| `handle TEXT` | `[a-z][a-z0-9_]{0,31}` | see 6.3 |
| `library_kind TEXT` | `character`, `environment`, `prop`, `wardrobe`, `brand`, `product`, `reference`, `audio` | from `kind`, see 6.2 |
| `origin TEXT` | `generated` \| `uploaded`, written once and never rewritten | `from_gen_id` set → `generated`; else the first version's source (`upload_id` → `uploaded`, `gen_id`/`identity_id` → `generated`); none → `uploaded` |
| `library_status TEXT` | `active` \| `draft` | `active`: every element is usable today |

Indexes: `UNIQUE (LOWER(handle)) WHERE handle IS NOT NULL` (the database is the workspace's, so this is unique per workspace) and `(library_kind)`.

### 6.2 Kinds: why `elements.kind` is not rewritten
- `elementKind()` (`lib/rig.ts:68`) reads any value it does not know as `character`. Writing `environment` into `kind` would make today's Rig bind every location as a character.
- So `library_kind` is the v30 kind, and `kind` becomes a compatibility value. One writer function sets both, and `kind` is never set on its own.

| Today's `kind` | → `library_kind` | Note |
|---|---|---|
| `character` | `character` | |
| `location` | `environment` | |
| `prop` | `prop` | |
| `voice` | `audio` | |
| `look` | **`reference`** (proposed; owner question Q8) | A look is a style, not clothing. The cast stores it as `style`, it fills the `look` slot, and its one attribute is `look` (`lib/rig.ts:62-79,100-108`). Wardrobe today is an *attribute of a character*. Mapping look → wardrobe would file every house style as clothing. As `reference`, it still feeds plates in the `look` role. |

New kinds take the nearest compatibility `kind`:
- `wardrobe`, `brand`, `product` → `prop`;
- `reference` → `look`;
- `environment` → `location`;
- `audio` → `voice`.

### 6.3 @handle: unique per workspace, without changing how @Name resolves
- **Today:** `expandCast` resolves `@Name` against `cast_members.name`, case-insensitive, within the production plus workspace-wide (`lib/cast.ts:44-56,104-146`). Its token grammar is `@[A-Za-z][A-Za-z0-9_]{0,31}`.
- **The handle grammar matches that grammar.** That is why the suffix is `_2`, not `-2`: `@maya-2` would be read as `@maya` followed by "-2".
- **Reserved handles:** `image<N>`, `video<N>` and `audio<N>`, because the engines' own citations are left alone.
- **Backfill rule** (once, in code, inside one write; idempotent: it only fills NULLs, so a crash is finished on the next run):
  1. Make the base: lowercase the name and turn each run of other characters into `_`, trimmed to 32 characters. A name that does not start with a letter gets its kind as a prefix (`prop_1920s_radio`).
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

### 6.5 Any take ↔ any production and step: new `take_filings`
```
take_filings(
  workspace_id, id,
  take_id TEXT,            -- generations.id; NULL while it is still being made
  job_id  TEXT,            -- quoted_jobs.id, for a filing made before the take exists
  production_id TEXT NOT NULL,
  step_id TEXT NOT NULL DEFAULT '',   -- '' = the production as a whole (a NULL would defeat UNIQUE)
  filed_by, filed_at, removed_at, removed_by,
  CHECK (take_id IS NOT NULL OR job_id IS NOT NULL),
  PRIMARY KEY(workspace_id, id))
UNIQUE (workspace_id, take_id, production_id, step_id) WHERE take_id IS NOT NULL AND removed_at IS NULL
INDEX (workspace_id, production_id, step_id)   INDEX (workspace_id, job_id)
```
- **Before, during, after:** a filing can name a job before its take exists. When the job's take is written, `take_id` is set in the same write.
- **The take's home stays `generations.project_id` / `shot_id`.** Filings are extra places it appears, never a second home. "Takes in production P" = its home OR a filing.
- Uploads already have their own many-to-many, `project_library_uploads` (`lib/workbench/project-library.ts`), which stays.

---

## 7. Migration list

Every item is additive. Tables are created by their store's `…Ready()` (`CREATE TABLE IF NOT EXISTS`, memoised), called only by flag-on code. Columns are added by `columnInstaller`'s `addColumn`, with the backfill in the same batch.

| # | Change | Database | How | Risk on an existing database |
|---|---|---|---|---|
| M1 | `projects.film_type`, `projects.canvas_store` | workspace | `addColumn` | Low: nullable; SQLite adds a column without rewriting the table |
| M2 | `production_steps` | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M3 | `canvas_nodes`, `plate_inputs` | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M4 | `generations.node_id` + index | workspace | `addColumn`, then `addIndex` | Low: a hot table, but metadata-only; the index build is one pass over takes (thousands per workspace) |
| M5 | `shots.source_version_id`, `source_start`, `source_end`, `beat_position` | workspace | `addColumn` | Low |
| M6 | `production_documents`, `document_versions`, `document_changes`, `document_imports` | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M7 | `quoted_jobs`, `agent_commands` | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M8 | Settings keys `monthlySpendLimitCredits`, `spendPause`, `askBeforeEveryTake`; 3 audit actions | workspace | `DEFAULTS` entries (no DDL) | None: a missing key reads its default |
| M9 | `elements.handle`, `library_kind`, `origin`, `library_status` + backfill + unique handle index | workspace | `addColumn` with backfill; index after | **Medium:** it writes every element row once, and the unique index fails if the backfill is incomplete. The backfill is idempotent, and the index is created only after it, so a failure leaves the columns and retries on the next boot. |
| M10 | `uploads.derived_from_upload`, `derived_from_gen`, `derivation` | workspace | `addColumn` | Low |
| M11 | `take_filings` | workspace | `CREATE TABLE IF NOT EXISTS` | None until used |
| M12 | Status trigger `generations` → `quoted_jobs` (wiring only) | workspace | `CREATE TRIGGER IF NOT EXISTS`, installed only after M7 exists | **Medium:** a trigger on the take table. It touches only rows that have a job, and it is installed only by the wiring PR (after the freeze). |

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
| **A1** | Steps and frames: M1, M2, film-type step lists from server config (interim; platform layer later), the store, `page_id` | S | — | `V30_PRODUCTION_MODEL` | no | `page_id` is stable across rename, reorder and removal; one frame per canvas step |
| **A2** | Nodes and plate inputs: M3, M4, `nodeStatusOf`, the `bindings` pairing | M | A1 | `V30_PRODUCTION_MODEL` | no | status derivation table; the plate-input and binding rows are written together or not at all; role → slot map |
| **A3** | Jobs and commands: M7, the store, `lib/jobView.ts`, the engine guard | M | — | `V30_JOBS` | **yes** | the response test and the source guard (4.4); the refund-status mapping; no charge path touched |
| **A4** | Spend limit, pause, ask-before-every-take: M8, admin-only writes, audit actions | S | — | `V30_SPEND_LIMIT` | **yes** | member, `agent:*`, MCP and token writes are refused; admin writes are audited; no reservation reads the keys |
| **A5** | Library columns and handles: M9, M10, the kind map, crop rows | M | — | `V30_LIBRARY` | no | the handle backfill (collisions, reserved, crash then rerun); `expandCast` output is identical before and after; Rig reads the same `kind` |
| **A6** | Documents: M6, the version, change and import stores | M | A1 | `V30_DOCUMENTS` | no | an accepted change makes a new version; a stale base marks the change stale; the original upload's SHA-256 is unchanged |
| **A7** | Breakdown → plates: M5, beat → two plates | S | A2, A6 | `V30_PRODUCTION_MODEL` | no | both plates share the shot; making them spends nothing |
| **A8** | Take filings: M11 | S | A1, A3 | `V30_LIBRARY` | no | a filing before the take exists gets its take id in the same write; the home is unchanged |
| **A9** | History read models and CSV (read-only API) | M | A3, A8 | `V30_HISTORY` | **yes** | the totals equal the `credit_receipts` sums; Agent rows have no engine; CSV through `csvCell` |
| **A10** | Job wiring (admission, Enhance, planning turn, exports): M12 | L | A3, A8, Q5 | `V30_JOB_WIRING` | **yes** | flag on and off give identical meter rows, reservations, balances and refusals |

**What can realistically merge by Thu 22**
- Today is Sat 17. Deploy #8 on Fri 23 is the last feature deploy; the freeze is Tue 27.
- CI runs about 30 min, two at a time, and the queue is shared with the demo path and three other lanes. Assume one or two slots a day for this plan, and one rerun per PR.
- **Must land by Thu 22 (deploy #8):** A1, A3, A4, A5. Phase B's canvas needs A1; money and Library come first.
- **Should land:** A2, A6, if their CI passes first time.
- **Stretch:** A7, A8, A9.
- **After the freeze:** A10. It touches every paid path, so it should not ride the last feature deploy, even behind a flag. The owner may say otherwise (Q9).

---

## 9. Open questions for the owner

| # | Question | Why it matters | Until you answer |
|---|---|---|---|
| Q1 | Which film types are there, and what is each one's step list? | It sets up the steps of every new production. | A1 ships the mechanism with one flagged sample list from server config, flag off; the platform layer and workspace override follow. |
| Q2 | Is a "kept" card one that was **picked**, or one that was **approved**? | Draft → picked → approved stays; "kept" has to mean one of them. | `kept` = picked. |
| Q3 | Can one script beat become more than one shot? | It decides whether a beat is a shot or a group of shots. | One beat = one shot. |
| Q4 | Is the Brief a new document, or is today's treatment the Brief? | It avoids two Briefs. | A new document; treatments untouched. |
| Q5 | Atomik's thinking (its planning turn) is billed today. The v30 brief says "talking is free". Is the planning turn talking (free, no job) or a billed job? | It changes what customers are charged, so it needs your word. | Billed exactly as today; no job row until you answer. |
| Q6 | Should Particl ask before every take by default? The 17 Oct brief says off, your 16 Oct note says on, and today's rule says Ask. | It decides whether Atomik can run small drafts without a tap. | The setting ships unset, and today's Ask stays. |
| Q7 | Should the new History include work made before it existed? | Old work has no instruction or decider recorded. | No; it stays in today's Usage and export. |
| Q8 | Today's "look" elements are styles, not clothes. File them as **reference** (proposed) or as **wardrobe**? | It decides where every existing house style shows up in the Library. | reference. |
| Q9 | May the job wiring (behind a switch that is off) land before the 27 Oct freeze, or after it? | It touches every paid path, even when off. | After the freeze. |
| Q10 | Is the monthly spend limit per calendar month, or per billing cycle? When it is reached, does it stop new work only, or work already running too? | It decides when work stops. | Billing cycle (`lib/cycle.ts`); new work only. Nothing enforces it in Phase A. |
| Q11 | Should a failed job that the vendor refunded cost 0 credits, as the brief's rule 3 says? Today's billing of failed jobs stays until the business manager signs off. | It is a change to what is charged. | Recorded as `refund_status` only; billing unchanged. |
