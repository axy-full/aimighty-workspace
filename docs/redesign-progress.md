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
| CI on PRs into release/1 | ci/verify-release1 | #612 | NEEDS AKSHAY (CI change, not screen work). CI confirmed running on it. |
| P0 foundation: switch, design import, screenshot tool, plan | redesign/p0-foundation | #613 | Opus approved (after fixes); CI running |
| B1 price layer, no-literal guard, low-credit rule and chip | redesign/b1-price | #614 | in review |
| C1 render-state model, typical times API, queue places | redesign/c1-render-model | #615 | in review |
| A1 tokens, primitives, overlay stack, V12Shell frame | redesign/a1-frame | — | lane A building |
| B2 Settings › Credits & billing | redesign/b2-billing | — | lane B building (on B1) |
| C2 Home (signed in) + shared bar | redesign/c2-home | — | lane C building (on B1) |

## Blockers

- **No self-merge until #612 merges.** Every redesign branch contains #612's CI commit, so merging one before #612 would merge a CI change. Screen PRs are made merge-ready (CI green, screenshots, Opus review) and listed under "Ready to merge" until then.

## Prices with no live quote path ("quoted")

- Lip-sync (no engine: Sync existed only on the retired Higgsfield sign-in path)
- Make turnaround (no code)
- Start from a tile (no code)
- A plan's fix (priced only when its turn comes)
- "/" skills (no per-skill quote)

## Next

1. P0 PR review (Opus) and CI.
2. Lanes: A → A1 (tokens, primitives, overlay stack, V12Shell frame); B → B1 (price layer, low-credit rule); C → C1 (render-state model, typical times). Then A2 header, B2 Settings › Credits & billing, C2 Home, C3 Make, C4 Library tray, A3 menus/keys/tooltips.

## Follow-ups for the owner (found while building)

- Cancelling a queued Ark (Seedance) or fal (Kling, Topaz) job: both providers have cancel APIs and say a queued cancel isn't billed, but calling them is new money-adjacent code (NEEDS AKSHAY). Until then, Cancel shows only for held takes and queued Higgsfield API video.
- fal's queue position is received and dropped (lib/engines/fal.ts); keeping it is an engine change.
- `meter_events` has no `created_at` index (typical times bound the query by rowid instead); adding one is a schema change.
- The house workspace pays in dollars, so it never shows credits or the low-credit chip; screenshots are taken in credit-paying test workspaces.

## Log

- 10 Oct, evening: overnight build started. Prototype imported, switch and screenshot tool written, #612 opened.
- 10 Oct, night: #613 reviewed (one blocker in the screenshot publisher, fixed) and approved. B1 (#614) and C1 (#615) pushed and in review; B2 and C2 started. The one-design guard now names prototype 12 as the design, with graphite only shrinking.
