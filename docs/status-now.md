# Status now: 7 October 2026, 17:31 IST, Release 1 lead moved to "contabo"

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. **Demo postponed (owner, about 17:30 IST); no date yet. The Thursday merge train is cancelled. Nothing merges to main and nothing deploys to production without the owner's "go".**
Order of work: (a) CI on `release/1` fully green; (b) finish the Thursday list's AT RISK and WON'T MAKE IT items, with an estimate per item; (c) move prep for Coolify on a test address, files only. Then a proposed demo date and the `release/1` → main plan.

**Lead:** the session on "contabo" took over from the "vps" session at about 15:50 IST. Deny rules checked: `git restore` and `docker ps` are both refused.
**Integration preview:** `release/1` (draft #546) = ac03f878. The preview runs on the staging databases.

## In `release/1` since 15:00
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
  - `fix/r1-ci-worker-probe-env` @ e5edf11b: Opus PASS; stops `workerProbe.spec.ts` leaking deployment settings into other specs. Merges with the next batch (so the running CI isn't cancelled).
  - `fix/r1-ci-make`: the Make composer specs (prices, batches, model picker).
  - `fix/r1-ci-settings`: Settings, credits, no vendor dollars, retired connected account.
  - `fix/r1-ci-board`: board, phone, Guest Home off, spend buttons.
  - `money/r1-make-stale-claim` (Opus): see the money finding below.

## Money finding (CI lane, 17:30)
In the new Make panel, a tab whose reply was lost can send a second paid request after another tab already settled the first, if the person presses Make again in the first tab. The old `recovery-race` spec forbade this. An Opus lane is confirming it and preparing a fix: the first tab checks its own lost request before sending again. Owner question 7 below.

## In flight
| Branch | State |
|---|---|
| 3D blocking B (`build/gaps-l2`) | Brought up to date: 44cda874 (3 import/ratchet conflicts; tsc clean; its unit specs 112 pass; browser spec passes at 1440 and 390). Opus delta review PASS at 44cda874 (one low: the sample shows Remake disabled with its price; follow-up after merge). Merges only after Q7 |
| CI fixes on `release/1` | lanes above |
| Release 1 remaining list | audit running: state, what's left, estimate per item |
| `fix/r1-blocking-sample-remake` (on top of B) | the sample hides Remake's priced button; building |

## Waiting on the owner
1. The signed-in price check on the preview: Motion transfer and Object swap at 6 s, 720p (about 62 cr).
2. Does Preview run with mocked engines, or with no engine keys?
3. Sample lift: allow the plan's fixes after the last take lands, or end the lift at once?
4. Platform-owner privacy: yes or no to a one-off, dry-run-first rewrite of old records in client workspaces.
5. Customer test 3 (an old-shell test, skipped): delete it?
6. Q7: the preview runs on staging. OK to put 3D blocking B into `release/1`? (Its re-check passed: 44cda874, Opus PASS.)
7. Make: a second press in a tab that lost its reply should check that request first and send nothing if it already landed (recommended), rather than send a new paid request. Yes?

## Machine
"contabo": 18 cores, 94 GB; agents capped at 12 cores and 64 GB. Up to 6 heavy jobs at once through `~/ops/heavy.sh` at low priority; full suites run in CI.
