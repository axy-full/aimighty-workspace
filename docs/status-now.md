# Status now: 6 October 2026, 10:42 IST, PAUSED by the owner

**Paused by the owner.** Agents are stopping at a safe point (work in progress committed and pushed, slots released, resume notes kept). Nothing merges and nothing deploys while paused. main is `e3fb0c98`. New drafts this morning: #543 (sample production), #544 (sample no-spend guard, owner decision: money).

## Done today
- The US$0.10 switch: #524 merged; production reads `creditUsd 0.1`. Step 6 green.
- Merged: #524, #529 (the $0.10 sweep), #528 (the clean slate), #526 (React Flow), #531 (deny rules), #541 (npm advisory fix).
- Rollback rule: never roll back to a deployment from before #524.

## Overnight, in order
| # | Item | Branch / PR | State | Next |
|---|---|---|---|---|
| 1 | D0: 13 owner fixes and 2 CI checks | #511, #513, #512, #514, #515 on `d0/*` | Fixes 1–11 done and cleaned up (#511 `fe1a9c77` → #513 `17d202db` → #512 `b847efa2` → #514 `228a1176` → #515 `4e3ffca3`); unit green on every head; CI checks are draft #533 (green) | Finish the browser specs on #515; owner preview check |
| 2 | Cinema "at most 3N" | #523 failed review → replacement #540 (`61dcb02c`) | Re-review PASS on the code; CI running | #540 brought up to date with main (`5a0f941f`, lockfile only), CI running; waits for the owner's yes |
| 3 | Deny rules for destructive git commands | #531 | **Merged** (`3ce363d8`); CI green, production deploy succeeded | Done |
| 4 | The board for everyone (Studio, Ads, Social) | `demo/board-everyone` from `demo/integration` (`08368b84`) | Draft #535: stage pages deleted, redirects, preview built; unit green; CI workbench shards red (old specs) | Board PR: delete the ten stage pages, redirect their routes, delete their styles, preview. Target Wed 7 Oct evening |
| 5 | Autosave, then Make's short form | Draft #532 (autosave), draft #534 (Make short form, stacked on #514) | Built and tested | Owner preview check |
| 6 | Guest Home follow-ups; dunes draft v3 | `site/guest-home*`, `design/master-round-2`, `site/copy-names` | Draft PRs #536 (master round 2), #537 (guest Home), #538 (guest Home on), #539 (site copy); dunes draft v3 ready for the owner | Owner preview; nothing generates |

## Paused tonight (work pushed, resume notes kept)
- Integration: `demo/integration` `08368b84`. Browser gates and the build still to run.
- The sample production builder (stream 12): pausing, with a work-in-progress commit.

## Waiting on the owner
1. The D0 preview check (all five) once the fixes are in; the review page comes in the morning.
2. The Studio, Ads and Social board preview, Wednesday evening.
3. Dunes draft v3 (326 cr ceiling): approval.
4. Open decisions: the /admin engine-cap field, the project cap "0 = no cap" fix, person-only take review, the guest-home sign-in PRs.
