# Native dispatch

Background work — stills and audio (`render/requested`), video submission (the same event with `kind: "video"`), native Blender renders (`astra-blender/render.requested`), long-form development (`workbench/development.requested`) and the wiring probe (`worker/probe`) — is dispatched by the app itself on Vercel. Inngest is no longer required; it is an optional mode a deployment opts into.

## Modes

`lib/dispatch.ts` decides once, from the environment, and every sender agrees:

| Mode | When | What happens |
| --- | --- | --- |
| `native` | `NODE_ENV=production` (or `DISPATCH_MODE=native`), **and** `CRON_SECRET` is set, **and** an origin exists (`APP_ORIGIN`, else `https://$VERCEL_PROJECT_PRODUCTION_URL`), **and** `ENGINE_MOCK` is not `1` | The request POSTs the event to its own `/api/worker` route; the worker answers 202 and runs the handler in its own function lifetime. |
| `inngest` | `DISPATCH_MODE=inngest` **and** both `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are set | Events go to Inngest, which calls `/api/inngest` back with retries and step memoisation, as before. A half-configured Inngest (one key, or keys without the opt-in) is never used. |
| `inline` | Everything else: local development, mocks, a production deployment missing its secret or origin | No queue. The request runs the work in its own `after()` continuation, exactly the fallback that always existed. |

`/api/health` reports the decided mode as `dispatch.mode`. `/api/inngest` answers 503 with the same mode whenever it is not `inngest`. Production readiness (`lib/deploymentReadiness.ts`, `/api/admin/readiness`) requires `CRON_SECRET` and `APP_ORIGIN`; the Inngest keys are only required when `DISPATCH_MODE=inngest`.

Environment, names only:

- `CRON_SECRET` — bearer for `/api/worker` and `/api/cron/sync`. Required for native mode.
- `APP_ORIGIN` — the canonical HTTPS origin the worker route is reached at (falls back to Vercel's production URL).
- `DISPATCH_MODE` — optional: `native`, `inngest`; anything else means "decide from the rest".
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — only read in `inngest` mode.

## The 202 hand-off

`POST /api/worker` (`app/api/worker/route.ts`, `maxDuration = 300`) with `Authorization: Bearer $CRON_SECRET` and a JSON body `{ id, name, data }`, where `name` is one of the four event names and every `data` value is an identifier matching `^[A-Za-z0-9_-]{1,120}$`. Prompts, URLs and credentials never travel in the event; the handler reads them from tenant storage.

The route, in order:

1. 401 without the exact bearer (outside production, a deployment with no secret accepts unauthenticated calls, like the cron route).
2. 400 for a malformed body.
3. 503 `{ maintenance: true }` while the recovery fence is `closed` **or** `draining` — no new work starts during a checkpoint; the cron drains what was accepted before it.
4. Acquire a concurrency slot (below). Refused → **202 `{ accepted: false, reason: "busy" }`** and nothing runs. The job stays queued; it is not run inline.
5. Reserve a recovery continuation (`reserveRecoveryContinuation("worker", …)`) so the fence accounts for the work, then respond **202 `{ accepted: true }`** and run the handler in `after()`.

The sender (`dispatchEvent`) treats any 202 as "taken": it POSTs with a 5-second `AbortSignal.timeout`, returns `true` only for HTTP 202, and never throws. 401, 500, a timeout or a missing origin/secret all return `false`, which every caller already handles as "no queue reachable — run inline in my own `after()`" (`enqueueRender`, `enqueueAstraRender`, `enqueueDevelopmentJob`).

A busy 202 is therefore the one case where nothing runs immediately: the render row keeps its `render_dispatches` intent, the Astra job stays `queued`/funded, and one of two things picks it up — the slot chain when a worker of the same kind and workspace finishes, or the ten-minute cron (`retryRenderDispatches`, `recoverAstraRenders`). Development jobs are not chained; their owner's resume request or the next continuation advances them.

## Concurrency: 4 platform-wide, 2 per workspace

`lib/worker-slots.ts` keeps a `worker_slots` table in the platform database (created by the platform bootstrap): one row per running worker invocation with `kind`, `workspace_id`, `job_id` and `expires_at`. `acquireSlot` runs in one write transaction: purge expired rows, count live rows for the kind (limit **4**) and for the kind + workspace (limit **2** — the same numbers Inngest's `concurrency` enforced), refuse if either is reached, refuse if the same `job_id` already holds a live slot (already running), otherwise insert. The route releases the slot in `finally`; a function that dies frees its slot by expiry (TTL 330 s, past Vercel's 300 s ceiling).

After a successful release the route makes **one** best-effort chained dispatch for the same kind and workspace: for renders, the oldest reserved-but-unclaimed generation with a `render_dispatches` row and no provider handle; for Astra, the oldest queued funded job. Whatever the chain misses, the cron finds.

## Retry semantics: single attempt plus the cron

Native mode is **one attempt per event**. There is no retry loop in the worker; the durable retry is the ten-minute recovery cron, which already reconstructs and re-sends unclaimed dispatches and reconciles everything else.

What differs from Inngest, per handler (`lib/worker-handlers.ts`):

- **Render, still/audio.** Inngest ran `produce` and `record` as separate memoised steps with three retries and an `onFailure` that failed the row. Natively:
  - `produce` throws → `failJob(genId, message)` immediately (the terminal state Inngest reached after its retries, without the retries). `produce` itself is already idempotent: the permanent `paidClaim` and the stored `params.$.producedOutcome` mean a repeated call never pays twice.
  - `seal` throws **after** `produce` returned → the vendor has been paid and the bytes stored. The handler does **not** call `produce` again and does **not** fail the row. `produce` has already persisted its outcome on the row as `params.$.producedOutcome`; the handler adds `params.$.sealFailed` with the message and leaves the row at `running`. The cron's `syncPending` (`lib/jobs.ts`, the `params.producedOutcome` branch) then seals it from the stored outcome. This is the exact case Inngest's step memoisation covered; the produce-once guarantee now comes from the row, not from the queue.
  - A row that is already terminal, or gone, is skipped (`loadJob` returns null) — at-least-once delivery does nothing twice.
- **Render, video.** `submitVideoRow`; a throw ends the dispatch with `failVideoDispatch` (a paid claim or known handle is never replaced or refunded).
- **Astra Blender.** `runAstraRender` then `reconcileAstraRender`, unchanged. Only the permanent queued→starting claim can purchase compute, so a duplicate or repeated delivery cannot start a second VM.
- **Development.** Phases run back to back inside one invocation until the job is done or waiting, or until ~240 s of wall time have elapsed; the remainder is re-dispatched to a fresh invocation with a phase-keyed id (`development-<jobId>-phase-<n>`) under the same reservation. A phase whose saved result is awaiting ledger settlement stops the invocation; only recovery touches it. A started phase with an unknown outcome is never resubmitted.

## Turning Inngest off (or on)

Off — either of:

- remove `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from the project, or
- set `DISPATCH_MODE=native` (keys may stay; they are ignored),

then redeploy. `/api/inngest` will answer 503 "dispatch is native", the Inngest dashboard will show the app as unreachable (expected), and nothing else changes: the same handlers run behind `/api/worker`.

On — set `DISPATCH_MODE=inngest` with both keys present and redeploy. The functions in `lib/workers.ts` and `lib/workbench/development-worker.ts` register with their original ids, triggers, concurrency and retries.

## Verifying in Vercel logs

For one render on a native deployment, the request logs show, in order:

1. the request that admitted the job (`POST /api/generate`, `/api/audio/...`, the Astra render route, …),
2. **`POST /api/worker` → 202** from the app's own origin, within the same second,
3. in that worker invocation's function logs, one line `{"level":"info","event":"worker.finished","name":"render/requested","ok":true,"durationMs":…}` when the handler ends (`"ok":false` with `level:"error"` if it threw; the line carries no ids, prompts or URLs).

A `POST /api/worker → 202` whose body was `accepted:false` is followed by no `worker.finished` line; the job is picked up by a later chain or cron run. If step 2 never appears, the deployment is not in native mode — check `dispatch.mode` on `/api/health` and the readiness `jobs` check — and the render ran on the request's own inline `after()`, as before.

The wiring probe can be sent by hand: `POST /api/worker` with the bearer and `{ "id": "probe-<n>", "name": "worker/probe", "data": { "workspaceId": "<isolated probe workspace>", "probeId": "<8–100 chars>" } }`; its receipt is read from `/api/admin/readiness` as before.
