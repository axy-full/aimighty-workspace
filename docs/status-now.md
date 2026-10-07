# Status now: 7 October 2026, 20:31 IST, Release 1 lead moved to "contabo"

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. **Owner, 18:45: move off Vercel today if possible.** Report on Vercel dependencies, env names, sign-in/URL needs, the particl.app redirect and Nixpacks sent in chat. The sign-in fix is in release/1 for the owner's test (applies to main too; main only on the owner's go). Before production: the public-link fix (running), AI_GATEWAY_API_KEY, the VERCEL_ENV guards, Traefik's read timeout. The reported home-page loop was not reproduced on main or release/1 and is withdrawn; a loop on the test address would come from a layer in front of the app.

**Demo postponed (owner, about 17:30 IST); no date yet. The Thursday merge train is cancelled. Nothing merges to main and nothing deploys to production without the owner's "go".**
Order of work: (a) CI on `release/1` fully green; (b) finish the Thursday list's AT RISK and WON'T MAKE IT items, with an estimate per item; (c) move prep for Coolify on a test address, files only. Then a proposed demo date and the `release/1` → main plan.

**Lead:** the session on "contabo" took over from the "vps" session at about 15:50 IST. Deny rules checked: `git restore` and `docker ps` are both refused.
**Integration preview:** `release/1` (draft #546) = c5422537. The preview is mocked: no engine keys, ENGINE_MOCK set. The preview runs on the staging databases.

## In `release/1` since 15:00
- 3D blocking part B (`build/gaps-l2` 44cda874, Opus PASS; owner yes to Q7: staging only, production only in a later train after a Turso backup branch).
- `fix/r1-ci-worker-probe-env` (Opus PASS).
- `money/r1-make-stale-claim` (Opus FAIL, reworked, delta PASS; owner yes): a tab that lost its reply checks that request first and sends nothing if it landed; changed words always send. Found by the CI lane: before this, video sent one extra paid request, image batches the whole batch again, audio one extra.
- `fix/r1-signin-behind-proxy` (Opus PASS; owner yes: release/1 only): behind the proxy, `SELFHOST_BEHIND_PROXY=1` makes every origin check accept exactly APP_ORIGIN; Vercel unchanged. **The owner checks it on the test address next** (https; steps in `docs/selfhost-test.md`).
- PR #561 `ops/selfhost-test-address` (Opus FAIL on the runbook: a plain platform copy names production workspace databases; fixed; delta PASS): Dockerfile, standalone output behind a flag, cron-sync, smoke test, runbook with the staging-set and keyring rules, a check of every workspace address before the scheduled task, Build Variable only on NEXT_PUBLIC_*, the particl.app redirect and DNS for all four names, and what changes when production leaves Vercel.
- `fix/r1-ci-board` (Opus PASS): board, phone, Guest Home off, palette, sample workspace, spend buttons; phone fault buttons 44 px.
- `fix/r1-blocking-sample-remake` (Opus PASS): the sample no longer offers 3D blocking's priced Remake. Optional polish queued: hide the disabled "price pending" button too, and a rendered test.
- Platform-owner privacy (`fix/r1-platform-owner-private`, delta review PASS) and its follow-up (`fix/r1-owner-privacy-followup`).
- `fix/r1-ci-privacy-tests` (Opus PASS): the 3 failing unit tests fixed in the tests only. Cause: `workerProbe.spec.ts` leaves `VERCEL_ENV=preview` set for every later spec, so the guard rightly refused. The guard is unchanged and safe on production.

## CI on `release/1`
- No full CI run has finished since yesterday: each merge cancelled the run before it. Run 37604935678 on 3ca30197 is the first to run through.
- Run 37604935678 on 3ca30197 finished red: 3 unit tests and about 240 browser tests (35 spec files).
  - unit: 3 tests in `platformOwnerPrivacy.spec.ts`. The follow-up's new "production only" guard refuses the tests' local run (they don't set the opt-in).
  - browser: mostly specs still driving the old Gen composer, the old Workspace pane and the retired connected account; plus money specs (no vendor dollars, credit value on phone, batch takes, recovery race, spend buttons) that must be ported, never dropped.
- Run 37615298051 on ac03f878: all 3 unit shards green (first green unit run on `release/1`); browser shards still running.
- On "contabo", 3ca30197: typecheck clean; unit 3,950 passed, 3 failed (the same three), 7 skipped.
- Fix lanes running since 16:20, one branch each, merged into `release/1` only after a fresh review (Opus where money, sign-in or tenancy):
  - `fix/r1-ci-make`: the Make composer specs (prices, batches, model picker).
  - `fix/r1-ci-settings`: Settings, credits, no vendor dollars, retired connected account.

## In flight
| Branch | State |
|---|---|
| CI fixes on `release/1` | lanes above |
| Release 1 remaining list | sent: `docs/r1-remaining.md` (this branch). Owner: list B in, list C out |
| image-ad variants and presets | No frame in the handoff (only one card, one Make at 3 cr). Nothing built. Brief for Claude Design: `docs/design-brief-image-ad-versions.md` (this branch). Logic already in code |
| "Particl demo" cap field (`admin/workspace-cap-field` @ 32994932) | Up to date with release/1. The cap is enforced on the server at the hold for every paid path (new door-by-door spec). Review: every paid path reaches the cap and customers never see it; two mediums being fixed (the no-bypass test could not catch a bypass; the desk's "N CR" beside the cap understates billed credits by the margin). Owner question 7 |
| `fix/r1-public-origin-links` (Opus, gated) | Before production leaves Vercel: password-reset, invite and top-up links never built from request headers; review, share, MCP and OpenAPI links use the public address, not the internal one |
| `fix/r1-review-lows` | Polish: reviewers' lows (sample hides "price pending", tighter spend audit for nav buttons, landscape 44 px, phone Make shows a failed press, old "save first" messages gone) |
| `fix/r1-public-origin-links` (Opus, gated) | Before production leaves Vercel: password-reset, invite and top-up links never built from request headers; review, share, MCP and OpenAPI links use the public address, not the internal one |
| `fix/r1-review-lows` | Polish: reviewers' lows (sample hides "price pending", tighter spend audit for nav buttons, landscape 44 px, phone Make shows a failed press, old "save first" messages gone) |
| `fix/r1-blocking-sample-remake` (on top of B) | the sample hides Remake's priced button; building |

## Owner's answers (17:40)
Scope: list B in (image-ad variants; phone gets "Open this on a larger screen" now, frames later); list C out. Stale-tab fix: yes. Q7: yes. Dunes: v4 at 233 cr in "Particl sample"; "Particl demo" for live presses only, capped at 100 cr, cheap engines only; nothing generates without the owner's "run". Price check on production after a merge. Sample lift ends with the run. Privacy rewrite: yes after the owner sees dry-run counts and a Turso backup copy. Q4/Q5: yes.

## Waiting on the owner
1. Yes before main on the reviewed work already in `release/1`: #556 money states, #540/#559 Cinema, sample paid-off, old pages (#558 has its yes).
2. Customer test 3 (`tests/customer.spec.ts:568`, skipped because it drives the old shell): checks that an unsaved project edit is saved in the current workspace before a workspace switch, and that a refused switch leaves the project editable. Recommended: port these two checks to the new switch in Settings › Team, then delete the old test. Delete on the owner's "go".

3. Self-hosted test address: it needs staging copies of the platform and workspace databases and a staging Blob store. The test address keeps the cron off, so it doesn't run beside Vercel's.

4. Image-ad versions and presets: no design frame exists. The brief for Claude Design is `docs/design-brief-image-ad-versions.md` on this branch. Draw it, or drop the item from Release 1?

5. Atomik's idea draft (a paid 2 cr write; nothing in the app calls it now): does it come back in Release 1, and where (a board card or Atomik's sheet)? Recommended: not in Release 1; its old race test stays marked as waiting.
6. Found while fixing: the phone's Make shows nothing when a press fails. A UI fix is queued (list A).

7. "Particl demo": the cap counts engine dollars, not billed credits, so the real 100 cr wall is a 100 cr credit grant (with the engine cap alongside). Keep the cap at $0 and raise it only on your "run"? "Cheap engines only" doesn't exist yet: a per-workspace engine list needs a platform database migration (your yes), about 1–1.5 days. Do Atomik's text models count too?

## Machine
"contabo" at 20:31: load about 16.5 of 18 cores for 15+ minutes (three mock dev servers, one at 17.5 GB, plus the owner's Coolify build). No new lanes until we are at 4 agents; oversized mock servers are being restarted.
