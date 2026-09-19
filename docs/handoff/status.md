# Particl status of record

Updated 19 September 2026. This file is the running handover: what is released, what was verified and how, and what is next. It supersedes the status sections of older handover documents where they differ. Claims are limited to what was observed; "released" means the commit is serving www.particl.app, not that every path has been exercised live.

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

- **Inngest is kept.** Replacing it with a Turso jobs table plus the existing cron saves nothing today and removes what the audit relies on: off-request dispatch (no 300 s request ceiling for a 180 s paid VM), retries, and the platform-wide 4 / per-workspace 2 concurrency on native renders. The inline `after()` + cron path already exists as the degraded mode. Revisit if the Inngest bill exceeds roughly $50/month or the marketplace organisation cannot be recovered.
- **Cloudflare R2 is planned, not started.** Zero egress removes both transfer lines only if private downloads redirect to short-lived signed URLs instead of streaming through functions. Sequence: backups and alerting first, then R2, then long-form mastering (so masters never migrate twice). Trigger: sustained egress above ~300 GB/month or mastering becoming the next item. The owner creates the account, bucket and scoped token and stores them in Vercel; the adapter goes behind `lib/storage.ts` with dual-read during cutover and SHA-256 verification of the copied originals.
- The Vercel CLI on the development machine lost its token on 19 September (auth file emptied at 10:51, not by this work); deployment checks fall back to the signed-in browser session until `vercel login` is run again.
- Stale pull requests from before the takeover remain open: #123–#131 (SOW surfaces, ark-video era) and dependabot #135–#141. They are not part of this line of work; close or park them explicitly.



## Next work, in order

1. Locate the Inngest organisation that owns the Vercel marketplace installation (the one with the 4 September keys) and confirm `Render Astra Blender` there; registration itself is already evidenced by the deploy-time PUT 200 in Vercel logs. Decide what to do with the empty `SensAI Studios LLP` organisation.
2. Done 19 September (PR194–PR199) except: `recoveryDrain` coverage for the Astra branch; a Settings card to save a workspace OpenAI key (BYOK precedence exists only via API today); the staged whole-screenplay analysis.
5. Done 19 September on the legacy workspace (see above); repeat on a non-legacy workspace once one exists, to exercise credit debiting.
6. Backups and recovery: activate the backup workflow (environment, secrets, one manual capture, freshness), escrow `KEYRING_SECRET`, add an alerting channel and a paid-dispatch kill switch, then measure RPO/RTO on a staging restore.
7. Long-form mastering design and host decision (needs a spend decision), then OCR durability and multilingual qualification, then provider qualification under explicit ceilings.

Design decisions awaiting the owner: which palette declaration is the approved desktop appearance; whether the suite dock has replaced the supplied mobile tab-bar navigation; the exact suite tab labels.
