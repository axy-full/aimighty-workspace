# Plan: P6b, self-review wired in (Phase 2)

Status: plan only, written 6 October 2026. No product code. **Do not merge before Friday 9 October.**
Scope source: `docs/particl-sow.md` v2 (branch `docs/sow-v2`) § 3.4, with the package prompt in `docs/handover-2026-10-05.md` Part D ("P6b: Verify and lock in the agent") and architecture § B4.2.
Rules that bind this package: CLAUDE.md rules 1, 2, 11, 13, 14, 15; the SOW's § 0 (money, merging, design, capacity).

## 1. Goal and done-when

**Goal.** When Atomik makes shots on the board, it checks its own work the way a careful assistant would. Every frame and take is compared with the look anchor (shot 1) and the locked masters (cast, environment, props). Each card gets one plain line saying what Atomik found. Where something is wrong it makes at most two targeted fixes per shot, paid from the plan's fix allowance, and then asks the person. It never retries silently, never passes a take it was unsure about, and may lock a master the plan names but can never unlock one.

**Done when** (all with the mocked engine and mocked judge; one paid calibration run in the internal workspace after the owner's yes):
1. A mocked run on the board checks every take it makes and writes a one-line note on the take's card. A pass says "Verified"; a fail or an unsure result says why, in the judge's words, and the run waits for the person.
2. A take that fails is fixed at most twice, each fix inside the approved allowance, and then the run asks. A third fix is refused by the server, not just hidden by the screen.
3. Atomik locks the masters its plan names and a test proves it cannot unlock one.
4. One take is never checked twice at once, and the same take against the same masters is read back free (the claim and stored result already work for people).
5. Every paid check and fix is quoted, sits inside the run's limit, appears in the ledger, and matches the project record.
6. The owner has seen 10 real verdicts beside his own judgement, and has said in writing that the thresholds stand. Until then the unattended switch stays off.
7. A test proves an agent or an MCP caller cannot take a people-only action (approve spend, unlock a master) through any path this package adds.

## 2. What exists today (and what is reused)

Everything below is on `main` (a00226e1) unless a branch is named. **Nothing is rebuilt.** P6b fills two empty seams and adds a thin layer around code that already works for people.

| What | Where | State |
|---|---|---|
| Verify check: a vision judge scores identity, wardrobe, environment, props, artifacts; the code (never the judge) decides pass, fail or "needs you" | `lib/workbench/verify.ts` (rubric, thresholds, key), `verify-judge.ts` (prompt, answer reader, token estimate), `verify-server.ts` (evidence gathering, stored result, mock judge) | Works for people from a Verify card |
| It runs as the development kind `verify`: quote, reservation, durable phase, settlement, recovery | `lib/workbench/development-server.ts` (`prepareDevelopmentJob`, `quoteDevelopmentJob`, `runDevelopmentStep`) | Reused as is |
| One take is never checked twice at once; the same take, masters, rubric and frames read back free | `claimVerifyKey`, `storedVerification`, table `take_verifications` (unique on take, master set, rubric, frames) | Reused as is |
| Locking a master (free), unlocking (admin and a reason only), history, drift check | `lib/masters.ts` (`lockMaster` already accepts `agent: { runId }`, `unlockMaster`, `masterCheck`), `lib/workbench/master-lock.ts` (`unlockProblem` refuses an agent) | Works for people |
| The agent's run, its paid steps, the run limit and its reservation | `lib/workbench/rig-agent.ts`, `rig-agent-runs.ts`, `rig-agent-plan.ts`, `rig-agent-store.ts`, `lib/runLimit.ts`, `lib/generationRequests.ts` (`reserveGenerationSpend`) | Plans, builds, renders inside an approved limit |
| **The two empty seams** | `RIG_AGENT_VERIFY` and `RIG_AGENT_LOCK` in `lib/workbench/rig-agent-runs.ts` (both `null`); `currentPaidStep` and `verifyStep`/`lockStep` already branch on them; the plan already emits a `verify` step after each render and a `lock` step per named master (`rig-agent-plan.ts`, `compilePlan`) | Shown to the person as "Verify arrives in the next update"; never run |
| The one-line note on a card | `verifyNote` and `shotHistory` in `components/graphite/board/cards/take/take-model.ts` (branch `demo/board-everyone`); the take card shows it | Reads stored verifications by take id, so it lights up as soon as the agent stores one |
| Reject with a reason, approve, review mode | `components/graphite/board/cards/take/use-judge.ts`, `review/ReviewMode.tsx` (same branch) | Reused; a failed check hands the person the same Approve and Reject |
| Mock judge for tests | `mockVerifyReply` in `verify-server.ts` (compares average colours) | Reused for every test here |
| Existing tests to extend, not duplicate | `tests/unit/rigVerify.spec.ts`, `tests/unit/rigLock.spec.ts`, `tests/rig-verify-workbench-api.spec.ts`, `tests/suites-rig-verify-workbench.spec.ts`, `tests/suites-rig-lock-workbench.spec.ts`, `tests/suites-rig-agent-workbench.spec.ts` | Run in CI today |

**Gaps this package fills** (found by reading the code, not assumed):
1. The Verify check works only from a **Verify card** (`verifyTarget` refuses any other node), and a video's three review frames are **sampled in the browser** (`VERIFY_FRAMES`, "the server has no decoder"). An unattended run has neither a person's open board nor a Verify card.
2. The development path takes **no run limit**. The planning turn reserves inside the run's limit through `reserveGenerationSpend({ run })`; the `verify` job does not, so a check could spend outside what the person approved. The seam's own comment says it must.
3. There is **no look anchor** in the rubric. The five checks compare with cast, environment and props masters only. SOW § 3.4 says "against the anchor and locked masters".
4. A failed check today ends in "this take needs you". There is **no fix step**.
5. The plan card and its model only list renders (`tool === "render"` in `components/graphite/board/cards/plan/model.ts`), so checks and fixes are not shown as priced lines yet.
6. **Same-face scoring** (an extra face comparison) does not exist anywhere in the repo.

## 3. The design

### 3.1 One review service, no framework in it
A single server module, `lib/workbench/agent-review.ts` (new), holds the logic: gather evidence, quote, reserve, run, read the verdict, decide the next move. It is plain async functions with dependency injection, like `rig-agent-runs.ts`. Today the two seams call it. In S2 each LangGraph node calls the same functions, so P6b is not thrown away when S2 lands.

### 3.2 Checking without a Verify card
Add a "virtual subject": the shot card, its wired masters and the anchor, read from the team canvas on the server, passed to the same `verifySubject`/`compileVerify` code. No card is created on the board, so nothing clutters it. The result is stored in `take_verifications` with the shot's node id in `verify_node_id`; `verifyNote` already finds it by take id. The Verify card stays for people who want one. (Owner decision 1 asks whether he prefers visible Verify cards.)

### 3.3 The anchor
- Shot 1 is marked the look anchor by the plan (S1/S2 own the mark; until S1 lands, the plan's first render is the anchor and the run records it on its own row).
- Rubric version 2 adds one check, **look**: colour, light and lens feel against the anchor frame. It is the only check that uses the anchor. The other five stay as they are.
- `VERIFY_RUBRIC` goes from 1 to 2. The file already says "a new rubric is a new check": stored version-1 results stay readable and read as "checked against an older rubric" through `verificationStanding`; nothing is re-run or re-billed.
- The anchor's identity joins the master-set key like any master (`look:generation:<id>`), so a new anchor is a new check.
- Thresholds for `look` start strict like the others ("when a check is unsure, it asks you", owner, 28 Sep) and are finalised only after the calibration in PR 5.

### 3.4 Money: quoted, inside the limit, one claim
- Each check is quoted through the existing `quoteDevelopmentJob` (a vision model; "about N cr" from `verifyLikelyTokens`, never above its ceiling), shown as a priced line on the plan, and reserved **inside the run's limit**. This needs one change in the money path: `prepareDevelopmentJob` accepts an optional `run: RunSpend` and passes it to `reserveGenerationSpend`, exactly as the planning turn does. That change is PR 2 and is reviewed as money.
- The claim on the take's key is the existing `claimVerifyKey`. The agent goes through `prepareDevelopmentJob`, so two runs, a person and the agent, or two server instances can never check the same key twice.
- A check the run cannot afford pauses the run with the existing "needs you" reasons (limit, balance); it does not skip the check and carry on.
- Atomik's review notes are "billed as the planning turn is" (CLAUDE.md rule 14). The plan lists checks and the fix allowance as lines so the person approves them once with the plan. Whether that billing is per request or per plan is the SOW's open decision (owner decision 2); this package follows the code's behaviour today and changes nothing there.

### 3.5 What a verdict does to the run
| Verdict | Run does |
|---|---|
| pass | Records "Verified", moves on |
| fail | Starts a fix if the shot has fixes left and the allowance covers it; else asks the person with the note |
| needs you (unsure) | Never passes. Asks the person with the note |
| check could not run (no key, no frames, offline judge) | Says so on the card and asks; never counts as a pass |
Every "asks" is a pause with the same Approve and Reject the person already has, plus "Try the fix again" only if fixes remain.

### 3.6 Fixes (money; after U1's plan approval and A1)
- At most two per shot (rule 14). Counted on the run, on the server.
- Still frame: a targeted edit of the failed area with an image edit model already in the catalogue.
- Video take: the existing `edit` task on the failed take where its limits allow (the task rules in `lib/tasks.ts` cap source length), else a re-render of the same shot with the judge's note added to the prompt. Same engine, same settings, so the price is the shot's own price.
- Each fix is priced by the existing path, drawn from the plan's fix allowance (2 × the plan's shot prices), and recorded on the project record. A fix above the allowance, a third fix, or a fix on another engine asks again.
- A fix is itself checked once. A second failed check ends the loop: the card says what was tried and the person decides.

### 3.7 Locks
`RIG_AGENT_LOCK` becomes `lockMaster({ canvas: { productionId, nodeId } }, { userId, name, admin, agent: { runId } })`, as its comment describes. Free. Only a card the plan names, of kind cast, environment or element, with a stored source. The agent route never reaches `unlockMaster`; a test calls it as an agent and expects the refusal in `unlockProblem`. A later edit of a locked master's picture is a new version and `masterCheck` reports drift. Whether dependants are marked stale is confirmed in PR 1 and added there if missing.

### 3.8 Video frames on the server (needs the worker)
Today three stills are sampled in the browser. For an unattended run the worker container (P8) samples frames with FFmpeg (the same three points for the judge, six for the face match) and stores them as uploads with their hashes, exactly as the browser path does, so the evidence and the key stay the same. Until the worker exists, a video take reads "Checked when frames can be read on the server"; **it is never marked verified**, and the person's own review stands. Stills are checked from day one.

### 3.9 Same-face score (last, optional, behind a setting)
One more score inside the identity check for cast masters: a face comparison service called directly on its own key, region ap-south-1, off when the key is unset, threshold in settings. Stateless: it compares two images and keeps no face data. It is **only** run on cast masters that were made by Particl (AI characters). A real person's face needs a recorded consent (rule 11, E4's consent records); until E4 exists the check stays off for real people's faces. Its price must come from a verified rate (A1: a tool that cannot be priced cannot run). Owner decision 5.

### 3.10 What is stored per verdict
Already stored (`take_verifications`): take id, master-set key, rubric, frames, per-check score and reasons, verdict, judge model, credits, who, when. P6b adds an additive table `agent_reviews` (workspace database): run id, step id, node id, take id, verification id, attempt number, action (`passed`, `asked`, `fixed`), fix job id, anchor id, rubric, thresholds version, created at. No prompt text, no pictures beyond what `take_verifications` already keeps (review-copy hashes). Traces to Langfuse (S2) carry ids, models, tokens and cost only.

## 4. PR-by-PR breakdown

One concern per PR, in this order. "Five sizes" means Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080 with no horizontal overflow. Gates follow SOW § 0: UI after the owner's preview check; money, sign-in and tenant separation after the independent review and the owner's yes.

| # | PR | Tests | Gate |
|---|---|---|---|
| 1 | **Locks by the agent.** Set `RIG_AGENT_LOCK`; plan's `lock` steps become runnable; confirm (add if missing) that editing a locked master marks dependants stale | Unit: agent locks a named cast, environment and element card; refuses a card the plan does not name, a Ref, an unstored picture; idempotent on replay; **agent cannot unlock** (`unlockProblem`); tenant isolation (a card of another workspace is not found). Extend `rigLock.spec.ts` and `suites-rig-lock-workbench.spec.ts` | Independent review (agent authority), then owner's yes. Free, so no money gate |
| 2 | **Verify inside the run's limit.** `prepareDevelopmentJob` takes `run: RunSpend`; the virtual subject (no Verify card); `RIG_AGENT_VERIFY` for still takes; verdict mapping and pauses; `agent_reviews` table | Unit: a check that would pass the limit is refused with the run's own wording; settled tenths match the ledger; stop releases the hold; two runs and a person claiming one key, one check runs; replay of a lost reply charges once; mock judge verdicts for pass, fail, unsure; frames missing says so. Extend `rigVerify.spec.ts`. Mocked end to end in the existing agent workbench spec | **Independent review + owner's yes** (money, claim, run limit) |
| 3 | **Anchor and rubric version 2.** `look` check, anchor in the master set, thresholds table, standing words for version-1 results | Unit: key stability (same inputs, same key), version-1 rows read "older rubric", threshold boundaries (at pass, at fail, between), the judge's prompt carries the anchor image index. No UI | Independent review (it changes what "pass" means); owner's yes with PR 5's calibration |
| 4 | **The note on every card.** Frames, anchor and takes show "Checking…", "Verified", or the one-line reason; the plan card lists the checks and the fix allowance as priced lines; phone plan screen and phone review show the same line | Unit for the line builder (length, the 120-character rule, no prompt text). Playwright at five sizes on the board and the phone screens: note visible, wraps, 12 px and 55% white floors, 44 px targets, no overflow; screenshot beside the handoff | **Owner's preview check** (UI). Built on Release 1's board, so it follows the Release 1 merge |
| 5 | **Calibration harness.** A script and a read-only page (internal workspace only) that lists the verdicts for a chosen set of takes beside a box for the owner's own call (pass, fail, unsure), and a report of agreement | Unit on the report maths. Mocked run in tests. The paid run itself is not a test | The paid run: **owner's yes with its cost stated first**, internal workspace only, 10 takes |
| 6 | **Unattended switch.** A workspace setting, default off, that lets the run continue past a pass without waiting for the person. Fail and unsure always ask | Unit: off means every verdict waits; on means only a pass continues. Playwright: setting shown in Spending rules, admin only | **Independent review + owner's yes**, after PR 5's result |
| 7 | **Fixes, at most two per shot.** Fix step kinds, counter, allowance draw-down, the second check, the stop and ask | Unit: fix 1 and 2 run, fix 3 refused by the server; allowance exhausted asks; price drift asks; a fix on another engine asks; a stopped run releases unspent holds; ledger rows tie to the project record; an agent or MCP caller cannot approve a fix (refused as `agent:*`). Mocked run: fail, fix, pass | **Independent review + owner's yes**. Needs U1's plan approval with allowance and A1 |
| 8 | **Frames on the server.** FFmpeg frame sampler in the worker container, event through the dispatcher, same evidence and key as the browser path | Unit with fixture clips (still, short video, one with no video track); output hashes stable; job idempotent on replay. Staging smoke test | Owner's yes for the worker image change (platform step; Claude Code prepares, the owner does the Coolify steps). Needs P4 and P8 |
| 9 | **Same-face score** (only if the owner says yes to decision 5) | Unit with a mocked face service: score joins identity, threshold from settings, off when the key is unset, never called for a real person's face without consent, no face data stored | **Independent review + owner's yes** (new provider, key, consent) |

PRs 1 to 4 can start as soon as the plan is approved and do not wait for A1: they extend today's agent through its seams. PR 7 waits for U1 and A1. PRs 8 and 9 wait for the platform packages and for owner decisions.

## 5. Dependencies

| Needs | For | Effect if late |
|---|---|---|
| **P4b** (direct provider APIs, gateway removed) | The judge model and the edit models run on their own provider keys | The judge keeps its current route; PR 2 is written against the model catalogue, not a provider |
| **A1** (registry) | Verify, lock, fix (and later face match) declared as tools with price, mock and "who may call" | PRs 1 to 6 go through the existing seams; they are re-declared as tools when A1 lands, with no change in behaviour. PR 7 should wait for A1 so fixes are born as tools |
| **S1** (board backend) | The anchor mark on a card, approval records, the project record, groups for live status | Until then the run records the anchor on its own row; the note reads from `take_verifications` which already exists |
| **S2** (LangGraph) | Calls the review service as nodes | P6b is built first on purpose; S2 consumes it |
| **U1** | Plan approval with a fix allowance (the approval primitive PR 7 draws on); the balance check | PR 7 waits |
| **Release 1** | The board screens PR 4 draws on | PR 4 waits |
| **P4, P8, E7's FFmpeg build** (VPS) | Frames on the server (PR 8) | Video is not auto-verified until then |
| **E4** (consent records) | Face score on real people | Face score stays off for real faces |
| **Higgsfield rule** | None: nothing here needs a Higgsfield sign-in | |

## 6. Risks

1. **A pass the person would not give.** The judge is a model. Mitigation: strict thresholds, "unsure asks", calibration (PR 5) before unattended mode, never silent retry.
2. **Spend outside the limit.** The development path has no run limit today. Mitigation: PR 2 adds it first, with tests on the limit arithmetic and a lost-reply case, and independent review.
3. **Double charge.** Two runs or a run and a person on one take. Mitigation: the existing key claim; tested across two server instances.
4. **Video with no frames.** Unattended runs cannot check video until the worker exists. Mitigation: say so on the card; never mark verified.
5. **Face data.** A face comparison of a real person is biometric processing and needs a recorded consent. Mitigation: off for real people until E4; stateless; owner's yes.
6. **Rubric change moves old results.** Mitigation: a new rubric is a new key; old rows read "older rubric", nothing re-billed.
7. **Cost creep on long productions.** Every take is a check, and every fix another. Mitigation: checks are listed and priced in the plan, the run's limit and the 80% stop (S2) still apply, and a take already checked is free to read.
8. **Judge sees a real person's likeness.** The judge already sees uploaded masters when a person runs a check. The agent runs it more often. Mitigation: no change in who sees what; images go only to the provider the workspace's model policy names; nothing stored beyond hashes and review copies already kept.

## 7. Open owner decisions

1. **Visible Verify cards or none.** Recommended: no card; the note sits on the take, and a Verify card remains for people.
2. **How checks are billed.** Per request (each check is its own line) or inside the plan's thinking. This is the SOW's open "per request or per plan" item; P6b follows today's behaviour until he decides.
3. **The `look` check and the anchor.** Confirm the anchor is always shot 1, and that "look" is one more check rather than a change to the existing five.
4. **Fix for a failed video take.** Recommended: the edit task where it fits, else a re-render of the same shot with the judge's note. Or always re-render (simpler, can cost more).
5. **Face comparison.** Yes or no, on a new provider key (AWS, ap-south-1), and only for characters Particl made until consent records exist.
6. **Which 10 takes for calibration**, and who judges them (the owner alone, or the owner plus one editor). Cost is stated from the quote path before the run.
7. **Unattended default.** Recommended: off for every workspace until calibration is signed off, then Ask stays the default for spending and "continue after a pass" is an admin setting.
8. **What the person sees for an unchecked video** before the worker exists: "Not checked yet" with a manual "Check now" (opens the existing Verify flow), or nothing.

## 8. Estimate

| PR | Agent-days |
|---|---|
| 1 Locks | 0.5 |
| 2 Verify inside the limit | 3 |
| 3 Anchor and rubric 2 | 1.5 |
| 4 Notes and plan lines (UI) | 1.5 |
| 5 Calibration harness | 1 |
| 6 Unattended switch | 1 |
| 7 Fixes | 3 |
| 8 Server frames | 2.5 |
| 9 Same-face score | 2 |
| Independent review, rework, preview fixes (about 20%) | 3 |
| **Total** | **about 19** |

Of these, about 8 days (PRs 1 to 4 and 6) need nothing from other packages; PRs 5 and 7 need the owner's yes and U1/A1; PRs 8 and 9 sit behind the VPS and the consent records. With 2 agents in parallel, the unblocked part is about 4 calendar days after approval of this plan.
