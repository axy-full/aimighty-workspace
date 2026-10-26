# The reading lane's tables: schema and migration plan

Status: **design, for the owner's yes.** Docs only: nothing is migrated, and no code or SQL changes. No migration PR exists until the owner says yes to section 4 and has taken his backup.

- **Read from:** code at `origin/release/1` `376f582a` (every `file:line` is on that commit), and the step plan `docs/reading-lane-plan.md` (`origin/docs/reading-lane-plan-v2-20261025`), Step 2's tables row.
- **Scope:** the behaviour is specified privately in SOW v2 §9, §10 and Part II.1, cited by number only.
- **Owner, 25 Oct:** yes to both tables; this plan first, as its own docs PR; every block stored with its page and box now; search over blocks later, with the record's search work; the quote-by-page before audio and video; uploads are free and outside a reading's price.

---

## 0. In short

- **Two new tables**, `document_readings` and `document_blocks`, in each workspace's own database (`db()`, `lib/db.ts:41-45`). `workspace_id` is on every row and leads every key and index.
- **No existing table is changed.** `uploads` (`lib/db.ts:157-169`) is read, never altered: a reading points at an upload by `upload_id` and copies its `sha256`.
- **No money in either table.** No credit column, no dollar column. The price of a reading is the step plan's Step 3, a separate money PR.
- **The switch is `DOCLING_ENABLED`**, through `engineEnabled` (`lib/engineGate.ts:19,36-40`): on only for exactly `"1"`, and then only for the house workspace and those the platform owner lists. Off for every customer workspace.
- **Migration:** created on first use, memoised. No script, no backfill, nothing destructive.

---

## 1. The tables

| Table | One row per | Holds |
|---|---|---|
| `document_readings` | reading of one upload | upload id and its `sha256`, state, reader version, page count, timings, the stored result's path, who asked, an error code |
| `document_blocks` | block of one reading | page, box, kind, reading order, text, OCR confidence |

**Rules that hold for both** (columns in the appendix):

- **Tenant.** `workspace_id TEXT NOT NULL CHECK(workspace_id <> '')`. Every key and index leads with it. Every statement binds it, `IN (…)` lists and sub-selects included, as `production_steps` does (`lib/productionModel/steps.ts:13-14`, `:245`).
- **Lookup by `sha256` is never across workspaces.** The index leads with `workspace_id`, and each workspace has its own database besides.
- **Factory.** The store is built only by `documentReadings()`, which pairs `db()` with `requireTenant().id` (`lib/tenant.ts:104-108`) and re-checks the tenant on every call, as `productionSteps()` does (`steps.ts:183-186`, `:472`). A test-only constructor is guarded as `stepStoreForTests` is (`steps.ts:486`).
- **No enum CHECKs.** SQLite cannot change a CHECK in place (`steps.ts:99-110`; `docs/film-record-schema.md` §A.1). State, kind and error code are validated in code. The one CHECK is `workspace_id <> ''`.
- **Ids.** A reading's id comes from `id()` (`lib/db.ts:1279-1281`) with the prefix `drd_`. A block's id is derived from its reading, `dbk_<reading id>_<seq>`, never from `id()`: a reading writes thousands of blocks within a few milliseconds, where `id()`'s time-plus-short-suffix ids could collide, and a derived id lets question 5's copy be a single `INSERT … SELECT`. Times are epoch ms.
- **Stored result** (the worker's full output, kept for a re-index) under the workspace's own storage prefix (`lib/storage.ts:33`), beside its uploads (`:45`): `readings/<reading id>.json`. The original workspace keeps bare paths, as its uploads do (`storage.ts:29-33`).

**Not in these tables, on purpose:**

- **No full-text index.** Search over blocks comes later with the record's search work, as its own schema PR. It can add an index over `document_blocks` without changing it.
- **No time columns.** Audio and video come after the quote-by-page and get their own plan.
- **No upload cost.** An upload is free and outside a reading's price; nothing here counts bytes for money.

---

## 2. Guarantees

**The text is the customer's document.**

- Never logged, never in an error, never in a trace. Logs and spans carry ids, counts, codes and timings only, as the upload finish does (`app/api/uploads/finish/route.ts:37-46`).
- `error_code` is a code from a closed list, never a message from the worker.
- It comes only from the worker that read it. These tables send it nowhere.
- Served only to a person who may open the upload (`uploadOpenableBy`, `lib/uploadAccess.ts:194`). A reading follows its upload: whoever may open the upload may read its reading, and nobody else (question 7). `project_id` records where it was asked, and gates nothing.
- The person is always named. A run started by an agent (`agent:*`) or a token reads as the run's owner or the token's person; `currentPerson()` returns null for an agent (`lib/draftProject.ts:134-137`), and the path that serves text refuses a null person rather than passing it on: elsewhere a null is let through (`mayReachProject`, `:144`; `assertUploadsOpenable`, `lib/uploadAccess.ts:216-220`, where background work is not asked). The worker's job writing results is background work and is not refused. A refusal is a 404, as uploads answer.

**Money stays in the money tables.**

- Neither table has a credit or dollar column, so the credit conversion (`lib/creditConversionTenant.ts:68-91`, `CAPS` and `SPECS`) needs no entry, and nothing it rewrites touches them.
- Step 3 decides how its money row names the reading. The reading names no money row.

**Nothing is erased.**

- A deleted upload takes its readings and their blocks out through `lib/archive.ts`: each row is copied to `archived_rows` in the same write (`lib/archive.ts:4-11`, `:94-104`). Blocks go first, then readings.
- Each table is checked in `sqlite_master` first, as the project delete does for `production_steps` (`app/api/projects/[id]/route.ts:134`, `:169`). The archive refuses a table that is not there (`lib/archive.ts:69-70`), and a customer workspace has never made these.
- Upload delete: inside `queueUploadDeletion`'s transaction (`lib/uploadReservations.ts:639-646`, called at `app/api/uploads/[id]/route.ts:139`), readings `WHERE workspace_id=? AND upload_id=?` (index `drd_upload`) and their blocks.
- Project delete archives no reading. Its library's originals go back to the workspace's uploads (`route.ts:164-167`), so their readings stay with them, and a quote citing those blocks from another project still opens (question 7).
- Workspace purge: in blob mode the `ws/<id>/` prefix goes, stored results included. The local-disk branch deletes files table by table (`lib/purge.ts:172-204`) and today knows nothing of `readings/*.json`; R1 adds them.

**Every block has a page and a box.** Both are `NOT NULL`. A block the worker returns without them is refused in code, and the reading fails with a code (question 3 covers plain-text files).

---

## 3. Tests

All under `ENGINE_MOCK=1`, on file databases, with the worker mocked and synthetic fixtures in `tests/fixtures/reading/`. No vendor call (rule 1).

| Spec | Proves |
|---|---|
| `tests/unit/documentReadingsSchema.spec.ts` | With the switch off, no table is made. On a database with data, first use adds only the two tables, changes no existing row and is idempotent. `workspace_id` leads every key and index (parsed from `sqlite_master`). No column ends in `_credits` or names a dollar figure |
| `tests/unit/documentReadingsTenant.spec.ts` | Two databases, then one file holding two workspace ids (the `tests/unit/productionSteps.spec.ts:21-24` setup): a second workspace sees nothing of the first, by id, by upload or by `sha256` of identical bytes (a by-project read is a record query with no index of its own, and is scoped the same). The store throws with no tenant or another tenant. A member who may not open the upload reads nothing. A null person (an agent with no owner) is refused. A re-read that fails leaves the earlier reading current, its blocks unchanged. A re-read that succeeds leaves exactly one current reading, and the older one's `superseded_by` names it |
| `tests/unit/documentBlocksGeometry.spec.ts` | Every stored block has `page` from 1 to the reading's page count and a box inside the page (`0 ≤ x0 ≤ x1 ≤ 1`, the same for y). A block without either is refused. Text over the cap is split as question 2 says, each part with its own `seq`, and joins back exactly |
| `tests/unit/documentReadingsNoText.spec.ts` | A sentinel string in a fixture never appears in console output, error bodies, `error_code` or trace attributes, on success and on each failure path (worker down, timeout, bad block) |
| `tests/unit/documentReadingsArchive.spec.ts` | Upload delete archives the readings and their blocks, copy first. Project delete archives none, and the readings of its library's originals still open. Both deletes succeed in a database without the tables. The local-disk purge removes `readings/*.json` |
| `tests/unit/documentReadingsPlans.spec.ts` | `EXPLAIN QUERY PLAN` names the expected index and its second key column for each query: `dbk_order` for blocks of a reading by page and order; `drd_sha` for the `sha256` lookup; `drd_current` and `drd_inflight` for an upload's current and in-flight reading, with each query repeating its index's `WHERE` exactly; `drd_upload` for the upload-delete archive. A bare `SEARCH … USING INDEX` does not pass, since every key leads with `workspace_id` |

---

## 4. The migration plan, for the owner's yes

**Nothing below runs until the owner says yes, after his backup.** One small PR per step (rule 8). Approving this plan approves no step.

**The switch.** `DOCLING_ENABLED` through `engineEnabled`. When it is off, nothing is made, read or written. The upload delete's archive step and the purge's file step run only where `sqlite_master` shows the table, switch or not, so rows made while it was on are still archived after it goes off.

**First use.** `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, memoised per database client as `memoryReady` is (`lib/atomikMemory.ts:59-70`), dropping the memo on failure so the next call retries.

| Step | What changes | Switch | Rollback |
|---|---|---|---|
| **R0** | This doc | — | revert |
| **R1** [schema] | The two tables, the store (`lib/reading/store.ts`, new), the upload delete's archive step, the purge's file step, the six specs above. **No product code writes yet.** Owner's yes after his backup | `DOCLING_ENABLED` | switch off: nothing reads them, nothing is dropped. Revert: the tables stay, unread |
| **R2** | Step 2's tool, job and routes write and read through the store (the step plan's own PR) | `DOCLING_ENABLED` | switch off |
| **R3** [money] | Step 3 prices a reading; its money row names the reading. No column here | as Step 3 | as Step 3 |

**Backfill: none.** No document has been read; an older upload is read when someone asks.

**Destructive or irreversible steps: none.**

- No `DROP`, `RENAME`, rebuild, column change or rewrite of an existing row.
- A row leaves its table only by archiving, copied first in the same write.
- A revert leaves the new tables in place, unread.

---

## 5. Open questions for the owner

1. **Box unit.** Fractions of the page, 0 to 1, origin top-left; or the file's own points.
   - *Recommend: fractions.* A highlight is drawn without knowing the page size, and scans and PDFs read alike. The page sizes stay in the stored result.
2. **Text cap per block.** 4,000 characters. A longer block (a long table, say) is split into consecutive blocks with the same page, box and kind, each with its own `seq`, and `part` counting up from 0.
   - *Recommend: 4,000, split, never cut.*
3. **Files with no pages** (.txt, .md, .fountain). Each block gets page 1 and the whole page as its box, and the reading's `geometry` says `none`.
   - *Recommend: yes,* so "every block has a page and a box" holds with no NULLs.
4. **A re-read of the same upload: replace or version?**
   - *Recommend: version.* A newer reader adds a reading, and the older one keeps its blocks, so a quote that cites them still opens. Two partial unique indexes hold it: at most one **current** reading per upload (`done`, not superseded) and at most one **in flight** (`queued` or `reading`). In one transaction, the older reading is marked superseded first and the newer one `done` second: SQLite checks a unique index row by row, so the other order fails on `drd_current`. A re-read that fails changes nothing: the older reading stays current.
5. **The same bytes uploaded twice in one workspace.** The second upload gets its own reading, with `reused_from` naming the first, and the blocks copied in one `INSERT … SELECT`. Its stored result is a copy under its own `readings/<id>.json`, never a pointer to the first reading's file, so deleting the first upload leaves it whole. No worker call. Never across workspaces, and never from a superseded reading.
   - An instant answer would tell the person someone here already uploaded those bytes. So a reading is reused only from an upload the asking person may open themselves; otherwise the file is read afresh.
   - *Recommend: yes, on those terms.* Whether a reuse is priced is Step 3's question; `reused_from` lets it tell.
6. **Export.** The workspace export keeps an allowlist (`lib/workspaceExport.ts:12`); R1 leaves these tables out of it.
   - *Recommend: out for R1;* added with the record's search work, grouped by upload.
7. **What gates a reading's text: the upload, or the project it was asked from?** Gating by project fits neither one reading per upload nor project delete. A teammate who may open a shared upload would be refused a reading asked from someone's private board and could not start their own. And deleting a project would archive readings of uploads that outlive it.
   - *Recommend: the upload.* The text is the upload's own words, so whoever may open the upload may read its reading. `project_id` only records where it was asked. Readings go when their upload goes, never with a project.

---

## Appendix: columns

**`document_readings`**

| Column | Type | Null | Note |
|---|---|---|---|
| workspace_id | TEXT | no | CHECK `<> ''` |
| id | TEXT | no | `drd_` |
| upload_id | TEXT | no | `uploads.id` |
| sha256 | TEXT | no | the upload's, copied when asked; 64 hex, checked in code |
| project_id | TEXT | yes | the project it was asked from; NULL for a workspace upload. A record only; it gates nothing (question 7) |
| state | TEXT | no, `queued` | `queued` · `reading` · `done` · `failed` |
| reader_version | TEXT | yes | the worker's reported version; NULL until the worker answers, set when `done` |
| geometry | TEXT | no, `page` | `page` · `none` (question 3) |
| pages, blocks | INTEGER | yes | set when done |
| result_path | TEXT | yes | `readings/<id>.json` under the workspace prefix |
| asked_by | TEXT | no | the caller, a person or an agent id (rule 11: every caller runs the same tool) |
| reused_from | TEXT | yes | a reading id in this workspace (question 5) |
| error_code | TEXT | yes | `worker_unavailable` · `timeout` · `too_large` · `encrypted` · `unreadable` · `bad_block`; a code only |
| created_at, started_at, finished_at | INTEGER | no / yes / yes | |
| superseded_at, superseded_by | INTEGER, TEXT | yes | question 4 |

Indexes:
- PK `(workspace_id, id)`;
- `drd_current` UNIQUE `(workspace_id, upload_id) WHERE state = 'done' AND superseded_at IS NULL`: at most one current reading per upload;
- `drd_inflight` UNIQUE `(workspace_id, upload_id) WHERE state IN ('queued','reading')`: at most one reading under way per upload;
- `drd_upload` `(workspace_id, upload_id)`: every reading of an upload, whatever its state, for the upload delete (a partial index cannot serve it);
- `drd_sha` `(workspace_id, sha256, state, finished_at)`: "is there already a reading of these bytes here".

**`document_blocks`**

| Column | Type | Null | Note |
|---|---|---|---|
| workspace_id | TEXT | no | CHECK `<> ''` |
| id | TEXT | no | `dbk_<reading id>_<seq>`; what a quote cites |
| reading_id | TEXT | no | `document_readings.id` |
| page | INTEGER | no | 1-based |
| seq | INTEGER | no | reading order within the reading, from 0; each part of a split block has its own |
| part | INTEGER | no, 0 | for a split block (question 2) |
| x0, y0, x1, y1 | REAL | no | fractions of the page, origin top-left (question 1) |
| kind | TEXT | no | `title` · `heading` · `paragraph` · `list_item` · `table` · `caption` · `footnote` · `page_header` · `page_footer` · `picture` · `formula` · `code` · `other`; checked in code |
| text | TEXT | no, `''` | ≤ 4,000 characters (question 2) |
| confidence | REAL | yes | OCR confidence, 0 to 1; NULL where the text came from the file's own text |

Indexes:
- PK `(workspace_id, id)`;
- `dbk_order` UNIQUE `(workspace_id, reading_id, page, seq)`: blocks of a reading by page and order, and the quote-by-page; it also serves the archive's `reading_id IN (…)`.
