# Status now: 7 October 2026, 17:07 IST, Release 1 lead moved to "contabo"

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. Thursday 8 Oct: merge train on the owner's "go". Friday 9 Oct: demo.

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
- On "contabo", 3ca30197: typecheck clean; unit 3,950 passed, 3 failed (the same three), 7 skipped.
- Fix lanes running since 16:20, one branch each, merged into `release/1` only after a fresh review (Opus where money, sign-in or tenancy):
  - `fix/r1-ci-worker-probe-env`: stops `workerProbe.spec.ts` leaking deployment settings into other specs.
  - `fix/r1-ci-make`: the Make composer specs (prices, batches, model picker).
  - `fix/r1-ci-settings`: Settings, credits, no vendor dollars, retired connected account.
  - `fix/r1-ci-board`: board, phone, Guest Home off, spend buttons, recovery race.

## In flight
| Branch | State |
|---|---|
| 3D blocking B (`build/gaps-l2`) | Brought up to date: 44cda874 (3 import/ratchet conflicts; tsc clean; its unit specs 112 pass; browser spec passes at 1440 and 390). Opus delta review PASS at 44cda874 (one low: the sample shows Remake disabled with its price; follow-up after merge). Merges only after Q7 |
| CI fixes on `release/1` | four lanes, above |

## Waiting on the owner
1. The signed-in price check on the preview: Motion transfer and Object swap at 6 s, 720p (about 62 cr).
2. Does Preview run with mocked engines, or with no engine keys?
3. Sample lift: allow the plan's fixes after the last take lands, or end the lift at once?
4. Platform-owner privacy: yes or no to a one-off, dry-run-first rewrite of old records in client workspaces.
5. Customer test 3 (an old-shell test, skipped): delete it?
6. Q7: the preview runs on staging. OK to put 3D blocking B into `release/1` once its re-check passes?

## Machine
"contabo": 18 cores, 94 GB; agents capped at 12 cores and 64 GB. Up to 6 heavy jobs at once through `~/ops/heavy.sh` at low priority; full suites run in CI.
