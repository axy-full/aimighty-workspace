# Redesign progress log (prototype 12)

The running log of the overnight redesign build. A restarted session reads this file first, then docs/redesign-plan.md, and picks up from **Next** below.

- **Design:** design/particl-prototype-12 is the only design. Each screen PR deletes the design/particl-graphite file(s) it replaces; the plan's work-item table names which.
- **Branch base:** every redesign branch stacks on `ci/verify-release1` (#612, NEEDS AKSHAY). Today CI only runs on PRs into main; with that commit in the branch, CI runs on PRs into release/1 too. Merge #612 first: the redesign PRs' diffs then drop it.
- **Switch:** `lib/newInterface.ts`. On for the house workspace (`aimighty`, legacy) and for workspaces in the site setting `newInterfaceWorkspaces` (empty by default). Off for every customer workspace. Client: `useNewInterface()` (lib/session.tsx). Tests: `signInToRedesign()` (tests/helpers/newInterface.ts).
- **Screenshots:** `tests/redesign/*.shots.ts` with `captureBeside()` (tests/helpers/redesignShots.ts), run with `-c playwright.redesign.config.ts` at 1440×900 and 1280×800 against a local mock server. Then `node scripts/redesign/publish-shots.mjs --pr <n> --from ../redesign-shots/<screen>` pushes the images to the `redesign-screenshots` branch and prints the Markdown for the PR body.
- **Merge rule (owner, 10 Oct):** the lead may merge into release/1 only screen work with no money, sign-in, migration, secret, env or DNS change, and only after CI is green, the screenshots are attached and a fresh Opus review has approved. Anything else: build it fully, open the PR, title it "NEEDS AKSHAY · …", and move on.
- **Production guard:** before each heavy step, check particl.si /api/health. If its p95 goes over 1 s, pause heavy work until it recovers.

## Status

| Item | Branch | PR | Status |
|---|---|---|---|
| CI on PRs into release/1 | ci/verify-release1 | #612 | NEEDS AKSHAY (CI change, not screen work). CI confirmed running on it. |
| P0 foundation: switch, design import, screenshot tool, plan | redesign/p0-foundation | — | in progress |

## Blockers

- **No self-merge until #612 merges.** Every redesign branch contains #612's CI commit, so merging one before #612 would merge a CI change. Screen PRs are made merge-ready (CI green, screenshots, Opus review) and listed under "Ready to merge" until then.

## Prices with no live quote path ("quoted")

(filled in as screens are built)

## Next

1. Write docs/redesign-plan.md from the prototype inventory and the app map.
2. Open the P0 PR.
3. Start lanes A–C on the first P1 items.

## Log

- 10 Oct, evening: overnight build started. Prototype imported, switch and screenshot tool written, #612 opened.
