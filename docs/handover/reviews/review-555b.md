# Independent money re-review: PR #555 "Plan approval: approve once, up to the plan's total"

Head reviewed: `4158f4123e79122da8c5689ebbe98eb3d5264679` (money/plan-approval), base `release/1`.
Reviewer: fresh, independent second reviewer (review-555b). I wrote my findings before reading `review-555.md`; the comparison is at the end.
Worktree: `W/review-555b` (detached; removed at the end). Probes: `S/demo/review-555b-probes/review555b-probes.spec.ts`.

## Verdict: FAIL. One medium (M1), six lows

M1 is a money-path gap. The design the owner is approving says "a changed prompt or reference (the price's fingerprint moves) … asks again". As built, nothing re-prices a render from the board once the plan gate has priced it. So a shot edited after the plan was priced goes out under the plan as the **old** request, at the old price, with no new tap. The PR also introduces "price every render at the first gate" (`priceAhead`), which widens the same stale-request window for ordinary per-render taps in Ask runs, the old card included.

Everything else on the checklist holds. There are no high findings.

## Findings

### M1. An edited shot is sent as its old request under the plan, with no new tap
- **Where:**
  - `lib/workbench/rig-agent-runs.ts:352`: `priceAhead` prices every render at the first gate and stores each `admission`.
  - `:340-374`: `gate()` works from the stored `step.admission`. It never re-prices from the board, so `coverage()` compares the approved fingerprint with itself.
  - `lib/admissionSupport.ts:216`: the admission checkpoint re-compiles the **stored** request, so it notices only a moved rate, never a board edit.
- **Scenario:** A plan has 2 shots and the person approves it. While shot 1 renders, the person rewrites shot 2's prompt on the board ("at night, in the rain, wide lens"). Shot 2 then goes out under the plan with the prompt from before the edit, and it is charged, with no tap. The design note (§ "What one approval allows", and check 1, "its fresh quote's fingerprint equals the one approved") promises it would ask again.
  - The same thing happens to a reference picture or engine change made after the gate.
  - The same thing happens to a per-render "Render · N cr" tap on a later shot in any Ask run, including the old `RigAgentCard` that customers with the switch off use. The step was priced at the first gate, possibly long before, and the tap approves that stored request. Before this PR, a step was priced only when its turn came.
- **Why medium:** the money stays within what was approved, but the person pays for a render of content they have since changed, with no ask. That breaks the one promise the owner's approval rests on: "anything outside it asks again".
- **Proof:** probe `FINDING 1`. It edits shot 2's `text` through `patchTeamCanvas` (the board's own path). It then asserts the second render was sent with no "EDITED" in its prompt, carrying `approval_id = rpa_…` and `approved_by = ana`. The harness quote fingerprint covers the compiled prompt, as the real one does (`admissionSupport.ts:121-129` hashes `compiled`).
- **Fix (small):**
  - When a render's turn comes (`gate`, before `tapped` or `coverage`), re-price it from the board with `priceRender`. Use the fresh admission, and compare its fingerprint with the approved one (listed `steps[].fingerprint`, or `approved_fingerprint` for a tap). If they differ, ask with `PRICE_MOVED`.
  - Equivalently, keep `priceAhead` only for the card's quote, and move the step back to `next` when it becomes current.
  - Add a test that edits a shot after approval and expects an ask.

### L1. Slack from a render tapped before the approval lets the plan spend past 2T
- **Where:** `lib/workbench/rig-agent.ts:546-547`. The limit is `settled + in-flight worst + 2T`, not the design's "planning used + 2T".
- **Scenario:**
  1. At the gate, the person taps shot 1 on its own (old card or API). It is approximate, held at 3a.
  2. The plan for shot 2 is approved at T = a, "at most 2a".
  3. Shot 1 settles at a, which frees 2a of room. That room is now available to the plan.
  4. Shot 2 and its two fixes then render under the plan with no tap: 3a against a stated 2a.
- The card then shows "4a of 2a used", because `used` also counts the out-of-plan render.
- Total spend (4a) stays within what the person approved in sum (3a + 2a), hence low.
- **Proof:** probe `FINDING 3`: three plan-covered renders, `used > ceiling`.
- **Fix:** keep a plan-scoped tally (charges of steps with `approval_id`) and check it against the ceiling in `coverage`. Or set the limit from settled spend only, so out-of-plan holds draw on the plan's room, as the design says.

### L2. An approval's close or expiry is not re-checked for a render it already approved
- **Where:** `rig-agent-runs.ts:347,359`. `tapped` is true for a plan-approved step that paused at send and was then resumed.
- **Scenario:** after the 7 days, a limit raise sends that render with no coverage check. A Stop closes the steps anyway, so only expiry matters.
- **Proof:** probe `FINDING 5` (state set by SQL).

### L3. After approval, an approximate plan's Total reads as an exact figure
- **Where:** `components/graphite/board/cards/plan/model.ts:227` uses `exact(approval.total)`; the approval view carries no `approximate` flag.
- **Scenario:** at the gate the phone Total reads "up to 30 cr"; after approval it reads "30 cr" (rule 14: "up to N cr").
- **Proof:** probe `FINDING 4`.

### L4. "Nothing billed → Retry under the same approval" is not offered; a re-render costs a fix
- **Where:** a failed, unbilled take is terminal (`failed`). `renderRigAgentStep` accepts only `waiting` or `paused`, and `fixRigAgentShot` (`rig-agent.ts:588`) counts it as a fix.
- **What it contradicts:** CLAUDE.md rule 14 and the design note ("It is not a fix and uses no allowance"). The PR's own test does this on purpose.
- **Why low:** conservative; it asks sooner, never spends more.

### L5. A step needing an admin blocks the whole plan instead of being listed to ask
- **Where:** `plan-approval.ts:105-107`. Any open step paused for anything but `limit` or `credits`, including `admin`, makes the quote `ready:false`.
- **Effect:** the member must skip that step before the plan can be approved at all. Design decision 8 and rule 14 ("the plan card says which steps need whom") expect the other steps to be approvable.
- **Why low:** conservative. Found by code reading.

### L6. The phone can toast "Approved · N cr, at most 2N cr" after a failed approve
- **Where:** `components/graphite/phone/PlanScreen.tsx:50-56,114`. `pressed` is set on press and never cleared when `act` fails (402, 409).
- **Scenario:** the approve call fails. If the phase later leaves "proposal" without an approval (a teammate stops the run), the screen toasts the approval and goes Home.
- **Why low:** a false approval message only; nothing is spent. Found by code reading.

Also noted, not findings:
- The approval stays open after the run is `done`, and a fix reopens the run (`rig-agent.ts:590,596`). That is an owner question; for fixes it is probably the intent.
- The explore-only sample card sums its recorded prices in the browser (`sample.ts`), behind a disabled button.

## Checklist (what holds, with proof)
1. **The ceiling is enforced at the hold.** The run's `cap_credits` is passed as `RunSpend` and checked by `runLimitVerdict` inside `reserveGenerationSpend`'s billing transaction. Proofs:
   - Probe "ceiling holds": one shot at a, a refunded fix, then a second fix makes used = 2a. A third fix is refused, and the double settlement delivery is counted once.
   - Probe "fixes racing": with one shot, the second fix pauses at the limit (2a).
   - The PR's test "the balance and the caps still bite".
2. **Fingerprints.** A moved price, even a lower one, asks again: admission returns `quoteChanged`, the step is re-priced, and `PRICE_MOVED` asks (PR test). These are also refused:
   - render N+1;
   - a third fix (also when pressed 3× concurrently);
   - a fix priced above its shot.
   The gap is M1, a board edit.
3. **People only.**
   - The route uses `requireSession()`, which refuses tokens with 403 (`lib/auth.ts:296`).
   - The function checks `isPersonApprover` and that the caller is the owner.
   - The table has a CHECK and insert/update triggers. Probe "people-only" tried 33 case, whitespace, unicode, NUL, fullwidth, zero-width and Kelvin-sign ids: the function and the table agree on every one.
   - `agent:<run>` is the only machine id the code forms, and it is refused.
   - No MCP or Atomik caller reaches `approveRigAgentPlan` or `fixRigAgentShot`; their only caller is the route.
4. **Per-render checks.** A covered render goes `approved` → `send()` → `admitGeneration` with the same `RunSpend`, the same as a tap. So the reservation checks the balance, the production cap, the monthly allowance, the run limit and the shot-cap (admin) rule. The 200 cr line is applied in `coverage` and `planQuote` at the worst case. Balance against T at approval (402 "Short by").
5. **Room and closing.**
   - Refunds return room through the ledger, exactly once (probe).
   - Stop closes the approval and skips unsent renders; the sent render settles (probe).
   - Undo after `done` closes it (probe). Expiry asks, and fixes are refused (probe).
   - Fix keys are `…:<node>.fix<seq>:take:<n>`, all distinct (probe: 4 calls, 4 keys).
6. **Concurrency.**
   - Two approvals by the person plus a teammate's, racing: one row, one limit record, and the teammate gets 403 (probe).
   - Fixes racing: one fix step (probe).
   - Two ticks racing: one render sent (probe).
   - `workbenchTransaction` uses `transaction('write')` behind a per-tenant queue, and `run_id` is `UNIQUE`.
7. **Migrations.**
   - Additive: `CREATE TABLE IF NOT EXISTS`, triggers `IF NOT EXISTS`, and two `ADD COLUMN`s.
   - Created on first use by `rigAgentReady`, memoised per client in each workspace's own database. Reads check that the table exists.
   - The triggers fire only on insert or a change of `approved_by`, which no legitimate code writes.
   - Full unit is green.
8. **UI equals the server.**
   - The gate's title, button and "at most" figures are `view.plan.quote`. The queue lists the plan once at the server's total, and it is not batchable.
   - Before the gate there is no total (L2 of the first review is fixed).
   - s04 and s10 are green at 1440x900 and 390x844.
   - Exceptions: L3 and L6.
9. **No vendor cost or margin** in any added route, view, string or stored row (diff grep; credits only).

## What I ran
| What | Result | Log |
|---|---|---|
| Full unit: `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://127.0.0.1:4999 playwright test --project=unit --workers=1` | 3674 passed, 6 skipped, 0 failed (4.5 min) | `review-555b-probes/claude-review555b-unit.log` |
| My probes (10) | 10 passed (the FINDING probes pass when the finding is present) | `review-555b-probes/claude-review555b-probes.log` |
| s04 plan + s10 phone plan specs, 1440x900 and 390x844, fresh mock DB (`mock-server.py`, port 4873, `PW_CHANNEL=chrome`) | 13 passed, 11 skipped (by design at the other width) | `review-555b-probes/claude-review555b-s10.log`, `claude-review555b-s04b.log` |

Environment notes:
- At `http://127.0.0.1:<port>`, the s04 Build click is refused with "Invalid request origin": the browser's Origin is 127.0.0.1, but the route's own origin comes from the mock server's `APP_ORIGIN=http://localhost:<port>`. With `PW_BASE_URL=http://localhost:4873` everything passes. This is a harness mismatch, not the PR.
- The bundled headless shell is missing, so I used `PW_CHANNEL=chrome` (lane-rules § 8).
- The mock server was stopped with `mock-server.py stop review555b`, and slot-1 was released.
- I briefly started the server at 37% free memory, stopped it at once, and restarted it at 55%.

## Compared with the first review (`review-555.md`, read after writing the above)
- The first review passed with six lows. It did not raise M1 (stale request under the plan, and the wider window `priceAhead` opens for taps) or L1 (slack past 2T).
- Its L4 is my L2, and its L3 is my "also noted" item. Its L1 (CHECK weaker than the function) and L2 (card summing before the gate) are fixed at this head.
