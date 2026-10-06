# Review of PR #556: money/gaps-l4 @ c11c0ece4948a39c1fd70fef2537aec6cc760dbd (base release/1)

**VERDICT: FAIL. 2 medium, 6 low. No high.** The people-only fix is right for every route the PR touches. The new workspace budget, though, is enforced by the gate while two screens still say "No cap" and offer no way out. Separately, a stale admin unlock switches off the new 80 % ask for good.

Reviewer: an independent agent with its own worktree (W/review-556, detached at c11c0ece). It did not commit, push or comment. The diff was taken against the merge base b58ae1e3.

## Gates run on this head
| Gate | Command | Result | Log |
|---|---|---|---|
| Typecheck | `./node_modules/.bin/tsc --noEmit -p .` | 0 errors | review-556-probes/claude-review556-tsc.log |
| Full unit | `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 ./node_modules/.bin/playwright test --project=unit --workers=1` | **3700 passed, 6 skipped**, 10.3 min | review-556-probes/claude-review556-unit.log |
| Board money states, browser | `demo-gaps-l4-money-workbench.spec.ts`, 1440x900 + 390x844, fresh mock DB `review556-a`, PW_CHANNEL=chrome | **10/10 passed** | review-556-probes/claude-review556-money-browser.log |
| Budget and cap, browser | `demo-gaps-l4-rules-workbench.spec.ts`, 1440x900 + 390x844, fresh mock DB `review556-b` | **4/4 passed** | review-556-probes/claude-review556-rules-browser.log |
| Review probes | `review-556-probes/review556-probes.spec.ts` (copied into tests/unit temporarily, then removed) | 7/7 passed. Each "STILL OPEN" probe asserts that the hole exists. | review-556-probes/probes-run.log |

The Playwright-bundled headless shell is not installed on this machine. The browser runs used `PW_CHANNEL=chrome`, as lane-rules does. The mock servers ran on port 4796 and were stopped with `mock-server.py stop` (PIDs 92480/92484 and 95165/95176). Slot 6 was taken and then released.

## Findings

### 1. MEDIUM: the workspace budget is enforced, but two screens say "No cap" and an over-budget production has no Unlock
- **Where:**
  - `lib/caps.ts:222-233` (`projectCap` falls back to `productionBudgetCredits`, which the reservation gate reads at `lib/generationRequests.ts:371`);
  - `lib/productions.ts:108` (only `GET /api/productions` applies the fallback);
  - `app/api/projects/route.ts:107` and `app/api/projects/[id]/route.ts:32` (raw `cap_credits`);
  - `components/graphite/settings/rules/spending-words.ts:75`;
  - `components/graphite/settings/rules/RulesSection.tsx:177-182` (Unlock appears only when `p.capCredits != null`).
- **Scenario:** an admin sets "Budget per production" to 400 cr. A production with no cap of its own has already used 2,000 cr.
  - It is blocked at once under the default `atCap = producer`. The refusal reads "At this production's cap of 400 cr … An admin can unlock it or raise it."
  - Settings › Spending rules › Each production shows that same production as "No cap · new work follows the workspace rules", with no Unlock button. The old project page also says "no cap".
  - Meanwhile the board's Record and plan card (from `/api/productions` and `/api/workbench/budget`) show 400 cr.
  - So server figures disagree between screens, and the remedy the refusal names cannot be reached from any screen. The only ways out are a raw `capUnlocked` PATCH, setting an own cap, or raising the budget for everyone.
- **Proof:** probe P5. The gate reads `{cap:400, from:"workspace"}`, the board reads 400, `/api/projects` reads null, the Settings line says "No cap", and the refusal text says "An admin can unlock it".
- **Fix direction:** carry the effective cap and its `from` on `/api/projects` and `/api/projects/[id]`. Offer Unlock and "Set own cap" for `from: "workspace"` rows.

### 2. MEDIUM: an old unlock switches off the 80 % ask for good
- **Where:**
  - `lib/caps.ts:258`: `budgetAsk` returns null whenever `cap_unlocked`.
  - `app/api/projects/[id]/route.ts:53`: changing `capCredits` resets `cap_warned_at` but never `cap_unlocked`.
  - `RulesSection.tsx:181`: Settings has no re-lock. Once unlocked, the row just reads "unlocked past the cap".
  - `MoneyStates.tsx`/`money-state.ts:105`: the board's paused state is also skipped when `unlocked`.
- **Scenario:**
  1. An admin unlocks a production at an old 100 cr cap.
  2. Later they set a new cap of 1,000 cr, or clear the own cap so the workspace budget applies.
  3. Auto now never pauses at 800 cr. It never stops at 1,000 cr either, because `capVerdict` lets an unlocked production through.

  The new control can therefore be bypassed by a stale decision, with nothing on screen saying so. Check (3) asks for an 80 % ask that cannot be bypassed.
- **Proof:** probe P6. The row is `{cap_credits:1000, cap_unlocked:1}`, `budgetPause` gives `reached:true`, and `budgetAsk` returns null.
- **Fix direction:** reset `cap_unlocked` (and `cap_warned_at`) whenever the cap changes, and when the workspace budget changes for budget-capped rows. Alternatively, have `budgetAsk` ignore `unlocked` until spent ≥ cap.

### 3. LOW (still open, not in the diff): PATCH /api/productions/[id] sets a cap from a member or a token
- **Where:** `app/api/productions/[id]/route.ts:10-20`. It uses `requireUser`, with no role check and no token check, and writes `productions.cap_credits` / `cap_usd`.
- **Impact:** the gate does not enforce this container-level cap. It is display only, summed on the old Productions page (`app/(app)/productions/page.tsx:63,139`). Still, it is "a production's cap" that an admin's render token or a member can change, so the PR's claim "tokens can no longer set a production's cap" does not hold for this route.
- **Proof:** probe P2. The token PATCH returned 200, the member PATCH returned 200, and the row became `{cap_credits:123456, cap_usd:7}`.

### 4. LOW (still open, not in the diff): POST /api/jobs/[id]/release accepts a render token
- **Where:** `app/api/jobs/[id]/release/route.ts:23` (`requireUser`).
- **Impact:** releasing a held take at a stated price is a spend approval. An admin's render token passes auth and, through `mayRelease`, can release anyone's held take.
- **Mitigation:** held takes also release automatically when credits arrive, so the extra exposure is small. It still contradicts "only a person approves spending".
- **Proof:** probe P3. The token got past auth to the lookup (404 "Not found", not 403).

### 5. LOW: "saves as you type" stores intermediate values
- **Where:** `BudgetSection.tsx:28,84-90`, a 600 ms debounce.
- **Scenario:** a pause while typing "400" saves "4". Every production without its own cap is then capped at 4 cr until the next save. In the cap field, typing turns `approvalRule` to "cap" at the partial figure.
- **Impact:** this causes refusals only, never spend. However, a job reserved in that window runs `checkCap`, which sets `cap_warned_at` (`lib/caps.ts:186-189`). That flag is never re-armed when the budget changes, so the real 80 % "capNear" push for the new budget is lost.

### 6. LOW: "Saved · logged with your name" and "Every change is logged" overclaim
- **Where:** `BudgetSection.tsx:78,150`; `lib/settings.ts:119-127`.
- **Detail:** settings keep only the last writer (`updated_by`, `updated_at`). There is no history of changes. Either reword the copy or write an audit row.

### 7. LOW: Ask an admin has no rate limit and does not check the step
- **Where:** `lib/control-room/ask-admin.ts:320-326`.
- **Detail:** a member can push "Shot N is over the per-shot cap" to every admin for any take step, whether or not it is over the cap, and as often as they like. It spends nothing.

### 8. LOW: test gaps
- No test drives the workspace budget through the reservation gate (`reserveGenerationSpendLocked`). The new tests use a production's own cap (`rigAgentRuns.spec.ts` sets `cap_credits=25`) or `projectCap`/`budgetAsk` directly.
- Nothing covers findings 1–3, an unlock combined with a cap change, or a member session on the new settings keys (`requireAdmin` covers it in code; probe P1 confirms 403).

## Checklist
1. **People-only (probe P1).**
   - An admin-made render token gets 403 on every one of these:
     - Settings: budget, shotCap, capWarnPct;
     - the project's cap and unlock;
     - top-up request and withdraw, and the old `/api/topups`;
     - token mint;
     - team-canvas: `agent.approve`, `agent.render`, `agent.limit`, `agent.stop`;
     - ask-admin.
   - A member session gets 403 on Settings, the project cap and unlock, and top-ups.
   - Ask-admin without the scope header returns 409. Ask-admin as a member returns 200 and changes nothing.
   - `GET /api/workbench/budget` is open to tokens but read-only, which is acceptable.
   - Atomik ids (`agent:`, `auto`, `server`, empty) are refused by `askAdmin`. The run's paid steps run as `run.owner`, and only the owner's tap sets `approved_fingerprint` (`lib/workbench/rig-agent.ts:411-414`).
2. **Security fix.** The claimed routes are fixed (`projects/[id]` cap and unlock, `workspaces/topups` POST, DELETE and `canRequest`). Every other mutating `requireUser` route was swept. Findings 3 and 4 are the money-adjacent ones still open; both were already there before this PR. Settings, tokens, team, the old top-ups and team-canvas were already session-only.
3. **Budget and pause.**
   - A blank, zero or junk budget changes nothing (probe P7, values "", " ", "0", "-5", "1.5", "abc", "1000001").
   - Held and settled spend are counted once, through `spentBy`, the same reckoning the gate uses.
   - There is no double count with the monthly allowance or the run limit: they are separate checks, and each can only add a stop or a tap.
   - If the budget read throws, the step stays "waiting", so it fails closed.
   - Bypass: finding 2.
4. **Figures come from the server.** That holds for the budget read, the packs, the quotes, the plan prices and the ledger outcome. "Short by" and "the rest" are sums of server prices and drive no spend. The one disagreement between server figures is finding 1.
5. **Retry and Move.**
   - Retry (`RetryTake`) only fetches a free quote and opens Make, where a person presses at Make's own price.
   - Move calls `rig.patchShot` (free) during the proposal phase only.
   - Continue sends the shown render's fingerprint, and a change of price is refused (`rig-agent.ts:409`).
   - The browser spec checks that nothing paid is posted.
6. **Migrations.** There are none. One settings key is added (`productionBudgetCredits`, default ""). It is stored in the tenant database and validated by `settingProblem`.
   - Note: if the platform layer's `defaultCapCredits` is set, new productions get an own cap and never follow the workspace budget. That is informational.
7. **No vendor cost or margin** in any reply or string. The budget route sends credits only, and dollar workspaces get `budget: null`. A grep of the diff is clean.
8. **Tests.** They pass and do prove the token refusals and the pure money words. The gaps are listed in finding 8.

## Probes
All probes are in `S/demo/review-556-probes/`: `review556-probes.spec.ts`, plus the run logs.
