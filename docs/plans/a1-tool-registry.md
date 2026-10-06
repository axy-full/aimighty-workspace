# Plan: A1, the tool registry (Phase 2)

Status: plan only, 6 October 2026. Build starts Fri 9 Oct. Nothing merges before the demo.
Scope source: `docs/particl-sow.md` (v2, 6 Oct) § 0 (agentic rule 11, money), § 3.2 and § 10; handover `docs/handover-2026-10-05.md` § B4.3 and Part D "A1"; `CLAUDE.md` rules 1, 2, 11, 14 and § Pricing.

This plan names no key values, vendor costs or internal pricing figures. Customer prices come only from `CLAUDE.md` § Pricing.

---

## 1. Goal and done-when

**Scope, SOW § 3.2, verbatim:**

> **A1, the tool registry:** engine tools generated from `lib/models.ts` and the task/still tables; app actions (board ops, Stop, Retry, approve, publish, consent) declared beside their handlers. Per tool: id, inputs and limits, provider, key, price function, mock, who may call it. One paid path: quote → approval → durable claim → poll → collect. A tool that can't be priced can't run. Consumers: buttons, Make, board cards, Atomik, skills, MCP.

**Goal.** Every feature is a tool before it is a button (rule 11). A button, Make, a board card, Atomik, a saved skill and an outside agent over MCP reach the same tool, at the same price, through the same approval.

**Done when**
1. Every offered model, task, still tool, audio kind and development kind has exactly one engine tool, generated from the tables that already define it. A test fails if a table gains an entry with no tool, or a tool with no price function, mock or key.
2. Every app action named in the SOW (board ops, Stop, Retry, approve, release, publish, record consent, set limits and budget, top up) is declared beside its handler, with who may call it.
3. Every paid call, from every consumer, goes quote → approval → durable claim → poll → collect. An unapproved call spends nothing (test).
4. A tool that cannot be priced is listed as unavailable with its reason, and cannot run (test).
5. A tool without its key says which key (to admins) and cannot run (test).
6. People-only actions refuse Atomik (`agent:<runId>`), MCP callers and every API token. A test proves it for every people-only tool.
7. A parity test proves the button's price, Make's price, Atomik's price and MCP's price are the same figure for the same input.
8. Atomik's Tools & connections page and its per-suite tool lists read the registry.

---

## 2. What exists today (reused, not rebuilt)

### The tables engine tools come from
- `lib/models.ts`: `MODELS` (every video and image engine, its provider, `supportsTasks`, `supportsDraft`, `retired`, billing style), `AUDIO_LABELS`, `offeredModels`, `retiredReason`.
- `lib/tasks.ts`: `TASKS` (generate, edit, extend, motion, upscale, reframe, genjutsu) and their source rules.
- `lib/stillTools.ts`: `STILL_TOOLS` (outpaint, cut-out, upscale).
- `lib/vendorRates.ts`, `lib/vendorPricing.ts`, `lib/creditTerms.ts` (`billCredits`), `lib/billingTerms.ts`: the only price path.
- `lib/workbench/development-types.ts` (`DevelopmentKind`: idea, screenplay, ad film, write, frames, sketch, cast, environment, beat sheet, condense, rig, verify) with `quoteDevelopmentJob` and `prepareDevelopmentJob` in `lib/workbench/development-server.ts`.
- `lib/engines/*` and `lib/providers.ts`: one adapter per provider; each provider names its key (`lib/vendorKeys.ts`).

### The paid path that already exists (pieces A1 joins up)
| Step | Today | Where |
|---|---|---|
| Quote | Free, repeatable preparation that returns a fingerprint and credits | `prepareGeneration`, `quoteGeneration` (`lib/generationAdmission.ts`); `lib/audioAdmission.ts`; `quoteDevelopmentJob`; `app/api/generate/quote`, `app/api/rig/quote` |
| Approval | A person's press with a fresh fingerprint; Atomik run limits and per-step approvals; pipeline stage approvals; held-take release | `app/api/generate/route.ts` (`quoteFingerprint` checkpoint); `approveRigAgent`, `renderRigAgentStep`, `raiseRigAgentLimit` (`lib/workbench/rig-agent.ts`); `lib/pipeline/*` (`pipeline_quotes`); `app/api/jobs/[id]/release` |
| Durable claim | A request key saved before sending; reservation under the write lock; a run's limit checked inside it | `withGenerationRequest`, `reserveGenerationSpend`, `fenceGenerationRequest` (`lib/generationRequests.ts`); `requestKeyFor` (`lib/workbench/rig-agent-runs.ts`); `pipeline_attempts` |
| Poll | Ask by key after a lost reply; never resend a key | `checkGenerationRequest`; `lib/jobs.ts`; `lib/recovery*` |
| Collect | Settled credits and the provider's outcome | `lib/meter.ts` (`meter`, `meteredCharge`), `credit_receipts`, `lib/billingLedger.ts`, `rig_agent_steps.credits_settled/outcome` |

The client-side `ApprovedQuote` brand in `lib/workspace/run-engine.ts` and `plan-types.ts` (only `approve()` can mint one) is the model for the server-side token in § 3.4.

### Limits that already guard spend
- Approval rule and guardrail 4: `lib/approvalRule.ts` (`JOB_APPROVAL_LINE_USD`, 200 cr at $0.10).
- Ask and Auto: `lib/workbench/rig-agent-limits.ts`.
- Project caps (warn at 80%): `lib/caps.ts`. Monthly allowance on platform keys: `lib/allowance.ts`. Run limits: `lib/runLimit.ts`. Token ceilings: `lib/auth.ts` (`tokenSpendThisMonth`, `tokenCreditsThisMonth`).

### Consumers today
- Buttons and Make (`app/api/generate`, the Make panel from Release 1).
- Board cards and Atomik's board runs (`lib/workbench/rig-agent*.ts`, `app/api/workbench/team-canvas`).
- Atomik threads (`lib/atomik.ts`, `app/api/atomik/steps/[id]/claim`).
- Skills (`lib/atomikSkills.ts`, `app/api/atomik/skills/[id]/run`).
- MCP (`lib/mcp.ts`, `app/api/mcp`): hand-written `TOOLS`, routed through the app's own HTTP API with the caller's token. That design stays (§ B4.3).
- Tools & connections (`components/graphite/atomik/ToolsView.tsx`, `lib/shell/tools-connections.ts`).
- The control room's Approvals queue (Release 1: `lib/control-room/approve.ts`, `queue.ts`).

### Two gaps found while planning
1. `POST /api/jobs/[id]/release` uses `requireUser`, and `POST /api/atomik/steps/[id]/claim` uses `requireRender`. Both accept API tokens. Both approve spending. Rule 14 says only a person approves. A1.3 fixes both.
2. MCP's `render_shot` spends on a render token today, up to the token's monthly ceiling. The SOW says MCP callers quote, never approve. A1.10 changes it (owner decision 2).

---

## 3. Design

### 3.1 The tool definition (`lib/tools/types.ts`)
```ts
type Caller = "anyone" | "people" | "admins";
type Price =
  | { kind: "free" }
  | { kind: "exact"; credits: number }
  | { kind: "upTo"; credits: number; hold: number }          // approximate: "about N cr, at most 3N cr"
  | { kind: "unavailable"; reason: string };

type ToolDef<I> = {
  id: string;                 // "engine:seedance-2.5:generate", "board.op.create", "spend.approve"
  kind: "engine" | "action";
  label: string;              // the UI name (no banned names)
  inputs: ZodType<I>;         // with limits: lengths, durations, sizes, counts
  provider: ProviderId | null;
  key: VendorKeyName | null;  // the key it needs, if any
  price(input: I, ctx: ToolContext): Promise<Price>;
  mock(input: I): ToolMock;   // deterministic, used by ENGINE_MOCK and tests
  callers: Caller;
  handler: string;            // the route or lib function that does it, for the declaration test
};
```
- Ids are stable strings. Engine ids are built from the model id and task, so a model's tool id never changes when the table is re-ordered.
- `label` is the SOW's UI name. Code names stay in code.
- Most app actions are free. A paid app action (Retry, release) prices through its engine tool.

### 3.2 Engine tools: generated, never hand-kept (`lib/tools/engine-tools.ts`)
- One tool per offered model × supported task (`MODELS` × `supportsTasks`, generate by default), per still tool (`STILL_TOOLS`), per audio kind (`AUDIO_LABELS` and `lib/audioAdmission.ts`), and per development kind (`DevelopmentKind`).
- Price functions wrap the existing free preparation: `prepareGeneration` for video and stills, the audio admission's preparation, `quoteDevelopmentJob` for development kinds. A1 writes no new price arithmetic.
- An approximate quote (Cinema Studio, settled on what it delivers) is `upTo` with its hold, exactly as #540 holds it. Until #540 merges, Cinema stays hidden, so its tool is `unavailable`.
- A retired model has no tool for new work. Its id still resolves for past jobs.
- A model whose key is missing is `unavailable` with the key named (to admins) or "not connected" (to members).

### 3.3 App actions: declared beside their handlers
- Each handler module gets a sibling `*.tool.ts` that declares its actions: for example `lib/workbench/canvas-ops.tool.ts` (create, move, wire, unwire, set, tidy, remove), `lib/held.tool.ts` (release), `lib/workbench/rig-agent.tool.ts` (stop, retry, skip, raise the limit), and later S1's `board-*.tool.ts`.
- `lib/tools/index.ts` imports every `*.tool.ts`. A test globs the repo and fails if a `*.tool.ts` is missing from the index, or a declared `handler` does not exist.
- **People-only actions** (SOW § 0): approving spend (`spend.approve`, `plan.approve`, `job.release`), setting spend limits and the budget ceiling (`limits.set`, `budget.set`, `spend-without-asking.set`), topping up (`topup.request`), approving a post (`post.approve`), recording consent for a face or voice (`consent.record`). Setting limits, the budget and the Ask/Auto setting are also admins-only.

### 3.4 One paid path (`lib/tools/paid.ts`)
The pipelines (`lib/pipeline/*`, `docs/durable-production-pipelines.md`) already do quote, approval and attempts durably. A1 generalises that shape for every tool and keeps pipelines working as they are.

1. **Quote.** `quoteTool(toolId, input, caller)` runs the price function and stores a `tool_quotes` row: the exact prepared request (server only), its fingerprint, credits, hold, expiry, who asked (a person, `agent:<runId>` or `token:<id>`), and whether the approval rule needs an admin. The caller gets a clean quote: credits, "about"/"at most", expiry, who must approve. No vendor figure.
2. **Approval.** `approveQuote(quoteId, person)` takes a `PersonActor`, which only `personActor(sessionUser)` can build (the server-side twin of `mintApproved`). It re-checks fingerprint, expiry and inputs; the approval rule (`lib/approvalRule.ts`: a step over the rule's cap needs an admin; anything over 200 cr always needs a tap); the project cap (`lib/caps.ts`); and the balance against the total, offering Top up when short. It writes a `tool_approvals` row. A plan approval (S2) is one row with scope `plan`, covering its listed steps and fix allowance up to its total. Auto (an admin's standing setting) writes a row with scope `auto` that names the setting's version, and covers only a draft at or under the per-job line.
3. **Durable claim.** `claimTool(approvalId)` inserts a `tool_attempts` row with a deterministic request key (`tool:<approvalId>:<n>`) before anything is sent, then admits through the existing admission (`admitGeneration` and its siblings) with that key and the approval's limit as a `RunSpend`. `reserveGenerationSpend` refuses anything past the limit inside its write lock, as it does for Atomik runs today.
4. **Poll.** `pollTool(attemptId)` asks by key (`checkGenerationRequest`) and reads the job. A lost reply is asked about, never resent. A new key is used only after the old one is fenced and proven never admitted.
5. **Collect.** `collectTool(attemptId)` reads the settled credits (`meteredCharge`, `credit_receipts`) and the provider's outcome (billed, refunded, or not stated), and writes them on the attempt and the approval. The project record (S1) reads from here.

**A button press** with a fresh quote is quote + approval + claim in one session request, as `/api/generate` does now with `quoteFingerprint`. The route keeps its contract. Under it, the press writes the same approval and attempt rows (owner decision 1).

**A tool that cannot be priced** has no quote, so it has no approval, so it has no claim. There is no other door: the admission functions take an approved attempt, and a test proves no consumer calls them directly.

### 3.5 Tables and migration (workspace database, created on first use)
All three are additive, in each workspace's own database, created with `CREATE TABLE IF NOT EXISTS` on the first paid call through the registry, the same way `pipeline_*`, `rig_agent_*` and `rig_canvas_ops` are. No existing table is altered. The platform database is untouched. Every table carries `workspace_id` in its key (rule 2).

- `tool_quotes(workspace_id, id, tool_id, caller, input_hash, prepared, fingerprint, credits, hold_credits, approximate, needs_admin, production_id, expires_at, state, created_at, PRIMARY KEY(workspace_id, id))`. States: open, approved, declined, expired.
- `tool_approvals(workspace_id, id, scope, quote_id, plan_id, run_id, limit_credits, approved_by, approved_name, rule_version, approved_at, closed_at, settled_credits, PRIMARY KEY(workspace_id, id))`. `approved_by` is always a person's user id, or `auto` with the admin's setting version. A check refuses any `agent:`, `mcp:` or `token:` value.
- `tool_attempts(workspace_id, id, approval_id, tool_id, number, request_key, state, generation_id, credits_reserved, credits_settled, outcome, error, created_at, updated_at, PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, request_key), UNIQUE(workspace_id, approval_id, tool_id, number))`.
- Indexes: quotes by `(workspace_id, state, expires_at)`, attempts by `(workspace_id, approval_id)`.
- **Rollback:** revert the code; the tables sit unused. Nothing is dropped (never erase team data).

### 3.6 Routes (thin, over the libs above)
| Route | Who | Does |
|---|---|---|
| `GET /api/tools` | members, read tokens | The registry, with availability and reasons for this caller. Prices are not listed here; they are quoted on demand |
| `POST /api/tools/[id]/quote` | members, render tokens, Atomik in-process | A quote (§ 3.4 step 1). Free |
| `POST /api/tools/quotes/[id]/approve` | **a signed-in person only** (`requirePerson`) | Approval (step 2) and the claim (step 3) |
| `POST /api/tools/quotes/[id]/decline` | members | Lets a quote go. Free |
| `GET /api/tools/attempts/[id]` | members, read tokens | Poll and collect (steps 4 and 5) |

Existing routes stay: `/api/generate`, `/api/generate/quote`, `/api/rig/quote`, `/api/jobs/[id]/release`, `/api/workbench/team-canvas` actions, `/api/pipelines/*`. A1 routes their insides through the registry; their request and reply shapes do not change.

### 3.7 People-only actions, and the test that proves an agent can't take them
- `requirePerson()` in `lib/auth.ts`: `requireSession` (refuses every token) plus a check that the request is not running as an agent. It returns a `PersonActor`.
- Every people-only and admins-only action's handler takes a `PersonActor`. The type cannot be built outside `personActor()`.
- The registry refuses a `people` or `admins` tool for any caller that is not a `PersonActor`, before calling the handler. Atomik's in-process calls carry `agent:<runId>`; MCP calls carry their token.
- A1.3 moves `/api/jobs/[id]/release` and `/api/atomik/steps/[id]/claim` onto `requirePerson`.
- **The proof (`tests/unit/tools-people-only.spec.ts`)**, generated over every tool whose `callers` is `people` or `admins`:
  1. Atomik in-process (`agent:<runId>`): refused, nothing written.
  2. MCP over HTTP (`lib/mcp.ts` `makeCaller` with a render token): 403.
  3. A render token on the route directly: 403.
  4. A member who is not an admin, on an admins-only tool: 403.
  5. A signed-in person: allowed.
  6. A static check: every route a people-only tool names imports `requirePerson`, and none imports `requireUser` or `requireRender`.
- Atomik's own tool list (S2) and MCP's tool list never contain people-only tools. Instead they can prepare one and return an approval link.

### 3.8 Tenant separation
- The registry is code; it holds no tenant data.
- Quotes, approvals and attempts live in the workspace's own database, keyed by `workspace_id`, and every query filters on it.
- Every id from a request (quote, approval, attempt, production, source media) is checked against this workspace before use. A quote id from workspace A, sent to workspace B, answers 404.
- MCP tokens are bound to their workspace, as today.
- Test: two workspace databases; cross-workspace quote, approval and attempt ids are all 404, and nothing in the other workspace is read or written.

### 3.9 Failure and refund paths
- **Quote expired at approval:** re-quoted. Same or lower price: the person's press approves it. Higher: shown again, never adopted silently.
- **Refused at claim** (balance, cap, run limit, allowance, approval rule): nothing sent, nothing billed. The attempt records the reason in plain words.
- **Provider failed, nothing billed:** "Nothing billed", with Retry. Retry re-runs under the same approval with a new attempt number, only after the old key is fenced.
- **Provider failed and billed:** the card says what it cost, from the provider's own outcome (billed, refunded, or not stated). Never a blanket "not billed".
- **Lost reply:** asked about by key; never resent.
- **Approximate tool over its quote:** charged at most its hold (3N for Cinema), with the overrun line from #540.
- **Stop:** queued attempts are skipped, unspent holds released (`fenceGenerationRequest`, held release). Work already sent finishes and settles.

### 3.10 Mocks
- `ENGINE_MOCK=1` uses each tool's `mock` through the same path, so a mocked run writes the same quote, approval, attempt and meter rows as a real one, at zero engine cost.
- `tests/unit/tools-registry.spec.ts`, generated per tool: it has a price function, a mock and (for engine tools) a key; a mocked agent harness runs it end to end (quote → a test person approves → claim → poll → collect) and the settled credits equal the quote (exact) or stay within the hold (approximate); an unapproved claim spends nothing; a missing key names that key.

---

## 4. PRs, in order (one concern each)

Every PR: typecheck, lint, full unit run, build; mocked engines only. Gate for every PR: an independent Opus review. Owner's yes where marked. UI PRs also need the owner's preview check and Playwright at 360×640, 390×844, 844×390, 1440×900 and 1920×1080.

| # | Branch | What | Tests | Owner's yes |
|---|---|---|---|---|
| A1.1 | `a1/1-engine-tools` | Types; engine tools generated from `MODELS`, `TASKS`, `STILL_TOOLS`, audio and development kinds; price functions wrap today's preparation; no caller yet | Completeness (every table entry has a tool; every tool a price function, mock, key); ids stable; retired models excluded | No (no behaviour change) |
| A1.2 | `a1/2-app-actions` | `*.tool.ts` beside today's handlers (canvas ops, release, Stop, Retry, skip, raise limit, review marks, limits, budget, Ask/Auto, top up, publish, consent); the index | Glob test; every handler exists; every people-only action from the SOW is declared `people` or `admins` | No (no behaviour change) |
| A1.3 | `a1/3-people-only` | `requirePerson`, `PersonActor`; release and step-claim routes move onto it | `tools-people-only.spec.ts` (§ 3.7); the existing `heldRelease`, `atomikKeySteps` specs | **Yes: money and sign-in** |
| A1.4 | `a1/4-tool-store` | The three tables (§ 3.5), created on first use; store functions; no caller | Schema exact; created twice is a no-op; a read creates nothing; existing tables' DDL unchanged; two-workspace isolation | **Yes: migration** |
| A1.5 | `a1/5-paid-path` | Quote, approve, claim, poll, collect for video and still tools; the `/api/tools` routes | Mocked end to end per tool; unapproved spends nothing; unpriced cannot run; expired quote; lost reply; refusal reasons; Retry under the same approval; tenant test | **Yes: money** |
| A1.6 | `a1/6-other-admissions` | Audio, development kinds (incl. verify), identity training, dubbing, Topaz and upscale tools onto the same path; Cinema after #540 | The same suite per tool; Cinema's hold and overrun line | **Yes: money** |
| A1.7 | `a1/7-buttons-and-make` | `/api/generate` and Make's engine line read price and availability from the registry; each press writes approval and attempt rows | Parity test (button = Make = registry quote); `paidEntryPoints`, `submitVideo` specs; Playwright at five sizes; the five-minute test | **Yes: money**, and the owner's preview check |
| A1.8 | `a1/8-tools-view` | Tools & connections and Atomik's per-suite tool lists read the registry; unavailable tools show their reason | `toolsConnections` spec; Playwright at five sizes | Owner's preview check |
| A1.9 | `a1/9-atomik-on-registry` | Atomik's board runs (`PaidDeps` defaults) and thread steps go through the registry's paid path; skills' engine choices read it | `rigAgent`, `atomikSkills` specs; parity test for Atomik; Atomik cannot call a people-only tool | **Yes: money** |
| A1.10 | `a1/10-mcp` | MCP's tool list comes from the registry; a paid MCP call returns a quote and an approval link, and `wait_for_render` waits for the approval and the render | `toolsConnections`, MCP route specs; a render token cannot spend without a person; parity test for MCP | **Yes: money and tokens** |
| A1.11 | `a1/11-approvals-queue` | The control room's Approvals lists open tool quotes (approve through `/api/tools/quotes/[id]/approve`, batch one at a time as Release 1 does) | Queue specs; Playwright at five sizes, phone approval included | **Yes: money**, and the owner's preview check |

---

## 5. Dependencies

- **P4b.1 to P4b.3** first: text and development tools price from the pinned list and run on the router.
- **Release 1** (merged Thu 8 Oct): the Make panel, the control room's Approvals (`lib/control-room/*`), Tools & connections.
- **#540** (Cinema hold): Cinema's tool is `upTo` with a 3N hold only after it merges.
- **S1:** A1.2 declares today's canvas ops; S1's new ops add their own `*.tool.ts` when S1.3 lands (whichever lands second adds the line).
- **S2** uses A1.5 and A1.9 for every paid step, and A1.10 for board tools over MCP.
- **U1** uses the approval and balance checks for plan approval and "Nothing billed" with Retry.
- **A2 and A4** (skills, skills over MCP) build on A1.10.

---

## 6. Risks

1. **Double charging while paths move.** Mitigation: the registry wraps the same admission and the same request keys; each consumer moves in its own PR with golden tests of the ledger rows before and after.
2. **MCP behaviour change.** Tokens that spend today will need a person. Mitigation: owner decision 2, a notice in Tools & connections, and the approval link in the reply.
3. **One more write per press.** Mitigation: one small row per paid press in the workspace's own database; measured in A1.7.
4. **Tool count.** Models × tasks, still tools, audio and development kinds make dozens of tools. Mitigation: the list is cheap (no prices), and quotes are fetched only when a control is visible or chosen (U1).
5. **Declarations drifting from handlers.** Mitigation: the glob and handler-exists tests.
6. **Approximate prices.** An approximate tool holds more than it quotes. Mitigation: plan totals (S2) use the hold, and the balance check uses it too.

---

## 7. Open owner decisions

1. **Record an approval row for every paid button press.** (A) Yes, so every charge in the ledger names who approved it at which quote. (B) Only for Atomik, MCP, plan and Auto approvals. Recommended: A.
2. **MCP render tokens.** (A) From A1.10, every paid MCP call returns a quote and an approval link; no token spends on its own. (B) Tokens made before A1.10 keep spending up to their ceiling until 31 Oct. Recommended: A (SOW § 0).
3. **Quote lifetime.** (A) 10 minutes, like pipelines, so an approval link is usable. (B) 5 minutes, like the run engine. Recommended: A, with a re-quote on approval if expired.
4. **Who may approve a quote another person or Atomik prepared.** (A) Any member within the workspace's approval rule; an admin above its cap. (B) Only the person who asked. Recommended: A.
5. **Take verdicts (approve or reject a take, no money).** Should they be people-only too? S1 makes board verdicts people-only. Recommended: yes.
6. **The missing-key message for members.** (A) Admins see the key's name; members see "not connected". (B) Everyone sees the key's name. Recommended: A.
7. **Token monthly ceilings.** Keep them as an extra limit on what a token may quote and a person approve. Recommended: keep.

---

## 8. Estimate

| PR | Agent-days |
|---|---|
| A1.1 engine tools | 1.5 |
| A1.2 app actions | 1 |
| A1.3 people-only | 1 |
| A1.4 tool store | 0.5 |
| A1.5 paid path | 2 |
| A1.6 other admissions | 1.5 |
| A1.7 buttons and Make | 1.5 |
| A1.8 Tools view | 0.5 |
| A1.9 Atomik on the registry | 1.5 |
| A1.10 MCP | 1 |
| A1.11 Approvals queue | 1 |
| **Total** | **13 agent-days**, plus review rounds |
