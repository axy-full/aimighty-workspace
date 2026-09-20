# Particl status of record

Updated 19 September 2026 (night). This file is the running handover: what is released, what was verified and how, and what is next. It supersedes the status sections of older handover documents where they differ. Claims are limited to what was observed; "released" means the commit is serving www.particl.app, not that every path has been exercised live.

## Released

| Item | Value |
| --- | --- |
| Released main | `89baffc` (19 September) — `d4a68a7` (PR192 Astra Blender + direct OpenAI) followed by the seven follow-ups below, each squash-merged after its own complete CI |
| Production deployment | `89baffc` serving www.particl.app on 19 September (`/api/health` from the owner session: commit `89baffc`, `ok:true`, cron succeeded 6 min earlier). PR192's own deployment was `dpl_3JYXuZJg5ut6RkuRGjwVfA9Sdufv` |
| Complete CI on the merged revision | run [35378251410](https://github.com/axy-full/aimighty-workspace/actions/runs/35378251410) on `e577256` (the branch head that was squashed): unit ×3, core, browser-shards workbench ×4 and customer ×4, both `browser` gates — all green |
| Previous released main | `3e0d20a` (PR191) |

The two viewport fixes that were uncommitted at handover (wall-time cap on orbit damping in `components/astra-blender/AstraViewport.tsx`; hit-tested drag helper and the 180 ms slow-render regression in `tests/astra-blender-workbench.spec.ts`) were committed as `e577256` and are part of `d4a68a7`. The backup patch in the handover folder is now historical; do not apply it.

## Verified after release (18 September, no paid generation)

All checks below ran against www.particl.app on deployment `dpl_3JYXuZJg5ut6RkuRGjwVfA9Sdufv` from the owner's signed-in browser session on the legacy Aimighty workspace, plus unauthenticated `curl` for the denial cases.

| Check | Result |
| --- | --- |
| `/api/health` | 200, `commit d4a68a7`, `ok:true`, cron `succeeded` 5 minutes earlier, database `turso`, storage `blob-configured` |
| `/api/openai/status` (owner) | 200 `configured:true verified:true route:"OpenAI direct" astraAvailable:true generationTested:false`; the key's model list (130 ids) includes `gpt-6-astra` |
| Gateway catalog | the public model list at `ai-gateway.vercel.sh/v1/models` carries `openai/gpt-6-astra` with pricing, so `catalog()` can price `ASTRA_BLENDER_MODEL` |
| `/api/workbench/astra-blender/render?projectId=dune-studies` with `X-Workbench-Scope` | 200 `runtime.configured:true blenderVersion:5.2.2 vcpus:2 memoryMb:4096 timeoutMs:180000`, `jobs:[]` |
| Same GET without the scope header | 409 "Your account or workspace changed…" (the scope guard, as designed) |
| Studio → Astra blender stage (desktop) | stage 06 renders the saved Product study scene in the WebGL viewport; Properties/Astra/Output panels present; Output panel reports "Blender 5.2.2 · Ready" |
| Review render quote (quoteOnly POST) | 200; dialog shows source 3D workspace, Blender 5.2.2, 180 s limit, outputs PNG + .blend + GLB, credit ceiling 0 cr. Zero because the legacy workspace meters USD and bills no credits (`lib/astra-blender/render-pricing.ts:28`); a customer workspace sees credits. **The render was not started.** |
| Project persistence (read) | `/api/workbench/projects?id=dune-studies` 200, revision 8, four seeded assets |
| Original download | signed-in GET `/api/uploads/upl_…?download=1` → 200 `image/png`, 5,628,839 bytes, `Content-Disposition: attachment; filename="MOTHER SHEET.png"`, `Cache-Control: private, no-store`; PNG magic bytes confirmed |
| Tenant/auth denial | unauthenticated GET of `/api/workbench/projects`, `/api/openai/status`, the Astra render route and the upload download → 401 |
| `/api/inngest` | Unsigned GET → 401 `{"message":"Unauthorized"}` (the Inngest SDK 4.19.0 refusing an unsigned request, so both keys are present). Vercel request logs for `www.particl.app/api/inngest` show, at the moment `dpl_3JYXuZJg5ut6RkuRGjwVfA9Sdufv` went READY (18:24 UTC), **GET 200 → PUT 200 → POST 200** from Inngest: the PUT is the function registration and returns 200 only when its signature verifies against the deployment's `INNGEST_SIGNING_KEY`. The same GET+PUT pair follows every deploy on 18 September. The functions served at `d4a68a7` are `[probe, render, astraRender]` (`lib/workers.ts:143`), so `astra-blender-render` is registered with that environment. **Dashboard visibility is unresolved:** the Inngest login reachable from the browser (organisation `SensAI Studios LLP`, created ~12 hours before this check) has no apps, event types or runs and is not the environment the production keys belong to; the Vercel marketplace installation (created 4 September, 11 events / 28 executions this period) lives in another Inngest organisation. Do not sync the app into `SensAI Studios LLP`. |

## Paid Astra qualification (19 September, owner-approved, ceiling $0.50)

Run from the owner session on the legacy Aimighty workspace (the only workspace on the account), project Dune Studies, on deployed `89baffc`:

| Step | Result |
| --- | --- |
| GPT-6 Astra proposal (`openai/gpt-6-astra`, medium effort, direct OpenAI) | job `wb_atomik_ff1a6c87-…` succeeded in ~40 s; proposal: body to #59402E / metalness 0.85 / roughness 0.36, key light warmed to #FFE6C9, 120-frame Z turntable; applied to the saved scene (2 keyframes). Quote reserved a $4.94 ceiling; **settled at $0.152885** metered USD; 0 credits (legacy workspace bills none). |
| Native render (scene source, Blender 5.2.2 on the Vercel Sandbox snapshot, OIDC auth) | job `astra_render_e81db968…` running → saving at ~60 s → **succeeded at 98 s**; artifacts `scene.blend` 654,339 B, `preview.png` 1,173,284 B (1280×960, a Cycles still of the bronze product on the plinth), `scene.glb` 27,984 B; each downloads with 200; registered as three "Astra Blender" project assets (project revision 10). **Compute settled at $0.004832** against the $0.10 ceiling; 0 credits billed. |
| Total | ≈ $0.158 of the $0.50 ceiling |

What this proves: the deployed OpenAI direct → reviewed proposal → apply → quote → Sandbox render → Blob storage → library registration → USD settlement path. What it does not prove: credit debiting (needs a non-legacy workspace) and the Inngest worker path — see below.

**Inngest finding from the same run:** Vercel request logs for 11:49–12:18 IST contain **no `/api/inngest` request**, so the render was not executed by the registered worker; it ran on the inline `after()` fallback of the render route (which is why it stayed within one request's budget). The deploy-time GET+PUT syncs do reach the deployment, but the event sent with the deployment's `INNGEST_EVENT_KEY` did not trigger a function. Two facts point at a key/organisation split: the Inngest organisation reachable from the GitHub login (`SensAI Studios LLP`) was created on 18 September and has no apps, and the Vercel marketplace installation (created 4 September, still counting events) is not connected to the `particlstudio` project (the project's `INNGEST_*` values were added by hand; `INNGEST_SERVE_ORIGIN` on 14 September). Resolution is an operator action: connect the marketplace installation to the project (or reinstall it while signed in to the intended Inngest organisation), let it write the keys, redeploy, then repeat one ~$0.005 render and confirm a `POST /api/inngest` in the logs.

Also observed: one project GET timed out during the docs deploy cutover and raised the "Connection interrupted" banner; the retry recovered on its own.


Production environment (names only): `ASTRA_BLENDER_SNAPSHOT_ID`, `ASTRA_BLENDER_RATE_CARD`, `OPENAI_API_KEY`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_SERVE_ORIGIN`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `KEYRING_SECRET`, Turso and provider keys. No `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`: Sandbox control-plane auth relies on Vercel OIDC, which is enabled on the project (`oidcTokenConfig.enabled:true`, issuer mode `team`) and read by `@vercel/sandbox` through `VERCEL_OIDC_TOKEN`.

## Audit of the remaining work (18 September)

A read-only audit of eight areas was run against this checkout (Astra release, direct OpenAI, long-form mastering, OCR/screenplay, provider qualification, capacity/backups/recovery, Studio/tenancy/accounting invariants, design/navigation). Findings that change priorities:

- **Inngest degrades silently.** If registration is missing, every native render falls back to inline execution inside `after()` on the request path (up to ~250 s of a 300 s function) with no concurrency limits. Dashboard confirmation is therefore the first post-release task.
- **Per-poll recovery cost.** The Astra render route reserves a recovery continuation and runs `recoverAstraRenders` on every 5-second poll (`app/api/workbench/astra-blender/render/route.ts:26`); gate it on pending jobs.
- **Backups are not active.** No backup artifact has ever been produced by the project pipeline; `KEYRING_SECRET` has no verified second copy outside archives that do not exist; the preflight table list predates `astra_render_jobs`.
- **No operator alerting** beyond Vercel logs, `/api/health` and the Actions UI; no paid-dispatch kill switch short of fencing the whole app.
- **Catalog gating is all-or-nothing per OpenAI key**: when verification fails, every `openai/*` entry disappears from menus, including Gateway-served image and speech models (`lib/catalog.ts:131`).
- **Generation DELETE ignores the captured scope** (`app/api/jobs/[id]/route.ts:135`) while upload DELETE enforces it; damage is bounded to the tenant.
- **Atomik crew silently truncates screenplays** to 8k–24k characters (`lib/workbench/atomik-server.ts:194`) with no on-screen notice; the Development flow is compliant.
- **Design:** `app/four-suites.css:2-19` re-declares the `--graphite-*` tokens after `app/globals.css`, so the rendered palette is four-suites.css while the only token unit test asserts globals.css; the supplied mobile navigation model is rendered but hidden by `four-suites.css:124-131` in favour of the project-bar grid and suite dock; suite tab labels read "Subatomik" and "Atomik Agent". These need the owner's confirmation before further design work.
- **Long-form mastering** cannot run on any existing host (Sandbox 180 s / 4 GB, functions ≤300 s); it needs a separate CPU worker with a reviewed rate card and spend approval.
- **Provider qualification** items (Cloud Genjutsu, connected Genjutsu, Marketing Studio Image, Soul) each need a paid rehearsal under an explicit ceiling; the marketing video rehearsal still runs in the provider's UGC mode.

## Restructure and platform work merged 19 September (evening/night)

| PR | What landed | Verification |
| --- | --- | --- |
| [PR203](https://github.com/axy-full/aimighty-workspace/pull/203) | Storage backend seam behind `lib/storage.ts`; Blob unchanged, R2 backend implemented but not selected (`docs/r2-storage-plan.md`) | 37 storage/upload specs, whole unit project, full CI |
| [PR204](https://github.com/axy-full/aimighty-workspace/pull/204), [PR206](https://github.com/axy-full/aimighty-workspace/pull/206), [PR215](https://github.com/axy-full/aimighty-workspace/pull/215) | Native dispatch on Vercel (`POST /api/worker`, cron bearer, `worker_slots` 4/2 limits, 202 hand-off, cron as retry path); Inngest optional behind `DISPATCH_MODE=inngest`; dispatch outcome logging; durable `dispatch_log` on the owner's `/api/health` | **Worker path proven on `16c752c`:** Astra job `277dbf74` → `dispatch.recent` = `send: sent 202 (358 ms)`, then `run: finished-ok (83.6 s)`; job succeeded, $0.0067 compute. Inngest keys and both integrations can be removed. |
| [PR205](https://github.com/axy-full/aimighty-workspace/pull/205), [PR211](https://github.com/axy-full/aimighty-workspace/pull/211) | `docs/four-suites-v2-plan.md` (owner brief mapped to the code and the authenticated 98-model catalogue) and `docs/rig-bug-inventory.md` (43 ranked defects) | docs |
| [PR207](https://github.com/axy-full/aimighty-workspace/pull/207) | Subatomik defaults to connected credits; no billing toggle in the flow; approval safeguards kept | 40 + 60 browser tests, full CI |
| [PR208](https://github.com/axy-full/aimighty-workspace/pull/208), [PR210](https://github.com/axy-full/aimighty-workspace/pull/210) | Atomik Super Agent: Generate (image/video/sound/3D over the live catalogue) and Tools (upscale image/video, background removal, extend canvas, deflicker, lip-sync), quote → approve → claim → receipt on the connected account | 21 + 26 unit, 172 regression, 15 + 25 browser at five viewports, full CI |
| [PR209](https://github.com/axy-full/aimighty-workspace/pull/209) | Information architecture: four suite names; project selector first; Particl stages Brief & Script · Boards (Look folded in) · Cast & Elements · Astra blender · Rig · Takes (uploads + generations) · Edit & Sound · Deliver with `script`/`moodboard`/`elements` aliases; Moleculr as one Marketing Studio page; one label vocabulary | full workbench (471 + 97) and customer (94) suites locally, full CI; live check on `17f3496`: home order, suite names, eight-stage dock, `?stage=script` → `brief` |
| [PR212](https://github.com/axy-full/aimighty-workspace/pull/212) | Edit & Sound: voice-over / sound effect / music generated into the timeline lanes (quote-first, idempotent), Dialogue task on the admission layer; Voice change and Dubbing deferred to C2 with endpoint facts | 57 unit, 5 + 14 browser, full CI |
| [PR213](https://github.com/axy-full/aimighty-workspace/pull/213) | Cast & Elements identity-first: identity state on every card, Identity action, ready identity pre-selected as reference, gated-render notice; older LoRA trainer marked legacy; no provider names | 73 unit, 52 browser, full CI |
| [PR214](https://github.com/axy-full/aimighty-workspace/pull/214) | Moleculr Marketing Studio: v2 template catalogue browser (Format) and Create with template (Variants) with fail-closed contract checks; synthetic fixture, first live run owed | 21 + 176 unit, 117 browser, full CI |
| [PR216](https://github.com/axy-full/aimighty-workspace/pull/216) | Rig bug pass, workbench canvas: inventory items 1–4, 8–24, 26, 35, 43 fixed; legacy `/rig` board deferred to the owner | 16 unit, 28 + 8 + 52 browser; CI rerun pending on an unrelated account-security flake |

Decisions recorded tonight: Inngest is not wanted (native dispatch replaces it); R2 pulled forward (buckets/token owed by the owner); design questions deferred to the Claude Design pass. Owed: the legacy `/rig` board decision (fix to workbench standards or retire); Inngest env/integration removal; paid qualifications under stated ceilings (Astra on a non-legacy workspace, identity render, Marketing v2 first run, one generation per output type); backups activation; the C2 audio endpoints; slice I3 (voice/dubbing/analysis on the connected account).

## Follow-up PRs merged 19 September (from the audit)

| PR | Concern | Local verification |
| --- | --- | --- |
| [PR194](https://github.com/axy-full/aimighty-workspace/pull/194) | Astra render GET reserves a recovery continuation only when a render is unsettled; `astra_render_jobs` with `settled=0` blocks backup capture; unit test pins the served worker list, the Astra trigger, retries and concurrency; suite-navigation spec runs at all five viewports | tsc, eslint, ops backup tests 8/8, new unit spec, suite-navigation at five viewports on port 4765 |
| [PR195](https://github.com/axy-full/aimighty-workspace/pull/195) | Generation DELETE requires the captured workbench scope (as upload DELETE already did); GenCard, Theatre and the context menu send it | tsc, eslint, asset-library unit spec 7/7 with the new refusal case |
| [PR196](https://github.com/axy-full/aimighty-workspace/pull/196) | Direct-OpenAI catalog gate applies to language models only; Gateway-served OpenAI image/speech entries follow Gateway reachability | tsc, eslint, new unit spec + catalogTextPricing; first CI attempt failed two unit shards because the spec mutated `process.env` at module load — fixed by scoping and restoring inside the test |
| [PR197](https://github.com/axy-full/aimighty-workspace/pull/197) | Atomik quotes carry `screenplay {chars, includedChars, truncated}` and the run dialog states the window read at this depth | tsc, eslint, workbenchAtomik spec 35/35 |

| [PR198](https://github.com/axy-full/aimighty-workspace/pull/198) | Generation PATCH (rename, review state, shot/project moves) requires the captured scope; renameClip, Theatre and the canvas page send it | tsc, eslint, asset-library unit spec 7/7 (PATCH + DELETE refusal case) |
| [PR199](https://github.com/axy-full/aimighty-workspace/pull/199) | The Higgsfield Verify rehearsal names `product_showcase` instead of inheriting the provider's UGC presenter default; no paid call | tsc, eslint, consumer video contract + route specs 23/23 |

All seven merged in number order (#193 `4c8464f`, #194 `7c21d57`, #195 `a3d89c6`, #196 `259e2cd`, #197 `97d5b80`, #198 `89baffc`, #199 `8c33e62`), each after a fully green run of `.github/workflows/verify.yml`. Re-checked on the deployed `89baffc` from the owner session: OpenAI status verified with `gpt-6-astra`; Astra runtime read 200 with the scope header and 409 without; original download 200 with attachment disposition. Still separate: `recoveryDrain` coverage for the Astra branch.

## Decisions recorded 19 September

Measured on the Vercel usage page for the current period: Blob data transfer 51 GB ($3.43), fast origin transfer 17 GB ($4.24, bytes streamed through functions including `/api/uploads` downloads), Blob storage 404 MB, function invocations 104K ($0.06), Sandbox $0.07; Inngest 11 events / 28 executions on the free plan.

- **Inngest is no longer required** (superseding the 19 September "Inngest is kept" note, after the worker finding above). Dispatch is native on Vercel: the request POSTs the event to the app's own `/api/worker`, which answers 202 and runs the same handler in its own 300 s function, with a platform `worker_slots` table enforcing the same 4 / 2-per-workspace concurrency. Retries are single-attempt plus the ten-minute cron; the produce-once guarantee comes from the row (`paidClaim`, `producedOutcome`), not from Inngest memoisation. Inngest remains available as an opt-in (`DISPATCH_MODE=inngest` with both keys). Modes, env, verification and the exact retry differences: `docs/native-dispatch.md`.
- **Cloudflare R2 is planned, not started.** Zero egress removes both transfer lines only if private downloads redirect to short-lived signed URLs instead of streaming through functions. Sequence: backups and alerting first, then R2, then long-form mastering (so masters never migrate twice). Trigger: sustained egress above ~300 GB/month or mastering becoming the next item. The owner creates the account, bucket and scoped token and stores them in Vercel; the adapter goes behind `lib/storage.ts` with dual-read during cutover and SHA-256 verification of the copied originals.
- The Vercel CLI on the development machine lost its token on 19 September (auth file emptied at 10:51, not by this work); deployment checks fall back to the signed-in browser session until `vercel login` is run again.
- Stale pull requests from before the takeover remain open: #123–#131 (SOW surfaces, ark-video era) and dependabot #135–#141. They are not part of this line of work; close or park them explicitly.



## Next work, in order

1. Deploy native dispatch: confirm `CRON_SECRET` and `APP_ORIGIN` are set in production, deploy, read `dispatch.mode: "native"` on `/api/health`, then run one ~$0.005 render and confirm a `POST /api/worker → 202` followed by a `worker.finished` log line (docs/native-dispatch.md). The Inngest organisation question is moot unless the deployment opts back in with `DISPATCH_MODE=inngest`; the marketplace installation can be removed once native dispatch is verified.
2. Done 19 September (PR194–PR199) except: `recoveryDrain` coverage for the Astra branch; a Settings card to save a workspace OpenAI key (BYOK precedence exists only via API today); the staged whole-screenplay analysis.
5. Done 19 September on the legacy workspace (see above); repeat on a non-legacy workspace once one exists, to exercise credit debiting.
6. Backups and recovery: activate the backup workflow (environment, secrets, one manual capture, freshness), escrow `KEYRING_SECRET`, add an alerting channel and a paid-dispatch kill switch, then measure RPO/RTO on a staging restore.
7. Long-form mastering design and host decision (needs a spend decision), then OCR durability and multilingual qualification, then provider qualification under explicit ceilings.
8. Product restructure ordered 19 September: PR A (information architecture only: suite names, the eight-stage Particl dock with `script`/`moodboard`/`elements` as aliases, Moleculr collapsed to one Marketing Studio page with seven sections, the project selector first on home) is done on `feat/four-suites-ia`; PRs B+ (features) follow the inventory. See [docs/four-suite-workspace.md](../four-suite-workspace.md).

Design decisions awaiting the owner: which palette declaration is the approved desktop appearance; whether the suite dock has replaced the supplied mobile tab-bar navigation; the exact suite tab labels.

## Workspace redesign and connected-account parity — 19–20 September

The owner supplied a high-fidelity design handoff (`design_handoff_particl_workspace`: tokens, shell, pages, state/agent docs and an HTML prototype) and asked for it to be rebuilt in this codebase, then said "start work on all fronts". Five decisions were taken before any code and hold for all of it:

1. **Phones keep today's surfaces.** The new shell is desktop (≥1100px); below 760px `/workspace` redirects to `/workbench`. Ground rule 7 still applies: every change ships with the five-viewport Playwright run.
2. **Nothing is simulated.** The prototype's 150 ms generation bar and 680 ms agent tick are not reproduced. Progress comes from real jobs; a plan step advances when its backend call returns; a plan with no backend reports "Not runnable yet — …" and never animates.
3. **Atomik Generate stays** as a ninth Atomik page alongside the design's eight.
4. **Prices are credits from live quotes**, never the provider's USD (the design's "$1.16" is our cost, not the customer's price).
5. **Model names are real on our own surfaces, neutral on the connected one** (amended by the owner, 20 September, reversing part of PR231 for MODEL names only): a model we integrate directly is named — Seedance 2.5, Kling 3.0 Pro, Nano Banana 2, Topaz Astra 2, Eleven v3, GPT-6 Astra, Claude Fable 5.1, Gemini 3.1 Pro — while the catalogue served through the connected account keeps neutral names, and Higgsfield, Supercomputer, Genjutsu and Soul ID are still never printed anywhere.

### What shipped (main `177bd05`, deployed and checked on production)

| Area | PRs |
| --- | --- |
| Foundation: `--pxw-*` tokens, primitives, shell (top bar, stage tabs, Library, three header rows, Inspector, status bar), `go()` with selection repair, Home | [PR223](https://github.com/axy-full/aimighty-workspace/pull/223) |
| Shot/take data: optional `look`/`engine`/`durationS`/`ratio`/`resolution` on draft nodes, `rigShots`, `projectTakes`, live credit estimate matching the server formula | [PR221](https://github.com/axy-full/aimighty-workspace/pull/221) |
| Plan registry and gated run engine (23 plans; `ApprovedQuote` token only `approve()` can mint) | [PR222](https://github.com/axy-full/aimighty-workspace/pull/222) |
| Rig: shot list, Inspector controls that persist, generation with the exact live quote; node graph over the real draft | [PR236](https://github.com/axy-full/aimighty-workspace/pull/236), [PR237](https://github.com/axy-full/aimighty-workspace/pull/237) |
| Takes, Cast & Elements, Edit & Sound | [PR229](https://github.com/axy-full/aimighty-workspace/pull/229), [PR238](https://github.com/axy-full/aimighty-workspace/pull/238), [PR239](https://github.com/axy-full/aimighty-workspace/pull/239) |
| Spec-card template and every remaining page, each mounting the tool that already works | [PR241](https://github.com/axy-full/aimighty-workspace/pull/241), [PR242](https://github.com/axy-full/aimighty-workspace/pull/242) |
| Atomik panel, gates and agent surfaces; ⌘K palette and keyboard map | [PR232](https://github.com/axy-full/aimighty-workspace/pull/232), [PR233](https://github.com/axy-full/aimighty-workspace/pull/233) |
| Neutral vendor copy: one banned-name list, `displayModelName`, 179 files, guard spec | [PR231](https://github.com/axy-full/aimighty-workspace/pull/231), gaps closed in [PR244](https://github.com/axy-full/aimighty-workspace/pull/244) |
| Real model names restored on the direct surfaces; the guard now bans only the connected-account vocabulary | [PR260](https://github.com/axy-full/aimighty-workspace/pull/260) |
| Connected account: toolset guard before every paid call and status read; planner reads and priced connected steps; presets and batches; workflows as recipes and slash commands | [PR226](https://github.com/axy-full/aimighty-workspace/pull/226), [PR228](https://github.com/axy-full/aimighty-workspace/pull/228), [PR234](https://github.com/axy-full/aimighty-workspace/pull/234), [PR240](https://github.com/axy-full/aimighty-workspace/pull/240) |
| Connected features: game-pipeline-only audio models withdrawn plus a voice picker; reframe; Shorts Studio with a multi-clip collector; explainer styles (browse only, no price path) | [PR225](https://github.com/axy-full/aimighty-workspace/pull/225), [PR227](https://github.com/axy-full/aimighty-workspace/pull/227), [PR230](https://github.com/axy-full/aimighty-workspace/pull/230), [PR235](https://github.com/axy-full/aimighty-workspace/pull/235) |
| Shorts clip polling through the guard's status fallback; Marketing and Shorts plan requests; CI in six browser shards | [PR245](https://github.com/axy-full/aimighty-workspace/pull/245), [PR246](https://github.com/axy-full/aimighty-workspace/pull/246), [PR243](https://github.com/axy-full/aimighty-workspace/pull/243) |

`/workspace` is a new route; `/`, `/workbench`, `/atomik` and `/subatomik` are untouched. The switch-over is a separate PR and needs the owner's word, because it changes what every user sees.

### Differences from the handoff, and why

- A finished render does **not** flip its shot to Approved. The lifecycle is draft → picked → approved (ground rule 4); the take is filed for review. Pinned by a test.
- The progress strip shows the job's phase, not a percentage: no engine reports one.
- Edit & Sound has three stem rows, not four. The edit has dialogue, effects and music lanes; ambience beds are generated as effects onto the effects lane, and the page says so.
- Home project cards carry no progress bar or "Sample project" pill: nothing records stage completion per project yet.
- Five labels the prototype set below `#7C7C84` were raised to the contrast floor.
- Marketing Studio is linked, not mounted, until its flow is extracted from `Studio.tsx` ([PR](https://github.com/axy-full/aimighty-workspace/pull/247) in progress).

### Not runnable, and what each needs

`builds` (an app build-and-deploy service with its own quote), `skills` (a skills registry endpoint), `takes` triage (a verdict-per-take endpoint), `budget` reconcile (an on-demand ledger route; today it runs only from `/api/cron/sync`), `sources` (a re-hash and re-measure endpoint), and `boards` — a board frame is a `Shot` citing an existing asset, with no prompt, engine, ratio or resolution, and nothing in the product generates board images (SOW §2.8 records the board pipeline as unbuilt). None of these fakes progress.

### Owed before these can be called proven

Each needs an explicit, stated ceiling: the first live connected **batch**, **preset** run and **status-fallback** poll; **Shorts** and **reframe** first runs; Marketing v2's first run; an identity render; Astra on a non-legacy workspace. Response shapes for the batch submit, `presets_show`, Shorts session/clip and the `job_display`/`jobs_wait` fallback have never been seen live — every one of them fails closed, so an unrecognised reply leaves the job uncertain and collects nothing rather than re-spending.

### Atomik parity backlog (from the capability audit)

Supercomputer parity is the owner's standard for Atomik. Landed: connected reads, priced connected steps, presets, batches, workflows-as-recipes and slash commands. Remaining, in order: memory (A7), schedules with an owner credit ceiling (A8), Soul/Reference pickers (A9), AI Employees (A10), marketplace apps (A11), the connected agent API (A12, spends inside a turn with no prior quote — off by default), owner-only websites (A13), our own connectors (A14). Tools with no price path (voice clone, video analysis, virality, personal clipper, sandbox, apps, 3D scene builder, websites) cannot pass the quote → approval → claim → poll → collect contract until one approved run establishes a price.
