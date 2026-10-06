# Status now: 6 October 2026, 14:04 IST, Release 1 under way

The scope of work v2 (6 Oct) is `docs/particl-sow.md` (PR #545). Phase 1 (Release 1) is the only thing that merges before the demo. Up to 8 agents. No UI merges until the owner's preview check; no money merge without the owner's yes.

## Merged today
- #541 (npm advisory lockfile fix), #525 (the 5 October handover). main is `a00226e1`.

## Phase 1: Release 1
| Item | Where | State | Next |
|---|---|---|---|
| Integration preview | `release/1`, draft #546 | D0, Make short form, autosave, design round 2, guest Home (off), the sample production and CI checks merged in; the switch deleted; 120 screenshots; screen list written | Full preview with its screen list at 18:00 IST |
| Prices on every spending button | `fix/r1-spend-markers` | 21 files being fixed | Merge into `release/1` |
| Screens not built yet | `build/r1-screen-gaps` | Control-room tabs, phone fix and states, Make Upscale | Merge into `release/1` |
| Plan card, approve once (money) | `money/plan-approval` | Design note for the owner first | Owner reads it; independent review; owner's yes |
| Five-minute test | `test/five-minute` | Being written | Merge into `release/1` |
| CI to green | triage | Sorting the old failures into fix batches | Fixers tonight |
| D0 chain | #511 → #513 → #512 → #514 → #515 | Frozen; checking CI against main | Fix anything D0 caused |
| Cinema "at most 3N" | #540 | Review passed on the code | Owner's yes |

## Phase 2 plans (draft PRs, nothing merges before 9 Oct)
P4b #547, A1 #549, S1 #551, P6b #548, S2 #553, U1 #550, E7R #552.

## Waiting on the owner
1. The scope questions sent at 13:25 IST (CI baseline, the five-minute test, the quick-tool price timing, features without a rail, #540, the cap field, the merge train, cost column).
2. A hotfix for the three token or agent approval gaps before the demo?
3. Release 1 review on Wed 7 Oct.
