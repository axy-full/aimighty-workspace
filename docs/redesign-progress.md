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
| P0 foundation: switch, design import, screenshot tool, plan | redesign/p0-foundation | #613 | Opus approved; CI green |
| B1 price layer, no-literal guard, low-credit rule and chip | redesign/b1-price | #614 | Opus approved (after fixes: Cinema "up to" the hold, batch totals, references) |
| C1 render-state model, typical times API, queue places | redesign/c1-render-model | #615 | Opus approved (after fixes: Cinema Cancel and money wording); CI green (a flaky spend-buttons failure passed on re-run) |
| A1 tokens, primitives, overlay stack, V12Shell frame | redesign/a1-frame | #616 | Opus approved (after 9 small fixes) |
| B2 Settings › Credits & billing | redesign/b2-billing | #617 | Opus approved (after fixes: members see "Ask an admin") |
| C2 Home (signed in) + shared bar | redesign/c2-home | #618 | CI green; no Opus approval on record: needs a fresh review |
| A2 header | redesign/a2-header | #620 | Fresh Opus re-review APPROVED (303ba243). CI on ce2498c7 green (the earlier spend-buttons failure was flaky: it also hit #615 and passed on re-run); run on 303ba243 in progress. Ready to merge once #612 is in. |
| C4 Library tray | redesign/c4-library | #619 | Fresh Opus re-review APPROVED (1222e2f6); CI green; screenshots re-taken. Ready to merge once #612 is in. |
| C3 Make (grid, composer, viewer, prompt reuse) | redesign/c3-make | #621 | Opus review asked for changes (focus ring, viewer by id, Esc on quick tools); all fixed at 34783290, specs pass locally; needs screenshots re-taken and an Opus re-review; CI running |
| P2-a1 board frame (stage rail, stage header, right toolbar, view switch) | redesign/p2a-board-frame | — | WIP at 630a6f35: frame spec 5/5 at 1440; other sizes not run; the storyboard shot fails at 1440 (not looked at) |
| P4 join sheet (Continue with email, request access + company size) | redesign/p4-join | — | WIP recovered and pushed (96d875e7); touches app/api/access-request: NEEDS AKSHAY when opened |
| A3 menus, keys, tooltips | redesign/a3-menus | — | Built (688c64bd, has A2 fixes and C3 e67252c9 merged in); no PR yet. After that merge, make-v12 "viewer=1" timed out once at 1440 (not yet re-run or looked at) |
| C3 Reuse seed (seed in the priced request) | redesign/c3-make-seed | #622 | NEEDS AKSHAY; branched before C3's review fixes (needs a merge of c3-make); CI unit (1) failed, not inspected |
| P2-b Shots 4-across grid (gap fix) and the bar with Attach | redesign/p2b-shots | — | WIP at efd0cf6c: grid and bar built; 3 desktop checks pass at 1440; the bar's Ask test times out; other sizes and shots not run |

## Blockers

- **No self-merge until #612 merges.** Every redesign branch contains #612's CI commit, so merging one before #612 would merge a CI change. Screen PRs are made merge-ready (CI green, screenshots, Opus review) and listed under "Ready to merge" until then.

## Prices with no live quote path ("quoted")

- Lip-sync (no engine: Sync existed only on the retired Higgsfield sign-in path)
- Make turnaround (no code)
- Start from a tile (no code)
- A plan's fix (priced only when its turn comes)
- "/" skills (no per-skill quote)

## Next (when resumed)

1. C3 (#621): re-take the make and make-viewer shots, republish, fresh Opus re-review; check its CI.
2. #622: merge c3-make into c3-make-seed, look at the unit (1) failure.
3. A3: re-run make-v12 "viewer=1" on a3-menus at 1440 (timed out once after merging C3), then open the PR with the menus shots and an Opus review.
4. #618 (C2): fresh Opus review (none on record).
5. Resume the two P2 lanes: P2-a1 (other sizes, the storyboard shot), P2-b (the bar's Ask timeout, other sizes, shots).
6. Merge the approved PRs once the owner merges #612.
7. The log lives on redesign/integration; commit and push at least every 30 minutes.

## Follow-ups for the owner (found while building)

- Cancelling a queued Ark (Seedance) or fal (Kling, Topaz) job: both providers have cancel APIs and say a queued cancel isn't billed, but calling them is new money-adjacent code (NEEDS AKSHAY). Until then, Cancel shows only for held takes and queued Higgsfield API video.
- fal's queue position is received and dropped (lib/engines/fal.ts); keeping it is an engine change.
- `billing_cycles` has no `workspace_id` index (the low-credit base and Credits & billing read it); adding one is a schema change.
- The spend-button scan counts any file using the quote layer as paid; each such v12 screen needs an entry in NOT_SPENDING_FILES until the scan learns quote-only helpers.
- `meter_events` has no `created_at` index (typical times bound the query by rowid instead); adding one is a schema change.
- C4 (re-review notes): `looksLikeTakeId` in BoardView.tsx is looser than needed (a dragged single word can toast in the new frame); no spec covers the switch-off drop; an async drop handler can leave an unhandled rejection if findProjectTake throws.
- "quoted" (decision 5) still conflicts with CLAUDE.md rule 14's wording; owner to confirm the override stands.
- The house workspace pays in dollars, so it never shows credits or the low-credit chip; screenshots are taken in credit-paying test workspaces.

- **#627 decisions (owner, 10 Oct, all yes):** a separate site setting for the visitor pages, off by default; `?workspace=` pre-fills the new workspace's name only with an invite code (the server still checks it; the field stays editable); company, role and size ride in the existing access-request note; neutral wording "You don't have access to this board."; keep `app/(test)/v12-join` (test builds only). Also to build: after joining, the person lands back where they were with the prompt in the bar and the price shown.
- **Google sign-in (NEEDS AKSHAY, later):** "Continue with Google" on the join sheet is a stub; no Google sign-in exists today. Not to be built until the owner says so.
- **Question for the owner (no change):** boards are listed per person today, so a teammate in the same workspace can't open another member's board from a link. Should workspace members see each other's boards?

- **Flaky ops test (found 10 Oct):** `tests/ops/blob-to-r2.test.mjs` "resume…" can fail CI's core job with EEXIST: two runs of the Blob→R2 copy script in the same millisecond name their report file the same (`blob-to-r2-copy-<ISO time>.json`, opened exclusively). Fix later: a unique suffix on the report name (script change, backups; owner's call). A re-run passes.
- **Flaky browser test:** `tests/demo-s07-board-agent-workbench.spec.ts` "the dock…" fails on a cold dev server and passes warm (release/1 alone and C4 alone).

## Log

- 10 Oct, evening: overnight build started. Prototype imported, switch and screenshot tool written, #612 opened.
- 10 Oct, night: #613 reviewed (one blocker in the screenshot publisher, fixed) and approved. B1 (#614) and C1 (#615) pushed and in review; B2 and C2 started. The one-design guard now names prototype 12 as the design, with graphite only shrinking.
- 10 Oct, late night: A1 (#616), B2 (#617) and C2 (#618) opened; A1 and B2 approved after fixes. Lanes now on A2 header, C4 Library tray, C3 Make.
- 10 Oct, 13:30 IST: session resumed (the previous one stopped about 02:45 IST and its conversation was lost). Recovered and pushed: A2's review fixes (ce2498c7, never pushed), C3 Make WIP (redesign/c3-make, never pushed), P2-a1 board frame WIP (redesign/p2a-board-frame, unlogged) and P4 join WIP (redesign/p4-join, unlogged). Found A2 (#620) and C4 (#619) already opened with screenshots, though the log said none. Running 2 lanes: C3, A3.
- 10 Oct, about 15:00 IST: C4 (#619) and A2 (#620) fixed after fresh Opus reviews and re-approved. C3 opened as #621, its Reuse seed as #622 (NEEDS AKSHAY). A3 built (a3-menus). Lanes now: C on P2-a1 board frame, A on P2-b Shots grid and bar. Integration has A2, C4 and C3 merged.
- 10 Oct, 16:15 IST (10:45 UTC): **Paused at 16:15 IST** by the owner. Every worktree committed and pushed (WIP where half-done); no servers running, all slots free. Approved and green: #613–#617, #619, #620 (#620's run on 303ba243 still going). In progress: #621 (fixes pushed, needs shots and a re-review), A3 (no PR), P2-a1 and P2-b (WIP).
- 10 Oct, 18:41 IST (13:11 UTC): **Resumed on the new account.** Checked against git and GitHub: nothing merged since the pause (#612 still open); every worktree clean and matching its pushed branch; no servers running. #620 now fully green. #621 has one real unit failure (tests/unit/demo-int-seams.spec.ts reads SuitesShell's old Make-panel condition); #622 has 6 failing checks (not yet inspected).
- 10 Oct, 19:05 IST: **Owner-approved merges into release/1** (Akshay: "merge into release/1 every open PR that is green, reviewed and approved, never main"). Merged: #612 a6cd4ab1, #613 e12f02ac, #614 b8d2b435, #615 8ebb563d, #616 8b693785, #617 2e2b6d7c, #606 b3e95735, #607 44aac1a6 (at 84a1ed59), #608 dd048c85. Stopped on (not merged): #619 and #620, which GitHub marks CONFLICTING after the earlier merges although git merges each cleanly locally (three merge bases from the stacked branches); fix proposed to the owner (merge release/1 into each branch, re-run CI). Not touched, per the owner: main (incl. #609), #618 (needs review), #621 (approved but CI on 7099468f still running), #622 (NEEDS AKSHAY). #606–#608 had only the Vercel check (opened before #612 brought CI to release/1); CI on release/1's new head dd048c85 is running.
- 10 Oct, 19:35 IST: release/1 at dd048c85 is red: unit shards 2 and 3 fail 12 storage specs. Cause: tests/unit/storeTimeoutRetry.spec.ts (from #607) leaked STORAGE_BACKEND=local into other specs. Test-only fix in #623 (33/33 locally); waiting on its CI. Owner decisions recorded in docs/redesign-plan.md ("Owner decisions").
- 10 Oct, 20:20 IST: release/1 dd048c85 run finished: only unit shards 2 and 3 failed (the storeTimeoutRetry leak); all 16 browser shards passed. #623 first CI: 1 left (storeTimeoutRetry's own fence check read another spec's unsettled write in the shared platform DB); fixed to count only its own; local shard 3/3 re-run in progress. B: closed #534, #537, #554 (already in release/1; branches kept). #618 Opus review: CHANGES NEEDED (Waiting strip clipping, bar safe area with a picked tile, faded text under 55%); lane on it. A3: make-v12 viewer=1 spec clicks the graphite header's brand-home, absent with A2; lane on it. P2-a done (1f206b48, + p2a-newboard-tab 4d7874c6), P2-b done (f11d5a23). #624 NEEDS AKSHAY: "Rig" UI ban lifted + CLAUDE.md owner decisions.
- 10 Oct, 21:20 IST: #623 (release/1 fix) reviewed and approved; its first CI passed every unit and browser shard, and failed only core on a lint error #607 also brought in (lib/storage.ts prefer-const), fixed behaviour-identically in the same PR (d0fedc84, re-approved); CI re-running. Local unit shard 3/3: 1355 passed. #618: Opus re-review APPROVED (8f813226) + two small follow-ups (77e1cf6c: Start not pressable without a showable figure; board cards' full names for screen readers); waits on release/1 green to sync. #626 A3 opened, Sonnet review APPROVED + fix fed9f288 (right-click on our menu no longer opens today's shell menu; spec fails without it); merges after #618–#621. P3 render cards built on redesign/p3-render (d1fbc70d). Lanes: P4 join (NEEDS AKSHAY) and P2-c client rounds.
- 10 Oct, 22:05 IST: **#623 merged (46cb919f): release/1 fixed.** #624 fixed again (one-design baseline lowered for Rig, 3 entries removed; 6475b255), CI re-running; #625 after it. release/1 merged cleanly (no hand fixes) into #618, #619, #620, #621, #624, #626; CI queued. #627 P4 opened (NEEDS AKSHAY); Opus review: no leak, no visitor spend, no sign-in change; 14 more privacy probes added (984e6d49, 7/7); five owner decisions sent. Owner paused new items: P5 Rig WIP at 8fb533c0 (redesign/p5-rig), P6 Campaign WIP at 5d4d4634 (redesign/p6a-campaign); restart when open PRs are down to about 4. Built, PRs to open: P2-a frame, P2-a new-board tab, P2-b Shots, P2-c client rounds (22ac7a52), P2-d Deliver + PPM (6af9bcd3), P3 render cards; lanes are syncing and re-shooting them.
- 10 Oct, 23:00 IST: owner's queue: one PR's CI at a time (#624, #625, #619, #620, #618, #621, #626); other runs cancelled until their turn. Opened #628 (P2-a frame), #629 (new-board tab), #630 (P2-b Shots + bar), #631 (P2-c client rounds), #632 (P2-d Deliver + PPM), #633 (P3 render) with screenshots; their CI cancelled until their turn; reviews running (Opus: #633; #629–#631 money paths; Sonnet: #628, #632). #627 carries a do-not-merge-before note listing its unmerged branches.
- 10 Oct, 23:40 IST: owner (usage 6%): full speed, three Sonnet lanes, one-at-a-time CI queue (#624, #625, #619, #620, #618, #621, #626, then reviewed P2/P3). Reviews: #628 approved (should-fix: stage cap), #629 approved, #630 approved (merge after #618/#620/#621), #631 changes needed (approval list could misdescribe a shot; rounds could exceed the draft's limits), #632 changes needed (13th language breaks saving), #633 changes needed (Cancel words vs billing; switch-off request). Lane A: #628/#632/#631 fixes; lane B: #633 fixes, then the cold-server flake in demo-s07; lane C: P5 Rig rebuilt on #628 alone (redesign/p5-rig-2). CI concurrency per PR already exists in verify.yml (no PR needed). Merge-order notes added to #628–#633. #624: flaky demo-s07 + blob-to-r2 core flake, one re-run running.
- 11 Oct, 00:40 IST: **#624 merged (4d006395)**. #625's first reopened run tested a stale base (dd048c85); re-reopened after GitHub refreshed its merge ref (now 4d006395); CI running. Opened #634 (P5 Rig rebuilt on #628 only) and #635 (demo-s07 cold flake fix, approved; next after #625). Approved: #628, #629, #630, #632, #634 (after two money-wording rounds: 'Nothing billed' only on a receipt or provider confirmation), #635. Changes needed: #631 (rounds must match by card id; lane A), #633 (never 'nothing billed' while a hold stands; Retry clipped; lane B). #628 will need a demo-s11-links unit fix (newboard params) before its CI; lane A. Lane C idle (P6 waits for fewer than 8 open PRs).
- 11 Oct, 01:25 IST: **#625 merged (7c80f5c3)** (22/22 on 4d006395). #635 (demo-s07 flake fix) running. #633 approved after a second Opus round (nothing billed only via failureUncharged; never while a hold stands). #634 approved. #631 retitled NEEDS AKSHAY: the planner can't edit a shot from feedback, so rounds are made honest (Atomik's own step titles; client words only as 'Asked'); server planner change reverted (91c2d512); out of the queue until the owner picks (a) a planner tool that edits a card, or (b) honest labels only. Queue after #635: #619, #620, #618, #621, #626, #628, #629, #630, #632, #633, #634. All three lanes idle (P6 waits for fewer than 8 open PRs).
