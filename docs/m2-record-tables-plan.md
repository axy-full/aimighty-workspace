# M2: the film record's tables — implementation plan

Status: **plan, for the owner's yes.** Docs only. No migration, product code or test is written until he says yes to M2 (owner, 23 Oct 2026: "A schema migration waits for my yes: plan and docs only").

- **The design** is PR #885, `docs/film-record-schema.md` (branch `docs/film-record-schema`, head `ed084d15`, not merged). This plan cites it as "#885 §n" and does not repeat it.
- **Code read at** `origin/release/1` `f542e552`. Every `file:line` below is on that commit, except the project-delete route after M1, which is cited from M1's commit `5fa9d78f` (local branch `fix/project-delete-archives-steps`, not merged).
- **M2 starts after M1 merges.** Both change the same delete path.

## In short

1. Nine `film_record_` tables in each workspace's own database, made on first use by one memoised batch of `CREATE … IF NOT EXISTS`, only when `V30_FILM_RECORD` is on. No existing table changes.
2. A store built only by `filmRecord()`, scoped to the workspace in scope, with #885's idempotent turn commit. Nothing in the product calls it yet.
3. Project delete archives the record tables that exist, each checked in `sqlite_master` first, in the same transaction as today.
4. **[money]** The six credit columns, and their archived copies, join the credit-unit conversion. Described here; changed only in the M2 PR, with its own money review.
5. The owner's export gains the record; fixtures and tests are named in §8–9. Rollback: the switch off; nothing is dropped.

---

## 1. How this repo makes tables today

There are no migration files and no migration runner. Each module makes its own tables on first use:

- **One database per workspace.** `db()` hands out the client for the workspace in scope and throws when there is none (`lib/db.ts:9-45`). Local files under `.data/`; one Turso database per workspace in production.
- **Core tables** are made by `ready()` → `bootstrap()`, memoised per client (`lib/db.ts:1263-1273`, `:878`).
- **Feature tables** are made by their own module, memoised per client in a `WeakMap`, and forgotten on failure so the next call retries:
  - one batch of `CREATE … IF NOT EXISTS`: `memoryReady` (`lib/atomikMemory.ts:59-70`);
  - one write transaction behind a switch: the v30 steps store's `ready()` (`lib/productionModel/steps.ts:131`, `:189-215`), reached only through `productionSteps()`, which refuses before touching the database when the switch is off (`:472-479`).
- **Columns added later** go through `columnInstaller` (`lib/schemaInitialization.ts:6-57`): one catalog read, then `ALTER TABLE … ADD COLUMN` only where missing.
- **SQLite cannot change a CHECK in place** (`steps.ts:99-110`), which is why #885 A.1 keeps enum checks in code.

M2 takes two shapes from these:
- **From the steps store:** the factory, the test-only constructor and the switch (`steps.ts:472-488`).
- **From `memoryReady`:** the table-making. M2 adds no column to an existing table and never rebuilds one, so it needs neither the steps store's `columnInstaller` nor its statement-by-statement write transaction (`steps.ts:194-206`). It sends its statements as one write batch, memoised per client (`lib/atomikMemory.ts:59-70`), as #885 §5 says.

---

## 2. Files M2 adds

| File | What it holds |
|---|---|
| `lib/filmRecord/flag.ts` | `FILM_RECORD_FLAG = "V30_FILM_RECORD"`; `filmRecordOn(workspace)`: the env value is exactly `"1"` **and** `productionModelOn(workspace)` is true (`lib/productionModel/flag.ts:15-21`, which already requires the new interface). `FilmRecordOffError` (404, "Not found."), as `ProductionModelOffError` (`flag.ts:23-29`) |
| `lib/filmRecord/schema.ts` | `FILM_RECORD_TABLES` (the nine names, in the order of §3) and `FILM_RECORD_SCHEMA` (the statements of §3). Pure: no client, no import of `db` |
| `lib/filmRecord/store.ts` | `filmRecord()` (the only product constructor) and `filmRecordStoreForTests(client, workspaceId)`, as `productionSteps()` and `stepStoreForTests` (`steps.ts:472-488`). The store: `ready()`, the turn open/commit/fail of #885 A.3, and the reads its tests need |
| `lib/filmRecord/private.ts` | The only reader of `film_record_private` (#885 A.1) |
| `tests/fixtures/film-record/` | The two fixtures (§8) |

Columns, keys and bounds are exactly #885 A.1 and A.2. Ids come from `id()` (`lib/db.ts:1279-1281`) with the prefixes in A.2.

---

## 3. `ready()`: the statements, in order

`filmRecord()` first checks `filmRecordOn`; when it is off it throws `FilmRecordOffError` **before** `db()` is called, so no database gains anything. When on, it calls `ready()` (`lib/db.ts`) and then the store's own `ready()`.

The store's `ready()` sends `FILM_RECORD_SCHEMA` as **one write batch**, memoised per client in a `WeakMap` and forgotten on failure (the `memoryReady` shape, `lib/atomikMemory.ts:59-70`). Every statement is `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS` or `CREATE TRIGGER IF NOT EXISTS`. No foreign keys, so the order is for reading only: each table, then its indexes and triggers.

| # | Statement | Source |
|---|---|---|
| 1 | `film_record_heads` | A.2 |
| 2–4 | `film_record_turns`; UNIQUE `(workspace_id, turn_key)`; `(workspace_id, production_id, started_at)` | A.2 |
| 5–9 | `film_record_rows`; `frr_live` UNIQUE partial (`WHERE superseded_at IS NULL`); `frr_step`; `frr_rev`; `frr_house` | A.2 |
| 10–13 | `film_record_said`; `frs_step`; `frs_rev`; `frs_about` | A.2 |
| 14–18 | `film_record_items`; `fri_ref` UNIQUE; `fri_step`; `fri_scope`; `fri_rev` | A.2 |
| 19–23 | `film_record_approvals` with `CHECK (NOT notAPersonSql('approved_by'))`; `fra_money` UNIQUE; `fra_when`; triggers `film_record_approvals_person_insert` and `_update` | A.2; `lib/workbench/plan-approval.ts:56-59`, `:199-202` |
| 24–27 | `film_record_private`; UNIQUE `(workspace_id, item_id) WHERE item_id IS NOT NULL`; `(workspace_id, production_id, node_id)`; `(workspace_id, production_id, step_kind)` | A.2 |
| 28–29 | `film_record_edges`; `(workspace_id, production_id, to_id)` | A.2 |
| 30 | `film_record_digests` | A.2 |

Every table carries `workspace_id TEXT NOT NULL CHECK(workspace_id <> '')`, and every key and index leads with it (A.1).

**Idempotency and re-runs.**
- A second boot sends the same batch; every statement finds its object and does nothing. One round trip.
- A batch is all or nothing, so a database never holds a partial set from M2 itself.
- A failed boot is forgotten (the `WeakMap` entry is deleted, `lib/atomikMemory.ts:65-68`), so the next call retries.
- A column added after M2 goes through `columnInstaller`, never a rebuild. No CHECK beyond `workspace_id <> ''` and the person check, so no rebuild is ever needed for a new kind or state.
- Nothing in M2 runs `DROP`, `RENAME`, `ALTER` or a rewrite of any existing table.

---

## 4. Project delete

M1 (`5fa9d78f`) adds, in `app/api/projects/[id]/route.ts`, one `sqlite_master` read for `production_steps` to the delete's first batch, and archives that table's rows only when it exists. The archive refuses a table that is not there (`lib/archive.ts:69-70`), which is why every table is checked first.

M2 extends the same two places:

1. **The first batch** gains one statement: `SELECT name FROM sqlite_master WHERE type='table' AND name IN (<the nine names>)`. Each table is then archived only if its name came back. One statement, not nine, so the write lock is held no longer than today.
2. **The archive steps** gain one entry per table that came back, with `where: workspace_id = ? AND production_id = ?` and `args: [requireTenant().id, id]`, placed after M1's `production_steps` entry and before `projects`. Children first: edges, private, approvals, items, said, rows, digests, turns, heads.

Everything stays in the one `archiveTransaction` and the one batch (`archiveDeleteStatements`, `lib/archive.ts:94-104`): every row lands in `archived_rows` before it leaves its table, or nothing changes.

- The archive acts wherever the tables exist, **switch on or off** (as M1 does for `production_steps`). It never creates a table. (Question 4.)
- `heads`, `edges` and `digests` have no `id` column, so their archive copies are keyed by `rowid` (`lib/archive.ts:76`). The body holds every column.
- No raw `DELETE FROM film_record_…` exists anywhere but through `lib/archive.ts` (the store supersedes rows, it never deletes them; #885 A.2).
- Workspace purge already removes the whole database (`lib/purge.ts:207-212`), so purge does not change.

---

## 5. [money] The credit-unit conversion

**Described only. Nothing here is changed by this plan, and this part needs its own money review in the M2 PR.**

### What it is today
`lib/creditConversionTenant.ts` restates the credit figures a workspace keeps in its own database when the price of a credit changes:
- `CAPS` (`:68-73`): caps a person set, including their archived copies (`:72`);
- `SPECS` (`:75-91`): every other credit column, by table, multiplied by the factor for the row's own time (`ts`, `:212`, `:217`);
- each table is skipped when it does not exist (`tableExists`, `:124-127`, used at `:207`), so it never creates one;
- each changed row is listed in `credit_unit_rows` so a reversal divides exactly what was multiplied (`:175-189`);
- the whole half runs in one write, once per conversion id (`convertTenantFigures`, `:330-352`).

### What M2 adds
1. **Two `SPECS` entries for the live tables:**
   - `film_record_items`, key `id`, `ts: ["made_at"]`, cols `quote_credits`, `cost_credits`;
   - `film_record_approvals`, key `id`, `ts: ["approved_at", "created_at"]`, cols `quote_credits`, `quote_low_credits`, `allowance_credits`, `settled_credits`.
2. **Two `SPECS` entries for their archived copies,** over `archived_rows`, key `id`, `json: [{ col: "body", paths: [...] }]`:
   - `where: table_name='film_record_items'`, paths the two item columns;
   - `where: table_name='film_record_approvals'`, paths the four approval columns.
3. **A small extension to the `Spec` shape for those two:** the factor must come from the row's own time, which for an archived copy is inside `body` (`made_at`, `approved_at`), not `archived_at`. Today `ts` names columns only (`:212`); a row with no time gets factor 1 (`lib/creditConversion.ts:389-391`) and would never be restated. The extension reads `json_extract(body,'$.<field>')` when an entry names body fields for its time. (Question 3.)
4. **The `WHERE id=?` exception** (#885 A.1): the generic update (`:240`) does not bind `workspace_id`. Every table in `SPECS` today relies on the database being the workspace's own. M2 either states that in a comment beside the new entries, or adds a bound `workspace_id` filter to the loop. (Question 2.)

What does not change:
- `CAPS`. The spend-limit row holds a reference, never a figure (#885 A.0, question 9 there); the figure stays in `projects.cap_credits`, already in `CAPS` (`:69`).
- `tenantChangesSince` (`:292-324`), the reversal's "saved since" check. The record mirrors money rows that check already reads (`rig_agent_steps`, `:316`); its `found` helper needs a `state` column the mirrors do not have (`:310`).
- Prices, quotes, approvals, settlement, the meter. No gate reads the record (#885 §0).

### Every reader of `lib/creditConversionTenant.ts`
| Reader | Use |
|---|---|
| `lib/creditConversion.ts:9` | imports `convertTenantFigures`, `tenantChangesSince`, `CapChoice`, `TenantFigure` |
| `lib/creditConversion.ts:402-425` (`finishTenant`, call at `:413`) | a real run or a reversal of one workspace's half |
| `lib/creditConversion.ts:534-537` (in `convertWorkspaceCredits`, `:427`) | the dry-run preview's workspace figures |
| `lib/creditConversion.ts:557-565` (`tenantChangesOf`, call at `:564`) | a reversal's refusal when figures were saved since |
| `app/api/admin/credit-unit/route.ts:8` | the `CapChoice` type; its `GET` (`:57`) and `POST` (`:66`) reach the module through `lib/creditConversion.ts` (`:9-11`) |
| `tests/unit/creditConversion.spec.ts:266-317`, `:434-452` | the existing tests of this half |
| `tests/unit/noAdminApprovalRule.spec.ts:36-54` | a guard that names the file; M2 adds none of its banned words |

---

## 6. The export

`app/api/export/route.ts:51-54` is owner-only and calls `workspaceExport` (`lib/workspaceExport.ts:114`). M2 adds a `film_record` key there, as #885 §6 describes:

**The shape problem.** `contents` is `Record<string, Row[]>`: the dollar strip walks every value as a list of rows (`:153-160`), and `counts` reads each value's `.length` (`:269-271`). A grouped object put into `contents` would throw in the strip for every credit workspace that has the tables. So M2 does it in three steps (flat rows in `contents`, grouped after the strip):

1. **Read, flat.** Inside the export's read transaction (`:120-227`), before the strip, each exported table's rows go into `contents` under its own key (`film_record_rows`, `film_record_said`, `film_record_items`, `film_record_approvals`, `film_record_private`, `film_record_edges`, `film_record_digests`), each a plain `Row[]`. The strip and `counts` then treat them like every other table. The record has no `_usd` column, but it is covered all the same.
2. **Group, after the strip.** The seven keys are folded into one `film_record` object, grouped by production, then step, and removed from `contents`. Their row counts are taken first.
3. **Return.** `counts` keeps one entry per record table (row counts). `film_record` sits beside `...contents` in the returned object (`:263-275`), not inside it.

The rest:
- **When:** only for tables in the catalog read the export already makes (`:122-126`), switch on or off. A workspace without them gets an empty `film_record`. It never creates a table.
- **Left out:** `film_record_turns`, `film_record_heads`, and any checkpoint.
- **Private rows:** only `chose = 'director'` (#885 §6).
- **Private boards, the rule itself:** a production's record is exported when either
  - its project id is not a private board (`isDraftProject` is false: the id does not start with `prj_wb_`, `lib/draftProject.ts:19-20`); or
  - it is one of the exporting owner's own boards: `mappedId(DRAFT_PROJECT_PREFIX, workspace id, owner id, project_id)` for each `workbench_projects` row whose `owner` is the exporting owner (as `lib/draftProject.ts:191-192` builds them), plus the owner's held-boards project, `heldBoardsProjectId(workspace id, owner id)` (`:27`).

  Nothing else: not a teammate's board even when shared (`projectLister` also admits shared boards and the marked sample, `:183-185`, `:193-195`, so it is not the definition here), as the export's note promises (`lib/workspaceExport.ts:268`).
- Every statement binds `workspace_id`.

---

## 7. The switch: what is reachable with it off

| Path | Switch off |
|---|---|
| `filmRecord()` | throws `FilmRecordOffError` before any database call; no table is made |
| `ready()` of the store | unreachable from product code |
| Project delete | one extra catalog read; archives only tables that exist |
| Credit conversion | one `tableExists` per entry; converts only tables that exist |
| Export | uses its existing catalog read; empty section where the tables do not exist |
| Any route, screen, tool, MCP or charge | unchanged: nothing in M2 reads or writes the record |

For every customer workspace the switch is off and the tables never exist, so the last four rows are each one catalog read and nothing else.

---

## 8. Fixtures

`tests/fixtures/film-record/mirror.ts` and `sand.ts`: the D10 golden productions (Amendment (iii), `docs/Particl-SOW-amendment-iii-22Oct2026.md:384`) as rows for the nine tables, with no client, product or person names (rule 3).

- **M2 needs** their shape and volume: every table populated, Mirror at 10 and at 200 takes for the size test.
- **M2 does not need** the owner's right answers (expected ripple ids, floor answers). Those are read by M5 and 3d. (Question 5.)
- No fixture holds a vendor rate, a model id or an engine mapping. Private rows use a placeholder engine string.

---

## 9. Tests

All unit specs, file databases, `ENGINE_MOCK=1`, no network. Setup as `tests/unit/productionSteps.spec.ts:14-24` (one file per workspace, and one file holding two workspace ids). The A.5 numbering is #885's.

| Spec | Test | Proves |
|---|---|---|
| `filmRecordSchema.spec.ts` | the switch off makes nothing | with `V30_FILM_RECORD` unset, `"0"`, `"true"`, or set without `V30_PRODUCTION_MODEL` or the new interface, `filmRecord()` refuses and `sqlite_master` gains no `film_record_` object |
| | ready adds only the new tables | on a database with data, `ready()` adds the nine tables, their indexes and two triggers, changes no existing row or table, and a second and third call change nothing |
| | every key leads with the workspace | parsing `sqlite_master`: every table has `workspace_id` with its CHECK, and every primary key and index starts with it |
| | one live version per key | `frr_live` refuses a second live row for the same key and scope (#885 test 2, its structural half) |
| | only listed modules | no file outside `lib/filmRecord/` and `tests/` calls the store's writers (no product writer in M2), and only the listed modules import `lib/filmRecord/private.ts` (#885 test 5, its import-scan half) |
| | no erase | no source file runs `DELETE FROM film_record_` outside `lib/archive.ts` |
| `filmRecordPrivacy.spec.ts` (#885 test 8, M2 half) | tenant isolation | two databases, then one file with two workspace ids: nothing is read, listed, committed, exported or archived across them; the store throws with no tenant and with another tenant in scope |
| | people approve | an `agent:`, MCP, token, `auto` or blank approver is refused by the CHECK and by both triggers |
| | consent is cited, never required | a real face or voice item without `consent_ref` is written; with one, it is kept |
| `filmRecordDurability.spec.ts` (#885 test 9, store half) | a failure changes nothing | a failure injected at open, in a scripted think step, and at commit leaves every record table (turns aside) and the head unchanged |
| | retry and re-run | a `failed` key retried commits once; a re-run after commit writes nothing and never calls the think step |
| | the person wins | a person's change after `base_rev` stands; Atomik's is listed in `skipped`; the digest is written stale |
| `filmRecordSize.spec.ts` (#885 test 10, store half) | bounds on write | value > 2,000 chars, digest > 3,000, reject reason > 500 are refused; said text > 8,000 is split into parts |
| | indexed reads | `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX` for each of the store's reads on every record table |
| `projectDeleteFilmRecord.spec.ts` | delete with no record tables | a project deletes in a database with none of the nine (and none of `production_steps`), and no table is made |
| | delete with some of them | only the tables present are archived; the delete succeeds |
| | delete with all of them | the project's rows in every table are in `archived_rows` and gone from their tables; another project's and another workspace's rows stay |
| `filmRecordCreditUnit.spec.ts` **[money]** | the six columns follow | a real run restates the six live columns by their row's own time, and their archived copies by the time inside the copy |
| | a reversal is exact | a reversal divides exactly what was multiplied, by `credit_unit_rows` |
| | nothing else moves | a workspace without the record tables converts to the same figures as before M2; a dry run lists the record's figures and writes nothing |
| `filmRecordExport.spec.ts` | the section | flat rows pass the strip and `counts` in a credit workspace without throwing; `film_record` is grouped by production and step, outside `contents`; no turns or heads; only `chose = 'director'` private rows; no `_usd` key; a teammate's private board is left out, shared or not; an empty `film_record` without the tables, and no table made |

Two halves wait for later steps, because the code they test does not exist in M2: the 200-vs-10 query-count and time-ratio half of test 10, and the context-hash half of test 9, land with the context builder (M4). Tests 1, 3, 4, 6 and 7 land with M3–M5 as #885 §5 assigns them.

Existing specs M2 must keep green without edits: `tests/unit/projectDeleteSteps.spec.ts` (M1), `tests/unit/neverDelete.spec.ts:117` (the production delete), `tests/unit/creditConversion.spec.ts`, `tests/unit/productionSteps.spec.ts`. M2 touches `lib/`, so CI runs the full plan (`scripts/ci-select.mjs`, `NEVER` list).

---

## 10. Rollback

- **Switch off** (the owner unsets `V30_FILM_RECORD`): nothing reads or writes the record. Existing tables stay, unread. Delete, conversion and export keep handling them where they exist.
- **Revert of the M2 PR:** the code is gone; any tables already made stay, unread. Nothing is dropped. Archived copies stay in `archived_rows`. One care: a credit conversion run while M2 was in multiplied the record's figures; reversing that conversion after a revert would leave them multiplied, because the reversal walks the `SPECS` entries the revert removed. So M2 is reverted only when no conversion has run since it merged, or its `SPECS` entries are kept.
- No step in M2 is destructive or irreversible (#885 §5, "Destructive or irreversible steps: none").

---

## 11. What M2 does not do

- **No product writer** (M3): no Director action, said line, item or approval mirror is written by product code; no reconcile.
- No digest writer, context builder, `record_lookup` or record span (M4); no ripple or "Carry the change" (M5); no LangGraph read (M6); no question engine (M7).
- No change to any existing table, column, price, quote, approval, cap or charge.
- No route, screen, tool or MCP reads the record, except the owner's export.
- No backfill.
- Does not set the switch anywhere (M8 is the owner's).

---

## What the owner is asked

1. **Yes to M2 as planned.** M1 merged on 24 Oct 2026 as `aad15b26` (#907).
2. **[money] When the conversion restates a record row, does it find the row by its id alone, or also check the workspace?** By id alone is what it does for every other table today, safe because each workspace has its own database; M2 would say so in a comment (recommended). Also checking the workspace means changing the loop every table shares.
3. **[money] Archived copies by their own time:** yes to the small `Spec` extension that reads the row's time from the archived body?
4. **Delete and export act on the record tables wherever they exist,** switch on or off, since they are the workspace's own data. Yes?
5. **Fixtures:** M2 ships Mirror and Sand as shapes and volumes; your right answers are needed before M5 and 3d. How will you give them (a document, or a session)?
6. **The test split:** store-level halves of the size and durability tests in M2, builder halves in M4. Yes?
7. **Answered 24 Oct 2026, 15:30 IST (owner, item 4): no PR of its own.** The conversion's header (`lib/creditConversionTenant.ts:39-40`) will say "archived caps", a one-line comment fix made whenever a PR already touches that file. The lead's check found the gap changes nothing for a real workspace today: no `SPECS` table is ever archived or deleted, and nothing reads `archived_rows`.
