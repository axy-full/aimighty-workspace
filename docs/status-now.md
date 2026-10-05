# Status now: 5 October 2026, after the pause

`main` is `ad044b2e`. The last production deploy is `ad044b2e`, at 05:53 UTC on 5 October. Nothing has deployed since the credit price setting was changed. **Merges are held until the US$0.10 switch is done.** Every stream's work is pushed to its own branch; nothing is pushed to `main`.

## The US$0.10 switch (critical path)

| Item | Branch / PR | Done | Next | Waiting on the owner |
|---|---|---|---|---|
| Credit back to US$0.10 | `pricing/back-to-010`, #524 (head `a12cb03f`) | The review fixes. The ledger's unit is read from the record and is never assumed from the price setting. With the new price already set, the merge deploy pauses paid work from its first request. The runbook is rewritten for the owner's order | Finish its gates; the independent reviewer re-checks the money paths | Run the read-only step 1 and the pre-merge check, then the dry run and the conversion |
| Site-wide sweep to US$0.10 | `pricing/sweep-010` (work in progress, on top of #524) | Rate-card tests started | Finish; merges after the conversion | — |
| Cinema Studio: hold at most 3N | `d0/make-cinema-price`, #523 (head `62e456ce`) | Hold, settlement, overrun mark, admin count, tests | Gates, independent review | Merge (money) |

## Held until the switch is done

| Item | Branch / PR | State | Next | Waiting on the owner |
|---|---|---|---|---|
| Clean slate | `design/clean-slate`, #528 | Built and checked locally; CI started | Merge first after the switch | — |
| Handover, runbook findings, payments rule | `docs/handover-2026-10-05`, #525 | Ready | Merge after the clean slate | — |
| React Flow dependency | `deps/react-flow`, #526 | Ready | Merge after the clean slate | — |
| D0 shell (#511, #513, #512, #514, #515) | Combined preview `preview/d0-combined`, #527 (not for merging) | Signed-in screenshots sent | Merge in order after the owner's check | Preview check |
| Public site copy and names (step 1) | `site/copy-names` (head `f53f4605`) | Done, gates run | Open as a PR for the owner's preview | Preview check |

## Demo streams (work in progress, each on its own branch; the PRs will be built clean)

| # | Stream | Branch | Done | Next |
|---|---|---|---|---|
| 1 | Switch and shell | `demo/base` (`preview/d0-combined`) | Combined D0 base and its checks; screenshots | The per-workspace switch: plan, then build |
| 2 | Home | `demo/s02-home` | Box, templates, projects | Start and its price, Waiting for you |
| 3 | Board canvas | `demo/s03-board-canvas` | Canvas, rail, drawers, minimap, list, tool pill (3.1) | History, presence, Made in Make (3.2) |
| 4 | Board cards 1 | `demo/s04-board-cards-plan` | Card models; brief and storyboard in progress | Plan card, looks, questions |
| 5 | Board cards 2 | `demo/s05-board-cards-shots` | Shot groups, take cards, review mode | Filing fix, Inspector |
| 6 | Make | `demo/s06-make` | Shared price display; Make panel in progress | Make panel as drawn |
| 7 | Atomik | `demo/s07-atomik` | ⌘K and the panel in progress | Finish PRs 1–2 |
| 8 | Control room | `demo/s08-control-room` | Approvals and the shared queue | Activity |
| 9 | Settings | `demo/s09-settings` | Settings, Team, Plan & credits in progress | Finish 9.1 |
| 10 | Phone | `demo/s10-phone` | Shell, Home, swipe review in progress | Finish PR 1 |
| 11 | Ads and Social | — | Plan written | Build after the screens above |
| 12 | Sample production | — | Plan and the dunes draft (approved) | Owner generates after the switch; then build the board from the results |
| 15 | Public site, then guest Home | `site/copy-names` | Copy and names | Guest Home after the owner's next message |
| S1 | Board backend | — | Plan written | Migration review by the owner |
| A | Platform (P2–P5) | — | Plans written | After the demo streams |

## Waiting on the owner
1. The read-only step 1 list and the pre-merge check (steps to follow), then the dry run and the conversion.
2. The D0 preview check.
3. The site copy preview check.
4. S1's migration and its other owner-gated pieces, when they come up.
