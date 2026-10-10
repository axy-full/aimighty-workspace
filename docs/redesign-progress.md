# Redesign progress log (prototype 12)

The running log of the overnight redesign build. A restarted session reads this file first, then docs/redesign-plan.md, and picks up from **Next** below.

- **Design:** design/particl-prototype-12 is the only design. Each screen PR deletes the design/particl-graphite file(s) it replaces; the plan's work-item table names which.
- **Branch base:** every redesign branch stacks on `ci/verify-release1` (#612, NEEDS AKSHAY). Today CI only runs on PRs into main; with that commit in the branch, CI runs on PRs into release/1 too. Merge #612 first: the redesign PRs' diffs then drop it.
- **Switch:** `lib/newInterface.ts`. On for the house workspace (`ws_legacy`, lib/houseWorkspace.ts) and for workspaces in the site setting `newInterfaceWorkspaces` (empty by default). Off for every customer workspace. Client: `useNewInterface()` (lib/session.tsx). Tests: `signInToRedesign()` (tests/helpers/newInterface.ts).
- **Screenshots:** `tests/redesign/*.shots.ts` with `captureBeside()` (tests/helpers/redesignShots.ts), run with `-c playwright.redesign.config.ts` at 1440×900 and 1280×800 against a local mock server. Then `node scripts/redesign/publish-shots.mjs --pr <n> --from ../redesign-shots/<screen>` pushes the images to the `redesign-screenshots` branch and prints the Markdown for the PR body.
- **Merge rule (owner, 10 Oct):** the lead may merge into release/1 only screen work with no money, sign-in, migration, secret, env or DNS change, and only after CI is green, the screenshots are attached and a fresh Opus review has approved. Anything else: build it fully, open the PR, title it "NEEDS AKSHAY · …", and move on.
- **Production guard:** before each heavy step, check particl.si /api/health. If its p95 goes over 1 s, pause heavy work until it recovers.

## Status

| Item | Branch | PR | Status |
|---|---|---|---|
| CI on PRs into release/1 | ci/verify-release1 | #612 | NEEDS AKSHAY (CI change, not screen work). CI green. |
| P0 foundation: switch, design import, screenshot tool, plan | redesign/p0-foundation | #613 | Opus approved; CI re-running after a spec fix (two site-settings specs expected the old fields) |
| B1 price layer, no-literal guard, low-credit rule and chip | redesign/b1-price | #614 | Opus approved (after fixes: Cinema "up to" the hold, batch totals, references) |
| C1 render-state model, typical times API, queue places | redesign/c1-render-model | #615 | Opus approved (after fixes: Cinema Cancel and money wording) |
| A1 tokens, primitives, overlay stack, V12Shell frame | redesign/a1-frame | #616 | Opus approved (after 9 small fixes) |
| B2 Settings › Credits & billing | redesign/b2-billing | #617 | Opus approved (after fixes: members see "Ask an admin") |
| C2 Home (signed in) + shared bar | redesign/c2-home | #618 | in review |
| A2 header | redesign/a2-header | #620 | Fresh Opus re-review APPROVED (303ba243). CI on ce2498c7 green (the earlier spend-buttons failure was flaky: it also hit #615 and passed on re-run); run on 303ba243 in progress. Ready to merge once #612 is in. |
| C4 Library tray | redesign/c4-library | #619 | Fresh Opus re-review APPROVED (1222e2f6); CI green; screenshots re-taken. Ready to merge once #612 is in. |
| C3 Make (grid, composer, viewer, prompt reuse) | redesign/c3-make | #621 | Opened with screenshots (e67252c9); Opus review running; Reuse seed split to #622 |
| P2-a1 board frame (stage rail, stage header, right toolbar, view switch) | redesign/p2a-board-frame | — | lane C building |
| P4 join sheet (Continue with email, request access + company size) | redesign/p4-join | — | WIP recovered and pushed (96d875e7); touches app/api/access-request: NEEDS AKSHAY when opened |
| A3 menus, keys, tooltips | redesign/a3-menus | — | Built and pushed (f882bd91, includes A2 fixes); PR next |
| C3 Reuse seed (seed in the priced request) | redesign/c3-make-seed | #622 | NEEDS AKSHAY (opened) |
| P2-b Shots 4-across grid (gap fix) and the bar with Attach | redesign/p2b-shots | — | lane A building |

## Blockers

- **No self-merge until #612 merges.** Every redesign branch contains #612's CI commit, so merging one before #612 would merge a CI change. Screen PRs are made merge-ready (CI green, screenshots, Opus review) and listed under "Ready to merge" until then.

## Prices with no live quote path ("quoted")

- Lip-sync (no engine: Sync existed only on the retired Higgsfield sign-in path)
- Make turnaround (no code)
- Start from a tile (no code)
- A plan's fix (priced only when its turn comes)
- "/" skills (no per-skill quote)

## Next

1. Fresh Opus reviews of #619 (C4) and #620 (A2); #620's CI.
2. Two lanes (owner, 10 Oct: at most 2 plus the lead): C3 Make (finish, specs, shots), A3 menus/keys/tooltips.
3. Then P2 boards, starting from redesign/p2a-board-frame.
4. The log lives on redesign/integration; commit and push at least every 30 minutes.

## Follow-ups for the owner (found while building)

- Cancelling a queued Ark (Seedance) or fal (Kling, Topaz) job: both providers have cancel APIs and say a queued cancel isn't billed, but calling them is new money-adjacent code (NEEDS AKSHAY). Until then, Cancel shows only for held takes and queued Higgsfield API video.
- fal's queue position is received and dropped (lib/engines/fal.ts); keeping it is an engine change.
- `billing_cycles` has no `workspace_id` index (the low-credit base and Credits & billing read it); adding one is a schema change.
- The spend-button scan counts any file using the quote layer as paid; each such v12 screen needs an entry in NOT_SPENDING_FILES until the scan learns quote-only helpers.
- `meter_events` has no `created_at` index (typical times bound the query by rowid instead); adding one is a schema change.
- C4 (re-review notes): `looksLikeTakeId` in BoardView.tsx is looser than needed (a dragged single word can toast in the new frame); no spec covers the switch-off drop; an async drop handler can leave an unhandled rejection if findProjectTake throws.
- "quoted" (decision 5) still conflicts with CLAUDE.md rule 14's wording; owner to confirm the override stands.
- The house workspace pays in dollars, so it never shows credits or the low-credit chip; screenshots are taken in credit-paying test workspaces.

## Log

- 10 Oct, evening: overnight build started. Prototype imported, switch and screenshot tool written, #612 opened.
- 10 Oct, night: #613 reviewed (one blocker in the screenshot publisher, fixed) and approved. B1 (#614) and C1 (#615) pushed and in review; B2 and C2 started. The one-design guard now names prototype 12 as the design, with graphite only shrinking.
- 10 Oct, late night: A1 (#616), B2 (#617) and C2 (#618) opened; A1 and B2 approved after fixes. Lanes now on A2 header, C4 Library tray, C3 Make.
- 10 Oct, 13:30 IST: session resumed (the previous one stopped about 02:45 IST and its conversation was lost). Recovered and pushed: A2's review fixes (ce2498c7, never pushed), C3 Make WIP (redesign/c3-make, never pushed), P2-a1 board frame WIP (redesign/p2a-board-frame, unlogged) and P4 join WIP (redesign/p4-join, unlogged). Found A2 (#620) and C4 (#619) already opened with screenshots, though the log said none. Running 2 lanes: C3, A3.
- 10 Oct, about 15:00 IST: C4 (#619) and A2 (#620) fixed after fresh Opus reviews and re-approved. C3 opened as #621, its Reuse seed as #622 (NEEDS AKSHAY). A3 built (a3-menus). Lanes now: C on P2-a1 board frame, A on P2-b Shots grid and bar. Integration has A2, C4 and C3 merged.
