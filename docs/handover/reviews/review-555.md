# PR #555 "Plan approval: approve once, up to the plan's total": independent money review

Private. Stream 14, 6 Oct 2026. Head `6b3ddd00b83368ab1cbd091612ed5877a628b9f0` (branch `money/plan-approval`, base `release/1` `12bff96d`). The worktree was `W/review-555` (detached), since removed. The probes are kept in `S/demo/review-555-probes/` (`p555.probe.ts`, `pw.config.ts`). I pushed nothing.

## Verdict: PASS (money). No high or medium findings; six lows

One process point: CI does not run on this PR. `check-merge.py 555` answers `WRONG_BASE` (base `release/1`), and only the two Vercel checks report. The gates below are mine.

## Checked

1. **One approval covers exactly the plan.**
   - `coverage()` (`lib/workbench/plan-approval.ts:137-151`) covers a listed render only at its approved quote fingerprint. A fix is covered only if it is drawn on the approval's record, is priced at or under its shot's worst, and is under the per-job line.
   - The 2T is enforced at the hold, not on screen: `approveRigAgentPlan` sets the run's limit to settled + in-flight worst + 2T (`rig-agent.ts`). The reservation then enforces it under the billing write lock (`runLimitVerdict`).
   - Proved: the PR's test "one approval covers exactly the plan…", and my probe R3 (two renders racing the last of the limit: one reserved, the other refused with "This would pass the limit approved for this run. Nothing was charged.").
2. **T and 2T are the server's figures.**
   - `planQuote` sums the server's per-render worst cases. The card at the gate and after approval (`model.ts:225-231`) and the queue item read `view.plan.quote` / `approval`. The approval re-quotes inside its write transaction and refuses a stale fingerprint.
   - Before the gate the card still sums its own estimates (L2).
3. **People only.**
   - The route takes a session only: `requireSession`, so tokens are refused.
   - `approveRigAgentPlan` and `fixRigAgentShot` refuse non-person ids (`isPersonApprover`) and anyone but the run's owner.
   - The control room's plan item is not batchable (`queue.ts` `batchable`).
   - The PR's test tries an Atomik id, `mcp:`, `token:`, `auto` and a teammate.
   - The CHECK is weaker than the function (L1, probe R1).
4. **Every per-render check still runs.** A covered render goes through the same admission as the owner's own tap (`asOwner`, the durable key first), so balance, production cap, monthly allowance, run limit and the admin rule (`shotCapGate` for a member) are all checked at the hold, and renders over the per-job line ask (`coverage`). The PR's test "the balance and the caps still bite" covers this.
   - Note: `release/1` does not contain #540. When #540 lands, the monthly allowance counts Cinema holds as reviewed there, and the plan's worst for an approximate engine (band 3) matches #540's 3N hold.
5. **Everything outside the plan asks again or is refused:**
   - a moved price, even a lower one, asks (PR test);
   - an unlisted render asks (PR test);
   - a third fix is refused (`THIRD_FIX`, PR test);
   - a fix priced above its shot asks: probe R2 shows 0 calls, the fix waiting and the run `needs_you`.
6. **Room, closing and keys.**
   - A refund returns room exactly once: the run tally reads the ledger (PR test "refunds return to the approval").
   - Stop closes the approval (`stopRun`), and so does Undo.
   - Expiry is 7 days (`PLAN_APPROVAL_MS`, `approvalClosed`).
   - A fix's request keys carry its own step (`${nodeId}.fix${seq}`). Probe R2 found all keys unique, and two simultaneous fix presses draw one fix (the counter holds one entry).
7. **Migrations are additive.** `rig_plan_approvals` is `CREATE TABLE IF NOT EXISTS` in the rig-agent schema of the workspace's own database. `approval_id` and `fix_of` are additive columns. Reads check that the table exists first.
8. **Concurrency.** Two renders racing the last of the limit: only one is reserved (probe R3). Approvals and fixes are serialized by `workbenchTransaction` (write transactions), and `run_id UNIQUE` makes one approval per run.
9. **No vendor cost, margin or multiplier** in any route, view or string. The diff's dollar figures are unit-test fixtures only.

## Lows

- **L1. The table's CHECK is weaker than the function.** `plan-approval.ts:179` accepts `AUTO`/`Auto` (the comparison is case-sensitive) and `plan:`, `system:`, `cron:`, `worker:` and a leading space; `isPersonApprover` refuses all of them. Only the function writes the table, so nothing gets through today, but the body's "the table has its own CHECK" holds only for `agent:`, `mcp:`, `token:`, `auto` and empty. Probe R1 (fails by design). Fix: mirror the function's prefix list and compare `lower(approved_by)`.
- **L2. The card sums its own figures before the gate.** At the proposal phase `model.ts:226-231` adds up the estimates and computes a ceiling of 2× that sum, and `PlanCard.tsx:33` always shows `fixLine(model)`. The card can therefore read "Fixes if needed: up to 2 per shot, within X" from the browser's own sum before the server has priced anything. The money button there is "Build · free", so nothing is approved on that figure. Fix: show the fix line only at or after the gate.
- **L3. The approval stays open after the run ends, and a fix reopens a finished run.** `fixRigAgentShot` accepts `run.state` `done` (`rig-agent.ts:590`) and moves it back to `running` (`:596`). The design note says an approval lasts "until the run ends, the person stops it, or 7 days". This is an owner question; for fixes it is probably the intent.
- **L4. A render approved under the plan that later pauses resumes without re-checking the approval.** Example: approved, then refused at the hold for the balance or the limit. On the next tick `tapped` is true (`rig-agent-runs.ts:347`), so the approval's expiry or close is not checked again. A Stop also closes the steps, so this matters only for the 7-day expiry.
- **L5. Renders above the per-job line share the plan's run limit.** They ask on their own and are not in T, but tapping one draws on the same used + 2T limit. It can use up room meant for the plan, or be refused at the limit after the person's tap. Say so on the card, or let such a tap raise the limit by its own price.
- **L6. The PR's CI did not run (base `release/1`).** The PR body's numbers match mine (3,673 passed, 6 skipped).

## What I ran (logs in /private/tmp)

| Run | Result | Log |
|---|---|---|
| `npm ci` | ok | `claude-review-555-npmci.log` |
| Focused: planApproval, demo-s04-plan-model, rigAgent, rigAgentRuns | 59 passed | `claude-review-555-focused.log` |
| Full unit (`env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 … --project=unit --workers=1`) | **3,673 passed, 0 failed, 6 skipped** | `claude-review-555-unit.log` |
| Probes R1, R2, R3 | R1 fails (L1); R2 and R3 pass | `claude-review-555-probes.log` |
| Browser `demo-s04-plan-workbench` (1440x900, 390x844), fresh mock DB | 5 passed, 3 skipped (size-gated) | `claude-review-555-browser-s04.log` |
| Browser `demo-s10-phone-plan-workbench` (same sizes), server restarted | 8 passed, 8 skipped | `claude-review-555-browser-s10.log` |

The browser runs used my own server `review555` on :4723 (fresh DB `/private/tmp/particl-suites/review555`), with PIDs 85915, then 86462/86470 after the restart; it was stopped. Slot-6 was acquired at 09:59Z on the 18th try and released.
