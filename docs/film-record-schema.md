# The film record: schema and migration plan (step 3c)

Status: **design, for the owner's yes, line by line.** Docs only: nothing is migrated, and no code or SQL changes. No migration PR exists until the owner says yes to section 5.

- **Read from:**
  - code at `origin/release/1` `d0048482` (every `file:line` is on that commit);
  - Amendment (iii) A–M, mainly I (`origin/docs/amendment-iii-22oct` `27faeda8`);
  - SOW R7 (`docs/particl-sow-v1.md:911`), answer 5 (`:959`), and Amendment (ii) B and C (`:1000-1022`);
  - the LangGraph design note of 21 Oct, approved rev 3, cited as "LG §n". Its public copy ships with slice 1.
- **Labels:** "(ii) Bn" and "(iii) Bn" name the two different B lists. This doc is also design note D of 21 Oct ("the ledger, with agent-private fields never served").
- **Readers:** the owner reads sections 0–7. The appendix is for whoever builds M2.

---

## 0. In short

- **Nine new tables**, all prefixed `film_record_`, in each workspace's own database. `workspace_id` is on every row and leads every key and index.
- **No existing table is changed:** none gains a column, and none is rewritten, renamed or dropped.
- **Existing tables are used, not copied:**
  - `atomik_memory` and the Library are layer 1;
  - `production_steps` is the spine;
  - `identity_consents` holds consent;
  - `generations` stays the truth for a take: what ran and its state;
  - the money tables stay the truth for money. The record mirrors them, and no gate reads the record.
- **A new switch, `V30_FILM_RECORD`:** on only in the house workspace and any workspace listed for the new interface. Off for customers.
- **Migration:** on first use, as today. No script, no backfill, nothing destructive.

**Where the amendment can't be built word for word:**

1. **"The production record — the LangGraph state, checkpointed after every turn"** (I.2).
   - Built as: tenant rows, with the graph state holding a pointer to them (production id and record revision). That is R7's "checkpointed as tenant rows" (SOW:911).
   - Why: the approved design note keeps checkpoints to ids only (LG §4.6, §10.5).
   - This is question 1.
2. **"The interview … lives in Turso and nowhere else."** True of everything we store. It is still sent to the thinking model during the turn that reads it.
3. **"Nothing in it trains anything."** Our code can prove where record text goes. Whether a vendor trains on API traffic is the vendor's setting on the key, not a test.
4. **"200 takes load no slower than 10."** Tested as: the same number of queries, indexed plans, a capped payload, and a median time ratio ≤ 1.5.
5. **Script "said lines by scene"** (G). The script's text stays in its version table. Said lines are a person's own words ((ii) C1).

---

## 1. The tables

| Table | Layer | Purpose |
|---|---|---|
| (none new) | 1 workspace memory | A read view over `atomik_memory`, the Library, consents and looks, plus two derived queries: house defaults and the Director's engine preferences |
| `film_record_heads` | 2 | One row per production: the revision every commit checks and advances |
| `film_record_rows` | 2 | Checklist rows, one version per change: value, source (said · document · earlier step · default · assumed), who, when, why |
| `film_record_said` | 2 | A person's words with step, source and mode: the interview, prompts, notes, comments, titles, bar, client |
| `film_record_items` | 2 | Everything made, pointing at its own table: the reject reason, the quote, the cost, consent. State is read live where that table holds it |
| `film_record_approvals` | 2 | A mirror of each approval (who, when, the quote, the allowance left), keyed to the money row |
| `film_record_private` | 2 | A Director node's settings before a take exists, voice ids, and who chose the engine. Never shown in Agent mode |
| `film_record_edges` | 2 | Ripple: what was made from which row version |
| `film_record_turns` | 2 (bookkeeping) | One row per turn: the idempotency key, the revisions, the outcome. Ids and timings only |
| `film_record_digests` | 3 | One bounded digest per step |
| (none) | 4 turn context | Built fresh every turn from layers 1–3. Never a chat history |

**Rules that hold across all of them** (detail in A.0):

- **Private boards stay private.** House defaults and Director preferences are derived only from productions the turn's person may reach.
- **One live version per checklist key** (a unique index), so "never asked twice" is structural. A change adds a version recording when, who, and the chip pressed.
- **The spend-limit row holds a reference to the existing cap, never a figure.** Only a person sets it.
- **`generations` is the truth** for a take's state and for what ran.
- **The money tables are the truth for money.** Approval mirrors are written after the money commit and never fail it. Approvers who are not people are skipped.
- **Credits only:** there is no `_usd` column. Errors never echo a value, a said line or a private field.

---

## 2. The checkpoint: "checkpoint before, commit after"

LangGraph checkpoints keep the design note's ids-only state, plus `recordRev` and `turnKey`. A production has one record and many runs (threads), and no run depends on its checkpoint (LG §3.5).

1. **Before.** The node reads the head and opens a turn row under its idempotency key. If that key has already committed, the node returns that result and calls no model.
2. **Think.** The model call goes through the paid path as today; a re-run never sends twice (LG §5.4). Nothing is written to the record yet.
3. **Commit.** One write transaction: the turn is marked committed (once only), the head advances, and every row of the turn lands at the new revision.
   - If a person changed the same checklist key meanwhile, the person's value stands. Atomik's is listed as skipped, and the step's digest is marked stale (question 6).
4. **After.** The next checkpoint stores the new revision.

**If a turn fails:**

- A failure before the commit leaves the record as it was. Money settles as today: "Nothing billed", or what it cost.
- Retry runs under the same key: a failed turn goes back to started.
- A crash after the commit is found by its key on re-run, so nothing repeats.
- A new session builds its context from the record, never from a chat.

---

## 3. The turn context

**What it loads.** Each turn loads, stable parts first so they stay cached:

1. the step's rules and checklist;
2. layer 1;
3. **all** step digests, with a free "changed since" list for stale ones;
4. every live checklist value;
5. the current step's rows, said lines and items, with items folded by shot (kept, sent and recent ones in full, the rest as counts);
6. open approvals;
7. requested Library results;
8. the person's words.

**`record_lookup`** fetches anything else.

- It is free, read-only and bounded.
- It is internal to Atomik's turn: no button, no MCP (question 10), and never private rows in Agent mode.

**Private rows by mode:**

- In Agent mode, no private row enters the model's context; tools read what they need in code.
- A Director-mode turn sees its own private rows.

**Size and price:**

- The worst case is about 30,000 tokens before the person's words, mostly cached.
- The size is known before any model runs, so the band quote can be priced from it ((ii) B2; LG question 12). That is why M4 is a money review.
- The judge reads only the item's own rows ((ii) B4).

**Why 200 takes cost no more than 10:**

- about ten indexed reads in one transaction, with no query per item;
- the payload is capped by count, not by history.

---

## 4. The guarantees and their tests

All tests run under `ENGINE_MOCK=1` on file databases, with no vendor call (rule 1).

- **Fixtures:** the Mirror and Sand golden records (K, D10), whose right answers are the owner's, and the D11 briefs.
- **Detail:** each test's full assertions are in A.5.

| # | Guarantee (I) | Test | Proves |
|---|---|---|---|
| 1 | Completeness | `tests/unit/filmRecordCompleteness.spec.ts` | Every Brief said line and row is in the context or reached by a fixed lookup within 2 calls, paraphrases included |
| 2 | Nothing asked twice | `tests/unit/filmRecordAskOnce.spec.ts` | A row with a value is never open again, in any step |
| 3 | Ripple | `tests/unit/filmRecordRipple.spec.ts` | Changing `plays` lists exactly the fixture's frames and takes, and remakes nothing |
| 4 | Both modes write | `tests/unit/filmRecordDirectorFirst.spec.ts` | Director rows open the first Agent context as a read-back, and none of the floor keys they answer is asked |
| 5 | Mode separation | `tests/unit/filmRecordModeSeparation.spec.ts` | Only listed modules import the private module. Private values echoed by a scripted model never reach an Agent-mode reply, History, receipt or error |
| 6 | Never shown | `tests/unit/filmRecordNeverShown.spec.ts` | No route under `app/api` (by glob) returns record ids or interview sentinel strings, outside the listed views |
| 7 | Tracing | `tests/unit/filmRecordTracing.spec.ts` | The record span carries ids, counts and timings only |
| 8 | Privacy and consent | `tests/unit/filmRecordPrivacy.spec.ts` | Nothing crosses a workspace or another member's private board. A real face or voice cites its consent tick when there is one, and nothing is refused for want of it. No machine approver |
| 9 | Durability | `tests/unit/filmRecordDurability.spec.ts` | A failure leaves the record unchanged. Retry under the same key works. A crash after the commit duplicates nothing. The person wins a race |
| 10 | Size | `tests/unit/filmRecordSize.spec.ts` | 200 takes vs 10: the same query count, indexed plans, a capped payload, a time ratio ≤ 1.5 |
| — | Nothing trains on it | not a test | the vendor's data-use setting on the key, set by the owner |

---

## 5. The migration plan, for the owner's yes

**Nothing below runs until the owner says yes.** One small PR per step, in this order (rule 8).

Each step has its own yes (owner, 23 Oct 2026, 13:15): M1 may go after deploy #6 (it is neither money nor a schema change); M2 and every later step each wait for his yes before it runs. Approving this plan approves no step.

**The switch.** `V30_FILM_RECORD` is on only when all three hold:

- it is exactly `"1"`;
- `V30_PRODUCTION_MODEL` is on;
- the workspace has the new interface: the house workspace, or one listed in `newInterfaceWorkspaces` (`lib/productionModel/flag.ts:6-8`).

It is off for every customer workspace. When it is off, nothing is made, read or written.

**First use.** Each database gets `CREATE … IF NOT EXISTS` on first use, memoised as `memoryReady` is (`lib/atomikMemory.ts:59-70`).

| Step | What changes | Switch | Rollback |
|---|---|---|---|
| **M0** | This doc and a pointer in `docs/redesign-plan.md` | — | revert |
| **M1** | Project delete also archives `production_steps` (it is missing at `app/api/projects/[id]/route.ts:149-166`), **only where the table exists**: checked in `sqlite_master` first, as the route does for `project_library_uploads` (`:131`, `:164`). Without that check, a delete fails where the table is absent (`lib/archive.ts:69-70`). Test: delete in a database without the table | none (a guarded no-op) | revert; archived rows stay |
| **M2** | The nine tables, the store and its idempotent commit. Project delete archives the record tables, each checked in `sqlite_master` first (test: delete with no record tables). The export section. The fixtures. The schema, privacy, durability and size tests. **[money]:** the six credit columns and their archived copies join the credit-unit conversion. **No product code writes yet** | `V30_FILM_RECORD` | switch off: nothing reads them, nothing is dropped |
| **M3** **[money]** | Product writers: Director actions, said lines, and item and approval mirrors after the existing commits. **A mirror write never throws into the money path:** a failure is logged as ids and a code, and the next turn's reconcile fills it. Tests: a failing mirror leaves the approval response unchanged; the reconcile skips non-person approvers | `V30_FILM_RECORD` | switch off: existing paths unchanged |
| **M4** **[money]** | Digests, the context builder, `record_lookup`, the record span. The context size feeds the band quote; no price row changes | `V30_FILM_RECORD` | switch off: turns build context as today |
| **M5** **[money]** | Ripple, and "Carry the change" as a quote a person approves | `V30_FILM_RECORD` | switch off |
| **M6** | LangGraph slice 3 reads the builder (the slice's own PR) | the slice's and this one | as the slice |
| **M7** | The question engine (3d) reads and writes rows | as 3d | as 3d |
| **M8** | **The owner** sets `V30_FILM_RECORD=1` in Coolify | — | he unsets it |

**Backfill: none** (question 4). v30 productions exist only where the production-model switch was on (`lib/productionModel/steps.ts:29-31`). An older production starts with an empty record, and its first turn imports what is already structured.

**Destructive or irreversible steps: none.**

- No `DROP`, `RENAME`, rebuild, column change or rewrite of an existing row.
- A record row leaves its table only by archiving, copied first in the same write (`lib/archive.ts:43-60`).
- A revert leaves the new tables in place, unread.

---

## 6. Export

- **Who gets it:** the workspace export is owner-only (`app/api/export/route.ts:51-54`).
- **What M2 adds:** a `film_record` section, grouped by production and step, never as a log. It holds checklist versions, said lines, items, approval mirrors, edges and digests. Turns and checkpoints are left out.
- **Private rows:** only `chose = 'director'` rows are exported. An engine Atomik chose is never exported, per the 17 Oct rule: "Agent jobs never expose an engine in the API, receipts, exports or error messages; Director jobs expose what they chose" (`CLAUDE.md:54`).
- **Existing rules carry over:** the `_usd` strip, the private-board boundary and the table allowlist (`lib/workspaceExport.ts:12-41`, `:115-143`).

**For the owner, out of scope here:** today's export already writes `generations.model` for every take, Agent jobs included (`lib/workspaceExport.ts:104-106`). It is flagged for a follow-up PR on the export's engine field (the model-disclosure work in 3b-3).

---

## 7. Open questions for the owner

1. **Record by pointer.**
   - Rows stay in tables. The checkpoint holds the production id and the record revision (R7: "checkpointed as tenant rows").
   - *Recommend: yes.*
2. **Deleting a production: archive or erase its record?**
   - Archive is today's rule (`lib/archive.ts:4-11`). Rows leave every screen and can be put back by hand from `archived_rows`; no restore route exists. Erasure happens only with a workspace purge (`lib/purge.ts:207-212`).
   - Said lines duplicate words that also sit in their own tables (prompts, notes, review comments, titles), so an erase must cover both copies.
   - *Recommend: archive,* with an owner-only "erase this film's record" later if privacy asks for it.
3. **Director-private rows in the export.** Settled by the 17 Oct rule: only Director-chosen rows are exported.
   - *Nothing to decide unless you want those left out too.*
4. **No backfill.**
   - *Recommend: yes.* The first turn imports structured facts for free (no model runs, (ii) B3). Anything that needs reading is the (ii) B5 Reading turn, quoted as a ceiling.
5. **[money] How a digest is written.** Amendment (iii) E says "digests … run at Low whatever the setting unless the setting is High". The options:
   - **(a) Inside the turn's own call.** No extra call, but it runs at the turn's setting (Medium in a Medium turn), which bends E.
   - **(b) A separate Low call** (High when the setting is High), as E says. This is a second call inside the turn's band, so the band's figures change.
   - Either way, edits with no model in them leave the digest stale, covered by the free "changed since" list.
   - *Recommend: (b).* It keeps E as written, and the band is re-checked in M4's money review.
6. **The person's change wins a race.**
   - Atomik's change is dropped, listed and proposed again, and the step's digest is marked stale.
   - *Recommend: yes.*
7. **House defaults (D8, 21 Oct).**
   - A default needs the three most recent productions the turn's person may reach to agree.
   - Only "said" or "document" answers count; "Decide for me" assumptions do not.
   - The spend limit never becomes a default.
   - An adopted default shows as "I assumed … · Change".
   - *Recommend: as written.*
8. **The switch.**
   - A new `V30_FILM_RECORD`, not `V30_PRODUCTION_MODEL`, so the record rolls back on its own.
   - *Recommend: the new one.*
9. **The spend-limit row.**
   - It holds a reference to the production's existing cap, not a credit figure, so the credit conversion never touches a figure a person set inside a JSON value.
   - *Recommend: a reference.*
10. **`record_lookup` on MCP?**
    - Rule 11 puts features on MCP, but this tool reads said lines, and I says no API lists the record.
    - *Recommend: no.* It stays internal to Atomik's turn.

---

## Appendix: for the M2 implementer

### A.0 Where each fact lives

- **Workspace memory (layer 1)** is read, not copied:
  - Memory entries come through `plannerMemory` (`lib/atomikMemory.ts:600-608`);
  - faces and consents through `identity_consents` (`lib/security/consent.ts:23-43`);
  - looks and Library elements (`lib/db.ts:950-956`).
- **House defaults and Director engine preferences are derived queries**, never stored.
  - Both read only productions the turn's person may reach, so a private board's answers never become another member's default.
  - A default is shown as "I assumed … · Change", with source `default`.
- **Checklist rows** keep one live version per key and scope, enforced by a unique index. That is what makes "never asked twice" structural.
  - Each change adds a version and marks the old one superseded. "Every change (when, why — the chip pressed)" (R7) is that version chain.
- **Where a row sets the production's Setup** (`plays` sets aspect and frame rate), the row and `projects.setup`/`format` (`lib/db.ts:1026`, `:1031`) are written by one writer in one transaction. Renders keep reading the Setup (rule 4).
- **The spend-limit row (`ceiling`) holds a reference to the production's existing cap, never a figure.**
  - The figure stays in `projects.cap_credits`, which the credit conversion already covers (`lib/creditConversionTenant.ts:68-73`).
  - Only a person sets it (rule 11). "Decide for me" leaves it at "No limit". This is question 9.
  - **Other** (owner, 25 Oct 2026): the figure a person types becomes the production's own cap through the money path (`setCapFromBrief` in `lib/caps.ts`). Only once that write has landed does the row record `{"cap":"production"}`. The figure is never in the row.
  - **Who may set it.** Any member sets the spend limit at the Brief where no cap is in force, or lowers the one that is. Raising it above the cap in force (the production's own, or else the workspace's budget per production), or choosing No limit where a cap is set, is an owner's or an admin's. An API or MCP token and Atomik never set it.
- **Take state.**
  - `generations` is the truth for a take's state: picked, and Sent (today's `approved_*`, `lib/db.ts:1062`; `CLAUDE.md:56`).
  - The item holds the reject reason, the quote and the edges, and reads the take's state live in the same query.
  - Keep (`kept_at`/`kept_by`) does not exist yet. When the Keep PR adds it, that column is the truth too.
  - Only kinds whose own table has no state (a treatment page, a cue, for example) keep their state on the item.
- **Engine, prompt as sent and settings for a take** are read from `generations` (`lib/db.ts:111-113`), which is the truth for what ran. In Agent mode the builder's `generations` join selects state columns only, never `model`, `prompt` or `params`.
  - `film_record_private` holds only what `generations` does not: a Director node's settings before a take exists ((iii) B1), a voice id, and who chose the engine (`director` or `agent`).
  - The Agent factor is keyed on who chose (R11, 21 Oct; the owner's answer 1).
- **Approvals.** The money tables (`rig_plan_approvals`, `rig_agent_steps`, the meter) stay the truth.
  - The record's approval row keeps what the person saw: the quote, and the allowance left at that moment.
  - It is written after the money commit and can never fail that commit.
  - Approvals whose approver is not a person (historical Auto rows) are skipped, never mirrored.
- **Costs** are in credits only. There is no `_usd` column anywhere in the record.
- **Errors** never echo a value, a said line or a private field. They read like `steps.ts`'s "That project is not in this workspace."

### A.1 Common rules

- **Columns on every table** except `heads`, `turns` and `digests`:
  - `workspace_id TEXT NOT NULL CHECK(workspace_id <> '')`;
  - `production_id TEXT NOT NULL` (a `projects.id`, as `requireProduction` reads it, `lib/workbench/team-canvas.ts:78-85`);
  - `rev INTEGER NOT NULL`;
  - `turn_id TEXT NOT NULL`.
- **Keys and statements.** Every key and index leads with `workspace_id`. Every statement binds `workspace_id` and `production_id`, ripple CTE and `IN (…)` lists included. This follows `production_steps` (`lib/productionModel/steps.ts:12-20`, `:77-97`) and `lib/pipeline/store.ts:122-129`.
  - The one exception: the credit conversion's generic `UPDATE … WHERE id=?` (`lib/creditConversionTenant.ts:240`). It relies on the database being the workspace's own. M2 either gives the record's specs a `where` on `workspace_id`, or states the exception in code.
- **Factory.** The store is built only by `filmRecord()`, which pairs `db()` with `requireTenant().id` and re-checks the tenant per call (the `productionSteps()` pattern, `steps.ts:183-186`, `:472-480`). A test-only constructor is guarded as `stepStoreForTests` is (`steps.ts:482-488`).
- **Reach.** A production's record is read only by people who may reach the project (`mayReachProject`).
  - Always pass the turn's person: `mayReachProject(null, …)` returns true (`lib/draftProject.ts:144`).
  - House defaults and Director preferences join through the same check.
- **No enum CHECKs.** SQLite cannot change a CHECK in place (`steps.ts:99-110`), so kinds, states and sources are validated in code. The CHECKs that remain are `workspace_id <> ''` and "a person approves" (copied from `lib/workbench/plan-approval.ts:56-59`, `:175-202`, with its guard triggers).
- **Private reads live in their own module**, `lib/filmRecord/private.ts`. An import scan holds its importers to a closed list: the store's writer, the Director views, the export and Atomik's tools. A string scan would prove nothing about callers of a store method.
- **Credit columns:**
  - `film_record_items.quote_credits`, `film_record_items.cost_credits`;
  - `film_record_approvals.quote_credits`, `quote_low_credits`, `allowance_credits`, `settled_credits`.
  - All six join SPECS (`lib/creditConversionTenant.ts:77-91`). Their archived copies need a new SPECS entry over `archived_rows.body` (`where: table_name IN ('film_record_items','film_record_approvals')`), as CAPS does for caps at `:72`; none exists today.
- **Ids** come from `id()` in `lib/db.ts`. Times are epoch ms.

### A.2 Columns

**`film_record_heads`** — `workspace_id`, `production_id`, `rev INTEGER NOT NULL DEFAULT 0`, `created_at`, `updated_at`. PK `(workspace_id, production_id)`.

**`film_record_rows`** (one version per row):

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `frr_` |
| step_id, step_kind | TEXT | no | `production_steps.id` and its kind, which a trigger keeps fixed (`steps.ts:93-96`) |
| row_key | TEXT | no | a floor id from H, or `q:<slug>` above the floor |
| scope | TEXT | no, `''` | `element:<id>`, `scene:<n>`, `shot:<id>` |
| floor | INTEGER | no, 0 | |
| value | TEXT | yes | JSON, ≤ 2,000 chars. NULL = asked, not answered. `ceiling` holds `{"cap":"production"}` or `{"cap":"none"}`, never a figure |
| source | TEXT | yes | `said` · `document` · `earlier_step` · `default` · `assumed`. NULL exactly when value is NULL |
| source_ref | TEXT | yes | `said:<id>`, `upload:<id>`, `row:<id>`, `house`, `genre:<id>`, `platform` |
| asked_at | INTEGER | yes | |
| set_by, set_at | TEXT, INTEGER | no | `set_by` must be a person for `ceiling` |
| change_reason | TEXT | yes | `answer`, `change`, `decide_for_me`, `carry:<row id>` |
| supersedes, superseded_at, superseded_by | TEXT, INTEGER, TEXT | yes | |

Indexes:
- PK `(workspace_id, id)`;
- `frr_live` UNIQUE `(workspace_id, production_id, row_key, scope) WHERE superseded_at IS NULL`;
- `frr_step` `(workspace_id, production_id, step_kind, superseded_at)`;
- `frr_rev` `(workspace_id, production_id, rev)`;
- `frr_house` `(workspace_id, row_key, superseded_at, source)`.

**`film_record_said`:**

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `frs_` |
| step_id, step_kind | TEXT | no | |
| source | TEXT | no | `interview` · `prompt` · `note` · `comment` · `title` · `bar` · `client` |
| mode | TEXT | no | `agent` · `director` (`boardModeOf`, `lib/modelTrace.ts:396-403`) |
| text | TEXT | no | ≤ 8,000 chars; longer text is split into parts |
| part | INTEGER | no, 0 | |
| by | TEXT | no | a person's id, or `client:<share id>` |
| about | TEXT | yes | `item:<id>`, `node:<id>`, `row:<id>`, `upload:<id>` |
| created_at | INTEGER | no | |

Never edited: a correction is a new line. Indexes:
- PK `(workspace_id, id)`;
- `frs_step` `(workspace_id, production_id, step_kind, created_at)`;
- `frs_rev` `(workspace_id, production_id, rev)`;
- `frs_about` `(workspace_id, production_id, about)`.

**`film_record_items`:**

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `fri_` |
| step_id, step_kind | TEXT | no | |
| item_kind | TEXT | no | `element` · `still` · `sheet` · `world` · `look` · `frame` · `take` · `read` · `cue` · `mix` · `cut` · `master` · `page` · `outline` · `script` |
| ref | TEXT | no | `generation:<id>`, `element:<id>`, `attribute_version:<id>`, `upload:<id>`, `treatment_version:<id>`, `edit_version:<id>`, `node:<id>` |
| parent_id, scope, fix_of | TEXT | yes / no `''` / yes | |
| fix_n | INTEGER | yes | counted against `MAX_FIXES_PER_SHOT` (`plan-approval.ts:29`) |
| state, state_at, state_by | TEXT, INTEGER, TEXT | yes | **only for kinds whose own table holds no state.** A take's state is read live from `generations` |
| reject_reason | TEXT | yes | ≤ 500 chars |
| reject_said_id | TEXT | yes | |
| quote_credits, cost_credits | REAL | yes | credit columns |
| cost_state | TEXT | no, `quoted` | `quoted` · `settled` · `nothing_billed` · `unknown` |
| approval_id, consent_ref | TEXT | yes | `consent_ref` = `identity_consents.id`, optional: it cites the consent tick (who ticked, when, a file if any) when one was recorded. Nothing is refused without it (owner, 23 Oct 2026: consent is a tick, never a gate) |
| mode, made_by, made_at, updated_at | | no | |

Indexes:
- PK `(workspace_id, id)`;
- `fri_ref` UNIQUE `(workspace_id, production_id, ref)`;
- `fri_step` `(workspace_id, production_id, step_kind, made_at)`;
- `fri_scope` `(workspace_id, production_id, scope, made_at)`;
- `fri_rev` `(workspace_id, production_id, rev)`.

The builder joins `generations` by the id list in the same query, to read picked and Sent (`approved_*`), and Kept once it exists.

**`film_record_approvals`:**

| Column | Type | Null | Note |
|---|---|---|---|
| id | TEXT | no | `fra_` |
| step_id, step_kind | TEXT | no | |
| approved_by | TEXT | no | person-only CHECK plus triggers |
| approved_at | INTEGER | no | |
| what | TEXT | no | `plan` · `step` · `job` · `band` · `carry` |
| quote_kind | TEXT | no | `exact` · `up_to` · `range` |
| quote_credits, quote_low_credits, allowance_credits, settled_credits | REAL | no / yes / yes / yes | credit columns |
| fixes_left | INTEGER | yes | from `fixRoom` (`plan-approval.ts:165-169`) |
| covers | TEXT | no, `'[]'` | |
| money_ref | TEXT | no | `plan_approval:<id>`, `rig_step:<id>`, `prepared_job:<id>`, `generation:<id>` |
| closed_at, closed_reason, created_at | | | |

Indexes:
- PK `(workspace_id, id)`;
- `fra_money` UNIQUE `(workspace_id, money_ref)`;
- `fra_when` `(workspace_id, production_id, approved_at)`.

**The reconcile at turn start.** It copies money rows that have no mirror yet, keyed by `money_ref`, and skips any whose approver fails `isPersonApprover` (`plan-approval.ts:43-50`). This covers historical Auto rows in `rig_agent_steps`.

**`film_record_private`** — `id` (`frp_`), `step_id`, `step_kind`, `item_id` (nullable), `node_id` (nullable), `engine` (nullable: a node's chosen engine before a take exists), `settings` (JSON, default `'{}'`), `voice_ref` (nullable), `chose` (`director` · `agent`, not null), `created_at`. Indexes:
- PK `(workspace_id, id)`;
- UNIQUE `(workspace_id, item_id) WHERE item_id IS NOT NULL`;
- `(workspace_id, production_id, node_id)`;
- `(workspace_id, production_id, step_kind)`.

It never holds vendor costs, vendor handles, fingerprints, or Atomik's own thinking slot.

**`film_record_edges`** — `from_id`, `to_id`, `via` (the row key read, default `''`), `created_at`. Indexes:
- PK `(workspace_id, production_id, from_id, to_id)`;
- `(workspace_id, production_id, to_id)`.

Edges come from the row keys each registry tool declares it reads, and point at row versions.

The ripple query is one recursive CTE that binds `workspace_id` and `production_id` in both members, with depth ≤ 12, `UNION`, and rejected items left out.

**`film_record_turns`** — `workspace_id`, `production_id`, `id` (`frt_`), `turn_key`, `kind` (`agent` · `director` · `system`), `step_id`, `run_id`, `checkpoint_id`, `base_rev`, `rev`, `state` (`started` · `committed` · `failed`), `failed_code`, `skipped` (`'[]'`), `attempts INTEGER NOT NULL DEFAULT 1`, `started_at`, `committed_at`. Indexes:
- PK `(workspace_id, id)`;
- UNIQUE `(workspace_id, turn_key)`;
- `(workspace_id, production_id, started_at)`.

**`film_record_digests`** — `workspace_id`, `production_id`, `step_id`, `step_kind`, `body`, `based_on_rev`, `version`, `turn_id`, `written_at`. PK `(workspace_id, production_id, step_id)`.
- `body` is JSON `{decided, made, open}`, ≤ 3,000 chars, each entry citing its source ids (`said:<id>`, `row:<id>`).
- It is kept off `production_steps` because the rail reads that table with `SELECT *` (`steps.ts:243-250`).

### A.3 The commit, in statements

1. **Open the turn:** `INSERT INTO film_record_turns … ON CONFLICT(workspace_id, turn_key) DO UPDATE SET state='started', attempts=attempts+1 WHERE state='failed'`.
   - A key that is already `committed` returns its result.
   - A `failed` key is reset, which is the Retry under the same approval.
   - Agent turn key: `<runId>:<node>:<checkpoint id>`.
   - Director turn key: `director:<user>:<request id>`, a per-press id from the client. The pattern is the same idea as `workbench_draft_writes` (`lib/workbench/records.ts:31-35`), not the same table.
2. **Context and model call**, as section 3.
3. **One write transaction**, the `steps.ts:217-230` shape, every statement binding `workspace_id` and `production_id`:
   - `UPDATE film_record_turns SET state='committed' WHERE workspace_id=? AND production_id=? AND turn_key=? AND state='started'`. If 0 rows change, roll back and return the committed result;
   - advance the head;
   - for each checklist row: skip it if its live version was set by a person after `base_rev`, listing it in `skipped`; otherwise supersede the old version and insert the new;
   - insert the said lines, items, mirrors, private rows and edges;
   - write the digest, with `based_on_rev = base_rev` when `skipped` is non-empty, so the person's racing change is in the next turn's "changed since" and the digest reads as stale;
   - commit.

### A.4 Context bounds

| Part | Bound |
|---|---|
| digests | ≤ 3,000 chars each; 48,000 in all. Above that, each cap shrinks evenly |
| changed since | ≤ 30 entries per step, keys and values only |
| live values | ≤ 400 |
| current step's row versions | ≤ 120 |
| current step's said lines | newest 60, or ≤ 24,000 chars. Uncited lines (no row, no digest entry) count inside the cap and are kept first; cited ones drop oldest first |
| current step's items in full | ≤ 60: kept, sent and picked, plus the newest 3 per scope (`ROW_NUMBER() OVER (PARTITION BY scope …)`); the rest as counts by scope and state |
| `record_lookup` | ≤ 50 rows and 12,000 chars per call; ≤ 5 calls per turn; matched by key, by id, or by `instr` within one step's said lines |

### A.5 Test detail

- **1 Completeness.** For each Mirror and Sand Brief said id and row id, assert one of:
  - the id is in the built context; or
  - a fixed lookup sequence finds it: row key first, then the row's `source_ref`, then the digest entry citing it, within 2 calls.
  - The fixture includes a paraphrase ("the sticker on the bottle", asked about as "the label") that a text match misses and the digest citation finds.
  - A spy shows no chat table is read.
- **2 Nothing asked twice.**
  - `frr_live` refuses a second live row.
  - Over the D11 briefs: an answered floor row is never produced as a question, and an unanswered one always is (R2, H).
  - The engine half lands with 3d.
- **3 Ripple.** On Mirror after Shots, change `plays`. The ripple lists the fixture's expected ids. No item or generation changes, and a spy on `lib/generationRequests.ts` sees no call.
- **4 Both modes write.**
  - Director make, Keep, reject with a reason, prompt, note and title each write rows.
  - The first Agent context's first section is a read-back built from those rows.
  - The question engine returns none of the floor keys they answer.
- **5 Mode separation.**
  - An import scan of `lib/filmRecord/private.ts` against the closed list.
  - In Agent mode the context holds no private value.
  - A scripted model that echoes the fixture's engine id, settings, seed and prompt as sent: none of it appears in the Agent-mode reply, History, receipt or error payloads.
  - The no-model-name test lands with the model-policy PR (3b-1, L.3). This test adds the record's values to its probes.
- **6 Never shown.**
  - The routes come from a glob of `app/api/**/route.ts`.
  - Probes: interview sentinel strings that exist only in the record, and record ids.
  - Only the listed views (read-back, "I assumed … · Change", Versions, receipt) may carry them.
  - The export section is grouped by step, without turns or checkpoints.
- **7 Tracing.**
  - Closed span keys: `workspace_id`, `production_id`, `turn_id`, `step`, `rows_read` (ids; above 200, a count and a hash), `lookups`, `read_ms`, `bytes`, `commit_ms`, `rows_written`, as `MODEL_CALL_KEYS` (`lib/modelTrace.ts:91-94`).
  - No attribute holds fixture text.
- **8 Privacy and consent.**
  - Two databases, then one file holding two workspace ids (the `tests/unit/productionSteps.spec.ts:15-23` setup): nothing is read, listed, exported or archived across them.
  - The store throws with no tenant or with another tenant.
  - A house-default or Director-preference query run for member A never counts member B's private board.
  - A real face, voice or lip-sync item without `consent_ref` is written and made, never refused; with a tick on record, `consent_ref` cites it.
  - An `agent:` approver is refused by the CHECK and the triggers.
- **9 Durability.** Inject a failure at open, model, commit, and between commit and checkpoint. Row counts and the head are unchanged; `film_record_turns` is excluded from the count. Then:
  - a retry under the same key after `failed` commits once;
  - a re-run after commit writes nothing and calls no model;
  - in a person-vs-Atomik race, the person's value stands, the key is in `skipped`, the digest is stale, and the skipped key is in the next turn's "changed since";
  - a fresh process builds a context with the same hash.
- **10 Size.**
  - A digest over 3,000 chars is refused.
  - Every bound in A.4 holds.
  - Mirror at 200 and at 10 takes: the same query count (an instrumented client, as in `docs/database-startup.md`), `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX` on every record table, and the median ratio over 20 runs is ≤ 1.5.
- **Schema (M2).**
  - With the switch off, no table is made.
  - On a database with data, `ready()` adds only the new tables, changes no existing row, and is idempotent.
  - `workspace_id` leads every key and index, checked by parsing `sqlite_master`.
- **Delete (M1, M2).** Deleting a project in a database without `production_steps` or the record tables succeeds. With them, their rows are archived.
- **Mirror (M3).** Making the mirror writer throw leaves the approval route's response and the money rows unchanged, and the next turn's reconcile fills the gap. A historical `auto` approver is skipped.
- **Export.** Only `chose = 'director'` private rows appear. There is no `_usd` key, no turns and no checkpoints.
