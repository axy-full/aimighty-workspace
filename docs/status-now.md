# Status now: 7 October 2026, 17:41 IST, Release 1 lead moved to "contabo"

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. **Demo postponed (owner, about 17:30 IST); no date yet. The Thursday merge train is cancelled. Nothing merges to main and nothing deploys to production without the owner's "go".**
Order of work: (a) CI on `release/1` fully green; (b) finish the Thursday list's AT RISK and WON'T MAKE IT items, with an estimate per item; (c) move prep for Coolify on a test address, files only. Then a proposed demo date and the `release/1` → main plan.

**Lead:** the session on "contabo" took over from the "vps" session at about 15:50 IST. Deny rules checked: `git restore` and `docker ps` are both refused.
**Integration preview:** `release/1` (draft #546) = 4b116e17. The preview is mocked: no engine keys, ENGINE_MOCK set. The preview runs on the staging databases.

## In `release/1` since 15:00
- 3D blocking part B (`build/gaps-l2` 44cda874, Opus PASS; owner yes to Q7: staging only, production only in a later train after a Turso backup branch).
- `fix/r1-ci-worker-probe-env` (Opus PASS).
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
  - `fix/r1-ci-board`: board, phone, Guest Home off, spend buttons.
  - `money/r1-make-stale-claim` (Opus): see the money finding below.

## Money finding (CI lane, 17:30)
In the new Make panel, a tab whose reply was lost can send a second paid request after another tab already settled the first, if the person presses Make again in the first tab. The old `recovery-race` spec forbade this. An Opus lane is confirming it and preparing a fix: the first tab checks its own lost request before sending again. The owner said yes (17:40): a tab checks its lost request before sending again.

## In flight
| Branch | State |
|---|---|
| CI fixes on `release/1` | lanes above |
| Release 1 remaining list | sent: `docs/r1-remaining.md` (this branch). Owner: list B in, list C out |
| `ops/selfhost-test-address` | move prep, files only (Dockerfile, scheduled jobs, storage, env NAMES, health, smoke test). "selfhost" in names: the deny rule stays |
| image-ad variants (list B) | next free slot |
| `fix/r1-blocking-sample-remake` (on top of B) | the sample hides Remake's priced button; building |

## Owner's answers (17:40)
Scope: list B in (image-ad variants; phone gets "Open this on a larger screen" now, frames later); list C out. Stale-tab fix: yes. Q7: yes. Dunes: v4 at 233 cr in "Particl sample"; "Particl demo" for live presses only, capped at 100 cr, cheap engines only; nothing generates without the owner's "run". Price check on production after a merge. Sample lift ends with the run. Privacy rewrite: yes after the owner sees dry-run counts and a Turso backup copy. Q4/Q5: yes.

## Waiting on the owner
1. Yes before main on the reviewed work already in `release/1`: #556 money states, #540/#559 Cinema, sample paid-off, old pages (#558 has its yes).
2. Customer test 3 (`tests/customer.spec.ts:568`, skipped because it drives the old shell): checks that an unsaved project edit is saved in the current workspace before a workspace switch, and that a refused switch leaves the project editable. Recommended: port these two checks to the new switch in Settings › Team, then delete the old test. Delete on the owner's "go".

## Machine
"contabo": 18 cores, 94 GB; agents capped at 12 cores and 64 GB. Up to 6 heavy jobs at once through `~/ops/heavy.sh` at low priority; full suites run in CI.
