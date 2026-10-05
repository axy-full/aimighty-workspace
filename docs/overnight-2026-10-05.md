# Overnight, 4–5 October 2026

What happened while the owner was away, and what waits for the morning.

Merging to `main` deploys to particl.si (Vercel Production), so only the pre-approved items 1–3, #501 (approved on 4 October) and three CI/test fixes were merged. The D0 PRs that change what customers see (3, 5, 6) are open with their previews. Every merge had green CI, was on the latest `main`, and had its preview opened in the browser: the public screens render, and the only console errors are Vercel's own preview-toolbar script (blocked by the app's security policy). The signed-in screens cannot be opened on a preview without a Particl account, which I may not use; CI's full browser suite (five sizes, real build, mocked sign-in) covers them.

## Merged

| PR | What | Preview |
|---|---|---|
| [#506](https://github.com/axy-full/aimighty-workspace/pull/506) | CI: `npm audit` checks shipped dependencies only. Every PR failed on braces ≤ 3.0.3, a lint-only dev dependency with no patched release. | [preview](https://particlstudio-git-ci-aud-bfd03c-akshayzigzag-filmscoms-projects.vercel.app) |
| [#505](https://github.com/axy-full/aimighty-workspace/pull/505) | docs: build SOW, 4 October — the SOW as `docs/particl-sow-2026-10-04.md`; ground rules 11–17 in `CLAUDE.md`. | [preview](https://particlstudio-git-docs-s-584c41-akshayzigzag-filmscoms-projects.vercel.app) |
| [#507](https://github.com/axy-full/aimighty-workspace/pull/507) | test: the Rig board spec waits for the board to settle; Playwright's click retries were scrolling it mid-fit, failing CI at random. Test-only. | [preview](https://particlstudio-git-test-r-339e71-akshayzigzag-filmscoms-projects.vercel.app) |
| [#501](https://github.com/axy-full/aimighty-workspace/pull/501) | D0 1a–2: one design (Graphite) — old design folders out, one token set, glass/flair/blur/light theme gone, sheets beside components, the removals and renames, Soul renders kept on the API key. Six CI fixes on the way: three intended-change test updates, a Rig canvas contrast drop, a Takes chip row overflowing on phones, the phone sheet's slide-up animation restored, and a half-pixel rounding tolerance on one 44 px check. | [preview](https://particlstudio-git-chore-a4315d-akshayzigzag-filmscoms-projects.vercel.app) |
| [#509](https://github.com/axy-full/aimighty-workspace/pull/509) | design: new handoff, board made easy — `design/particl-graphite/` replaced whole (sample emails changed to `@example.com`), and `docs/handoff-diff.md` with "Where the repo wins". | [preview](https://particlstudio-git-design-3dfe74-akshayzigzag-filmscoms-projects.vercel.app) |
| [#510](https://github.com/axy-full/aimighty-workspace/pull/510) | D0 tokens: `app/graphite.css` to README §2 — pure-black panels, 55 % secondary text, the 12/13/14/15 px type steps, 10 px cards, the new quiet/disabled/segment/sheet tokens, lighter hovers. Four Atomik tests and the token unit test updated to the new values. | [preview](https://particlstudio-git-d0-tok-3a7176-akshayzigzag-filmscoms-projects.vercel.app) |

Closed without merging: [#508](https://github.com/axy-full/aimighty-workspace/pull/508), a test tolerance fix, superseded by the same change inside #501.

## Open and waiting for you

All are rebased on `main` after the tokens PR merged and carry its look; each PR body has its own open-and-click list. Nothing in them is paid.

| PR | What | Why it waits | Preview |
|---|---|---|---|
| [#511](https://github.com/axy-full/aimighty-workspace/pull/511) | D0 3a: header option B (Home · project · Make · Atomik), the Settings menu behind the avatar, the old-link redirect table in `lib/shell/ia.ts` | Changes what customers see; also moves the logout call into a shared helper (sign-in rule). | [preview](https://particlstudio-git-d0-pr3-323422-akshayzigzag-filmscoms-projects.vercel.app) |
| [#513](https://github.com/axy-full/aimighty-workspace/pull/513) | D0 3b: ⌘K, the right-click menu, the Jobs tray and toasts in the master's look (stacked on #511) | Customer-visible; two small calls below. | [preview](https://particlstudio-git-d0-pr3-b2aaf5-akshayzigzag-filmscoms-projects.vercel.app) |
| [#512](https://github.com/axy-full/aimighty-workspace/pull/512) | D0 5a: Make is a panel over any screen; `view=gen` links redirect to it. Overnight CI fix: three tests now check the panel instead of a "Generate" page, and the film `#` suggestion list scrolls clear of the panel's sticky Make row on a landscape phone (`FilmVocabulary.tsx`). | Customer-visible; twelve composer controls need a Claude Design frame. | [preview](https://particlstudio-git-d0-pr5-ccbd50-akshayzigzag-filmscoms-projects.vercel.app) |
| [#514](https://github.com/axy-full/aimighty-workspace/pull/514) | D0 5b: Motion transfer and Object swap as Make modes; Viral motion/swap links redirect (stacked on #512). Overnight CI fix: the old-link switchover test now expects those links to open Make in the matching mode. | Customer-visible; one decision below. | [preview](https://particlstudio-git-d0-pr5-719025-akshayzigzag-filmscoms-projects.vercel.app) |
| [#515](https://github.com/axy-full/aimighty-workspace/pull/515) | D0 6: the reading floor (12 px, 55 %, 44 px) on the surfaces the handoff does not draw | Restyles sign-in and account pages (sign-in rule). | [preview](https://particlstudio-git-d0-pr6-4f90bf-akshayzigzag-filmscoms-projects.vercel.app) |

CI at 02:04 UTC (7:34 IST), after the overnight rebase on `main`:
- **#511, #513:** all 24 checks green.
- **#515:** 23 of 24 green, the last still running (it was all green before the rebase, same content).
- **#512:** the three Make failures are fixed; one new failure, unrelated to Make: `tests/workbench.spec.ts:220` at 844×390, where the old workbench's "Node version saved" toast sits over the Genie tab and the click times out. The same test passes on #511, #513 and #515 from the same base, so I re-ran the failed jobs rather than changing anything. If it fails again it is a toast-placement fix in the old workbench, not in this PR's code.
- **#514:** test-only fix for the switchover spec pushed (`a1c41292`); 14 of 22 checks green and the rest still running when this was written.

Check each PR's Checks tab before merging; none of these has been merged.

Merge order when you're happy: #511 → #513 → #512 → #514 → #515, each rebased on `main` first.

## Skipped, and why

- **D0 PR 5c** (retire `/generate`, `/images`, `/audio`, `/make/[kind]` with their redirects): not started. It needs 5a merged, and the Gen controls that have no frame (above) should be settled first so nothing is lost when the old page goes.
- **Home as its own page** (`?view=home`): not built. The SOW gives Home with templates and the sample production to U1; the header's Home opens today's Studio overview until then, and no redirect was added for it.
- **Signed-in screens on the previews**: not opened — they need a Particl account, which I may not use. Covered by CI's browser suite.
- **GitHub issue for the Astra upscale billing question**: issues are disabled on the repo (enabling them is a setting change), so the write-up is in the working copy as `astra-upscale-issue.md`, not in a PR.

## Decisions needed

Each is a short question; the PR or file that holds it is in brackets.

1. Does the Auto per-job line become a workspace setting, or stay `RIG_AGENT_JOB_CEILING_CREDITS`? (handoff-diff a)
2. "Start · up to 4 cr" (Atomik's thinking): taken by any member, or a person approving like other spend? (handoff-diff e; also SOW §10.7)
3. Fix allowance: 2 × the shots' engine prices is 186 cr for the sample plan, but the design prints 114 cr. Which formula? (handoff-diff)
4. The 80 % budget pause with Continue and Stop is new behaviour on caps (today it is a one-time notice to admins). Build it? (handoff-diff)
5. Board dot grid: draw it as an SVG pattern (as the repo already does) instead of the README's gradient? (handoff-diff, tokens)
6. Make's shortcut: ⌥M (README, built) or ⌘/ (master)? (#511)
7. Phone sheets: keep the slide-up restored in #501, or the README's fade (its motion list has no slide)? (#501)
8. Object swap: keep 1–8 reference images, or cap at one replacement as drawn? (#514)
9. Jobs tray: dots (master, built) or keep the 52 px thumbnails? (#513)
10. Toast dot: green only with Undo/Open (built, so errors don't look like success), or always green as drawn? (#513)
11. The Settings menu's interim targets until D1 — Spending rules → Atomik › Budget, Connections → Tools & connections, Advanced → Engines — OK? (#511)
12. The "STUDIO" label under the wordmark is under 12 px: raise it (wider lockup) or leave the logo as drawn? (#515)
13. Credit price: `CLAUDE.md` § Pricing says US$0.10, rule 14 and particl.si say US$0.80 (the deployment's `CREDIT_USD`), and PR #500 is open. Merge #500 to make the docs and code agree?
14. Cinema Studio 4.0's price in Make: "about N cr, at most 3N cr", or remove it? (SOW §10.2)
15. Send the missing frames (below) to a Claude Design round before U1?
16. Old Viral links to Motion transfer / Object swap now open Make over Studio's first page (Brief & Script), and the page drops their `account=` param on load (only the old shell reads it). Keep `account=` on the final URL, or let it go? (#514)

**Frames the handoff does not draw** (kept as today in the PRs, never invented):
- Make (#512): film chips/shot control, Enhance + Auto, aspect, Draft first, resolution, length, Sound, voice, music length/Instrumental, takes count, the footer lines, the Edit tab; desktop failed ("Nothing billed · Retry") and insufficient-credits states; Upscale and Seedance Edit as card actions.
- Motion transfer / Object swap (#514): start/end frame, reference reordering, run status and Cancel, the Rendered row, the variant's Recent list, removing the source.
- For U1/D1/S3/S4 (from the coverage check): desktop board money states (short by N cr, failed, unavailable engine, admin markers), Undo toast and reject-with-reason, client review links with approve, the sample board, Settings › Connections token creation, Team security, Advanced › General, editing the budget and cap, the Edit & Sound editor and 3D blocking editor in the new IA, identity training and consent capture, operator/flow cards with wires, empty Ads and Social boards, post states.

## Proposed order for the next packages

Against the new handoff and the SOW's §7 dependencies:

1. **Claude Design round 2** for the frames listed above, starting with Make's controls and the desktop money states — needed by D0 5c and U1.
2. **P4b, then A1** (the tool registry): U1 needs A1, and S2 needs it too. P4b moves every model off the AI Gateway first.
3. **U1**, first PR the five-minute Playwright test (rule 17), then: autosave and no "save first" errors; the names in §3; Home with templates and the sample production (and the `?view=home` redirect from the Studio overview); price display ("N cr / up to N cr / free", dollar hover); plan approval, the Ask/Auto setting, the balance check, "Nothing billed" + Retry (money — owner review before merge); review mode and phone swipe; "Notify me when done".
4. **D1**: the control room (Approvals, Activity, Skills, Memory), Settings in five sections, the phone screens; its last PR retires each old shell in `docs/old-shells.md` whose page is live (62 of the redirect table's pending rows are D1's).
5. **S3** after S1 (running in its own session) and S2 (needs P6b and A1): Studio as the board; its PR carries the 13 Studio redirect rows.
6. **S4** after S3, E8, E9 and A2: Ads and Social boards, Crew review on any board; its PR carries the 14 Business/Viral/Crew rows.
