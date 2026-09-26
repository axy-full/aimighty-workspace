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
| Real model names restored on the direct surfaces; the guard now bans only the connected-account vocabulary | [PR262](https://github.com/axy-full/aimighty-workspace/pull/262) |
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

## 21 September — handoff refreshed

`main` is `e4c1610`, deployed and green. Landed since the redesign write-up above: one credit = US$0.10 stated once and derived everywhere (#270), the always-mounted credit slot on desktop and phone (#267, #269), the switch-over gate deciding once per page load so a landscape phone is never redirected mid-session (#272), and the Make wall's day grouping tested against a clock the test owns (#273). The full handover for a new session is [`HANDOFF.md`](HANDOFF.md), with a paste-ready opening prompt in [`START-HERE.md`](START-HERE.md). The one decision waiting on the owner: whether to flip phones from the old routes onto the new phone build.

## 21 September — Suites shell, build step 1 (branch `feat/suites-shell`, not released)

The owner supplied a new desktop design, **Particl Suites** (Graphite). It is filed at `design/particl-suites/` (README = the spec, `Particl Suites.dc.html` = reference only, never ported). The build order is the README's: shell → Gen → assets and drag-drop → Studio + Rig → Business/Viral → Atomik/Workspace → switch-over. Step 1 is this branch.

| What | Where |
| --- | --- |
| New route, beside the old ones, nothing switched over | `/suites` (`app/suites/page.tsx`). `/workspace` and `/workbench` are untouched in behaviour; both now share `lib/shell/bootstrap.server.ts`, extracted verbatim from `app/workspace/page.tsx` |
| Information architecture | `lib/shell/ia.ts`: Studio 8 stages, Business 3, Viral 3, Atomik 6, plus the Gen and Workspace views. Every shell page is backed by a page the existing state layer has, so `PAGE_BODIES`, `INSPECTOR_BODIES`, `AtomikHost`, `RigProvider` and `GenerateComposer` are reused, not rebuilt |
| State | `lib/shell/state.tsx` sits on top of `WorkspaceProvider`, which gained two optional props (`path`, `keep`) so it can write its URL under `/suites` and preserve the shell's own params (`view`, `tab`, `sp`). Default behaviour is unchanged |
| Chrome | `components/graphite/*` and `app/graphite.css` (tokens scoped under `.gx`; the reset is `:where(.gx)` so it never out-ranks a component or a hosted legacy body) |
| Pure logic with unit specs | `lib/shell/undo.ts` (20 deep), `context-menu.ts` (README order, blocked items keep their reason, viewport clamp), `palette.ts` (ranking, always ends in Ask Atomik) — `tests/unit/suitesShell.spec.ts` |
| Browser spec | `tests/suites-shell-workbench.spec.ts`, all five workbench viewports: header segment, strip gaps, 280/320 columns at ≥1280 and overlays below, per-suite page memory, Back/forward, pasted links, ⌘K, ⌘J, drag payload = asset id as `text/plain`, right-click menu inside the viewport, and the phone floors on the chrome |

Deliberately not in step 1, and shown as such in the UI rather than faked: asset actions other than Copy / Open in Inspector / Retry (disabled with the reason), `+` use-as-reference (step 3), the new Gen composer (the Gen view opens the existing composer), and Business pages 02–03 (all three still show the existing Marketing Studio body until step 5).

Open questions for the owner, none of which block step 1:

1. The design README prints the connected account's brand names in Business and Viral. The repo rule and `tests/unit/noVendorNamesInUi.spec.ts` forbid them. Step 1 follows the repo rule — the Atomik mark reads `AGENT`, not the prototype's word. Steps 2 and 5 need the decision.
2. "One balance, quotes in cr" for connected-account jobs needs a rate; connected credits are never converted at `creditUsd()`.
3. The README is desktop-only. Step 1 holds the phone floors on the chrome at 360/390/844 with the panels as overlays; hosted legacy bodies keep their own sizes until their step rebuilds them.

Local verification note: Playwright's bundled browser is not installed on the owner's Mac; the workbench config's `PW_CHANNEL=chrome` runs the specs on the installed Chrome. In a fresh worktree `tests/unit/screenplayOcr.spec.ts` (needs the generated `public/vendor/tesseract-*`) and one `localDatabaseClient` case (`spawn EBADF` under the app's sandbox) fail locally for reasons unrelated to this branch.

## 21 September (night) — owner decisions on the three open questions

1. **Names: "follow the design and retire the rule."** The Suites surface (`lib/shell`, `components/graphite`, `app/suites`) prints the design's names verbatim — `SUPERCOMPUTER`, `Moleculr Business Suite · Marketing Studio`, `Subatomik Viral Studio · Genjutsu`, and from step 2 the model sheet's real model and provider names. `tests/unit/noVendorNamesInUi.spec.ts` exempts those three directories and now guards the legacy screens only; it is deleted with them at the switch-over. The connected catalogue's neutral renaming (`lib/higgsfield-consumer/catalogue.ts`) is untouched here because the legacy screens and their specs still read it; the Suites model sheet reads real names in step 2.
2. **Price: "for now just keep 10 cents as 1 credit."** Connected-account jobs are quoted in cr at the same US$0.10 as everything else. This overrides binding rule 3 (connected credits are never converted) for now, by the owner's word; it is to be built behind one function so the rate can change.
3. **Google refusals: dropped** by the owner. Not being pursued.
## 21–22 September — Crew (branch `feature/crew`, not released)

Owner request, in chat: "build Crew from ~/Desktop/CREW_ADDENDUM.md, Grok test ceiling $2". The addendum and its prototype are filed at `design/particl-suites/CREW_ADDENDUM.md` and `Particl Crew.dc.html`. Crew is additive: a sixth header tab after Atomik (`/suites?view=crew&cp=room|members|sessions`), four new tables, `/api/crew/*`, and xAI as a vendor key. Studio, Gen, Business, Viral and Atomik are untouched apart from the tab and the three solution routes.

| What | Where |
| --- | --- |
| Pure core: role cards, the role-card template and the three phase instructions word for word, the prototype's two regexes, temperatures, caps, the round ceiling, minutes | `lib/crew/room.ts`, `lib/crew/context.ts` |
| Tables (workspace DB, created on first use) | `lib/crew/store.ts`: `crew_members`, `crew_sessions`, `crew_messages`, `crew_solutions` |
| Grok | `lib/crew/xai.ts`: `POST https://api.x.ai/v1/chat/completions`, model from `XAI_MODEL`, 45 s, one retry, `max_tokens` 220. Key = workspace's own or `XAI_API_KEY` via `lib/vendorKeys` (`xai` added); never sent to the browser |
| Orchestration and money | `lib/crew/round.ts`: Propose ∥ (cap 6) → Challenge ∥ → one Converge to the chair. **One metered event per round** (`engine: xai`), reserved at its ceiling, settled at the tokens reported; failed requests add nothing; a round that does not converge settles at zero and keeps its messages |
| Price | Rate = the live catalogue's entry for the model (it lists `grok-4.6` at $2 / $6 per M tokens) or `XAI_RATE_USD_PER_MTOK`; no price → no round. `quoteOnly` → `maxCredits`, like every paid text job |
| Routes | `sessions` (POST, GET, `quoteOnly`), `sessions/:id` (GET, PATCH), `sessions/:id/rounds` (SSE), `…/notes`, `…/minutes`, `solutions` (pin, remove), `solutions/:id/route` (brief, boards → revision-checked draft save; gen → text handed back), `members`, `status` (GET, Verify) |
| UI | `components/graphite/crew/*`, `app/crew.css`, `lib/crew/use-crew.ts`; Workspace › Engines gets an **xAI · Grok** row (Connect → the existing sealed keys route, Verify → model list only) |
| Tests | `tests/unit/crewRoom.spec.ts`, `tests/crew-workbench-api.spec.ts`, `tests/crew-workbench.spec.ts` (five viewports, phone floors) — all on the ENGINE_MOCK room, which speaks the prototype's canned lines |

Deliberate deviations from the addendum: completions are requested unstreamed so `usage` is always present and billable (each message still streams to the room as it lands); minutes download as Markdown rather than being filed into Assets; "Open in Gen" copies the solution and stores it as `particl-gen-preset` until the new Gen composer (branch `feat/suites-gen`) reads it.

Production facts checked 21 September: `XAI_API_KEY` and `XAI_MODEL` exist in Vercel **Production** only (not Preview, not local). The live Grok qualification therefore has to run on production after release, from the owner's signed-in session, inside the owner's stated $2 ceiling; one five-member round is expected to cost about $0.05.

## 21–22 September — Suites › Gen and the prompt enhancer (branch `feat/suites-gen`, not released)

Build step 2 of `design/particl-suites/README.md`, plus the owner's instruction of 21 September: "use higgsfield prompt enhancer for the gen section. unless directed otherwise to use either claude or open AI".

What Higgsfield actually publishes (all nine repos under github.com/higgsfield-ai were searched): no text-in / text-out enhancer. There is the `enhance_prompt` boolean a generation request carries (applied on their servers; the result carries `raw_data.params.enhanced_prompt`, which `lib/higgsfield-consumer/video-contract.ts` already reads), and the rule set their own agents write prompts by (`skills/higgsfield-generate/references/prompt-engineering.md`). So the **Higgsfield** provider is those published rules, run on the workspace's routed writer; it is the default (`promptEnhancer` setting). Claude and OpenAI write on their own model families and a chosen provider never silently becomes another.

| What | Where |
| --- | --- |
| Rules, `raw:` bypass, citation preservation (a rewrite that drops `@Image1` is refused, not repaired), writer choice | `lib/shell/enhancer.ts` |
| `POST /api/prompt/enhance { prompt, provider?, model?, mode, anchored?, editing? }` on the existing paid-text envelope: `quoteOnly` → `maxCredits`, one settled charge, Idempotency-Key replays | `app/api/prompt/enhance/route.ts` |
| The button's life: live quote on the button, press = approve that figure, Use this / Keep mine, Auto | `lib/shell/use-enhancer.ts` |
| Composer picks (ratio, resolution, per-second length), validated against the engine's own lists | `lib/workspace/composer.ts`, `use-composer.ts` |
| Gen view on the existing `useComposer` host: Video · Images · Audio (3D shown, disabled, with where 3D is made), model sheet (Studio engines · Higgsfield catalogue), reference well taking the Library's `text/plain` id, Results | `components/graphite/GenView.tsx` |

Not in this branch, and not faked: the Takes stepper (the host dispatches one job), `enhance_prompt: true` on catalogue jobs, 3D, and the Workspace › General enhancer selector (step 6). Known cost edge: a rewrite refused for dropping a citation has already been paid for by the time it is refused.

## 21 September — Crew live qualification (production, owner-approved ceiling US$2)

Run from the owner's signed-in Browser-pane session on www.particl.app (deployment of `a99399d`, Crew #279), project **Dune Studies**, the prototype's goal ("Open the film without dialogue and still make the product unmistakable inside the first four seconds."), Room reads Brief · Script · Boards, the default five seated, Producer in the chair, model `grok-4.6` on the production `XAI_API_KEY`.

| Fact | Value |
| --- | --- |
| Quote on the button | `Run round · up to $0.10` (legacy workspace: dollars, no credits) |
| Requests | 11 (5 Propose ∥, 5 Challenge ∥, 1 Converge) — all answered |
| Tokens | ≈13,450 in · 650 out |
| Settled | **$0.0308** (`crew_sessions.spend_usd`; one `xai` meter event), 31 % of the ceiling |
| Transcript shape vs prototype | Proposals 32–45 words, first person, all grounded in the Dune Studies brief (chrome sphere, Mira, ivory suit). Every challenge parsed `@Name —` into `↳ to` (Editor→Director, Producer→Editor, Designer→Editor, Director→Producer, DOP→Editor). Converge produced exactly three `n. Title — what we do` lines, parsed into three solutions. Same shape as the prototype's canned room. |
| Defect found | The SSE stream died mid-round (`ERR_HTTP2_PING_FAILED`) because the #280 production deploy cut over at that moment. The server finished and settled the round; the client said "network error" and did not re-read the room. Fixed on `fix/crew-stream-reread`: on a dropped stream the client re-reads the room and says so. |

## 22 September — FINAL_SPEC step 1: assets on every page (branch `feat/suites-01-assets`)

The owner's v3 brief (`design/particl-suites/FINAL_SPEC.md` — wins every disagreement; `CLAUDE_CODE_PROMPT_FINAL.md`; the updated `Particl Suites.dc.html` with the flair layer; `Particl Mobile.dc.html`). Order of work: 1 assets · 2 Business · 3 Viral · 4 Gen catalogue · 5 Skills + Workspace · 6 flair, then mobile. `MOBILE_ADDENDUM.md` is referenced by the brief but was not in the folder or the zip.

| What | Where |
| --- | --- |
| Library `+` sends the asset into the composer as a reference; the toast names the role (`harbour-plate.webp added as Image`) | `Library.tsx`, `lib/shell/reference-inbox.ts` (the letterbox between any page and the Gen composer), `GenView.tsx` |
| Every asset tile draggable (`text/plain` = asset id); drop targets: the Gen well, and a Rig row (a render dropped on a shot is filed on it through `PATCH /api/jobs/:id { shotId }`, mapped first if need be) | `Library.tsx`, `RigList.tsx`, `lib/shell/drop-targets.ts` |
| Right-click commands, all real: copy · cut · paste · move to… · delete · use as reference · recreate · open in Inspector · undo (20 deep). Duplicate is offered and says why it cannot (an original has one copy; a render's copy is a new render) | `lib/shell/assets.ts` (pure: capabilities, reasons, the prototype's toasts), `lib/shell/use-asset-actions.ts`, `SuitesShell.tsx` |
| Delete is soft for 30 days: `PATCH /api/jobs/:id { trashed: true|false }` hides a render and dates its cleanup row a month out (the existing sweeper honours `lease_until`); an upload is unfiled from the project and its original stays in All assets. ⌘Z restores either | `app/api/jobs/[id]/route.ts` |
| Cut here → paste in another project moves it (uploads: file + unfile; renders: `PATCH { projectId }` to the target's production). Move to… is the same through a picker | `use-asset-actions.ts` |
| Recreate (the menu's Retry, ⌘R, the Inspector) hands Gen the take's whole recipe by letter, so an open Gen takes it too: the typed words (`params.rawPrompt`), the credits that paid (a connected-account take stays on the account for the owner), model, aspect, size, length, Soul identity, references read again in order (the words renumbered to the survivors, @Image/@Video counted per kind as the engine counts them; the gone ones listed by their @tag), and the shot setup, which Gen writes into the words on request. A card says what was kept and what changed and why (the reason from the real state: changed here, not offered here now, Studio engines chosen, or the composer's own block), and a size the new engine lacks lands on the nearest one at or below the take's. Generate waits while the take's references or the account's identities are read, and while the words cite a reference that is gone; a Recreate clears any enhancement of the words it replaced. Undo puts the composer back; Generate prices it again. *Use settings only* keeps the person's words; *Copy prompt* copies the take's. `params.task` is an allow-list: a take from a tool Gen lacks (an edit, a template, a motion transfer, a dub, a trained identity's still, the account's marketing video, 3D) is blocked with the reason | `lib/shell/recipe.ts`, `lib/shell/recipe-setup.ts`, `lib/shell/reference-inbox.ts › sendRecipe`, `lib/workspace/composer.ts › recipe/restore`, `GenView.tsx`, `AssetInspector.tsx` |
| Inspector: a fixed 180px preview card, provenance (engine, prompt, made, settled / file, type, size, pixels, integrity) and the actions as buttons on the shell's own command path; hides via `×`, the page-head toggle (every width, lit when open) and ⌘J | `components/graphite/AssetInspector.tsx`, `Inspector.tsx`, `PageHead.tsx`, `lib/shell/state.tsx › runCommand` |

Not in step 1: Business/Viral media wells (those composers are steps 2–3), per-model reference roles (step 4 — today the role is Image/Video by kind).

Tests: `tests/unit/suitesAssets.spec.ts`, `tests/assets-trash-workbench-api.spec.ts` (real route, real tables: hidden, bytes kept, cleanup dated 30 days, restore), `tests/suites-assets-workbench.spec.ts` (five viewports).
## 22 September — FINAL_SPEC step 2: Business = Marketing Studio (branch `feat/suites-02-business`)

What the connected account actually offers was checked against its advertised toolset (`tests/fixtures/connected-tools-98.json`, 98 tools) and its saved catalogue entry for `marketing_studio_video` (`tests/fixtures/connected-models.json`): the account's `generate_video` takes the whole Marketing Studio contract as `params` (mode, product_ids, avatar_ids, hook_id, setting_id, ad_reference_id, medias with roles image · start_image · end_image, aspect, resolution, generate_audio, duration_range), and its own schema text says setup ids come from `show_marketing_studio`. There is **no** tool for the DTC Ads Engine (`dtc-ads generate`), ad formats, brand kits, or for creating products/avatars/ad references — those are CLI/REST flows. The app only talks to `mcp.higgsfield.ai`. So:

| What | Where |
| --- | --- |
| **Ads** rides the existing catalogue-generation route (`/api/higgsfield/consumer/generation`: quote → the exact price on the button → submit with that price → poll) with model `marketing_studio_video`. It validates every parameter against the live schema, imports reference stills before the quote, and refuses a moved price. Chips: Mode · Product (+ From URL… = Click-to-Ad) · Avatar · Hook · Setting · Ad reference · Aspect · Duration 15/30 s (clamped to the account's range, the clamped value shown) · Resolution · Audio; prompt + Enhance; a reference well whose roles cycle image → start_image → end_image | `components/graphite/business/BusinessView.tsx`, `lib/shell/business.ts` (pure rules and copy), `lib/shell/use-connected-job.ts`, `lib/shell/use-business.ts` |
| The two server rules, client and server: hook/setting only for `ugc, ugc_how_to, ugc_unboxing, product_review, ugc_virtual_try_on`; never with an ad reference. Disabled chips at 40 % with the reason, never hidden; picking a mode outside the family or an ad reference clears the other | `lib/shell/business.ts`, `lib/higgsfield-consumer/video-contract.ts` (`superRefine`) |
| `video-contract.ts` widened per §2.1 for the older marketing-video workflow too: `productIds | webProductIds` (never both), `avatars[{id,type}]`, `hookId`, `settingId`, `adReferenceId`, `medias[{id, role}]` ≤14, `productUrl`, duration ≥ 4, 1080p; `consumerVideoOriginalResult` recognises a job carrying exactly the ids/medias we sent and still refuses anything we did not send | `lib/higgsfield-consumer/video-contract.ts` |
| **Image ads** runs `marketing_studio_image` (aspect from its list, 1k/2k/4k, ≤14 stills; aspect auto needs a still; prompt or a reference). The page says the DTC Ads Engine is not offered by the account's tools | `BusinessView.tsx › ImageAdsView` |
| **Setup** reads `show_marketing_studio` by type when the account advertises it (`readConnectedPlannerReads`, tool added to the allow-list); otherwise each row type says so and names the CLI command. Every row opens a detail with Use in Ads / Use in Image ads, which pre-select in the composer | `lib/higgsfield-consumer/marketing-setup.ts`, `/api/higgsfield/consumer/video` `action: "setup"` (existing route, extended) |
| Business pages are the shell's own views (`own: true` in `lib/shell/ia.ts`); `marketing` stays the state page behind them | `lib/shell/ia.ts`, `SuitesShell.tsx` |

Decisions to note (the brief says decide and note): DTC (§2.2 format/brand kit/batch) and creating setup items (§2.3) are not wired because the account offers no tool for them; the pages say exactly that and take an id from the CLI where one exists. Tests: `tests/unit/suitesBusiness.spec.ts`, `tests/suites-business-workbench.spec.ts` (five viewports), and the existing consumer-video guards updated for the widened contract.

## 22 September — FINAL_SPEC step 3: Viral = Genjutsu (branch `feat/suites-03-viral`)

The existing `genjutsu-service` (`hf_mult_motion_control`, `hf_mult_replace_object`; quote → approve → submit → poll on `/api/higgsfield/consumer/genjutsu`) surfaced in the shell's own views; nothing in the service or its route changed.

| What | Where |
| --- | --- |
| Motion Transfer and Object Swap share one composer: exactly one source video 4–30 s at index 0 (a longer one is refused with its length), then up to 30 **ordered** reference images (↑ ↓ reorder; the order is the order sent), 480p/720p/1080p from the account's capabilities, an optional prompt with each page's own words | `components/graphite/viral/ViralView.tsx`, `lib/shell/viral.ts` (pure rules and the prototype's copy) |
| **Live estimate required**: the primary reads the account's quote for exactly the current input and wears it (`Transfer motion · 22 cr`); a missing, failed or expired estimate blocks submit with the reason inline, and the estimate is re-read when the input changes or expires. Submit carries the estimated job's id, wallet and exact credits | `lib/shell/use-viral.ts` |
| History = this project's Genjutsu results (from the route's GET): Recreate (the job's own inputs resolved against the Library and loaded into the composer, priced again), Compare (original and result on one clock, in a sheet), Send to Edit (selects the collected original and opens Studio › Edit) | `ViralView.tsx › HistoryView`, `CompareSheet` |
| Viral pages are the shell's own views (`own: true`) | `lib/shell/ia.ts`, `SuitesShell.tsx` |

Tests: `tests/unit/suitesViral.spec.ts`, `tests/suites-viral-workbench.spec.ts` (five viewports).

## 22 September — FINAL_SPEC step 4: Gen from the live catalogue (branch `feat/suites-04-gen`)

| What | Where |
| --- | --- |
| The Higgsfield group's chips come from each model's own catalogue entry, never a hard-coded list: aspect from `aspect_ratios`, resolution from the `resolution` parameter's options, **Length** as every second of a `duration_range` (Seedance 2.5: 4–30) or exactly the closed list (`durations`: Veo 3.1 4/6/8, Hailuo 6/10, Kling 5/10/15), roles from the media slots, `promptOnly` when the entry declares no slot (the well is hidden and the page says so), `enhanceable` when the schema declares `enhance_prompt` | `lib/workspace/composer.ts › ConnectedRow, connectedModels, secondsIn`, `use-composer.ts` (catalogue read carries the whole entry) |
| The quote carries the entry's settings as `parameters` (`aspect_ratio`, `duration`, `resolution` only where declared) and each reference's role (per-reference, cycled on the chip; the family's first role by default). The server already validates every parameter against the live schema and refuses out-of-range values; the account's `adjustments` still surface as `unapproved_adjustment` and are never auto-accepted | `use-composer.ts › connectedInput`, `GenView.tsx` |
| Enhancer passthrough (§4): Auto sends `enhance_prompt: true` for models whose schema declares it; a `raw:` prompt sends `false`, is never rewritten locally, and its prefix is stripped before it is sent. The footer says "enhanced on Higgsfield" when that applies | `use-composer.ts`, `GenView.tsx` |
| Model sheet rows: name · one line (the entry's description) · aspects · lengths · roles / prompt only · "enhances on the account" | `GenView.tsx` |

Not in this branch, noted for the next: showing the account's returned `enhanced_prompt` on the result card (the generic generation view does not carry it yet), the workflows (`reframe` → Deliver › Social cuts, `draw_to_video` → Astra › Draw to edit, `dubbing`/`voice-change` → Edit), Soul ID from Cast › Build identity, `brain_activity`, and the Takes stepper. Tests: `tests/unit/workspaceComposer.spec.ts` (catalogue mapping), `tests/suites-gen-catalogue-workbench.spec.ts` (five viewports).

## 22 September — FINAL_SPEC step 5: Atomik › Skills and the Workspace tabs (branch `feat/suites-05-skills-workspace`)

| What | Where |
| --- | --- |
| Atomik › Skills = the eight `higgsfield-ai/skills` packs, one row each with the prototype's line, the install command (copied on click) and **Install**, which opens the pack's folder in the public repo. Thinking-model choice stays in Atomik › Models | `lib/shell/skills.ts`, `components/graphite/atomik/SkillsView.tsx` (the shell's own view for `atomik/skills`) |
| Workspace tabs rebuilt in Graphite over the routes that already serve them — no tab links out to a legacy page: **General** (delivery format, cost approval and per-shot cap, the **prompt enhancer** selector Higgsfield · Claude · OpenAI with its note; Save → `PATCH /api/settings`, admins only, said so otherwise), **People** (`/api/team`: initials · name · email · last seen · clips · role pill, Promote / Unlock through `PATCH /api/team/:id`, *Invite · one-time link* through `POST /api/team` → `/invite/<code>`), **Plans & credits** (`/api/billing`: the 40px mono balance, the plan line, the real packs with bonus and what lands, statements from `/api/statements`), **Usage** (`/api/usage`: settled credits per engine as bars, failed renders not billed), **Engines** (`/api/workspaces/keys` rows with Connect / Replace key through the sealed `PUT`, plus the xAI · Grok row with Verify), **Security** (`/api/account/security`: sessions, two-step state, media access, audit; the one link off the shell is the account's own security page, where a password is typed) | `components/graphite/WorkspaceView.tsx` |

Decided and noted: the workspace name is read-only here (no rename route on the workspace); pack purchase is described, not faked (no checkout route in the app); per-vendor Verify exists only for xAI (the other vendors have no verify endpoint). Tests: `tests/unit/suitesSkills.spec.ts`, `tests/suites-workspace-workbench.spec.ts` (five viewports).

## 22 September — FINAL_SPEC step 6: the flair layer, then mobile (branch `feat/suites-06-flair`)

Additive only: `app/flair.css` is imported after `app/graphite.css` by `app/suites/page.tsx`; it defines no `--gx-*` token (a unit test enforces that) and keys on `.gx[data-view][data-suite]`.

| What | Where |
| --- | --- |
| Header 60px with two drifting blobs (blob A tinted per view — Studio blue, Business amber, Viral red, Atomik green, Gen/Crew violet, Workspace cyan), the 14px dot grid, the gradient baseline; breathing gradient mark; mono suite badge; avatar ring | `flair.css`, `Header.tsx` |
| Suite picker: glass track; each tab = glyph + label + 5px signature dot in the suite colour (Studio clapper · Gen spark · Business tag · Viral bolt · Atomik atom · Crew three agents round a chair); below 1180px the label clips (kept in the accessible name) and the icon stays | `components/graphite/icons.tsx` (the prototype's SVG paths, `SUITE_LOOK`), `Header.tsx` |
| Gradient primaries (34px page / 44px Gen), layered cards, glass segment tracks, gradient display titles, the stage/main/panel grounds, glowing running pill, Crew's violet badge | `flair.css` |
| Library › Tools: framed department cards with the glowing colour dot, count badge, tinted 36px tag tiles and trailing chevron in the cycle `#0A84FF, #BF5AF2, #FF9F0A, #30D158, #64D2FF, #FF453A`; tab icons (wrench · stack); the search magnifier; kind-dot filter chips (All = 3-stop gradient) | `Library.tsx`, `icons.tsx › DEPT_COLORS, KIND_DOT` |
| Project poster: 72×46 head tile / 56×36 switcher rows with the gradient, blurred colour signature, mono initials and film-strip baseline; sample palette for Dune Studies / Northline / Untitled, a stable hue for any other name | `ProjectHead.tsx`, `icons.tsx › posterOf` |
| Stage strip: the current page carries a glowing dot; the project head's "saved" dot; the Workspace balance in the title gradient | `StageStrip.tsx`, `ProjectHead.tsx`, `flair.css` |
| **Phone (< 768px)**, mirroring `Particl Mobile.dc.html`: glass tab bar Studio · Gen · Suites · Assets · More (glowing active tab; every tab is an existing shell route — Suites = the last non-Studio suite, Business until one is chosen; Assets opens the Library's Assets tab; More = Workspace); the header's suite tablist becomes the 4-up glass tabs with the glyph over the label; the project row is the poster pill + "saved · meta"; sheets rise from the bottom (26px top radius, handle, `om-up`); Gen's Generate is sticky above the bar with the blue glow; chips become pills | `components/graphite/TabBar.tsx`, `flair.css` |

Decided, not asked (the brief says decide and note): `MOBILE_ADDENDUM.md` was not in the folder, so the phone layer is the FINAL_SPEC §6 mobile paragraph plus what `Particl Mobile.dc.html` shows for the chrome; the prototype's phone IA (a Studio home of stage cards, per-stage card lists) is not rebuilt — the existing pages render inside the same chrome. The tab bar's 10.5px labels are 12px here (the phone floor the shell already enforces). The Rig list keeps its legacy 800px minimum width on phones and scrolls sideways (legacy `rig.css`, not a `--gx` surface). The Crew view inherits everything (badge, glyph tab, cards) and needed no change.

Tests: `tests/unit/suitesFlair.spec.ts` (fixed values, poster palette, no token redefinition), `tests/suites-flair-workbench.spec.ts` (desktop: aurora tint per view, glyph tabs, label clipping at 1100px with the name intact, tool groups, kind dots, poster tile; phone: tab bar routing and floors). The step 1–5 suites and Crew specs pass at all five viewports with the layer on.

## 22 September — the vendor-name guard retired (branch `chore/retire-vendor-name-guard`)

`tests/unit/noVendorNamesInUi.spec.ts` is deleted. The owner retired the never-name rule on 21 September when they chose the Suites design, which prints Higgsfield, Genjutsu and Supercomputer as the prototype does; #278 had only exempted the Suites paths. Item 5 of the 20 September rules above is therefore history for the Suites surface; nothing else in the tree depended on the guard.
## 22 September — Crew: minutes into Assets; the settlement rule in one place (branch `feat/crew-minutes-assets`)

| What | Where |
| --- | --- |
| **File minutes in Assets · free** beside Export: the session's minutes markdown goes through the existing chunked upload (`uploadToProject`), stored byte-identical and filed on this project, so it sits in the Library and Takes like any original | `lib/crew/room.ts › minutesFile`, `lib/crew/use-crew.ts › minutesAsFile`, `CrewView.tsx` |
| The round's money rule as a pure function: a chair that failed, or a room in which nobody proposed, settles at zero (messages kept, not billed, the note says so); only a converged round bills the tokens reported. The round used this rule already; it is now named and tested | `lib/crew/room.ts › settleRound`, `lib/crew/round.ts` |

Tests: `tests/unit/crewRoom.spec.ts` (+2), `tests/crew-workbench.spec.ts` (+1, five viewports).
## 22 September — Gen: the prompt the account rendered (branch `feat/gen-enhanced-prompt`)

When a connected entry enhances on the account (`enhance_prompt`, step 4), the account's status carries `params.enhanced_prompt`. It is now read from the same qualified evidence as the original (`consumerGenerationEnhancedPrompt`: sanitised, links omitted, 8000 cap, never from another job), kept on the completed job (`resultManifest.providerResult.enhancedPrompt`) and on the collected generation (`params.enhancedPrompt`, via the collector's new `enhancedPrompt` option — the marketing-video path passes its own), and shown: on the Gen results head once the take completes (*Enhanced on the account: …*), on the filed asset's description, and in the Inspector's provenance as **Enhanced** beside the prompt that was sent. Provenance only; it is never re-sent as input.

Files: `lib/higgsfield-consumer/{video-contract,generation-contract,generation-service,video-service,video-original,generation-client}.ts`, `lib/workspace/use-composer.ts`, `components/graphite/{GenView,AssetInspector}.tsx`. Tests: `tests/unit/connectedCatalogue.spec.ts` (+ evidence and client cases), `tests/suites-assets-workbench.spec.ts` (Inspector row).
## 22 September — Enhance: a refused rewrite is not charged (branch `feat/enhance-refuse-unbilled`)

`runPaidText` takes an `accept` verdict judged **before** the job settles. The enhance route passes `parseEnhanced`: a rewrite that dropped an `@name` citation, or an answer that is not a prompt, is saved (`paid_text_jobs.status='refused'`, the provider's real cost on the row and in `atomik_spend`) but the meter settles at zero — the workspace is not charged for text it cannot use, and the error says so (*… Nothing was charged.*). Nothing else reads `paid_text_jobs` statuses. Files: `lib/paidText.ts`, `app/api/prompt/enhance/route.ts`; test `tests/unit/paidEntryPoints.spec.ts` (+1).
## 22 September — the connected workflows on the Studio pages (branch `feat/suites-workflows`)

FINAL_SPEC §4 › Workflows, on the existing voice-tools route (`/api/higgsfield/consumer/audio-tools`: quote → the exact price → run → poll; a dubbed or reframed video is filed on the project, a report as a note) through the existing client (`components/suites/AtomikVoiceTools`) inside the shell's own frame:

| Where | Tool |
| --- | --- |
| Studio › Edit | **Dub** (`dubbing`), **Change voice** (`voice_change`) |
| Studio › Deliver | **Social cuts** (`reframe`, up to 60 s) |
| Studio › Astra | **Draw to edit** — the account does not advertise `draw_to_video`, so the card is disabled with that reason inline |
| Gen › Analysis tab | **Virality Predictor** (`video_analysis`, the account's report filed as a note; says *Video analysis is switched off for this platform* while `HF_CONSUMER_VIDEO_ANALYSIS_ENABLED` is unset) |

Each host reads only this project's saved jobs and the account's tool flags, and shows the one reason a tool cannot run (project · owner · connection → *Open Engines* · suspension · the flag), in `lib/shell/workflows.ts › workflowReason`. Files: `lib/shell/workflows.ts`, `components/graphite/tools/WorkflowHost.tsx`, `SuitesShell.tsx` (the page extras slot), `GenView.tsx` (Analysis tab), `app/graphite.css`. Tests: `tests/unit/suitesWorkflows.spec.ts`, `tests/suites-workflows-workbench.spec.ts` (five viewports).
## 22 September — Gen: takes per Generate (branch `feat/gen-takes-count`)

The prototype's stepper beside the primary (1–4). Each take is its own quoted job at the price shown — the button says `Generate 2 takes · 86 connected cr` (the take's price times the count), a price that moves on any take stops the rest with the notice, and the takes file into Takes as they land. Files: `lib/workspace/composer.ts` (`count`, `TAKES_MAX`, the label), `lib/workspace/use-composer.ts` (Generate loops the count), `components/graphite/GenView.tsx`, `app/graphite.css`. Tests: `tests/unit/workspaceComposer.spec.ts` (+1), `tests/suites-gen-catalogue-workbench.spec.ts` (the stepper and the label).
## 22 September — Gen: a Soul model carries a trained character (branch `feat/gen-soul-id`)

FINAL_SPEC §4 › Soul ID, the reuse half: a connected Soul model whose schema declares `soul_id` (Soul 2, Soul Cinematic) shows an **Identity** select of the account's trained characters, read through the generation route's new `characters` action (`show_characters`, the tool the planner already reads; `lib/higgsfield-consumer/characters.ts`), bounded and text-only. A pick becomes `parameters.soul_id` in the quote and moves the quote key; *No identity · prompt only* leaves it out; a character still training cannot be picked. *Build identity in Cast* opens Studio › Cast, where the existing identity panel trains one. The account's plan gate is not pre-checked: a quote the plan refuses surfaces as the quote's error inline, unbilled. Files: `lib/higgsfield-consumer/characters.ts`, `app/api/higgsfield/consumer/generation/route.ts` (action added), `lib/workspace/{composer,use-composer}.ts`, `components/graphite/GenView.tsx`. Tests: `tests/unit/connectedCharacters.spec.ts`, `tests/unit/workspaceComposer.spec.ts` (+1), `tests/suites-gen-catalogue-workbench.spec.ts` (+1, five viewports).
## 22 September — the phone's Studio home (branch `feat/suites-phone-home`)

`Particl Mobile.dc.html › STUDIO HOME`, the IA the flair step left out. Studio gains a `home` page (`lib/shell/ia.ts › withHome`: shares Brief's backing page, `own`, `phoneOnly` — never in the stage strip). The phone tab bar's Studio opens it; on a stage the header shows **‹ Studio** instead of the mark (phone only). The home carries the project's name in the gradient, **Up next** (the first shot without a render → Rig), the eight stages as cards with a live line and a status dot from the project itself (`lib/shell/studio-home.ts`: words in the brief and script, frames, identities and elements, shots and how many rendered, takes, clips, the delivery spec), and the recent takes (tap → Inspector; *All assets* → the Library). Files: `lib/shell/{ia,studio-home}.ts`, `components/graphite/mobile/StudioHome.tsx`, `components/graphite/{SuitesShell,StageStrip,TabBar,Header}.tsx`, `app/flair.css`. Tests: `tests/unit/suitesStudioHome.spec.ts`, `tests/suites-phone-home-workbench.spec.ts` (two phones + one desktop).

## 22 September — Business › Image ads: ad formats from the account's templates (branch `feat/business-ad-formats`)

FINAL_SPEC §2.2 › ad formats. The DTC Ads Engine itself (`marketing-studio dtc-ads generate`) is still not offered by the connected account's tools; the page says so. The **ad formats** are the account's Marketing Studio templates (UGC · product shots · motion · ads · posters · marketplace), which the app already reads and creates with through `/api/higgsfield/consumer/marketing-templates` (catalogue → pick → create at the quoted price, the same client the legacy Business page uses): an **Ad formats** section now sits under the Image ads composer, in the shell's frame. Brand kits and batch stay on the CLI. Files: `lib/shell/business.ts` (copy), `components/graphite/business/BusinessView.tsx`. Tests: `tests/suites-business-workbench.spec.ts` (the catalogue mocked, two cards listed).

## 22 September — the Suites shell is the site (branch `feat/suites-is-default`)

The switch-over (`lib/workspace/switchover.ts`, live since PR223's follow-up) sent the four old entry points (`/`, `/workbench`, `/atomik`, `/subatomik`) to the redesigned workspace at `/workspace` on desktops and kept phones on the old surfaces. Its target is now the Suites shell (`SHELL_PATH = "/suites"`) and phones switch too (`SHELL_ON_PHONES`; the shell has its phone layer and Studio home). The mapping is unchanged; `/workspace` stays reachable by URL; `?shell=legacy` still opens the old shell for one release. The gate's note reads *Opening Particl…*. Files: `lib/workspace/switchover.ts`, `components/switchover/SwitchoverGate.tsx`, `app/suites/page.tsx` (comment), `docs/workspace-switchover.md`. Tests: `tests/unit/workspaceSwitchover.spec.ts` (paths), `tests/workspace-switchover-workbench.spec.ts` (every old deep link lands in the shell on desktop and phone; the old Generate page folds into Agent). Also: the catalogue spec's role-cycling assertion now waits for the quote that carries the cycled role (a CI flake at 360 px).

## 22 September — the switch-over cookie carries the release (branch `fix/switchover-cookie-generation`)

A "previous workspace" choice remembered before the Suites cut-over (`particl_shell=legacy`, 30 days) kept a phone on the old site after it. The cookie is now `particl_shell_suites`: choices made before the cut-over no longer apply; a fresh `?shell=legacy` writes the new one and `?shell=new` clears it. File: `lib/workspace/switchover.ts`.

## 22 September — the connected account's developer API: a probe first (branch `feat/developer-api-probe`)

The Higgsfield CLI (the `@higgsfield/cli` binary, inspected as strings) talks to a REST gateway the account's MCP toolset does not expose: `https://fnf-api-gw.higgsfield.ai/fnf` with `/developer/v1alpha/marketing-studio/{products, avatars, hooks, ad-references, brand-kits, image-styles}` (the setup items the app could only read), `/developer/v2alpha/{images, videos, jobs, media, souls, account/balance, marketing-studio-v2/presets}`, and `dtc-ads generate` (model `dtc_ads`, `format_id` + `brand_kit_id`) — behind the same Clerk OAuth as the MCP (`clerk.higgsfield.ai`). What is **not** known is whether the grant this app holds (`resource` = the MCP, scopes `openid email offline_access`) is accepted by that gateway. So, before building on it: **Workspace › Engines › Connected account · developer API › Verify** — one free read of `/developer/v2alpha/account/balance` with the account's token, the answer said plainly (reachable with balance; refused: the gateway wants a token of its own; 404/429/HTTP n). Owner only, 12/min, never spends, no provider text surfaced. Files: `lib/higgsfield-consumer/developer-api.ts`, `app/api/higgsfield/consumer/connection/route.ts` (`POST {action:"developer-probe"}`), `components/graphite/DeveloperApiRow.tsx`, `WorkspaceView.tsx`. Tests: `tests/unit/developerApi.spec.ts`, `tests/suites-workspace-workbench.spec.ts`. If the probe is refused on production, setup-item creation and DTC ads need a developer token the account can issue (the CLI's `auth login` grant) — a re-consent flow for a second resource — before anything else is built.
## 22 September — the four remaining Studio stages in the shell's idiom; nothing without a workflow (branch `feat/suites-stage-views`)

Brief & Script, Boards, Astra 3D and Deliver are now the shell's own stage views (`components/graphite/StageView.tsx`, `own` in `lib/shell/ia.ts`): the intro, the five facts, the groups as framed cards in the department colours with a status dot each, and the stage's existing working tool beneath (BriefTool, BoardsTool, AstraTool, DeliverTool — untouched, mounted in `.pxw.gx-legacy.pxw-embed`). Every count is the project's own through the same `spec-cards` rules; the Inspector's SPECIFICATION table still reads them. Deliver › Social cuts and Edit › Dub · Change voice keep their workflow hosts above.

**Owner's rule, 22 September: a feature with neither an agentic nor an API workflow behind it is eliminated.** Applied: a stage card must open a tool or be performed by an Atomik plan (`workflowGroups`) — Astra's *Video upscale* / *Image upscale* cards and Deliver's *Social cuts* card (a description of the reframe host above it) are gone; Astra's *Draw to edit* card is gone (`draw_to_video` is not advertised by the account); Library › Tools derives from the same filtered cards (`lib/workspace/pages.ts › SPEC_GROUPS`); Gen's disabled *3D* tab is gone; Workspace › Plans no longer lists packs (no purchase route). Still to review under the rule, not changed here: Business › Setup's rows for item types the account cannot create (they read; creation is CLI-only), and the connected-account setup flows that need the developer API (below).

Tests: `tests/suites-stage-views-workbench.spec.ts` (five viewports), `tests/unit/suitesWorkflows.spec.ts`, `tests/unit/workspacePages.spec.ts`; workflows, shell, flair, workspace, Gen and assets specs re-run green.
## 22 September — Gen › Edit: Seedance Edit in the shell; the missing models, answered (branch `feat/gen-seedance-edit`)

The owner reported OpenAI models and Seedance 2.5 / 2.0 Edit missing from Gen. **Seedance Edit** was never a model: it is the `edit` task on the Seedance engines (`lib/tasks.ts`, `supportsTasks`), with its own working panel in the old Gen (`components/make/SeedanceEdit.tsx`). Gen now has an **Edit** tab hosting that panel in the shell's frame (`components/graphite/tools/SeedanceEditHost.tsx`: source clip, references, the vendor's trigger words, quoted and run on this workspace's credits), with an engine picker — 2.5, and 2.0 on the vendor guide's reading (`-1` duration for the 2.0 series), which is listed as **untested** in the picker and in `lib/models.ts`. **OpenAI image models (GPT Image 2)** are not a Gen engine in either shell: they exist only as a gateway catalogue entry for the planner (`lib/catalog.ts › FEATURED.image`) with no render adapter (`lib/engines/*` has google, byteplus, fal, elevenlabs, higgsfield, vercel — no OpenAI image). Adding one is a new paid integration (an OpenAI-billed image adapter with quote and meter) and needs a stated ceiling to qualify; not done here. Gen's Output strip wraps below 400px so its five tabs keep the thumb floor. Tests: `tests/suites-gen-workbench.spec.ts` (+1).
## 22 September — connected models read under their own names (branch `feat/retire-neutral-names`)

The owner asked where the OpenAI models were. GPT Image 2 was in Gen's connected catalogue all along — as "Forge Image 2": the catalogue reader still applied the never-name aliases (`lib/vendorNames.ts › neutralModelText`: Forge, Persona, Vista, Motion…) that the owner retired with the Suites design on 21 September, and it stripped the provider's own name. `displayName` now keeps a catalogue name as the account gives it — GPT Image 2, Higgsfield Soul 2.0, DTC Ads, Google Veo 3.1. The planner's thinking models already read as themselves (GPT 5.5 Pro, GPT-6 Astra, o3…; the allow-list carries the OpenAI family) and the enhancer's OpenAI provider is in Workspace › General. `lib/vendorNames.ts` stays for the copy of legacy screens. Test: `tests/unit/connectedCatalogue.spec.ts` (real names; the never-name assertion dropped).
## 22 September — Business › Image ads: the DTC Ads Engine, on the account's `ms_image` (branch `feat/business-dtc-engine`)

Step 2 (#283) said the DTC Ads Engine was not offered through the account's tools. It is — as a catalogue **model**, `ms_image` ("DTC Ads"), on the ordinary `generate_image` path, with `style_id` **required** (the ad format: `show_marketing_studio type=image_style`, no default), `brand_kit_id` (a completed kit folds logo, colours, fonts and tone into the prompt), `quality` low/medium/high (affects cost), `batch_size` 1–20 per job (cost scales), up to four `product_ids`, ≤14 reference stills, the entry's own aspects. Image ads now has an **Engine** picker — Marketing Studio Image (as before) or DTC Ads — and, on DTC, Style · Brand kit · Products · Quality · Batch, all read from the account (`image_style` joins the setup types), all carried in the quote through the existing generation route, which validates every parameter against the live schema. Rules in `lib/shell/business.ts › imageAdsBlock`. Files: `lib/shell/{business,use-business}.ts`, `components/graphite/business/BusinessView.tsx`, `app/api/higgsfield/consumer/video/route.ts` (the setup schema accepts every type). Tests: `tests/unit/suitesBusiness.spec.ts` (+DTC rules), `tests/suites-business-workbench.spec.ts` (+1: the quote carries style, kit, products, quality and batch).

## 22 September — the glass material on the desktop shell (branch `feat/glass-desktop`)

`design/particl-suites/` now carries the glass handoff (GLASS_SPEC.md wins on visuals and the mobile Home; FINAL_SPEC.md §1–5 unchanged; `Particl macOS 27.dc.html` / `Particl Mobile iOS 27.dc.html` are the click-through references). `app/glass.css` is one layer after `graphite.css`, `flair.css` and `crew.css`, loaded by `app/suites/page.tsx`: the `--gl-*` tokens, the wallpaper on the shell root, the toolbar (64px, radius 22), the stage capsule (48px), and Library · stage · Inspector as floating islands with 10px gutters in place of the hairline grid — each panel + `blur(40px) saturate(180%)` + the .14 edge + the specular top edge + the lift. Anything pressed is a capsule (header buttons, primaries, chips, tabs, pills, segment tracks and thumbs, menu and sheet rows, badges); boxes with content keep 12–16 (thumbnails and tag tiles 12, cards 14–16, Rig nodes 16); ⌘K, the model sheet, the context menu, popovers and the toast sit on `--gl-panel-2` over the `rgba(6,6,12,.45)` + `blur(18px)` scrim; below 1280 the Library and Inspector float as `--gl-overlay` islands inset 10px; the Rig canvas's nodes (`components/workspace/rig`) are glass with glass-cored ports. The header aurora reads at ~35 % / 28 % through the glass. One consequence of the islands: a `backdrop-filter` ancestor contains `position: fixed`, so Gen's model-sheet veil (rendered inside the stage island) covered only the stage — it now portals to the shell root (`GenView.tsx`), where the tokens still reach it, and the spec asserts the veil covers the window; the takes stepper and the billing line sit outside the sticky Generate block. `@supports not (backdrop-filter)` raises the panel alphas to .92 and drops the blur. Every `--gx-*` token stays; the layer writes only background, border, box-shadow, border-radius and backdrop-filter plus the island geometry the spec names — `tests/unit/glassCss.spec.ts` holds that line. The phone (GLASS_SPEC §3) is the next step; desktop rules sit above 768px, and the island geometry (the margins, gutters and heights) also asks for a fine pointer — a phone held sideways is ~390px tall and a coarse pointer, and the 36px the islands cost there left the Business composer with no stage to scroll (the 844×390 spec found it); it keeps the hairline grid under the glass until §3.

Tests: `tests/suites-glass-workbench.spec.ts` (1440 and, inside it, 1180), `tests/unit/glassCss.spec.ts`; the flair spec now expects the 64px toolbar; every Suites and Crew workbench spec re-run at 1440, 390×844 and 844×390.

## 23 September — the phone's Home and the glass shell on the phone (branch `feat/glass-mobile-home`)

GLASS_SPEC §3. The phone's Studio pages outside the strip are now two: `home` — the suite picker, "Where to?" — and `stages`, the Studio stage grid that used to be the home (`lib/shell/ia.ts › withHome`). `components/graphite/mobile/SuiteHome.tsx` renders the Home: the project's name as the eyebrow, the display title, six suite tiles (Studio · Gen · Business · Viral · Atomik · Crew, the prototype's lines verbatim, the suite colour as the icon tile and the glow) each with a live fact in mono — `n of 8 done` from the stage cards, `n rendering` / `<default video engine> ready` from the running pill, the Ads defaults (`UGC · 15 s · quoted in Ads` — the prototype's `40 cr` is sample data; a price appears only where a live quote exists), the Viral resolution, `n awaiting approval` from the current run, `n seats` from one free read of the Crew roster — and one 56px Assets row (`n in <project>`) that opens the Library's Assets tab. Nothing else on Home. The tab bar (`TabBar.tsx`) is Home · Gen · Suites · Assets · More; Home and the mark return to the Home; the Studio tile opens the stage grid with ‹ Home, a stage keeps ‹ Studio back to the grid (`Header.tsx`); the context badge reads HOME / STUDIO / ASSETS on the phone. `lib/shell/studio-home.ts › suiteTiles, assetsRowLabel` are pure.

Material (`app/glass.css`, phone block): the top bar is a glass island (margin `max(10px, safe-area)`, radius 24), the tab bar a floating glass capsule (`left/right 12 · bottom 22 · height 66 · padding 6`, the active tab a light pill), sheets rise on `--gl-sheet` with the 30px top radius over the scrim, every control a capsule, cards on the card gradient; every scroll region carries `padding-bottom: 110px` (the stage, the Workspace, the Library's tools and assets, the Inspector body, sheet lists, the Crew room and pages), and Gen's sticky Generate sits above the bar (`flair.css`) and is now only the button and its one-line foot — the takes stepper and the billing line moved out of the sticky block (`GenView.tsx`), because at 360×640 the taller block covered the whole composer. Tile layout lives in `flair.css` (`.gx-where-*`). Two repo floors held over the spec's numbers: the tab label stays 12px (the phone text floor; the spec says 10.5px) and the context badge is 12px on the phone. The top bar's first row is mark + badge, search, credits, avatar on one row at 360–390: the prototype's row has no search (its palette is desktop-only), the shell keeps ⌘K reachable as a round 44px button, so the wordmark yields to the badge on the phone. The strip is hidden on the two phone-only screens. Two CI findings, both fixed in the layer: Turbopack's CSS pipeline (Lightning CSS, which CI's `next dev` and the Vercel build both run; the worktrees run `--webpack`) turns a `backdrop-filter` + `-webkit-backdrop-filter` pair carrying the same `var()` into the `-webkit-` declaration alone, which Chromium ignores — the served CSS in CI showed it, and running Lightning CSS on the file reproduces it (0 unprefixed declarations before, 8 after) — so the layer now writes `backdrop-filter` unprefixed only; and every glass rule is scoped under `.gx` so the layer wins whatever order the bundler emits the sheets in. The glass specs read from the page whether the blur applies (or the `@supports` fallback fired) and assert accordingly.

Tests: `tests/suites-glass-mobile-workbench.spec.ts` (360×640, 390×844, and a 1440 guard), `tests/suites-phone-home-workbench.spec.ts` and the flair phone test rewritten for Home › Studio, `tests/unit/suitesStudioHome.spec.ts` (+ tiles and the Assets label), `tests/unit/glassCss.spec.ts` (+ the phone geometry selectors); every Suites and Crew workbench spec re-run at 360, 390, 844×390 and 1440.
## 23 September — the Rig canvas takes a Library drop (branch `feat/assets-rig-canvas-drop`)

FINAL_SPEC §1 step 1's last gap: a Library render dragged onto a Rig **canvas** node now files on that shot exactly as a drop on the list's row does — the same `text/plain` asset id, the same `fileOnShot` path (`lib/shell/drop-targets.ts › shotDropHandler`), the same toast (`<take> filed on <shot>`), the same undo (`⌘Z` unfiles), the same refusal for an upload ("Only a render can be filed on a shot. Use it as a reference instead."). The node lights while the asset hovers (`data-drop`, the accent outline in `graphite.css`). Only shot nodes take a drop; the old `/workspace` shell registers no handler and its canvas stays plain. `components/workspace/rig/RigGraph.tsx`.

Tests: `tests/suites-rig-canvas-drop-workbench.spec.ts` (1440, 1920); `tests/workspace-rig-workbench.spec.ts` and `tests/suites-assets-workbench.spec.ts` re-run green.
## 23 September — Business › Ads: the contract as the account's tool declares it (branch `feat/business-ads-contract`)

FINAL_SPEC §2.1 audited against the connected catalogue's own entry for `marketing_studio_video` (the `generate` tool's schema, mirrored in `tests/fixtures/connected-models.json`): the tool declares `resolution`, `generate_audio`, `mode`, `folder_id`, `width`, `height`, `avatar_ids`, `product_ids`, `assets`, `hook_id`, `setting_id`, `ad_reference_id`, the `medias` roles, the aspect list and the duration range — and nothing else. So on this path `avatar_ids` (a plain UUID array) is the right shape, and Click-to-Ad (`product: { url }`), `web_product_ids`, `specific_mode` / `storyboard_id` and `enhance_prompt` do not exist: they are the CLI's REST-gateway parameters, and the server refuses a parameter the schema does not name. The Ads composer's *From URL…* chip therefore never reached the account; by the owner's rule (no API workflow behind it → eliminated) it is gone, with a line under Product saying products are made in Setup once the developer API is verified in Workspace › Engines. `lib/shell/business.ts › NOT_ON_THIS_PATH` records the five names; `tests/unit/suitesBusiness.spec.ts` asserts none of them is ever sent. Everything else in §2.1 that the tool takes was already wired (#283, #296, #303).

What returns with the developer-API grant (`lib/higgsfield-consumer/developer-api.ts`, probe merged in #300): Setup-item creation (products fetched by URL, avatars, hooks, settings, ad references, brand kits) and, through it, Click-to-Ad as a product picked from Setup.
## 23 September — Gen: the named defaults (branch `feat/gen-task-defaults`)

FINAL_SPEC §3 › Defaults (SKILL.md): image → GPT Image 2.5, video → Seedance 2.5, audio → Seed Audio 1.0. `lib/workspace/composer.ts › DEFAULT_MODEL_PREFERENCE` names them by the catalogue's ids (with the workspace engines' ids for the same families) and `activeModel` picks the first the offered list carries when nothing is chosen — a pick still wins, and a list without the default falls back to its first as before. Nothing is invented: a default the account does not offer is not the default. Boards and Cast presets already seed Nano Banana 2 and Soul 2 (`lib/workspace/spec-cards.ts`); 3D and analysis are their own tabs and workflows, not composer types.

Tests: `tests/unit/workspaceComposer.spec.ts` (+ the connected list where the default is not first, a pick over the default, the fallback), `tests/suites-gen-catalogue-workbench.spec.ts` and `tests/suites-gen-workbench.spec.ts` re-run.

## 23 September — Cast › Build identity on the connected account (branch `feat/soul-id-build`, owner's ceiling US$5)

FINAL_SPEC §3 › Soul ID. Studio › Cast now opens with a *Build identity* card on the connected account (`components/graphite/tools/SoulIdHost.tsx`, mounted by `SuitesShell.tsx`): a name, Soul 2 or Soul Cinematic, five to twenty stills of the same person picked from this project's images (uploads and finished renders), the plan gate, one confirm that names the exact request (`Train Mira · Soul Cinematic · 5 stills`), and the account's own answer word for word. The account's existing Soul IDs are listed beneath with *Use in Gen* on the ready ones (a Gen preset on the matching Soul model). Blocked reasons are inline: connect the account · name it · pick 5–20 stills (n picked) · a paid plan is required (the account reads as Free). Every still is imported first (`media_import_url`, free); then `show_characters` is called once with `action: "create"`, the name, the type and the imported media (`lib/higgsfield-consumer/mcp.ts › createConsumerCharacter`) — never retried; a refusal keeps the account's reason, bounded and scrubbed, and spends nothing. The route (`/api/higgsfield/consumer/generation`) gains `characters-plan` (free read of `show_plans_and_credits`) and `characters-create` (render permission, 3/min).

**What is not there, and why:** the account offers no cost tool for training, so there is no quote on the button — the card says the account bills it at its plan's rate, and the owner's stated ceiling (US$5) is the price control for the live qualification. The tool's `action` vocabulary is not documented in the captured schema (`action`, `name`, `type`, `images`, `medias`, `soul_id`, `status`); `create` is the CLI's verb. The first live attempt on production, inside the ceiling, is the qualification: an accepted request lists the new Soul ID as *Training*; a refusal shows the account's words and costs nothing.

Tests: `tests/unit/connectedCharacters.spec.ts` (plan gate, reasons, reply parser), `tests/suites-soul-id-workbench.spec.ts` (1440 and 390, the route mocked).
## 23 September — Gen › Edit: a render with no recorded shape is measured, not refused (branch `fix/edit-source-dimensions`)

Found on production while qualifying Seedance 2.0 Edit under the owner's US$5 ceiling: every project clip — the two connected-account renders and the workspace render alike — was refused with "The source clip's dimensions or duration are unavailable. Upload the original clip so the edit can be quoted accurately.", although each one's length was known (4.04 s). The Edit task needs the source's ratio and length; a generation row only carries a ratio when its `params` recorded one, and connected-account renders record none. `lib/generationAdmission.ts` now does for Edit what Astra and Transform already do: when the ratio or the length is missing it reads the stored original once (`inspectOriginalVideo`, bounded by the row's bytes) and takes the shape from the file; a render whose original cannot be read is refused in the same words as before. No pricing changes: the quote is the same formula on the measured shape.

Tests: `tests/unit/generationAdmission.spec.ts` (+ a render with a length but no ratio quotes at the measured 720:1280; an unreadable one is still refused). The live qualification on production follows once this is released.

## 23 September — Particl lists only the Soul IDs it built; the planner stops reading the account's library (branch `fix/soul-id-particl-only`)

Owner's rule, in chat, 23 September: what is generated on higgsfield.ai (characters like Vanya and Aryan, trained on the site) is a separate library from Particl's; the two must not be cross-connected — Particl is a standalone generation platform and the connected account is its engine, not its library. #310 as landed listed the account's characters on the Cast card and in Gen's Soul-model picker, and Atomik's planner context read the account's characters, reference elements, recent generations and uploaded images. Now: `lib/higgsfield-consumer/character-records.ts` keeps Particl's own record of every Soul ID it asked the account to train (`higgsfield_consumer_characters`: soul_id, user, project, name, type); `connectedCharacters` intersects the account's list with that record, so the Cast card ("Built in Particl") and Gen's picker show only Particl-built identities, with the status the account gives them now. `lib/higgsfield-consumer/planner-reads.ts` no longer reads `show_characters`, `show_reference_elements`, `show_generations` or `show_medias` for Atomik's context — presets, voices, the balance and the plan remain (engine facts, not the owner's library). The build carries the project id into the record; nothing about the project is sent to the account.

Tests: `tests/unit/connectedCharacters.spec.ts` (+ the narrowing), `tests/unit/atomikConnectedPlanner.spec.ts` (the reads list), `tests/suites-soul-id-workbench.spec.ts` (copy).
## 23 September — Seedance 2.0 Edit live qualification (production, owner-approved ceiling US$5)

Run from the owner's signed-in session in the browser pane on www.particl.app (deployment of 81de0ae, #311), project **Dune Studies**, Gen › Edit, engine **Seedance 2.0**, source the workspace render "A chrome sphere rests on pale sand; the camera pushes in slowly." (4.04 s), direction "Turn the sand a deep rust red; keep the sphere, the camera move and the audio exactly as they are."

| Fact | Value |
| --- | --- |
| Before #311 | every project clip refused: "The source clip's dimensions or duration are unavailable" |
| Quote on the button after #311 | **$0.74** (Review edit cost → Generate edit · $0.74) |
| Submitted | 11:00 AM · Takes: "Edit queued. Its progress is in Your takes." · Inspector: engine `dreamina-seedance-2-0-260128`, status rendering, Not settled |
| Finished | ≈15 minutes later · the take reads **$0.75 · Review**; the Inspector's Settled figure is **$0.747** (the tile rounds), status *review*, the output playable and downloadable — 15 % of the ceiling |
| Copy retired | `SeedanceEditHost.tsx` no longer calls Edit on 2.0 untested; the Gen spec asserts the qualified note |

What the run confirms: the Edit task on 2.0 quotes, admits and settles on the same path as 2.5; the measured-source fix (#311) is what made the quote possible on a render with no recorded ratio. The output's look is the owner's call to review in Takes.
