# Plan: Vercel out (dead weight, Atomik's tool loop, Blob → R2, a guard)

Status: plan only, 14 October 2026. No product code in this PR.
Every code claim cites `file:line` on `origin/release/1` at `05e93d09`.
Server-side only. No board UI changes (design freeze). No paid calls anywhere in this plan: every PR runs on mocked engines and scripted models.

Production facts this plan relies on (from the brief, not read from the server):
- Production self-hosts on its own server. `AI_GATEWAY_API_KEY`, `VERCEL` and `VERCEL_OIDC_TOKEN` are unset there. If any is set, `/api/health` fails (`app/api/health/route.ts:122-123`), using `lib/vercelGuard.ts:17-38`.
- Storage is `STORAGE_BACKEND=r2` with `BLOB_READ_WRITE_TOKEN` still set. New objects go to R2. Old ones are read from Blob through the fallback (`lib/storage/backend.ts:66-85`).
- The owner closes the Vercel account before 27 October 2026, and closing it deletes the Blob store (`docs/selfhost-test.md:705`). That date drives the order below.

---

## Summary

1. **Most of the "dead weight" is not dead.** `lib/gateway.ts` carries the live OpenAI text path and the mock. `lib/engines/vercel.ts` is the live text adapter. Both must be split before they can be deleted. Only `vercel.json`, `public/vercel.svg` and `mintGatewayKey` have no live use.
2. **`ai` itself depends on `@ai-sdk/gateway`, which depends on `@vercel/oidc`** (`package-lock.json`, `node_modules/ai` and `node_modules/@ai-sdk/gateway` entries). Removing them from `package.json` does not remove them from the install while `ai` stays.
3. **One live Vercel call may still happen in production:** the model catalogue reads Vercel's public model list unless `MODEL_CATALOG=static` (`lib/catalog.ts:117-140`, `lib/catalog.ts:241-249`). It needs no account, but it is Vercel, and it sets text prices. The owner checks the setting.
4. **(b) Recommendation: our own small tool loop (Option 1).** It is about 150 lines, adds no package, and every existing planner test already drives it unchanged. Folding into #553 means new LangChain packages, a checkpointer and two migrations, and still needs a model loop inside a node.
5. **(c) The copy tool exists and is sound.** It needs one small ops PR: a counts-only census, and coverage for consent recordings and upload derivatives, which `--verify` does not check today.
6. **A guard lands first,** as a ratchet at today's counts. Each PR lowers it. Nothing new can come in during the work.

---

## 1. (a) Dead weight inventory

"Reachable in production" assumes the three settings above are unset and `PARTICL_DEPLOYMENT=production`.

### 1.1 The named packages and files

| Item | Importers (file:line) | Runtime or type | Reachable in production? | What replaces it |
|---|---|---|---|---|
| `@ai-sdk/gateway` (`package.json:20`) | `lib/language-provider.ts:2` (used `:69`); `lib/vendorImages.ts:4` (used `:66`). Also a hard dependency of `ai` (lockfile). | Runtime | No. Both uses sit behind the gateway door, closed in production (`lib/gateway.ts:20-26`, `lib/vendorKeys.ts:27`). | Nothing. The direct doors already exist (`lib/language-provider.ts:56-65`). |
| `@vercel/oidc` (`package.json:34`) | `lib/gateway.ts:42` (dynamic import). Also a dependency of `@ai-sdk/gateway`, `@vercel/blob` and `@vercel/sandbox` (lockfile). | Runtime | No. `gatewayAuth` throws before it in production (`lib/gateway.ts:37-39`). | Nothing. |
| `@vercel/sandbox` (`package.json:35`) | `lib/astra-blender/sandbox.ts:2` (used `:67-73`); `scripts/astra-blender-snapshot.mjs:4`; test `tests/unit/astraBlenderSandbox.spec.ts:5`. | Runtime | **Depends on a setting.** `ASTRA_RENDER_BACKEND` unset means `vercel` (`lib/astra-blender/backend.ts:32-37`). Status and cancel of an old job also pick Vercel by its recorded engine (`lib/astra-blender/backend.ts:26-29`, `lib/astra-blender/render-jobs.ts:96`). | The self-hosted render workers, already built (`lib/astra-blender/selfhost-sdk.ts`, `ops/render-worker/`). |
| `vercel.json` | Read by Vercel only. Holds the region and the cron `/api/cron/sync` every 10 minutes. | Config | No. | The scheduled task that runs `ops/selfhost/cron-sync.mjs` (calls the same route with `CRON_SECRET`). |
| `lib/gateway.ts` | `lib/textRoute.ts:4`, `lib/providers.ts:260`, `lib/gemini.ts:5`, `lib/vendorImages.ts:8`, `lib/catalog.ts:2`, `lib/enhance.ts:28-31` and `:51-56`, `lib/language-provider.ts:7`, `lib/engines/vercel.ts:2`, `lib/textDirect.ts:3`, `lib/workbench/atomik-server.ts:20`; type-only: `lib/openai-direct.ts:5`, `lib/workbench/suite-agent.ts:7`, `lib/astra-blender/agent.ts:10`. | Runtime | **Partly live.** See 1.2. | Split first (PR A3), then delete (A5). |
| `lib/engines/vercel.ts` | `lib/engines/index.ts:7`, `:14`. Called as `engineFor("vercel").run` by `lib/paidText.ts:282` and `lib/workbench/atomik-server.ts:254`. | Runtime | **Live.** Its `run` is the text transport (`lib/engines/vercel.ts:14` → `textPost`). | The callers call `textPost` (`lib/textDirect.ts:30`) directly. `chat` (`:15`) has no caller and goes. |
| `lib/vercelKeys.ts` | `lib/purge.ts:13` (`revokeGatewayKey`, used `:264` and `:454`). `mintGatewayKey` (`lib/vercelKeys.ts:37`) has no caller. | Runtime | **Yes, in the cron.** `retireDeletedWorkspaces` runs from `app/api/cron/sync/route.ts:198`. For any deleted workspace with a `gateway_key_id`, it calls Vercel's API (`lib/vercelKeys.ts:66-81`) and fails when `VERCEL_TOKEN` is unset. | Nothing to revoke once the gateway is gone. The column stays (data). The owner counts such rows first (owner step O3). |
| `public/vercel.svg` | None (searched `.ts`, `.tsx`, `.css`, `.mjs`, `.json`). | Asset | No. | Delete. |

### 1.2 What in `lib/gateway.ts` is live

- `gatewayPost` (`lib/gateway.ts:107-127`): the mock reply (`:111`) and **OpenAI's direct text** (`:115`, to `openaiDirectPost`). `textPost` sends every mock and OpenAI call here (`lib/textDirect.ts:31`, `:35`). Live.
- `explainGatewayFailure` (`lib/gateway.ts:54-73`): its first branch explains a direct provider's error (`:55-58`). Used by `lib/workbench/atomik-server.ts:501`, `lib/enhance.ts:475`, `lib/gemini.ts:273`. Live.
- `GatewayReply` (`lib/gateway.ts:101`): the reply type the text paths share. Type only.
- `GATEWAY_BASE` (`lib/gateway.ts:16-17`): the catalogue's live read uses it, with no key, whenever an OpenAI key is set (`lib/catalog.ts:119-124`). **Live unless `MODEL_CATALOG=static`.**
- `gatewayReachable`, `gatewayAuth`, `gatewayCredits`, `gatewayChat`, `chatBody`, `GATEWAY_URL`: false, throwing, null or uncalled in production (`lib/gateway.ts:20-26`, `:33-51`, `:80-99`, `:158-167`).

### 1.3 `ai` and `@ai-sdk/*`

None of the declared `@ai-sdk/*` packages is unused. All are runtime:

| Package | Runtime use |
|---|---|
| `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/xai` | Direct text doors (`lib/language-provider.ts:41-43`). `@ai-sdk/xai` also Grok stills (`lib/vendorImages.ts:97`). |
| `@ai-sdk/openai` | OpenAI text (`lib/language-provider.ts:61-62`) and GPT Image (`lib/vendorImages.ts:88`). |
| `@ai-sdk/provider` | **Not declared** in `package.json`, but imported: types in `lib/workbench/rig-agent-planner.ts:3`, `lib/workbench/suite-agent.ts:4`, `lib/workbench/atomik-server.ts:11`, `lib/workbench/development-server.ts:6`, `lib/astra-blender/agent.ts:4`, `lib/textDirect.ts:2`; `APICallError` at runtime in tests (`tests/unit/suiteAgentSdk.spec.ts:3`). It resolves only by hoisting. Declare it (PR B1). |

`ai` is runtime in nine files, not type-only:

| File | What it uses |
|---|---|
| `lib/workbench/rig-agent-planner.ts:1` | `ToolLoopAgent`, `Output`, `isStepCount`, `tool` |
| `lib/workbench/suite-agent.ts:3` | the same |
| `lib/astra-blender/agent.ts:3` | the same |
| `lib/workbench/development-server.ts:5` | `ToolLoopAgent`, `stepCountIs` (one step, no tools, `:591-595`) |
| `lib/textDirect.ts:1` | `generateText`, `Output`, `APICallError` |
| `lib/vendorImages.ts:1` | `generateImage` |
| `lib/language-provider.ts:6` | `wrapLanguageModel` |
| `lib/providerFailure.ts:13` | `APICallError`, `NoImageGeneratedError` (`:59-67`) |
| `lib/textRoute.ts:1` | `APICallError` (`:203-204`) |

Type-only `ai` imports: `lib/openai-direct.ts:2` (`LanguageModelUsage`), plus the type names inside the runtime imports above. Removing them matters only if `ai` leaves (owner decision D2).

Tests on `ai/test`: `tests/unit/suiteAgentSdk.spec.ts:2`, `tests/unit/astraBlenderAgent.spec.ts:2`, `tests/unit/workbenchAtomik.spec.ts:15`. Tests on `ai`: `tests/unit/openaiDirect.spec.ts:2`, `tests/unit/textDirect.spec.ts:2`, `tests/unit/textDirectRequests.spec.ts:2`, `tests/unit/providerBillingOutcome.spec.ts:225`.

**The lockfile fact.** `node_modules/ai` depends on `@ai-sdk/gateway` 4.0.86, which depends on `@vercel/oidc` 3.2.0. So `@ai-sdk/gateway` and `@vercel/oidc` stay installed until `ai` goes. `inngest` lists `@vercel/node` only as an optional peer; it is not installed.

### 1.4 Other Vercel use found

**`VERCEL*` settings read in app code** (all false or empty in production, so every branch below is dead there):

| File:line | Reads | Effect off Vercel |
|---|---|---|
| `lib/deployment.ts:38`, `:50-51`, `:69`, `:80` | `VERCEL`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA` | Falls through to `PARTICL_DEPLOYMENT` and `GIT_COMMIT_SHA`. |
| `lib/site.ts:30`, `:60`, `:73` | `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL` | Falls through to `APP_ORIGIN`. |
| `lib/requestOrigin.ts:33` | `VERCEL` | Proxy origin used. |
| `lib/clientIp.ts:79-81` | `VERCEL` | Trusted-proxy rules used. Removing the branch is strictly safer: on Vercel it trusts the first `x-forwarded-for` hop. |
| `lib/dispatch.ts:93` | `VERCEL_PROJECT_PRODUCTION_URL` | `APP_ORIGIN` or `WORKER_ORIGIN` used. |
| `lib/recovery.ts:28`, `lib/workerProbe.ts:35` | `VERCEL_DEPLOYMENT_ID`, `VERCEL_URL` | Label `"local"`. |
| `lib/previewSeed.ts:85-87`, `:111` | `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL` | The preview seed refuses (no preview). Run on every build by `package.json:7` (`prebuild`). |
| `lib/platformOwnerScrub.ts:82` | `VERCEL_ENV` (through `onVercel`) | `PARTICL_DEPLOYMENT` used. |
| `app/api/platform/route.ts:27`, `app/api/health/route.ts:196` | `VERCEL_REGION` | `"local"`. |
| `lib/astra-blender/sandbox.ts:105`, `:118` | `VERCEL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Goes with the Sandbox (A6). |
| `lib/vercelKeys.ts:23-31` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Goes with A2. |
| `lib/gateway.ts:17`, `:25`, `:40` | `AI_GATEWAY_BASE_URL`, `VERCEL`, `VERCEL_OIDC_TOKEN` | Goes with A5. |
| `lib/vercelGuard.ts:17-31` | `VERCEL`, `VERCEL_OIDC_TOKEN`, `AI_GATEWAY_API_KEY`, `VERCEL_ENV` | **Keep.** This is the runtime guard that fails health if they appear. |
| Dev and ops scripts: `scripts/dev-session.mjs:9`, `scripts/account-http-rehearsal.mjs:22`, `scripts/ops/load-rehearsal.mjs:107` | `VERCEL` | Not in the app. Tidy in A7. |

**Hosts and headers:**
- `https://ai-gateway.vercel.sh/v1`: `lib/gateway.ts:17`, `lib/providers.ts:174`, `scripts/ops/snapshot-catalog.mjs:23` (refreshes the price snapshot from Vercel's public, no-key model list).
- `api.vercel.com`: `lib/vercelKeys.ts:20`.
- `.vercel-storage.com`: `lib/storage/backend.ts:96-97`, `lib/storage/blob.ts:25`, `scripts/ops/blob-to-r2.mjs:64`, `scripts/ops/backup-lib.mjs:697`. Old rows hold absolute Blob URLs, so the backend must keep recognising this host after Blob goes (to map them to R2 keys).
- `vercel-cron` user agent: `app/api/cron/sync/route.ts:60-62`, stored as `lastCronBy` (`:175`) and shown by health (`app/api/health/route.ts:228`). A label only.
  - **Owner's finding, 14 Oct, after deploy #3:** health showed the cron agent "vercel-cron/1.0".
  - **That is a stale settings value (`lastCronAgent`), not a live caller.**
    - No code has written `lastCronAgent` since 475fa895.
    - Health still reads it (`app/api/health/route.ts:229`).
    - Today's caller is our own scheduled task, `ops/selfhost/cron-sync.mjs`, which calls `http://127.0.0.1:3000/api/cron/sync` inside the container with `CRON_SECRET`. It sends Node's default user agent, so it is recorded as `by: "manual"`.
  - **The rename goes in its own PR now** (the owner asked for it with the health change, ahead of A1):
    - the scheduler sends `particl-scheduler/1` and is recorded as `scheduler`;
    - the `vercel` branch is dropped;
    - health stops returning the stale `agent`.
  - **One thing to rule out (owner, O1):** that the old Vercel project's own cron, from `vercel.json`, is not still running a deployment that points at the production databases. Check that the project has no live production deployment, or that its crons are off, before the account closes.
- `x-vercel-*` headers, `vercel.app` URLs, `waitUntil` from `@vercel/functions`, `@vercel/analytics`, `@vercel/speed-insights`: **none found.** Next's own `after()` is already used (`lib/workbench/rig-agent.ts`, `lib/held.ts`, others) and works under `next start` (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`, "Platform Support"). `maxDuration` (61 route files) is Next's own route config, read by platforms; keep it.
- OIDC: only `lib/gateway.ts:40-44` and the `'ai-gateway-auth-method': 'oidc'` headers (`lib/language-provider.ts:69`, `lib/vendorImages.ts:66`, `lib/workbench/development-server.ts:74`).
- Cron config: only `vercel.json`.
- `.github/workflows/`: no Vercel use. `.gitignore:37-38` lists `.vercel` (keep: it stops a stray link folder being committed).

**Copy a customer can read:** `app/(app)/privacy/page.tsx:29` and `:82` say older files are in Vercel Blob. True until the Blob cutover; change it then (owner decision D8).

**Data names that stay** (history, not dependencies): the text ledger engine `'vercel'` (`lib/openai-direct.ts:21-24`), the meter engine `'vercel-sandbox'` (`lib/astra-blender/backend.ts:16`), the refine provider value `'gateway'` that a stored setting can hold (`lib/enhance.ts:88-95`), the platform label `"vercel-blob-private"` (`app/api/platform/route.ts:26`, read by `app/(app)/platform/page.tsx:94`, `:205`), and the worker path `/vercel/sandbox` inside our own render worker's protocol (`ops/render-worker/server.mjs:27`). Statements and reconciliation read the first two from old rows. None calls Vercel. The guard ignores them by design (section 4).

**Docs that still describe Vercel as live:** `README.md:179-214` (hosting section). Operating docs with Vercel steps: `docs/astra-blender-runtime.md` (11 mentions), `docs/backup-restore.md` (10), `docs/credit-switchover.md` (11), `docs/long-flows.md` (8), `docs/r2-storage-plan.md` (8), `docs/native-dispatch.md` (6), `docs/atomik-models.md` (4), `docs/r2-migration.md`, `docs/scale-out-runbook.md`, `docs/enterprise-readiness.md` (2 each), and one each in `docs/openai-direct.md`, `docs/upload-and-media-lifecycle.md`, `docs/production-workbench.md`, `docs/subscribed-workspaces.md`, `docs/four-suite-apis.md`, `docs/higgsfield-soul-integration.md`. Dated history (`docs/handover-2026-10-05.md`, `docs/overnight-2026-10-05.md`, `docs/particl-sow*.md`) stays as written. #553's plan says Langfuse settings are set "in Vercel"; update it if #553 goes ahead.

### 1.5 PR breakdown for (a), in order

Every PR: `npx tsc --noEmit`, `npm run lint`, the named unit specs, the full unit run and `npm run build`, **in CI** (`verify.yml`), never on this server. Each is one revert to roll back.

| PR | What | Proves nothing changed | Tests that mention the removed code | Size |
|---|---|---|---|---|
| **A1** Config | Delete `vercel.json` and `public/vercel.svg`. (The cron user agent and label are renamed earlier, in the /api/health PR; see 1.4.) README hosting section rewritten. **Before:** owner step O2 (the cron heartbeat). | Build; cron route specs. | None. | S |
| **A2** Gateway keys | Delete `lib/vercelKeys.ts`. `retireDeletedWorkspaces` and `purgeWorkspace` stop calling Vercel (`lib/purge.ts:13`, `:264`, `:454-478`); `gateway_key_id` stays as data. **Before:** owner step O3 (count, then revoke in Vercel if any). | `tests/unit/adminDeletedWorkspace.spec.ts`, `tests/unit/neverDelete.spec.ts`. | `adminDeletedWorkspace.spec.ts` if it injects a revoke. | S |
| **A3** Split the live text helpers out of `lib/gateway.ts` (no behaviour change) | `GatewayReply` → `TextReply` in `lib/textDirect.ts`. The mock and OpenAI branches of `gatewayPost` move into `textPost`. `explainGatewayFailure`'s provider branch becomes `explainTextFailure`. `paidText.ts:282` and `atomik-server.ts:254` call `textPost`. `gatewayChat`, `chatBody` and the adapter's `chat` go (no callers). | `textDirect`, `openaiDirect`, `paidTextDirect`, `paidTextReconcile`, `workbenchAtomik`, `enhance*`, `engines` specs; byte-for-byte same request bodies and replies under mock. | `gatewayChat.spec.ts` (deleted: tests `chatBody` only); `openaiDirect.spec.ts:5`, `textDirect.spec.ts:3` (import path moves); `engines.spec.ts:24`, `:36`. | M |
| **A4** Catalogue: snapshot only | `catalog()` always reads `lib/modelCatalog.json`; the live read (`lib/catalog.ts:117-140`) and `MODEL_CATALOG` go. **Owner decision D3 first:** if production reads the live list today, prices move to the 8 October snapshot. | `catalogStatic`, `catalogTextPricing`, `catalogDirectGate`, `atomikModelPolicy`, `atomikRailPricing` specs. | `catalogStatic.spec.ts:246-263` (tests the `gateway` source value). | S |
| **A5** The gateway door out | Remove the gateway route and door: `lib/textRoute.ts:123-145` (no `gateway` route; an unrouted model is simply not offered, as in production now), `lib/providers.ts:157-176`, `:298-322`, `lib/gemini.ts:49-54`, `:168`, `lib/vendorImages.ts:62-75`, `:115`, `lib/enhance.ts` gateway parts, `lib/language-provider.ts:66-70`, `app/api/engines/route.ts:30`, `app/api/usage/route.ts:143`, `:223-254`. Delete `lib/gateway.ts` and `lib/engines/vercel.ts`. Drop `@ai-sdk/gateway` and `@vercel/oidc` from `package.json` (still installed through `ai`, see 1.3). Split in two if the diff passes 400 lines: A5a stills and images, A5b text, providers and the file. | Under mock and in production settings, every model menu, route and price is unchanged (snapshot test of `catalog()` and `textRouteWorks` before and after). | **Guard:** `vercelGuard.spec.ts:3`, `:42-58`. Others: `stillsDoor.spec.ts`, `geminiDoors.spec.ts`, `vendorImages.spec.ts:72-113`, `textDirect.spec.ts:58-71`, `paidTextDirect.spec.ts:175`, `:344-382`, `xaiVideo.spec.ts:45`, `textJobRoute.spec.ts:81`, `textDirectRequests.spec.ts:171`; module mocks of `@/lib/gateway` in `enhanceTimeout.spec.ts:60`, `enhanceStableKey.spec.ts:55`, **`moneyRoutes.spec.ts:147`**. | L |
| **A6** Sandbox out | Default backend becomes `selfhost`; `vercel` is no longer accepted (`lib/astra-blender/backend.ts:32-37`). Remove the Vercel SDK path (`lib/astra-blender/sandbox.ts:2`, `:53-73`, `:102-121`), `scripts/astra-blender-snapshot.mjs`, and `@vercel/sandbox`. The `vercel-sandbox` meter label stays for old rows. **Before:** owner steps O1 and O3 (backend setting, no unsettled jobs). | `astraSelfhostWorker`, `astraSelfhostRenderJobs`, `astraBlenderRenderJobs`, `astra` specs; `tests/ops/render-worker.test.mjs`. | `astraBlenderSandbox.spec.ts` (whole file); `astraSelfhostWorker.spec.ts:19`, `:32-41`; `astraSelfhostRenderJobs.spec.ts:22`. | M |
| **A7** `VERCEL*` branches out | Remove the Vercel branches listed in 1.4 (keep `lib/vercelGuard.ts`). Remove the preview seed and `prebuild` (previews are gone; staging replaces them, decision D9). Split: A7a origins and client IP (security review), A7b deployment label, commit, region and ids, A7c preview seed. | With `VERCEL*` unset, every function returns the same value (table tests over today's off-Vercel cases). | **Guards / security probes:** `clientIp.spec.ts`, `requestOrigin.spec.ts`, `publicLinkOrigin.spec.ts`, `heldMailLink.spec.ts`, `platformOwnerPrivacy.spec.ts:37-42`, `deploymentReadiness.spec.ts:24`, `:86`, `operationalHealth.spec.ts:108-113`. Others: `deployment.spec.ts`, `dispatchMode.spec.ts`, `appPagesAudit.spec.ts:58`, `workerProbe.spec.ts`, `previewSeed.spec.ts`, `tests/ops/preview-seed.test.mjs`, `tests/ops/preview-seed-scenario.cjs`. | M (×3) |
| **A8** Docs | README, and the operating docs in 1.4 say what runs now. History docs untouched. | Docs only. | None. | S |

**Tests that mention these files are moved or deleted only with the owner's word.** The list is in the column above. Bold names are guards or privacy and security probes. Each PR asks for that word in its description, file by file. No guard is weakened: where a guard pinned Vercel behaviour, its remaining cases stay and a case for the new behaviour is added.

---

## 2. (b) Atomik's ToolLoopAgent

### 2.1 What `ToolLoopAgent` does for us today

One planning turn (`lib/workbench/rig-agent-planner.ts:205-258`):
- **Tools:** six dry tools, all local, none spends or writes: `inspect_board`, `create_node`, `wire`, `tidy`, `render`, `lock` (`:220-235`). Inputs are zod schemas. Each call is counted; past 160 the tool answers a problem (`:29`, `:209-212`). `render` and `lock` only propose; a person acts (`:51`).
- **Steps:** at most 3 model calls (`stopWhen: isStepCount(3)`, `:26`, `:218`). The loop goes on while the model calls tools.
- **Last step:** no tools. `prepareStep` sets `toolChoice: 'none'`, and removes the tools except on Anthropic, where the provider wrapper keeps them and sends a no-tool header (`:236-240`, `lib/language-provider.ts:26-29`, `:45-51`). It throws `PlannerError` once the tool limit was hit (`:237`).
- **Structured output:** `Output.object(plannerResultSchema)` (`:219`). The `ai` package sends the JSON schema as `responseFormat` on every step (`node_modules/ai/dist/index.js:6167`), then parses the last step's text. We parse it again with zod (`:249-250`).
- **Tool execution:** in call order, through `Promise.all` (`node_modules/ai/dist/index.js:6631`). Our tools are synchronous, so the order is the call order.
- **Retries:** none (`maxRetries: 0`, `:217`). Timeout 120 s (`:30`, `:244`).
- **Streaming:** none. The planner calls `generate`, not `stream`. The mock refuses to stream (`:340`). No `streamText` anywhere in the repo.
- **Token accounting:** the planner keeps each step's `usage` (`:247`). `ai` maps the provider's usage to `LanguageModelUsage` with a 20-line function (`node_modules/ai/dist/index.js:2703-2722`), keeping the provider's raw counts in `raw`. The money path prices each step from those raw counts on a direct door (`lib/textDirect.ts:241-245`, `:208-231`; `lib/openai-direct.ts:62-73`), or from the totals otherwise (mock).
- **Providers and models:** Claude, OpenAI and Grok, from Atomik's policy, Auto by default (`:31-32`, `:265-277`; `lib/atomikModelPolicy.ts:117`). The model object comes from `languageModel()` (`lib/workbench/rig-agent.ts:976`): OpenAI on its key through `@ai-sdk/openai`; Anthropic, Google and xAI through their `@ai-sdk/*` packages when `TEXT_DIRECT` names them (`lib/language-provider.ts:56-65`, `lib/textRoute.ts:123-127`). Under `ENGINE_MOCK=1` a scripted `LanguageModelV4` stands in (`:324-342`).

### 2.2 The money path around it (unchanged by either option)

- Price before the turn: the ceiling is per-call bytes as tokens × 3 calls (`rig-agent-planner.ts:161-176`).
- Reserve inside the run's approved limit, before anything is sent (`lib/workbench/rig-agent.ts:867-875`). A turn that started and never finished is released, never resent (`:836-839`).
- Stopped between reserve and send: released at zero (`:877-881`).
- The turn fails: **not billed**. What it used, if the model said, is recorded as the platform's cost; otherwise the ceiling is (`:885-889`, `:924-935`).
- The turn succeeds: settled at what it used, never above the reservation; usage that cannot be priced is not billed (`:892-893`, `:926`).
- Approval of the plan is a person's, after the turn (rule 14). The planner has no approval tool.

### 2.3 Option 1: our own small tool loop

**What exists.** The provider SDKs already wired are the AI SDK provider packages: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/xai`, `@ai-sdk/google` (`package.json:19-23`), built by `lib/language-provider.ts`. Each returns a `LanguageModelV4` with `doGenerate`. `@anthropic-ai/sdk` is also installed, used only by the legacy refine path (`lib/enhance.ts:394-401`). There is no `openai` npm package; OpenAI's other direct call is plain `fetch` (`lib/openai-direct.ts`).

**The design.** A new `lib/llm/tool-loop.ts`, about 150 lines, that calls `model.doGenerate()` directly:
1. Build the V4 prompt: system, then the user message (text and file parts), as `ai` does today.
2. Per step: send the tools as JSON schema (`z.toJSONSchema`), the `responseFormat` schema, `maxOutputTokens`, `abortSignal`, `toolChoice` (`none` on the last step, tools removed except Anthropic, exactly `finalToolStep`).
3. Read tool calls from the reply. Parse each input with its zod schema. A bad input or unknown tool becomes an error result sent back, as `ai` does. Run tools in call order.
4. Append the assistant tool calls and the tool results; loop until no tool call or 3 steps.
5. Keep each step's usage, converted by a copy of `ai`'s 20-line function, `raw` passed through untouched.
6. Return the last text, every step's usage, the step count.

The planner keeps its tools, limits and errors; only `:213-245` changes. The provider packages and `wrapLanguageModel` stay in the path, so the Anthropic no-tool handling and error redaction are untouched.

**Why it is safe to test.** Every planner test already drives a `LanguageModelV4` by `doGenerate`: `mockPlannerModel` (`rig-agent-planner.ts:324-342`), and the prompt capture in `tests/unit/rigAgentAttachments.spec.ts:160-169`. Those tests run unchanged against the new loop. While `ai` is still installed, a **differential test** runs the old `ToolLoopAgent` and the new loop on the same scripted models and asserts the same `doGenerate` options per step, the same draft, result, step count and per-step usage, and the same `plannerCostUsd` for recorded usage fixtures of each vendor (Anthropic cache reads and writes, OpenAI cached and reasoning tokens, xAI cached tokens, Google thoughts). No network.

**Small improvement, same rule.** Today a provider error on step 2 loses step 1's usage, so the platform's recorded cost is the ceiling (`rig-agent.ts:887`). Our loop can attach the usage so far to the error. Still **not billed**; only the platform's own cost record gets more exact. Optional; called out in the PR for the money review.

### 2.4 Option 2: fold into #553 (LangGraph.js)

#553 is an open plan to `main` from 6 October (`docs/plans/s2-atomik-langgraph.md` on `plans/s2`). It adds `@langchain/langgraph` and `@langchain/langgraph-checkpoint` (its S2.1), a libSQL checkpointer and two tables (S2.2, owner's yes: migration), a graph host and new columns (S2.3, migration), then the production graph. Its own estimate is 18 agent-days over 13 PRs. LangGraph does not call models by itself: a node needs either LangChain chat-model packages (`@langchain/core` plus one per provider, each with its own usage shape) or a loop like Option 1's. The planner turn is one bounded call of at most 3 steps, with no waiting and nothing to resume, so a checkpointer adds nothing to it.

### 2.5 Comparison

| | Option 1: own loop | Option 2: into #553 |
|---|---|---|
| New code | ~150 lines plus ~250 lines of tests | #553 S2.1–S2.3 at least (its estimate: 4 agent-days) plus a model node |
| New packages | None. Declares `@ai-sdk/provider`, already installed. | At least `@langchain/langgraph`, `@langchain/langgraph-checkpoint`, `@langchain/core`, plus chat-model packages if used (tree not measured: no install on this server) |
| Migrations | None | Two (owner's yes each) |
| Usage for reserve and settle | Provider `raw` passed through untouched; same pricing functions; proven equal by the differential test | A new usage shape to map (LangChain `usage_metadata`) unless the node uses Option 1's loop anyway |
| "Not billed when nothing came back" | Same code path (`rig-agent.ts:885-889`) | Same, once the graph wraps it |
| Streaming | Not used today; nothing to keep | Not used |
| Tests with mocks | Every existing planner test runs unchanged | New harness (graph, checkpointer conformance) |
| Removes Vercel? | Removes `ToolLoopAgent` from the planner; with B3–B7, removes `ai`, and with it `@ai-sdk/gateway` and `@vercel/oidc` from the install | Removes nothing by itself; the other three `ToolLoopAgent` users and `generateText`/`generateImage` remain |

**Recommendation: Option 1.** It is smaller (no package, no migration, one file), and safer: the money path reads the same raw provider counts through the same functions, and a differential test against today's loop proves it before the switch. It is also what #553 would need inside its model nodes, so it does not block #553; #553 can call it later.

### 2.6 PRs for (b)

| PR | What | Tests (all mocked) | Review | Size |
|---|---|---|---|---|
| **B1** The loop | `lib/llm/tool-loop.ts` and its usage conversion; declare `@ai-sdk/provider`. No caller yet. | Unit tests of the loop on scripted V4 models: step limit, last step without tools, bad tool input, unknown tool, tool order, abort, timeout, JSON result parse. Usage conversion equals `ai`'s on recorded fixtures for each vendor. | **Opus money review** (usage conversion) | M |
| **B2** The planner on it | `rig-agent-planner.ts:205-258` uses the loop. | Unchanged: `rigAgent`, `rigAgentRuns`, `rigAgentAttachments`, `planApproval`, `rigLock`, `sampleLift`, `textDirect.spec.ts:326-332`. New: the differential test; a failed step 2 is not billed and settles unbilled; a stopped run sends nothing. | **Opus money review** | M |
| B3–B6 (only on decision D2) | Move `suite-agent.ts:115`, `astra-blender/agent.ts:73`, `:91`, `development-server.ts:591` to the loop; replace `generateText` (`lib/textDirect.ts:261`), `generateImage` (`lib/vendorImages.ts:109`, cost read at `:111-125`), `wrapLanguageModel` (`lib/language-provider.ts:45`, `:63`), and the two error classes (`APICallError` from `@ai-sdk/provider`; our own no-image check). Tests swap `ai/test` mocks for plain V4 objects. One concern per PR. | Each with a differential test against today's call while `ai` is installed. | **Opus money review** on each (all are paid text or images) | M each |
| B7 (only on D2) | Remove `ai`. `@ai-sdk/gateway` and `@vercel/oidc` leave the lockfile (if Blob and Sandbox are already out). | `npm ls` shows neither; the guard's lockfile ratchet drops to zero. | Lead | S |

---

## 3. (c) Vercel Blob

### 3.1 How the app reads and writes Blob today

All storage goes through `lib/storage.ts` and the backend seam:
- **Selector:** `STORAGE_BACKEND` (`lib/storage/backend.ts:26-31`). Unset, the Blob token alone selects Blob.
- **The dual read:** with `STORAGE_BACKEND=r2` and `BLOB_READ_WRITE_TOKEN` set, `cloudBackend()` wraps R2 with Blob as a read fallback (`:66-71`, `:74-85`). Writes, deletes and lists touch R2 only. `get` and `head` try R2, then Blob; `presignGet` signs on whichever holds the object.
- **Absolute Blob URLs in rows:** recognised by host (`:96-97`, `:109-118`). Under R2 they are read at their decoded path on R2, then the original URL on Blob if the token is set (`:116`).
- **The Blob SDK:** only `lib/storage/blob.ts:23-27` (lazy import), behind `blobBackend()` (`backend.ts:54-56`).
- **Key families** (`lib/storage.ts:33-50`, `:634`, `:874`): `generations/<id>.mp4|png|mp3|glb` (renders and originals), `uploads/<id>.<ext>`, `identities/<id>.zip` (training archive), `consents/<id>.<ext>` (consent recordings), `chunks/<session>/<n>` (in-flight uploads, deleted after assembly), `platform/…` (platform previews and health probes). Every workspace except the legacy one is prefixed `ws/<workspaceId>/` (`lib/storage.ts:32`).
- **Other Blob users:** `scripts/ops/backup-lib.mjs:600`, `:1104` (backups with `blob` or `dual` media), `scripts/ops/blob-to-r2.mjs:370`, `:738`, `scripts/ops/migrate-media-r2.mjs:6` (the older copier, with `lib/storage/migrate.mjs`), `scripts/ops/staging-rehearsal.mjs:12`. Module mocks of `@vercel/blob` in `tests/unit/mediaRange.spec.ts`, `operationalHealth.spec.ts:42`, `privateUploadStream.spec.ts`, `reviewLinks.spec.ts`, `selects.spec.ts`, `storageChunks.spec.ts`.

**Columns that can point at a stored object:**

| Table (database) | Column | How it resolves | In `--verify` today? |
|---|---|---|---|
| `generations` (workspace) | `stored_url` | Read by deterministic key `generations/<id>.<ext>` (`app/api/media/[id]/route.ts:82-84`) | Yes (`scripts/ops/backup-lib.mjs:781-787`), succeeded and not deleted |
| `uploads` (workspace) | `stored_url` | Bare key, absolute Blob URL, or deterministic key | Yes (`backup-lib.mjs:789-805`) |
| `uploads` (workspace) | `derivative_url` | Sent to engines that cannot take the master (`lib/falVideo.ts:80`, written at `lib/uploadReservations.ts:549-565`) | **No** |
| `workbench_media` (workspace) | `stored_url` | As uploads | Yes |
| `consent_recordings` (workspace) | `stored_url` | `consents/<id>.<ext>` (`lib/security/consent.ts:46-48`, `lib/storage.ts:874-895`) | **No** |
| `identities` (workspace) | `photos`, `cover_upload_id` | Upload ids, so covered through `uploads` | Indirectly |
| `identities` | `lora_url`, `config_url` | The trainer's own hosted files, not our store | Not ours |
| — | `identities/<id>.zip` | No column; rebuilt from the photos on the next training (`lib/identities.ts:381-392`) | No (not needed) |
| `platform_assets` (platform) | `path` | Bare key under `platform/` | Yes (`backup-lib.mjs:775-779`) |

### 3.2 The inventory (read-only, run by the owner or the advisor only)

What exists: `blob-to-r2.mjs --dry-run` counts every Blob object not on R2, with bytes and conflicts, and writes keys only to a private report (`scripts/ops/blob-to-r2.mjs:382-560`). `--verify --live` resolves every referenced row on R2 alone (`:687-760`).

What is missing, added by **PR C1** (ops only):
- `scripts/ops/vercel-census.mjs --live --private-dir DIR`. Read-only. It reuses the live database snapshotting of `blob-to-r2.mjs` (`:610-685`) and the store listings (`backup-lib.mjs:362`, `:505`). It prints **counts only**:
  - per table and kind: referenced objects on R2; **on Blob only**; on neither;
  - Blob objects referenced by no row (orphans): count and bytes;
  - workspaces with a `gateway_key_id` (for A2);
  - 3D jobs not settled, by backend (for A6).
  Row ids for anything missing go only to a private report file (mode 600) in the private folder. Never keys, URLs or file names on screen.
- `verifyMediaReferences` (`backup-lib.mjs:739-812`) also checks `consent_recordings.stored_url` and `uploads.derivative_url`. This strengthens backups too. A nightly backup that then fails is a true finding.
- `--verify --open`: for every referenced object, a ranged GET of its first byte **straight from R2 with the S3 client**, not through the app. Confirms each one opens, and its size matches.

Cost: listing Blob uses Blob "advanced operations" on the Vercel bill (pennies). Reading for the copy uses Blob transfer (the store was about 404 MB in September, `docs/selfhost-test.md:722`). R2 writes are class A operations. No customer workspace is touched or billed.

### 3.3 The copy (exists: `scripts/ops/blob-to-r2.mjs`)

- **Keys:** each object goes to its Blob pathname and, when an absolute URL decodes differently, to that key too: exactly what the app reads (`:85-101`).
- **No overwrite, ever:** conditional writes, `If-None-Match: *` (`:292-366`, at `:308` and `:334`). A 412 means R2 already has the key; the bytes are compared and a difference is a **conflict**, reported, never overwritten (`:444-494`).
- **Checks:** source size and ETag against the listing (`:186-205`). A single PUT is checked by R2's MD5 ETag; multipart by a read-back SHA-256 (`:478-490`, `:264-290`). `--deep` re-hashes objects that were already present at the same size; `--readback` forces read-back.
- **Resume and idempotency:** one JSON line per verified object in `blob-to-r2-progress.jsonl`; a torn last line is ignored (`:119-138`). A rerun skips what the progress file proves (`:446-455`). A lock file stops two runs at once (`:156-170`).
- **Retries:** network faults, 5xx and 429 are retried; permanent Blob errors are not (`:176-183`).
- **Privacy:** counts on screen; keys only in private reports; the private folder must be outside the checkout and owner-only (`privateDirectory`).
- **The known flake:** two reports written in the same millisecond collided. Fixed in #636 (merged 10 Oct): the name gets a counter and the open stays exclusive (`:143-154`); test `tests/ops/blob-to-r2.test.mjs:625`.
- 15 tests cover keys, copy, skip, conflict, retry, resume, dry run, verify and `--live` (`tests/ops/blob-to-r2.test.mjs:191-625`).

### 3.4 The verify step: proving R2 alone

- **In the script:** `--verify` resolves every reference with media kind `r2` (`blob-to-r2.mjs:729`). In that mode the resolver looks only at the R2 listing and never at Blob, whatever is set (`backup-lib.mjs:702-735`). With `BLOB_READ_WRITE_TOKEN` in the env file it **also** lists Blob and fails if any Blob object is not on R2 at its keys (`blob-to-r2.mjs:736-755`). Add `--open` (C1) so each object is actually read from R2.
- **In the app:** the fallback exists only while `BLOB_READ_WRITE_TOKEN` is set (`backend.ts:69`, `:116`). Unset, `cloudBackend()` is R2 alone and an old Blob URL is read from R2 at its decoded path, with no fallback. That is the cutover (3.5). Storage readiness already accepts R2 without the token (`lib/deploymentReadiness.ts:126-135`).

### 3.5 The cutover

1. Owner runs the census, the copy until clean, and the verify (O4–O6). Pass: on-Blob-only = 0, missing = 0, `"ok":true`, `"blobObjectsNotOnR2":0`, `--open` failures = 0.
2. Owner removes **`BLOB_READ_WRITE_TOKEN`** from the production app's settings and redeploys. Keep `STORAGE_BACKEND=r2` and the four `R2_*` settings. Keep the token's value in the owner's private record.
3. Watch for 7 days (owner can change): signed in, open an old image, play an old video and seek, download an old upload, open an old review link; `/api/health?deep=1` shows `r2-private`; the app log shows no storage not-found spike.
4. **PR C2** (only after the owner's yes): remove `lib/storage/blob.ts`, `blobBackend`, the fallback in `migrationBackend`, and the `blob` value of `STORAGE_BACKEND` (`backend.ts:26-31`, `:54-85`). `resolveStored` keeps recognising the Blob host and maps old URLs to R2 keys. Remove the `blob` and `dual` media kinds from `backup-lib.mjs`, `migrate-media-r2.mjs`, `lib/storage/migrate.mjs`, the Blob part of `staging-rehearsal.mjs`, and `blob-to-r2.mjs` with its test. Tag the last commit that has the copy tool, so it can still be run during retention. Rename the platform label. Drop `@vercel/blob`. Tests: storage seam, `storageBackendR2`, `mediaRange`, `privateUploadStream`, `reviewLinks`, `selects`, `storageChunks`, `operationalHealth`, `tests/ops/backup-r2.test.mjs`; the `@vercel/blob` module mocks go (owner's word, listed in 3.1).
5. Privacy page copy (decision D8) and docs follow.

### 3.6 Deletion from Blob

**Never without the owner's yes.** It is a separate, later step. **Owner (14 Oct):** Blob is kept read-only for 30 days after the cutover, and the Vercel project `particlstudio` is deleted in one step as the very last step (O9). Closing the Vercel account deletes the Blob store, so **closing the account is the deletion** and needs that same yes. Suggested: a retention period after the cutover (the owner sets it; the account closing date limits it), with a private archive taken first by the backup tool with `dual` media (`docs/backup-restore.md`) if the owner wants a copy outside both stores. Nothing in this plan deletes anything on either store.

### 3.7 Rollback at each step

| Step | Rollback |
|---|---|
| Census, dry run, verify | Read-only. Nothing to undo. |
| Copy | Writes only keys R2 does not have, with verified bytes. The app already reads R2 first, so users see the same file. Nothing to undo. A bad copy is reported, never silently kept. |
| Cutover (token removed) | Put `BLOB_READ_WRITE_TOKEN` back and redeploy. The fallback returns at once (`backend.ts:69`). |
| C2 (code removed) | Revert the PR and put the token back. Possible only while the Blob store exists. |
| Deletion or account closure | **None.** Hence last, with retention and an archive. |

### 3.8 Commands for the owner (setting names only)

Where: the owner's machine or the server's terminal, never a shared or CI machine. A checkout of this repo with `npm ci`. Env files outside the checkout, `chmod 600`. One private folder per tool, `chmod 700`.

- `/private/blob-to-r2.env` holds: `BLOB_READ_WRITE_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_ENDPOINT` only if production sets it.
- `/private/live.env` holds the same, plus `PLATFORM_DATABASE_URL`, `PLATFORM_AUTH_TOKEN` and the deployment's own `KEYRING_SECRET`.

```
# O4: census (after C1 merges). Read-only. Counts on screen.
node --env-file=/private/live.env scripts/ops/vercel-census.mjs --live --private-dir /private/vercel-census

# O5: dry run, then copy until a run shows failed 0 and copied 0, then one deep pass.
node --env-file=/private/blob-to-r2.env scripts/ops/blob-to-r2.mjs --dry-run --private-dir /private/blob-to-r2
node --env-file=/private/blob-to-r2.env scripts/ops/blob-to-r2.mjs --copy --private-dir /private/blob-to-r2
node --env-file=/private/blob-to-r2.env scripts/ops/blob-to-r2.mjs --copy --deep --private-dir /private/blob-to-r2

# O6: verify on R2 alone, and open every referenced object from R2 (--open after C1).
node --env-file=/private/live.env scripts/ops/blob-to-r2.mjs --verify --live --open --private-dir /private/blob-to-r2
```

Conflicts: read them with the advisor in the private report before the cutover. The app already shows the R2 version.

---

## 4. The guard

A new unit test, `tests/unit/vercelOut.spec.ts`, with its allowance file `tests/unit/vercel-out-ratchet.json`, built on the existing dated ratchet (`tests/helpers/ratchet.ts:1-30`, as the UI-names and spend-buttons guards use it). It runs in the unit project on every CI run (`.github/workflows/verify.yml:64`). It lands **first** (PR G1), with today's counts, so nothing new can arrive while the work goes on. Each later PR lowers its entries. A count may only go down; an entry past its date fails.

**What it checks:**
1. **Files:** `vercel.json`, anything under `.vercel/`, and `public/vercel.svg` are not tracked (`git ls-files`).
2. **`package.json`:** no key in any dependency section starts with `@vercel/` or is `@ai-sdk/gateway`. Today 4; zero after A5, A6 and C2.
3. **`package-lock.json`:** no installed package (a `packages` key whose last `node_modules/` segment is `@vercel/*` or `@ai-sdk/gateway`). Today 8 entries, each with the parent that pulls it in. Zero after B7. If the owner keeps `ai` (D2), two entries (`@ai-sdk/gateway`, `@vercel/oidc` under `ai`) stay, named, with no date.
4. **Source**, every tracked text file under `app/`, `lib/`, `components/`, `mcp/`, `scripts/`, `ops/`, `.github/`, and `proxy.ts`, `instrumentation.ts`, `next.config.ts`, `package.json` scripts. Comments are skipped by reading tokens with the TypeScript scanner (already a dev dependency), so "on Vercel" in a comment never counts. It counts:
   - imports (static, dynamic, `require`, `typeof import`) of `@vercel/*` or `@ai-sdk/gateway`;
   - imports that resolve to a removed module: `lib/gateway`, `lib/vercelKeys`, `lib/engines/vercel`, `lib/storage/blob`;
   - code tokens naming a setting `VERCEL` or `VERCEL_*`, `AI_GATEWAY_*`, and (after C2) `BLOB_READ_WRITE_TOKEN`, including destructuring (`lib/astra-blender/sandbox.ts:118`);
   - string literals holding `vercel.app`, `vercel.sh`, `vercel.com`, `vercel-storage.com`, `x-vercel-`, or `vercel-cron`.
5. **Tests:** imports of `@vercel/*`, `@ai-sdk/gateway`, or a removed module (so a dead mock cannot linger).
6. **Self-test:** each pattern fires on a planted in-memory sample; the same text in a comment does not.

**Allowed for good, each with its reason in the allowance file:**
- `lib/vercelGuard.ts`: the runtime guard names `VERCEL`, `VERCEL_OIDC_TOKEN`, `AI_GATEWAY_API_KEY` and `VERCEL_ENV` on purpose, to fail health if they appear.
- `lib/storage/backend.ts`: the Blob host only (after C2), to map old rows' URLs to R2 keys.
- `scripts/ops/snapshot-catalog.mjs`: Vercel's public model list, if the owner keeps it as the price source (D3).

**How it avoids false positives:**
- Not scanned: `docs/**`, every `*.md`, `tests/fixtures/**`, `design/`, `brand/`, `.claude/`, the guard's own two files, and git history.
- It never matches the bare word `vercel`. The ledger's `'vercel'` engine, `'vercel-sandbox'`, the `'gateway'` setting value and the worker's `/vercel/sandbox` path are data names in old rows and our own protocol, not Vercel use.
- Tests are scanned for imports only, so `vercelGuard.spec.ts` can keep setting `VERCEL` to prove the runtime guard.

---

## 5. Order, sizes, owner steps, risks

### 5.1 Order

Blob first in time, because the account closes before 27 October. The code removals can follow.

| # | Step | Who | Size | Depends on |
|---|---|---|---|---|
| 1 | **G1** the guard (ratchet at today's counts) | lane | S | — |
| 2 | **C1** census, coverage, `--open` | lane | M | — |
| 3 | O1–O3 settings check, cron heartbeat, census | owner | — | C1 |
| 4 | O4–O6 copy and verify | owner | — | C1 |
| 5 | O7 cutover: token removed, 7-day watch | owner | — | step 4 |
| 6 | **A1** config, **A2** gateway keys | lane | S, S | O2, O3 |
| 7 | **A3** split text helpers | lane | M | — |
| 8 | **B1**, **B2** the loop, the planner (Opus money review) | lane | M, M | — |
| 9 | **A4** catalogue snapshot only | lane | S | D3 |
| 10 | **A5** gateway door out | lane | L | A3, A4 |
| 11 | **A6** Sandbox out | lane | M | O1, O3 |
| 12 | **C2** Blob code out | lane | M | O7 and the owner's yes |
| 13 | **A7a–c** `VERCEL*` branches | lane | M ×3 | — |
| 14 | **A8** docs, privacy copy (D8) | lane | S | C2 |
| 15 | B3–B7 retire `ai` | lane | M ×4, S | D2 |
| 16 | Blob kept read-only for 30 days after the cutover (owner, 14 Oct); deleting the Blob store only with the owner's yes | owner | — | step 5 + 30 days, the owner's yes |
| 17 | **Last step: delete the Vercel project `particlstudio` in one step** (owner, 14 Oct: its previews stay until then) | owner | — | step 4 verified **and** the 7-day watch in step 5 passed; see the caution in 3.6 |

Roughly 14 PRs without B3–B7, 19 with them.

### 5.2 Owner steps

- **O1. Settings check (names and yes/no only, no values).** Confirm unset: `AI_GATEWAY_API_KEY`, `VERCEL`, `VERCEL_OIDC_TOKEN`. Report: `MODEL_CATALOG` (is it `static`?), `ASTRA_RENDER_BACKEND` (is it `selfhost`?), whether `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `ASTRA_BLENDER_SNAPSHOT_ID` are set, `TEXT_DIRECT`, `STORAGE_BACKEND`, and whether `BLOB_READ_WRITE_TOKEN` is set.
- **O2. Cron heartbeat.** Signed in as the platform owner (after the /api/health PR, the detail is the platform owner's only), `/api/health` shows the last cron run within 15 minutes, `by: "scheduler"` (`app/api/health/route.ts:205-235`). Proves the scheduled task, not `vercel.json`, drives it.
- **O3. Census** (command in 3.8). Gives the Blob-only counts, the `gateway_key_id` count and the unsettled 3D jobs. If the key count is not 0: revoke those keys in Vercel before closing. If unsettled 3D jobs are not 0: wait for them to settle before A6.
- **O4–O6. Copy and verify** (3.8).
- **O7. Cutover** (3.5): remove `BLOB_READ_WRITE_TOKEN`, redeploy, watch 7 days, then say yes to C2.
- **O8. Blob retention:** Blob stays read-only for 30 days after the cutover (owner, 14 Oct). Deleting the store needs the owner's own yes.
- **O9. Last step:** delete the Vercel project `particlstudio` in one step (owner, 14 Oct). Its preview deployments stay until then; they are not deleted one by one.
  - **When:** only after the Blob→R2 copy is verified (O6) and the 7-day watch (O7) has passed.
  - **Before clicking delete:** open the project's **Storage** tab and confirm the Blob store is a separate team resource that stays when the project goes.
  - **If deleting the project would delete the Blob store:** wait until the 30 days in O8 end, or disconnect the store from the project first.
- **Guard word:** for each PR, a yes to move or delete the tests it lists (1.5, 3.5).

### 5.3 Owner decisions

- **D1.** (b) Option 1, our own loop, rather than #553. Recommended.
- **D2.** Retire `ai` entirely (B3–B7), so `@ai-sdk/gateway` and `@vercel/oidc` leave the install. Recommended, after B2 has run a week.
- **D3.** Text prices come only from the checked-in snapshot at runtime. And the snapshot's source after Vercel: keep reading Vercel's public no-key list in the ops script, or move to the providers' own price lists. The snapshot must be refreshed by 5 February 2027 (`tests/unit/catalogStatic.spec.ts:20-33`, `:134-141`, 120 days from 8 October). Changing what a workspace is charged needs the owner's approval.
- **D4.** The guard word per PR (5.2).
- **D5.** Gateway keys: revoke any still recorded, in Vercel, before closing (O3).
- **D6.** 3D runs on the self-hosted workers only.
- **D7.** The cutover date, the watch length (7 days suggested) and the retention before any Blob deletion, within the account closing date.
- **D8.** The privacy page's two sentences about Vercel Blob (`app/(app)/privacy/page.tsx:29`, `:82`) change after C2.
- **D9.** No more preview deployments; staging is the preview.

### 5.4 Risks

1. **The account closes before the copy is verified.** Old files are lost. Mitigation: Blob first (C1 and O3–O6 lead the order).
2. **The live catalogue read.** If production reads Vercel's public model list today, A4 moves text prices to the snapshot. Mitigation: O1 first; any price change is shown to the owner before merge.
3. **Money path in B2.** A usage mapping slip would misbill a planning turn. Mitigation: raw counts passed through untouched; the differential test against today's loop; Opus money review.
4. **Verify coverage.** Consent recordings and upload derivatives are not checked today. Mitigation: C1 adds them before the cutover.
5. **Old 3D jobs.** A Vercel-backed job not settled before A6 could hold credits. Mitigation: census count 0 first.
6. **Security branches in A7.** Origins and client IP decide where reset links point and how rate limits count. Mitigation: table tests over today's off-Vercel cases; a security review; with `VERCEL` unset nothing changes.
7. **Guards.** Several guards pin today's behaviour. Mitigation: listed per PR; the owner's word each time; no case is weakened, new cases are added.
8. **Rollback ends when the account closes.** After closure, putting the Blob token back does nothing. Mitigation: the watch ends before the closure.

### 5.5 What this plan could not verify

- Production's settings (O1): `MODEL_CATALOG`, `ASTRA_RENDER_BACKEND`, `TEXT_DIRECT`, whether `BLOB_READ_WRITE_TOKEN` and the `VERCEL_TOKEN` family are set.
- Whether the copy has already been run, and how many objects are Blob-only (O3).
- The count of `gateway_key_id` rows and of unsettled 3D jobs (O3).
- That the scheduled cron task is running (O2).
- The size of #553's dependency tree (nothing was installed on this server).
