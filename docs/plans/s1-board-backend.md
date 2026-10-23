# Plan: S1, the board backend (Phase 2)

Status: plan only, 6 October 2026. Build starts Fri 9 Oct. Nothing merges before the demo.
Scope source: `docs/particl-sow.md` (v2, 6 Oct) § 3.3; handover `docs/handover-2026-10-05.md` § B4.1 and Part D "S1"; `CLAUDE.md` rules 2, 4, 11, 12, 14. This plan folds in the working S1 plan of 5 October and the lead's answers to it.

S1 adds no price, hold or charge. It reads credits that were already settled. No vendor figure appears in anything it returns.

---

## 1. Goal and done-when

**Scope (SOW § 3.3):** card kinds doc, questions, plan, group, take, deliver; groups as real containers; versions with approve/reject (with reason) on every frame and take; the project record (brief version, every approval with quote and settled cost, open decisions, spend vs ceiling); regions; a board for every existing production; API with person-only approval. The Release 1 screens stay; S1 lands underneath.

**Done when**
1. The six card kinds exist with bounded schemas. Today's canvases and drafts parse, merge and tidy exactly as before (golden tests).
2. Groups hold cards in order; group status and cost so far are computed; Tidy lays groups out in production order.
3. Every frame and take has versions v1…vn. One version per card is approved. Rejections carry a reason. Every verdict is kept, with who and when.
4. `GET /api/board/record` answers the brief version, every approval with its quote and settled cost, open decisions, and spend against the ceiling.
5. Named regions can be saved and hidden.
6. Every existing production can get a board built from its stored data, by a dry run first and then a resumable backfill that never changes old data.
7. The API reads the board, applies ops, sets verdicts (people only; a test proves Atomik, MCP and tokens are refused) and reads the record. Every query is scoped to the workspace.
8. The Release 1 screens look and behave the same (their browser specs pass at the five sizes).

---

## 2. What exists today (extended, never a second store)

### The canvas is already the board
- `lib/workbench/team-canvas.ts`, `team-canvas-model.ts`: one row per production in `workbench_team_canvas` (workspace database). The body holds nodes, assets, order, removed and retired cards, stamps and writers. Edits are last-write-wins per field on the server's clock. Removal is soft. Limits: 4,000 cards and 24 MB.
- `lib/workbench/canvas-ops.ts`, `canvas-ops-model.ts`, `canvas-ops-log.ts`, `canvas-push.ts`: server ops (create, move, wire, unwire, set, tidy, remove), idempotent by op id (`rig_canvas_ops UNIQUE(production_id, op_id)`), pushed live through Liveblocks with a 5-second fallback check. "A person always wins": an `agent:` writer changes only cards it made and nobody has changed since.
- `lib/workbench/node-graph.ts` (`NODE_DEFS`, 15 node types, `NodeVersion` capped at 30), `studio.ts`, `studio-schema.ts` (undeclared fields are dropped), `draft-merge.ts`.
- `lib/workspace/rig-board.ts`, `rig-graph.ts` (sections, snap, Tidy); `lib/production/rig-build.ts` (cards from boards); `lib/workbench/board-import.ts` (stable ids, bounded deterministic batches: the backfill's precedent).
- `lib/workbench/master-lock.ts`, `lib/masters.ts` (locked masters), `lib/workbench/edit-versions.ts`.

### Takes, approvals and spend
- A take is a `generations` row. Review marks (`review_state` '', picked, approved, changes; `review_by`, `approved_by`, times) are written by `PATCH /api/jobs/[id]`. There is no rejected state, no reason, no history, and nothing enforces one approval per shot.
- Paid approvals on the board today: `rig_agent_runs` (limits approved, by whom) and `rig_agent_steps` (quote, approved by, settled, outcome, job, node) in `lib/workbench/rig-agent-store.ts`.
- Spend against the ceiling: `projectCapSpent` in `lib/caps.ts`. Credits per take: `credit_receipts`.

### Release 1 (merging Thu 8 Oct, from `demo/board-everyone`)
- The board screens on React Flow (`components/graphite/board/**`), derived cards and layout (`lib/board/types.ts`, `layout.ts`, `regions.ts`, `tidy.ts`, `list.ts`): opening a board writes nothing, and today's shot cards are drawn as take cards.
- The control room's activity and approvals (`lib/control-room/activity.server.ts`, `approvals.server.ts`, `queue.ts`): the one model of priced → settled.
- The ten stage pages are deleted and redirect to board regions. There is no new-interface switch after Release 1.

### Who can call what
- `requireSession` refuses every token. MCP tools call the app's HTTP API with the caller's token, so a session-only route refuses them. `agent:<runId>` writers exist only inside the server.

---

## 3. Design

### 3.1 Where each piece lives
| Piece | Where | Why |
|---|---|---|
| Small card data (questions, plan, group, take note, deliver spec, group membership and order, doc summary) | Card fields on the canvas row | One store; last write wins per field; pushed live; undo and soft removal already work |
| Doc bodies (brief, shot list) | `board_docs` | Up to 200 KB. As a card field every edit would copy the body into the op log and every live push |
| Versions v1…vn of any card | `board_versions` | Never capped, never dropped (`NodeVersion` keeps only 30) |
| Approve, reject, clear, undo | `board_verdicts` (append-only), mirrored into the take's existing marks | History and reasons; "approved" stays one truth with today's screens |
| Regions | `board_regions` | Small rows; hidden, never deleted |
| Backfill progress | `board_backfills` | Says which productions have a board, from what, without writing old rows |
| The project record | A read model, no table | Computed from the above and from existing tables |

### 3.2 The six kinds sit beside `NODE_DEFS`
Putting them inside `NODE_DEFS` would change the old node library and its icons. So:
- `NodeType` stays the 15 kinds. A new `BoardCardType = 'doc' | 'questions' | 'plan' | 'group' | 'take' | 'deliver'`. `CanvasNode.type` becomes `NodeType | BoardCardType`.
- `BOARD_CARD_DEFS` (family "Board", with zod schemas) and `BOARD_CARD_INPUTS` sit in `node-graph.ts` beside `NODE_DEFS`. `nodeDef()` reads both; `isBoardCardType()` and `inputRule()` are new. A typecheck experiment showed exactly one call site to adjust (`draft-merge.ts`).
- **A take is the shot card.** Today's `scene` and `generate` cards are the board's take cards and their versions sit on the shot card. The new `take` kind is for a result with no recipe on the board: a Make result placed on the board, an upload, a branch. `take.shotCardId` links it to a shot.
- **Frames get the same treatment.** Storyboard frames and look frames are existing cards; they get versions and verdicts too. "Every frame and take" means every card that holds media.

### 3.3 Card fields (optional; absent on every card saved before them)
- Any card: `groupId`, `groupOrder` (0–4,000).
- `doc`: `{ role: brief | shotlist | notes, rev, chars, rows }` (the body is in `board_docs`).
- `questions`: up to 5 items, each with up to 8 chip options, an optional free answer, and the answer's who and when; plus "Use your judgement" with who and when.
- `plan`: state (draft, waiting, approved, held, running, done, stopped), up to 50 steps (label, cards, engine, credits or null, basis exact | upTo | free | unavailable, needs admin, reason), total, fix allowance. `plan.quote`, `plan.approved` and an approved, running or done state are written **only** by the trusted plan writer (§ 3.7).
- `group`: kind (brief, looks, storyboard, plan, shot, cast, cut, deliver, custom), label, order, and for a shot group the shot card it names.
- `take`: the shot it belongs to, where it came from (make, upload, branch, library), and its one-line review note with who and when.
- `deliver`: the spec (aspect, frame rate, resolution, duration, loudness). Checks are computed; the master is a version.
- **Rules:** no media id or media URL in any field (media lives in `board_versions`, so trashing a take never breaks a draft save); each field at most 8,000 characters as JSON.
- **Doc body** (`board_docs.body`, at most 200,000 characters): Markdown text (headings, paragraphs, lists, bold, italic; at most 30,000 characters) plus an optional table (at most 12 columns and 1,500 rows; rows have ids and can link to a shot card). Markdown plus a table was the lead's choice; S3's Tiptap converts it. If S3 later needs Tiptap JSON, a second key is added.

### 3.4 The migration (workspace database, created on first use)
Five tables and three indexes, in each workspace's own database. Created with `CREATE TABLE IF NOT EXISTS` the first time a board write runs there (memoised, retried after a failure, as `canvas-ops-log.ts` and `rig-agent-store.ts` do). Reads check `sqlite_master` and never create a table. No existing table is altered. The platform database is untouched. Every table carries `workspace_id` in its key (rule 2).

- `board_docs(workspace_id, production_id, card_id, role, body, sha256, rev, updated_by, updated_at, PRIMARY KEY(workspace_id, production_id, card_id))`
- `board_versions(workspace_id, production_id, card_id, n, source_kind, source_id, parent_n, body, made_by, made_at, added_by, added_at, op_id, PRIMARY KEY(workspace_id, production_id, card_id, n), UNIQUE(workspace_id, production_id, card_id, source_kind, source_id))` with an index on `(workspace_id, source_kind, source_id)`. `source_kind` is generation, upload or doc. A number is never reused; a row is never deleted; a trashed take stays a version.
- `board_verdicts(seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id, production_id, card_id, n, verdict, reason, by_user, by_name, at, op_id, cause_seq, UNIQUE(workspace_id, production_id, op_id, card_id, n))` with indexes on `(workspace_id, production_id, card_id, n, seq)` and `(workspace_id, production_id, seq)`. Verdicts: approved, rejected (reason 3–500 characters), cleared. Rows are only added.
- `board_regions(workspace_id, production_id, id, name, x, y, w, h, position, created_by, created_at, updated_by, updated_at, hidden_by, hidden_at, PRIMARY KEY(workspace_id, production_id, id))`. At most 50 per production.
- `board_backfills(workspace_id, production_id, version, state, source, reason, cards, versions, batches, started_by, started_at, finished_at, PRIMARY KEY(workspace_id, production_id, version))`.

**Rollback:** revert the code; the tables sit unused. Dropping them is never needed and would go against "never erase team data". Later columns come one per PR through the existing `addColumn` pattern.

### 3.5 New ops (beside today's seven; one batch is one transaction and one log row)
| Op | Writes | Who |
|---|---|---|
| `create` of a new kind | the card | person, agent, system; a `plan` card only through the trusted plan writer |
| `group.add`, `group.remove`, `group.order` | members' `groupId`, `groupOrder` | person: any unlocked card. Agent or system: its own cards, or a card with no group yet; never takes a card out of a group a person chose |
| `doc.set` | `board_docs` (rev + 1) and the card's summary | person; agent or system only on a doc it wrote that nobody has changed since. Rows merge by id; an `ifRev` that no longer matches is refused ("This doc changed. Reload it.") |
| `doc.version` | a snapshot in `board_versions` (no-op if unchanged) | person, agent, system |
| `questions.answer` | one question's answer | person, agent (recorded; S2 decides when Atomik may answer) |
| `take.note` | the card's review note | person, agent |
| `version.attach` | `board_versions` | person, agent, system; the source must exist in this workspace |
| `region.set`, `region.hide` | `board_regions` | person, agent; hiding is people only |

Idempotency is by op id (`rig_canvas_ops`), plus natural keys for versions and request ids for verdicts. Two people grouping different cards, answering different questions or editing different doc rows both land; the same field's later write wins. Server writers (`agent:` and the new `system:board-backfill`) follow "a person always wins". Locked cards and masters are honoured as today.

### 3.6 Versions and verdicts
- **Version sources:** the card's own picture; assets filed on it; a shot card's takes (through `workbench_shots`, for any person on that production); Atomik's renders for it (`rig_agent_steps`); fixes (edits whose source chain reaches a version, with `parent_n`); explicit attachments. Numbered by when each was made, then by id. Numbers are given by the backfill, by `version.attach`, by a verdict on an unnumbered version, or just after a board read (as a bounded write after the response, like `scheduleCanvasPush`; the read answers those versions as pending with the number they will get).
- **Rules:** one approved version per card (approving vK writes an automatic "Superseded by vK" clear for the earlier one); rejection needs a reason; undo is allowed only while that verdict is the card's newest, and writes the inverse as new rows; only a finished render can be judged; docs and uploads any time. Free.
- **Mirror into today's marks** in the same transaction, so the Takes desk, Library, cut and phone read one truth: approved → `review_state='approved'` with the approver; rejected → `review_state='changes'`; cleared → `''`, keeping the `approved_by` trail. S1 never writes `picked`.
- **Marks set elsewhere** (`PATCH /api/jobs/[id]`) are read as the current verdict when newer. Two approved versions set through the old path are flagged as a conflict for the screen to ask about.
- **History:** `GET /api/board?history=<cardId>` lists every version and verdict row.

### 3.7 The plan card's trusted writer (for S2 and A1)
- A guard like `guardMasters`: any write through `PATCH /api/workbench/team-canvas` or an op that would create a `plan` card, write `plan.quote` or `plan.approved`, or set a plan to approved, running or done, is filtered (never refused) with "A plan is approved through its approval, never by an edit."
- Only `writePlanCard()` may write those fields. S1 ships its signature and tests. S2 calls it with the quote and the approval recorded by A1's paid path (`tool_approvals`), which is money and owner-gated there.
- Prices on a card are a display copy. No card edit changes what was approved.

### 3.8 Groups and Tidy
- A group is a `group` card; members carry `groupId` and `groupOrder`. A card is in at most one group. A shot group can name its shot card without writing to it.
- **Status is computed, never stored**, in Release 1's words (empty, working, needs, done; rolled up needs > working > done > empty), with a count of what needs a person and flags for failed, rejected and conflict. Stopped comes with S2.
- **Cost so far** is the settled credits of the members' versions, with a count still settling. Never a held figure.
- **Tidy:** a board without groups tidies exactly as today (golden test). With groups: brief, looks, storyboard, plan, shot 1…n, cast, cut, deliver, custom, left to right; members in order; ungrouped cards in a band below. The arithmetic is Release 1's `lib/board/layout.ts`, imported, so there is one layout. Locked cards and cards a writer may not move stay put.

### 3.9 Regions
Named bookmarks: a name and a viewport in board units, fitted to any screen. The rail's seven regions stay derived by Release 1 (`lib/board/regions.ts`); S1 stores only the ones people or Atomik save. The backfill makes none.

### 3.10 The project record (`GET /api/board/record`)
- **Brief:** the brief doc's revision, its newest version, whether it changed since, and who changed it; else the newest published shared context (`workbench_bibles`); else "no brief yet".
- **Approvals, one row each, quote → settled:** run limits approved or raised; each paid step's quote, who approved it (a person, or "spent without asking" for Auto), settled credits and outcome in today's words ("Nothing billed" only when nothing was charged); Atomik thread steps and held releases from Release 1's activity model (one model of priced → settled, not a second); plan approvals once S2 records them in `tool_approvals`.
- **Open decisions:** unanswered questions, versions waiting for a verdict, plans waiting for approval, runs that need a person, held takes (a count linking to the Approvals queue).
- **Spend:** `projectCapSpent`, the figure the gate enforces; "No budget" when there is no cap.
- **Money rules:** credits for platform-key workspaces; a workspace on its own keys sees its own unit. No vendor cost, rate or figure from the private policy in the JSON; a test asserts the keys.

### 3.11 A board for every existing production (the backfill)
- **One production at a time,** inside its workspace's database, through the same op path as every server change, as `system:board-backfill`. Bounded, deterministic batches (at most 100 cards and 400 version rows per call). Stable card ids; op ids from batch content. Idempotent and resumable.
- **Reads (only):** the project row; the creator's draft (brief, beats, boards, cast, environment, aspect, frame rate, its board cards); the newest published shared context when there is no draft; treatments and `shots` for productions made outside the workbench; `workbench_shots`, `generations` and `rig_agent_steps` for versions; `elements` to de-duplicate cast and places; the canvas as it is.
- **Makes, in order:** (0) when there is no canvas row, the creator's own board cards join it exactly as on first open; (1) a brief doc and a shot-list doc in a brief group; (2) framed beat shots not yet on the board (as "Build shots from boards" makes them), each in its shot group; existing shot cards get a shot group that names them and are not written; (3) cast and place cards not yet on the board; (4) a deliver card with its spec; (5) versions v1…vn for every card with media; (6) the ledger row.
- **Never:** writes a draft, shot, take, old board, element, published context, treatment, cast member, identity or upload; changes or moves an existing card; puts back a card a person took off; writes a verdict; renders, quotes or charges.
- **Skips, with the reason recorded:** Ads and Social projects (S4's), unreadable drafts, productions at the card limit (what fits is made, the rest counted).
- **Dry run first:** `POST /api/board/backfill {dryRun: true}` plans every batch in memory, writes nothing and does not create tables. The owner reads his own workspace's dry run before any real run.

### 3.12 API
Every route runs inside `withTenant`, checks the production belongs to this workspace (404 otherwise), answers `Cache-Control: no-store` and plain-word errors.

| Route | Who | Does |
|---|---|---|
| `GET /api/board` | signed-in members | The board read model: canvas, groups with status and cost, versions with verdicts, approved version per card, docs, regions, backfill state. `head=1` for the 5-second check; `history=<cardId>` |
| `POST /api/board/ops` | signed-in members; origin check | `{productionId, opId, ops[]}` (at most 500 ops, 1 MB) → outcomes, revision |
| `POST /api/board/approval` | **a signed-in person only** | `{productionId, cardId, n, verdict, reason?, requestId, undoOf?}`. Free |
| `GET /api/board/record` | signed-in members | The project record (§ 3.10) |
| `POST /api/board/backfill` | signed-in members (a board's first open starts it); origin check | `{productionId, dryRun?}` → state, counts, batches |

`app/api/workbench/team-canvas/route.ts` stays as it is. The new routes are thin over the same lib. Atomik (S2) uses the lib in-process as `agent:<runId>`, through the same gates. Board ops reach MCP only through A1's registry in S2.

**The write gate** (replaces the old switch, which Release 1 deletes): writes are refused on the sample productions ("Particl sample", and the generic starter), verdicts included, and refused while the platform's /admin setting "Board backend" is off for that workspace (owner decision 1). Reads are open to members and create nothing.

### 3.13 People-only verdicts, and the test that proves it
1. The approval route uses `requireSession` (A1.3's `requirePerson` once it lands): every token is refused with 403, including the token every MCP tool forwards. Wording: "Approving or rejecting needs a signed-in person. Atomik and outside agents can prepare it, never decide it."
2. The lib takes a `PersonActor`, which only the session can produce.
3. The lib also refuses, at runtime, any author starting `agent:`, `system:` or `mcp:`.
4. The person comes from the session, never from the body.
- **Test (`tests/unit/s1-approval.spec.ts`):** Atomik in-process is refused; an MCP call through `makeCaller` with a render token gets 403; a token on the route gets 403; another workspace's production gets 404; a person succeeds, and the take's marks match what `PATCH /api/jobs/[id]` would write.

### 3.14 Tenant separation
Every S1 query filters on `workspace_id` and `production_id`. Every source id (generation, upload) is checked against this workspace's own tables. Doc bodies, versions and verdicts never leave the workspace's database. Test: two workspace databases; a production id from A asked for in B answers 404, and nothing in A is read or written. The backfill runs inside one workspace at a time.

### 3.15 Failure paths
- A table that fails to create leaves that workspace's board read-only until the next write retries; today's screens are unaffected.
- A backfill stopped mid-way resumes from the board as it is; running it again adds nothing.
- A doc edited by two people on the same row: the later write wins and both are in the log; an editor that sends `ifRev` gets "This doc changed. Reload it."
- A verdict on a render still running answers 409 with "Only a finished take can be approved or rejected."
- S1 has no money path, so there is no refund path. Cost so far reads only settled credits.

---

## 4. PRs, in order (one concern each)

Every PR: typecheck, lint, full unit run, bounded build. Unit tests run on local libsql files with `ENGINE_MOCK=1` and a stand-in live room. Gate for every PR: an independent Opus review. Owner's yes where marked. S1 adds no screen; where shared files change, the Release 1 board and Rig browser specs run at 360×640, 390×844, 844×390, 1440×900 and 1920×1080 to prove nothing visible moved.

| # | Branch | What | Tests | Owner's yes |
|---|---|---|---|---|
| S1.1 | `s1/1-declare-kinds` | The six kinds and new fields declared, nothing writing them; `BOARD_CARD_DEFS`, `inputRule`, the plan guard, `isServerWriter` | `s1-cards-schema` (each kind valid and bounded; no media keys; golden parse of today's canvases and drafts; `NODE_DEFS` unchanged; plan guard via PATCH and ops); board and Rig browser specs at five sizes | No (lead check: shared schema files) |
| S1.2 | `s1/2-board-store` | **The migration** (§ 3.4) and store libs for docs, versions, verdicts, regions, ledger; no route | `s1-store-migration` (exact schema; idempotent; reads create nothing; existing DDL unchanged; retry after failure) | **Yes: migration** |
| S1.3 | `s1/3-board-ops` | The new ops in one transaction and one log row; `POST /api/board/ops`; the write gate | `s1-ops` (every op; replay; locks; card limit); `s1-two-writers` | No (lead and reviewer: a new state-changing route) |
| S1.4 | `s1/4-verdicts` | `POST /api/board/approval`, the mirror into take marks, `recordTakeVerdict()` | `s1-approval` (§ 3.13; mirror; undo; supersede; history) | **Yes: person-only approval** |
| S1.5 | `s1/5-groups-tidy` | Group status, cost so far, group-aware Tidy on Release 1's layout | `s1-groups-tidy` (status; roll-up; cost from stand-in receipts; Tidy without groups identical); browser specs at five sizes | No |
| S1.6 | `s1/6-board-read` | `GET /api/board` (head, history, numbering after the response) | `s1-read` (shape; pending numbers; no vendor field; people only; tenant isolation) | No (reads settled credits only) |
| S1.7 | `s1/7-record` | `GET /api/board/record` on Release 1's activity model | `s1-record` (brief fallbacks; approvals settled and settling; "Nothing billed" only when nothing was charged; decisions; spend; credits only; tenant isolation) | No (reads billing data; the owner sees it before S2 relies on it) |
| S1.8 | `s1/8-backfill` | The backfill: plan, runner, ledger, dry run; `rig-build.ts` gets an optional id source | `s1-backfill` on fixture productions (with and without a canvas; made outside the workbench; teammates' drafts; a card a person took off; a doc a person edited; a malformed draft; a 900-shot production): old rows hashed unchanged; second run adds nothing; resume equals one run; dry run writes nothing; two workspaces isolated | **Yes: it writes boards for existing productions.** The dry run of the owner's workspace goes to him first |
| S1.9 | `s1/9-sweep` (optional) | A per-workspace sweep the owner starts | Resume from the ledger; deadline respected | **Yes** |

---

## 5. Dependencies

- **Release 1** (Thu 8 Oct): `lib/board/layout.ts` (S1.5), `lib/control-room/activity.server.ts` (S1.7), the sample-production flag (the write gate), the deleted stage pages (no old screen to keep in step).
- **A1.3** (`requirePerson`): S1.4 uses it if it has landed, otherwise `requireSession` plus the lib's refusal; the test is the same.
- **A1.4 and A1.5:** the record lists plan approvals from `tool_approvals` once they exist; until then it lists run and step approvals.
- **S2** writes doc, questions, plan, group and take cards through S1's ops and `writePlanCard()`, and reads the record.
- **S3** (the full board on React Flow) adopts `GET /api/board` and the ops; the Record tab moves onto `GET /api/board/record` without a screen change.
- **Stream 5's person-only review marks** can call `recordTakeVerdict()` so the Takes desk's verdicts are logged too.

---

## 6. Risks

1. **A rollout window.** A server from before S1.1 would drop new card fields. Mitigation: S1.1 declares everything one release before anything writes it.
2. **Unlogged old-path approvals.** Marks set through `PATCH /api/jobs/[id]` have no reason or history until they call `recordTakeVerdict()`. Mitigation: the board reads them deterministically and flags a conflict.
3. **A write after a read.** Numbering after the response is a bounded, idempotent write. Precedent: `scheduleCanvasPush`.
4. **Whose draft builds the docs.** The creator's draft. Teammates' differing briefs stay in their drafts; nothing is lost.
5. **Size.** Doc bodies stay out of the canvas row and the log. The card limit still applies; the backfill counts what did not fit.
6. **Shared files.** Small additive edits to `studio.ts`, `studio-schema.ts` and `draft-merge.ts` (approved by the lead on 5 Oct). Golden tests guard them.
7. **Per-workspace DDL on Turso.** A failure affects only that workspace's board writes until the retry.

---

## 7. Open owner decisions

The lead recommended option A for each of the first eight.

1. **How the migration is applied.** (A) The five tables are made in a workspace's database the first time it writes to the board: internal and demo workspaces first, customers when the "Board backend" setting is on for them. (B) Added to the bootstrap every workspace runs.
2. **When the backfill runs.** (A) Per production, the first time its board opens, after the owner has read a dry run of his own workspace. (B) A, plus a per-workspace sweep he starts. (C) The sweep only.
3. **Existing cards and groups.** (A) The backfill never writes to an existing card; a shot group names its shot card. (B) It also files existing shot and frame cards into groups (their group fields only, logged and undoable).
4. **Whose draft builds the brief and shot list.** (A) The production creator's draft, else the most recently saved one. (B) The newest published shared context first, else A.
5. **Verdicts made on the Takes desk.** (A) Keep both paths; the board reads the desk's marks and logs only its own until stream 5's change. (B) Fold the logging into `PATCH /api/jobs/[id]` now.
6. **Outside agents (MCP) on the board.** (A) People only in S1; board tools for MCP come with S2 through A1, behind the same gates; verdicts stay with people. (B) Accept render tokens for non-verdict ops now, recorded as `mcp:<tokenId>`.
7. **A rejection's reason.** (A) Required, one line (3–500 characters). (B) Optional.
8. **How a rejection shows on today's screens.** (A) As today's "changes" mark, so no old reader changes. (B) A new `rejected` value, and every reader updated.
9. **The write gate after the switch is gone.** (A) A platform /admin setting "Board backend", per workspace, off by default; on for the internal and demo workspaces first, then for everyone. (B) On for every workspace from S1.3. Recommended: A (no env var).

---

## 8. Estimate

| PR | Agent-days |
|---|---|
| S1.1 declare kinds | 0.5 |
| S1.2 store and migration | 1 |
| S1.3 ops | 1 |
| S1.4 verdicts | 0.75 |
| S1.5 groups and Tidy | 0.75 |
| S1.6 board read | 0.5 |
| S1.7 record | 0.5 |
| S1.8 backfill | 1.25 |
| S1.9 sweep (optional) | 0.25 |
| **Total** | **6.5 agent-days**, plus review rounds |
