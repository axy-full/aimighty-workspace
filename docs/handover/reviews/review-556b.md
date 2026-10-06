# Re-review of PR #556: money/gaps-l4 @ 2fe96b9fc18171866ecd2d4ee54f48662c119ac3 (base release/1 fa9956d0)

**VERDICT: FAIL. 1 medium, 7 low. No high.**

Most of the first review is fixed:
- M1: one effective cap is now shown everywhere.
- L3, L4, L5 and L6 are fixed.
- L7 and L8 are mostly fixed.

M2 is fixed only halfway. A change of cap or budget now re-locks the production. But an Unlock still names no cap. An Unlock pressed on a screen that shows the old cap therefore unlocks the new one. One admin can do this on one Settings screen: Each production is not read again after Budget and cap saves.

Reviewer: an independent agent with its own worktree, `W/rev-556b`, detached at 2fe96b9f. It did not commit, push, comment or merge.
- The delta reviewed is c11c0ece..07c289b0: commit 669cf058 plus a two-line test fix. Commit 2fe96b9f only merges release/1.
- The whole PR was then re-read against release/1, through merge base fa9956d0.

## Gates run on this head
| Gate | Command | Result | Log (S/demo/review-556b-probes/) |
|---|---|---|---|
| Typecheck | `./node_modules/.bin/tsc --noEmit -p .` | **0 errors** | tsc.log |
| Touched and new unit specs (9 files) | `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 ./node_modules/.bin/playwright test --project=unit --workers=1` with appPagesAuditDb, capSpend, demo-gaps-l4-budget-gate, demo-gaps-l4-money, demo-gaps-l4-people-only, demo-s09-settings, rigAgentRuns, settingsRoute, studioRoutes | **78/78 passed** | unit-touched.log |
| Money and rules, browser | `demo-gaps-l4-money-workbench` + `demo-gaps-l4-rules-workbench`, 1440x900 + 390x844, fresh mock server `review556b` on port 4797 (webpack), `PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/review556b/platform.db`, PW_CHANNEL=chrome | **13/14 first run.** The member test failed once at 390x844 on the phone-floor check (every control under 44 px). It then passed **6/6** in `--repeat-each=3`. This is a flake, see L7. | browser-money-rules.log, browser-rules-390-rerun.log |
| Review probes, unit | `review556b-probes.spec.ts` (copied into tests/unit for the run, then removed) | **6/6 passed**. Each "OPEN" probe asserts that the hole exists. | probes-run.log |
| Review probe, browser | `zz-review556b-browser-workbench.spec.ts`, 1440x900 + 390x844, same server (copied into tests/ for the run, then removed) | **2/2 passed**: the hole exists | browser-probe.log |

Environment notes:
- `W/ci-checks/node_modules` has no `@xyflow/react`, which release/1 now needs. tsc gave 24 errors there, all "cannot find module @xyflow/react".
- I linked `W/cinema-r1/node_modules` instead. Its package-lock.json is identical to this head's. With it, tsc gave 0 errors.
- The server was stopped with `mock-server.py stop review556b` (PIDs 30423/30430). Slot 6 was taken and released.
- No paid action was made. The browser probe's spend is one take row, written straight into that mock server's own workspace database.
- The worktree is left clean: `git status` shows only ignored build files.

## The first review's findings, checked again
| # | Was | Now | Proof |
|---|---|---|---|
| M1 | Workspace budget enforced, screens said "No cap" | **Fixed for the cap.** The gate, `/api/projects`, `/api/projects/[id]`, `/api/productions` and `/api/workbench/budget` all carry 400 cr from the workspace budget. Settings says "of the workspace budget" and offers Unlock, Set own cap and Lock again. What is *spent* still differs between screens, and that is older than this PR (L1 below). | R1, R2 |
| M2 | A stale unlock silenced the 80 % ask for good | **Partly fixed.** A cap or budget change re-locks the production and re-arms the warning (`lib/caps.ts:215-222`, `app/api/projects/[id]/route.ts:63,69`, `app/api/settings/route.ts:44-51`). `budgetAsk` still asks below the cap when unlocked (`lib/caps.ts:204`). **But an Unlock is not tied to the cap it was given for** (M1 below). | R3, R3b |
| L3 | Container cap could be set by a member or a token | **Fixed** (`app/api/productions/[id]/route.ts:15-18`). `capCredits: null` is refused too. | people-only spec, R6 |
| L4 | Release accepted a token | **Fixed.** The token is refused before any read (`app/api/jobs/[id]/release/route.ts:27`). | people-only spec |
| L5 | Saves as you type | **Fixed.** A field saves on blur, on Enter or on Done (`BudgetSection.tsx:86-98,140-150`). The browser spec proves that "4" stays unsaved. | rules browser |
| L6 | "logged with your name" | **Fixed in the UI** ("Saved · last changed by you"). The PR *description* still claims the opposite (L6 below). | GitHub read of #556 |
| L7 | Ask an admin: no check, no rate limit | **Mostly fixed.** The server now judges the step, and asks are limited per person and step every 10 minutes. The over-cap test uses a different basis from the gate, and refused asks are not counted (L4 below). | R4 |
| L8 | Tests did not use the real gate | **Fixed.** `demo-gaps-l4-budget-gate.spec.ts` reserves through `reserveGenerationSpend`. Ask-admin's `over` is still stubbed in the PR's own test. | read |

## Findings

### MEDIUM

**M1. An Unlock is not tied to the cap it was given for. A stale Unlock unlocks a new, higher cap, and spend runs past it with no person's unlock for that cap.**
- **Where:**
  - `app/api/projects/[id]/route.ts:71-72`: `capUnlocked` is written as given. It names no cap and does not check that the production is at a cap.
  - `components/graphite/settings/rules/RulesSection.tsx:147,161,184-185`: Each production reads `/api/projects` only when the fold opens or after its own PATCH, never after Budget and cap saves.
  - `app/(app)/projects/[id]/page.tsx:269`: the old page's Unlock toggle has the same gap.
- **Scenario (one admin, one screen, proven in the browser by R3b):**
  1. The budget is 10 cr, and a production has spent 20 cr. Settings › Each production reads "20 of 10 cr · at the workspace budget", with Unlock.
  2. The admin opens Budget and cap, sets 100,000, presses Enter, then Done. The server re-locks the production. Its cap is now 100,000.
  3. Each production still shows "of 10 cr" and Unlock.
  4. The admin presses Unlock. The server sets `cap_unlocked=1` under the 100,000 cap.
  5. At 100,000 cr the gate lets every take through (`lib/caps.ts:44`). The 80 % ask stays only for Atomik Auto drafts.

  The same happens when a second admin, or a second tab, changes the cap or the budget between someone's view and their Unlock (unit probe R3, through the real gate). That is the race in check 2.
- **Fix:**
  - The Unlock sends the cap it was shown, e.g. `{ capUnlocked: true, forCap: 10 }`. The route compares that with the effective cap (`projectCap`) and refuses with 409 "The cap changed to N cr: look again" when they differ, or when the production is not at its cap.
  - In the same change, re-read Each production after Budget and cap saves (e.g. key the `useRead` on `rules.budget`, or call `read()` from `rules.retry`).

### LOW

**L1. (Older than this PR; it is what is left of the old M1.) The figure for what a production has spent differs between screens. Settings can say "N cr left" with no Unlock while the gate refuses.**
- **Where:**
  - `app/api/projects/route.ts:116` and `lib/productions.ts:111` count `generations` only (`billedCreditsSum`).
  - The gate (`lib/generationRequests.ts:449`) and `/api/workbench/budget` (via `spentBy`, `lib/caps.ts:76`) also count meter-only jobs. Atomik planning jobs are reserved on the production with no take row (`lib/workbench/atomik-server.ts:414`).
- **Proof:** R2.
  - One meter-only job of c cr: the gate counts c spent, `/api/projects` 0 and `/api/productions` 0.
  - Settings reads "c cr left of the workspace budget", and `atItsCap` is false, so there is no Unlock.
  - The next job is refused: "… An admin can unlock it or raise it."
  - On the board, Record (from `/api/productions`) and the plan card's budget (from `/api/workbench/budget`) show different figures for "used".
- **Impact:** the gate fails closed (refusals only), and Set own cap still works.
- **Fix:** read `spentBy("project_id", ids)` for the credits figure in both lists, which are already batched.

**L2. Narrow windows where a new cap and an old unlock are both live.**
- `app/api/projects/[id]/route.ts:62→63` (and `:68→69`) writes the new cap, then re-locks, in two statements.
- `app/api/settings/route.ts:46→50` writes the budget, then re-locks.
- A reservation in between (`lib/generationRequests.ts:371` reads `projectCap` outside the billing lock) sees the new cap with the old unlock.
- **Fix:** re-lock first (this fails closed), or do it in one statement (`SET cap_credits=?, cap_unlocked=0, cap_warned_at=NULL`).

**L3. Ask an admin decides "over the per-shot cap" from the one render's quote, not from the shot's running total that the gate and admission use.**
- **Where:** `lib/control-room/ask-admin.ts:54-58,84`.
- **Scenario:** a step paused "admin" at send time (`lib/workbench/rig-agent-runs.ts:439`). The shot already holds 45 cr, and this take is 20 cr against a cap of 50 cr. The member is told "That step is not over the per-shot cap: it needs no admin" (409), and nobody is told.
- **Fix:** treat `step.state==="paused" && step.pause==="admin"` as over. Otherwise compare `shotCreditsSoFar + quote×band` with the cap.
- **Proof:** R4.

**L4. Ask an admin counts only asks that succeed.**
- **Where:** `lib/control-room/ask-admin.ts:75,95`.
- Refused asks (409 not-over, 404, unpriced) are never recorded, so a member can repeat them without limit.
- Each repeat runs `priceRender` as the run's owner (`rig-agent-runs.ts:252,259`). That is a free pricing, but it writes the shot mapping (`mapNodeShot`).
- The count also lives in one server instance's memory (`:60`). The comment there admits this.
- It spends nothing, and it leaks no price or other workspace's data, since it uses the tenant database only and the reply carries no figures.
- **Fix:** record the attempt before judging the step.
- **Proof:** R4 (10 refused asks in a row, all judged, none returned 429).

**L5. "Particl pauses at 80 % … and asks whether to continue" holds for Atomik Auto drafts only.**
- **Where:**
  - `components/graphite/settings/rules/budget-words.ts:26`;
  - `budgetAsk` is called only from `lib/workbench/rig-agent-runs.ts:363-364` when `run.mode==="auto" && draft`.
- A person's render, or an API/MCP token's, at 90 % gets a notice and goes on until the cap (`lib/caps.ts:45`).
- **Fix:** reword, e.g. "Atomik's Auto runs pause at 80 % (320 cr) and ask; anyone's own render is warned, and everything stops at the budget."
- **Proof:** R5.

**L6. The PR description still says the opposite of the code.**
- GitHub #556, read at 2fe96b9f (updated 13:23Z), says: "Changes save as they're typed (`PATCH /api/settings`, which logs who made each change)."
- Both parts are now untrue: the fields save on blur, Enter or Done, and there is no change log.
- `tests/unit/demo-gaps-l4-people-only.spec.ts` (first test) also still says "Every change is logged with who made it".
- The owner's rule forbids change-log claims that aren't true. Update the description.

**L7. Smaller points.**
- **(a) The old project page.** `app/(app)/projects/[id]/page.tsx:250-270` now receives the effective cap.
  - The prompt "Cap for this project" is prefilled with the workspace budget, so saving it unchanged quietly makes it the production's own cap.
  - Blank shows the budget again, with no "whose cap" word.
  - Unlock shows whenever there is any cap, not only at the cap.
- **(b) The house workspace.** Budget and cap are shown and editable in the house (non-credits) workspace (`RulesSection.tsx:80`), but `projectCap` ignores the budget there (`lib/caps.ts:143`). The budget route's re-lock also clears unlocks on house productions that have only a dollar cap (`lib/caps.ts:220`, `WHERE cap_credits IS NULL`). This reaches the unbilled house workspace only.
- **(c) A flaky floor check.** `tests/demo-gaps-l4-rules-workbench.spec.ts:34-36` (`panelFloors`) measures the controls as soon as the panel is visible. On a cold webpack dev server it failed once at 390x844. Every control measured under 44 px, while the failure screenshot shows them correctly sized. Wait for a settled box (e.g. `expect.poll`) before measuring.
- **(d) Test gaps.**
  - The PR's ask-admin test stubs `over`, so the real `overCap` is untested (R4 exercises it).
  - Nothing covers a stale Unlock (M1) or the spend mismatch (L1).

## Checks asked for
1. **Cap equality (M1). Holds.** Every route and screen shows the gate's cap (R1).
   - What is spent differs: the gate and the plan card count meter-only jobs, while Settings and Record do not (L1).
   - A path where the screen says there is room but the gate refuses: L1.
   - The reverse, a screen saying stop while the gate allows: only the house workspace's budget (L7b).
2. **Unlock tied to its cap (M2). Not fully.**
   - Re-lock on any change to the own cap, the dollar cap or the workspace budget: **yes** (R3 control steps; `settingsRoute.spec`).
   - Unlock and cap change at the same time, or a stale screen: **the unlock lands on the new cap** (M1).
   - A budget change while a render reserves: a window of milliseconds (L2).
   - So an unlock can let spend past a new, higher cap: **yes, M1.**
3. **Writers of caps, budgets, unlocks, top-ups and withdrawals.** Every writer was grepped:
   - `cap_credits`, `cap_usd`, `cap_unlocked` and `setSetting`;
   - `/api/settings` (requireAdmin plus scope), `/api/projects/[id]`, `/api/productions/[id]`, `/api/topups` (requireAdmin), `/api/workspaces/topups` (token and member refused), `/api/admin/topups` (super admin), `/api/tokens` (requireSession), `/api/jobs/[id]/release`.

   None is reachable by a token. None is reachable by a member, except the old page's read-only display.
   - `POST /api/projects` sets only the platform default cap.
   - `POST /api/productions` sets no cap.
   - Out of scope and older than this PR: render tokens can still claim Atomik steps (`app/api/atomik/steps/[id]/claim`, requireRender). That is spend by a token, not a cap, budget or unlock.

   R6 confirms that a member and a token are refused on every cap, unlock and settings key.
4. **Ask an admin.**
   - Judged by the server: yes, though on a different basis from the gate (L3).
   - Rate limit per person and step: yes, but refused asks are not counted and the count is per instance (L4).
   - No price leaks to another workspace: the tenant database only, and no figures in the reply.
   - People only: `requireSession`, request scope, and `isPersonId`.
5. **L5/L6 copy and behaviour.** The panel's behaviour and copy are right. The 80 % line overclaims (L5), and the PR description is stale (L6). L8: the budget gate test uses the real gate.
6. **Gates.** tsc 0. Touched unit specs 78/78. Probes 6/6 unit and 2/2 browser. Money and rules browser specs 13/14 then 6/6: one flake (L7c).

No vendor cost or margin appears in any new string or reply. A grep of the PR's added lines is clean.

## Probes (S/demo/review-556b-probes/)
- `review556b-probes.spec.ts`:
  - R1: one cap everywhere (passes, so it is fixed);
  - R2: spend mismatch (open);
  - R3: stale unlock through the real gate (open);
  - R4: ask-admin basis and counting (open);
  - R5: the 80 % copy (open);
  - R6: refusals for members and tokens (fixed).
- `zz-review556b-browser-workbench.spec.ts`: R3b, one admin on Settings, end to end (open).

## Needs the owner's yes (every behaviour change in the PR)
1. A new workspace setting, "Budget per production", is blank by default. A production with no cap of its own is stopped at it, just as at its own cap.
2. In an Atomik Auto run, a cheap draft that would bring the production to 80 % of its budget (or the share set) now waits for a person's tap. Other renders do not pause.
3. Changing a production's cap, or the workspace budget, re-locks every production it applies to and re-arms the "near the cap" warning. Earlier unlocks are dropped.
4. An admin's unlock no longer silences the 80 % ask below the cap. It only lets work past the cap.
5. Settings › Each production shows the cap actually enforced, whose cap it is, and Unlock wherever the gate can refuse. It adds "Set own cap" and "Lock again".
6. API and MCP tokens, even an admin's, can no longer set or unlock a production's cap, request or withdraw a top-up, or release a held take.
7. Members and tokens can no longer set the cap on a production's container (the old Productions page).
8. "Before an admin" (the per-shot cap) must be a whole number of credits from 1. Before, nonsense was stored and read back as 50.
9. The Budget and cap panel saves a field when it is left or Enter is pressed. "Undo changes" writes back what was there when the panel opened.
10. A new "Ask an admin" button notifies the owner and admins about a step over the per-shot cap, or about the rules. It is limited to once per person and subject every 10 minutes, and it spends and changes nothing.
11. New board money states:
    - Short, with "Top up · N cr · $N" opening Settings;
    - Needs an admin;
    - Engine unavailable, with a free "Move to …";
    - A take failed, saying "Nothing billed" only on the provider's own outcome;
    - Paused at 80 %, with "Continue · N cr".
12. Retry on a take card now shows the server's quote, "Retry · N cr", before it opens Make.
13. A new read, `GET /api/workbench/budget`, gives any signed-in person or token in the workspace a production's cap, used figure and pause point, in credits.

---

# Round 3: re-review at c8fc35cccf9065c463b40b063dcfe01072a2739f (the author's fixes, 2fe96b9f..c8fc35cc)

**VERDICT at c8fc35cc: PASS. No high or medium findings; 3 low notes.**

**The release/1 merge is NOT pushed yet.** At 14:2x UTC, origin/money/gaps-l4 was still c8fc35cc, and GitHub shows #556 as "dirty". Trying the merge read-only (`git merge-tree c8fc35cc origin/release/1@e87181d6`) gives conflicts in three files:
- `lib/workbench/rig-agent-runs.ts` (the money gate);
- `components/graphite/board/cards/plan/PlanCard.tsx`;
- `components/graphite/board/cards/plan/use-plan.ts`.

So the merge commit **will** change money logic, and it needs its own check before #556 goes anywhere (see "What the merge must keep" below). This PASS covers c8fc35cc only.

Same rules as before: read-only, worktree `W/rev-556b` detached at c8fc35cc, `node_modules` linked from `W/cinema-r1` (identical lockfile). No commits, pushes, comments or paid actions. Slot 5 was taken and released. Server `review556c` (fresh database, port 4797) was stopped with `mock-server.py stop` (PIDs 57541/57552).

## Gates (logs in S/demo/review-556b-probes/)
| Gate | Result | Log |
|---|---|---|
| tsc | **0 errors** | round3-tsc.log |
| Touched and new unit specs (the same 9 files) | **80/80 passed** | round3-unit.log |
| Money and rules browser specs, 1440x900 + 390x844, fresh server `review556c`, `PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/review556c/platform.db` | **16/16 passed**, including the author's new "one screen, two tabs" spec. The earlier flake did not recur. | round3-browser.log |
| My round-2 probes, re-run (serial mode off, so each runs alone) | R2, R3, R4 and R5 now **fail at the assertion that proved each hole**, so the holes are closed. R1 and R6, which were "fixed" probes, still pass. | round3-old-probes.log |
| My browser probe R3b | **Fails** at both sizes: the hole is closed. After a new budget, Each production reads "30 of 100,000 cr · 99,970 cr left of the workspace budget", with no Unlock. | round3-browser-probe.log |
| New race probes `review556c-race.spec.ts`, 25 and then 40 rounds each (the second run with 0–12 ms of random delay, so both orders happen) | **4/4 hold**, see below | round3-race.log |

Where each old probe now fails:
- **R2:** `/api/projects` reports the 8 cr meter-only job (expected 0).
- **R3:** the stale Unlock gets 409 (expected 200).
- **R4:** an ask about a step paused for an admin is accepted (expected "needs no admin").
- **R5:** the copy now says "Atomik's Auto runs pause at 80 % … a person's own render is warned and goes on to the budget".

## Trying to break unlockAtCap
`lib/caps.ts` (`unlockAtCap`, `setOwnCap`, `setWorkspaceBudget`):
- The Unlock reads the own cap and the budget, compares them with `forCap`, checks the production is at its cap, and writes `cap_unlocked=1`, all in one write transaction.
- `setOwnCap` changes the cap and re-locks in one UPDATE. SQLite evaluates SET expressions against the old row, so a write of the same cap keeps the unlock.
- `setWorkspaceBudget` writes the setting and the re-lock in one transaction.

The race probes, each run as the real lib calls at the same moment:
- **C1: Unlock (for budget c) and new budget 3c at once.** Both orders occurred: run 1 had 25× "refused 409", run 2 had 40× "unlock, then re-locked by the budget". Every round ended locked on 3c, with no errors and no SQLITE_BUSY.
- **C2: Unlock (own cap c) and new own cap 3c at once.** Both orders occurred, and every round ended with cap 3c and locked.
- **C3: three Unlocks and two cap changes interleaved on one production, 40 rounds.** Whenever it ended unlocked, the cap was the one the unlock named (c). There were no errors.
- **C4: a budget change while reservations are in flight, 40 rounds.**
  - After each change the production is re-locked, and an Unlock for the old figure is refused.
  - No reservation failed for any reason other than the cap.
  - In this process the next job is judged on the new budget at once, because the write drops the settings memo.

Read-through of the remaining interleavings:
- `projectCap` (`lib/caps.ts:132-152`), which the gate uses, reads the project row and then the budget separately. A reservation can therefore pair the old unlock with the new budget. That pairing only ever **allows**, and the unlock it carries was a person's, given for the old cap. Unlocked with the old cap also allows. So the outcome equals one where the reservation came just before the change. The other mix (re-locked row, old budget) can only refuse more, unless the budget was lowered (next point).
- Settings are memoised for 10 s per server instance (`lib/settings.ts:95-111`). `setWorkspaceBudget` drops the memo only on the instance that wrote it. **Low N1 below.**
- `unlockAtCap` reads what has been spent before its transaction (`lib/caps.ts:278-279`). Spend only rises, except when a failed job is settled at 0. So a stale figure can only refuse (fail closed), or, after a refund, allow an Unlock a hair under the cap. That Unlock is for the same cap, and the gate still stops nothing below the cap. It is harmless.

## Round-2 findings
| # | Status at c8fc35cc |
|---|---|
| M1 (stale Unlock) | **Fixed.**<br>• `app/api/projects/[id]/route.ts:68-75`: an Unlock without `forCap` gets 409; unlock and check share one transaction.<br>• Settings re-reads the list on a budget change and after any refusal (`RulesSection.tsx:159-171`).<br>• Proven by R3/R3b failing, C1–C3, and the author's two-tabs spec. |
| L1 (spent figure) | **Fixed.** `/api/projects` (`withCaps`, which also re-reads cached rows) and `listProductions` use `spentBy` (R2 fails). |
| L2 (windows) | **Fixed.** `setOwnCap` is one statement; `setWorkspaceBudget` is one transaction. |
| L3 (ask basis) | **Fixed.** A step paused for an admin counts as over; otherwise the shot's running total plus this render (`lib/control-room/ask-admin.ts:56-69`). |
| L4 (ask counting) | **Fixed.** Every ask is counted before it is judged (`ask-admin.ts:88-89`). |
| L5 (copy) | **Fixed** (`budget-words.ts:21,28`). |
| L6 (PR body) | **Fixed.** The GitHub body at c8fc35cc says fields save "when it is left or Enter is pressed … there is no change history". |
| L7a (old project page) | **Fixed.**<br>• The prompt prefills only the production's own cap and says "blank follows the workspace budget".<br>• Unlock shows only at the cap and sends `forCap`; Lock again shows when unlocked (`app/(app)/projects/[id]/page.tsx:250-277`). |
| L7b (house workspace) | **Fixed.**<br>• Budget is read-only there with "not billed in credits: no budget per production applies here" (`BudgetSection.tsx:31,42-45,143-148`).<br>• `setWorkspaceBudget` re-locks nothing there. |
| L7c/d (flake, tests) | No flake this round. The author added real-gate tests for the stale Unlock, the meter-only spend and the real `overCap`. |

## Low notes (none blocks)
- **N1. A lowered budget takes up to 10 s to reach other server instances.**
  - **Where:** the settings memo in `lib/settings.ts:95,101-111`, read by `projectCap` via `workspaceBudget`. The drop on write only reaches the instance that wrote.
  - **Effect:** after an admin lowers the budget, another instance can let jobs through up to the old budget for 10 s. This is older than this PR and applies to every setting (per-shot cap, approval rule).
  - **Fix if wanted:** read the budget in the same SELECT as the project row in `projectCap`, which also removes the two-read pairing above.
- **N2. Counting every ask means an early refused ask blocks a real ask for 10 minutes.** A member who asks before the step is over the cap gets "You asked about this N minutes ago" once it is. The step still sits in Approvals for admins, so nothing is lost.
- **N3. Fail-safe edges in `unlockAtCap`.** The spend read is outside the transaction (see above), and `forCap` accepts any number, including `true` read as 1.

## What the merge with release/1 must keep (check it when it is pushed)
The conflict in `lib/workbench/rig-agent-runs.ts` (function `gate`) is between two changes:
- this PR's `budgetAsk` (the 80 % ask, in the Auto-draft branch only);
- release/1's plan approval (#555): `coverage(approval, …)` approves a render with no tap whenever the person's plan approval covers it, *before* the Auto branch is reached.

If the merge keeps `budgetAsk` only in the Auto branch, renders under an approved plan will run past 80 % of the budget with no ask. This PR's own description says "Under #555 the 80 % pause also has to cover renders inside an approved plan".

When the merge is pushed, check that:
1. `budgetAsk` runs before the plan-approval `coverage` branch (or the owner says a plan approval may pass the 80 % mark).
2. The gate's cap check and `projectCap` are unchanged.
3. `PlanCard.tsx`/`use-plan.ts` still pass the budget read to `planMoneyState`.
4. `rigAgentRuns.spec.ts` covers the budget ask with an approved plan.

## Needs the owner's yes (updated, plain words)
1. Each workspace gets a "Budget per production", empty by default; a production without its own cap stops at it.
2. Atomik's Auto drafts stop and ask a person at 80 % of the budget (or the share set); people's own renders are only warned.
3. Whether renders inside a plan a person has approved should also stop and ask at 80 % (this decides the release/1 merge).
4. Changing a production's cap, or the workspace budget, re-locks those productions and re-arms the near-the-cap warning.
5. An admin's Unlock now names the cap it was shown; it is refused if that cap changed or the production isn't at its cap yet.
6. An unlock lets work go past the cap, but no longer skips the 80 % ask below it.
7. Settings › Each production shows the cap that is enforced, whose it is, and what was used (Atomik planning included), with Unlock, Set own cap and Lock again.
8. The board's Record and Settings now count Atomik's planning jobs in what a production used, so some figures will rise.
9. API and MCP tokens can no longer set or unlock caps, request or withdraw top-ups, or release held takes.
10. Members and tokens can no longer set a cap on a production's container.
11. The per-shot cap must be a whole number of credits, 1 or more.
12. The budget fields save when you leave them or press Enter, and Undo puts back what was there.
13. A new "Ask an admin" button tells the owner and admins, at most once per person and subject every 10 minutes, and spends nothing.
14. New money states on the board: short of credits with a Top up price, needs an admin, engine unavailable with a free Move, take failed with the provider's real outcome, paused at 80 % with Continue at its price.
15. Retry on a take card shows its price before opening Make.
16. Anyone in the workspace, tokens included, can read a production's budget, use and pause point, in credits only.
17. The house workspace, not billed in credits, shows no editable budget.

---

# Round 4: the release/1 merge, eff8eff41d2305725c5201d218b1ffccb6fea08e (parents c8fc35cc + e87181d6, plan approval #555)

**VERDICT at eff8eff4: FAIL. 1 medium, 2 low. No high.**

The merge weakens none of #555's plan approval, and none of #556's caps and unlocks. But under #555, a person's plan approval carries renders past the 80 % budget ask without a stop. This PR's own description says that ask "has to cover renders inside an approved plan". The settings copy and the description also still say things that are no longer true.

## What the merge changed (read with `git show --remerge-diff eff8eff4`)
- **`lib/workbench/rig-agent-runs.ts` (`gate`).** The resolution keeps #555's gate intact: re-price, moved fingerprint, tap, the run limit, credits, then plan `coverage`. It adds this PR's `budgetAsk` only in the Auto-draft branch, on #555's renamed `quoteCredits`. Nothing else in the gate changed.
- **`use-plan.ts`.** `act` returns `Promise<boolean>` (#555), and `rule`/`admin` are kept (#556).
- **`PlanCard.tsx`.** #555's `gate` sits beside #556's `short`/`paused`/`acting`. The short line drops the balance line when the money state is "short".
- **`MoneyStates.tsx`.** The admin, unavailable and short states now place the plan model's own button, with its label (`Approve · T` / `Approve the rest · T` / `Build · free`) and its `data-spend`. They no longer word it themselves.
- **No other money code moved:**
  - `git diff e87181d6 eff8eff4` on `plan-approval.ts`, `rig-agent.ts`, `generationRequests.ts` and `runLimit.ts` is empty, so #555's core is exactly release/1's.
  - `git diff c8fc35cc eff8eff4` on `lib/caps.ts`, the projects, settings, productions, release, top-up, budget and ask-admin routes, and Settings is empty, apart from #555's own additions: the sample spend guard in `generationRequests.ts` and control-room approvals.

## The checks the coordinator asked for
- **#555 is not weakened.**
  - The 2T ceiling is still set as the run's limit and enforced in the reservation.
  - Approving is still people-only: `isPersonApprover` and `found.owner` in `rig-agent.ts:530-532`, plus the table's CHECK and triggers.
  - Quote fingerprints still guard both the approval and each render.
  - `planApproval.spec.ts` passes in full on the merge.
- **An approved plan's renders still hit the reservation's cap and budget.** `planApproval.spec` "the caps still bite" uses the own cap. My probe P1 uses the **workspace budget**: under an approved plan, the render that would pass the budget is refused at the hold ("cap"), and nothing is reserved.
- **"Approve the rest" cannot approve an admin-only step.**
  - `planQuote` leaves a render with no admission out of the total and the covered list (`rig-agent.ts:111`).
  - `coverage` then says `NOT_IN_PLAN`, and the reservation's shot cap refuses anyway.
  - `planApproval.spec` "a step that needs an admin asks on its own…" passes on the merge, and the money spec's admin state shows the server's "Approve the rest · T".
- **#556's unlocks are not weakened.** My round-3 race probes C1–C4 re-ran on eff8eff4 and passed 4/4 (`round4-race.log`).

## Gates at eff8eff4 (logs in S/demo/review-556b-probes/)
| Gate | Result | Log |
|---|---|---|
| tsc | **0 errors** | round4-tsc.log |
| Unit: the 9 touched specs plus `planApproval`, `demo-s04-plan-model`, `demo-s10-phone-model`, `demo-s12-no-spend`, `rigAgent` | **145/145 passed** | round4-unit.log |
| Browser: money, rules, `demo-s04-plan`, `demo-s10-phone-plan`, at 1440x900 + 390x844 | **30 passed, 12 skipped, 0 failed**. The skips are the specs' own viewport skips: s10 is phone-only, and three s04 tests are large-screen-only. | round4-browser.log |

The browser specs ran on a fresh server `review556d` (port 4797, `PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/review556d/platform.db`). The server was stopped (PIDs 65980/65990), and slot 6 was taken and released.

## Findings

### MEDIUM
**R4-M1. An approved plan runs past 80 % of the budget with no ask. The PR's description and the Settings copy say otherwise.**
- **Where:** `lib/workbench/rig-agent-runs.ts` `gate`. The `approval` → `coverage` branch returns `CONTINUE` before the only `budgetAsk` call, which sits in the Auto-draft branch below it. That holds in Ask **and** Auto mode, since a plan can be approved in either.
- **Proof:** probe P1 (`zz-review556d-plan.spec.ts`, which uses `planApproval.spec`'s harness).
  1. A three-shot plan is approved, and the workspace budget is set to planning + 2.5 renders.
  2. Before shot 2, `budgetAsk` reports the pause.
  3. Shot 2 is still admitted with no tap.
  4. Shot 3 is refused at the budget.
  So the 100 % budget holds, and the 80 % stop does not apply.
- **Untrue text:**
  - The PR description still says "Under #555 the 80 % pause also has to cover renders inside an approved plan, which run without a tap", "Ask runs already ask at every render", and "This branch is built against release/1 as it is … carry no figure".
  - Settings says "Atomik's Auto runs pause at 80 %…" (`budget-words.ts:21,28`). An Auto run with an approved plan does not pause.
- **Fix, either:**
  - (a) Call `budgetAsk(run.productionId, quoteCredits)` before the `coverage` branch, so any covered render that reaches the share waits for a person's Continue. Add a `planApproval`/`rigAgentRuns` test for it.
  - or (b) the owner says yes to "a plan approval may run to the budget", and the copy and description are changed to say so: "Unapproved Atomik Auto drafts pause at 80 %; an approved plan runs to the budget."

### LOW
- **R4-L1. A plan can be approved for more than the production has left of its cap or budget.** `approveRigAgentPlan` checks the balance only (`rig-agent.ts:546`). The plan then stops part-way at the cap, with a "cap" refusal. This fails closed, but the plan gate could say "Over this production's budget by N cr" before Approve.
- **R4-L2.** The round-3 low notes N1–N3 (the settings memo on other instances, the ask window, `forCap` edges) stand. Nothing in the merge changes them.

## Needs the owner's yes (updated after the merge, plain words)
1. Each workspace gets a "Budget per production", empty by default; a production without its own cap stops at it.
2. Atomik's Auto drafts stop and ask a person at 80 % of the budget (or the share set); people's own renders are only warned.
3. Whether a plan a person has approved should also stop and ask at 80 % of the budget. Today it does not; it runs until the budget refuses.
4. A plan can be approved even when its total is more than the production has left; the budget then stops it part-way.
5. Changing a production's cap, or the workspace budget, re-locks those productions and re-arms the near-the-cap warning.
6. An admin's Unlock names the cap it was shown, and is refused if that cap changed or the production isn't at it yet.
7. An unlock lets work go past the cap, but no longer skips the 80 % ask below it.
8. Settings › Each production shows the cap that is enforced, whose it is, and what was used (Atomik planning included), with Unlock, Set own cap and Lock again.
9. Settings and the board's Record now count Atomik's planning jobs in what a production used, so some figures will rise.
10. API and MCP tokens can no longer set or unlock caps, request or withdraw top-ups, or release held takes.
11. Members and tokens can no longer set a cap on a production's container.
12. The per-shot cap must be a whole number of credits, 1 or more.
13. The budget fields save when you leave them or press Enter, and Undo puts back what was there.
14. A new "Ask an admin" button tells the owner and admins, at most once per person and subject every 10 minutes, and spends nothing.
15. New money states on the board use the plan's own buttons and prices: short of credits with Top up, needs an admin with "Approve the rest · T", engine unavailable with a free Move, take failed with the provider's real outcome, paused at 80 % with Continue at its price.
16. Retry on a take card shows its price before opening Make.
17. Anyone in the workspace, tokens included, can read a production's budget, use and pause point, in credits only.
18. The house workspace, not billed in credits, shows no editable budget.
