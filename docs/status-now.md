# Status now: 5 October 2026, ~21:00 IST, paused for the owner's travel

**All work is paused.** Every stream's work is pushed to its own branch (work in progress where marked). Nothing is pushed to `main`, nothing is merging, and no deploy is running. One exception, stream 10 below, is kept safe on disk.

## The US$0.10 switch: done
- PR #524 merged (`ebdcd9c0`); production deploy Ready at 14:19 UTC.
- The live check reads `creditUsd 0.1`, `ledgerUnitUsd 0.1`, `pausedSince null`, `conversions []`. Nothing was written in the old-price window, so nothing paused and nothing needed converting. The live price list reads Seedance 2.5 1080p 5 s = 43 cr and Nano Banana Pro 1K = 3 cr.
- **The dry run ran once,** with `dryRun: true` written explicitly. It reported 0 rows in the window for every workspace, nothing needing a decision, no caps, no debts and no declined top-ups. There is no conversion step.
- Rollback rule: never roll back to a deployment from before #524.
- **The site-wide $0.10 sweep, PR #529** (`pricing/sweep-010`, `ca972f22`): open, CI running (6 passed, 16 pending at pause time), NOT merged. Next: when CI is green, merge it, run the step 5 checks, then "step 6 green".

## Merge queue after "step 6 green"
| # | Item | Branch / PR | State | Next | Waiting on the owner |
|---|---|---|---|---|---|
| 1 | $0.10 sweep | `pricing/sweep-010`, #529 | CI running | Merge when green | — |
| 2 | Clean slate | `design/clean-slate`, #528 | Ready | Merge first after step 6 | — |
| 3 | Handover and runbook docs | `docs/handover-2026-10-05`, #525 | Ready | Merge | — |
| 4 | React Flow dependency | `deps/react-flow`, #526 | Ready | Merge | — |
| 5 | D0 #511, #513, #512, #514, #515 | `d0/*` | Being merged onto the clean slate: #512 `0b13ea58`, #514 `5e75527c`, #515 `845b7c0c` pushed; #511 `0f990b6c`, #513 `18e2a5ce` | Finish the clean-slate merges, collect a preview link and screenshots per PR | Preview check of all five |
| 6 | Cinema "at most 3N" | `d0/make-cinema-price`, #523 | Built and tested | Independent review | Merge (money) |
| 7 | Public site copy and names | `site/copy-names` | Done | Open as a PR | Preview check |
| 8 | /admin engine-cap field | `admin/workspace-cap-field` | Built, gates green | Open as a PR | Merge (spend limits); the project cap "0 = no cap" rule |

## Demo streams (work in progress)
| # | Stream | Branch (head) | Done | Very next step |
|---|---|---|---|---|
| 1 | Switch and shell | `demo/s01-switch` (`3f9b627b`) | Switch, routing, wiring | Add the missing route mock in `adminDeletedWorkspace.spec.ts`; keep Make's param fix; pass the balance to Make |
| 2 | Home | `demo/s02-home` (`7c89f4f0`) | Box, templates, projects, Start, Waiting for you | Cut a clean PR on the switch |
| 3 | Board canvas | `demo/s03-board-canvas` (`0dbd2880`) | 3.1, 3.2, 3.3 | Cut a clean PR |
| 4 | Board cards 1 | `demo/s04-board-cards-plan` (`72e149d0`) | Models, brief, storyboard, shot list, sample plan | Plan card, looks, questions |
| 5 | Board cards 2 | `demo/s05-board-cards-shots` (`1d9089a5`) | Shot groups, take cards, review mode | Inspector, Cast, Cut and Deliver |
| 6 | Make | `demo/s06-make` (`2c7d9060`) | Panel as drawn, Recent | Call the board's "made" event; cut a PR |
| 7 | Atomik | `demo/s07-atomik` (`c1a4e8cb`) | ⌘K and panel in progress | Finish PRs 1–2, then the docked panel |
| 8 | Control room | `demo/s08-control-room` | Approvals and the shared queue | Activity |
| 9 | Settings | `demo/s09-settings` (`8d377475`) | 9.1 in progress | Finish 9.1 |
| 10 | Phone | `demo/s10-phone` (`b7ff57c7` pushed) | PR 1 in progress | **It was mid-merge of the switch when paused.** That state is kept on disk with a backup; finish the merge first |
| 15 | Design master round 2 and guest Home | `design/master-round-2` (`acd0d09f`), `site/guest-home` (`f1a19f0a`) | Master swap and corrections in progress; guest Home started | Finish the frame-diff list; then guest Home |
| — | Old-design inventory and CI guard | `design/old-design-inventory` (`b72e8447`) | Done | Merge after the clean slate |
| — | Platform plan (P2 status, P3, P4) | `docs/platform-plan` (`86846375`) | Done | Open as a docs PR |

## Waiting on the owner
1. "resume".
2. The D0 preview check, all five PRs in one sitting; links and screenshots come together.
3. Dunes draft v3 (326 cr ceiling): approval. Nothing generates before then.
4. Decisions: welcome grants during the old-price days (now moot: none in the window), goodwill expiry, the project cap "0 = no cap" fix, and the eight unowned inventory items.
