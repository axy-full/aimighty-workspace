# Plan: P4b, models on their own APIs (Phase 2)

Status: plan only, 6 October 2026. Build starts Fri 9 Oct. Nothing merges before the demo.
Scope source: `docs/particl-sow.md` (v2, 6 Oct) § 3.1 and § 8; handover `docs/handover-2026-10-05.md` § B5 and Part D "P4b"; `CLAUDE.md` rules 1, 2, 10, 14, 16 and § Pricing.

This plan names no key values, vendor costs or internal pricing figures. Customer prices come only from `CLAUDE.md` § Pricing.

---

## 1. Goal and done-when

**Goal (SOW § 3.1):** every model runs on its own provider's API and key. Vercel AI Gateway is removed. Particl keeps a pinned, tested price list for the text models it offers.

**Done when**
1. No request leaves Particl for Vercel AI Gateway. A test fails if `ai-gateway.vercel.sh`, `@ai-sdk/gateway`, `AI_GATEWAY_API_KEY` or `AI_GATEWAY_BASE_URL` appear in shipped code.
2. Text models route by their id prefix, each on its own key: `anthropic/`, `openai/`, `google/`, `xai/`. There is no fallback. A missing key fails with a message that names that key.
3. Nano Banana stills run only on Google's API with `GEMINI_API_KEY`.
4. The model list and text prices come from a pinned list checked into the repo, not from the gateway's `/models`. A test fails if any offered or featured text model has no price.
5. A text call's cost is the provider's reported tokens times the pinned price. Credits still come only through the existing price path (`billCredits` in `lib/creditTerms.ts`).
6. Spend control no longer depends on gateway keys. The workspace's existing allowance and credits are checked before each call.
7. On a preview with no gateway key, with the owner's yes in the internal workspace: an Atomik chat on Claude, the prompt writer, a Nano Banana still and a Grok crew run all succeed. Each shows on its own provider's usage page and none on the gateway's.

---

## 2. What exists today (reused, not rebuilt)

| Area | Files | What it does now | P4b |
|---|---|---|---|
| Text routing | `lib/language-provider.ts` | OpenAI goes direct (`lib/openai-direct.ts`); everything else goes through `createGateway` | Becomes the router by prefix |
| Direct OpenAI | `lib/openai-direct.ts` | `textVendor`, `directOpenAIKey`, `sdkTextUsage`, `store: false` | Kept as is; the pattern for the other three |
| Gateway door | `lib/gateway.ts` | `gatewayReachable`, `gatewayAuth` (key or OIDC), `gatewayPost`, `gatewayChat`, `gatewayCredits` | Deleted in the last PR |
| Thinking engine | `lib/engines/vercel.ts`, `lib/engines/index.ts` | The "vercel" adapter is the one text engine | Replaced by a text adapter on the router |
| Prompt writer | `lib/enhance.ts`, `lib/refineGate.ts` | Refine providers `anthropic`, `gateway`, `byteplus`; `GATEWAY_PROMPT_MODELS` | `gateway` becomes the router; `PROMPT_MODELS` |
| Reasoning options | `lib/atomik-reasoning.ts` | Gateway-shaped `providerOptions` (`gateway: { only: [...] }`) | Each provider's native options |
| Atomik start-up | `lib/atomik.ts` (the "needs the model gateway" check), `lib/workbench/development-server.ts` | Ask for the gateway or OpenAI | Ask for at least one direct text key |
| Model list and prices | `lib/catalog.ts` (`catalog()`, `textQuoteCostUsd`) | Reads the gateway's `/models`, cached for an hour | Reads the pinned list |
| Planner billing | `lib/workbench/rig-agent-planner.ts` (`plannerCeilingUsd`, `plannerCostUsd`), `lib/paidText.ts` | Prices thinking from the catalogue | Unchanged logic, new price source |
| Model policy | `lib/atomikModelPolicy.ts` (`VERIFIED_TEXT_MODEL_IDS`, `ATOMIK_MODEL_IDS`, `ATOMIK_AUTO_MODEL_IDS`) | The models people may pick | The price test runs over these |
| Stills | `lib/gemini.ts` (`stillsDoor`), `lib/vendorImages.ts`, `lib/providers.ts` | Google direct, with the gateway as a door and a fallback | Google only |
| Keys | `lib/vendorKeys.ts` (`VendorKeyName` includes `gateway`), `lib/providers.ts` (`GATEWAY_FALLBACK`, `providerVia`) | The gateway is a vendor key and a fallback for Google | `gateway` removed; `anthropic` added |
| Key minting | `lib/vercelKeys.ts`, `lib/purge.ts` (`revokeGatewayKey`, `gateway_key_id`) | A gateway key per new workspace; revoked on purge | Minting and revoking removed; the column stays, unwritten |
| Spend | `lib/allowance.ts`, `lib/credits.ts`, `lib/platformSpend.ts`, `lib/meter.ts` | Allowance and credits; platform spend maps `gateway` to two vendors | Particl's own records only |
| Usage | `app/(app)/usage/page.tsx`, `app/api/usage/route.ts`, `app/(app)/admin/page.tsx` | Show gateway balance and usage | Show Particl's own records; old rows keep their label |
| Health | `app/api/health/route.ts`, `lib/deploymentReadiness.ts` | Report the gateway | Report the direct keys |
| Media engines | `lib/models.ts`, `lib/vendorRates.ts`, `lib/engines/{byteplus,fal,google,higgsfield,openai,xai,elevenlabs}.ts` | Already on their own APIs and keys, with pinned rates | Unchanged; covered by the price-list test |

**Size of the change.** 59 files under `lib/`, `app/` and `components/` mention the gateway, most in comments. About 60 test files mention it too.

**Packages.** `ai` 7, `@ai-sdk/openai`, `@ai-sdk/xai` and `@anthropic-ai/sdk` are installed. `@ai-sdk/anthropic` and `@ai-sdk/google` are not. `@ai-sdk/gateway` and `@vercel/oidc` go.

---

## 3. Design

### 3.1 The text router (`lib/language-provider.ts`)
- The app keeps its `vendor/model` ids. The prefix picks the provider:
  - `anthropic/` → `@ai-sdk/anthropic` on `ANTHROPIC_API_KEY`;
  - `openai/` → the existing direct path (`lib/openai-direct.ts`) on `OPENAI_API_KEY`;
  - `google/` → `@ai-sdk/google` on `GEMINI_API_KEY`;
  - `xai/` and `spacexai/` → `@ai-sdk/xai` on `XAI_API_KEY`.
- The provider's own model id is the part after the prefix, mapped where the provider spells it differently. The map sits in the pinned list (§ 3.3), so one file says what each id means.
- **No fallback.** If the key for a prefix is missing, the call fails before it is sent: "Claude isn't connected. Set ANTHROPIC_API_KEY." No silent switch to another provider or model.
- `languageAuth` and `languageReachable` keep their names and callers. `languageReachable()` becomes "at least one direct text key is set".
- Reasoning settings in `lib/atomik-reasoning.ts` move to each provider's native options (Anthropic thinking budget, OpenAI reasoning effort, Google thinking config, xAI reasoning effort). The `gateway: { only: [...] }` routing hints go.
- `store: false` stays on OpenAI. Each provider's equivalent of "do not keep this request" is set where it has one.

### 3.2 The thinking engine and the prompt writer
- `lib/engines/vercel.ts` is replaced by `lib/engines/text.ts`: the same `EngineAdapter` shape (`run`, `chat`, `enhance`, `estimateText`) on the router. `ENGINES` in `lib/engines/index.ts` loses `vercel` and gains `text`. `ProviderId` loses `vercel`.
- In `lib/enhance.ts`, the `gateway` refine provider becomes `router`. `GATEWAY_PROMPT_MODELS` becomes `PROMPT_MODELS`, with the same default. The `anthropic` provider (today's `@anthropic-ai/sdk` path) folds into the router so there is one Claude path.
- `lib/atomik.ts` (the start-up check) and `lib/workbench/development-server.ts` ask for at least one direct text key. The `ai-gateway-auth-method` header goes.

### 3.3 The pinned price list (`lib/textPrices.ts`, new)
- One row per text model Particl offers: the app id, the provider's id, the provider, the key it needs, per-token prices (input, output, cached input where the provider has one), context window, reasoning options, the source page and the date it was checked.
- Seeded from LiteLLM's MIT price map (`model_prices_and_context_window.json`). Every row is then checked by hand against the provider's own pricing page, and the check date is written on the row.
- `lib/catalog.ts` reads this list instead of the gateway's `/models`. `CatalogModel` keeps its shape, so `rig-agent-planner.ts`, `paidText.ts`, `enhance.ts` and `refineGate.ts` keep working unchanged. The hour cache and the network read go.
- **The cost of a call** is the provider's reported tokens (from the SDK's usage) times that row's prices. This is what `plannerCostUsd` and `textQuoteCostUsd` already do; only the source changes. Credits still come only through `billCredits`.
- **Tests:**
  - every id in `VERIFIED_TEXT_MODEL_IDS`, `ATOMIK_MODEL_IDS` and `ATOMIK_AUTO_MODEL_IDS` has a row with every price set;
  - every row names a key from `lib/vendorKeys.ts` and a provider the router knows;
  - every row's check date is within 90 days, so a stale list turns CI red and someone re-checks it;
  - every offered media model in `lib/models.ts` still has a rate in `lib/vendorRates.ts` (the media half of "a pinned and tested price list");
  - a golden test: the credits quoted for Atomik's planning turn and the prompt writer, for fixed token counts, match a stored snapshot. Any change to the snapshot needs the owner's yes (money).
- **Where the figures live** is owner decision 1 (§ 7). The figures are not repeated in this plan.

### 3.4 Stills
- `stillsDoor()` answers `google` or `null`. The gateway door and the "fall back to the gateway" branch in `lib/gemini.ts` go.
- `lib/vendorImages.ts` and `lib/providers.ts` drop `GATEWAY_FALLBACK` for Google. A still model is runnable only when `GEMINI_API_KEY` is set.
- Ledger rows for new stills bill to `google`. Old rows billed to the gateway keep their label.
- OpenAI and xAI images keep their direct paths.

### 3.5 Spend control
- Today every new workspace gets its own gateway key with a budget set in Vercel (`lib/vercelKeys.ts`). That second wall goes with the gateway.
- What stays and is enough: the workspace's credits (`lib/credits.ts`), the monthly allowance on platform keys (`lib/allowance.ts`), project caps (`lib/caps.ts`), token ceilings, and the run limits for Atomik (`lib/runLimit.ts`). All are checked before each call, as they are for media today.
- `lib/purge.ts` stops revoking gateway keys. The `gateway_key_id` column stays and is no longer written. Past values stay (nothing is erased).
- `lib/platformSpend.ts` maps each vendor key to one vendor. The usage page, `/api/usage` and the admin page read Particl's own meter. Rows the gateway billed keep the label they were written with.
- A test proves a text call is refused before it is sent when the workspace has no credits, or its allowance is spent.

### 3.6 Removal
- Delete `lib/gateway.ts`, `lib/vercelKeys.ts`, `@ai-sdk/gateway`, the OIDC path (`@vercel/oidc` use for the gateway), the `gateway` vendor key, and the `AI_GATEWAY_API_KEY` and `AI_GATEWAY_BASE_URL` settings.
- `/api/health` and `lib/deploymentReadiness.ts` report the four direct text keys and `GEMINI_API_KEY`, as set or not set (never their values).
- Comments that name the gateway are updated in the same PR.
- A guard test fails on any gateway host, package or env name in `lib/`, `app/` and `components/`.

### 3.7 Money flow (quote → approval → durable claim → poll → collect)
P4b changes the price source for thinking, not the flow.
- **Quote:** Atomik's planning turn and the prompt writer are quoted from the pinned list, at their ceiling, as today.
- **Approval:** unchanged. The person approves the run's limit when asking (`askRigAgent`), and the prompt writer's charge is part of the job a person presses.
- **Durable claim:** unchanged (`reserveGenerationSpend` with the run id; `generation_requests` for paid stills).
- **Poll:** text calls are synchronous; stills are synchronous on Google.
- **Collect:** settled at the reported tokens times the pinned price; refunded in full when nothing came back, as `rig-agent.ts` does today.

### 3.8 People-only actions
P4b adds no action. It must not widen one. Test: the start-up check, the router and the health route never expose a key value, and no new route accepts a token for anything that spends.

### 3.9 Tenant separation
- Workspaces on platform keys share the platform's provider keys, as they do for media today. Their spend is separated by Particl's own meter, which carries `workspace_id` on every row (rule 2).
- A workspace's own keys (the keyring) are read only for that workspace, through `vendorKey()` as today. A test runs two workspaces, one with its own Anthropic key, and proves each call uses the right key and is metered to the right workspace.
- Workspaces that stored a gateway key in their keyring: owner decision 3.

### 3.10 Failure and refund paths
- **Missing key:** refused before sending, nothing billed, the message names the key.
- **Provider error (4xx/5xx, rate limit):** the error is explained per provider (`lib/providerOutcome.ts` gets Anthropic, Google and xAI text cases). Nothing billed when the provider billed nothing; the reservation is released.
- **Partial reply with usage:** billed at the reported tokens, never above the reserved ceiling.
- **Reply with no usage:** billed at the ceiling only if the provider states it billed; otherwise nothing billed and the run says so. This matches the owner's rule: show what the provider did.
- **Rollback:** each PR reverts on its own. The gateway env vars stay in Vercel until the last PR has been live for a week, so a revert works without the owner touching settings.

---

## 4. PRs, in order (one concern each)

Every PR: typecheck, lint, full unit run, build. Mocked engines only (`ENGINE_MOCK=1`). Gate for every PR: an independent Opus review. Owner's yes where marked.

| # | Branch | What | Tests | Owner's yes |
|---|---|---|---|---|
| P4b.1 | `p4b/1-price-list` | `lib/textPrices.ts` and `lib/catalog.ts` reading it; `/models` read removed; no routing change | Price-list tests (§ 3.3); planner and prompt-writer golden credits; catalogue shape unchanged | **Yes: money** (thinking prices change source) |
| P4b.2 | `p4b/2-router` | The router by prefix; `@ai-sdk/anthropic` and `@ai-sdk/google` added; native reasoning options; `anthropic` vendor key | Mocked SDK per provider: right package, right key, no fallback, missing-key message; reasoning options per provider; two-workspace key test | **Yes: env vars and secrets** (the owner sets `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` in Vercel before merge) |
| P4b.3 | `p4b/3-text-engine` | `lib/engines/text.ts` replaces `vercel.ts`; `enhance.ts` on the router; `PROMPT_MODELS`; start-up checks | Engine adapter contract tests; prompt writer and Atomik planning on mocks; existing `rigAgent`, `atomikSkills`, `refinementSpend` specs | **Yes: money** (the prompt writer's charge path) |
| P4b.4 | `p4b/4-stills-google` | Nano Banana on Google only; gateway door and fallback removed | `geminiDoors`, `vendorImages` specs updated; a still with no `GEMINI_API_KEY` is unavailable with the key named; ledger bills to `google` | **Yes: money** (where stills bill) |
| P4b.5 | `p4b/5-spend-control` | Stop minting and revoking gateway keys; `gateway_key_id` unwritten; usage and admin pages on Particl's records | Refusal before send on no credits or spent allowance; `usageLedger`, `usagePrivacy`, `noVendorCostToCustomers` specs; old gateway rows keep their label | **Yes: money and workspace provisioning** |
| P4b.6 | `p4b/6-remove-gateway` | Delete `lib/gateway.ts`, `lib/vercelKeys.ts`, the package, the OIDC path, the `gateway` key and settings; health reports direct keys; comments | Guard test (no gateway host, package or env name); health shape; full suite | **Yes: env vars** (the owner removes the two gateway settings from Vercel a week after merge) |
| P4b.7 | `p4b/7-qualification` (docs only) | The verification runbook and its result: four paid calls in the internal workspace on a preview with no gateway key | The four checks in § 1 item 7 | **Yes: paid runs** (cost stated first, per call) |

**UI.** P4b changes no screen layout. The usage and admin pages change only their data source. P4b.5 runs the existing usage and admin browser specs at the five sizes (360×640, 390×844, 844×390, 1440×900, 1920×1080) to prove nothing visible moved.

---

## 5. Dependencies

- **Release 1:** none in code. P4b starts after the Thu 8 Oct merge so it rebases onto the released `main`.
- **A1** waits for P4b.1 to P4b.3: engine tools for text need the pinned prices and the router.
- **S2** needs P4b.2 and P4b.3: the graph's model calls go through the router, and its traces read the pinned prices.
- **C2** (search by meaning) needs P4b.2 for direct embedding keys.
- **P5 (cutover)** is easier after P4b: no OIDC identity to carry to the VPS.

---

## 6. Risks

1. **A second spend wall goes.** Gateway keys carried a budget in Vercel's books. After P4b, Particl's own checks are the only wall. Mitigation: P4b.5's refusal tests, and the guard that every text call reserves before it sends.
2. **Price drift.** Providers change prices. Mitigation: the 90-day check date turns CI red; the golden credits test shows any change to what a customer pays.
3. **Model id drift.** A provider renames a model. Mitigation: ids are mapped in one file; a mocked test per offered model; the qualification run catches the rest.
4. **Key rate limits.** One platform key per provider now carries all workspaces' text traffic. Mitigation: existing 429 handling with backoff; owner decision 4 on asking providers for higher tiers.
5. **Reasoning options.** Each provider spells them differently; a wrong option can fail a call. Mitigation: per-provider tests and the qualification run.
6. **Wide diff.** 59 app files and about 60 test files. Mitigation: six PRs, each small enough to review; comment changes ride with the code they describe.

---

## 7. Open owner decisions

1. **Where the pinned per-token prices live.** (A) In `lib/textPrices.ts`, like `lib/vendorRates.ts` today: provider list prices are public on their pages, and no contract or discount figure goes in. (B) In a private store the owner fills in, with only a completeness test in the repo. Recommended: A, unless the repository is made private first (SOW § 9 open item).
2. **The default Atomik model when its key is missing.** (A) Auto picks the first featured model whose key is set. (B) Atomik is unavailable until the default model's key is set. Recommended: A, with the model line showing which one it picked.
3. **Workspaces that stored their own gateway key.** (A) The key stays stored and unused; the workspace is told to add direct keys. (B) The workspace falls back to platform keys with its allowance. Recommended: A, with a notice in Settings › Connections.
4. **Provider rate tiers.** Whether to ask Anthropic, Google and xAI for higher limits before P5's load test. Recommended: yes, before P4b.6 merges.
5. **Keeping the gateway settings in Vercel for a week after P4b.6.** Recommended: yes, so a revert needs no settings change.

---

## 8. Estimate

| PR | Agent-days |
|---|---|
| P4b.1 price list | 1.5 |
| P4b.2 router | 1.5 |
| P4b.3 text engine | 1 |
| P4b.4 stills | 0.5 |
| P4b.5 spend control | 1 |
| P4b.6 removal | 1 |
| P4b.7 qualification | 0.5 |
| **Total** | **7 agent-days**, plus review rounds |
