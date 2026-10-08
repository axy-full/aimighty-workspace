# Self-hosted staging address and cutover runbook (Coolify on the build server)

Status: prepared 7 Oct 2026, updated the same night with the owner's answers (staging address, Cloudflare, build paths, proxy timeouts, cutover order). **Files only**: the image has not been built in Docker here (the preparing machine has none); the standalone Next build was built and run locally, and nothing in Vercel, Cloudflare, DNS, Turso, hPanel or the platform has been touched. The owner runs every step below. **Nothing in the cutover checklist happens without the owner's "go".**

This is the first half of SOW Phase 3 step 3 ("P4 beside Vercel"): the same app, a build of `release/1` (which now carries these files), running at the **staging address `https://staging.particl.si`** next to the live Vercel site. Coolify runs on the same server as the build tools, behind its Traefik proxy. **Owner action:** the owner and his advisor create the Cloudflare DNS record for `staging.particl.si` and add the domain in Coolify. (`sslip.io`, Coolify's free generated address, was the earlier fallback and still works if the record is not ready.) Staging is not the cutover: production DNS does not move until the checklist in "Cutover order" is run.

> **LOUD WARNING: databases.** The staging address must point at **STAGING databases, never production.** The staging set the Vercel preview runs on (see below). The older runbook (handover Part C, step 11 of P4) said staging may share the live database; that is **not** what this test does. Reasons: the test host has different `CREDIT_USD` handling during the switchover, it can create workspace databases through the Turso API, and a mistake would write rows into live customer data. If you don't have the Preview staging values, stop at "Before you start".

> **LOUD WARNING: a platform copy names workspace databases.** The platform database stores each workspace's own database address (`workspaces.db_url`) and its sealed token. A plain copy of production's platform database therefore still points at the **production** workspace databases, and with production's `KEYRING_SECRET` the test host could open them. The scheduled `cron-sync` reconciles every workspace it finds, so it would write into live customer data.
> - Use the **staging set the Vercel preview already runs on** (the Preview environment's database values), not a fresh copy of production.
> - **Never put production's `KEYRING_SECRET` on the test host.** Use the Preview environment's value. If you are not sure the Preview keyring differs from production's, stop and ask: `scripts/ops/prepare-restore.mjs` repoints every workspace at new databases but re-seals with the **original** keyring, so it does not solve this on its own.
> - Before turning on `cron-sync`, run the check in step 9b: every workspace address must be a staging host.

> **LOUD WARNING: nothing may spend.** `ENGINE_MOCK=1` on the staging address, always. Do not enter real engine keys there unless a later gate says so. No live Stripe either.

## What is in the branch

| File | What |
|---|---|
| `ops/selfhost/Dockerfile` | Multi-stage, Node 24 (bookworm-slim), `npm ci`, `next build` with standalone output, non-root user (uid 1001), port 3000, HEALTHCHECK on `/api/health`. |
| `.dockerignore` (repo root) | Keeps `.git`, `.env*`, docs, tests, design, `node_modules` out of the build context. At the repo root because that is where every builder looks for it. |
| `next.config.ts` (one line) | `output: "standalone"` only when `NEXT_OUTPUT=standalone`. The Dockerfile sets it. **Vercel never sets it, so Vercel builds are unchanged.** |
| `ops/selfhost/cron-sync.mjs` | The scheduled task's script: calls `/api/cron/sync` with the bearer secret read from the container env. Copied into the image at `/app/cron-sync.mjs`. |
| `ops/selfhost/smoke.sh` | Read-only curl checks (see "Smoke test"). |
| `ops/selfhost/proposed/proxy-site-loop.patch` | Withdrawn: the loop it targeted was not reproduced (see "Findings" 2). Kept only for reference; do not apply. |
| `docs/selfhost-test.md` | This file. |

The existing `app/api/health/route.ts` is used for the health check; no product code was added.

The `postinstall` (`scripts/copy-pdf-worker.mjs`, `scripts/copy-ocr-worker.mjs`) runs inside `npm ci` in the image's first stage, and the resulting `public/vendor/*` is copied into the build and run stages. `smoke.sh` checks that a worker file is served.

## Findings (read before building)

These came from a real local standalone build (Turbopack, no secrets) started with `node .next/standalone/server.js`.

1. **The build needs no secrets.** `next build` with only `ENGINE_MOCK=1 NEXT_TELEMETRY_DISABLED=1` succeeds. `release/1`'s `prebuild` (`scripts/ops/preview-seed.cjs`) runs inside `npm run build`; it needs **no secrets here**: it only acts on a Vercel preview build (`VERCEL_ENV=preview` plus `SUPER_ADMIN_EMAIL`) and otherwise prints `skipped (VERCEL_ENV is not set)` and touches no database. Never set `VERCEL_ENV` on this host.
2. **Home page redirect loop: not reproduced (withdrawn 7 Oct).** An earlier local run reported signed-out `/` looping with 308s. A full retest found no loop on `main`, this branch or `release/1`: with `next start` and the standalone server, any bind, any `APP_ORIGIN`, and forwarded headers, signed-out `/`, `/pricing` and `/studio` answer 200 in one pass, and `/site/pricing` answers one 308. If the staging address shows a loop, it comes from a layer in front of the app (Traefik, Cloudflare SSL mode or a domain rule): run `curl -sIv --max-redirs 0 https://<staging address>/` and send Claude the `location`, `server` and `via` lines (never the hostname). The proposed patch is not needed.
3. **Sign-in behind the proxy: fixed on `fix/r1-signin-behind-proxy` (Opus PASS).** Before the fix, every origin check compared the browser's `Origin` with the server's internal address, so sign-in and every form post answered 403. With the fix, the host sets `SELFHOST_BEHIND_PROXY=1` and the checks accept only `APP_ORIGIN` (exact match; Host and forwarded headers are never trusted; ignored on Vercel). Sign-in also needs **https**: the session cookie is Secure, and browsers drop it over plain http.
4. **Health is 503 until storage is configured.** `/api/health` reports `storage: "missing"` in production unless `BLOB_READ_WRITE_TOKEN` or `STORAGE_BACKEND=r2` (+ R2 names) is set, even with a healthy database. The public answer carries no secrets (ok, mock, dispatch mode, database ok, storage ok), and no commit sha (that appears only to signed-in callers, as `VERCEL_GIT_COMMIT_SHA`, which is `local` on this host).
5. **`HOSTNAME=0.0.0.0` is set in the image** so the container listens on all interfaces. Coolify does not need a port mapping; it proxies to 3000.
6. **Dispatch.** With `DISPATCH_MODE` unset in production, background work is handed to `APP_ORIGIN/api/worker` (native mode), i.e. out through the public address and back. On the staging address this is harmless under `ENGINE_MOCK=1`. Self-hosted Inngest comes in P4.
7. **Workspace databases on disk.** On a production-mode host with no Turso API variables, `lib/provision.ts` refuses to create new workspaces (only the house workspace on `TURSO_DATABASE_URL` works; `WORKSPACE_DB_DIRECTORY` is unused). If the Turso API variables are set, new workspaces create real Turso databases in the organisation. Do **not** set `TURSO_API_TOKEN` / `TURSO_ORG` on the staging address unless they point at the staging organisation or group.

## Staging now (7 Oct)

The owner has created the staging app on the platform: branch `release/1`, Dockerfile build, Dockerfile location `/ops/selfhost/Dockerfile`, on a **temporary sslip.io `https` address** (never write that address in the repo or any public place: it contains the server's IP). `staging.particl.si` replaces it later (see click-by-click step 4). While on the sslip.io address, `APP_ORIGIN`, `APP_URL` and `NEXT_PUBLIC_APP_URL` must be **exactly that sslip.io https address** (not `staging.particl.si`). Moving to `staging.particl.si` means changing the three values **and rebuilding**, because `NEXT_PUBLIC_APP_URL` is fixed at build time. Before any scheduled task is added, run the two read-only checks in step 9b (keyring fingerprint, workspace hosts).

## Before you start (owner)

**Current plan:** staging starts empty with fresh secrets (see "Staging test: fresh empty databases"). The checklist below is the older Preview-set route, **only if the Preview keyring is ever known**; with fresh databases only the staging storage item applies.

- [ ] The **staging databases the Vercel preview runs on** (Preview environment values: platform database URL and token, and its `KEYRING_SECRET`). Not production, and not a plain copy of production's platform database (see the warning at the top).
- [ ] You know the Preview `KEYRING_SECRET` is **not** production's. If unsure, stop.
- [ ] A **staging Blob store** (its read/write token). Not the live store.
- [ ] Vercel's staging/preview environment values open in another tab (you copy values yourself; they never go into chat, the repo or a note).
- [ ] The Coolify project (one empty project) is open on this machine.

## Build paths: Dockerfile or Railpack

`main` was smoke-built with **Railpack** on the server and served 200; it is stopped until the hotfixes land. Both paths are valid; pick one per app and keep it.

| | Dockerfile (`ops/selfhost/Dockerfile`, on `release/1`) | Railpack |
|---|---|---|
| Repo change needed | the self-host files on main (step 2e) | the self-host files on main (step 2e); the build itself needs nothing else |
| Node version | Node 24, fixed in the Dockerfile | Railpack's default Node is 22 and the repo has no `engines`, `.nvmrc` or `.node-version`, so **always set `RAILPACK_NODE_VERSION=24`** (Railpack also reads `.node-version`, `.nvmrc` and `engines.node`; the older Nixpacks name was `NIXPACKS_NODE_VERSION`). Verify the variable name on the Railpack page for your version |
| Output | standalone server, non-root, HEALTHCHECK in the image | `next build` then `next start` (no `NEXT_OUTPUT`); same port 3000 |
| Scheduled task command | `node /app/cron-sync.mjs` | `node /app/ops/selfhost/cron-sync.mjs` (the repo is kept under `/app`; verify the working directory of the container; the script must be on the branch built, see cutover step 3) |
| Build variables | `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` only | same; the Node variable above is a build variable |

Everything else in this file (variables, health check, volume, smoke test) is the same for both. Do not mix: if staging is on one path, build production the same way, so what was tested is what ships.

## Platform settings checklist

| Setting | Value |
|---|---|
| Source | Public repository, URL `https://github.com/axy-full/aimighty-workspace`, branch **`release/1`** (it carries the Dockerfile and these files; the same Dockerfile works on main once the hotfixes land). See "Build paths" below for Railpack as the alternative |
| Build pack | **Dockerfile** (or Railpack, see "Build paths") |
| Base directory | `/` (repo root, so the build context contains `package.json`) |
| Dockerfile location | `/ops/selfhost/Dockerfile` |
| Ports exposes | `3000` |
| Domain | `https://staging.particl.si` (owner and advisor create the Cloudflare record, then add the domain in Coolify; see step 4) |
| Health check | **Leave the platform's own check off** and rely on the image's HEALTHCHECK (it uses Node's fetch). The platform's check may run `curl` or `wget` inside the container, and the `node:bookworm-slim` image has neither, so it would report the app unhealthy; or install curl in the image. Confirm on staging which works. A Railpack image may differ (it may have curl): check there. |
| Persistent storage | One volume, destination `/app/.data` (see Storage) |
| Resource limits | Memory `4g`, CPUs `2` (the build needs more than the runtime; this machine also runs the other lanes' builds, so deploy when it is quiet) |
| Build variables | Only `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` are build variables (baked in at build). Coolify may tick **Build Variable** ("available at build time") on every new variable by default: **untick it on every other variable**. A secret marked as a build variable reaches the build environment and the image history, and lets the build reach the database. |
| Auto deploy | **Off** (deploy by hand) |
| Scheduled task | `cron-sync`, see below |

## Scheduled jobs

`vercel.json` defines exactly one cron, and the staging address runs it.

| Vercel cron | Schedule | Purpose | Staging address |
|---|---|---|---|
| `GET /api/cron/sync` | `*/10 * * * *` | The platform heartbeat: reconciles every workspace (pending render sync, held jobs, training identities, storage sizes, deletion retries, expired upload reservations, pipeline and canvas wake-ups, recovery drain) and records its last-run heartbeat that `/api/health` (signed in) reports. | Runs every 10 minutes as a Coolify scheduled task, inside the app container, **only after the step 9b check passes**. Off until then. |

Setup (Coolify: the app, **Scheduled Tasks**, **+ Add**; menu names as best known, check the labels on your version):

| Field | Value |
|---|---|
| Name | `cron-sync` |
| Command | `node /app/cron-sync.mjs` |
| Frequency | `*/10 * * * *` |
| Container | leave empty (the app has one container) |
| Timeout | 300 seconds if the field exists (the route may run up to 300 s) |

Why a script and not `curl`: the Node slim image has no curl, and Coolify wraps the command in its own shell quoting, which breaks a long `node -e "..."` one-liner (only the scheduled-task wrapper mangles them; `node -e` one-liners are fine in the interactive terminal, like the checks in step 9b). `/app/cron-sync.mjs` (source `ops/selfhost/cron-sync.mjs`) uses Node's built-in fetch to call `http://127.0.0.1:3000/api/cron/sync`.

The header is the one the route checks (`app/api/cron/sync/route.ts`): `Authorization: Bearer <CRON_SECRET>`. The script reads `CRON_SECRET` from the container's own environment, so the value is never typed into the task and never printed. Without the header the route answers 401 (`smoke.sh` checks this; in production it answers 401 even if `CRON_SECRET` is unset, so the real proof the secret is set is the task's `cron-sync: 200`). Exit codes: 0 for a 2xx answer, 1 for a 401 or an error, 2 if `CRON_SECRET` is not set in the container.

Checked locally against the standalone server: with the right secret the script prints `cron-sync: 200` and exits 0; with a wrong one `cron-sync: 401` and exit 1; with none, exit 2.

After the first run, open the task's execution log in Coolify and look for `cron-sync: 200`. The staging databases are also served by the Vercel preview, so two heartbeats would run against them. The leased heartbeat is built for that, but keep the task **disabled** until the owner says otherwise.

## Storage: what is written, and where

| What writes | Where it goes | Persistent volume needed? | Staging address |
|---|---|---|---|
| Media: renders, uploads, thumbnails, stills, audio, 3D files (`ws/<workspace>/...`), platform assets, pending upload chunks | Vercel Blob (`BLOB_READ_WRITE_TOKEN`, default), R2 (`STORAGE_BACKEND=r2` + `R2_*`), or local disk (`STORAGE_BACKEND=local`) | No on Blob or R2. **Yes on local** | **Staging Blob store.** Never the live store, nor the live R2 bucket |
| Local generations `/app/.data/generations`, uploads `/app/.data/uploads`, chunks `/app/.data/chunks`, platform assets `/app/.data/platform` | Container disk | **Yes: volume at `/app/.data`** (only used on the local backend, and as scratch) | Mount the volume anyway: it costs nothing and a restart keeps scratch |
| Platform database | Turso (`PLATFORM_DATABASE_URL`, fallback `TURSO_DATABASE_URL`), or a local file under `.data` if neither is set | Only if the local file is used | **Staging Turso** |
| Workspace databases | One Turso database each; with no Turso API configured, **production mode refuses new workspaces** (only the house workspace works; `WORKSPACE_DB_DIRECTORY` files are used only outside production) | Yes for files: `/app/.data` (or the folder named by `WORKSPACE_DB_DIRECTORY`, which must then be a volume path) | **Staging Turso**; do **not** set `TURSO_API_TOKEN`/`TURSO_ORG` so nothing gets created |
| Next build output and caches | `/app/.next` inside the image | No (rebuilt on every deploy; image is read-only after build) | n/a |
| Everything else (sessions, ledger, settings, heartbeat) | In the databases above | n/a | Staging Turso |

Blob versus R2 for the test: keep the **staging Blob store** for this first test. One thing changes at a time (the host), nothing needs copying, and rollback is trivial. R2 comes with P3 (`docs/r2-migration.md`), needs its own **test** bucket and CORS for the staging address, and should only be used here if P3 has passed its gate. Nothing is switched by this branch.

## Environment variable names (one list)

Names only; the owner copies values from Vercel's **staging/preview** environment into the app's Environment Variables in Coolify. Found by searching `process.env.` and `env.` across `app/`, `lib/`, `scripts/`, `mcp/`, `proxy.ts`, `instrumentation.ts`, `next.config.ts`; `vercel.json` sets none.

Column **STAGING**: "YES" means the value must be a staging value on the staging address; "set" means a fixed value for this test.

| Name | Required? | Purpose | STAGING / value |
|---|---|---|---|
| `ENGINE_MOCK` | Required | `1` makes every engine call a mock so nothing spends | set: `1` |
| `APP_ORIGIN` | Required | Canonical origin for links and the worker hand-off; every emailed link (reset, invitation, sign-up, top-up) is built on it alone, and without it a production server sends none of those emails (logged `[mail] APP_ORIGIN is not set`) | set: the https address staging is served on, exactly (no path): `https://staging.particl.si`, or the temporary sslip.io address until then |
| `SELFHOST_BEHIND_PROXY` | Required (self-hosted only; set on staging and on production) | `1` makes the origin checks accept exactly `APP_ORIGIN` behind the proxy, and makes every rate limit and sign-in lock (login, reset, sign-up, resend, review links, report, request access) count the address the proxy saw, never the client's own `X-Forwarded-For` entries (`lib/clientIp.ts`); unset, no forwarded header is trusted and every caller shares one allowance; **runtime variable, not a build variable; never set on Vercel** (ignored there) | set: `1` |
| `TRUSTED_PROXY_HOPS` | Optional (self-hosted only) | How many proxies we run in front of the app, counted from the right of `X-Forwarded-For` (whole number 1 to 5; unset means 1, Traefik's own view). Any other value is refused and every caller shares one allowance. Only takes effect with `SELFHOST_BEHIND_PROXY=1` | leave **unset** |
| `TRUST_CF_CONNECTING_IP` | Optional (self-hosted, **production only**, after the Cloudflare-only firewall) | `1` reads the client's address from Cloudflare's `CF-Connecting-IP` header instead (valid addresses only). Anyone can send that header, so set it **only once the server accepts connections from Cloudflare alone**. Only takes effect with `SELFHOST_BEHIND_PROXY=1` | leave **unset** on staging |
| `NEXT_PUBLIC_APP_URL` | Required | Same origin for the browser build (**build variable**) | set: the https address staging is served on, exactly (no path): `https://staging.particl.si`, or the temporary sslip.io address until then |
| `APP_URL` | Required | Same origin, read by some server code | set: the https address staging is served on, exactly (no path): `https://staging.particl.si`, or the temporary sslip.io address until then |
| `PLATFORM_DATABASE_URL` | Required | Platform database | **YES: fresh file per "Staging test" (or staging Turso on the Preview route)** |
| `PLATFORM_AUTH_TOKEN` | Required | Token for it | **YES: staging (not set with file databases)** |
| `TURSO_DATABASE_URL` | Required | Fallback database URL some code reads | **YES: fresh file per "Staging test" (or staging Turso on the Preview route)** |
| `TURSO_AUTH_TOKEN` | Required | Token for it | **YES: staging (not set with file databases)** |
| `KEYRING_SECRET` | Required | Decrypts stored workspace keys and database tokens (30+ characters); must be the value that sealed the staging databases; never rotate; stop if blank | **YES: a freshly generated value (see "Staging test"); the Preview value only if it is ever known. Never production's** |
| `SESSION_SECRET` | Required | Signs session cookies | fresh value (test sessions must not work on production) |
| `CRON_SECRET` | Required | Bearer secret for `/api/cron/sync` and `/api/worker`; the scheduled task reads it from the container | fresh value |
| `SUPER_ADMIN_EMAIL` | Required | Who may use platform admin routes | same as Vercel |
| `BLOB_READ_WRITE_TOKEN` | Required (on Blob) | Media storage token | **YES: staging Blob store** |
| `STORAGE_BACKEND` | Optional | `blob`, `r2` or `local`; unset means Blob when the token is set | staging: unset or `blob` (or `r2` with a staging bucket). **Production: `r2`** (with `BLOB_READ_WRITE_TOKEN` kept) |
| `PARTICL_DEPLOYMENT` | Required (self-hosted only; set on staging and on production) | Which deployment this server is (`lib/deployment.ts`): `production`, `staging` or `development`. Off Vercel it replaces `VERCEL_ENV` for every production-only behaviour: `production` turns on the "no test Stripe key" billing guard (`lib/billingConfig.ts`), the live-key and real-engine readiness checks (`lib/deploymentReadiness.ts`) and allows the owner-privacy scrub (`lib/platformOwnerScrub.ts`); `staging` keeps all of those off and refuses the scrub even with `OWNER_PRIVACY_SCRUB_LOCAL=1`. Unset means `development` (production paths off); any other value also means `development` and fails the readiness check `deployment`. **Runtime variable, not a build variable; ignored on Vercel** (`VERCEL_ENV` decides there) | set: `staging` here; production sets `production` |
| `CREDIT_USD` | Required | Dollar value of one credit, **must be `0.10`** on the new host | set: `0.10` |
| `PAYMENT_PROVIDER` | Optional | Leave **unset** (means `manual`: requests are queued, no card is charged). Never `stripe` on the staging address | set: unset or `manual` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Do not set | Live payments must be off | **not set** |
| `TURSO_API_TOKEN`, `TURSO_API_URL`, `TURSO_ORG`, `TURSO_GROUP` | Do not set | Would create real workspace databases | **not set** |
| `RESEND_API_KEY`, `RESEND_BASE_URL`, `MAIL_FROM` | Optional | Email; leave unset so the test sends no mail | staging: not set. **Production: copied; `MAIL_FROM=hello@particlstudio.com`** |
| `DISPATCH_MODE` | Optional | `native` is the production default (hand-off to `APP_ORIGIN/api/worker`); `inngest` needs the two keys below | unset |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_SERVE_ORIGIN`, `INNGEST_STREAMING` | Optional | Only for `DISPATCH_MODE=inngest`; the serve route is `/api/inngest` (`INNGEST_SERVE_PATH` would change it; unset) | staging: not set. **Production: both keys copied, `INNGEST_SERVE_ORIGIN=https://particl.si`, `INNGEST_STREAMING=true`** (see "Production specifics") |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | Optional | R2 adapter, only with `STORAGE_BACKEND=r2` | a **test** bucket, if ever |
| `WORKSPACE_DB_DIRECTORY` | Optional | Folder for file-based workspace databases | unset (`.data`) |
| `CREDIT_PACKS`, `CREDIT_MARGINS`, `SIGNUP_CREDITS`, `PLATFORM_ALLOWANCE_USD`, `ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD`, `BLOB_USD_PER_GB_MONTH`, `BLOB_USD_PER_GB_TRANSFER` | Optional | Pricing, caps and cost display | same as Vercel |
| `RIG_AGENT_ENABLED`, `LEGACY_WORKSPACE_NAME` | Optional | Feature switch; the original studio's name | same as Vercel |
| `LIVEBLOCKS_SECRET_KEY` | Optional | Live board collaboration | same as Vercel, or unset |
| `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | Optional | Web push | unset |
| Engine and assistant keys and switches: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROMPT_MODEL`, `ANTHROPIC_PROMPT_EFFORT`, `AI_GATEWAY_BASE_URL`, `GATEWAY_PROMPT_MODELS`, `REFINE_PROVIDER`, `HF_API_KEY_ID`, `HF_API_KEY_SECRET`, `HF_CREDENTIALS`, `HF_CREDENTIALS_PREVIOUS`, `HF_CREDENTIAL_ALIASES`, `HF_POOL_SIZE`, `HF_POOL_WORKSPACE_SHARE`, `HF_CONSUMER_CLIENT_ID`, `HF_CORRELATION_HEADER`, `HF_CINEMA_STUDIO_ENABLED`, `HF_CONSUMER_VIDEO_ANALYSIS_ENABLED`, `HF_SOUL_CHARACTER_ENABLED`, `HF_SOUL_CHARACTER_USD_720P`, `HF_SOUL_CHARACTER_USD_1080P`, `GEMINI_BASE_URL`, `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`, `ARK_BASE_URL`, `ARK_TEXT_MODEL`, `XAI_BASE_URL`, `XAI_MODEL`, `XAI_RATE_USD_PER_MTOK`, `FAL_*`, `ELEVEN_*`, `ASTRA_BLENDER_*`, `AI_GATEWAY_API_KEY`, `GEMINI_API_KEY`, `ARK_API_KEY`, `OPENAI_API_KEY`, `OWNER_PRIVACY_SCRUB_LOCAL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_OIDC_TOKEN` | Do not set | **No engine keys are needed**: `ENGINE_MOCK=1` answers every call. Real keys would mean real spend | **not set** |
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
| `/api/cron/sync` with no header | 401 (the route refuses an unauthenticated call; the task's `cron-sync: 200` is what proves the secret is set) |
| Security headers on `/login` | frame DENY and a content policy |
| Any 5xx | none |

It accepts an `http://` or `https://` base URL. It prints each time and exits 0 only if all pass. Retested against `main`, this branch and `release/1` locally: `home /` passes. `/api/health` answers 503 until storage is configured (a staging Blob token), which also trips the "no 5xx" check.

## Click by click (owner)

Menu names are for current Coolify v4 as best known; a label marked (unsure) may read a little differently on your version.

1. **Open the project.** Coolify, **Projects**, open the one empty project, then its environment (usually `production`).
2. **New resource.** **+ New** (unsure: it may read "Add New Resource"), then **Public Repository** (the repo is public, so no GitHub App is needed). Repository URL: `https://github.com/axy-full/aimighty-workspace`. Click **Check repository**. Server: the localhost server (this machine). Continue.
3. **Build settings.** Branch: `release/1`. **Build Pack: Dockerfile** (or Railpack, see "Build paths"). **Base Directory:** `/`. **Port (Ports Exposes):** `3000`. Continue (or Save). On the next page, in **Configuration, General**, set **Dockerfile Location:** `/ops/selfhost/Dockerfile`. Save. Do **not** deploy yet.
4. **Domain.** **Owner:** with the advisor, create the Cloudflare DNS record for `staging.particl.si` (an A record to `<server IPv4>`; proxied or DNS-only, either works for staging; if proxied, see SSL mode in the cutover checklist) and, in Coolify, **Configuration, General, Domains**, enter `https://staging.particl.si` (replace any generated address). Coolify gets a Let's Encrypt certificate through Traefik; that needs the record to be DNS-only or Cloudflare SSL mode **Full** while the certificate is issued. **Sign-in needs `https`:** the session cookie is Secure, so over plain `http://` it is never kept. Fallback if the record is not ready: Coolify's generated `http://<random>.<server-ip>.sslip.io` address (switch it to `https://`); plain `http` is enough only for the read-only smoke test.
5. **Environment variables.** **Configuration, Environment Variables**, **Developer view** (unsure: sometimes a toggle at the top). Add the names from the table above: every row marked Required, with values copied from Vercel's staging/preview environment where it says "same as Vercel" and **staging** values where it says STAGING (the databases and keyring per "Staging test: fresh empty databases"; the Preview values only if the Preview keyring is ever known). Set `ENGINE_MOCK=1`, `CREDIT_USD=0.10`, and set `APP_ORIGIN`, `APP_URL` and `NEXT_PUBLIC_APP_URL` to the staging address from step 4. On `NEXT_PUBLIC_APP_URL` tick **Build Variable** (unsure: shown as a "Build Variable?" checkbox). Check: the databases and the Blob store are staging, `KEYRING_SECRET` is not blank, no `STRIPE_*`, no `TURSO_API_*`, no `VERCEL*`, no engine keys. Save. **Untick Build Variable on every variable except `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY`** (check your version's default). `KEYRING_SECRET` and the database values come from the **Preview** environment, never Production. Add `SELFHOST_BEHIND_PROXY=1` and `PARTICL_DEPLOYMENT=staging` (runtime only) and make `APP_ORIGIN`, `APP_URL` and `NEXT_PUBLIC_APP_URL` exactly the https address you serve staging on: the temporary sslip.io address now (see "Staging now"), `https://staging.particl.si` once its record exists (a rebuild is needed to change it). Use the **Preview** environment's staging databases and keyring, `ENGINE_MOCK=1`, and no live Stripe.
6. **Health check.** **Configuration, Healthcheck** (unsure): **leave it off** on the Dockerfile path; the image's own HEALTHCHECK (Node fetch of `/api/health`) is what counts, because the platform's check may need `curl` or `wget` and the slim image has neither. If you do enable it (path `/api/health`, port `3000`, GET, `200`, start period 40 s), confirm on staging that it goes green and does not flap; on Railpack, check what the image contains.
7. **Storage and limits.** **Configuration, Persistent Storage, + Add**: volume mount, name `selfhost-data`, destination path `/app/.data`. Then **Resource Limits**: memory `4g`, CPUs `2`. Make sure **Auto Deploy** is off.
8. **Deploy.** Click **Deploy**. Watch **Deployments, Logs**. The first build takes several minutes. The step "npm run build" prints `preview seed: skipped (VERCEL_ENV is not set)`; that is expected and touches no database. It passes when the log ends with the container started and the health check going green. If it fails, copy the last 30 lines to Claude (no variable values are printed by the build).
9. **Smoke test.** From a shell on this machine, in the repo: `bash ops/selfhost/smoke.sh <staging address from step 4>`. Expected: every check passes once storage is configured. If anything fails, send the output (without the hostname).
9b. **Check the workspace addresses before any scheduled task (only if a Preview-staging set is used; not needed with fresh databases, see "Staging test: fresh empty databases").** In the Turso dashboard, open the **staging** platform database's shell (read only) and run only this query: `SELECT id, db_url FROM workspaces;`. Every `db_url` host must belong to the staging group (or be empty for the house workspace). If any row names a production database, **stop**: do not add the scheduled task, and tell Claude only that a row failed (never paste the URLs). Don't paste the output anywhere.

    Two more read-only checks, in the **app's terminal** on the platform (they print only an 8-character fingerprint, a count and host names). The first shows which keyring the host holds (compare it with the same fingerprint computed from the Preview environment's value; it must differ from production's):

    ```
    node -e 'console.log("keyring fingerprint:",require("crypto").createHash("sha256").update(process.env.KEYRING_SECRET||"").digest("hex").slice(0,8))'
    ```

    The second lists the workspace database hosts the platform database names (every host must be a staging one):

    ```
    node -e 'import("@libsql/client").then(({createClient})=>createClient({url:process.env.PLATFORM_DATABASE_URL,authToken:process.env.PLATFORM_AUTH_TOKEN}).execute("SELECT db_url FROM workspaces")).then(r=>{const h={};for(const x of r.rows){const u=String(x.db_url??"");const k=u?u.replace(/^[a-z]+:\/\//i,"").split(/[/?]/)[0]:"(none: house workspace)";h[k]=(h[k]||0)+1}console.log("workspaces:",r.rows.length);console.log(h)}).catch(e=>console.log("error:",e.message))'
    ```

    Notes on the fingerprint. To compute the comparison value from the Preview environment's secret **without leaving it in shell history**, paste the secret into a prompt that does not echo (`IFS= read -rs K; printf %s "$K" | sha256sum | cut -c1-8; unset K`, with `shasum -a 256` instead of `sha256sum` on macOS; start the line with a space, or use a private shell, so the history does not keep it), and watch for a **trailing newline or space** in a copied value: it gives a false mismatch. **Do not paste either output anywhere**, not even to Claude: report only pass or fail.
10. **Scheduled task.** The "after 9b, and keep it disabled while the Vercel preview uses the same staging databases" rule applies **only to the Preview-set route**; with fresh databases the task may be added once health is green and sign-in works. **Configuration, Scheduled Tasks, + Add**: name `cron-sync`, command `node /app/cron-sync.mjs`, frequency `*/10 * * * *`, save, then run it once by hand if the page has a run button (unsure), and read its log for `cron-sync: 200`.
11. **Stop or roll back.** Nothing live is affected. Coolify, the app, **Stop** (or Delete in Danger Zone). To keep the settings and just pause the heartbeat: Scheduled Tasks, disable `cron-sync`. Vercel and particl.si are untouched throughout.

## Before production leaves Vercel (not needed for the staging address)

These work on Vercel without any setting and change on another host:
- **AI Gateway** (`lib/gateway.ts`; Atomik drafts, memory read, prompt enhance): on Vercel it signs in with the deployment's own identity. Off Vercel it needs `AI_GATEWAY_API_KEY` (created on Vercel's AI Gateway page) until P4b moves models to their own APIs.
- **Vercel Sandbox** (`lib/astra-blender/sandbox.ts`, the 3D render): needs `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` off Vercel.
- **Production-only guards** (the "no test Stripe key on production" check in `lib/billingConfig.ts`, deployment readiness in `lib/deploymentReadiness.ts`, the owner-privacy scrub in `lib/platformOwnerScrub.ts`) use `VERCEL_ENV` on Vercel and `PARTICL_DEPLOYMENT` off Vercel (`lib/deployment.ts`). Set **`PARTICL_DEPLOYMENT=production` on the production app** and `staging` on staging; unset off Vercel means development, and the guards stay off. Never set `VERCEL_ENV` on this host.
- **Long requests:** routes declare `maxDuration` up to 800 s (uploads, media) and Traefik v3's default `readTimeout` is 60 s. The exact lines to add are in "Proxy timeouts and forwarded headers" below; do it on staging first. Cloudflare adds its own 100 s limit on silent requests (see there).
- **Sign-in behind the proxy** is fixed on `release/1`. The host sets `SELFHOST_BEHIND_PROXY=1` and `APP_ORIGIN` = the exact public `https` address; never set the flag on Vercel.
- **Client address for rate limits and the sign-in lock** (`lib/clientIp.ts`). With `SELFHOST_BEHIND_PROXY=1` the app counts the last `X-Forwarded-For` entry, the one Traefik added, so a client cannot pick a fresh address per request by writing its own entries. On the bare staging address leave `TRUST_CF_CONNECTING_IP` and `TRUSTED_PROXY_HOPS` unset (hops 1 = Traefik's view of the caller). Once Cloudflare is in front, Traefik sees Cloudflare's edge, so every visitor through one edge would share an allowance: **set `TRUST_CF_CONNECTING_IP=1` only once the Cloudflare-only firewall is in place** (P2); before that anyone could send the header straight to the server. In every case the app's own port must be reachable only through Traefik: a request that skips the proxy can write the last entry itself. So: **do not publish the app's port on the host** (no host port mapping; the container is reached only through the proxy), and **keep Traefik's default of appending to `X-Forwarded-For`** (never set `notAppendXForwardedFor`): without the append, the last entry is again whatever the client sent. If the app logs `[client-ip] … one shared bucket`, one of these settings is wrong.

Staging at `https://staging.particl.si` is public until the Cloudflare-only firewall exists. It runs mock engines and staging data, but keep it stopped when not in use, or add Traefik basic auth. If the sslip.io fallback is used, its hostname contains the server's IP: don't paste it anywhere public.

## Domains at cutover: particl.si, www.particl.si, particl.app, www.particl.app

Nothing here happens on the staging address (it is the P5 steps in "Cutover order"). These are cutover steps (P5), done only on the owner's "go".

**Today.** Vercel serves `particl.si`. It answers `particl.app` and `www.particl.app` with a 308 to `particl.si`. That redirect is a Vercel **domain setting**: nothing in the repo does it (`vercel.json` holds only the cron; no code matches the host). When the site leaves Vercel, the redirect goes too, unless something else takes it over. Before the move, check in Vercel, **Settings, Domains**:
- that `particl.si` is the primary domain;
- what `www.particl.si` does today (a redirect to `particl.si`, or serving directly);
- that the 308 keeps the path and query (for example, `https://particl.app/pricing?x=1` lands on `https://particl.si/pricing?x=1`).

The steps below assume `particl.si` stays primary and every other name 308s to it, path and query kept.

### Option A (recommended): a Cloudflare redirect rule
The redirect happens at Cloudflare's edge, so it needs no app code, puts no load on the server, and keeps working if the app is down.
1. `particl.app` is **already on Cloudflare** (nameservers `alan` and `daphne` `.ns.cloudflare.com`), so no nameserver move is needed; only the redirect rule remains. Both `particl.app` and `www.particl.app` must have **proxied** (orange-cloud) records, or the request never reaches the rule. `particl.si` joins the same pattern at cutover (see the checklist).
2. (This rule can be created ahead of the cutover.) In the `particl.app` zone: **Rules, Redirect Rules, Create rule** (Single Redirect):
   - If: custom filter, hostname is in `particl.app`, `www.particl.app`.
   - Then: Dynamic, expression `concat("https://particl.si", http.request.uri.path)`, status **308**, **Preserve query string** ticked.
3. In the `particl.si` zone, the same pattern for `www.particl.si`, if `www` should redirect to the bare name: hostname equals `www.particl.si`, the same expression and options.
4. The app on the server then only ever sees `particl.si`. In Coolify the app's **Domains** field lists only `https://particl.si`.

### Option B: the self-hosted app redirects
Not needed, since `particl.app` is already on Cloudflare. Kept only as a fallback.
1. In Coolify add every name to the app's **Domains** field (comma-separated) so Traefik answers for them and fetches a certificate for each. With Cloudflare proxying in Full (strict) mode, use the Cloudflare origin certificate (P2) for the `particl.si` names.
2. The redirect then has to come from the server, in one of two ways:
   - a Traefik redirect-regex middleware added through the app's custom labels, which needs no code change;
   - a host check at the top of `proxy.ts` that 308s any host other than `particl.si` to `https://particl.si` plus the path and query. That is product code: its own PR, reviewed, tested against the Vercel preview so nothing changes there.
3. Downsides: a certificate per name, renewals, and the redirect stops whenever the app or Traefik is down.

### DNS records (all four names)
`<server IPv4>` (and `<server IPv6>`, if the server has one) is this server's public address. Every record below is **proxied** through Cloudflare.

| Name | Type | Value | With option A | With option B |
|---|---|---|---|---|
| `particl.si` | A (+ AAAA) | `<server IPv4>` (`<server IPv6>`) | serves the site | serves the site |
| `www.particl.si` | CNAME | `particl.si` | redirect rule answers | Traefik answers, redirects |
| `particl.app` | A (+ AAAA) | `<server IPv4>` (`<server IPv6>`) | redirect rule answers; traffic never reaches the server | Traefik answers, redirects |
| `www.particl.app` | CNAME | `particl.app` | redirect rule answers | Traefik answers, redirects |

If the host firewall cannot filter IPv6, add **no AAAA record** (see cutover step 5).

Under option A the two `particl.app` records may point anywhere while proxied (the redirect rule answers first). Pointing them at the server keeps option B open.

### Keep, and don't touch
- **Mail records** on both domains (MX, SPF/TXT, DKIM, DMARC, the mail sender's verification records) stay exactly as they are. Moving the website changes only the A, AAAA and CNAME rows above.
- **CAA records**, if any: they must allow the certificate issuer in use (Cloudflare's for proxied names; Let's Encrypt only under option B).
- **Rollback (short form; the full order is step 11 of "Cutover order"):** before the change, write down the four current records (Vercel's values), and lower their TTL a day ahead. Rolling back means restoring those four values **and their proxy status** (Vercel records are usually DNS-only, grey cloud; proxied records use Cloudflare's fixed Auto TTL) (SOW: rollback is one DNS change). Leave the Vercel domain settings in place until the two weeks of watching are over, so a rollback lands on a working redirect.

### Checks after the change
`curl -sI 'https://particl.app/pricing?x=1'` and the same for `www.particl.app` and `www.particl.si`: each must answer **308** with `location: https://particl.si/pricing?x=1`. `curl -sI https://particl.si/` answers 200. Then run `smoke.sh https://particl.si`.

## Production specifics (from production's own signed-in health answer, checked in code)

Owner's facts: storage `r2-configured`, dispatch mode `inngest`, mail from `hello@particlstudio.com`, AI through the Vercel AI Gateway, Astra Blender renders in active use. What each one means after the move:

**Storage (R2, with Blob still readable).** Copy from Vercel Production: `STORAGE_BACKEND=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_ENDPOINT` if production sets it (otherwise the code builds `https://<account>.r2.cloudflarestorage.com`). **Keep `BLOB_READ_WRITE_TOKEN` as well:** with `STORAGE_BACKEND=r2` and the token present, `lib/storage/backend.ts` reads through a dual backend (`migrationBackend(r2Backend, blobBackend())`), so old Blob URLs keep working; without the token they would break. Bucket CORS: the app's origin stays `https://particl.si`, so nothing changes, but **check the bucket's CORS list contains `https://particl.si`** (and not only the Vercel preview origins).

**Background work (Inngest).** `DISPATCH_MODE=inngest` is honoured only when `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are both set (`lib/dispatch.ts`); copy all three from Vercel Production **before** disconnecting Inngest's Vercel integration (below). The serve route is `app/api/inngest/route.ts` (GET, POST and PUT, `maxDuration = 300`); the SDK registers `/api/inngest` by default. It reads `INNGEST_SERVE_ORIGIN` and `INNGEST_SERVE_PATH` if set (the code sets neither). Behind a proxy the SDK may infer its public URL from request headers, so **set `INNGEST_SERVE_ORIGIN=https://particl.si` on the production app** and leave the path default. Re-pointing at cutover:
1. The app URL in Inngest Cloud is `https://particl.si/api/inngest`. It is the same domain, so Inngest's requests follow DNS to the new host with no URL change.
2. **OWNER, before step 7:** in Inngest's **Vercel integration** settings, **turn off sync for this project** rather than uninstalling the integration (uninstalling may remove the keys from Vercel), so a later Vercel deploy cannot sync the app back to Vercel URLs. Afterwards **confirm Vercel Production still lists both Inngest keys**. The values are already copied to the production app's env.
3. **OWNER, after step 8 passes:** in the Inngest dashboard, **Apps, Sync** (a new sync) against `https://particl.si/api/inngest`, or verify the last sync shows the new host. A failed sync usually means Cloudflare or the firewall is blocking the call (see the next point).
4. **Bot Fight Mode must be OFF.** The free Bot Fight Mode cannot be bypassed by a WAF skip rule; a skip rule for `/api/inngest` (and `/api/worker`) only covers the other WAF rules. Inngest's signed calls must never be challenged.
5. **Cloudflare's 100 s limit hits Inngest step calls too.** Each step Inngest runs is one request to `/api/inngest`, and Cloudflare returns a 524 if it sends no bytes for about 100 s (see the Cloudflare block above). The route allows 300 s, and some steps can run longer than 100 s: **`astra-blender-render`'s step `render-persist-and-account`** (it boots a sandbox and the render command alone is allowed `RENDER_TIMEOUT_MS = 165 s`), **`audio-dubbing`'s `submit-poll-or-collect`** (polls a vendor; no fixed bound), possibly the `render` function's `produce` step for stills and audio, and a `rig-agent` tick (a model call). Inngest sees the 524 as a failed step and retries (2 to 3 retries), so the person sees a failed or doubled attempt (the paid claim prevents a second vendor purchase, but the retry still shows as a failure). **Recommended, no code change: set `INNGEST_STREAMING=true` on the production app.** `inngest` 4.19 reads it from the environment (`helpers/consts.js`, `components/InngestCommHandler.js`), and the Next adapter then answers 201 at once and sends a space every 3 seconds (`helpers/stream.js`), so Cloudflare's 100 s no-bytes limit never fires. **Caveat:** staging dispatches natively, so this cannot be tested there; **verify on the first long run after step 8** (an Astra render or a dubbing job completing without a 524), or in a separate Inngest environment beforehand. **OWNER** confirms it works before the Vercel deployment is retired. Fallbacks if streaming does not hold: (b) Cloudflare Enterprise (longer timeouts); (c) serve `/api/inngest` from an unproxied (grey cloud) host via `INNGEST_SERVE_ORIGIN`, which conflicts with the Cloudflare-only firewall unless Inngest's source addresses are allowed too.
6. **Watch window:** check the Inngest dashboard daily for failed syncs and failed runs, plus `dispatch.refused` in the app log.

**Mail.** `MAIL_FROM=hello@particlstudio.com` and `RESEND_API_KEY` (and `RESEND_BASE_URL` if set) are copied unchanged. The sending domain `particlstudio.com` stays verified at Resend: **change nothing in its DNS**; it is a different domain from the four being moved.

**AI Gateway.** `AI_GATEWAY_API_KEY` (**OWNER** creates it on Vercel's AI Gateway page). Without it, Atomik drafts, memory read and prompt enhance fail off Vercel (`lib/gateway.ts`).

**Astra Blender renders (Vercel Sandbox).** The render runs in a **Vercel Sandbox**, a microVM on Vercel's infrastructure that the app drives with `@vercel/sandbox` (`lib/astra-blender/sandbox.ts`). From the new host it needs: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (read by `credentials()`; without all three the SDK falls back to a Vercel OIDC token that does not exist off Vercel, so off Vercel the 3D render reports itself not connected and is refused before any credits are reserved) and `ASTRA_BLENDER_SNAPSHOT_ID` (must look like `snap_...`; the sandbox is started from that snapshot). Optionally `ASTRA_BLENDER_RATE_CARD`. After cutover:
- **The Vercel team, project and snapshot must stay.** Do not delete the Vercel project or the snapshot; the sandbox's billing stays on the Vercel account. The deployment and domains can be retired after the watch window; the team, project and snapshot stay.
- The render is **dispatched from the new host** (through Inngest, or native), the sandbox runs on Vercel, and the app persists the result to storage (R2) itself. In the code there is **no callback to a Vercel URL and no use of `VERCEL_URL` or OIDC** in the render path: the sandbox starts with an empty environment, no ports and a deny-all network policy, so nothing from the VM calls back. The one place that mentions a Vercel address is `lib/dispatch.ts` `dispatchOrigin`, which falls back to `VERCEL_PROJECT_PRODUCTION_URL` only when `APP_ORIGIN` is unset; `APP_ORIGIN` is set, so it is not used. **Flag:** the render step can exceed Cloudflare's 100 s (see point 5 above); this is the one place a render can fail after the move.
- **Cutover check (no paid press):** do **not** press a render. Instead check that the render page loads, and that the credentials are present, in the app's terminal (it prints only set or MISSING):
  ```
  node -e 'console.log(["VERCEL_TOKEN","VERCEL_TEAM_ID","VERCEL_PROJECT_ID","ASTRA_BLENDER_SNAPSHOT_ID"].map(k=>k+": "+(process.env[k]?"set":"MISSING")).join("  "))'
  ```

## Staging test: fresh empty databases (current plan for this test)

The Preview environment's keyring cannot be read by the owner, so staging starts **empty, with fresh secrets**. This **replaces the Preview-staging-set rule** above for this test; that rule stays only for the case where the Preview keyring is ever known. Nothing here touches production data.

| Setting | Value |
|---|---|
| `PLATFORM_DATABASE_URL` | `file:/app/.data/platform.db` (fresh file on the `/app/.data` volume) |
| `TURSO_DATABASE_URL` | `file:/app/.data/legacy.db` |
| `WORKSPACE_DB_DIRECTORY` | `/app/.data/tenants` (unused here; see "One workspace only" below) |
| `PLATFORM_AUTH_TOKEN`, `TURSO_AUTH_TOKEN` | not set (file databases need none) |
| `KEYRING_SECRET`, `SESSION_SECRET`, `CRON_SECRET` | **generate** each, for example `openssl rand -base64 48` (fresh values, never production's; keep `KEYRING_SECRET` safe: it can never be rotated and the databases are sealed with it) |
| `ENGINE_MOCK` | `1` |
| `SUPER_ADMIN_EMAIL` | the email you will create the first account with (below) |
| Not set | `TURSO_API_*`, `RESEND_*` and `MAIL_FROM` (no mail), `STRIPE_*`, `INNGEST_*` and `DISPATCH_MODE` (unset, so it dispatches natively), any AI key, any `VERCEL_*` |
| Storage | a **separate staging store**: a new Vercel Blob store (its token as `BLOB_READ_WRITE_TOKEN`) **or** a staging R2 bucket (`STORAGE_BACKEND=r2` and the four `R2_*`). **Never production's.** Local disk is not enough: in production mode `/api/health` answers 503 (`storage: missing`) without a configured store |
| Origin variables | as in the variables table (`APP_ORIGIN`, `APP_URL`, `NEXT_PUBLIC_APP_URL`, `SELFHOST_BEHIND_PROXY=1`, `PARTICL_DEPLOYMENT=staging`, `CREDIT_USD=0.10`) |

**First account.** Open `/setup` on the staging address: the first account created there becomes the platform owner, then `/setup` closes (`app/api/auth/setup/route.ts`). Use the same email as `SUPER_ADMIN_EMAIL`. Then sign in and run `smoke.sh`.

**Do `/setup` immediately after the first deploy.** On a fresh public staging site the first account to post to `/setup` becomes its owner, and new hosts are scanned within minutes. Either create the account the moment the deploy is healthy, or keep staging **stopped** or behind **Traefik basic auth** until you have. **If `/setup` says it is already complete and you did not do it: stop, wipe the `/app/.data` volume, and redeploy** (someone else owns that staging).

**One workspace only.** On these hosts (production mode, no `TURSO_API_*`) `lib/provision.ts` refuses to create new workspace databases ("Workspace provisioning is not available on this deployment"), so only the house workspace (on `TURSO_DATABASE_URL`) works and `WORKSPACE_DB_DIRECTORY` is unused. Staging cannot create a second workspace, which is fine for this test.

**Step 9b is not needed with fresh databases:** the databases are new files on the volume, so no workspace row can name a production database, and the keyring is one you generated. Run 9b only if a staging set from Preview is used instead. The cron task may be added once health is green and sign-in works.

## Proxy timeouts and forwarded headers (owner, once, before production; staging first)

**Why.** Routes declare `maxDuration` up to 800 s (uploads, media), and Traefik v3's default entrypoint `readTimeout` is 60 s, so a long upload or request would be cut by the proxy.

**Where.** Coolify, **Servers**, the server, **Proxy**, **Configuration** (the proxy's docker-compose). In the Traefik service's `command:` list, add these lines next to the existing `--entrypoints.http.address=:80` and `--entrypoints.https.address=:443` lines. **Verify the entrypoint names in your proxy config:** Coolify's default names them `http` and `https`; if yours differ, use your names.

```yaml
      - '--entrypoints.http.transport.respondingTimeouts.readTimeout=900s'
      - '--entrypoints.http.transport.respondingTimeouts.writeTimeout=900s'
      - '--entrypoints.https.transport.respondingTimeouts.readTimeout=900s'
      - '--entrypoints.https.transport.respondingTimeouts.writeTimeout=900s'
```

900 s is above the longest route (800 s). `idleTimeout` is left at Traefik's default (180 s), so no line is needed. Note that `writeTimeout` caps the whole response, so a streamed download that takes longer than 900 s is cut. **Save, then restart the proxy** (the restart button on the same page). A restart drops connections for a few seconds on every app on the server, so do it when quiet. Afterwards check the proxy is running and staging still answers 200.

**Cloudflare's own limit (owner decision before cutover).** A proxied request that sends **no bytes for about 100 s** is cut by Cloudflare with a 524 on Free and Pro; Traefik's settings cannot change that. Chunked uploads and streamed downloads are fine (bytes keep flowing). **`POST /api/uploads/finish`** is not: it may run up to 800 s and assembles up to 2 GB before it answers, so on large files it **will 524**. A retry recovers, but the person sees a failure. Options:
1. **Direct-to-storage upload** (a presigned R2 or Blob upload, so the server only records the result). **Recommended**; it needs a product change, so it is its own PR.
2. Cloudflare Enterprise (longer proxy timeouts).
3. An unproxied (grey cloud) upload host. This conflicts with the Cloudflare-only firewall, so it is the least attractive.

**OWNER decides which before step 7;** until then, large uploads may show a failure on the new host.

**Forwarded headers.**
- Keep Traefik's default of **appending** to `X-Forwarded-For` (never set `notAppendXForwardedFor`), and do not publish the app's port on the host (see the client-address note above).
- Recommended with Cloudflare: **leave `forwardedHeaders.trustedIPs` unset.** Traefik then ignores any incoming `X-Forwarded-*` and writes the address it saw (Cloudflare's edge); the app gets the real visitor from `TRUST_CF_CONNECTING_IP=1`. That header is only trustworthy if **nothing can reach the server except Cloudflare**, which depends on the firewall in step 5 really covering Docker's published ports (see there). Until it does, leave `TRUST_CF_CONNECTING_IP` unset.
- Alternative, if Traefik should trust Cloudflare: `- '--entrypoints.https.forwardedHeaders.trustedIPs=<Cloudflare ranges, comma separated, from https://www.cloudflare.com/ips/>'`. Traefik then keeps Cloudflare's `X-Forwarded-For` (client first) and appends the edge address. Then set the app's `TRUSTED_PROXY_HOPS=2` (the edge and Traefik) **or** `TRUST_CF_CONNECTING_IP=1`, per the variables table above. The ranges change now and then and the list must be kept current, which is why the first option is simpler.

## Cutover order (owner actions marked **OWNER**; nothing happens without the owner's "go")

Steps 1 to 6 do not move live traffic. From step 7 the live site is affected. Do not start a step until the one above has passed.

0. **Gates.** Gates 1 to 5 in "Gates still ahead" below are each **passed or explicitly waived by the owner**, in writing in the owner's message. If any is open, stop here.
1. **Staging works end to end.** **OWNER:** staging DNS record and platform domain for `https://staging.particl.si` (with the advisor); staging values in the app (`PARTICL_DEPLOYMENT=staging`, `ENGINE_MOCK=1`, fresh databases per "Staging test: fresh empty databases", no live Stripe). **OWNER:** add the proxy timeout lines above and restart the proxy. Deploy, run `smoke.sh https://staging.particl.si`, and **sign in** in a browser. Passes when every check is green and sign-in sticks.
2. **OWNER's "go": five preconditions are merged to `main`** (the lead merges, on the owner's word): (a) sign-in behind the proxy, (b) public links, (c) client IP, (d) the production flag (`PARTICL_DEPLOYMENT`), and (e) **the self-host files** (`ops/selfhost/*`, `.dockerignore`, and the `next.config` standalone switch; a fifth hotfix PR is being prepared for this). **Verify each on `main` before going on**, limiting every search to code so this document does not match itself: `git grep -l SELFHOST_BEHIND_PROXY origin/main -- lib app proxy.ts`, `git grep -l TRUST_CF_CONNECTING_IP origin/main -- lib app proxy.ts`, `git grep -l PARTICL_DEPLOYMENT origin/main -- lib app proxy.ts`, `git grep -l mailLinkOrigin origin/main -- lib app` (or `configuredOrigin`; use whichever name the public-links PR introduced; PR numbers come later), and `git ls-tree origin/main ops/selfhost/` (must list the Dockerfile, `cron-sync.mjs` and `smoke.sh`). If any check finds nothing, that change is not on `main`: stop.
3. **Staging moves to `main`, then production is prepared.**
   - Switch the **staging app's branch to `main`**, rebuild, and **redo the sign-in check and `smoke.sh`** on staging. Do not go on until they pass on a build of `main`.
   - **Scheduled task command for a main build** (after the merges above): `node /app/ops/selfhost/cron-sync.mjs` on Railpack (the repo is kept under `/app`; verify the container's working directory), `node /app/cron-sync.mjs` on the Dockerfile path. Do not call the route from outside with the bearer secret (it would put `CRON_SECRET` in a host crontab, and Cloudflare cuts the request at about 100 s with a 524).
   - **Production app** on the server, built from `main` by the same build path as staging, **stopped** until step 7. Environment variables, one explicit list: **copy every Production value from Vercel** except the rows marked "Never set" in the variables table (the ones Vercel sets itself), and **never copy `VERCEL_OIDC_TOKEN`**. `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` are *not* in that group: they are real settings and are copied (3D render). With these specifics:
     - Same `SESSION_SECRET` as production on Vercel, or everyone is signed out. Same `KEYRING_SECRET` and the production databases.
     - **Storage: `STORAGE_BACKEND=r2` plus `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (and `R2_ENDPOINT` if set)**, and **keep `BLOB_READ_WRITE_TOKEN`** (the dual read keeps old Blob URLs working). Check the bucket's CORS lists `https://particl.si`. See "Production specifics".
     - **`DISPATCH_MODE=inngest` with `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`**, `INNGEST_SERVE_ORIGIN=https://particl.si` and `INNGEST_STREAMING=true`. Copy the keys before disconnecting Inngest's Vercel integration. Re-pointing steps are in "Production specifics".
     - The engine and assistant keys production uses (the long "Engine and assistant keys" row), and `AI_GATEWAY_API_KEY` (**OWNER** creates it on Vercel's AI Gateway page).
     - `RESEND_API_KEY`, `RESEND_BASE_URL` (if set), `MAIL_FROM=hello@particlstudio.com`. Nothing changes in the `particlstudio.com` DNS.
     - Stripe as live today: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENT_PROVIDER` as production has it. Same URL, same `STRIPE_WEBHOOK_SECRET`, nothing to change in Stripe.
     - `TURSO_API_TOKEN`, `TURSO_API_URL`, `TURSO_ORG`, `TURSO_GROUP`.
     - `LIVEBLOCKS_SECRET_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.
     - `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` and `ASTRA_BLENDER_SNAPSHOT_ID` (the Astra Blender render runs in a Vercel Sandbox and needs all four; the Vercel project must stay).
     - The pricing and cap variables as production has them; `ENGINE_MOCK` unset.
     - `PARTICL_DEPLOYMENT=production`, `CREDIT_USD=0.10`, `SELFHOST_BEHIND_PROXY=1`, `APP_ORIGIN` / `APP_URL` / `NEXT_PUBLIC_APP_URL` = `https://particl.si`, and `CRON_SECRET` (fresh, or production's own).
     - `TRUST_CF_CONNECTING_IP=1` **only after** the firewall check in step 5 passes (step 6).
     - **Untick Build Variable on every one** except `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.
   - Domain `https://particl.si`; no scheduled task yet. Leave it **stopped**: production workspaces must not be reconciled by two hosts.
4. **Cloudflare, ahead of the switch (OWNER, with the advisor).**
   - `particl.si` is already a Cloudflare zone; if it is not, **stop** and tell Claude.
   - SSL/TLS mode **Full (strict)**; **Always Use HTTPS** on. **Bot Fight Mode must be OFF** (WAF skip rules cannot bypass the free Bot Fight Mode; add skip rules for `/api/worker` and `/api/inngest` only for the other WAF rules), so the app's own hand-off and Inngest's signed calls are never challenged.
   - **Certificate on the server's proxy for `particl.si` and `*.particl.si`.** Two ways: a **Cloudflare Origin Certificate** (SSL/TLS, Origin Server, Create Certificate; valid up to 15 years, nothing to renew, trusted only by Cloudflare), or Let's Encrypt through a DNS challenge. **Recommended: the Origin Certificate.** Why: Coolify's own Let's Encrypt resolver uses the HTTP-01 challenge, and Cloudflare forwards HTTP-01 challenges, so the firewall does not block them, but **Always Use HTTPS** (or another redirect or rule) can get in the way of renewals; the DNS challenge avoids that but needs a Cloudflare API token on the server, and the Origin Certificate needs neither. Install: save the certificate and key as files in the proxy's certificate directory (Coolify: under `/data/coolify/proxy/`, mounted into Traefik) and point a Traefik dynamic-config file at them as the **default certificate** (verify the paths in your proxy compose). Never paste the private key into chat, the repo or this file.
   - **Before step 7, prove it on staging:** proxy the `staging.particl.si` record (orange cloud) under Full (strict), using the `*.particl.si` Origin Certificate. Confirm `curl -sI https://staging.particl.si/` answers **200, not 526**. For staging either issuer is fine under Full (strict): it got a Let's Encrypt certificate while its record was DNS-only, so `-servername staging.particl.si` will report Let's Encrypt. To test the proxy's **default** certificate, with the production app still **stopped**, run `openssl s_client -connect <server IPv4>:443 -servername particl.si </dev/null 2>/dev/null | openssl x509 -noout -issuer`: it must name Cloudflare as the issuer (the Origin Certificate served as the default). If it shows something else, the default certificate is not set up: fix that first.
   - Optional hardening: **Authenticated Origin Pulls** (Cloudflare presents a client certificate and Traefik requires it), on top of the firewall.
   - Check that **no MX record points at a proxied name** (mail names must be DNS-only, grey cloud; Cloudflare does not proxy mail).
   - The `particl.app` redirect rule (Option A) can be created now, ahead of time; it does nothing until the records point at the server.
   - Lower the TTL of the records to be changed (step 7) **a day ahead**, and **write down the current Vercel records** (all four names: type, value, TTL, proxy status).
5. **Firewall: only Cloudflare can reach the server (OWNER applies it).**
   - **Use the provider's firewall (Hostinger hPanel) as the primary path.** **Plain `ufw` is not enough:** on a Docker host, Docker publishes ports (Traefik's 80 and 443, the platform's dashboard ports 8000, 6001 and 6002) by its own rules ahead of ufw, so ufw rules do not filter them and the server stays reachable around Cloudflare.
   - *Advanced alternative:* rules in Docker's `DOCKER-USER` chain (or `ufw-docker`). Three traps: it needs an `ESTABLISHED,RELATED` return rule, or the containers' own outbound calls (Turso, Blob, the engines) break; rules see the **container** port after Docker's address translation, so match on `--ctorigdstport` (published 8000 appears as 8080 inside); and IPv6 needs the same rules in `ip6tables`. Only use it if you know these.
   - **Default-deny all inbound.** Then allow: **80 and 443 only from Cloudflare's IPv4 and IPv6 ranges** (https://www.cloudflare.com/ips/); **8000, 6001 and 6002 only from the owner's own addresses, or closed**; **SSH (22) only from the owner's own addresses**. **Keep the provider's console access (VNC or web console) available** in case the allowlist locks the owner out.
   - **If hPanel cannot make IPv6 rules:** block IPv6 inbound entirely and add **no AAAA record** for any of the four names.
   - **Check from an outside network** (not the server, not the owner's allowed address, for example a phone on mobile data): `curl -m 10 -sI https://<server IPv4>/ -k`, the same to `https://[<server IPv6>]/ -k`, and `curl -m 10 http://<server IPv4>:8000/`, `:6001` and `:6002` must all **time out**, while a proxied name still answers.
6. **App environment, and the app starts just before step 7 (OWNER, in the platform).** Only after the step 5 check passed: set `TRUST_CF_CONNECTING_IP=1` on the production app (with `SELFHOST_BEHIND_PROXY=1`); confirm `PARTICL_DEPLOYMENT=production`, `CREDIT_USD=0.10` and `AI_GATEWAY_API_KEY`. Start the production app **just before step 7**, after the firewall, and check its health. Add the scheduled task `cron-sync` now but keep it **disabled** until step 9 (no cron yet).
7. **Switch DNS (OWNER's "go", in Cloudflare).** Change all four names, **proxied** (orange cloud): `particl.si` A (+ AAAA only if IPv6 is filtered, see step 5) to `<server IPv4>` (`<server IPv6>`); `www.particl.si` CNAME to `particl.si`; `particl.app` and `www.particl.app` as in the DNS records table above, with the **redirect rule** from Option A (308 to `https://particl.si`, path and query kept). Mail records are not touched.
8. **Checks (right after).** `curl -sI https://particl.si/` answers 200; the redirect checks in "Checks after the change"; `ops/selfhost/smoke.sh https://particl.si`; **sign in** in a browser; **a price shows** (a plan or Make price reads `N cr`); **no paid press**: do not click anything that starts a paid render, including an Astra Blender render; instead check that the render page loads and that the sandbox credentials are present (the command in "Production specifics"); an unsigned `GET /api/inngest` answers 200 with `function_count` above 0 and `has_signing_key: true`, not the 503 "not configured". **From an outside network:** direct requests to the server's IPv4, its IPv6 and ports 8000, 6001 and 6002 **time out** (the step 5 check again, now with live traffic).
9. **Cron moves.** Enable `cron-sync` on the server and read its log for `cron-sync: 200` on at least two runs. **Only then OWNER disables the Vercel cron.** For a short while both run: that overlap is brief and the heartbeat's lease handles it; do not leave it so.
10. **Watch window.** Two weeks. Watch health, the log line `[client-ip] ... one shared bucket` (a header setting is wrong), the cron heartbeat, 5xx, the Inngest dashboard (failed syncs and runs), and **`dispatch.refused`** in the app log (it means the app's hand-off to `/api/worker` is being challenged or refused: check Bot Fight Mode and the WAF). The Vercel deployment stays in place for the whole window.
11. **Rollback (any time before the window ends).** In Cloudflare, restore the four records and their **proxy status** to the values written down in step 4 (Vercel's are usually DNS-only, grey cloud). Disable `cron-sync` on the server and re-enable the Vercel cron; stop the production app. Leave the Vercel deployment and its domain settings untouched for two weeks so the old site is a working target. Re-enable the Inngest Vercel integration's sync for the project and **re-sync the app** in the Inngest dashboard so it points at the Vercel deployment again. **Never use Instant Rollback to a Vercel deployment from before #524** (it predates the credit switchover and would bill the wrong price). After the window: retire the Vercel deployment and domains (keep the team, project and snapshot) and rotate exposed keys (see the gates below).

## Gates still ahead before any cutover (SOW section 4)

Gates 1 to 5 are step 0 of "Cutover order": each is passed, or waived by the owner in writing. Gate 6 happens after the cutover and gate 7 is not a blocker. The Cloudflare certificate and firewall items that used to be listed here are now steps 4 and 5.

1. **P2 finish:** the platform's keys saved, dashboard domain, GitHub App, real visitor addresses (the sign-in lockout depends on it), outside monitor, VPS snapshots.
2. **P3 media:** R2 switched on (`/api/health` says r2-configured), media domain with signed links, thumbnails and posters; Blob downloads near zero.
3. **P4 beside Vercel:** the fixes above (the four hotfix PRs in step 2); **self-hosted Inngest** sized for 1,000 jobs with per-plan limits (Invite 2, Studio 5, Agency 15, Production 50); `staging.particl.si` with **all 12 smoke checks** (those include sign-in and a paid run, which need the fixes first).
4. **The 1,000-job load test** passes on staging.
5. **The credit switchover is done on Vercel first** (`CREDIT_USD` 0.10), and the already-converted database is the one the new host uses.
6. **After cutover:** cron moved (step 9), two weeks of watching, then the Vercel deployment and domains retired (**keep the Vercel team, project and snapshot**: Astra renders run there), and exposed keys rotated. **Blob is retired only after every old Blob object has been copied to R2 (gate 2)**, because the dual read needs `BLOB_READ_WRITE_TOKEN` until then.
7. **P8 many clients (later, not a blocker):** worker container, legacy-path guard, load test, error tracking.

Remotion is not part of any of this.
