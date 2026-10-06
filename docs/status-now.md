# Status now: 6 October 2026, 18:25 IST, Release 1 under way

The scope of work v2 (6 Oct) is `docs/particl-sow.md` (PR #545). Phase 1 (Release 1) is the only thing that merges before the demo. Up to 8 agents. No UI merges until the owner's preview check; no money merge without the owner's yes. Release is Thursday 8 Oct as a merge train, one PR at a time, on the owner's "go".

## Today
- 18:00 preview of `release/1` (draft #546) sent to the owner.
- The Higgsfield sign-in is off in Release 1 (#557, reviewed PASS). Motion transfer and Object swap stay: they use the platform API key.
- The sample production's no-spend guard (#544) passed a fresh review; the owner said yes. Queued for `release/1`.
- Plan approval (#555): owner said yes to all nine decisions; a delta review of the last fixes is running.

## Phase 1: Release 1
| Item | Where | State | Next |
|---|---|---|---|
| Integration preview | `release/1`, draft #546 | First full CI run in progress | Merge the queued branches when it finishes |
| Queued for `release/1` | UI sweep, phone, #557, #544 | Ready | One merge after the CI run |
| Gap screens, board tools | `build/gaps-l2` | Cut-out, line drawings, Transcribe in `release/1`; 3D blocking built | 3D blocking: fresh review, then a branch-copy check of the database |
| Gap screens, Edit & Sound, Crew, Ads/Social | `build/gaps-l3` | Being built | Merge into `release/1` |
| Gap screens, money states | #556 | Review found 2 medium; being fixed | Re-review; owner's list Wed morning |
| Gap screens, security | lane 5 | Being built | Fresh review; owner's list Wed morning |
| Plan card, approve once | #555 | Owner yes; delta review running | Merge into `release/1` on PASS |
| Cinema "at most 3N" | #540 | Owner's three decisions being built | Fresh review, Cinema browser tests, then `release/1` |
| Old pages | `fix/r1-old-pages` | Started: remove the old-shell switch, redirect old addresses | Merge into `release/1` |
| CI to green | F6 | Fixing `release/1`-only failures | Green before the train |

## Phase 2 plans (draft PRs, nothing merges before 9 Oct)
P4b #547, A1 #549, S1 #551, P6b #548, S2 #553, U1 #550, E7R #552.

## Waiting on the owner
1. Security hotfix now, or with Thursday's train?
2. Ask the crew: how to measure the lower ceiling.
3. Dunes sample draft v4: approval and which workspace.
4. 3D props provider pick.
5. Six old-page decisions.
6. Sign in on the preview so the API-key price check can run.
7. Release 1 review on Wed 7 Oct; merge order Wed evening.
