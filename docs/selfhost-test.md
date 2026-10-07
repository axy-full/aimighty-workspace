# Self-hosted test address (Coolify on the VPS)

Status: prepared 7 Oct 2026 on branch `ops/selfhost-test-address`. **Files only**: nothing here has been built in Docker (the preparing machine has none), and nothing in Vercel, Cloudflare, DNS, Turso, hPanel or Coolify has been touched. The owner runs every step below.

This is the first half of SOW Phase 3 step 3 ("P4 beside Vercel"): the same app, built from `main`, running at a **test address** next to the live Vercel site. It is not the cutover. Production DNS does not move.

> **LOUD WARNING: databases.** The test address must point at **STAGING databases, never production.** A copy of the platform database and of one or two workspace databases made for this purpose. The older runbook (handover Part C, step 11 of P4) said staging may share the live database; that is **not** what this test does. Reasons: the test host has different `CREDIT_USD` handling during the switchover, it can create workspace databases through the Turso API, and a mistake would write rows into live customer data. If there is no staging copy yet, stop at "Before you start".

> **LOUD WARNING: nothing may spend.** `ENGINE_MOCK=1` on the test address, always. Do not enter real engine keys there unless a later gate says so.

## What is in the branch

| File | What |
|---|---|
| `ops/selfhost/Dockerfile` | Multi-stage, Node 24 (bookworm-slim), `npm ci`, `next build` with standalone output, non-root user (uid 1001), port 3000, HEALTHCHECK on `/api/health`. |
| `.dockerignore` (repo root) | Keeps `.git`, `.env*`, docs, tests, design, ops, `node_modules` out of the build context. At the repo root because that is where every builder looks for it. |
| `next.config.ts` (one line) | `output: "standalone"` only when `NEXT_OUTPUT=standalone`. The Dockerfile sets it. **Vercel never sets it, so Vercel builds are unchanged.** |
| `ops/selfhost/smoke.sh` | Read-only curl checks (see "Smoke test"). |
| `ops/selfhost/proposed/proxy-site-loop.patch` | A proposed fix for a real defect found while testing (see "Findings"). Not applied. |
| `docs/selfhost-test.md` | This file. |

The existing `app/api/health/route.ts` is used for the health check; no product code was added.

The `postinstall` (`scripts/copy-pdf-worker.mjs`, `scripts/copy-ocr-worker.mjs`) runs inside `npm ci` in the image's first stage, and the resulting `public/vendor/*` is copied into the build and run stages. `smoke.sh` checks that a worker file is served.

## Findings (read before building)

These came from a real local standalone build (Turbopack, no secrets) started with `node .next/standalone/server.js`.

1. **The build needs no secrets.** `next build` with only `ENGINE_MOCK=1 NEXT_TELEMETRY_DISABLED=1` succeeds. There is no prebuild seed step on `main` (`scripts/ops/preview-seed.cjs` does not exist there).
2. **Home page redirect loop (signed-out visitors).** On a self-hosted Next server, `/`, `/pricing`, `/studio`, `/business`, `/viral`, `/atomik`, `/workspace` answer `308 -> /` forever for anyone without a session cookie. Cause: `proxy.ts` rewrites those paths to `/site/...`, and on a self-hosted server the rewritten request passes through the proxy again, where the "`/site` is internal, redirect to the real path" rule fires. Vercel does not re-enter the proxy, so the live site is fine. Proposed fix (tested locally: `/`, `/pricing`, `/studio` all 200, `/site` still redirects): `ops/selfhost/proposed/proxy-site-loop.patch` (a marker request header set on the rewrite and checked by the redirect rule). This is product code on the public site; the owner decides. Until it is merged, `smoke.sh` will **fail its "home /" check** on the test address, correctly.
3. **Sign-in and every form post answer 403 behind a proxy.** `lib/auth.ts` line 239 compares the browser's `Origin` header with `new URL(req.url).origin`. On a self-hosted Next server that URL is built from the listen address (`http://localhost:3000`), not the public host, so it never matches `https://test.<domain>`. (Vercel's Next build turns on an internal `trustHostHeader` setting by itself; it is not a public option and cannot be set from `next.config.ts`; it is dropped by the config schema, tried and confirmed.) This is the same blocker recorded in handover Part C ("the sign-in fix inside Docker"). Proposed fix, **not applied and not tested** (sign-in code, owner-gated; an attempt to edit it here was refused by the permission system, which is right): also accept `Origin` equal to `APP_ORIGIN` when that variable is set, in `withTenant`. Until then, the test address works for **signed-out pages and read-only checks only**; no one can sign in there. That is enough for the smoke test and for judging speed and the look of the public pages.
4. **Health is 503 until storage is configured.** `/api/health` reports `storage: "missing"` in production unless `BLOB_READ_WRITE_TOKEN` or `STORAGE_BACKEND=r2` (+ R2 names) is set, even with a healthy database. The public answer carries no secrets (ok, mock, dispatch mode, database ok, storage ok), and no commit sha (that appears only to signed-in callers, as `VERCEL_GIT_COMMIT_SHA`, which is `local` on this host).
5. **`HOSTNAME=0.0.0.0` is set in the image** so the container listens on all interfaces. Coolify does not need a port mapping; it proxies to 3000.
6. **Dispatch.** With `DISPATCH_MODE` unset in production, background work is handed to `APP_ORIGIN/api/worker` (native mode), i.e. out through Cloudflare and back. On the test address this is harmless under `ENGINE_MOCK=1`. Self-hosted Inngest comes in P4.
7. **Workspace databases on disk.** If the Turso API variables are set, new workspaces create real Turso databases in the organisation. Do **not** set `TURSO_API_TOKEN` / `TURSO_ORG` on the test address unless they point at the staging organisation or group.

## Before you start (owner)

- [ ] A **staging copy** of the platform database and the workspace databases you want to look at (and its token). Not production.
- [ ] The test hostname chosen: `test.<domain>` (a subdomain of a domain you control in Cloudflare). Write it here for yourself: `test.__________`.
- [ ] Vercel's environment values open in another tab (you copy values yourself; they never go into chat, the repo or a note).
- [ ] Coolify reachable and the GitHub source connected (handover Part C, P2).
- [ ] You know that the DNS record in step 8 below is a change you make, and that nobody else does it.

## Platform settings checklist

| Setting | Value |
|---|---|
| Resource type | New resource, Application, from GitHub: `axy-full/aimighty-workspace` |
| Branch | `main` |
| Build pack | **Dockerfile** |
| Base directory | `/` (the repo root, so the build context contains `package.json`) |
| Dockerfile location | `/ops/selfhost/Dockerfile` |
| Ports exposed | `3000` |
| Domain | `https://test.<domain>` (placeholder; the owner picks) |
| Health check | Enabled. Path `/api/health`, port `3000`, method GET, expected status `200`, start period 40 s. (The image also carries its own HEALTHCHECK.) |
| Persistent storage | One volume, destination `/app/.data` (small; holds local uploads, chunks and the platform file DB only if local files are used) |
| Resource limits | Memory `4g`, CPUs `2` for the test (the build needs more than the runtime: if the build is killed, raise the build server's memory or add swap, which is already 8 GB) |
| Build variables | Tick **Build Variable** on `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` only (they are baked in at build time). Nothing secret should be a build variable. |
| Auto deploy | **Off** for the test (deploy by hand) |
| Cloudflare | Test record added in step 8, proxied, SSL/TLS stays Full (strict) |

## Scheduled jobs

`vercel.json` defines exactly one cron.

| Vercel cron | Schedule | Purpose | On the test address |
|---|---|---|---|
| `GET /api/cron/sync` | `*/10 * * * *` | The platform heartbeat: reconciles every workspace (pending render sync, held jobs, training identities, storage sizes, deletion retries, expired upload reservations, pipeline and canvas wake-ups, recovery drain). Records its own last-run heartbeat for `/api/health`. | **Leave it off.** Under `ENGINE_MOCK=1` against a staging copy there is little to reconcile, and a second heartbeat beside Vercel's would be a second writer on shared state. Turn it on only if the staging databases are not also served by a Vercel preview. |

If you do want it (Coolify: the app, Scheduled Tasks, add), command runs **inside** the container, schedule `*/10 * * * *`, name `cron-sync`:

```
node -e "fetch('http://127.0.0.1:3000/api/cron/sync',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>process.exit(r.ok?0:1))"
```

The route reads the `Authorization: Bearer <CRON_SECRET>` header (name `CRON_SECRET`; its value stays in Coolify's environment and is read inside the container, never typed into the task). It answers 401 without it, which `smoke.sh` relies on. The route is allowed 300 s; the first runs on a copy can be slow.

## Storage

What the app writes:

| What | Where | Notes |
|---|---|---|
| Media (renders, uploads, thumbnails, stills, audio, 3D files), per workspace under `ws/<workspace>/...`, plus platform assets and pending upload chunks | **Vercel Blob** today (`BLOB_READ_WRITE_TOKEN`); **R2** when `STORAGE_BACKEND=r2` (adapter built, Blob kept as read fallback, `docs/r2-migration.md`); local disk when `STORAGE_BACKEND=local` | Backend choice is `lib/storage/backend.ts`. Media plays through private, short-lived signed links. |
| Local files | `/app/.data/generations`, `.data/platform`, `.data/uploads`, `.data/chunks` | Only used on the local backend or as scratch. The `/app/.data` volume covers it. |
| Platform database | Turso (`PLATFORM_DATABASE_URL`, with `TURSO_DATABASE_URL` as fallback) or a local file | Accounts, memberships, sessions, billing ledger pointers. **Staging copy on the test address.** |
| Workspace databases | One Turso database each (or files under `WORKSPACE_DB_DIRECTORY`, default `.data`) | Created through the Turso API when `TURSO_API_TOKEN` + `TURSO_ORG` are set. |

**Choice for the test address (nothing is switched by this branch):**

| | Keep Vercel Blob for the test | Use R2 now (P3 early) |
|---|---|---|
| For | One thing changes at a time: the host. Same media, same links, nothing to copy, easy rollback. Smoke test can read existing staging media. | Proves the real target storage on the real target host; R2 is the SOW's plan for P3 and has no egress charge. |
| Against | The test host pulls media from Vercel Blob (egress, slower from the VPS). Blob is retired after cutover anyway. | Needs a separate **test** bucket, CORS for `https://test.<domain>`, and the copy tool run first (`docs/r2-migration.md`); two changes at once make a failure harder to place. Per the SOW, R2 comes in P3, **before** this step; if P3 has not passed its gate, do not use R2 here. |
| Recommendation | **Blob for the first test**, with a **staging** Blob store (never the live store: an upload or a delete on the test address would touch live media). Move to R2 when P3 is done. | |

Never point the test address at the live Blob store or the live R2 bucket.

## Environment variable names

Names only. Values are copied by the owner from Vercel (Settings, Environment Variables) into Coolify's Developer view for this app. Found by searching `process.env.` and `env.` across `app/`, `lib/`, `scripts/`, `mcp/`, `proxy.ts`, `instrumentation.ts` and `next.config.ts`; `vercel.json` sets none.

"Same as Vercel" means copy the same value Vercel's **staging/preview** environment uses (not production's, where they differ for databases and keys). "Test-only" means a value made for this test.

### Required

| Name | Purpose | Value |
|---|---|---|
| `ENGINE_MOCK` | `1` makes every engine call a mock so nothing spends. | Test-only: `1` |
| `APP_ORIGIN` | Canonical https origin used for links, mail and the worker hand-off. | Test-only: the test address |
| `NEXT_PUBLIC_APP_URL` | The same origin for the browser build (**build variable**). | Test-only: the test address |
| `APP_URL` | Same origin, read by some server code. | Test-only: the test address |
| `PLATFORM_DATABASE_URL` | Platform database. **STAGING copy, never production.** | Test-only (staging) |
| `PLATFORM_AUTH_TOKEN` | Token for that database. | Test-only (staging) |
| `TURSO_DATABASE_URL` | Fallback database URL some code reads. **STAGING.** | Test-only (staging) |
| `TURSO_AUTH_TOKEN` | Token for it. | Test-only (staging) |
| `KEYRING_SECRET` | Decrypts stored workspace keys and database tokens. Must be the value that sealed the **staging copy** (30+ characters). Never rotate. Stop if blank. | Same as the source of the staging copy |
| `SESSION_SECRET` | Signs session cookies. | Test-only (a fresh value, so test sessions cannot work on production) |
| `CRON_SECRET` | Bearer secret for `/api/cron/sync` and `/api/worker`. | Test-only (fresh) |
| `SUPER_ADMIN_EMAIL` | Who may use platform admin routes. | Same as Vercel |
| `STORAGE_BACKEND` | `blob`, `r2` or `local`; unset means `blob` when the Blob token is set. | Test-only: unset or `blob` |
| `BLOB_READ_WRITE_TOKEN` | Media storage token. **Staging store, not live.** | Test-only (staging) |
| `CREDIT_USD` | Dollar value of one credit. **Must be `0.10` on the new host.** | Test-only: `0.10` |
| `NODE_ENV` | Set by the image (`production`). | Do not add |
| `PORT`, `HOSTNAME` | Set by the image (`3000`, `0.0.0.0`). | Do not add |

### Optional (leave out for a first test unless you need the feature)

| Name | Purpose | Value |
|---|---|---|
| `DISPATCH_MODE` | `native` (default in production), `inngest`, or inline. | Test-only: leave unset |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Only for `DISPATCH_MODE=inngest` (self-hosted Inngest is P4). | Test-only |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | R2 adapter, only with `STORAGE_BACKEND=r2`. A **test** bucket. | Test-only |
| `TURSO_API_TOKEN`, `TURSO_API_URL`, `TURSO_ORG`, `TURSO_GROUP` | Creates new workspace databases. **Leave out** (see finding 7). | Test-only if ever set |
| `WORKSPACE_DB_DIRECTORY` | Folder for file-based workspace databases. | Leave unset (`.data`) |
| `RESEND_API_KEY`, `RESEND_BASE_URL`, `MAIL_FROM` | Email (invitations, resets). Leave out so the test address sends no mail. | Test-only: leave unset |
| `PAYMENT_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments. Leave out. | Test-only: leave unset |
| `CREDIT_PACKS`, `CREDIT_MARGINS`, `SIGNUP_CREDITS`, `PLATFORM_ALLOWANCE_USD`, `ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD` | Pricing and spending caps. | Same as Vercel |
| `LIVEBLOCKS_SECRET_KEY` | Live board collaboration. | Same as Vercel (or leave out) |
| `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | Web push. | Leave out |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROMPT_MODEL`, `ANTHROPIC_PROMPT_EFFORT`, `AI_GATEWAY_BASE_URL`, `GATEWAY_PROMPT_MODELS`, `REFINE_PROVIDER` | Assistant and prompt writer. Not needed under mocks. | Leave out |
| `HF_API_KEY_ID`, `HF_API_KEY_SECRET`, `HF_CREDENTIALS`, `HF_CREDENTIALS_PREVIOUS`, `HF_CREDENTIAL_ALIASES`, `HF_POOL_SIZE`, `HF_POOL_WORKSPACE_SHARE`, `HF_CONSUMER_CLIENT_ID`, `HF_CORRELATION_HEADER`, `HF_CINEMA_STUDIO_ENABLED`, `HF_CONSUMER_VIDEO_ANALYSIS_ENABLED`, `HF_SOUL_CHARACTER_ENABLED`, `HF_SOUL_CHARACTER_USD_720P`, `HF_SOUL_CHARACTER_USD_1080P` | Video and image engine account and its switches. Real keys mean real spend: leave out. | Leave out |
| `GEMINI_BASE_URL`, `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`, `ARK_BASE_URL`, `ARK_TEXT_MODEL`, `XAI_BASE_URL`, `XAI_MODEL`, `XAI_RATE_USD_PER_MTOK`, `FAL_TRAINER`, `FAL_TRAIN_STEPS`, `FAL_TRAIN_USD_PER_STEP`, `FAL_RENDER_USD_PER_MP`, `ELEVEN_MUSIC_CREDITS_PER_MINUTE`, `ELEVEN_SFX_CREDITS` | Other engine endpoints and unit costs. | Same as Vercel (rates) or leave out |
| `ASTRA_BLENDER_SNAPSHOT_ID`, `ASTRA_BLENDER_RATE_CARD`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_OIDC_TOKEN` | 3D blocking runs in Vercel Sandbox. Leave out on the test address. | Leave out |
| `BLOB_USD_PER_GB_MONTH`, `BLOB_USD_PER_GB_TRANSFER` | Storage cost display. | Same as Vercel |
| `RIG_AGENT_ENABLED`, `LEGACY_WORKSPACE_NAME` | Feature switch and the original studio's name. | Same as Vercel |
| `AIMIGHTY_URL`, `AIMIGHTY_TOKEN`, `PARTICL_URL`, `PARTICL_TOKEN` | Client settings for the MCP and rehearsal scripts. | Leave out |

### Never set on the self-hosted server

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL` (Vercel sets these itself; setting them on another host changes behaviour).

### Used only by scripts and CI, not by the running app

`PARTICL_BACKUP_*`, `PARTICL_ALLOW_STAGING_REHEARSAL`, `TURSO_CLI`, `CI_DEV_SOURCE_MAPS`, `WARM_BUDGET_MB`, `WARM_CAP_MB`, `PW_*`, `PWTEST_SHARD_WEIGHTS`, `GITHUB_*`, `RUNNER_TEMP`, `PHASE`.

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

It prints each time and exits 0 only if all pass. Validated here against a local standalone server (`localhost`, with a dummy storage value only so health could read ok): all 10 passed with the proxy patch applied; without it, `home /` fails (finding 2).

## Click by click (owner)

1. **Create the app.** Coolify, Projects, pick or create a project named "particl-test", Environment "test", New Resource, Application, Public or GitHub repository `axy-full/aimighty-workspace`, branch `main`, Build Pack: Dockerfile, Base Directory `/`, Dockerfile Location `/ops/selfhost/Dockerfile`, Port `3000`. Save. Do **not** deploy yet.
2. **Settings from the checklist.** Health check on (path `/api/health`), a persistent storage volume at `/app/.data`, memory limit `4g` and CPU limit `2`, auto deploy off.
3. **Enter the variable names.** Open the app's Environment Variables, Developer view. Add the **Required** names from the table above, copying values from Vercel's staging/preview environment where the table says "same", and the test-only values where it says "test-only". Tick Build Variable on `NEXT_PUBLIC_APP_URL`. Check: `ENGINE_MOCK=1`, `CREDIT_USD=0.10`, the databases and the Blob store are **staging**, `KEYRING_SECRET` is not blank. Delete any `VERCEL*` lines.
4. **Domain.** Under the app's General, Domains: `https://test.<domain>`. Save. (No DNS change yet.)
5. **Build.** Click Deploy. Watch the build log; the first build takes several minutes. It passes when the log ends with the container started and the health check going green. If it fails, copy the last 30 lines and send them to Claude (no variable values are printed by the build).
6. **Try it without a name first.** In Coolify's Terminal for the container, run `wget -qO- http://127.0.0.1:3000/api/health` (or open the app's logs). It should say `"ok":true`.
7. **Certificate.** The wildcard origin certificate from P2 covers `*.<domain>`; nothing to issue.
8. **DNS (owner's step; needs your own "go").** In Cloudflare, the zone for `<domain>`, DNS, add an `A` record: name `test`, value the VPS IP, **Proxied** (orange cloud). Nobody else makes this change. Wait a minute.
9. **Smoke test.** From your own computer, in the repo: `bash ops/selfhost/smoke.sh https://test.<domain>`. Every line should say PASS. Expect `home /` to FAIL until the proxy patch (finding 2) is merged, and sign-in to be unavailable until the origin fix (finding 3) is merged.
10. **Stop or roll back.** Nothing live is affected, so rolling back is: Coolify, the app, Stop (or Delete). To also remove the address: Cloudflare, DNS, delete the `test` record. Vercel and particl.si are untouched throughout.

## Gates still ahead before any cutover (SOW section 4)

1. **P2 finish:** Coolify keys saved, origin certificate, dashboard domain, GitHub App, Cloudflare-only firewall, real visitor addresses (the sign-in lockout depends on it), outside monitor, VPS snapshots.
2. **P3 media:** R2 switched on (`/api/health` says r2-configured), media domain with signed links, thumbnails and posters; Blob downloads near zero.
3. **P4 beside Vercel:** the fixes above (findings 2 and 3, plus the visitor-address header, `APP_ORIGIN` helper, 300-second cap, background work sent to the container's own address); self-hosted Inngest sized for 1,000 jobs with per-plan limits (Invite 2, Studio 5, Agency 15, Production 50); `staging.<domain>` with all 12 smoke checks (those include sign-in and a paid run, which need the fixes first). This test address is only the first, read-only part.
4. **P5 cutover:** only after the 1,000-job load test passes on staging; `CREDIT_USD` is 0.10 on Coolify and the credit switchover is done on Vercel first; the already-converted database is the one copied; cron moved (Vercel's cron disabled once the VPS task has run clean); rollback is one DNS change; two weeks of watching; then Blob retired and exposed keys rotated.
5. **P8 many clients:** worker container, legacy-path guard, load test, error tracking.

Remotion is not part of any of this.
