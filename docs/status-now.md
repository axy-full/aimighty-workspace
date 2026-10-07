# Status now: 7 October 2026, 16:25 IST, Release 1 lead moved to "contabo"

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. Thursday 8 Oct: merge train on the owner's "go". Friday 9 Oct: demo.

**Lead:** the session on "contabo" took over from the "vps" session at about 15:50 IST. Deny rules checked: `git restore` and `docker ps` are both refused.
**Integration preview:** `release/1` (draft #546) = 3ca30197. The preview runs on the staging databases.

## In `release/1` since 15:00
- Platform-owner privacy (`fix/r1-platform-owner-private`, delta review PASS) and its follow-up (`fix/r1-owner-privacy-followup`).

## CI on `release/1`
- No full CI run has finished since yesterday: each merge cancelled the run before it. Run 37604935678 on 3ca30197 is the first to run through.
- Already failing in that run:
  - unit: 3 tests in `platformOwnerPrivacy.spec.ts`. The follow-up's new "production only" guard refuses the tests' local run (they don't set the opt-in).
  - browser: Make (batch takes, model picker, Grok voices), credits shown on phone, no-vendor-dollars pages, Settings at 360 px, Guest Home off, three recovery-race tests.
- Next: split the failures into fix lanes once the run ends (about 16:45). Money and sign-in fixes get an Opus review before they merge.
- On "contabo": typecheck on 3ca30197 is clean. The local unit run is in progress.

## In flight
| Branch | State |
|---|---|
| 3D blocking B (`build/gaps-l2`) | PASS at 4d24cc2e. Being brought up to date with `release/1` and re-checked now. Merges only after Q7 |
| CI fixes on `release/1` | starting after the run ends |

## Waiting on the owner
1. The signed-in price check on the preview: Motion transfer and Object swap at 6 s, 720p (about 62 cr).
2. Does Preview run with mocked engines, or with no engine keys?
3. Sample lift: allow the plan's fixes after the last take lands, or end the lift at once?
4. Platform-owner privacy: yes or no to a one-off, dry-run-first rewrite of old records in client workspaces.
5. Customer test 3 (an old-shell test, skipped): delete it?
6. Q7: the preview runs on staging. OK to put 3D blocking B into `release/1` once its re-check passes?

## Machine
"contabo": 18 cores, 94 GB; agents capped at 12 cores and 64 GB. Up to 6 heavy jobs at once through `~/ops/heavy.sh` at low priority; full suites run in CI.
