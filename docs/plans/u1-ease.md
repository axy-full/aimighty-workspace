# Plan: U1, the rest of the ease work (Phase 2)

Status: plan only, written 6 October 2026. No product code. **Do not merge before Friday 9 October.**
Scope source: `docs/particl-sow.md` v2 (branch `docs/sow-v2`) § 3.6, with the package prompt in `docs/handover-2026-10-05.md` Part D ("U1: Easy by default") and § B4.4.
Rules that bind this package: CLAUDE.md rules 6, 11, 13, 14, 15, 17; the SOW's § 0.

"The rest" means what Release 1 does **not** already deliver. Release 1 (Home, the board, Make, Atomik, control room, Settings, phone, autosave) is on branches and merges Thursday 8 October after the owner's preview check. This plan was written against `origin/demo/integration` (08368b84) and `origin/demo/board-everyone` (c4c1ff7c) so it does not plan twice what is already built there. Where a Release 1 piece is only *partly* there, the plan says which part is left.

## 1. Goal and done-when

**Goal.** A stranger with an invite gets from the email to an approved first render in five minutes without reading a paragraph, and nobody is ever surprised by a charge. The money moments (approve a plan, check the balance, a failed step, a retry) behave the way rule 14 says, the person can walk away and be told when it is done, and the product measures how easy it really is, with ids and timings only.

**Done when:**
1. A Playwright test drives the real screens, mocked, as a new person with an invite: sign-up, Home, a first project, a plan, one approval, a first render, an approved take. It passes on desktop (1440×900) and phone (390×844) and runs on every UI PR. It is faster than five minutes and uses no more taps than the budget it records.
2. One tap on a plan approves its listed steps at their listed prices, up to its total, **including a stated fix allowance** (at most two fixes per shot). Anything outside it asks again. The server enforces this, not the screen.
3. The balance is checked against the plan's total **on the server** before the plan can start, and a short balance offers Top up right there.
4. A step that failed and cost nothing says "Nothing billed" and offers Retry, which re-runs it under the same approval. A step that was charged says what it cost.
5. A person can say "Notify me when done" on a plan, a take or a render, on desktop and on a phone, and is told when it finishes or needs them.
6. Review mode works with the keyboard, compare (side by side and slider) and, on a phone, a swipe, for takes, frames and ad and clip versions, with a test at five sizes.
7. The product records time to first render, approvals per session and where people stop, as ids and timings only, never prompt text, and the owner can read them in `/admin`.
8. A test proves Atomik, a skill and an MCP caller cannot approve a plan, raise the budget or top up.

## 2. What exists today (and what is reused)

### Already on `main` (a00226e1)
| Piece | Where |
|---|---|
| The agent's run: asks inside a limit a person approves, plans, builds, renders step by step, settles | `lib/workbench/rig-agent.ts`, `rig-agent-runs.ts`, `rig-agent-plan.ts`, `rig-agent-store.ts` |
| Per-render approval with the price's fingerprint; "Retry" on a paused step; "Price again"; skip; raise the limit; only the person who asked may approve | `renderRigAgentStep`, `skipRigAgentStep`, `raiseRigAgentLimit` in `rig-agent.ts` |
| Ask and Auto, the per-job line, the approval line | `lib/workbench/rig-agent-limits.ts`, `lib/approvalRule.ts` (`JOB_APPROVAL_LINE_USD`, the "cap" rule) |
| The run limit arithmetic and reservation (tenths of a credit, worst case, bands) | `lib/runLimit.ts`, `lib/generationRequests.ts` |
| The ledger: what a failed take cost, "billed / not billed / not known yet" per step | `recordTakeEnd`, `rig_agent_steps.outcome`, `credits_settled`; `lib/providerOutcome.ts`, `lib/errors.ts`, `lib/jobState.ts` ("The balance is at zero", action "Top up") |
| Web Push, VAPID, four notification kinds, per-person choices | `lib/push.ts`, `lib/push-client.ts`, `lib/notifyPrefs.ts`, `app/api/push/*`, `public/sw.js`; a take finishing already notifies its author (`lib/jobs.ts`) |
| Client review links: read-only approved takes, no sign-in, hashed token, expiry, revoke | `lib/shares.ts`, `tests/review-link-workbench.spec.ts` (client approve and comment are **not** built) |
| Sign-up by invite, invite table, local test helpers | `app/(auth)/signup`, `app/(auth)/invite`, `signup_invites` in `lib/platform.ts`, `tests/helpers/workbenchLocal.ts` (`signInLocally`) |
| An existing five-minute test | `tests/onboarding.spec.ts`: **API only** (no screens), local only, run by `npm run test:onboarding`, **not in CI** |
| The mocked planner and mocked engines | `mockPlannerModel` in `rig-agent-planner.ts`; `ENGINE_MOCK=1` (`lib/mock.ts`) |
| Browser-test setup | `playwright.workbench.config.ts` and `playwright.customer.config.ts` with the five sizes; 12 CI shards in `.github/workflows/verify.yml`; phone floor helpers `tests/phoneFloors.ts` |

### Already on the Release 1 branches (not merged yet)
| Piece | Where | What is left for U1 |
|---|---|---|
| Plan card: steps, total, balance line ("Short by N cr"), Top up button, the fix allowance as a line | `components/graphite/board/cards/plan/model.ts` (`fixAllowance`, `balanceLine`, `SHORT_LINE`), `PlanCard.tsx`, phone `phone/PlanScreen.tsx` | The allowance is **information only** (its own comment: "never added to the total") and the balance check is **on the screen only** (`blocked`). Prices come from client-side pre-quotes (`estimates.ts`). Each render still asks at its own price ("decision 27"). **This is the main gap** |
| Take card: "Nothing billed" only when confirmed; failed take says why; Retry | `board/cards/take/TakeCard.tsx`, `take-model.ts` | Retry "hands the recipe to Make to be priced again", not "re-runs it under the same approval" |
| "Notify me" on the phone Home, Settings switch | `phone/NotifyButton.tsx`, `settings/*` | Nothing on the board or a plan card; no notification for "the run needs you" or "the run finished" |
| Review mode: J K A R Space C, side by side, slider, focus trap, reject with a reason; phone review with swipe right to approve, left to send back | `board/review/ReviewMode.tsx`, `review-model.ts`, `phone/ReviewScreen.tsx` (`swipeVerdict`) | Audit at five sizes; cover frames, ad versions and clips; undo for a swipe |
| Balance, Top up in Settings › Plan & credits; "Waiting for you" strip with Top up | `settings/credits`, `home/WaitingStrip.tsx` | Top up today is a request approved in `/admin` (`lib/payments.ts` is manual; Stripe is last) |
| Home, templates, "Ask Atomik how", autosave, Make with the engine line | `home/*`, `make/*`, `atomik/*` | Nothing: Release 1 |

### Not anywhere
- A server-priced plan: the plan is priced step by step as the run reaches each step.
- A plan-level approval record.
- Any ease metric. `lib/board/ease.ts` is animation easing, not this.

## 3. The design

### 3.1 The five-minute test (lands first)
- **A new spec, `tests/five-minute.spec.ts`**, with its own config, `playwright.five-minute.config.ts`, two projects: desktop 1440×900 and phone 390×844. Kept out of the 12-shard workbench and customer matrix on purpose: CI notes in `verify.yml` show those shards are memory-bound, and this test needs a fresh sign-up and a longer path. A separate CI job runs it on every PR that changes UI files (path filter), as its own check name.
- **It uses the real screens.** Seed one invite directly in the local platform database (as `tests/helpers/workbenchLocal.ts` does), then drive the browser: the sign-up page, Home, "What are we making?", a template, Atomik's questions if any, the plan card, **one** approval, the render (mock engine), review, approve. On the phone, the same path through the phone screens (Home, plan approval, full-screen review with a swipe).
- **What it asserts:** it ends in an approved take; wall time under five minutes (the mock engine makes the wall time small, so the real guard is the next two lines); the number of taps from sign-up to approved take is no more than the **tap budget** stored in the spec (set from its first green run, lowered when U1's plan approval lands); on every screen of the path there is exactly one primary button and no visible text block longer than 25 words that the person did not write (rule 6: "without reading a paragraph"); text at least 12 px; phone targets at least 44 px; no horizontal overflow; no request to any paid route outside the mock (`forbidPaidWork` in `tests/helpers/workspaceFixtures.ts`).
- **It replaces** the API-only `tests/onboarding.spec.ts` as the rule-6 test; the old file is kept as a fast API smoke until the new one has run green for a week, then deleted in the same PR as nothing else.
- **Owner step:** make the new check name required in the repository's branch rules. Claude Code never changes repository settings.

### 3.2 A server-priced plan and the balance check
When the agent proposes a plan, the server prepares each render step through the existing free, repeatable `prepareGeneration` (the same call the run makes later) and stores each step's quote, fingerprint and worst case on the proposal. The plan's total is then the **server's** sum, not a figure the browser worked out. The proposal's own fingerprint (`planFingerprintText`) widens to cover these quotes. Before approval, the server refuses a plan whose total is above the balance (message and "Top up" action from `lib/jobState.ts`), and again at approval. A step with no price is listed as unavailable with its reason and is not part of the total (rule: a tool that cannot be priced cannot run). Top up, for a member, is the existing request to an admin; for an admin it is the same request page. It is a people-only action.

### 3.3 One approval per plan, with the fix allowance
Approving a plan creates one **plan approval** (additive table `rig_plan_approvals` in the workspace database, written by a signed-in person only):
- the run id, the proposal's fingerprint, who and when;
- each listed step: sequence, card, fingerprint, quoted price, worst case, whether it needs an admin;
- the total, and the **fix allowance** = 2 × the plan's shot prices, with a counter of fixes used per shot (at most two each);
- a closed-at time (a stop, an end, or "asks again").

How the money moves does not change: paid dispatch still needs an `ApprovedQuote` minted by the run engine and re-checked before dispatch. What changes is **what mints it**. For a listed step whose fresh quote still carries the approved fingerprint, whose price is within the rule's cap (or an admin approved it), and which is under the job line (guardrail 4: a job above it always asks), the engine records the person's plan approval as the step's approval instead of waiting for a tap. If the price moved, the step asks again ("This render's price changed. Look at it again."). A step not on the list (a new shot, another engine) asks. A fix draws from the allowance through one server function that refuses a third fix on a shot, a fix beyond the remaining allowance, or a fix priced above its shot's own price. The run limit becomes the plan's total plus its allowance plus the planning turn, set when the person approves and shown on the button; raising it later stays a person's action (`raiseRigAgentLimit`). Stop cancels queued steps and releases unspent holds, as today.

The button reads as the price, as the SOW draws it ("Approve · N cr", with "up to N cr more for fixes" beside it). The plan card shows which steps need an admin and who can approve them (`lib/approvalRule.ts`); a step above the cap waits in the control room's Approvals for an admin.

This is the approval primitive S2 (the LangGraph agent) and P6b's fixes build on. It lives on today's run so it can ship before S1; S1 later reads it into the project record ("every approval with its quote and settled cost").

### 3.4 "Nothing billed" with Retry
A failed step records what the provider did: billed, not billed, or not known yet (`outcome`). The card says "Nothing billed" only for *confirmed not billed*; otherwise it says what the ledger or provider reported. **Retry** on a step that cost nothing starts a new attempt with a new durable request key (the run already supports up to 8 attempts, each only after the earlier was proven never admitted or refused unbilled) **under the same plan approval and the same price**, with no new tap beyond pressing Retry. A retry is not a fix and does not draw on the allowance. A step that was charged shows what it cost; its Retry asks at its price. A take made in Make (outside a plan) has no plan approval: Retry shows the price once and asks.

### 3.5 Notify me when done
- A **Notify me** control on the plan card and on a take that is rendering, beside the progress. It makes sure this device is subscribed (the existing `usePushSubscription`), with the existing states (on, denied, add to Home Screen first, not set up, not supported) in plain words.
- Two new kinds in `lib/notifyPrefs.ts` (additive, on by default like the others): "A run needs you" and "A run finished". The run sends them at the moments it already records (`needs_you`, ended) through `lib/push.ts`.
- **The push text carries no prompt text.** Today a finished take's body is its prompt's first 120 characters; that text travels through the browser vendors' push services. New and changed notifications say only the shot code and the state ("Shot 2 v1 is ready", "Atomik needs you on shot 3"). Owner decision 6.
- Push works for people who are members of the workspace and wanted it; tenant isolation is tested on the recipient list.

### 3.6 Review mode
Mostly built. U1's work is to make it **complete and proven**: take cards, storyboard frames, ad versions and clips all open it; compare works wherever there are two versions; the phone swipe has an Undo toast and a button fallback for people who cannot swipe; reduced-motion respected; focus returns where it was. Then Playwright at five sizes, including keyboard on desktop and a touch swipe on phones. **Client review links** (approve and comment with no sign-in) are listed as an optional last PR because they open a door to people outside the workspace (owner decision 7).

### 3.7 Ease metrics, ids and timings only
- One table in the platform database (`ease_events`): a random event id, workspace id, a pseudonymous person id (the existing user id, never an email or name), a session id, a **step id from a fixed list**, a duration in milliseconds, a viewport class (phone, desktop), a time. Nothing else.
- The step list is a closed enum in code (invite opened, account made, first project, plan shown, plan approved, first render started, first render done, first take approved, and the screens people leave from). A unit test fails if a payload carries a free-text field, and a second test greps the recorder for any prompt field.
- Computed in `/admin`: time to first render (median and spread), approvals per session, and where sessions end (the last step reached). Retention 90 days, then deleted by the existing cron.
- Recording is off for workspaces flagged `internal` so the owner's own testing does not skew it.
- The same ids feed the five-minute test's tap budget so the test and the product agree.

## 4. PR-by-PR breakdown

Order follows the SOW ("the five-minute Playwright test on every UI PR"; handover: land the test first). One concern per PR. "Five sizes" means Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080, with no horizontal overflow, text at least 12 px and 55% white, targets at least 44 px on phones. Screenshots go beside the handoff for UI. Gates follow SOW § 0.

| # | PR | Tests | Gate |
|---|---|---|---|
| 1 | **The five-minute test** (`tests/five-minute.spec.ts`, its config, a CI job with a path filter, a tap budget file) | The test itself passes on 1440×900 and 390×844 against the integration build; a deliberately broken fixture (an extra primary button, a long paragraph) makes it fail, proving it bites; the old API test still passes | Owner's preview is not needed (tests only). Owner sets the required check |
| 2 | **Ease metrics** (recorder, closed step list, `/admin` read, 90-day purge, internal flag off) | Unit: closed enum, no free text, no prompt field, tenant scoping, purge, internal excluded; API: only a platform admin reads aggregates; Playwright: the admin read at five sizes | Independent review + owner's yes (cross-tenant data in the platform database) for the recorder; owner's preview for the `/admin` read |
| 3 | **Server-priced plan and the balance check** (quotes stored on the proposal, total from the server, balance refusal with Top up, on both the board and the phone plan screen) | Unit: total equals the sum of step quotes in tenths; a step with no price is unavailable and excluded; short balance refuses at proposal and at approval; fingerprint changes when a price changes; replay safe. Mocked run. Playwright at five sizes: plan card with "Short by N cr" and Top up, wraps, no overflow | **Independent review + owner's yes** (money); owner's preview for the UI |
| 4 | **Plan approval with the fix allowance** (`rig_plan_approvals`, engine mints from it, allowance counter, run limit set from the approval, the button as the price, who-can-approve lines) | Unit: approval math in tenths; **agent:\* and MCP callers refused**; a step approved by the plan runs with no tap; price drift asks; unlisted step asks; a step above the job line asks; a step over the cap waits for an admin; fix 1 and 2 draw, fix 3 refused, a fix beyond the allowance refused; replay of a lost reply approves once; stop releases holds; tenant isolation. Mocked run end to end. Playwright: board and phone approval, five sizes. **Tap budget in PR 1 is lowered here** | **Independent review + owner's yes** (money, approval path); owner's preview for the UI. The plan is reviewed by the owner *before* code (handover § B9.1) |
| 5 | **"Nothing billed" with Retry, under the same approval** | Unit: outcome mapping (billed, not billed, not known); retry uses a new key and the same approval; not counted as a fix; a charged failure shows its cost and asks. Mocked failing engine in Playwright at five sizes on the take card and the phone review | **Independent review + owner's yes** (money); owner's preview for the UI |
| 6 | **Notify me when done** (control on plan card and rendering take; two new kinds; neutral push text; tenant-safe recipients) | Unit: payload has no prompt text; recipients are the person who asked and members who chose it; admin-only kinds never reach members; a mocked push service. Playwright: the control's states (on, denied, install, not set up) at five sizes | Owner's preview (UI). Independent review for the recipient logic |
| 7 | **Review mode, complete** (frames, ad versions and clips open it; phone swipe undo and button fallback; reduced motion; keyboard help) | Playwright at five sizes: J K A R Space C; compare modes; touch swipe right and left; Undo; focus returns; never spends | Owner's preview |
| 8 | **Client review links: approve and comment** (optional; only on the owner's yes to decision 7) | Unit: token hashed, expiry, revoke, scope fixed at mint, rate limit, no session granted, tenant isolation, a comment cannot reach another production; Playwright at five sizes on the link page | **Independent review + owner's yes** (sign-in, tenant separation) |
| 9 | **Keep the docs true**: the SOW, CLAUDE.md rule 14 note on the plan approval, the old API test removed | Docs lint only | Owner reads |

PRs 1 and 2 can start at once. 3, 4 and 5 are in order (3 before 4 before 5). 6 and 7 are independent of the money PRs and can run beside them.

## 5. Dependencies

| Needs | For | Effect if late |
|---|---|---|
| **Release 1 merged** (Thursday 8 October) | The screens PRs 1, 3, 4, 5, 6, 7 draw on (board, phone, Home) | Written and tested against `demo/integration` first, rebased after merge |
| **A1** (registry) | "Approve plan", "Retry", "Top up request", "Notify" declared as tools with who may call; the test that an agent cannot take a people-only action | PRs 3 to 5 are written against today's routes with the people-only check in one place so A1 can declare them; the agent-refusal test is the same either way |
| **S1** (board backend) | The plan as a card kind and the project record reading the approval | U1's approval lives on today's run and exposes a read for S1; no change to screens |
| **S2** (LangGraph) | Interrupts for approvals; resumes | Consumes U1's approval record. U1 goes first |
| **P6b** | Fixes: the agent's fixes draw from U1's allowance (PR 4 provides the draw function) | P6b's fix PR waits for U1 PR 4 |
| **#523 / Cinema Studio "at most 3N" hold** | A Cinema step's worst case in the plan and its hold | Plan lines use the same worst case the quote path returns; if #523 is not merged, Cinema steps show "about N cr" as the SOW says and are not part of a plan's allowance |
| **S2 / thinking billing** (SOW open decision) | "Start · up to N cr" figure | Shown as the code computes it (handover § 3, #522: the code wins) |
| **VPS packages (P2 to P8)** | Nothing in U1 needs them. Push and metrics run on Vercel today |  |
| **Claude Design frames** | Any screen the handoff does not draw (client review page, a Notify control on the plan card) | Listed in PR 6 and 8; follow the nearest frame until drawn (rule 9) |

## 6. Risks

1. **Silent spending.** A plan approval that mints approvals is the most sensitive code in this package. Mitigation: the engine still mints the `ApprovedQuote`; price drift, the job line and the cap always ask; independent review; owner's yes; the plan reviewed before code.
2. **A server price that is stale.** A quote stored at proposal time can age. Mitigation: re-quoted at each step; a different fingerprint asks again; proposals expire.
3. **Balance race.** A balance can fall between the check and the step. Mitigation: the check is advisory at approval and enforced again at each admission (as today); a step that cannot be afforded pauses and offers Top up, never silently skips.
4. **A flaky five-minute test blocks every UI PR.** Mitigation: its own job and config, mock engine and mock planner only, no network, retries at the step level for waits not for assertions, a rerun button, and the tap budget kept loose at first.
5. **Metrics become surveillance.** Mitigation: a closed list of step ids, no free text, pseudonymous ids, internal workspaces excluded, 90-day retention, platform admin only, a test that fails on any new field.
6. **Push leaks content.** Mitigation: neutral text (PR 6); recipients tested.
7. **Client review links open a door.** Mitigation: separate PR, optional, reviewed as sign-in and tenant separation.
8. **The per-render tap disappears.** Today's Ask mode asks at every render (decision 27). The SOW and rule 14 say a plan is approved once. Mitigation: the owner confirms (decision 2); the tap stays outside a plan.

## 7. Open owner decisions

1. **Where the five-minute test lands.** The SOW's Release 1 done-when needs it by Thursday 8 October, and § 3.6 puts it in Phase 2. Recommended: build PR 1 first and let Release 1 use it, since the plan is to write it against the integration build anyway.
2. **One approval replaces the per-render taps inside a plan.** Confirm rule 14 over the earlier "each render still asks" (decision 27), and that Ask stays the default outside a plan.
3. **The fix allowance is drawn by the agent without a further tap**, up to two fixes per shot and the allowance (as the SOW says), and anything beyond asks.
4. **What "Top up" does today.** Packs are requests approved in `/admin` (payments are manual until Stripe, last). Recommended: the button opens that request for a member and for an admin, and the plan's Approve unlocks when credits arrive.
5. **Retry wording and rule.** Confirm that Retry after a confirmed not-billed failure is one press under the same approval and is not a fix.
6. **Push text.** Recommended: shot code and state only, no prompt text, and an email fallback (through the existing mail sender) only for people who ask for it.
7. **Client review links:** build approve and comment in U1 (recommended in the handover) or later.
8. **Who reads the ease metrics.** Recommended: platform admin only, aggregates only; and 90-day retention.
9. **The five-minute test as a required check** in the repository's rules (the owner's step).
10. **The thinking figure** ("Start · up to N cr"): show the code's real figure, not the design's sample (the handover's recommendation, #522). Confirm.

## 8. Estimate

| PR | Agent-days |
|---|---|
| 1 Five-minute test | 2.5 |
| 2 Ease metrics | 2 |
| 3 Server-priced plan and balance check | 2.5 |
| 4 Plan approval with the fix allowance | 5 |
| 5 Nothing billed and Retry | 2.5 |
| 6 Notify me when done | 2.5 |
| 7 Review mode, complete | 2 |
| 8 Client review links (optional) | 3 |
| 9 Docs | 0.5 |
| Independent review, rework, preview fixes (about 20%) | 4.5 |
| **Total** | **about 27** (about 24 without PR 8) |

With 2 or 3 agents in parallel, the first three PRs and PR 6 and 7 can run together; PRs 3, 4, 5 are the long chain (about 8 calendar days with review). The five-minute test (PR 1) is the first to land.
