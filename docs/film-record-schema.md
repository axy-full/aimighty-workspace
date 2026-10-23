# The film record: schema and migration plan (step 3c)

Status: **design, for the owner's yes, line by line.** Docs only. Nothing is migrated, and no code or SQL changes in this PR. No migration PR exists until the owner says yes to section 6.

- **Read from:**
  - code: `origin/release/1` at `d0048482`. Every `file:line` is on that commit;
  - Amendment (iii): `origin/docs/amendment-iii-22oct` at `27faeda8`, sections A–J, mainly I;
  - the SOW: R7 (`docs/particl-sow-v1.md:911`), the owner's answer 5 (`:959`), and Amendment (ii) C1–C4 (`:1014-1022`);
  - the LangGraph design note of 21 Oct (Opus rev 3, answered by the owner). Its public copy goes in with slice 1's PR. This doc cites its sections as "LG §n".
- **What it covers:** the four layers of Amendment (iii) I, the checkpoint rule, the turn context, the ten acceptance tests (I's list), the migration, export and deletion.
- **Related:** this is also design note D of 21 Oct ("the ledger, with agent-private fields never served (a closed-list guard)"). The graph-index spike (E) waits for this schema to be agreed. Search (F) is separate. Make (no production) writes no record: it writes to the Library with "made in Make" as its source (Amendment (iii) G, Make).

---

## 0. In short

- **Nine new tables** in each workspace's own database, all prefixed `film_record_`. Every row carries `workspace_id`, and `workspace_id` comes first in every key and index.
  - **No existing table gains a column**, and none is rewritten, renamed or dropped.
- **Existing tables become layers rather than being copied:**
  - `atomik_memory` and the Library tables are layer 1;
  - `production_steps` is the spine every record row hangs on;
  - `identity_consents` holds consent;
  - the money tables (`rig_plan_approvals`, `rig_agent_steps`, the meter) stay the truth for money. The record mirrors them by id and is never read by a gate.
- **One switch, new and off for customers:** `V30_FILM_RECORD`. It is on only when `V30_PRODUCTION_MODEL` is on and the workspace has the new interface (the house workspace).
- **Tenant databases migrate on first use, as they do today.** There is no script and no backfill.

**What cannot be built exactly as written, and the closest version** (each is also in section 8 where it needs a decision):

1. **"The production record — the LangGraph state, checkpointed after every turn"** (I.2; R7 "It is the LangGraph state").
   - Built as: the record is tenant rows. The graph state holds only a pointer to it (production id and record revision).
   - Why: the approved design note keeps checkpoints to ids only, with a privacy probe that no checkpoint blob holds the brief, prompts or titles (LG §3.5, §4.6, §10.5). It also holds that "no run's behaviour depends on its checkpoint" (LG §3.5).
   - A record inside the checkpoint blob would put words in it and grow without bound.
   - "Checkpointed after every turn" holds: every turn commits a new record revision, and the checkpoint after the node stores that revision (section 3).
2. **"The interview as spoken lives in Turso and nowhere else"** (I, Tracing).
   - It does live only in Turso among our own stores: not in Langfuse, Inngest outputs, checkpoints or logs.
   - It is still sent to the thinking model inside the turn that reads it. That is the model call itself, not storage.
3. **"Nothing in it trains anything"** (I, Privacy).
   - Our code can prove that record text goes only to the turn's own model call and to the owner's export.
   - Whether a vendor trains on API traffic is that vendor's data-use setting on the key. A unit test cannot prove it; the owner sets it with the keys.
4. **"A production with 200 takes loads no slower than one with 10"** (I, Size).
   - Equal wall time is not a stable test.
   - The test asserts the same number of queries, index use on every record table (no full scan), a capped payload, and a median time ratio ≤ 1.5 (section 4).
5. **Script "WRITES: the script as 'said' lines by scene"** (G, Script).
   - The script's own text stays in its version table, and the record points at the approved version.
   - "Said" lines are what a person typed or said (C1): the interview, prompts, notes, comments, titles, bar commands, a client's comments.
   - A hand edit to the script saves a version, as today. It is not copied keystroke by keystroke.

---

## 1. Where it lives and how it is scoped

- **One database per workspace** (`lib/db.ts:9-20`; `lib/tenant.ts:3-13`). `db()` refuses without a tenant (`lib/db.ts:41-45`).
- **`workspace_id` on every row anyway**, first in every key and index. Every statement binds it. This follows the newer stores:
  - `production_steps` (`lib/productionModel/steps.ts:12-20`, `:77-97`);
  - `atomik_memory` (`lib/atomikMemory.ts:21-25`, `:45-57`);
  - the pipeline store (`lib/pipeline/store.ts:122-129`).
- **The store is reachable only through a factory**, `filmRecord()`. It always pairs `db()` with `requireTenant().id`, and every public method re-checks the tenant. This is the `productionSteps()` pattern (`steps.ts:183-186`, `:472-480`).
  - A test-only constructor is named nowhere outside `tests/`, guarded as `stepStoreForTests` is (`steps.ts:482-488`).
- **"Production" means a `projects` row.** It is what `production_steps.production_id` and `rig_agent_runs.production_id` name, and what `requireProduction` checks (`lib/workbench/team-canvas.ts:78-85`).
  - A record exists only for a v30 production: one with a film type and steps (`steps.ts:21-28`).
- **Who may read a production's record:** the same people who may reach the project (`mayReachProject`, as `requireProduction` asks). A private board's record is its owner's alone.
- **Files are never copied into the record.** It names objects by id (`generation:<id>`, `upload:<id>` …). Blob paths and signed URLs stay with their own rows (rule 2).
- **No enum CHECKs.** SQLite cannot change a CHECK in place (`steps.ts:99-110`), so an enum CHECK would force a table rebuild when a kind is added, and a rebuild is the one step here that would not be additive.
  - Kinds, states and sources are validated in code and tested.
  - The only CHECKs are invariants that will not change: `workspace_id <> ''`, and "only a person approves", which copies `rig_plan_approvals` (`lib/workbench/plan-approval.ts:175-202`).

---

## 2. The four layers mapped to tables

### 2.0 The table list

| Table | Layer | One line |
|---|---|---|
| (none new) | 1 workspace memory | A read view over `atomik_memory`, the Library, consents and looks, plus two derived queries: house defaults and Director engine preferences |
| `film_record_heads` | 2 | One row per production: the committed record revision |
| `film_record_rows` | 2 | Checklist rows, one version per change: value, source, who, when, why |
| `film_record_said` | 2 | The person's words with step, source and mode: the interview, prompts, notes, comments, titles, bar, client |
| `film_record_items` | 2 | Every element, still, frame, take, cue, read, cut, page and master, with its state (draft → picked → Kept; Sent), cost and the reason for a reject |
| `film_record_approvals` | 2 | A mirror of each approval (who, when, the quote, the allowance left), keyed to the money row it copies |
| `film_record_private` | 2 | Agent-private rows: the engine, settings, prompt as sent and voice id per take or node. Never served to Agent mode |
| `film_record_edges` | 2 | Ripple edges: which item or row was made from which row version |
| `film_record_turns` | 2 (bookkeeping) | One row per turn: the idempotency key, base and committed revision, outcome. Ids and timings only |
| `film_record_digests` | 3 step digest | One bounded digest per step, regenerated by the turn that works the step |
| (none) | 4 turn context | Built fresh every turn from layers 1–3. Never stored, and never a chat history |

Common columns, shown once and not repeated in each table below:

- `workspace_id TEXT NOT NULL CHECK(workspace_id <> '')`;
- `production_id TEXT NOT NULL` (a `projects.id`);
- `rev INTEGER NOT NULL`: the record revision the row was committed at;
- `turn_id TEXT NOT NULL`: the `film_record_turns.id` that wrote it.

`film_record_heads`, `film_record_turns` and `film_record_digests` differ, and their tables say how. Ids come from `id()` in `lib/db.ts` with the prefixes shown. Times are epoch milliseconds, as everywhere in the schema.

### 2.1 Layer 1: the workspace memory (no new table)

Read at the start of every production and every turn. It never crosses a workspace, because it is the workspace's own database.

| What I.1 lists | Where it already lives | How the record reads it |
|---|---|---|
| the brand's words and colours, the workspace's own vocabulary ("our packshot"), notes | `atomik_memory`, kinds brand · audience · reference · identity · note (`lib/atomikMemory.ts:45-57`; kinds `lib/atomikMemoryText.ts:18`) | `plannerMemory` (`lib/atomikMemory.ts:600-608`): active entries only, the production's own and the workspace's, ranked and cut small. Proposals waiting for a tick are never read. Unchanged |
| trained faces with consent | `identities`, `soul_identities`, `identity_consents` (`lib/security/consent.ts:23-43`) | By id. A consent row is people-only and never deleted (`consent.ts:15-20`) |
| kept looks and LUTs | `shot_presets` (looks), `elements` with `library_kind` (`lib/db.ts:950-956`, behind `V30_LIBRARY`, `lib/elementLibrary.server.ts:24-27`) | By id |
| house defaults (D8: "a row answered the same way three times becomes the default") | **derived**, not stored | A query over `film_record_rows` across this workspace's productions (index `frr_house`, below). Rule in question 7 |
| engine preferences a Director set | **derived** | A query over `film_record_private` across productions (`chose = 'director'`). Read only by Atomik and Director-mode views (section 5, test 5) |

Why there is no table:

- Every fact here already has a home and its own rules (Memory's "nothing is kept silently", `atomikMemory.ts:27-34`; consent is people-only).
- House defaults are a count over answers that are already rows. Storing them again would make a second truth that could disagree with the first.

### 2.2 Layer 2: the production record

#### `film_record_heads`: the revision counter

| Column | Type | Null | Note |
|---|---|---|---|
| workspace_id | TEXT | no | |
| production_id | TEXT | no | |
| rev | INTEGER | no, default 0 | +1 on every commit (3.2) |
| created_at, updated_at | INTEGER | no | |

- **Key:** `PRIMARY KEY(workspace_id, production_id)`.
- **Why a table and not `projects.record_rev`:** `projects` has no `workspace_id` (`steps.ts:15`), and a head is the fence every commit checks. A table keeps step 1 free of changes to existing tables.

#### `film_record_rows`: checklist rows (value and source)

One row per **version** of one checklist row. A change adds a version and marks the old one superseded. Nothing is overwritten, so "every change (when, why — the chip pressed)" (R7) is the version chain.

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `frr_…`, one version |
| step_id | TEXT | no | `production_steps.id` where it was asked or answered |
| step_kind | TEXT | no | copied from `production_steps.kind`, which a trigger keeps fixed (`steps.ts:93-96`), so the copy cannot go stale |
| row_key | TEXT | no | a floor id from H (`kind`, `length`, `plays`, `language`, `real`, `material`, `ceiling`, `speech`, `narrated`, `source`, `consent`, `label`, `stage`, `takes`, `voice`, `music`, `captions`, `masters`, `extras`), or `q:<slug>` for an above-floor row |
| scope | TEXT | no, default `''` | `''` = the whole production; `element:<id>`, `scene:<n>`, `shot:<id>` for rows asked per element, scene or shot (H, Elements) |
| floor | INTEGER | no, default 0 | 1 = a floor row (D1) |
| value | TEXT | yes | JSON, ≤ 2,000 chars. NULL = asked and not yet answered |
| source | TEXT | yes | `said` · `document` · `earlier_step` · `default` · `assumed` (I.2). NULL exactly when value is NULL. H's "brief" is `document` when it came from a file, and `said` when typed or picked from the + menu |
| source_ref | TEXT | yes | what answered it: `said:<id>`, `upload:<id>`, `row:<id>`, or a default key (`house`, `genre:<id>`, `platform`) |
| asked_at | INTEGER | yes | when the question was put. Set at most once per live key (section 5, test 2) |
| set_by | TEXT | no | a person's id, or an agent id for `assumed` and `earlier_step` |
| set_at | INTEGER | no | |
| change_reason | TEXT | yes | the chip or action: `answer`, `change`, `decide_for_me`, `carry:<row id>` |
| supersedes | TEXT | yes | the version this replaced |
| superseded_at, superseded_by | INTEGER, TEXT | yes | set when a newer version lands. Never cleared |
| rev, turn_id | | no | common |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, id)`.
- `frr_live`: `UNIQUE (workspace_id, production_id, row_key, scope) WHERE superseded_at IS NULL`. **One live row per key per scope.** This is how "a row with a value is never an open question again, in any step" is made structural: the key is production-wide, not per step.
- `frr_step`: `(workspace_id, production_id, step_kind, superseded_at)`, for the current step's rows.
- `frr_rev`: `(workspace_id, production_id, rev)`, for "changed since the digest".
- `frr_house`: `(workspace_id, row_key, superseded_at, source)`, for house defaults across productions.

**Rules:**

- A row whose key sets money (`ceiling`, the production's spend limit) is written only by a person. Its `set_by` must pass `isPersonApprover` (`plan-approval.ts:43-50`). "Decide for me" leaves it at the lit default ("No limit") and never sets a figure.
  - Rule 11 says "setting spend limits" belongs to people alone.
  - The cap itself is still set by the existing money path. The row records the decision.
- Where a row sets a Setup field (`plays` sets aspect, frame rate and safe areas), one writer writes the row and the production's Setup (`projects.setup`, `projects.format`, `lib/db.ts:1026`, `:1031`) in the same transaction.
  - Renders keep reading the Setup as today (rule 4: "Setup carried into every shot").
  - A test asserts the row and the Setup agree.

#### `film_record_said`: the "said" lines

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `frs_…` |
| step_id, step_kind | TEXT | no | |
| source | TEXT | no | `interview` · `prompt` · `note` · `comment` · `title` · `bar` · `client` (I.2, C1) |
| mode | TEXT | no | `agent` · `director`: the person's board mode on this production (`boardModeOf`, `lib/modelTrace.ts:396-403`) |
| text | TEXT | no | ≤ 8,000 chars. Longer text (a transcript) is split into parts |
| part | INTEGER | no, default 0 | the part's number |
| by | TEXT | no | a person's id, or `client:<share id>` for a review-link comment |
| about | TEXT | yes | what it is about: `item:<id>`, `node:<id>`, `row:<id>`, `upload:<id>` (the voice note a transcript came from) |
| created_at | INTEGER | no | |
| rev, turn_id | | no | common |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, id)`.
- `frs_step`: `(workspace_id, production_id, step_kind, created_at)`.
- `frs_rev`: `(workspace_id, production_id, rev)`.
- `frs_about`: `(workspace_id, production_id, about)`.

**Rules:**

- **Never edited.** A correction is a new line whose `about` names the old one.
- **Tenant data only** (the owner's answer 5 to Amendment (ii), 21 Oct 22:15). Never in Langfuse, telemetry, Inngest step output or a checkpoint.

#### `film_record_items`: what was made, with state, cost and reason

One row per thing made. The thing itself stays in its own table and the item points at it, so the record never copies a file or a URL.

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `fri_…` |
| step_id, step_kind | TEXT | no | |
| item_kind | TEXT | no | `element` · `still` · `sheet` · `world` · `look` · `frame` · `take` · `read` · `cue` · `mix` · `cut` · `master` · `page` · `outline` · `script` |
| ref | TEXT | no | the object: `generation:<id>`, `element:<id>`, `attribute_version:<id>`, `upload:<id>`, `treatment_version:<id>`, `edit_version:<id>`, `node:<id>` |
| parent_id | TEXT | yes | the item it belongs to: a still's element, a take's frame |
| scope | TEXT | no, default `''` | `shot:<id>`, `scene:<n>`, `element:<id>`: the group a list folds by |
| fix_of | TEXT | yes | the item this fixes |
| fix_n | INTEGER | yes | 1 or 2, counted against the plan's allowance (`MAX_FIXES_PER_SHOT`, `plan-approval.ts:29`) |
| state | TEXT | no, default `draft` | `draft` · `picked` · `kept` · `sent` · `rejected`: the furthest mark, for the index |
| picked_at, picked_by | INTEGER, TEXT | yes | |
| kept_at, kept_by | INTEGER, TEXT | yes | Keep (Look and Elements) |
| sent_at, sent_by | INTEGER, TEXT | yes | Sent (output steps) |
| rejected_at, rejected_by | INTEGER, TEXT | yes | |
| reject_reason | TEXT | yes | ≤ 500 chars: the chip pressed or the person's words |
| reject_said_id | TEXT | yes | the said line, when the reason was typed |
| quote_credits | REAL | yes | the figure on the button that started it |
| cost_credits | REAL | yes | what the ledger charged. NULL until settled |
| cost_state | TEXT | no, default `quoted` | `quoted` · `settled` · `nothing_billed` · `unknown` |
| approval_id | TEXT | yes | `film_record_approvals.id` |
| consent_ref | TEXT | yes | `identity_consents.id` for a real person's face or voice |
| mode | TEXT | no | `agent` · `director` |
| made_by, made_at, updated_at | TEXT, INTEGER, INTEGER | no | |
| rev, turn_id | | no | common |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, id)`.
- `fri_ref`: `UNIQUE(workspace_id, production_id, ref)`. One item per object, so mirroring is idempotent.
- `fri_step`: `(workspace_id, production_id, step_kind, state, made_at)`.
- `fri_scope`: `(workspace_id, production_id, scope, made_at)`.
- `fri_rev`: `(workspace_id, production_id, rev)`.

**Rules:**

- **Kept and Sent are separate marks.** A card shows both, and Send does not need Keep (`CLAUDE.md:56`: "Keep is a separate mark (kept_at, kept_by) … the commit is Sent").
  - For a take, Sent mirrors today's `generations.approved_by`/`approved_at` (`lib/db.ts:1059-1062`). One writer writes both in the same transaction.
  - Whether `generations` also gains `kept_at`/`kept_by` (19 Oct, Q12) belongs to the Keep PR. Where that column exists, the record is written in the same transaction.
- **A real person's face, voice or lip-sync item needs a live `consent_ref`.** The gate itself stays in `lib/security/consent.ts`; the record mirrors it and never grants it.
- **Costs are in credits only.** No `_usd` column exists, so no vendor cost can reach a customer.
  - The three credit columns join the credit-unit conversion list (`lib/creditConversionTenant.ts:77-89`). This is the one **[money]** touch in step M2 (section 6).

#### `film_record_approvals`: who, when, the quote, the allowance left

A mirror. The money tables stay the truth: `rig_plan_approvals` (`plan-approval.ts:175-192`), `rig_agent_steps` (`lib/workbench/rig-agent-store.ts:69-105`), prepared jobs, and the meter.

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `fra_…` |
| step_id, step_kind | TEXT | no | |
| approved_by | TEXT | no | a person. `CHECK (NOT notAPersonSql(approved_by))` plus the same guard triggers as `plan-approval.ts:56-59`, `:194-202` |
| approved_at | INTEGER | no | |
| what | TEXT | no | `plan` · `step` · `job` · `band` · `carry` |
| quote_kind | TEXT | no | `exact` · `up_to` · `range` (rule 14's forms; the band form of 21 Oct) |
| quote_credits | REAL | no | the top: the figure on the button |
| quote_low_credits | REAL | yes | a range's low end |
| allowance_credits | REAL | yes | what was left of the plan's limit when this was approved |
| fixes_left | INTEGER | yes | when approved (`fixRoom`, `plan-approval.ts:165-169`) |
| covers | TEXT | no, default `'[]'` | the item ids or plan step numbers it covers |
| money_ref | TEXT | no | the row it mirrors: `plan_approval:<id>`, `rig_step:<id>`, `prepared_job:<id>`, `generation:<id>` |
| settled_credits | REAL | yes | filled when known |
| closed_at, closed_reason | INTEGER, TEXT | yes | |
| created_at | INTEGER | no | |
| rev, turn_id | | no | common |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, id)`.
- `fra_money`: `UNIQUE(workspace_id, money_ref)`, an idempotent mirror.
- `fra_when`: `(workspace_id, production_id, approved_at)`.

**Rules:**

- **Written after the money row commits, never inside a money transaction**, so no money code changes.
  - The route or graph node that recorded the approval calls the mirror writer next.
  - Each turn starts by reconciling missing mirrors from the money tables, keyed by `money_ref`. A crash between the two leaves a gap that the next turn fills, never a duplicate.
- **"Allowance left" at turn time is read live from the money row**, through `plan-approval.ts`'s exported readers. The snapshot here is what the person saw when they approved.
- **No gate reads this table.** A test asserts no module on the money path imports the record (section 5, test 5).

#### `film_record_private`: agent-private rows (B, J, C1)

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `frp_…` |
| step_id, step_kind | TEXT | no | |
| item_id | TEXT | yes | the take, still or read it describes |
| node_id | TEXT | yes | the Director's node, for settings remembered before a take exists (B1) |
| engine | TEXT | yes | the catalogue id the Director or the plan chose |
| settings | TEXT | no, default `'{}'` | JSON: stage, seconds, resolution, seed, the camera-bank picks (R10) |
| prompt_sent | TEXT | yes | ≤ 16,000 chars: the prompt as sent (B2; J's Take tab) |
| voice_ref | TEXT | yes | the voice id (G, Sound) |
| chose | TEXT | no | `director` · `agent`: who chose the engine. The Agent factor is keyed on this (R11, the owner's answer 1, 21 Oct) |
| created_at | INTEGER | no | |
| rev, turn_id | | no | common |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, id)`.
- `frp_item`: `UNIQUE(workspace_id, item_id) WHERE item_id IS NOT NULL`.
- `frp_node`: `(workspace_id, production_id, node_id)`.
- `frp_step`: `(workspace_id, production_id, step_kind)`.

**Rules:**

- **Never in this table:** vendor costs, vendor job handles, account or credential fingerprints. Those stay in `generations.params`, stripped from exports as today (`lib/workspaceExport.ts:50-76`).
- **Atomik's own thinking model and effort are never recorded here or anywhere in the record** (E: "never disclose").
- **A separate table, so the guard is structural.** Only modules on a closed list may name `film_record_private`: the store, the context builder, the Director views and the export. A source-scan test enforces the list, the way the `stepStoreForTests` guard works.

#### `film_record_edges`: ripple

| Column | Type | Null | Note |
|---|---|---|---|
| from_id | TEXT | no | a row version (`frr_…`) or an item (`fri_…`) it was made from |
| to_id | TEXT | no | the item or row made from it |
| via | TEXT | no, default `''` | the row key the downstream read (`plays`), for the ripple list's wording |
| created_at | INTEGER | no | |
| rev, turn_id | | no | common |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, production_id, from_id, to_id)`.
- `fre_to`: `(workspace_id, production_id, to_id)`.

**Rules:**

- **Edges come from what was declared, never from a model's guess.** Each tool in the registry declares the row keys it reads (G's CALLS). The commit that writes an item writes one edge from each live row version it read, and from each input item (a frame into its take).
- **Edges point at row *versions*.** When `plays` changes, the items made from the old version are exactly the ones touched.
- **The ripple query** is one recursive CTE from the superseded version. It is depth-capped at 12, deduplicated with `UNION`, and returns items whose state is not `rejected`. It lists them and changes nothing.
  - "Carry the change" is then a quoted job through the price path, approved by a person like any other (rule 14).

#### `film_record_turns`: bookkeeping (ids and timings only)

| Column | Type | Null | Note |
|---|---|---|---|
| workspace_id, production_id | TEXT | no | |
| id | TEXT | no | `frt_…`. The `turn_id` on every row the turn writes |
| turn_key | TEXT | no | the idempotency key (3.2) |
| kind | TEXT | no | `agent` · `director` · `system` |
| step_id | TEXT | no | |
| run_id | TEXT | yes | the graph thread (a `rig_agent_runs.id`, LG §3.5) |
| checkpoint_id | TEXT | yes | the LangGraph checkpoint the node started from |
| base_rev | INTEGER | no | the head when the turn read the record |
| rev | INTEGER | yes | the head it committed. NULL until committed |
| state | TEXT | no | `started` · `committed` · `failed` |
| failed_code | TEXT | yes | a code, never text |
| skipped | TEXT | no, default `'[]'` | row keys dropped because a person changed them after `base_rev` (3.2) |
| started_at, committed_at | INTEGER | no / yes | |

**Keys and indexes:**

- `PRIMARY KEY(workspace_id, id)`.
- `frt_key`: `UNIQUE(workspace_id, turn_key)`.
- `frt_when`: `(workspace_id, production_id, started_at)`.

**Rules:**

- No words in this table.
- It is not part of "what Atomik knows" (I: "if Atomik knows it, it is a row with a source"). It is how a commit is made exactly once.

### 2.3 Layer 3: `film_record_digests`

| Column | Type | Null | Note |
|---|---|---|---|
| workspace_id, production_id | TEXT | no | |
| step_id | TEXT | no | `production_steps.id` |
| step_kind | TEXT | no | |
| body | TEXT | no | JSON `{decided:[…], made:[…], open:[…]}`, ≤ 3,000 chars in total (about 450 words: I's "a few hundred words"). Enforced in code and tested, not by a CHECK (section 1) |
| based_on_rev | INTEGER | no | the record revision it was written from |
| version | INTEGER | no | +1 each time it is rewritten |
| turn_id | TEXT | no | the turn that wrote it |
| written_at | INTEGER | no | |

**Key:** `PRIMARY KEY(workspace_id, production_id, step_id)`. One per step by construction.

**Rules:**

- **When it is written:** every model turn that works a step rewrites that step's digest in the same commit (3.2).
  - The digest is part of that turn's own output, not a second call (question 5).
  - A change with no model in it (a Director's hand edit, Keep, Send, an undo) does not rewrite it. The digest goes stale, and the context builder adds a free, deterministic "changed since" list (4.1).
- **Overwritten in place.** A digest is derived from rows that are never erased, so nothing is lost when it changes.
- **Why not columns on `production_steps`:** the rail reads that table with `SELECT *` (`steps.ts:243-250`). Digest text would then ride along on every rail read, and the "only these modules read the record" guard could not be kept.

### 2.4 Layer 4: the turn context

Not stored. It is built each turn by the builder in section 4, and each build is traced as ids and timings (section 5, test 7).

---

## 3. The LangGraph checkpoint: "checkpoint before, commit after"

### 3.1 Where each thing lives

| Thing | Where | Holds |
|---|---|---|
| Graph checkpoints | `agent_checkpoints`, `agent_checkpoint_writes` in the workspace's database (LG §4.3), from slice 1, not this PR | LG §3.5's ids-only state, **plus two fields:** `recordRev` (the head the node read) and `turnKey` |
| The record | the `film_record_*` tables | everything with words, values, states and costs |
| The run's truth | `rig_agent_runs`, `rig_agent_steps`, `rig_plan_approvals` (LG §1, "What does not change") | unchanged |

- A run is one thread (`thread_id = runId`, LG §3.5). A production has one record and many runs. The record is therefore per production, and the checkpoint points at it.
- **No run's behaviour depends on its checkpoint** (LG §3.5), and the same holds for the record: a fresh pass re-reads the head.

### 3.2 One turn, in order

1. **Before.** LangGraph has checkpoint C*n* (the node's start). The node reads the head `base_rev` and inserts a `film_record_turns` row in state `started`, keyed by `turn_key`.
   - `INSERT … ON CONFLICT(workspace_id, turn_key) DO NOTHING`.
   - If the key is already `committed`, the node returns that turn's result and calls no model. This covers a crash after the commit but before C*n+1*.
2. **Read.** The context builder reads layers 1–3 in one read transaction (section 4), so it sees a consistent snapshot.
3. **Think.** The model call goes through the existing paid path, reserved and settled as today.
   - A re-run never sends twice: the planning turn's `planning_started_at` and fixed meter event id (LG §5.4) do this.
   - No record row is written yet.
4. **Commit.** One write transaction (`client.transaction("write")`, as in `steps.ts:217-230`):
   1. `UPDATE film_record_turns SET state='committed' … WHERE turn_key=? AND state='started'`. If no row changed, roll back and return the committed result. This makes the commit idempotent.
   2. `UPDATE film_record_heads SET rev = rev + 1 … RETURNING rev`. This takes the head under the database's single write lock.
   3. For each checklist row the turn writes: if the key's live version changed after `base_rev` and was set by a **person**, that row is skipped and listed in `skipped` (question 6: a person's word beats Atomik's). Otherwise the old version is marked superseded and the new one inserted.
   4. Insert the said lines, items, approval mirrors, private rows and edges, and rewrite the step's digest, all at the new `rev` with this `turn_id`.
   5. Commit.
5. **After.** The node returns. LangGraph writes C*n+1* with `recordRev = rev` (durability `sync`, LG §4.6).

**Director actions** (no graph) use the same commit function:

- `kind = 'director'`;
- `turn_key = 'director:<user>:<request id>'`, the client's idempotency id for the press, as `workbench_draft_writes` does for saves (`lib/workbench/records.ts:31-35`).

### 3.3 What a failed turn leaves

| Fails at | The record | The checkpoint | Money |
|---|---|---|---|
| 1–2 (before the model) | unchanged; turn `started`, then `failed` with a code | C*n* | nothing reserved: "Nothing billed" and Retry (rule 14) |
| 3 (model failed or refused) | unchanged; turn `failed` | C*n* | settled by today's rules: charged only what was used, else "Nothing billed" |
| 4 (commit failed) | unchanged: the transaction rolled back | C*n* | the model's use is settled as in row 3. Retry re-runs under the same approval |
| between 4 and 5 | committed | C*n*; the re-run finds the key committed and returns | nothing new |

"A session that ends resumes from the record, not from a chat" (I, Durability): a new session builds the context from the head (section 4). It never reads `atomik_messages` or any chat table.

---

## 4. The turn context builder

### 4.1 What it loads, in a fixed order

Stable parts come first so the prompt cache holds them (E: "a long record read is mostly cached input").

| # | Part | Query | Bound |
|---|---|---|---|
| 1 | The step's system rules and its checklist (D1 floor rows, above-floor example bank) | code, no query | fixed |
| 2 | Layer 1 | `plannerMemory` (`atomikMemory.ts:600-608`, already ranked and cut small); house defaults (one grouped query on `frr_house`); the production's consents (one query) | Memory's own limits; ≤ 40 defaults |
| 3 | **All** digests | `SELECT … FROM film_record_digests WHERE workspace_id=? AND production_id=?` | ≤ 3,000 chars × steps, with a budget of 48,000 chars in total. Above that, every digest's cap shrinks evenly |
| 4 | "Changed since" for stale digests | rows, said lines and items with `rev > based_on_rev`, one query per table using the `*_rev` indexes | ≤ 30 entries per step, keys and values only |
| 5 | Every live checklist value in the production (compact: key, scope, value, source) | one query on `frr_live` | ≤ 400 rows |
| 6 | The **current step's full rows**: versions with sources and change reasons | one query on `frr_step` | ≤ 120 versions |
| 7 | The current step's said lines, newest first | one query on `frs_step` | ≤ 60 lines or 24,000 chars. Older lines are folded into the digest and fetched on demand |
| 8 | The current step's items | one query with `ROW_NUMBER() OVER (PARTITION BY scope ORDER BY made_at DESC)`: in full, the kept, sent and picked items and the newest 3 per scope; plus one grouped query of counts by scope and state, with reject reasons cut to 200 chars | ≤ 60 items in full |
| 9 | Agent-private rows for exactly those items | one query, `item_id IN (…)` from 8 | ≤ 60 rows |
| 10 | Open approvals and the allowance left | one read through `plan-approval.ts`'s readers | ≤ 10 |
| 11 | Library search results the turn asked for | the search tool (F) | its own cap |
| 12 | The person's latest words | the request | the bar's own limit |

**Fetched on demand:** `record_lookup` is a registry tool (rule 11), free because no model runs (B3), read-only, with a mocked test.

- **Arguments:** step, row keys, item ids, and a text to match in said lines. The match uses `instr`/`LIKE` inside the step's lines through `frs_step`, so no full-text extension is needed.
- **Limits:** ≤ 50 rows and 12,000 chars per call; ≤ 5 calls per turn.
- **Example:** "what did they say at Brief about the label" is one lookup on `step=brief`, `text=label`.

**Not loaded:** any chat history; another production's rows; another member's private board (`mayReachProject`).

**Size bounds and price:**

- Worst case, before the person's words, is about 120,000 characters (about 30,000 tokens). Most of it is the cached prefix (parts 1–3).
- The builder reports its size before any model runs, so the band quote can be priced from it (B2). That is LG question 12 ("cap the context, then a money review"), and is why step M4 of the migration is a money review.
- **The judge (Reviewing) does not use this builder.** It reads the item's own rows only (B4: "with the shot's own rows, never the record").
- **Agent mode:** private rows (part 9) reach the model under a labelled section. The reply to an Agent-mode person passes the no-engine-name and no-model-name rule from step 3a before it is shown.

### 4.2 How "200 takes loads no slower than 10" is met

- **The number of queries does not depend on the number of takes:** ten reads in one read transaction (parts 2–10), and no per-item query. Part 9 is a single `IN (…)` over at most 60 ids. That removes the N+1.
- **Every query is an index range scan** on an index that leads `workspace_id, production_id, …`. `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX` and never `SCAN` on a record table (tested).
- **The payload is capped by count, not by history.** 200 takes in a step become at most 60 in full plus counts by scope. A 10-take step and a 200-take step build contexts of the same shape.

---

## 5. The guarantees, each with the test that proves it

All tests run under `ENGINE_MOCK=1` with scripted models, on file databases (the `tests/unit/productionSteps.spec.ts:15-23` setup). **No real vendor call** (rule 1).

The golden records are the Mirror and Sand productions (D10), as complete mocked records with the owner's decisions as the right answers. They live in `tests/fixtures/film-record/mirror.ts` and `sand.ts`, and the owner's decisions in them come from him. The brief fixtures (D11) live in `tests/fixtures/briefs/`.

| # | Guarantee (I) | Test file | What it asserts |
|---|---|---|---|
| 1 | **Completeness** | `tests/unit/filmRecordCompleteness.spec.ts` | At Deliver on Mirror and Sand, every Brief "said" line and row is reachable: from the digests and the live values, or by at most 2 `record_lookup` calls. A scripted model answers "what did they say at Brief about X" for each fixture question from the builder's output alone. A spy on the client shows no chat table is read |
| 2 | **Nothing asked twice** | `tests/unit/filmRecordAskOnce.spec.ts` | `frr_live` refuses a second live row per key and scope. Over every D11 brief: a row with a value is never returned as open, in any step; an asked row is never asked again; a brief that answers a floor row never produces its question, and one that doesn't always does (R2, H). The question engine's own cases land with 3d; the schema half lands in M2 |
| 3 | **Ripple** | `tests/unit/filmRecordRipple.spec.ts` | On Mirror after Shots, changing `plays` at Brief lists exactly the fixture's frames and takes (rejected ones left out). No item changes state, no generation request is made (spy on `lib/generationRequests.ts`), and "Carry the change" is a quote awaiting a person's approval |
| 4 | **Both modes write** | `tests/unit/filmRecordDirectorFirst.spec.ts` | Director actions (make, Keep, reject with a reason, a prompt typed, a note, a title) each write their rows. On a Director-first project, the first Agent turn's context opens with a read-back assembled from those rows, the scripted model's first message is not "What are we making?", and no floor row those rows answer is asked (C2) |
| 5 | **Mode separation** | `tests/unit/filmRecordModeSeparation.spec.ts` | A source scan: only the closed list of modules names `film_record_private`. For Mirror in Agent mode, the read-back, History, receipt and error payloads contain none of the fixture's engine ids, settings, prompts as sent or voice ids |
| 6 | **Never shown** | `tests/unit/filmRecordNeverShown.spec.ts` | A closed list of routes may read the record, and each returns only its view: read-back, "I assumed … · Change", the Versions chain, the receipt. A probe calls every other route with a Mirror production and finds no record ids or said-line text. The export carries the record grouped by step (section 7), with no turns table and no checkpoints |
| 7 | **Tracing** | `tests/unit/filmRecordTracing.spec.ts` (with `tests/unit/model-trace.spec.ts`) | With a fake tracer, a turn emits one record span whose keys are a closed list (as `MODEL_CALL_KEYS`, `lib/modelTrace.ts:91-94`): `workspace_id`, `production_id`, `turn_id`, `step`, `rows_read` (ids; above 200, a count and a hash), `lookups`, `read_ms`, `bytes`, `commit_ms`, `rows_written`. No attribute holds any said-line text or row value from Mirror |
| 8 | **Privacy and consent** | `tests/unit/filmRecordPrivacy.spec.ts` | Two workspaces each with its own database, then one database file holding two `workspace_id`s (as in `productionSteps.spec.ts`): nothing is read, listed, exported or archived across them. The store throws with no tenant or with another one. A real person's face, voice or lip-sync item cannot be written without a live `consent_ref`. An `agent:` approver is refused by the CHECK and the triggers. Only the closed list of modules reads record tables, so record text reaches only the turn's model call and the owner's export |
| 9 | **Durability** | `tests/unit/filmRecordDurability.spec.ts` | A failure injected at each of the four points in 3.3 leaves row counts and the head unchanged. A re-run with the same `turn_key` after a commit writes no duplicate and calls no model. A person's change racing Atomik's on the same key: the person's stands, and Atomik's is listed in `skipped`. A fresh process builds a context with the same hash from the record alone |
| 10 | **Size** | `tests/unit/filmRecordSize.spec.ts` | A digest over 3,000 chars is refused. The builder stays inside every bound in 4.1. Mirror scaled to 200 takes and to 10 takes: the same query count (an instrumented client, as in `docs/database-startup.md`), `EXPLAIN QUERY PLAN` uses an index for every record table, the payload is within its cap, and the median build time ratio over 20 runs is ≤ 1.5 |

Tests that go with the schema itself (M2):

- `tests/unit/filmRecordSchema.spec.ts`:
  - with the switch off, no table is made (as `productionSteps` does, `steps.ts:466-470`);
  - on a database with existing data, `ready()` adds only the new tables, changes no row of any existing table, and is idempotent;
  - every record table has `workspace_id` first in its key and every index (parsed from `sqlite_master`).
- `tests/unit/export.spec.ts` (extended) and `tests/unit/filmRecordDelete.spec.ts`: for section 7.

---

## 6. The migration plan, for the owner's yes

**Nothing below runs until the owner says yes.** Each step is one small PR in this order (rule 8). Each lands on `release/1` under the standing rules: full CI, an Opus review, and a money review where marked.

**The switch.** `V30_FILM_RECORD` is on only when it is exactly `"1"`, `V30_PRODUCTION_MODEL` is on, and the workspace has the new interface. That is the `V30_LIBRARY` rule (`lib/elementLibrary.server.ts:24-27`) and the production-model rule (`lib/productionModel/flag.ts:13-21`). It is **off for every customer workspace.** With it off, no table is made, nothing is read or written, and no screen, route or price changes.

**How each workspace migrates.** On first use, as today:

- `filmRecordReady()` runs the `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` batch once per database per instance. It is memoised, and the memo clears on failure (the `memoryReady` and `rigAgentReady` pattern, `atomikMemory.ts:59-70`, `rig-agent-store.ts:123-134`).
- No step adds a column to an existing table, so the column installer (`lib/schemaInitialization.ts:6-56`) is not needed.
- There is no script. `ops/` holds no tenant-schema tooling today, and none is added.

| Step | What changes | Additive? | Switch | Existing workspaces | Rollback |
|---|---|---|---|---|---|
| **M0** (this PR) | `docs/film-record-schema.md`; a pointer in `docs/redesign-plan.md` | docs | — | — | revert the doc |
| **M1** | Deleting a project also archives its `production_steps` rows. Today they are left behind: they are not in the archive list at `app/api/projects/[id]/route.ts:149-167` | yes: rows copied to `archived_rows` first (`lib/archive.ts:4-11`) | none needed: only the house workspace has steps | nothing to migrate | revert; archived rows stay |
| **M2** | The nine tables and their indexes; the store, its factory and `commit()`, with idempotency; the project delete also archives record rows; the workspace export includes the record (section 7); the record's credit columns join the credit-unit conversion list (`lib/creditConversionTenant.ts:77-89`) **[money]**; the Mirror and Sand fixtures; tests 8, 9, 10 (schema half), the schema, export and delete tests. **No product code writes yet** | yes: new tables only | `V30_FILM_RECORD` | tables made on first use with the switch on | turn the switch off: nothing reads them. Reverting the code leaves the tables unread. Nothing dropped |
| **M3** | Writers in the product, behind the switch: Director actions (C1); said lines from the bar, prompts, notes, comments, titles and client comments; item and approval mirrors after each existing write, with the reconcile at turn start; rejection reasons; consent refs. Tests 4, 5, 6 | yes | `V30_FILM_RECORD` | first write makes the head at rev 0 | switch off: existing paths are unchanged, because the record writes come after their commits |
| **M4** | Digests, the context builder, `record_lookup` in the registry, the record span. Tests 1, 7, 10. **[money] review:** the builder's size feeds the band quote (LG question 12). No price row changes | yes | `V30_FILM_RECORD` | — | switch off: turns build context as today |
| **M5** | Ripple: tools declare the rows they read; edges written; the ripple list; "Carry the change" as a quote through the price path. Test 3. **[money] review:** it offers paid work (approved by a person, priced as its tools are) | yes | `V30_FILM_RECORD` | — | switch off: no ripple list is offered |
| **M6** | LangGraph slice 3's context node reads the builder. The state gains `recordRev` and `turnKey`. This is the slice's own PR and review | graph state fields only | the slice's own switch and this one | — | as the slice's rollback |
| **M7** | The question engine (3d) reads and writes rows. Test 2's engine half and the D11 briefs | yes | as 3d | — | as 3d |
| **M8** | The owner sets `V30_FILM_RECORD=1` in Coolify. This is **his action**; the lead does not set it | — | — | the house workspace only (new interface) | he unsets it |

**Backfill of existing productions: none is proposed** (question 4).

- Only the house workspace has v30 productions: `V30_PRODUCTION_MODEL` has never been on anywhere else (`steps.ts:29-31`).
- A production that predates the switch starts with an empty record at rev 0.
- Its first Agent turn assembles what already exists: the board, Setup, cast and elements, as `earlier_step` rows with `source_ref` pointing at them. That part is deterministic, so it is free (B3: "free means no model ran").
- Anything that needs a model to read is the B5 Reading turn, quoted as a ceiling and charged once, as the SOW already says.

**Destructive or irreversible steps: none.**

- No `DROP`, no `RENAME`, no table rebuild, no column change, and no rewrite of an existing row, in any step.
- Deleting from a record table only happens by archiving: the row is copied to `archived_rows` in the same write first (`lib/archive.ts:43-60`).
- Two patterns from elsewhere in the schema are **not** used here: the dev-only rebuild of `production_steps` (`steps.ts:113-129`), and the `bindings` rebuild in `lib/db.ts` bootstrap.
- The only change that cannot be undone by a revert is that new tables exist in the house workspace's database once the switch has been on. They stay, unread, after a rollback.

---

## 7. Export and deletion

### 7.1 Export

The workspace export is owner-only (`app/api/export/route.ts:51-54`; `requireOwner`, `lib/auth.ts:394-404`). Members, and so Agent-mode members, never receive it. M2 adds one section to `workspaceExport` (`lib/workspaceExport.ts:79-235`), read inside its existing read transaction (`:85`):

- **`film_record`:** per production, then per step, then by row key or item. It is **not** a chronological log. It holds:
  - the checklist rows, every version, with source and change reason;
  - the said lines;
  - the items, with state, marks, credits and reasons;
  - the approval mirrors;
  - the edges;
  - the digests.
- **`film_record_director`** (question 3): the agent-private rows (engine, settings, prompt as sent, voice id), in their own section.
- **Left out:** `film_record_turns` (bookkeeping) and the graph checkpoints. Vendor costs and handles are never in the record to begin with.
- **The existing rules still apply:** in a credit workspace every `_usd` key is stripped (`workspaceExport.ts:115-127`). A test asserts the record section has none.
- **Private boards:** a private board's record is exported only to the exporting owner when it is theirs. Same boundary as `workbench_projects` (`workspaceExport.ts:128-143`).
- **The allowlist pattern stays** (`workspaceExport.ts:12-41`): record tables are named in the code, not picked up by a scan.
- **A future per-production export for members** would use a `publicRecord(mode)` view, as pipelines do (`workspaceExport.ts:153-184`, `publicRun`). It drops the private section for anyone whose board mode on that production is Agent (`boardModeOf`, `lib/modelTrace.ts:396-403`). It is not in this plan.

### 7.2 Deletion

- **Deleting a production archives its record in the same transaction as the rest of the production** (`app/api/projects/[id]/route.ts:111-195`). M2 adds the nine tables to its archive steps, filtered on `workspace_id` and `production_id`.
- The rows leave every screen and are copied to `archived_rows` first, under the owner's rule that "nothing a team makes is ever erased" (`lib/archive.ts:4-11`). Restoring a production restores its record from the same copies.
- **Erasure happens only when the workspace is purged**, which removes its whole database (`lib/purge.ts:207-212`).
- Whether a production's record should instead be truly erased on delete (a person's words, consent) is question 2.
- **"Never shown as a log" holds in both:** the export groups by step, and the archive is never listed on any screen.

---

## 8. Open questions for the owner

Real decisions only, each with a recommendation.

1. **Is the record "the LangGraph state" by pointer?** The rows live in the record tables. The graph state carries only the production id and the record revision, and checkpoints stay ids only (LG §4.6, §10.5).
   - *Recommendation: yes.* Putting the record in the checkpoint would break the approved privacy probe and grow without bound.
2. **What does deleting a production do to its record: archive it, or erase it?**
   - Archive is today's rule for every production row: hidden everywhere, restorable, erased only with the workspace.
   - Erase would apply to the said lines and the record only.
   - *Recommendation: archive,* the same as the rest of the production. Erasure stays with workspace purge. If privacy needs it later, an owner-only "erase this film's record" can be its own PR.
3. **Does the owner's workspace export include the Director-private rows** (engine, settings, prompt as sent, voice id)?
   - *Recommendation: yes,* in their own `film_record_director` section. It is the owner's data, and Director mode names engines. Vendor costs and handles never appear. Any member-facing export later drops the section for Agent mode.
4. **Backfill of productions that exist before the switch?**
   - *Recommendation: none.* The record starts empty. The first turn imports what is already structured, free because no model runs. Anything that needs reading is the B5 Reading turn, quoted as a ceiling, as the SOW says.
5. **[money] Is the step digest written inside the turn's own model call, with no second call and no price row?** Changes with no model in them leave the digest stale, and a free, deterministic "changed since" list covers the gap.
   - *Recommendation: yes.* It keeps digests out of the receipt and makes "regenerated every turn" cost nothing extra.
6. **When a person and Atomik change the same row at the same moment, does the person's change stand?** Atomik's would be dropped and proposed again.
   - *Recommendation: yes.* It matches "only a person decides". The dropped key is listed in the turn's `skipped`, never silently lost.
7. **House defaults (D8): what counts as "answered the same way three times"?**
   - *Recommendation:* the three most recent productions that answered the row gave the same value. Only `said` or `document` answers count; a "Decide for me" assumption does not. A money row (`ceiling`) never becomes a house default by itself, because setting a spend limit is a person's act (rule 11).
8. **The switch: a new `V30_FILM_RECORD`, rather than reusing `V30_PRODUCTION_MODEL`?**
   - *Recommendation: the new one.* It is off for customers, and on only where the production model and the new interface are on. That way the steps can be switched on without the record, and the record can be rolled back on its own.
