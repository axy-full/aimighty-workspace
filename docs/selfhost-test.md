# Self-hosted test address (Coolify on the build server)

Status: prepared 7 Oct 2026 on branch `ops/selfhost-test-address`. **Files only**: nothing here has been built in Docker (the preparing machine has none), and nothing in Vercel, Cloudflare, DNS, Turso, hPanel or Coolify has been touched. The owner runs every step below.

This is the first half of SOW Phase 3 step 3 ("P4 beside Vercel"): the same app, a build of `main` plus these files (branch `ops/selfhost-test-address`), running at a **test address** next to the live Vercel site. Coolify runs on the same server as the build tools, behind its Traefik proxy, and the test address is Coolify's free generated `sslip.io` address, so **there is no DNS or Cloudflare step at all**. It is not the cutover. Production DNS does not move.

> **LOUD WARNING: databases.** The test address must point at **STAGING databases, never production.** A copy of the platform database and of one or two workspace databases made for this purpose. The older runbook (handover Part C, step 11 of P4) said staging may share the live database; that is **not** what this test does. Reasons: the test host has different `CREDIT_USD` handling during the switchover, it can create workspace databases through the Turso API, and a mistake would write rows into live customer data. If there is no staging copy yet, stop at "Before you start".

> **LOUD WARNING: nothing may spend.** `ENGINE_MOCK=1` on the test address, always. Do not enter real engine keys there unless a later gate says so.

## What is in the branch

| File | What |
|---|---|
| `ops/selfhost/Dockerfile` | Multi-stage, Node 24 (bookworm-slim), `npm ci`, `next build` with standalone output, non-root user (uid 1001), port 3000, HEALTHCHECK on `/api/health`. |
| `.dockerignore` (repo root) | Keeps `.git`, `.env*`, docs, tests, design, `node_modules` out of the build context. At the repo root because that is where every builder looks for it. |
| `next.config.ts` (one line) | `output: "standalone"` only when `NEXT_OUTPUT=standalone`. The Dockerfile sets it. **Vercel never sets it, so Vercel builds are unchanged.** |
| `ops/selfhost/cron-sync.mjs` | The scheduled task's script: calls `/api/cron/sync` with the bearer secret read from the container env. Copied into the image at `/app/cron-sync.mjs`. |
| `ops/selfhost/smoke.sh` | Read-only curl checks (see "Smoke test"). |
| `ops/selfhost/proposed/proxy-site-loop.patch` | A proposed fix for a real defect found while testing (see "Findings"). Not applied. |
| `docs/selfhost-test.md` | This file. |

The existing `app/api/health/route.ts` is used for the health check; no product code was added.

The `postinstall` (`scripts/copy-pdf-worker.mjs`, `scripts/copy-ocr-worker.mjs`) runs inside `npm ci` in the image's first stage, and the resulting `public/vendor/*` is copied into the build and run stages. `smoke.sh` checks that a worker file is served.

## Findings (read before building)

These came from a real local standalone build (Turbopack, no secrets) started with `node .next/standalone/server.js`.

1. **The build needs no secrets.** `next build` with only `ENGINE_MOCK=1 NEXT_TELEMETRY_DISABLED=1` succeeds. `release/1`'s `prebuild` (`scripts/ops/preview-seed.cjs`) runs inside `npm run build`; it needs **no secrets here**: it only acts on a Vercel preview build (`VERCEL_ENV=preview` plus `SUPER_ADMIN_EMAIL`) and otherwise prints `skipped (VERCEL_ENV is not set)` and touches no database. Never set `VERCEL_ENV` on this host.
2. **Home page redirect loop (signed-out visitors).** On a self-hosted Next server, `/`, `/pricing`, `/studio`, `/business`, `/viral`, `/atomik`, `/workspace` answer `308 -> /` forever for anyone without a session cookie. Cause: `proxy.ts` rewrites those paths to `/site/...`, and on a self-hosted server the rewritten request passes through the proxy again, where the "`/site` is internal, redirect to the real path" rule fires. Vercel does not re-enter the proxy, so the live site is fine. Proposed fix (tested locally against `main`'s proxy: `/`, `/pricing`, `/studio` all 200, `/site` still redirects; the patch file is re-based on `release/1`'s proxy with the same logic, not re-built): `ops/selfhost/proposed/proxy-site-loop.patch` (a marker request header set on the rewrite and checked by the redirect rule). This is product code on the public site; the owner decides. Until it is merged, `smoke.sh` will **fail its "home /" check** on the test address, correctly.
3. **Sign-in and every form post answer 403 behind a proxy.** `lib/auth.ts` (the `withTenant` origin check, about line 251 on `release/1`) compares the browser's `Origin` header with `new URL(req.url).origin`. On a self-hosted Next server that URL is built from the listen address (`http://localhost:3000`), not the public host, so it never matches `https://test.<domain>`. (Vercel's Next build turns on an internal `trustHostHeader` setting by itself; it is not a public option and cannot be set from `next.config.ts`; it is dropped by the config schema, tried and confirmed.) This is the same blocker recorded in handover Part C ("the sign-in fix inside Docker"). Proposed fix, **not applied and not tested** (sign-in code, owner-gated; an attempt to edit it here was refused by the permission system, which is right): also accept `Origin` equal to `APP_ORIGIN` when that variable is set, in `withTenant`. Until then, the test address works for **signed-out pages and read-only checks only**; no one can sign in there. That is enough for the smoke test and for judging speed and the look of the public pages.
4. **Health is 503 until storage is configured.** `/api/health` reports `storage: "missing"` in production unless `BLOB_READ_WRITE_TOKEN` or `STORAGE_BACKEND=r2` (+ R2 names) is set, even with a healthy database. The public answer carries no secrets (ok, mock, dispatch mode, database ok, storage ok), and no commit sha (that appears only to signed-in callers, as `VERCEL_GIT_COMMIT_SHA`, which is `local` on this host).
5. **`HOSTNAME=0.0.0.0` is set in the image** so the container listens on all interfaces. Coolify does not need a port mapping; it proxies to 3000.
6. **Dispatch.** With `DISPATCH_MODE` unset in production, background work is handed to `APP_ORIGIN/api/worker` (native mode), i.e. out through the public address and back. On the test address this is harmless under `ENGINE_MOCK=1`. Self-hosted Inngest comes in P4.
7. **Workspace databases on disk.** If the Turso API variables are set, new workspaces create real Turso databases in the organisation. Do **not** set `TURSO_API_TOKEN` / `TURSO_ORG` on the test address unless they point at the staging organisation or group.

## Before you start (owner)

- [ ] A **staging copy** of the platform database and the workspace databases you want to look at (with its token). Not production.
- [ ] A **staging Blob store** (its read/write token). Not the live store.
- [ ] Vercel's staging/preview environment values open in another tab (you copy values yourself; they never go into chat, the repo or a note).
- [ ] The Coolify project (one empty project) is open on this machine.

## Platform settings checklist

| Setting | Value |
|---|---|
| Source | Public repository, URL `https://github.com/axy-full/aimighty-workspace`, branch **`ops/selfhost-test-address`** (main plus these files, so "a build of main") |
| Build pack | **Dockerfile** |
| Base directory | `/` (repo root, so the build context contains `package.json`) |
| Dockerfile location | `/ops/selfhost/Dockerfile` |
| Ports exposes | `3000` |
| Domain | The free generated `sslip.io` address Coolify proposes (see step 4); no DNS record |
| Health check | Enabled. Path `/api/health`, port `3000`, method GET, expected status `200`, start period 40 s. (The image also has its own HEALTHCHECK.) |
| Persistent storage | One volume, destination `/app/.data` (see Storage) |
| Resource limits | Memory `4g`, CPUs `2` (the build needs more than the runtime; this machine also runs the other lanes' builds, so deploy when it is quiet) |
| Build variables | Tick **Build Variable** only on `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (baked in at build). Nothing secret is a build variable. |
| Auto deploy | **Off** (deploy by hand) |
| Scheduled task | `cron-sync`, see below |

## Scheduled jobs

`vercel.json` defines exactly one cron, and the test address runs it.

| Vercel cron | Schedule | Purpose | Test address |
|---|---|---|---|
| `GET /api/cron/sync` | `*/10 * * * *` | The platform heartbeat: reconciles every workspace (pending render sync, held jobs, training identities, storage sizes, deletion retries, expired upload reservations, pipeline and canvas wake-ups, recovery drain) and records its last-run heartbeat that `/api/health` (signed in) reports. | Runs every 10 minutes as a Coolify scheduled task, inside the app container. |

Setup (Coolify: the app, **Scheduled Tasks**, **+ Add**; menu names as best known, check the labels on your version):

| Field | Value |
|---|---|
| Name | `cron-sync` |
| Command | `node /app/cron-sync.mjs` |
| Frequency | `*/10 * * * *` |
| Container | leave empty (the app has one container) |
| Timeout | 300 seconds if the field exists (the route may run up to 300 s) |

Why a script and not `curl`: the Node slim image has no curl, and Coolify wraps the command in its own shell quoting, which breaks a long `node -e "..."` one-liner. `/app/cron-sync.mjs` (source `ops/selfhost/cron-sync.mjs`) uses Node's built-in fetch to call `http://127.0.0.1:3000/api/cron/sync`.

The header is the one the route checks (`app/api/cron/sync/route.ts`): `Authorization: Bearer <CRON_SECRET>`. The script reads `CRON_SECRET` from the container's own environment, so the value is never typed into the task and never printed. Without the header the route answers 401 (which `smoke.sh` relies on). Exit codes: 0 for a 2xx answer, 1 for a 401 or an error, 2 if `CRON_SECRET` is not set in the container.

Checked locally against the standalone server: with the right secret the script prints `cron-sync: 200` and exits 0; with a wrong one `cron-sync: 401` and exit 1; with none, exit 2.

After the first run, open the task's execution log in Coolify and look for `cron-sync: 200`. Because the staging copy may also be served by a Vercel preview, tell the owner if two heartbeats would run against the same staging database; the leased heartbeat is built for that, but it is the owner's call.

## Storage: what is written, and where

| What writes | Where it goes | Persistent volume needed? | Test address |
|---|---|---|---|
| Media: renders, uploads, thumbnails, stills, audio, 3D files (`ws/<workspace>/...`), platform assets, pending upload chunks | Vercel Blob (`BLOB_READ_WRITE_TOKEN`, default), R2 (`STORAGE_BACKEND=r2` + `R2_*`), or local disk (`STORAGE_BACKEND=local`) | No on Blob or R2. **Yes on local** | **Staging Blob store.** Never the live store, nor the live R2 bucket |
| Local generations `/app/.data/generations`, uploads `/app/.data/uploads`, chunks `/app/.data/chunks`, platform assets `/app/.data/platform` | Container disk | **Yes: volume at `/app/.data`** (only used on the local backend, and as scratch) | Mount the volume anyway: it costs nothing and a restart keeps scratch |
| Platform database | Turso (`PLATFORM_DATABASE_URL`, fallback `TURSO_DATABASE_URL`), or a local file under `.data` if neither is set | Only if the local file is used | **Staging Turso** |
| Workspace databases | One Turso database each; or files under `WORKSPACE_DB_DIRECTORY` (default `.data`) when no Turso API is configured | Yes for files: `/app/.data` (or the folder named by `WORKSPACE_DB_DIRECTORY`, which must then be a volume path) | **Staging Turso**; do **not** set `TURSO_API_TOKEN`/`TURSO_ORG` so nothing gets created |
| Next build output and caches | `/app/.next` inside the image | No (rebuilt on every deploy; image is read-only after build) | n/a |
| Everything else (sessions, ledger, settings, heartbeat) | In the databases above | n/a | Staging Turso |

Blob versus R2 for the test: keep the **staging Blob store** for this first test. One thing changes at a time (the host), nothing needs copying, and rollback is trivial. R2 comes with P3 (`docs/r2-migration.md`), needs its own **test** bucket and CORS for the test address, and should only be used here if P3 has passed its gate. Nothing is switched by this branch.

## Environment variable names (one list)

Names only; the owner copies values from Vercel's **staging/preview** environment into the app's Environment Variables in Coolify. Found by searching `process.env.` and `env.` across `app/`, `lib/`, `scripts/`, `mcp/`, `proxy.ts`, `instrumentation.ts`, `next.config.ts`; `vercel.json` sets none.

Column **STAGING**: "YES" means the value must be a staging value on the test address; "set" means a fixed value for this test.

| Name | Required? | Purpose | STAGING / value |
|---|---|---|---|
| `ENGINE_MOCK` | Required | `1` makes every engine call a mock so nothing spends | set: `1` |
| `APP_ORIGIN` | Required | Canonical origin for links and the worker hand-off | set: the generated sslip.io address |
| `NEXT_PUBLIC_APP_URL` | Required | Same origin for the browser build (**build variable**) | set: the generated sslip.io address |
| `APP_URL` | Required | Same origin, read by some server code | set: the generated sslip.io address |
| `PLATFORM_DATABASE_URL` | Required | Platform database | **YES: staging Turso** |
| `PLATFORM_AUTH_TOKEN` | Required | Token for it | **YES: staging** |
| `TURSO_DATABASE_URL` | Required | Fallback database URL some code reads | **YES: staging Turso** |
| `TURSO_AUTH_TOKEN` | Required | Token for it | **YES: staging** |
| `KEYRING_SECRET` | Required | Decrypts stored workspace keys and database tokens (30+ characters); must be the value that sealed the staging copy; never rotate; stop if blank | the staging copy's own value |
| `SESSION_SECRET` | Required | Signs session cookies | fresh value (test sessions must not work on production) |
| `CRON_SECRET` | Required | Bearer secret for `/api/cron/sync` and `/api/worker`; the scheduled task reads it from the container | fresh value |
| `SUPER_ADMIN_EMAIL` | Required | Who may use platform admin routes | same as Vercel |
| `BLOB_READ_WRITE_TOKEN` | Required (on Blob) | Media storage token | **YES: staging Blob store** |
| `STORAGE_BACKEND` | Optional | `blob`, `r2` or `local`; unset means Blob when the token is set | unset or `blob` |
| `CREDIT_USD` | Required | Dollar value of one credit, **must be `0.10`** on the new host | set: `0.10` |
| `PAYMENT_PROVIDER` | Optional | Leave **unset** (means `manual`: requests are queued, no card is charged). Never `stripe` on the test address | set: unset or `manual` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Do not set | Live payments must be off | **not set** |
| `TURSO_API_TOKEN`, `TURSO_API_URL`, `TURSO_ORG`, `TURSO_GROUP` | Do not set | Would create real workspace databases | **not set** |
| `RESEND_API_KEY`, `RESEND_BASE_URL`, `MAIL_FROM` | Optional | Email; leave unset so the test sends no mail | not set |
| `DISPATCH_MODE` | Optional | `native` is the production default (hand-off to `APP_ORIGIN/api/worker`); `inngest` needs the two keys below | unset |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Optional | Only for `DISPATCH_MODE=inngest` (self-hosted Inngest is P4) | not set |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | Optional | R2 adapter, only with `STORAGE_BACKEND=r2` | a **test** bucket, if ever |
| `WORKSPACE_DB_DIRECTORY` | Optional | Folder for file-based workspace databases | unset (`.data`) |
| `CREDIT_PACKS`, `CREDIT_MARGINS`, `SIGNUP_CREDITS`, `PLATFORM_ALLOWANCE_USD`, `ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD`, `BLOB_USD_PER_GB_MONTH`, `BLOB_USD_PER_GB_TRANSFER` | Optional | Pricing, caps and cost display | same as Vercel |
| `RIG_AGENT_ENABLED`, `LEGACY_WORKSPACE_NAME` | Optional | Feature switch; the original studio's name | same as Vercel |
| `LIVEBLOCKS_SECRET_KEY` | Optional | Live board collaboration | same as Vercel, or unset |
| `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | Optional | Web push | unset |
| Engine and assistant keys and switches: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROMPT_MODEL`, `ANTHROPIC_PROMPT_EFFORT`, `AI_GATEWAY_BASE_URL`, `GATEWAY_PROMPT_MODELS`, `REFINE_PROVIDER`, `HF_API_KEY_ID`, `HF_API_KEY_SECRET`, `HF_CREDENTIALS`, `HF_CREDENTIALS_PREVIOUS`, `HF_CREDENTIAL_ALIASES`, `HF_POOL_SIZE`, `HF_POOL_WORKSPACE_SHARE`, `HF_CONSUMER_CLIENT_ID`, `HF_CORRELATION_HEADER`, `HF_CINEMA_STUDIO_ENABLED`, `HF_CONSUMER_VIDEO_ANALYSIS_ENABLED`, `HF_SOUL_CHARACTER_ENABLED`, `HF_SOUL_CHARACTER_USD_720P`, `HF_SOUL_CHARACTER_USD_1080P`, `GEMINI_BASE_URL`, `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`, `ARK_BASE_URL`, `ARK_TEXT_MODEL`, `XAI_BASE_URL`, `XAI_MODEL`, `XAI_RATE_USD_PER_MTOK`, `FAL_*`, `ELEVEN_*`, `ASTRA_BLENDER_*`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_OIDC_TOKEN` | Do not set | **No engine keys are needed**: `ENGINE_MOCK=1` answers every call. Real keys would mean real spend | **not set** |
| `AIMIGHTY_URL`, `AIMIGHTY_TOKEN`, `PARTICL_URL`, `PARTICL_TOKEN` | Do not set | Client settings for the MCP and rehearsal scripts | not set |
| `NODE_ENV`, `PORT`, `HOSTNAME` | Do not add | Set by the image (`production`, `3000`, `0.0.0.0`) | n/a |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` | Never set | Vercel sets these itself; on another host they change behaviour (and `VERCEL_ENV=preview` would let `prebuild` touch databases) | **not set** |

Used only by scripts and CI, not by the running app: `PARTICL_BACKUP_*`, `PARTICL_ALLOW_STAGING_REHEARSAL`, `TURSO_CLI`, `CI_DEV_SOURCE_MAPS`, `WARM_BUDGET_MB`, `WARM_CAP_MB`, `PW_*`, `PWTEST_SHARD_WEIGHTS`, `GITHUB_*`, `RUNNER_TEMP`, `PHASE`.

## Smoke test

`ops/selfhost/smoke.sh <base-url>`: curl only, every request a GET. It never signs in, never posts, never calls a route that spends.

| Check | Expect |
|---|---|
| `/` | 200 (redirects followed, at most 3) |
| `/login` | 200 |
| `/api/health` | 200 and `"ok":true` |
| A `/_next/static/...js` file from the page | 200 |
| `/vendor/tesseract-7.0.0/worker.min.js` | 200 (proves the postinstall copy is in the image) |
| `/api/me`, `/api/projects` signed out | 401 each |
| `/api/cron/sync` with no header | 401 (proves `CRON_SECRET` is set) |
| Security headers on `/login` | frame DENY and a content policy |
| Any 5xx | none |

It accepts an `http://` or `https://` base URL. It prints each time and exits 0 only if all pass. Validated here against a local standalone server of this branch (merged with `release/1`; `localhost`, dummy storage and cron values only so health could read ok): 9 of 10 pass; `home /` fails with too many redirects (finding 2), which is the defect it is there to show.

## Click by click (owner)

Menu names are for current Coolify v4 as best known; a label marked (unsure) may read a little differently on your version.

1. **Open the project.** Coolify, **Projects**, open the one empty project, then its environment (usually `production`).
2. **New resource.** **+ New** (unsure: it may read "Add New Resource"), then **Public Repository** (the repo is public, so no GitHub App is needed). Repository URL: `https://github.com/axy-full/aimighty-workspace`. Click **Check repository**. Server: the localhost server (this machine). Continue.
3. **Build settings.** Branch: `ops/selfhost-test-address`. **Build Pack: Dockerfile**. **Base Directory:** `/`. **Port (Ports Exposes):** `3000`. Continue (or Save). On the next page, in **Configuration, General**, set **Dockerfile Location:** `/ops/selfhost/Dockerfile`. Save. Do **not** deploy yet.
4. **Domain.** In **Configuration, General, Domains**, Coolify has already generated an address of the form `http://<random>.<server-ip>.sslip.io`. Keep it (it is free and needs no DNS). Copy the exact text; this is the **test address**. If your version offers a "Generate Domain" button (unsure), use it. Note that it may be `http://`, not `https://`: that is fine for a smoke test, and `smoke.sh` accepts either.
5. **Environment variables.** **Configuration, Environment Variables**, **Developer view** (unsure: sometimes a toggle at the top). Add the names from the table above: every row marked Required, with values copied from Vercel's staging/preview environment where it says "same as Vercel" and **staging** values where it says STAGING. Set `ENGINE_MOCK=1`, `CREDIT_USD=0.10`, and set `APP_ORIGIN`, `APP_URL` and `NEXT_PUBLIC_APP_URL` to the test address from step 4. On `NEXT_PUBLIC_APP_URL` tick **Build Variable** (unsure: shown as a "Build Variable?" checkbox). Check: the databases and the Blob store are staging, `KEYRING_SECRET` is not blank, no `STRIPE_*`, no `TURSO_API_*`, no `VERCEL*`, no engine keys. Save.
6. **Health check.** **Configuration, Healthcheck** (unsure): enable, path `/api/health`, port `3000`, method GET, return code `200`, start period 40 seconds. Save.
7. **Storage and limits.** **Configuration, Persistent Storage, + Add**: volume mount, name `selfhost-data`, destination path `/app/.data`. Then **Resource Limits**: memory `4g`, CPUs `2`. Make sure **Auto Deploy** is off.
8. **Deploy.** Click **Deploy**. Watch **Deployments, Logs**. The first build takes several minutes. The step "npm run build" prints `preview seed: skipped (VERCEL_ENV is not set)`; that is expected and touches no database. It passes when the log ends with the container started and the health check going green. If it fails, copy the last 30 lines to Claude (no variable values are printed by the build).
9. **Smoke test.** From a shell on this machine, in the repo: `bash ops/selfhost/smoke.sh <test address from step 4>`. Expected today: **`home /` FAILS** (the signed-out redirect loop, finding 2), everything else passes. If anything else fails, that is news; send the output.
10. **Scheduled task.** **Configuration, Scheduled Tasks, + Add**: name `cron-sync`, command `node /app/cron-sync.mjs`, frequency `*/10 * * * *`, save, then run it once by hand if the page has a run button (unsure), and read its log for `cron-sync: 200`.
11. **Stop or roll back.** Nothing live is affected. Coolify, the app, **Stop** (or Delete in Danger Zone). To keep the settings and just pause the heartbeat: Scheduled Tasks, disable `cron-sync`. Vercel and particl.si are untouched throughout.

## Gates still ahead before any cutover (SOW section 4)

1. **P2 finish:** Coolify keys saved, origin certificate, dashboard domain, GitHub App, Cloudflare-only firewall, real visitor addresses (the sign-in lockout depends on it), outside monitor, VPS snapshots.
2. **P3 media:** R2 switched on (`/api/health` says r2-configured), media domain with signed links, thumbnails and posters; Blob downloads near zero.
3. **P4 beside Vercel:** the fixes above (findings 2 and 3, plus the visitor-address header, `APP_ORIGIN` helper, 300-second cap, background work sent to the container's own address); self-hosted Inngest sized for 1,000 jobs with per-plan limits (Invite 2, Studio 5, Agency 15, Production 50); `staging.<domain>` with all 12 smoke checks (those include sign-in and a paid run, which need the fixes first). This test address is only the first, read-only part.
4. **P5 cutover:** only after the 1,000-job load test passes on staging; `CREDIT_USD` is 0.10 on Coolify and the credit switchover is done on Vercel first; the already-converted database is the one copied; cron moved (Vercel's cron disabled once the VPS task has run clean); rollback is one DNS change; two weeks of watching; then Blob retired and exposed keys rotated.
5. **P8 many clients:** worker container, legacy-path guard, load test, error tracking.

Remotion is not part of any of this.
