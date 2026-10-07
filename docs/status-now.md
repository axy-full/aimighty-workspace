# Status now: 7 October 2026, 08:40 IST, Release 1 on the VPS

The VPS session took over from the laptop at 03:45 IST (work began 08:05). The governing scope is `docs/particl-sow.md` (v2). The laptop's full handover is `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. Release is Thursday 8 Oct as a merge train, one PR at a time, on the owner's "go"; the demo is Friday 9 Oct.

**Integration preview:** `release/1` (draft #546) → https://particlstudio-git-release-1-akshayzigzag-filmscoms-projects.vercel.app/suites. It opens behind the Vercel login. Signing in to Particl there still fails (the preview's database key, owner step 1 below).

## Checked this morning
- main is 17683826 (#545). particl.si serves $0.10 a credit; plans, packs and the rate card match the scope; no public page shows $0.80 or an 8× figure. Step 6 was declared green on 5 Oct.
- The VPS runs the unit suite: 3,717 passed, 2 failed (two cleanup dates that ran out on 6 Oct; fixed in `fix/r1-orphan-sweep`).

## Today
| Item | Where | State | Next |
|---|---|---|---|
| Queue into `release/1` | Edit & Sound and empty boards, sample no-spend 2, Cinema hidden, CI fixes F6 | Merged 08:30, `release/1` = 8a964da3 | CI run in progress |
| Orphan sweep | `fix/r1-orphan-sweep` | 23 unused old files deleted; fixes the two expired cleanup dates | Full unit run, then into `release/1` |
| Cinema "at most 3N" | #540, #559 | Fresh review of the last fixes running | Then the Cinema browser tests |
| Security gaps | #558 | Fresh review running | The owner's yes on its lines (today) |
| Sample: nothing spends | `fix/sample-paid-off` | Finishing its checks | Fresh review |
| 3D blocking A and B | `build/gaps-l2-schema`, `build/gaps-l2` | Review round 3 running | Into `release/1` on PASS (B waits on Q7) |
| Money states | #556 | Waiting on the owner's Q11 | Checks, review delta, the owner's yes |
| Old pages | `fix/r1-old-pages` | Waiting on the owner's Q15 for old tests | Spec decisions, review |
| CI to green | `release/1` | Biggest risk for Thursday | Read the new run; Q15 |
| D0 check, screen by screen | review page | Not started | Screenshots at 1440×900 and 390×844 beside the handoff frames |

## Waiting on the owner, in order
1. Preview sign-in: a Turso token for the Preview environment's database, pasted into Vercel's Preview `TURSO_AUTH_TOKEN` and `PLATFORM_AUTH_TOKEN`; and whether Preview uses the live database (Q7).
2. Q11: the 80% pause and approved plans (recommended: warn on the plan card).
3. Q15: delete or port about 70 old tests (recommended: delete those whose feature left with no new home; port the money ones).
4. #558: yes or no to its lines, after today's review.
5. Q14: a sample mark stops all spending in its workspace (recommended: yes).
6. Q10: Cinema's four points.
7. Q3: the dunes film ceiling (326 cr in scope v2, 233 cr in draft v4) and whether "Particl demo" stays.
8. Q4 to Q6: the empty Ads and Social boards; Social posts off.
9. Q8, Q9, Q16, Q2.
10. On the VPS: remove `axy` from the `docker` group (`sudo gpasswd -d axy docker`); it applies when the session restarts.

## Phase 2 plans (draft PRs, nothing merges before 9 Oct)
P4b #547, A1 #549, S1 #551, P6b #548, S2 #553, U1 #550, E7R #552.
