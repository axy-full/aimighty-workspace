# Particl status of record

Updated 18 September 2026 (evening). This file is the running handover: what is released, what was verified and how, and what is next. It supersedes the status sections of older handover documents where they differ. Claims are limited to what was observed; "released" means the commit is serving www.particl.app, not that every path has been exercised live.

## Released

| Item | Value |
| --- | --- |
| Released main | `d4a68a729c546638ad5cb3bf2f340ce60f5c0c04` — squash of [PR192](https://github.com/axy-full/aimighty-workspace/pull/192) "Add Astra Blender Studio and direct OpenAI integration" |
| Production deployment | `dpl_3JYXuZJg5ut6RkuRGjwVfA9Sdufv` (READY; `/api/health` reports commit `d4a68a7`, `mock:false`, region `bom1`) |
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
| `/api/inngest` unsigned GET | 401 `{"message":"Unauthorized"}` — this is the Inngest SDK 4.19.0 refusing an unsigned request, not the app's 503 "not connected" body, so both Inngest keys are present. **Function registration of `astra-blender-render` is not yet confirmed**: confirm in the Inngest dashboard (Vercel integration) that the production app lists `Render Astra Blender` alongside `Worker probe` and `render`. The in-app worker probe cannot be used from the legacy workspace (`lib/workerProbe.ts:81`). |

Not verified: a live OpenAI → proposal → native render → storage → settlement flow. That requires an explicitly approved spending ceiling (≈$0.10 compute per render at the documented iad1 card, plus one GPT-6 Astra proposal at its quoted credits) and should run in a non-legacy internal workspace so credit settlement is exercised.

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

## Next work, in order

1. Confirm `Render Astra Blender` in the Inngest dashboard; if absent, resync the app from the dashboard and re-check. Record the result here.
2. Post-release hardening PR (no behaviour change for users): gate per-poll Astra recovery on pending jobs; unit test that `functions` registers `astra-blender-render` with its trigger, concurrency and retries; cover the `astra_render_` branch of `lib/recoveryDrain.ts`; add `astra_render_jobs` to the backup preflight; fix the dead `workbench-1024x768` project name in `tests/suite-navigation-workbench.spec.ts`; make generation DELETE honour the captured scope.
3. Direct OpenAI follow-ups: scope the `/v1/models` filter to language models; unit tests for `/api/openai/status` and the catalog intersection; a Settings card to save a workspace OpenAI key (BYOK precedence exists only via API today).
4. Disclose Atomik-crew screenplay truncation in the quote and response, then plan the staged whole-screenplay analysis.
5. One approved paid Astra qualification in a non-legacy internal workspace (ceiling stated and approved first).
6. Backups and recovery: activate the backup workflow (environment, secrets, one manual capture, freshness), escrow `KEYRING_SECRET`, add an alerting channel and a paid-dispatch kill switch, then measure RPO/RTO on a staging restore.
7. Long-form mastering design and host decision (needs a spend decision), then OCR durability and multilingual qualification, then provider qualification under explicit ceilings.

Design decisions awaiting the owner: which palette declaration is the approved desktop appearance; whether the suite dock has replaced the supplied mobile tab-bar navigation; the exact suite tab labels.
