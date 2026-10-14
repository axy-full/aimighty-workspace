# Step 0 data: job label, reject reasons, who picked and approved, billed credits on the take (plan, 14 Oct)

The owner asked for this on 14 Oct (docs/redesign-plan.md on `redesign/integration`, "board design freeze"): server-side work that does not depend on the screens. This plan was read from release/1 at 890d559c. It changes no screen. Anything a screen will need is marked **waits for Claude Design / v18**.

**What Step 0 is for (my reading; owner question 1 confirms it).** Each take should carry enough facts to learn from later: what job it was doing, which engine made it, what it cost, who picked or approved it, and why it was rejected. Later steps (automatic engine choice, SOW 4 Oct §5.1 "Automatic engine choice"; Atomik's review) can then read this. Step 0 only records the facts. It does not use them yet.

**Rule 17 applies to every read of this data:** analytics read ids, codes and timings, never prompt text or a person's free-text reason.

## Where a take lives today
- **A take is a row in `generations`,** in each workspace's own database (`lib/db.ts:107-124`, plus columns added at `lib/db.ts:1040-1107`).
- **Tenant isolation is by database.** `db()` throws when no workspace is in scope (`lib/db.ts:9-20`, `:40-44`). Tables in a workspace database carry no `workspace_id` column, because the whole database belongs to one workspace. Every new table in this plan follows that pattern.
- **Platform tables carry `workspace_id`** and every query filters on it (for example `meter_events`, `lib/platform.ts:155-171`).

---

## 1. Job label per take

### Today
- **"Job label" is not defined anywhere in the code or docs.** I searched for it. The nearest things are:
  - `TEXT_JOB_LABELS` (`lib/platformLayer.ts:106`): the three text jobs (Prompt enhancement, Ideas and treatments, Shot lists). These are model settings, not takes.
  - `generations.kind`: video, image, audio or model (`lib/db.ts:1044`).
  - `generations.task`: generate, edit, extend, motion, upscale, reframe or genjutsu (`lib/db.ts:1063`, `lib/tasks.ts:25`).
  - `projects.category`: "what kind of job this is", a production-level genre (`lib/db.ts:991-994`).
  - Draft and final: a Seedance draft and its final are linked by `params.finalGenId` and `finalOf` (`lib/generationAdmission.ts:239`, `:2299-2305`; docs/seedance-draft-final.md).
  - Board stages: per board kind, and people can rename them (`lib/v12/board/stages.ts:40-80`). So a stage id is not a stable label.
  - Where a take was made: #706 (open) adds `params.madeIn = "make"`, set by the server (`lib/madeIn.ts` on that branch).
- **The CLAUDE.md "draft/hero split" is not in the code.** It is a product default for recipes, and recipe stage names are free text (`lib/db.ts:586-594`).

### The meaning I propose (owner question 1)
**The job label says what the take was for in the production.** It is a closed list. `kind` and `task` already say what the engine did, so the label adds only the missing fact: the purpose.

| Code | Means | How the server knows |
|---|---|---|
| `storyboard` | a still for a storyboard frame | the request says so (a hint, checked) |
| `keyframe` | a still used as a shot's first or last frame | hint |
| `cast` | a cast reference or sheet | hint; the identities routes set it themselves |
| `element` | an environment, prop or look reference | hint |
| `shot_draft` | a cheap draft take of a shot | a Seedance draft; or a hint |
| `shot_final` | the final or hero take of a shot | `finalOf` is set; or a hint |
| `shot` | a video take of a shot, with no draft or final mark | the default for a video filed on a shot |
| `fix` | an edit, extend, reframe, motion transfer or object swap of an earlier take | `task` is not `generate` |
| `upscale` | an upscale | `task` or the still tool is upscale |
| `voice` | speech, dialogue, dub or voice change | the audio task |
| `music` | music | the audio task |
| `sound` | sound effects | the audio task |
| `ad` | a Campaign format run | the skill or format that sent it |
| `other` | none of the above | the fallback |

### Proposed change
- **Stored as `params.job`, written only by the server.** No new column, so no migration. This follows the owner's word on #706 ("do it without a new column if possible") and #706's own pattern.
- **One function decides it:** `jobOf(request, actor)` in a new `lib/takeJob.ts`.
  - It derives what it can from facts (kind, task, `finalOf`, the audio task, the route).
  - It accepts a hint from the request only if the hint is on the list and fits the kind. For example, `storyboard` is refused for a video.
  - Anything else is `other`. A bad hint is a 400, not ignored (as #706 does for `madeIn`).
  - Atomik steps set it from the step's own definition, because a step's body is rebuilt on the server (`lib/generationAdmission.ts:445-453`).
- **The label never changes the price.** It is not part of the quote. (Today the whole body is in the quote's fingerprint. `job` must be left out of the fingerprint so that a label cannot make a quote stale.)
- **Alternative, not recommended for now:** a `job TEXT` column with an index. Choose this only if Step 0's later queries are too slow with `json_extract`. Workspaces hold thousands of takes, not millions, so `json_extract` is enough today.

### Backfill
- **No rewrite of old rows.** Instead, a read helper `jobOfRow(row)` works out the label for old takes at read time, only where the facts are certain:
  - an audio take, by its task: `voice`, `music` or `sound`;
  - `task` not `generate`: `fix` or `upscale`;
  - a take named by another take's `finalGenId`: `shot_final`, and the draft: `shot_draft`.
- **Everything else on old rows reads `null` ("not recorded")**, never a guess. Old stills cannot honestly be split into storyboard, keyframe, cast or element.

### Who writes it, and when
- **Writes:** the admission path, in the same insert as the take row (`lib/generationAdmission.ts:2307-2330`). Also the still, audio and identity routes that insert takes.
- **Reads:**
  - Library and jobs API: a `job` field and a `?job=` filter in `listGenerations` (`lib/jobs.ts:280`).
  - CSV export: one more column (`lib/exportRows.ts:29`).
  - Statements: unchanged (they itemise by engine).
  - MCP: `get_render` and `list_renders` return it (`lib/mcp.ts:105-128`).
- **Screens:** showing or picking the label on the board **waits for Claude Design / v18**.

### Tenant isolation and privacy
- It lives in the take's own row, in the workspace's own database.
- It holds no person and no money.

---

## 2. Structured reject reasons

### Today
- **"Rejected" is `review_state = 'changes'`** (`lib/db.ts:1048`, written by `app/api/jobs/[id]/route.ts:229-238`).
- **The reason is a separate note.** The board sends two calls: the mark, then a note (`components/graphite/board/cards/take/use-judge.ts:74-90`). The note's text is the tapped chips plus the typed line, joined by "; " (`components/graphite/board/cards/take/take-model.ts:399-404`). The note is an ordinary row in `notes` (`lib/db.ts:264-271`, written by `app/api/notes/route.ts:64-65`).
- **So nothing marks that note as a reject reason,** and the chips are not stored as categories. If the second call fails, the mark stands with no reason (`use-judge.ts:81`).
- **The chips:** "Off the brief", "Wrong framing", "Motion looks wrong", "Look or face drifted", "Artifacts" (`take-model.ts:399`).
- **Client verdicts from a review link** are a separate table, `review_verdicts` (`lib/security/review-link.ts:29-33`). The client's words are in `review_notes` (`lib/db.ts:275-283`).
- **A second writer clears approvals:** changing a locked attribute sets `review_state = ''` on approved takes (`app/api/rig/attributes/[id]/current/route.ts:120-127`). Nothing records why.

### Proposed change
**A closed list of reasons**, in a new `lib/rejectReasons.ts`. Each reason has a code and its one UI label (rule 5: one vocabulary):

| Code | Label (today's chip) |
|---|---|
| `off_brief` | Off the brief |
| `framing` | Wrong framing |
| `motion` | Motion looks wrong |
| `drift` | Look or face drifted |
| `artifacts` | Artifacts |
| `audio` | (new; owner question 2) Sound or lip-sync is wrong |
| `other` | used when only free text is given |

- **Each existing chip maps one-to-one to a code.** Nothing is merged or renamed.
- **`drift` may carry one detail:** `identity`, `wardrobe`, `environment` or `props`. These are the checks the Verify judge already scores (`lib/workbench/verify.ts:25`). Later, a person's reject and the judge's score can then be compared. The detail is optional.

**One new table in the workspace database, `take_review_events`.** It is append-only and follows the pattern of `element_lock_events` (`lib/db.ts:479-505`):

```
take_review_events (
  id          TEXT PRIMARY KEY,
  gen_id      TEXT NOT NULL,
  action      TEXT NOT NULL,      -- picked | approved | changes | cleared
  actor_id    TEXT NOT NULL,      -- the account id; '' for the system
  via         TEXT NOT NULL,      -- person | token | agent | system
  token_id    TEXT,               -- the API token, when via = token
  reasons     TEXT,               -- JSON array of codes, only for 'changes'
  drift       TEXT,               -- the optional drift detail
  note_id     TEXT,               -- the note that carries the person's words
  cause       TEXT,               -- for 'cleared' by the system: 'master_changed'
  created_at  INTEGER NOT NULL
)
INDEX (gen_id, created_at)
```

- **The person's words stay in `notes`,** so the team still sees one conversation. The event row links to the note by `note_id`. Free text is not copied into the event.
- **The server accepts the reasons on the same request as the mark.** `PATCH /api/jobs/[id]` gains optional `reasons` (codes), `drift` and `reasonText`. In one transaction it writes the mark, the event and the note. So a reject can no longer land without its reason.
  - Unknown codes are a 400.
  - Reasons are **optional on the server**. An MCP or API caller that sends only `reviewState: "changes"` keeps working (owner question 6).
  - The board already requires a reason of 3 to 500 characters (`take-model.ts:394-410`).
- **The old two-call path keeps working** until the board is wired. That wiring is a payload change in `use-judge.ts`, with no visible change. It still waits for v18 or the owner's OK, because it touches the board's code (owner question 7).
- **The system clear** in the attributes route writes a `cleared` event with `via = system`, `cause = master_changed`, and the person who changed the attribute as `actor_id`.
- **Client review links stay as they are.** Guests have no account, so they are not copied into this table. Step 0 reads `review_verdicts` beside it. Structured reasons for guests **wait for Claude Design / v18**.

### Backfill
- **None.** Old reject notes cannot be told from other notes with certainty. Someone may have typed "Artifacts" as an ordinary comment.
- The chip panel is in the new interface, which is off for every customer workspace (`lib/newInterface.ts`). So in practice only the house workspace has chip-made notes.
- If the owner wants a count, a read-only report can list the notes that start with an exact chip label right after a `changes` mark. It writes nothing.

### Reads
- **The take's history** (the board's versions card) reads events and notes. Showing reason chips there **waits for v18**.
- **CSV export:** `reject_reasons` (codes joined by `;`). Never the free text, which stays in the notes export.
- **MCP:** `get_render` returns `review` with its state and, for `changes`, the codes.
- **Step 0 analytics:** codes and timings only (rule 17).

### Tenant isolation and privacy
- The table is in the workspace's own database.
- `actor_id` is shown the same way as described in item 3 below.

---

## 3. User ids for pick and approve

### Today
- `picked_by`, `approved_by` and `review_by` store the person's **display name** at that moment (`app/api/jobs/[id]/route.ts:229-238` writes `got.user.name`).
- **A name is not a person.** Two members can share a name. A rename breaks the link. A deleted member's name still reads, but it cannot be tied to their account.
- **Each column keeps only the latest mark.** If a take was picked, cleared and picked again by someone else, the first pick is lost.
- **For the platform owner the name is already masked when it is written.** In a client workspace, the session's name is "Particl support" (`maskSessionUser`, `lib/platformOwnerPrivacy.ts:245-253`). The workspace's own `users` row for the owner is stored as "Particl support" at an address that is not theirs (`mirrorIdentity`, `:230-237`).
- **Account ids are already in each workspace database:** `users.id` is the account id, and `generations.created_by` and `notes.user_id` hold it (`lib/jobs.ts:277` joins on it).
- **Masking ids on read already has a pattern.** Outside the house workspace, the owner's account id is shown as an opaque `supportMemberId(workspace, account)` (`lib/platformOwnerPrivacy.ts:214-216`, used in `lib/workbench/team-boards.ts:42` and `app/api/team/route.ts:67`). Stored actor values go through `storedActorMaskHere` (`:184-208`).
- **PR #702 is still open,** not merged. It adds `workbench_projects.updated_by` as an account id. This plan uses the same rule: store the id, mask it on every read.

### Proposed change
- **The ids go in `take_review_events.actor_id`** (item 2). There are no new columns on `generations`.
  - "Who picked it" is the latest `picked` event. "Who approved it" is the latest `approved` event. The index on `(gen_id, created_at)` keeps this cheap for a page of takes.
  - Unlike columns, events keep the whole history.
- **The name columns stay** and are written exactly as today. Older screens and exports keep working.
- **`via` records the channel:** a person in a browser, an API or MCP token, an agent (`agent:*`, `lib/security/people-only.ts:18`), or the system.
  - Today a token can pick, approve or reject a take: the route accepts `got.token`. That is unchanged here, only recorded (owner question 4).

### Backfill
- **None (recommended).** Matching old names to ids would guess wrong whenever a member was renamed or two members share a name.
- Old takes keep their names. Their ids read `null`, meaning "not recorded" (owner question 3).

### Reads, and what is never sent
- **API replies and MCP** send the masked name (the `users` join, as `lib/jobs.ts:277` does for the take's maker), never a raw account id.
  - Where a screen needs an id to filter by person, it is the Team list's id: `supportMemberId` for the owner outside the house workspace, as in `team-boards.ts:42`.
- **CSV export:** names only (`picked_by`, `approved_by`), masked. No ids.
- **Step 0 analytics:** ids, inside the platform only. They are not sent to any third party.
- **Deleted members:** their `users` row is retired, not erased (`lib/db.ts:942-944`), so their name still reads.

### Tenant isolation
- An account id appears only in the databases of workspaces the person belongs to, which is already true of `users`.
- No event names another workspace.

---

## 4. Billed credits on the take

### Today: this mostly exists already
- **The source of truth** is `meter_events.billed_credits` in the platform database (`lib/platform.ts:155-171`), written by `meter()` (`lib/meter.ts:150-245`).
  - While a take runs, its row holds the reservation (the quote). At settle it holds what was charged.
  - A failure that cost nothing settles at 0. Work on a workspace's own keys is 0 credits (`lib/meter.ts:204-206`).
  - An overrun past a hold is absorbed by the platform and never changes `billed_credits` (`lib/meter.ts:26-36`).
- **A copy already reaches each workspace.** A trigger writes every change to `meter_credit_receipts`, with a rising revision number (`lib/platform.ts:176-197`). `syncCreditReceipts()` copies those rows into the workspace's own `credit_receipts` table, keyed by the take's id (`lib/creditReceipts.ts:8-30`, `lib/db.ts:48-49`).
  - The sync runs before every read that needs money (for example `lib/jobs.ts:314`).
  - An older copy can never overwrite a newer one (`creditReceipts.ts:23`).
  - Refunds and restatements arrive as new revisions. `tests/unit/creditReceipts.spec.ts:19` covers refunds, rate changes and clock skew.
- **The take already reads it:** `billedCreditsExpr` (`lib/creditSql.ts:28-31`), returned as `creditsBilled` (`lib/jobs.ts:244-246`). The CSV export uses it (`lib/exportRows.ts:47`, `:79`). The MCP wait reply uses it (`lib/jobs.ts:705`). Statements read the meter directly (`lib/statements.ts:209-211`).
- **The gaps:**
  1. **Takes from before metering** have no receipt. They show a figure computed at read time from `cost_usd` and today's margin table (`lib/creditSql.ts:5-25`). The comment says history must not be repriced, but the code uses the current `margins()`. A change to the margin table would change these old figures.
  2. **The quote and the approved ceiling are not kept.** The quote lives in the meter row only until settle overwrites it. The person's ceiling (`maxCredits`, `lib/generationAdmission.ts:2110-2116`) is checked and then dropped. So "quoted 43, charged 43" cannot be shown afterwards.
  3. **A running take's figure is its reservation,** and nothing in the take's money says "not final yet" except the take's own status.

### Decision: do not add a `billed_credits` column to `generations`
- **It would be a third copy** of the same number (meter, receipts, take). Every refund, restatement (`lib/ledgerUnit.ts`) and reconcile would need a third write, and a missed write would be a silent disagreement with the balance.
- **The receipt table already is the snapshot,** and it is the safe kind: written from the meter, ordered by revision, replayed on the next read if a write was missed.
- **So "billed credits on the take" means:** one helper, `takeCredits(row)`, returns `{ credits, final, estimated }`:
  - `credits` comes from the receipt;
  - `final` is true once the take has settled (`settled_at`, `lib/db.ts:1115`);
  - `estimated` is true for a take with no receipt (gap 1).
  
  Every reader uses this helper: Library, export, MCP and Step 0.

### The two snapshots I do propose (owner question 5)
- **`params.quote = { credits, maxCredits }`,** written once by the server at admission, in the same insert as the take:
  - `credits` is what the server price path quoted (`quotedCredits(estUsd, model) × band`);
  - `maxCredits` is the person's approved ceiling, or the plan approval's, when there is one.
  
  No migration. This is our price in credits, never a vendor dollar. On a workspace that uses its own keys, nothing is written, because there is no credit quote there.
- **Pre-metering takes are labelled `estimated`** in the export and the API. Their number is not changed and nothing is written to the meter. Writing meter rows for old takes would debit balances.

### Consistency on refunds and overruns
- **A refund** (settle at 0) or a correction is a new receipt revision. The take shows it after the next sync. No new code is needed. A test proves it end to end for the helper.
- **An overrun** never changes `billed_credits` (`lib/meter.ts:26-36`). So the take shows what the person approved, and the platform's absorbed cost stays on the admin desk only.
- **The quote snapshot is never updated.** It records what was promised, so "quoted vs charged" stays honest.

### Who reads it
- **Library and jobs API:** `creditsBilled` as today, plus `final` and `estimated`.
- **CSV export:** `credits`, plus `credits_quoted` and `estimated`.
- **Statements:** unchanged. They read the meter, which is the source of truth.
- **MCP:** `get_render` and `wait_for_render` add the quote.
- **Price wording follows rule 14:** `N cr`, `up to N cr`, or `free`. A vendor cost never reaches a customer. The new fields must pass `tests/unit/noVendorCostToCustomers.spec.ts`.

### Tenant isolation
- The receipt sync filters on `workspace_id` (`lib/creditReceipts.ts:16`).
- The quote is in the take's own row.

---

## 5. Migrations

There is **one** migration in this plan. It ships only after the owner's backup (docs/backup-restore.md), in a migration deploy, never mixed into an ordinary one.

| # | What | Database | Additive? | Safe to roll back? |
|---|---|---|---|---|
| M1 | `CREATE TABLE IF NOT EXISTS take_review_events` and its index | each workspace database | Yes: a new table. No existing row or column is touched. No backfill. | Yes. The previous release never reads the table. Rolling back leaves it in place, unused. Events written before the rollback stay valid. Reviews made during a rollback have no event; they read as "not recorded", and their names are still in the old columns. |

- **Items 1 and 4 add no schema.** `params.job` and `params.quote` are server-written keys in existing JSON. A previous release ignores them. Rolling back is safe: new takes simply stop getting the keys.
- **No migration touches the platform database.**
- **The table is created in the workspace bootstrap** (`lib/db.ts:878` onwards), the same way `element_lock_events` is. Tests: `tests/unit/schemaInitialization.spec.ts` and `schemaColumnRace.spec.ts` gain a case. Nothing in them is changed or removed.

## 6. PRs (about 30 h of Sonnet lane time)

| # | PR | Size | Review | After |
|---|---|---|---|---|
| 1 | `lib/rejectReasons.ts` and `lib/takeJob.ts`: the two closed lists, labels and the chip map. Pure, no schema. | S, 2h | — | — |
| 2 | Job label: `jobOf` at every take insert; `jobOfRow` for old takes; `?job=` filter; left out of the quote fingerprint | M, 6h | — | 1, #706 |
| 3 | M1: `take_review_events`; `PATCH /api/jobs/[id]` writes the mark, the event and the note in one transaction; the system clear writes an event | M, 8h | **Opus (privacy)**, migration, NEEDS AKSHAY | 1 |
| 4 | Reads: who picked and approved from events, masked; `via`; MCP `review` field | S, 4h | **Opus (privacy)** | 3 |
| 5 | `takeCredits()` helper used by Library, export and MCP; `estimated` for takes before metering | S, 4h | **Opus (money)** | — |
| 6 | `params.quote` snapshot at admission; export `credits_quoted` | S, 4h | **Opus (money)**, NEEDS AKSHAY | 5 |
| 7 | CSV export columns: `job`, `picked_by`, `approved_by`, `reject_reasons`, `credits_quoted`, `estimated` | S, 2h | — | 2, 4, 6 |
| 8 | Board wiring: the reject panel sends codes; the versions card shows them; the Library shows the job | — | **waits for Claude Design / v18** | 3, 4 |

**Guard tests: added to, never weakened.**
- `tests/unit/platformOwnerPrivacy.spec.ts`: new cases. The owner's pick or approval reads "Particl support" in a client workspace and their name in the house workspace. No raw owner account id appears in any reply.
- `tests/unit/noVendorCostToCustomers.spec.ts`: the new money fields pass the scanner.
- `tests/unit/creditReceipts.spec.ts`: new case. `takeCredits` follows a refund and a restatement.
- `tests/unit/neverDelete.spec.ts`: unchanged. Events are only ever added.
- `tests/helpers/uiStrings.ts`: the new labels use no retired word.
- If a guard seems to be in the way, the PR stops and shows the exact lines to the owner.

**Mocked tests that prove an agent can use it (rule 11):**
- An MCP token rejects a take with codes, and the event records `via = token`.
- An Atomik step's take carries its job label.
- No engine is called anywhere in this plan.

## 7. Owner questions (with recommendations)
1. **What does "job label" mean?** Three options:
   - **A. The purpose:** storyboard, keyframe, cast, element, shot draft, shot final, fix, voice and so on (item 1).
   - **B. Where it was made:** Make, a board, an Atomik plan, a skill, MCP or the API. This would grow #706's `madeIn` into a full list.
   - **C. The production's genre** (`projects.category`, for example "30s car spot"), copied onto each take.

   **Recommended: A,** stored as `params.job` with no migration. B is mostly there already (#706, plus `token_id`). C needs no copy, because a take already links to its production.
2. **The reject list:**
   - Keep the five chips one-to-one, and add `audio` and `other`? **Recommended: yes.**
   - Split "Look or face drifted" into separate chips? **Recommended: no.** Keep one chip, with an optional detail (identity, wardrobe, environment, props) that matches Verify's checks.
3. **Fill in ids for old picks and approvals by matching names?** **Recommended: no.** Old rows keep their names and read "not recorded" for the id.
4. **Should an API or MCP token be able to approve a take?** Today it can. Approving a take is not spending, but it is a sign-off. **Recommended:** record the channel now (this plan). Then make approve people-only in a separate small PR, as with approving a post. Tokens may still pick and reject.
5. **Keep the quote and the approved ceiling on each take** (`params.quote`)? **Recommended: yes.** It lets "quoted vs charged" be shown and checked.
6. **Is a reject reason required on the server?** **Recommended: optional on the server, required on the board** (as today), so existing API callers keep working.
7. **May PR 8's non-visual part (the reject panel sending codes) land before v18?** **Recommended: wait for v18**, as the freeze says.
