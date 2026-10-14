# Step 0 data: job label, shot type, reject reasons, who picked and approved, billed credits on the take (plan, 14 Oct; owner answers added)

The owner asked for this on 14 Oct (docs/redesign-plan.md on `redesign/integration`, "board design freeze"): server-side work that does not depend on the screens. This plan was read from release/1 at 890d559c. It changes no screen. Anything a screen will need is marked **waits for Claude Design / v18**.

**What Step 0 is for.** Each take should carry enough facts to learn from later: what job it was doing, which engine made it, what it cost, who picked or approved it, and why it was rejected. Later steps (automatic engine choice, SOW 4 Oct §5.1 "Automatic engine choice"; Atomik's review) can then read this. Step 0 only records the facts. It does not use them yet.

**Rule 17 applies to every read of this data:** analytics read ids, codes and timings, never prompt text or a person's free-text reason.

## Owner decisions (14 Oct, after the first draft)
In the owner's words: "job label = A (purpose) AND add the shot type (the recipe: face close-up, pack shot, dialogue, motion transfer, product reveal, etc.) as a second label, e.g. params.shot — Particl Auto routes on it. Other recommendations accepted, including approving takes people-only." And: "pre-metering takes marked 'estimated', no repricing".

- **DECIDED: the job label is the purpose** (item 1), stored in `params.job`.
- **DECIDED: a second label, the shot type** (item 1b). This plan stores it as `params.shotType`, not `params.shot`. In the code, `shot` already means shot *size*: the composer's Shot chip (`lib/workspace/film-vocabulary.ts:6-9`, `:27`) and the Setup row `shot` (`lib/studio.ts:52`) both write it, and it is stored on every take as `params.shotSpec.shot`. A second `shot` key would mean two things. (If the owner prefers `params.shot` anyway, it is a one-word change; see owner question A.)
- **DECIDED: approving a take is people-only.** An API token, an MCP client or an agent identity (`agent:*`) is refused. Picking and rejecting stay open to them. This is PR 2 below.
- **DECIDED: a reject reason is optional on the server and required on the board.** The board side follows the v18 design.
- **DECIDED: no backfill of ids by name matching. A quote snapshot goes on each take (`params.quote`).**
- **DECIDED: takes from before metering are marked `estimated`, and they are never repriced.** Item 4 says exactly how. Today they *are* repriced whenever the margin table changes.

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

### The meaning (DECIDED: option A, the purpose)
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

## 1b. Shot type per take (`params.shotType`), the label Auto routes on

### Today: what the code already knows about a shot's type
**No single field says what kind of shot a take is.** Five places carry pieces of it:
- **Setup rows**, written on every take as `params.shotSpec` (videos: `lib/generationAdmission.ts:2175`, `:2217`; stills: `:1620`):
  - shot size: extreme close, close-up, medium close, medium, medium wide, wide, establishing, over shoulder, POV, insert (`lib/studio.ts:52-66`);
  - sound: ambient, music-led, dialogue-led, silent (`lib/studio.ts:273-281`).
- **The cast a take cites,** stored as `params.cast` (`lib/generationAdmission.ts:1617`, `:2205`). Each cast member has a kind: character, location, prop or style (`lib/db.ts:200`; `lib/platformLayer.ts:34`).
- **The task** (`lib/tasks.ts:25`). `motion` is "motion control" (`:102-105`). `genjutsu` is "Transform: transfer motion or swap subjects" (`:65`).
- **Make's creative templates**, 18 in all (`lib/workbench/moleculr-creative.ts:44-61`). Examples:
  - `studio-seamless` (Studio essential), `listing-clean`, `listing-detail` (Material close-up);
  - `editorial-model` (With a model);
  - `ugc-presenter` (Talking head), `ugc-faceless` (Faceless demonstration), `ugc-silent` (Silent unboxing);
  - `motion-orbit` (Product orbit, whose first beat is "Reveal"), `motion-graphic`, `motion-mixed`;
  - posters and banners.
- **Campaign formats,** which point at those templates (`lib/v12/campaign.ts:95-102`): Product video ad, Talking review, Unboxing ("the product revealed"), Try-on, Tutorial, Photoshoot ("Packshot · lifestyle · banner · carousel"). "Product voice-over" ("Narrated pack shots") is listed but not built (`:100`).
- **The words "recipe" and "pack shot".** "Recipe" already means two other things in the code: a take's whole settings for Recreate (`lib/shell/recipe.ts:6-15`), and the `recipes` table (`lib/db.ts:573`). So this plan says **shot type**. "Packshot" appears only as Product-stage photo candidates and the "End packshot" mandatory (`lib/v12/campaign.ts:49`, `:71`; `lib/v12/deliver.ts:104`), never as a kind of take.

### The closed list (proposal; owner question B)
| Code | Means | Where the code already has it | The server sets it when… |
|---|---|---|---|
| `face_close_up` | a close shot of a real or cast character's face | shot size `cu` or `ecu` (`lib/studio.ts:56-57`) **plus** a cited cast member of kind `character` | the Setup's shot is `cu` or `ecu` and the take cites a character |
| `dialogue` | people speaking in the scene | Setup sound `dialogue` (`lib/studio.ts:279`) | Setup sound is `dialogue` |
| `talking_head` | one presenter speaking to camera | template `ugc-presenter`; format "Talking review" | it comes from that template or format |
| `pack_shot` | the product alone, clean, as a hero still or end frame | templates `studio-seamless` and `listing-clean`; "Packshot" in the Photoshoot format | it comes from those templates |
| `product_reveal` | the product revealed or opened: an unboxing, or a light or orbit reveal | templates `ugc-silent` and `motion-orbit` ("Reveal" beat); format "Unboxing" | it comes from those templates |
| `product_detail` | a macro or insert of a product detail | shot size `insert` (`lib/studio.ts:65`); templates `detail-ad` and `listing-detail` | the Setup's shot is `insert`, or it comes from those templates |
| `on_model` | the product worn or held by a person | templates `editorial-model`, `lifestyle-moment` and `listing-context`; format "Try-on" | it comes from those templates |
| `demonstration` | hands showing how the product is used | template `ugc-faceless`; format "Tutorial" | it comes from that template |
| `motion_transfer` | another clip's movement given to a character, or a subject swapped | tasks `motion` and `genjutsu` (`lib/tasks.ts:65`, `:102`) | the task is `motion` or `genjutsu` |
| `establishing` | a wide shot that sets the place | shot size `evs` (`lib/studio.ts:62`) | the Setup's shot is `evs` |
| `graphic` | type, shapes or a poster, with no live action | templates `motion-graphic`, `type-poster`, `launch-poster`, `wide-poster`, `hero-ad`, `story-ad` | it comes from those templates |
| `action` | a character moving through a scene (the default for a video that cites a character) | Setup `move` plus a character | a video cites a character and nothing above applies |
| `other` | none of the above | — | the fallback; never guessed further |

**Types the owner named that the code lacks:**
- **"Face close-up"**: the code has the shot size (`cu`, `ecu`) but no notion of a *face*. The rule above is built from size plus a character. It cannot tell a close-up of a hand from one of a face when a character is cited.
- **"Pack shot"**: no kind of take, only templates and Product-stage wording.
- **"Product reveal"**: only a template beat ("Reveal") and a format's description.

"Dialogue" and "motion transfer" exist (a Setup row and two tasks). The owner should confirm the list (owner question B).

### Who sets it, and when
- **The server, at admission,** in the same insert as the take row (`lib/generationAdmission.ts:2307-2330`), through one function, `shotTypeOf(request, actor)`, in `lib/takeJob.ts` beside `jobOf`.
- **Order of evidence, first match wins:**
  1. the task (`motion` or `genjutsu`);
  2. the template or format id the request came from;
  3. the Setup (`shotSpec.shot`, `shotSpec.sound`) and the cast it cites;
  4. a hint from the request (the board's shot card, or an Atomik plan step), accepted only if it is on the list and fits the kind (a `pack_shot` hint on an audio take is a 400).
- **The template id is not sent today.** Make's composer and the Campaign Formats stage would send it (`templateId`) the way #706 sends `madeIn`. That is a payload change with no visible change; it waits for v18, with the rest of the board wiring.
- **Audio takes get no shot type** (`null`). A shot type describes a picture.
- **Not part of the price, and left out of the quote's fingerprint,** like `job`.

**Reads.** As for `job`: a `shotType` field and a `?shotType=` filter in `listGenerations`, an export column, and MCP `get_render` and `list_renders`. Showing it on the board waits for v18.

### Backfill (only when certain)
No rewrite of old rows. A read helper, `shotTypeOfRow(row)`, works it out at read time, only from facts the take stored:
- `task` is `motion` or `genjutsu` → `motion_transfer`;
- `params.shotSpec.shot` is `evs` → `establishing`;
- `params.shotSpec.shot` is `insert` → `product_detail`;
- `params.shotSpec.sound` is `dialogue` → `dialogue`;
- `params.shotSpec.shot` is `cu` or `ecu` **and** `params.cast` names a cast member whose kind is `character` → `face_close_up`.

**Everything else on old rows is `null` ("not recorded").** The template a take came from was never stored, so old takes cannot be told apart as `pack_shot`, `product_reveal`, `on_model`, `demonstration`, `talking_head` or `graphic`.

### How Auto would route on it (described; not built here)
Today "Auto" in Make picks by type alone ("Auto · Video, so <model>", `components/v12/make/Composer.tsx:141-143`; the default model is `lib/models.ts:573`). SOW 4 Oct §5.1 lists "Automatic engine choice: Particl rule table over the registry" (E2, U1) as not yet built. With the shot type, the rule table would be:

- **A platform-layer table (rule 3), overridable per workspace:** `(shotType, job) → an ordered list of engines and settings`, each priced on the server. Examples of the *kind* of rule:
  - `face_close_up` prefers engines that take identity or reference input, and adds the face check to Verify;
  - `motion_transfer` goes only to motion-control engines;
  - `dialogue` and `talking_head` prefer engines with native audio, or plan a lip-sync step after;
  - `pack_shot` and `product_detail` prefer still engines that keep product references exact;
  - `shot_draft` takes the cheap engine of the pair, and `shot_final` the hero engine (the draft/hero split in CLAUDE.md § Pricing).
- **Step 0's data then tunes it.** Rejects by reason, per `(shotType, engine)`, and picks and approvals per `(shotType, engine)` show which engine wins for which shot type. That is a later step, reading codes and ids only (rule 17).
- **Nothing about money changes:**
  - Auto stays one line with a Change link (rule 13);
  - the price comes from the server's price path;
  - a person approves (rule 14).
  
  The routing only chooses which engine is quoted.

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
| `audio` | (new; DECIDED) Sound or lip-sync is wrong |
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
  - **DECIDED: reasons are optional on the server.** An MCP or API caller that sends only `reviewState: "changes"` keeps working. They are required on the board, as today, and again after v18.
  - The board already requires a reason of 3 to 500 characters (`take-model.ts:394-410`).
- **The old two-call path keeps working** until the board is wired. That wiring is a payload change in `use-judge.ts`, with no visible change. **DECIDED: it waits for v18.**
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
  - **DECIDED: approving is people-only.** Today a token can pick, approve or reject a take: the route accepts `got.token` (`app/api/jobs/[id]/route.ts:94-99`). PR 2 refuses `reviewState: "approved"` unless `isPerson({ user, token })` holds (`lib/security/people-only.ts:22-29`). So an API token, an MCP client and an `agent:*` identity get 403 with `PEOPLE_ONLY` (`:16`), and nothing is written. Picking, rejecting and clearing a pick stay open to them, and `via` records who did it.
  - **Clearing an approval** (`reviewState: ""` on an approved take) is also people-only, so a token cannot undo a person's sign-off. The system clear when a locked attribute changes (`app/api/rig/attributes/[id]/current/route.ts:120-127`) is not an approval and stays as it is.
  - **Client review links** (`lib/security/review-link.ts`) are guests, recorded in their own table. They are untouched.

### Backfill
- **None (recommended).** Matching old names to ids would guess wrong whenever a member was renamed or two members share a name.
- **DECIDED: no backfill.** Old takes keep their names. Their ids read `null`, meaning "not recorded".

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
- **The source of truth** is `meter_events.billed_credits` in the platform database (`lib/platform.ts:155-171`), written by `meter()` (`lib/meter.ts:158-245`).
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

### The two snapshots (DECIDED)
- **`params.quote = { credits, maxCredits }`,** written once by the server at admission, in the same insert as the take:
  - `credits` is what the server price path quoted (`quotedCredits(estUsd, model) × band`);
  - `maxCredits` is the person's approved ceiling, or the plan approval's, when there is one.
  
  No migration. This is our price in credits, never a vendor dollar. On a workspace that uses its own keys, nothing is written, because there is no credit quote there.
- **Pre-metering takes are labelled `estimated`** in the export and the API. Nothing is written to the meter: writing meter rows for old takes would debit balances.

### DECIDED: "estimated", and never repriced. Exactly how
**The problem.** Four places price a take that has no receipt, and all four use **today's** margin table (`margins()`, which `CREDIT_MARGINS` can change at any time):
- `historicalCreditsExpr` in `lib/creditSql.ts:5-25`. This is the SQL every take, usage, project, shot and export read uses through `billedCreditsExpr` (`:28-31`).
- The statement's fallback (`lib/statements.ts:214`).
- The cap baseline before a new job is admitted (`lib/generationRequests.ts:502`).
- The cap reader (`lib/caps.ts:89`).

So a change to the margin table today silently reprices every take made before metering, on statements, usage and caps. The comment at `lib/creditSql.ts:3-4` says this must not happen.

**The fix: freeze the figure once, then never compute it again.**
1. **A new workspace table, `estimated_credits`** (M2 below):

   ```
   estimated_credits (gen_id TEXT PRIMARY KEY, credits INTEGER NOT NULL, frozen_at INTEGER NOT NULL)
   ```
   
   It is additive. Nothing existing changes shape.
2. **It is filled once per workspace,** the first time it is needed, guarded by a one-row marker table. This is the pattern the platform uses for its receipts copy (`meter_credit_receipt_migrations`, `lib/platform.ts:192-197`). The marker and the rows are written in one batch, so a fill either lands whole or not at all, and runs again on the next read. The fill is one `INSERT … SELECT` over `generations`, using **today's** `historicalCreditsExpr`, so every figure a customer sees today is kept exactly. It covers only takes that are certainly from before metering:
   - the take has no row in `credit_receipts`, after a full `syncCreditReceipts()` first; **and**
   - the take is older than this workspace's first meter event (`MIN(created_at)` in `meter_events WHERE workspace_id = ?`, read from the platform database before the fill). For a workspace with no meter events at all, that means all of its takes.
   
   A new take whose receipt has not synced yet can never be frozen by mistake, because it is newer than the first meter event.
3. **All four readers read the frozen figure instead of computing one:**
   - `billedCreditsExpr` becomes `COALESCE(receipt, (SELECT credits FROM estimated_credits WHERE gen_id = …), 0)`;
   - the statement, the cap baseline and the cap reader use one helper, `estimatedCreditsFor(ids)`.
   
   `historicalCreditsExpr` is then used only by the one-time fill, and is renamed to say so (`freezeEstimatesSql`). No reader can reach today's margins for an old take any more.
4. **`estimated: true`** means the take has a row in `estimated_credits`. The export gets an `estimated` column, the API an `estimated` field, and statements mark such lines "estimated" in words (the wording waits for v18 where it is on a screen).

**Rollback.** The previous release ignores the table and goes back to computing at today's margins: the behaviour it already has. Rolling forward again reads the frozen rows, untouched. No balance, receipt or meter row is written.

**A simpler option that was not chosen.** Read a frozen margin table from a new private setting (for example `HISTORICAL_CREDIT_MARGINS`) instead of `margins()`. It needs no table. But the frozen figure would then depend on a setting staying exactly right forever, and on the `0.10` written into `lib/creditSql.ts:22`. The table freezes the numbers themselves.

### Consistency on refunds and overruns
- **A refund** (settle at 0) or a correction is a new receipt revision. The take shows it after the next sync. No new code is needed. A test proves it end to end for the helper.
- **An overrun** never changes `billed_credits` (`lib/meter.ts:26-36`). So the take shows what the person approved, and the platform's absorbed cost stays on the admin desk only.
- **The quote snapshot is never updated.** It records what was promised, so "quoted vs charged" stays honest.

### Who reads it
- **Library and jobs API:** `creditsBilled` as today, plus `final` and `estimated`.
- **CSV export:** `credits`, plus `credits_quoted` and `estimated`.
- **Statements:** they read the meter, which is the source of truth. Their fallback for pre-metering takes reads the frozen figure (above).
- **MCP:** `get_render` and `wait_for_render` add the quote.
- **Price wording follows rule 14:** `N cr`, `up to N cr`, or `free`. A vendor cost never reaches a customer. The new fields must pass `tests/unit/noVendorCostToCustomers.spec.ts`.

### Tenant isolation
- The receipt sync filters on `workspace_id` (`lib/creditReceipts.ts:16`).
- The quote is in the take's own row.

---

## 5. Migrations

There are **two** migrations, both in each workspace's own database. They ship only after the owner's backup (docs/backup-restore.md), in a migration deploy, never mixed into an ordinary one.

| # | What | Additive? | Safe to roll back? |
|---|---|---|---|
| M1 | `CREATE TABLE IF NOT EXISTS take_review_events` and its index `(gen_id, created_at)` | Yes: a new table. No existing row or column is touched. No backfill. | Yes. The previous release never reads it. Events written before a rollback stay valid. Reviews made during a rollback have no event; they read "not recorded", and their names are still in the old columns. |
| M2 | `CREATE TABLE IF NOT EXISTS estimated_credits`, plus its one-row marker table, then the one-time fill of pre-metering takes at today's figures | Yes: new tables. Nothing existing is rewritten. No meter, receipt or balance row is written. | Yes. The previous release ignores both tables and computes at today's margins, as it does now. Rolling forward again reads the frozen rows, untouched. |

- **Items 1, 1b and the quote add no schema.** `params.job`, `params.shotType` and `params.quote` are server-written keys in existing JSON. A previous release ignores them, and rolling back only stops new takes getting them.
- **No migration touches the platform database.** M2's fill only reads it (the workspace's first meter event).
- **Tests:** `tests/unit/schemaInitialization.spec.ts` and `schemaColumnRace.spec.ts` gain cases for both tables. Nothing in them is changed or removed.

## 6. PRs, re-cut after the owner's answers (about 47 h of Sonnet lane time)

In order. "Opus" marks the PRs that need the Opus review (money or privacy) before merging.

| # | PR | Size | Review | After |
|---|---|---|---|---|
| 1 | `lib/rejectReasons.ts` and `lib/takeJob.ts`: the closed lists (reject reasons, job, shot type), their labels and the chip map. Pure, no schema. | S, 3h | — | — |
| 2 | **Approving a take is people-only:** `PATCH /api/jobs/[id]` refuses `approved`, and clearing an approval, for a token, an MCP client or `agent:*` (403, `PEOPLE_ONLY`, nothing written); picking and rejecting unchanged. No schema. | S, 3h | **Opus (privacy)** | — |
| 3 | **M2 + the freeze:** `estimated_credits`, the one-time fill, and all four readers (`lib/creditSql.ts`, `lib/statements.ts:214`, `lib/generationRequests.ts:502`, `lib/caps.ts:89`) read the frozen figure; `estimated` flag | M, 8h | **Opus (money)**, migration, NEEDS OWNER | backup |
| 4 | Job label: `jobOf` at every take insert, `jobOfRow` for old takes, `?job=` filter, left out of the quote fingerprint | M, 6h | — | 1, #706 |
| 5 | Shot type: `shotTypeOf` at every take insert, `shotTypeOfRow` for old takes (certain cases only), `?shotType=` filter, left out of the fingerprint | M, 6h | — | 4 |
| 6 | **M1:** `take_review_events`; the PATCH writes the mark, the event (with `via`) and the note in one transaction; reasons optional on the server; the system clear writes an event | M, 8h | **Opus (privacy)**, migration, NEEDS OWNER | 1, 2, backup |
| 7 | Reads: who picked and approved, from events, masked (`supportMemberId`); MCP `review` field | S, 4h | **Opus (privacy)** | 6 |
| 8 | `takeCredits()` helper (receipt, frozen estimate, final) used by Library, export and MCP | S, 3h | **Opus (money)** | 3 |
| 9 | `params.quote` snapshot at admission; MCP and export show the quote | S, 4h | **Opus (money)** | 8 |
| 10 | CSV export columns: `job`, `shot_type`, `picked_by`, `approved_by`, `reject_reasons`, `credits_quoted`, `estimated` | S, 2h | — | 4, 5, 7, 9 |
| 11 | Board and Make wiring: the reject panel sends codes; Make and Campaign Formats send `templateId`; the versions card and Library show job, shot type and reasons | — | **waits for Claude Design / v18** | 5, 6 |
| 12 | Auto routing on `(shotType, job)`: the platform-layer rule table (described in item 1b) | — | later; a plan of its own, after Step 0 has data | 5, 10 |

PRs 3 and 6 are the migration deploy: one backup covers both.

**Guard tests: added to, never weakened.**
- `tests/unit/platformOwnerPrivacy.spec.ts`: new cases. The owner's pick or approval reads "Particl support" in a client workspace and their name in the house workspace. No raw owner account id appears in any reply.
- `tests/unit/noVendorCostToCustomers.spec.ts`: the new money fields (`quote`, `estimated`) pass the scanner.
- `tests/unit/creditReceipts.spec.ts` and `creditSql.spec.ts`: new cases.
  - `takeCredits` follows a refund and a restatement.
  - **Changing `CREDIT_MARGINS` after the freeze changes no estimated figure** on takes, usage, statements or caps.
  - A take newer than the first meter event is never frozen.
- `tests/unit/workAccess.spec.ts`: unchanged. Its approvals are by people (`:150`, `:159`). The refusal tests for tokens and agents are new cases in a new spec. I found no existing spec that has a token approve a take; if the PR finds one, it stops and shows the lines to the owner.
- `tests/unit/neverDelete.spec.ts`: unchanged. Events and estimates are only ever added.
- `tests/helpers/uiStrings.ts`: the new labels use no retired word.

**Mocked tests that prove an agent can use it (rule 11):**
- An MCP token rejects a take with codes, and the event records `via = token`.
- An MCP token's approval is refused, and nothing is written.
- An Atomik step's take carries its job and shot type.
- No engine is called anywhere in this plan.

## 7. Owner questions

**Answered (14 Oct):**
- Job label: A, the purpose, plus a shot type.
- The reject list as proposed.
- No id backfill.
- Approving is people-only.
- The quote snapshot.
- Reasons optional on the server, required on the board.
- The board wiring waits for v18.
- Pre-metering takes are `estimated` and never repriced.

**New:**
- **A. The key's name.** `params.shotType` (recommended) or `params.shot`? In the code, `shot` already means shot size (`params.shotSpec.shot`; the composer's Shot chip). A second `shot` would mean two things.
- **B. The shot-type list** (item 1b), 13 codes. Three types the owner named are not in the code today, so their rules are new:
  - **face close-up:** shot size plus a cited character;
  - **pack shot:** only templates;
  - **product reveal:** only a template beat and a format.
  
  Confirm or edit the list. **Recommended:** accept it as is, and add types only with a rule that can set them.
- **C. How to freeze pre-metering figures:** the `estimated_credits` table (recommended; it freezes the numbers), or a private setting that freezes the margin table instead (no migration, but the figures then depend on a setting staying right forever).
