# Review 555c: independent money review of PR #555 (plan approval)

Head reviewed: b55f32b69f469f1b8ceb813356cdc1df9c39ce0c (money/plan-approval), base release/1.
Reviewer: fresh third reviewer. I had not seen the PR or the earlier reviews. I wrote section A before reading review-555.md and review-555b.md; section B was written after.
Worktree: W/review-555c (detached; removed at the end). Probes and logs: S/demo/review-555c-probes/.

## Verdict: PASS (money). No high or medium findings; two new lows

Both lows are narrow. Neither lets the plan spend past its ceiling or at a price the person did not approve. The earlier M1, L1, L2, L3 and L6 are fixed, and their probes now fail for the right reason. L4 and L5 are owner-approved changes that will land separately.

## A. Own findings (written before reading the earlier reviews)

### N1 (Low): after expiry, a render the plan approved earlier can be sent with no tap
- **Where:** `lib/workbench/rig-agent-runs.ts:474` (`recordReply`, `quoteChanged`) and `:351` (`gate`, moved fingerprint). Both clear `approval_id` but keep `approved_fingerprint` and `approved_by`. Then `:361-362` treats `approvedFingerprint === fingerprint && !approvalId` as a person's own tap, so `approvalClosed` is never consulted.
- **Scenario:**
  1. The plan is approved. Shot 1 is approved by the plan at its gate.
  2. Its price moves between the gate's fresh pricing and the send. Admission answers `quoteChanged`, so shot 1 is re-priced and asks (`PRICE_MOVED`).
  3. Later the price returns to the approved figure, and the 7 days pass.
  4. The person raises the run's limit, which is a different action from approving shot 1.
  5. The next tick re-prices shot 1 to its original fingerprint and sends it with no tap, under an expired approval.
- **Bound:** one render per such step, at exactly the price the person approved in the plan. The run's limit, the balance and the caps are all still checked at the hold. It breaks owner decision 4 ("after that, nothing more is drawn from it") on a narrow path. It is the same class as the earlier L2, reached another way.
- **Proof:** probe P1 fails on b55f32b6: a render is reserved after expiry.
- **Fix:** wherever `approval_id` is cleared on a step the plan approved, also clear `approved_fingerprint`, `approved_by` and `approved_at`.

### N2 (Low; liveness only, nothing charged): a Fix can be stranded
- **Where:** `lib/workbench/rig-agent.ts:589` (`fixRigAgentShot`'s "same answer" branch) against `lib/workbench/rig-agent-runs.ts:307`. There, `advancePaidSteps` patches the run to `done`, from `running`, after reading the steps outside any transaction.
- **Scenario:**
  1. The last take settles, and a tick reads the steps (none open).
  2. The person presses Fix. That inserts the fix step, records it on the approval and sets the run to `running`.
  3. The tick then writes `done`.
- **Result:** the fix stays `next` on a done run, and `dueRuns` never picks up a done run. Pressing Fix again answers "the same" and dispatches nothing. The shot's fix allowance is used up with no render. Nothing is charged.
- **Proof:** probe P4 simulates the tick's write. It fails on b55f32b6: 2 sends, and the fix never goes.
- **Fix:** in the "already on its way" branch, if the run is `done` and the fix is still `next`, move the run back to `running` and dispatch. Or re-check for open steps inside the write that sets `done`.

### Observations (not findings)
- **O1. Auto runs can take the plan approval.** `planView` and `approveRigAgentPlan` don't check `run.mode`. So an Auto run can show and accept the plan gate once every remaining render is priced (for example, one non-draft render waiting). Owner decision 6 says Auto keeps today's behaviour. A person still approves at the server's price, and the limit only tightens, so there is no money risk.
- **O2. The approval never closes as "ended".** The design lists stopped, ended and expired. A done run keeps its approval open for fixes for up to 7 days, and a Fix moves the run back to `running`. Fixes need a person's press and stay under the run's limit. Both earlier reviews noted this too; it is an owner question.
- **O3. A racing tick can undo an approval's "running".** `approveRigAgentPlan` accepts a run that is `running`, and a tick's `needsYou` can then overwrite that state. This affects liveness only: the card then shows the render's own button.
- **O4. The queue's plan item skips the admin rule.** It sets `needsAdmin: false` and does not apply `capGate`. The server still refuses an over-cap render at prepare or at the hold (it pauses for an admin, and nothing is charged). The owner-approved L5 change covers this area.

## Checklist (what holds, with proof)
1. **The ceiling is enforced at the hold, under the write lock.**
   - The limit is `planning settled + planning worst + 2T` (`rig-agent.ts` approveRigAgentPlan), written to `cap_credits` inside a `transaction('write')`.
   - `runSpend` passes it to `reserveGenerationSpend`, and `runLimitVerdict` checks it inside `billingTransaction`.
   - Fixes and plan renders carry `RunSpend`.
   - Proof: the PR's tests, my P3 (racing fixes; spend at most planning + 2T), and 555's R3 (two renders racing the last of the limit).
2. **Re-pricing at each render's turn.** `gate` re-prices from the board with `priceRender` before any `tapped` or `coverage` decision. A prompt, reference, engine or price change moves the fingerprint, which clears the plan link, and the render asks.
   - The admission checkpoint also catches a price that moves between the gate and the send (`quoteChanged`).
   - What is sent is always the stored, approved request.
   - Proof: the PR's M1, early-tap and moved-price tests, and 555b's FINDING 1, which now fails (the edit asks).
3. **People only:**
   - the route: `requireSession` refuses tokens;
   - the function: `isPersonApprover` and owner-only, in both approve and fix;
   - the table: a CHECK plus insert/update triggers.

   Proof:
   - my P5 (odd case, unicode spaces and the update path: the function and the table agree);
   - 555's R1, which now passes;
   - 555b's 33-id probe.

   No caller other than the route reaches `approveRigAgentPlan` or `fixRigAgentShot`, and the queue's plan item is not batchable.
4. **Per-render checks.** A plan-covered render goes approved → `send` → admission with the same `RunSpend` as a tap. So the hold checks:
   - the balance, the production cap and the monthly allowance;
   - the run limit;
   - the shot-cap (admin) rule;
   - the 200 cr line, in `planQuote` and `coverage` at the worst case.

   The balance is also checked against T at approval (402 "Short by").
5. **Refunds, Stop, Undo, expiry and resume:**
   - a refund returns room exactly once (PR test, 555b probe);
   - Stop skips unsent work, including an approved-not-sent render (my P6), and closes the approval;
   - Undo closes it, and a later fix is refused (my P6);
   - expiry asks, except on the N1 path;
   - resume after a pause re-checks the approval through `approval_id`, except on the N1 path.
6. **Concurrency:**
   - racing approvals write one row and one limit record (my P2);
   - racing fixes draw one fix, and a racing third fix is refused (my P3, 555b);
   - racing ticks send one render (555b);
   - `workbenchTransaction` uses a per-tenant queue plus `transaction('write')`, and `run_id` is UNIQUE.
7. **Migrations:**
   - `CREATE TABLE IF NOT EXISTS`, triggers `IF NOT EXISTS`, and additive `approval_id` and `fix_of` columns;
   - created on first use by `rigAgentReady`, memoised per client, in each workspace's own database;
   - reads check that the table exists before reading.
8. **The card and phone show the server's figures:**
   - the gate's title, button and "at most" come from `view.plan.quote`;
   - after approval they come from the approval row, and an approximate plan keeps "up to";
   - the queue lists the plan once at the server's T (my P7);
   - nothing is summed before the gate;
   - the phone toasts "Approved" only once the server holds the approval.

   Proof: s04 and s10, green.
9. **No vendor cost or margin** in the run view or the queue item (my P7 greps the view JSON), or in any added string.

## B. Earlier findings re-checked (read after writing section A)
| Earlier | Status at b55f32b6 | Proof |
|---|---|---|
| 555b M1 (an edited shot is sent as the old request) | Fixed: `gate` re-prices at its turn | 555b FINDING 1 now fails (1 call, not 2); PR test "an edited shot asks again" |
| 555b L1 (slack past 2T) | Fixed: the limit is planning used + 2T | 555b FINDING 3 now fails (1 done under the plan, not 3); PR test "never spends past its stated ceiling" |
| 555b L2 / 555 L4 (approval not re-checked on resume) | Fixed on the direct path (`approval_id` check). **A residual path remains: N1** | 555b FINDING 5 now fails (0 sends); my P1 fails (the quoteChanged path) |
| 555b L3 (approximate total reads exact after approval) | Fixed: `approval.approximate` | 555b FINDING 4 now fails ("up-to") |
| 555b L6 (phone toasts "Approved" after a refused press) | Fixed: `pressed` is cleared on refusal, and the toast needs `model.used` | s10 "a refused Approve never says Approved", green |
| 555 L1 (the table's CHECK is weaker) | Fixed | 555 R1 now passes |
| 555 L2 (the card sums before the gate) | Fixed | s04 and s10 "no total … before the gate", green |
| 555b L4, L5 | Owner-approved; to land as a separate commit | not reviewed here |

555's R2 and R3 and 555b's six "check" probes all pass.

## What I ran (logs in S/demo/review-555c-probes/)
| Run | Result | Log |
|---|---|---|
| Full unit, `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 … --project=unit --workers=1` (probe files moved out) | **3679 passed, 6 skipped, 0 failed** (9.1 min) | claude-review555c-unit.log |
| My probes P1–P7 | P1 and P4 fail (N1, N2); P2, P3, P5, P6 and P7 pass | claude-review555c-probes.log |
| 555b probes | its 4 FINDING probes fail (fixed); its 6 checks pass | claude-review555c-b-probes.log |
| 555 probes | R1, R2 and R3 pass | claude-review555c-p555.log |
| s04 plan spec, 1440x900 and 390x844, fresh mock DB | 5 passed, 3 skipped (size-gated) | claude-review555c-s04.log |
| s10 phone plan spec, same sizes, fresh mock DB (server restarted) | 9 passed, 9 skipped (size-gated) | claude-review555c-s10.log |

Environment:
- The browser specs need `PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/<name>/platform.db`. Without it, sign-in fails with "no such table: signup_invites". That first attempt is discarded; it was a harness setup error, not the PR.
- Servers, one after another, each on a fresh database: `review555c` (the discarded attempt), `review555c-s04` and `review555c-s10`, on :4767 with `PW_CHANNEL=chrome`. All were stopped with `mock-server.py stop`.
- Slot-5 was held for the full unit and the browser runs, then released.
- Nothing was pushed, committed or commented.

---

# Delta review: b55f32b6..1b0f4a2e (8f08c651 = owner decisions L4 and L5; 1b0f4a2e = fixes for N1 and N2)

## Verdict for the final head 1b0f4a2ea6577ca7dd83279189a26f3dae06b610: PASS (money). No high or medium findings; no new lows

Worktree: W/review-555c2 (detached; removed at the end). Probes and logs: S/demo/review-555c-probes/delta/.

## L4: agent.retry (a failed render with nothing billed retries free)
- **People only, at every layer:**
  - the route: `requireSession`, which refuses tokens;
  - `retryRigAgentStep`: `isPersonApprover` plus an owner check.
  - Probe Q1 proves it: `agent:<run>`, `mcp:`, `token:`, `auto`, `AGENT:` and a teammate all get 403.
- **Never a charged or unknown failure:** `failedOutcome` reads the ledger (`runCharges`). A charge still running is "unknown" and refused. A settled charge above 0 is "charged" and refused, so it goes the fix route or asks. With no ledger row, it falls back to the step's recorded outcome. Inside the transaction, the step must still be `failed` with the same `jobId`. Proof: Q1 (a charged failure is refused), plus the PR's test.
- **Can't loop:** the step's `attempt` is kept, a retry is refused once `attempt >= MAX_SEND_ATTEMPTS` (8), and every send adds one. Proof: Q2c.
- **Can't outlive the approval:**
  - an expired approval is refused at the press (Q2b);
  - a stopped run is refused (Q2d);
  - at the render's turn, the gate checks again through `approval_id`.
- **Can't change price:** the retried step goes back to waiting and is priced again from the board at its turn. A moved fingerprint clears the plan link and the earlier approval (`approval_id`, `approved_*`), and the render asks. Proof: Q2: nothing is sent at the new price, and both fields are null.
- **New key:** the attempt goes up, so the request key is new. Proof: Q1 and Q3 (all keys distinct).
- **Fix count and room:**
  - a retry draws no fix: Q1 shows `fixes = {}`;
  - pressing Fix on a shot whose latest take failed free becomes a retry (Q3);
  - room is still enforced at the hold: Q3 runs 10 rounds of free failures, retries and fixes, and spend stays at most planning + 2T with fixes at most 2 per shot.
- **Earlier probe now fails, as expected:** 555b's "check: the ceiling holds…" now fails at its last line. Its refunded fix 1 is now retried free (owner decision L4), so the shot still has one fix left. That fix then waits at the limit, because used = 2a = the ceiling. This is the intended new behaviour, not a regression.

## L5: a step needing an admin asks on its own
- **It can never render without an admin.**
  - Its price is read through a second, free prepare as an admin, stored only as `quote_credits` and `band`, with `admission: null`.
  - `send` refuses any step without an admission. The gate sends a step with no admission back to `next`.
  - A member's own Render prices it again as that member, which needs an admin again.
  - The queue item has no approve reference, because it has no fingerprint.
  - Every real send goes through admission as the run's owner, with that owner's real role.
- **Proof, probe Q4:** the member owns the run and shot 2 needs an admin.
  - The plan lists shot 2 in `asks`, not in `covered`.
  - After approval, shots 1 and 3 render and shot 2 is never sent, including after the member's own Render press.
  - Fix and Retry on shot 2 are both refused.
  - T counts two shots only.
- **Other paths:**
  - Under a plan, an admin pause no longer stops the run (`pause` returns CONTINUE), and `advancePaidSteps` steps around it. When nothing else is left, the run waits with "waits for an admin".
  - The queue now also reads running runs, but only for admin-paused steps.
- **Stated gap:** no one can press the admin step from the queue, so it can only be skipped. That is safe, since nothing is sent. It is an owner question.
- **Observation:** if the shot's rule later relaxes and the owner then taps that step, it draws on the run's limit (planning + 2T), not on a separate budget. That is conservative (it may hit the limit and ask), the same as the first review's L5 for renders over the 200 cr line. Not a money risk.

## N1 and N2
- **N1 is fixed.** The gate (when the price moved) and the `quoteChanged` path now clear `approved_fingerprint`, `approved_by` and `approved_at` along with `approval_id`. My P1 now passes: after expiry, a limit raise sends nothing. On the "Price again" path, `approval_id` is kept, so expiry is still checked. I found no new expiry bypass.
- **N2 is fixed.** The tick sets the run to done only if no take step is open (`NOT EXISTS`, inside the same UPDATE), and otherwise loops again. If the run is done, pressing Fix again sets it running. My P4 now passes: the fix goes.
- **No new fix-count bypass:** P3 (racing fixes) and Q3 pass.

## No regression of M1, L1 or L2
555b's FINDING 1 (M1), FINDING 3 (L1), FINDING 4 (L3) and FINDING 5 (L2) still fail, which means they stay fixed. 555's R1, R2 and R3 pass. My P2, P3, P5, P6 and P7 pass.

## What I ran (logs in review-555c-probes/delta/)
| Run | Result |
|---|---|
| Full unit, `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 … --project=unit --workers=1` | **3683 passed, 6 skipped, 0 failed** |
| My probes P1–P7 plus Q1–Q4 | **11 passed** |
| 555b probes | 4 FINDING probes fail (stay fixed); 1 check fails as expected under L4 (above); 5 checks pass |
| 555 probes | R1, R2 and R3 pass |
| s04 plan spec, 1440x900 and 390x844, fresh mock DB, `PW_PLATFORM_DATABASE_URL` set | 5 passed, 3 skipped (size-gated) |
| s10 phone plan spec, same sizes, fresh mock DB | 9 passed, 9 skipped (size-gated) |

Servers: `review555c2-s04` and `review555c2-s10` on :4767, both stopped with `mock-server.py stop`. Slot-6 was released. Nothing was pushed, committed or commented.
