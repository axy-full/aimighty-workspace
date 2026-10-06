# Review of PR #558: security/gaps-l5 at 10c1e8c, base release/1

This was a fresh, independent, read-only review. I did not commit, push, comment or merge anything.

- **Worktree:** `work/rev-558`, detached at `origin/security/gaps-l5` = 10c1e8c01a199c52ef1d1250a34212c9bdd050ad.
- **Probe spec:** `work/rev-558/tests/unit/probe-558-review.spec.ts`. It exists only in the review worktree and is not part of the PR. It has 6 probes and all 6 pass, which confirms each finding below.

## VERDICT: FAIL

There is 1 High and there are 2 Medium findings. The route guards the PR claims are real and hold up under probes: people-only routes, the prepare-token gate, and the client link's scoping. The failures come from three things: compatibility with older builds, a gap in the consent check, and where the consent recording is stored.

---

## Findings

### HIGH

**H1. A `prepare` token becomes an uncapped spending token on any older build (rollback, or a shared database).**
- **The code:**
  - The scope is stored as the word `prepare` in each workspace's `api_tokens.scope` (`app/api/tokens/route.ts:104`, insert at `:116-118`).
  - A prepare token is stored with no ceiling. `lib/tokenCeiling.ts:59` and `:64` keep a ceiling only for `render`. `lib/shell/tools-connections.ts:252` sends none for `prepare`.
  - The base build reads every scope except `read` as `render`. `git show origin/release/1:lib/auth.ts` line 205 is `scope: row.scope === "read" ? "read" : "render"`, and the same line is on `origin/main`.
- **Scenario:** a person makes a "Prepare jobs" token and hands it to an outside agent. Then either release/1 is rolled back, or an older deployment opens the same workspace database (production main, or another preview on the same Turso databases). Every prepare token then authenticates as `render` with no monthly ceiling. Through MCP `render_shot`, `/api/generate`, Crew rounds and Rig runs, the outside agent can spend with no person approving.
- **Fix:** pick one of these.
  - (a) Keep `api_tokens.scope = 'read'` for prepare tokens and record the prepare grant in its own additive table or column. Old builds then see a read-only token.
  - (b) Ship the reader change ("unknown → read", `lib/auth.ts:205-206` here) to main and release/1 alone first. Allow minting `prepare` only after every live build reads it safely.
- **Also:** add a release note saying that rolling back past this PR requires revoking all prepare tokens.

### MEDIUM

**M1. The check that consent is "for this production" is skipped when the training request names no production. The cast member and the allowed uses are never checked.**
- **The code:**
  - `app/api/soul/identities/route.ts:69-70` calls `consentForTraining(body.consentId, await projectKeysFor(body.projectId, …))`.
  - `projectKeysFor` returns `[]` when `projectId` is absent (`lib/security/consent.ts:161`).
  - `consentForTraining` runs the production check only `if (ids.length && …)` (`lib/security/consent.ts:152-153`).
  - `CreateSoulIdentityInput.projectId` is optional (`lib/soulIdentities.ts:386`).
- **Probes:**
  - P1: a record for `prod_one` is accepted with `[]`.
  - P5, through the real route: `POST /api/soul/identities {consentId}` with no `projectId` returns 202, and the paid call is made.
- **More gaps, same function:**
  - The record's `subjectKey` (whose face) is never compared with what is being trained, so one cast member's consent arms training of another.
  - A record whose uses are only "ads" (not "this production") arms training.
  - A request without `consentId` still trains: P5's second call returns 202. Any record is enforced only by the Cast card's UI.
- **Fix:**
  - In `consentForTraining`, refuse when no production key resolves.
  - Pass and compare the subject (cast card id) and require `uses` to include `production`.
  - Decide with the owner whether the server must require a live record for every new likeness training. Today the older pages still use the tick-box.

**M2. The consent recording (the person's voice or face agreeing) can be read by any API or MCP token, including read-only and prepare tokens. It also sits in the workspace library.**
- **The code:**
  - `ConsentForm.tsx:54` stores the recording as an ordinary upload with kind `"chat"`.
  - `GET /api/uploads` (`app/api/uploads/route.ts:32-40` uses `requireUser`, so tokens get through) lists every upload with no filter (`lib/uploadLibrary.ts:30-56`).
  - `GET /api/uploads/<id>` (`app/api/uploads/[id]/route.ts:29-40`) serves it to any token.
  - The consent routes themselves are session-only. `lib/security/consent-words.ts:62` claims the recording is "signed in, this workspace only", which is not true.
- **Probe P6:** a prepare token's `GET /api/uploads` returns the consent recording `upl_voice`.
- **Scenario:** an outside agent holding a read or prepare token lists the library and downloads a real person's consent video or voice. A member can also pick it as a reference in Make, which sends it to an engine.
- **Fix:**
  - Store recordings with their own kind or flag.
  - Exclude them from library listings and pickers.
  - Serve them only through a session-only route that checks the consent record (for example `GET /api/identity-consents/<id>/recording`).

### LOW

**L1. Older review links are not "unchanged".**
- Every older link is now rate limited: 300 reads and 30 comments per link per 10 minutes (`app/api/review/[token]/route.ts:28`, `notes/route.ts:27`, `media/[genId]/route.ts:35`).
- Opening one creates the new tables in that workspace. Probe P3.

**L2. Clients on different links to the same production see each other.**
- Each client sees the others' names, comments and decisions. `reviewSet` unions `review_notes` and `review_verdicts` across every link of the production (`lib/security/review-link.ts:113-122`). Probe P3.
- The team's internal notes on takes waiting for review are also shown to the client, signed "The production" (`:115`).
- **Fix:** filter by `share_id`, or confirm with the owner that this is intended.

**L3. A leaked link can lock the real client out for 10 minutes.**
- The counter goes up before anything is served (`review-link.ts:63-72`).
- `review_link_hits` is never pruned, so it grows by one row per link per 10 minutes per kind.

**L4. A client link can fall back to the older view, which shows prompts and team names.**
- Making a client link is two writes: `mintShare` in the platform database, then `markReviewLink` in the workspace database (`app/api/review-links/route.ts:53-54`).
- If the second write fails, or the build is rolled back, the `rv_` link opens the older view. That view returns each take's prompt and the approver's name (`app/api/review/[token]/route.ts:38-75`).
- **Fix:**
  - Write the scope first and the link second, or revoke the share if marking it fails.
  - Note the rollback behaviour.

**L5. Minting a token with an absent or unknown scope still makes a `render` token** (`app/api/tokens/route.ts:104`).
- It is session-only, but "only the word itself grants spending" holds only when a token is read, not when it is made.
- **Fix:** make a missing scope mean `read`, or refuse it.

**L6. The 50-job limit per prepare token can be overrun.**
- `WAITING_LIMIT` is a count followed by an insert, not one atomic step (`lib/security/prepared-jobs.ts:65-72`). Concurrent calls can go past 50.
- Low impact, because nothing is spent.

**L7. Two older screens mislabel a prepare token.**
- The older Tokens page shows it as "Can generate" (`components/Tokens.tsx:118`).
- Atomik's ToolsView marks it "available" (`components/graphite/atomik/ToolsView.tsx:277`).

**L8. Gaps from before this PR remain open (found by the grep in check 4; this PR did not introduce them).**
- `POST`/`DELETE /api/workspaces/topups` accept an admin's API token (`requireUser` plus a role check, `app/api/workspaces/topups/route.ts:42-47`). The token files a top-up request and starts checkout. No money moves until a person pays or the platform answers.
- `PATCH /api/jobs/[id]` lets a render token set a take to approved or picked (`app/api/jobs/[id]/route.ts:55-75`). With this PR, that also puts the take in front of a client link.
- Older "Can generate" tokens still spend everywhere within their ceiling, which is contrary to "tokens prepare only".

**L9. One neighbouring browser spec is flaky.**
- `tests/demo-s05-cast-workbench.spec.ts:76` failed once at 1440x900 when the dev server reloaded the page mid-test (Make's prompt was empty). It passed on 2 reruns.

---

## Claims checked against the code

### 1. Client review links

| Claim | Result |
|---|---|
| Production comes from the stored link | Holds: `shares.ts:60-70`, `review-link.ts:100-110` |
| The set is finished, not deleted, and Approved or `picked` | Holds: `review-link.ts:77-84` |
| Media by a guessed id | Refused: `media/[genId]/route.ts:35-38` |
| Other workspaces | Refused: each database is per workspace |
| Prompts, people and balances | Not read |
| Writes | Only a decision or comment on a take in the set, and only from new links (`verdict/route.ts:20-22`, `review-link.ts:146-158`). The team's `review_state` is never written. |
| Secret | `rv_` plus 32 random bytes (256 bits, `shares.ts:36`). Stored as a hash and looked up by hash (`shares.ts:63`), so no compare-time leak. Expires in 30 days. Revoke is scoped to the workspace. |
| Link secret used as an API token | Refused: `callerFromToken` needs `pk_` or `aw_` and `api_tokens` (P2) |
| API token used as a link | Refused: `p_shares` lookup only |
| Enumeration | Not feasible |
| Rate limits | Real across instances, because the counter is in the workspace database |
| Who can make or withdraw links | Session-only, owner or admin (`review-links/route.ts:46-69`, `shares/route.ts:21-37`) |
| CSRF on the signed-out write | Not applicable: no cookie is involved, and the secret in the path is the credential |
| Referrer-Policy | `strict-origin-when-cross-origin` (`next.config.ts:23`) |
| Exceptions | L1–L4 |

### 2. Consent

| Claim | Result |
|---|---|
| Read and write are session-only; tokens of every scope refused | Holds: `identity-consents/route.ts:21-42`, `[id]/route.ts:11-22` |
| The library refuses agents, disabled people and tokens | Holds: `people-only.ts:22-28`, `consent.ts:107`, `:129` |
| Records are never erased | Holds: withdrawing only marks `revoked_at`/`revoked_by` |
| Other workspaces see nothing | Holds: per-workspace database |
| A security-history receipt with no name | Holds |
| The 54 cr shown is the server's figure | Holds: it comes from `terms.trainingCredits` and `version.trainingCredits` |
| "Nothing billed" appears only when the ledger shows 0 | Holds: `identity-card.ts:42-46` |
| The check happens before anything is sent | Holds: `consentForTraining` runs before `createSoulIdentity`. The idempotency claim reserves no money. |
| Exceptions | M1, M2 |

### 3. Prepare tokens

| Claim | Result |
|---|---|
| The write gate in `withTenant` runs before every handler and allows only POST with `preparedJobs` or `mcpTransport` | Holds: `lib/auth.ts:239-240`. Probe P2: PATCH, PUT and DELETE on an opted-in route are refused, and the opt-in for read tokens does not admit a prepare token. |
| The opt-in list is closed | Holds: only `app/api/prepared-jobs/route.ts:32` and `app/api/mcp/route.ts:81` |
| Routes outside `withTenant` | None take bearer tokens: auth, admin (super-admin), the review links, and the Higgsfield consumer routes. `workbench/uploads` re-exports the wrapped `/api/uploads`. |
| MCP tools cannot spend through the transport | Holds: they re-enter the app over HTTP with the same bearer (`lib/mcp.ts:172-180`), so `render_shot` → `/api/generate/quote` and `/api/generate` and `create_project` → `/api/projects` are refused by the gate. |
| Crew MCP | A separate `crewmcp_` path |
| `requireRender` refuses prepare tokens | Holds: `auth.ts:325` |
| Unknown stored scope reads as read-only | Holds: P2, `RENDER` → read |
| "Open in Make" is a real person approval | Holds: it marks the job and pre-fills Make. Make prices it through the server quote, and the person's press is the paid path (`ConnectionsSection.tsx:190-202`). |
| Token secret never stored or logged | Holds: hash only, and no new logging |
| Exceptions | H1, L5, L6 |

### 4. Closed gaps

- Release (`jobs/[id]/release/route.ts:26-27`), the Atomik step claim (`atomik/steps/[id]/claim/route.ts:26-27`), `soul/identities` (`:62-63`) and `identities/[id]/train` (`:42-43`) all refuse every token. Holds.
- `/api/shares` POST and DELETE use `requireSession`. Holds.
- The control room's approvals, pipelines' approve, team-canvas approve and raise-limit, settings, rules, ledger-checks and keys were already session-only, admin-only or owner-only.
- Remaining gaps: L8.

### 5. New tables

- All are `CREATE TABLE/INDEX IF NOT EXISTS`, made on first use in each workspace's own database, with init promises per client. That makes them safe if created concurrently.
- The diff adds no DROP, DELETE or ALTER, and no new platform-database schema. Only existing `p_shares` rows are written.
- An old build ignores the tables. The exceptions on rollback are H1 and L4.

### 6. Team

- `twoStep` comes from `account_security.enabled_at` (primary key `account_id`, so the join cannot duplicate rows). The route is `requireAdmin`, which is session-only (`app/api/team/route.ts:22-61`). It adds a yes/no only, and no other data.
- The Roles section lists Owner, Admin and Member only (`components/graphite/settings/model.ts`, `ROLES`). Counts appear on the owner's view only.

### 7. Gates, run here on a fresh review worktree

- **tsc:** clean (exit 0).
  - The `node_modules` in `ci-checks` is stale: no `@xyflow/react`, and its lockfile differs. I used `d0-main-check/node_modules` instead, whose `package-lock.json` is identical to this branch's.
- **Unit tests:** 56/56 passed. Files: `demo-gaps-l5-consent`, `demo-gaps-l5-client-link`, `demo-gaps-l5-tokens`, `atomikNoAccount`, `demo-s10-phone-model`, `identityTraining`, `reviewLinks`, `toolsConnections`. Command: `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 … --project=unit --workers=1`.
- **Review probes:** 6/6 passed. Each one confirms a finding (P1–P6).
- **Lane-5 browser specs** at `workbench-1440x900` and `workbench-390x844`: 9 passed, 3 skipped by design (desktop-only or phone-only).
  - Setup: a fresh mock server (`mock-server.py`, name `rev558`, port 4981, slot-5, now stopped and released), with `PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/rev558/platform.db`.
  - Turbopack refuses a symlinked `node_modules`, so the server ran in webpack mode.
  - No Playwright browsers are cached on this machine, so I used `PW_CHANNEL=chrome`.
- **Neighbour specs** (`demo-s05-cast`, `demo-s09-settings`): 18 passed and 1 flaky, which passed on rerun (L9).

---

## Needs the owner's yes

Each line is a behaviour change.

- API and MCP tokens of every kind, even an admin's "Can generate" token, can no longer train an identity (both training routes).
- API and MCP tokens can no longer release a held take or claim an Atomik step; only a signed-in person can.
- API tokens can no longer make or withdraw client review links on the older Shares route; only a signed-in owner or admin can.
- A new kind of token, "Prepare jobs", lets an outside agent queue a shot for a person to approve. It is the default in Settings, and Settings no longer offers "Can generate" (older pages and the CLI still can).
- Before any "Prepare jobs" token is made, decide how to keep it from becoming a spending token if the release is rolled back or an older build shares the database (H1).
- A stored token kind the code doesn't recognise now counts as read-only instead of "can spend".
- Any team member can see the queue of prepared jobs and open or dismiss any of them; dismissed jobs are kept.
- On the board, training a character's identity now needs a recorded consent first. The older pages still train with the tick-box, and the server does not require a record (M1).
- Any team member can record a consent. The person who recorded it, or an owner or admin, can withdraw it. Records are never deleted.
- The consent recording is saved as an ordinary workspace upload. Today that means API tokens and the library can see it (M2).
- New client links open the takes waiting for review as well as the approved ones. The client can approve or ask for changes and comment, and the team still makes the real approval.
- Clients on different links to the same production see each other's names, comments and decisions, plus the team's notes signed "The production" (L2).
- Older client links now have the same per-link limits: 300 opens and 30 comments per 10 minutes (L1).
- Owners and admins now see whether each person has two-factor on. A new Roles section lists Owner, Admin and Member with counts. Member rows show a role only on the owner's view.
- Five new tables are created on first use in each workspace's own database: `identity_consents`, `review_link_scopes`, `review_verdicts`, `review_link_hits` and `prepared_jobs`.
