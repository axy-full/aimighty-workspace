# Plan: S2, Atomik on LangGraph.js (Phase 2)

Status: plan only, 6 October 2026. Build starts Fri 9 Oct. Nothing merges before the demo.
Scope source: `docs/particl-sow.md` (v2, 6 Oct) § 0, § 3 (goal), § 3.5 and § 8; handover `docs/handover-2026-10-05.md` § B4.2, § B5.2 and Part D "S2"; `CLAUDE.md` rules 1, 2, 11, 13, 14 and § Pricing.

This plan names no key values, vendor costs or internal pricing figures. Customer prices come only from `CLAUDE.md` § Pricing.

---

## 1. Goal and done-when

**Scope (SOW § 3.5):** questions → brief/shot list → plan → approval (interrupt) → anchor → review → remaining shots → cut → deliver; "Where to next?" after each step; checkpointer in each workspace's own libSQL database; Stop releases unspent holds; budget ceiling per production, asks at 80%; board ops as MCP tools behind the same gates; traces to Langfuse (ids, models, tokens, cost, never prompt text); thinking billed as rule 14 says.

**Phase 2 goal (SOW § 3):** an InVideo-style run on the Studio board. Atomik asks its questions, writes the brief and shot list, prices a plan, waits for one approval, makes shot 1 as the look anchor, reviews it, makes the rest, fixes at most twice per shot, assembles the cut and delivers, with every paid step at its quoted price and the ledger matching.

**Done when**
1. Every step above is a node in one LangGraph.js graph. Every approval, and every wait for a person, is an interrupt.
2. A run survives a crash or a redeploy at any point and resumes from its last checkpoint without repeating a paid call (test: kill the tick mid-node, resume, and the ledger has each charge once).
3. Checkpoints live in the workspace's own database, never shared.
4. No paid step runs without a person's approval of a quote; a plan's approval covers only its listed steps and fix allowance, up to its total.
5. Stop cancels queued steps and releases every unspent hold.
6. At 80% of the production's ceiling the run stops and asks: Continue or Stop.
7. Board operations are MCP tools, through A1's registry, behind the same gates. People-only actions are not among them.
8. Each run is traced to Langfuse with ids, models, tokens and credits, and never prompt or reply text (test asserts the payload).
9. **Phase 2 done:** one real production, in the internal workspace with the owner's yes, runs from brief to an approved cut on the board, every paid step approved at its quote, and the ledger matches. A test proves an agent cannot take a people-only action.

---

## 2. What exists today (extended, not replaced)

### Atomik's board runs (the loop S2 extends)
- `lib/workbench/rig-agent.ts`: a person asks; Atomik plans with dry tools; the person approves a limit and a mode (Ask or Auto); the build is applied through `applyCanvasOps` as `agent:<runId>`; renders run as paid steps inside the limit; Stop and Undo. State in the database; a **tick** under a lease moves a run a bounded amount, woken by Inngest (`rig-agent` in `lib/workers.ts`), the native worker, `after()`, or the cron; every tick checks the kill switch and the asker's membership.
- `lib/workbench/rig-agent-store.ts`: `rig_agent_runs` (one live run per production; limits approved; plan; lease; wake) and `rig_agent_steps` (tool, purpose, node, durable request key, prepared request, quote, approved by and fingerprint, job, reserved and settled credits, outcome).
- `lib/workbench/rig-agent-runs.ts`: paid steps next → waiting → approved → sending → rendering → done | failed, paused for a person; `requestKeyFor`; never send a paid request twice; the empty seams `RIG_AGENT_VERIFY` and `RIG_AGENT_LOCK` (P6b fills them).
- `lib/workbench/rig-agent-plan.ts`, `rig-agent-planner.ts` (planning turn reserved at its ceiling, settled at use: today's thinking billing), `rig-agent-limits.ts` (Ask/Auto, the per-job line), `rig-agent-settled.ts`.
- `lib/runLimit.ts`: a run's approved limit, enforced inside the reservation's write lock (`reserveGenerationSpend`).

### Other pieces S2 uses
- Atomik threads and steps: `lib/atomik.ts`, `app/api/atomik/*`. Suite agents: `lib/workbench/suite-agent*.ts` (the AI SDK `ToolLoopAgent`). Crew: `lib/workbench/crew.ts`.
- Verify and masters: `lib/workbench/verify.ts`, `verify-server.ts` (`take_verifications`), `verify-judge.ts`, `master-lock.ts`, `lib/masters.ts`.
- The cut: `lib/workbench/edit-versions.ts`, `editorial.ts`; pipelines' timeline manifest and the browser movie render (`docs/durable-production-pipelines.md`).
- Budget: `lib/caps.ts` (a production's cap in the workspace's unit; warns at 80%; stop, producer unlock or warn at the cap).
- Approval rule and guardrail 4: `lib/approvalRule.ts`. Push: `lib/push.ts`. Dispatch: `lib/dispatch.ts`.
- MCP: `lib/mcp.ts`, `app/api/mcp`.

### Packages
- Installed: `ai` 7, `@ai-sdk/openai`, `@ai-sdk/xai`, `@xyflow/react`, `@liveblocks/*`.
- Not installed: `@langchain/langgraph`, `@langchain/langgraph-checkpoint`, a Langfuse SDK. LangGraph's own SQLite saver runs on a local file driver, not on libSQL/Turso, so S2 writes a libSQL saver.

### Release 1 screens S2 drives (merged Thu 8 Oct)
The Atomik panel docked right, the plan card ("Make 3 shots · 93 cr · at most 186 cr"), the Approvals queue, the board's groups, "Where to next?" band and take cards. S2 changes what feeds them, not how they look, except where § 4 says.

---

## 3. Design

### 3.1 The graph (`lib/atomik/production-graph/*`)
State (small, JSON): workspace, production, run and thread ids; the brief doc's revision; the questions card id; the plan id and its approval id; the anchor shot; per shot: status, versions, fixes used; spend so far; the ceiling and whether the 80% ask was answered; the last "Where to next?" choice.

| Node | Does | Writes | Money |
|---|---|---|---|
| `questions` | Reads the brief. If it does not answer the essentials, writes a questions card (3–5 questions, chip options, "Use your judgement"), then interrupts (`answers`) | questions card (S1 op) | Thinking only |
| `brief` | Writes the brief and shot-list doc cards: screen direction, look, timed shots with size, camera, lens and sound, open decisions. Re-reads them at the start of every later node; a person's edits win | doc cards (S1 `doc.set`) | Thinking only |
| `plan` | Quotes every paid step through A1 (`quoteTool`); adds the fix allowance (2 × each shot's price, at most two fixes per shot); marks steps that need an admin; checks the balance against the total | plan card via S1's `writePlanCard()` | Quotes are free |
| `approval` | Interrupts (`approval`). Only A1's person-only approve route resumes it | — | The approval |
| `anchor` | Makes shot 1 (frame, then take) through A1's paid path inside the plan; marks it the look anchor; interrupts (`anchor`) for a person's look | take versions (S1) | Inside the plan |
| `review` | Runs Verify (P6b) on each frame and take; writes a one-line note on the card; on a fail, makes a targeted fix from the allowance, at most twice per shot; then asks | `take.note`, fix versions | Fixes inside the allowance |
| `remaining` | Makes the other shots with the anchor and the locked cast and environment masters as references | take versions | Inside the plan |
| `cut` | Assembles an edit version from the approved takes, in shot-list order; writes the cut card; a person approves it (S1 verdict) | cut card, edit version | Free |
| `deliver` | Computes the deliver card's checks against its spec; the master is rendered by a person through today's movie render until E7's server renders | deliver card | Free in Phase 2 |
| `whereNext` | After each step, a "Where to next?" card with two or three choices | questions card with role `next` | Thinking only |

- **Waiting on a render is an interrupt too** (`render`), resumed by the settlement event (`notifyRenderSettled`, `RIG_RENDER_SETTLED`). No node blocks while a provider renders.
- **Replay safety.** LangGraph re-runs a node from its start after a crash mid-node. So every side effect in a node uses an id derived from the run, the node and the step: canvas op ids, A1 request keys (`tool:<approvalId>:<n>`), doc revisions. A replayed node lands nothing twice. A test kills a tick after each side effect and resumes.

### 3.2 Where it runs: today's tick, not a new worker
- A run is still a `rig_agent_runs` row (new `kind = 'production'` beside today's build runs). The existing tick (`advanceRigAgentRun`, `driveRigAgent`) takes the lease, loads the graph with the libSQL checkpointer, and streams it until an interrupt, the tick budget, or the end. Then it releases the lease.
- Wake-ups stay as they are: Inngest's `rig-agent` function, the native worker, `after()`, the cron, and the settlement event. P4's self-hosted Inngest takes over later without a code change.
- The kill switch is checked on every tick (owner decision 7).

### 3.3 The checkpointer (workspace database, created on first use)
`lib/atomik/checkpoint-libsql.ts` implements LangGraph's `BaseCheckpointSaver` (`getTuple`, `list`, `put`, `putWrites`) on the workspace's libSQL client, inside `runInTenant`. Two additive tables, created with `CREATE TABLE IF NOT EXISTS` on first use, each keyed by `workspace_id` (rule 2):
- `atomik_checkpoints(workspace_id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata, created_at, PRIMARY KEY(workspace_id, thread_id, checkpoint_ns, checkpoint_id))`
- `atomik_checkpoint_writes(workspace_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value, PRIMARY KEY(workspace_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx))`
- The thread id is the run id. A run in workspace A can never load a thread from B: the client is B's own database, and every query also filters on `workspace_id`.
- Additive columns on existing tables (same `addColumns` pattern as today): `rig_agent_runs.kind`, `graph_version`, `budget_asked_at`; `rig_agent_steps.approval_id`, `attempt_id` (links to A1's `tool_approvals` and `tool_attempts`).
- The saver passes LangGraph's checkpointer conformance tests, run against a local libsql file.

### 3.4 Money: quote → approval → durable claim → poll → collect
1. **Quote.** `plan` calls A1's `quoteTool` for every step. A step that cannot be priced is listed as unavailable with its reason and is not in the total. Approximate steps (if any) count at their hold.
2. **Approval.** The plan card shows each step, its price, the fix allowance and the total ("Make 3 shots · 93 cr · at most 186 cr"), and which steps need an admin. One tap by a person approves the plan through A1 (`tool_approvals`, scope `plan`). The balance is checked against the total first, with Top up offered then. Anything outside the plan (a new shot, a fix past the allowance, another engine) is quoted and asked again.
3. **Durable claim.** Each step is claimed through A1 (`tool_attempts`, request key saved first) with the plan's total as the run's limit (`RunSpend`), enforced inside `reserveGenerationSpend`'s write lock.
4. **Poll.** The `render` interrupt is resumed by the settlement event, or by the tick's own look by key. A lost reply is asked about, never resent.
5. **Collect.** Settled credits and the provider's outcome go on the attempt, the step and the project record (S1). The run's ledger is the sum of its attempts; the qualification run checks it against the meter.

**Ask and Auto inside a plan.** The plan is one approval in either mode. Outside a plan, Ask (the default) asks for every paid step; Auto runs only a draft at or under the per-job line, and nothing above 200 cr ever runs without a tap.

**Atomik's thinking** (questions, the brief, the plan, review notes) is billed as rule 14 says: each planning turn is reserved at its ceiling against a limit the person approved when asking, settled at what it used, and not billed when nothing came back. This is today's `rig-agent-planner.ts` path, priced from P4b's pinned list. Whether thinking is limited per request or per plan is owner decision 1.

### 3.5 Budget ceiling and the 80% ask
- The ceiling is the production's cap (`lib/caps.ts`). A new production takes the workspace's default ceiling from Settings › Spending rules (owner decision 2). Only an admin sets or raises it.
- Before each paid claim the graph checks spend so far plus the step's worst case. At 80% it interrupts (`budget`) with Continue or Stop. Continue is a person's tap; raising the ceiling is an admin's. At the cap the cap's own rule applies (stop, or an admin unlocks).
- The 80% ask is recorded once per ceiling (`budget_asked_at`), so a resumed run does not ask twice for the same line.

### 3.6 Stop
- Anyone in the production may press Stop; Atomik may also stop itself.
- Stop marks the graph stopped, skips queued steps, fences every unsent request key, and releases unspent holds (A1's attempts; `lib/held.ts` for held takes). Work already sent finishes and settles; its card says what it cost.
- Group status shows "stopped". The project record shows spend at the stop.

### 3.7 People-only actions, and the test that proves Atomik can't take them
- The graph's model tools (what the language model may call) are built from A1's registry and exclude every `people` and `admins` tool: approving spend, setting limits and the ceiling, Top up, approving a post, recording consent. A test asserts the list.
- The `approval`, `anchor` (look), `budget` and verdict interrupts can be resumed only through routes that take a `PersonActor` (A1.3, S1.4). The tick itself cannot resume them.
- Defence in depth: A1's registry refuses a people-only tool for `agent:<runId>`; `tool_approvals` refuses an `agent:`, `mcp:` or `token:` approver.
- **Tests (`tests/unit/s2-people-only.spec.ts`):** a scripted model that tries to call `spend.approve`, `budget.set`, `topup.request`, `post.approve` and `consent.record` is refused at each layer and nothing is written; resuming an approval interrupt from the tick, from MCP or with a token is refused; a person's approval resumes it.
- Brief text and uploads can contain instructions. The gates are code, not prompts, so a brief cannot talk Atomik into approving.

### 3.8 Board ops as MCP tools
- Through A1's registry (A1.10), MCP gains: read a board, apply board ops (as `mcp:<tokenId>`, under S1's server-writer rules: a person always wins), ask Atomik to start or continue a production run, quote a plan, and Stop.
- Approving is not an MCP tool. A plan quoted over MCP returns an approval link for a person.
- Tenant: the token's workspace only; ids from another workspace answer 404.

### 3.9 Traces to Langfuse
- One trace per run; a span per node; a generation per model call. Fields: workspace, production, run, node and step ids; model id; input and output tokens; credits the ledger charged; durations; interrupt kinds.
- Never prompt text, reply text, brief or doc content, media URLs, keys or vendor costs. A test serialises a mocked trace and fails on any of them.
- Off when the Langfuse settings are unset. The owner sets them in Vercel (the `LANGFUSE_*` settings; names only in the PR, never values). Where traces live is owner decision 6.

### 3.10 Tenant separation
- Checkpoints, runs, steps, quotes, approvals and attempts live in the workspace's own database, keyed by `workspace_id`.
- Each tick runs inside `runInTenant` for the run's workspace and re-checks the asker's membership.
- Memory, skills, references and masters are read only from the run's workspace.
- Test: two workspaces each run a mocked production at once; neither reads or writes the other's checkpoints, board, docs or ledger.

### 3.11 Failure and refund paths
- **A provider fails and bills nothing:** the card says "Nothing billed" with Retry; Retry re-runs under the same approval, as a new attempt.
- **A provider fails and bills:** the card says what it cost, from the provider's own outcome.
- **A fix fails twice:** the shot is marked for a person; nothing more is spent on it.
- **Verify cannot decide:** "needs you" on the card; the run waits for that shot only, and carries on with the others.
- **The model call fails:** the thinking reserve is released when nothing came back; the run pauses with the reason.
- **Crash or redeploy:** the next tick resumes from the last checkpoint; replayed nodes land nothing twice (§ 3.1).
- **The balance runs short mid-plan:** it cannot, because the balance is checked against the plan's total (at its holds) before it starts. A refund or settlement under the quote only frees room.
- **The plan's quote expires before approval:** re-quoted; a higher total is shown again, never adopted silently.

---

## 4. PRs, in order (one concern each)

Every PR: typecheck, lint, full unit run, build; mocked engines and a scripted model only. Gate for every PR: an independent Opus review. Owner's yes where marked. UI PRs also need the owner's preview check, Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080, and the five-minute test.

| # | Branch | What | Tests | Owner's yes |
|---|---|---|---|---|
| S2.1 | `s2/1-langgraph-deps` | Add `@langchain/langgraph` and `@langchain/langgraph-checkpoint`; nothing imports them yet | Bundle-size check (`tests/unit/bundle.spec.ts`); licence check (MIT); audit clean | No (lead check: dependencies) |
| S2.2 | `s2/2-libsql-checkpointer` | The libSQL saver and its two tables | LangGraph's checkpointer conformance tests; idempotent creation; a read creates nothing; two-workspace isolation | **Yes: migration** |
| S2.3 | `s2/3-graph-host` | The graph skeleton (nodes as stubs), interrupts, the tick host, `kind = 'production'` and the new columns; the /admin setting "Atomik production runs", off | Kill mid-node and resume; leases; wake on settlement; kill switch; existing `rigAgent` specs unchanged | **Yes: migration** |
| S2.4 | `s2/4-questions-brief` | `questions`, `brief` and `whereNext` nodes; thinking reserved and settled | Skips questions when the brief answers them; person edits win; thinking billed only when something came back; golden credits | **Yes: money** |
| S2.5 | `s2/5-plan-approval` | `plan` and the `approval` interrupt; fix allowance; needs-admin marks; balance check with Top up | Plan total and allowance; unpriceable step excluded; approval only by a person; outside-plan steps ask again; expired quote | **Yes: money** |
| S2.6 | `s2/6-shots` | `anchor` and `remaining` through A1's paid path; masters as references; live group status; project record updates | Mocked end-to-end; ledger equals the sum of attempts; replay lands nothing twice; Ask and Auto rules; nothing above 200 cr without a tap | **Yes: money** |
| S2.7 | `s2/7-review-fixes` | `review` with P6b's Verify; at most two fixes per shot from the allowance; then ask | Pass, fail, needs-you; third fix refused; never a silent retry | **Yes: money** |
| S2.8 | `s2/8-stop-budget` | Stop releases unspent holds; the 80% ask; the cap's rule at 100% | Stop mid-render; holds released; 80% asked once; Continue by a person; raise by an admin only | **Yes: money** |
| S2.9 | `s2/9-cut-deliver` | `cut` (edit version from approved takes) and `deliver` (spec checks) | Cut order; cut verdict people-only; deliver checks; Playwright at five sizes on the cut and deliver cards | Owner's preview check |
| S2.10 | `s2/10-panel` | The Release 1 Atomik panel and plan card show the graph's states: questions, plan approval, anchor look, review notes, 80% ask, Stop, "Where to next?" | Panel states from fixture runs; approval buttons carry their price; Playwright at five sizes, phone plan approval included; the five-minute test | **Yes: money** (the approval button), and the owner's preview check |
| S2.11 | `s2/11-mcp-board-tools` | Board ops, start or continue a run, quote a plan, and Stop as MCP tools through A1 | No people-only tool listed; a plan over MCP returns an approval link; token's workspace only | **Yes: money and tokens** |
| S2.12 | `s2/12-langfuse` | Traces (§ 3.9), off when unset | Payload has ids, models, tokens and credits only; no text, URLs or keys | **Yes: env vars and secrets** |
| S2.13 | `s2/13-qualification` (docs only) | The Phase 2 run: one real production in the internal workspace, from brief to an approved cut; the ledger check | Every paid step approved at its quote; ledger matches; the report in the PR | **Yes: every paid step**, cost stated first |

---

## 5. Dependencies

- **S1:** S1.1–S1.4 (cards, ops, people-only verdicts) before S2.4; S1.7 (the record) before S2.6; `writePlanCard()` (S1.1) before S2.5.
- **A1:** A1.3 (`requirePerson`), A1.4 and A1.5 (the paid path) before S2.5; A1.9 (Atomik on the registry) before S2.6; A1.10 (MCP) before S2.11.
- **P4b:** the router and pinned prices (P4b.1–P4b.3) before S2.4.
- **P6b:** Verify and lock wired into the agent before S2.7. The anchor can ship before P6b with Verify shown as "arrives in the next update", as today's seam does.
- **Release 1:** the Atomik panel, plan card, Approvals queue and board bands (S2.10 drives them).
- **U1:** plan approval with its fix allowance, the balance check with Top up, and the five-minute test on every UI PR.
- **#540:** Cinema stays out of Atomik's plans until it merges.
- **E7** (November): server-side renders replace the person's browser render for the master.

---

## 6. Risks

1. **Replay doubling side effects.** Mitigation: deterministic ids for every write and request key; the kill-and-resume test after every side effect.
2. **Serverless time limits.** A tick is bounded; long work waits in interrupts, not in a node.
3. **The libSQL saver.** A custom saver can get ordering or pending writes wrong. Mitigation: LangGraph's own conformance tests, run in CI.
4. **Checkpoint growth.** Every step writes a checkpoint. Mitigation: state stays small (ids, not media or text); size measured on the qualification run; owner decision 5.
5. **Thinking cost.** A long production makes many model calls. Mitigation: each reserved at its ceiling inside the approved limit; the run pauses when the limit is reached.
6. **Plan quality.** The model may plan poorly. Mitigation: questions first, people's doc edits win, the anchor look before the rest, at most two fixes per shot.
7. **Prompt injection through briefs and uploads.** Mitigation: every gate is code; the model's tool list has no people-only tool.
8. **Trace leakage.** Mitigation: the payload test; traces off until the owner sets the keys.
9. **Two agents at once.** Today's build runs and S2's production runs share `rig_agent_runs`; the one-live-run-per-production index keeps them from overlapping.

---

## 7. Open owner decisions

1. **Thinking billing, per request or per plan** (SOW § 9 open item). (A) Per request, as today: each planning turn is reserved against a limit the person approves when asking, shown "up to N cr". (B) Per plan: the plan's total includes a thinking line, approved with the plan. Recommended: A for questions and the brief (before any plan exists), B once a plan is approved.
2. **The default ceiling for a new production.** (A) A workspace default an admin sets in Settings › Spending rules. (B) No default: Atomik asks an admin to set one before the plan. Recommended: A.
3. **Who may Continue at 80%.** (A) The person who approved the plan, or an admin; raising the ceiling stays admin-only. (B) Admins only. Recommended: A.
4. **The anchor look.** (A) Always stop for a person's look at shot 1 (one free tap). (B) Only in Ask mode; in Auto, carry on if Verify passes. Recommended: A for Phase 2.
5. **Checkpoint retention.** (A) Keep every checkpoint (nothing erased). (B) After a run ends, archive intermediate checkpoints and keep the final one and every interrupt. Recommended: A for Phase 2, then review the size.
6. **Where traces live.** (A) Langfuse Cloud's free Hobby plan now, ids-only, off until the owner sets the keys; self-hosted after P8. (B) Wait for self-hosted Langfuse on the VPS. Recommended: A.
7. **The kill switch.** A platform /admin setting "Atomik production runs", off by default, on for the internal workspace first. Recommended: yes (no env var).
8. **The master in Phase 2.** A person renders it with today's movie render until E7's server renders. Recommended: yes.
9. **The qualification production.** Which brief, which internal workspace, and the ceiling. Atomik states the plan's total and its "at most" before anything runs.

---

## 8. Estimate

| PR | Agent-days |
|---|---|
| S2.1 dependencies | 0.5 |
| S2.2 checkpointer | 1.5 |
| S2.3 graph host | 2 |
| S2.4 questions and brief | 1.5 |
| S2.5 plan and approval | 2 |
| S2.6 shots | 2 |
| S2.7 review and fixes | 1.5 |
| S2.8 Stop and budget | 1 |
| S2.9 cut and deliver | 1.5 |
| S2.10 panel | 1.5 |
| S2.11 MCP board tools | 1 |
| S2.12 Langfuse | 1 |
| S2.13 qualification | 1 |
| **Total** | **18 agent-days**, plus review rounds |
