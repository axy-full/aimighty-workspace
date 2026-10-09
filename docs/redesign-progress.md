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
| A2 header | redesign/a2-header | — | lane A building |
| C4 Library tray | redesign/c4-library | — | lane B building |
| C3 Make (grid, composer, viewer, prompt reuse) | redesign/c3-make | — | lane C building |

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
- `billing_cycles` has no `workspace_id` index (the low-credit base and Credits & billing read it); adding one is a schema change.
- The spend-button scan counts any file using the quote layer as paid; each such v12 screen needs an entry in NOT_SPENDING_FILES until the scan learns quote-only helpers.
- `meter_events` has no `created_at` index (typical times bound the query by rowid instead); adding one is a schema change.
- The house workspace pays in dollars, so it never shows credits or the low-credit chip; screenshots are taken in credit-paying test workspaces.

## Log

- 10 Oct, evening: overnight build started. Prototype imported, switch and screenshot tool written, #612 opened.
- 10 Oct, night: #613 reviewed (one blocker in the screenshot publisher, fixed) and approved. B1 (#614) and C1 (#615) pushed and in review; B2 and C2 started. The one-design guard now names prototype 12 as the design, with graphite only shrinking.
- 10 Oct, late night: A1 (#616), B2 (#617) and C2 (#618) opened; A1 and B2 approved after fixes. Lanes now on A2 header, C4 Library tray, C3 Make.
