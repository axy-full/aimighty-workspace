# Self-hosted Particl: staging, production settings and the cutover

For the owner. The app runs in Coolify (Traefik v3 proxy) on the server **contabo**. DNS is on Cloudflare. **Files only:** nothing in Vercel, Cloudflare, DNS, Turso, Inngest, Stripe or the server is changed by this document. The owner runs every step, and **nothing in "Cutover order" happens without the owner's "go".**

**Where things stand (8 Oct 2026).**
- **Staging PASSED** on `release/1` at `c287f044`: Dockerfile build, served on a temporary sslip.io `https` address, `/setup` sign-in, workspace rename, an upload to the **staging R2 bucket** with its thumbnail, `/api/health` ok.
- **Switched 8 Oct 2026, about 16:10 IST.** `particl.si` and `www.particl.si` are served by the self-hosted production app; Vercel production stays deployed, untouched, as the fallback. See [Production switch, 8 Oct 2026 (as done)](#production-switch-8-oct-2026-as-done). `particl.app` and `www.particl.app` redirect through Cloudflare.
- **Owner's decision for the cutover:** `particl.si` and `www.particl.si` stay **DNS-only (grey cloud)**, as they are today with Vercel. Visitors reach the server directly, so Cloudflare's 100-second limit does not apply. Orange cloud comes later, only after every long flow is proven under 100 s (see the last "Later" section).
- Production on Vercel before the switch (and the fallback now): storage `r2-configured` (R2 for new files, old links still on Vercel Blob), `DISPATCH_MODE=inngest`, mail from `hello@particlstudio.com`, AI through the Vercel AI Gateway, Astra Blender renders in use (Vercel Sandbox).

**Owner's choices (8 Oct 2026). These settle the options further down; where a section offers (a) or (b), use what is written here.**
- **DNS:** grey cloud at cutover. Request durations are measured only before any later orange-cloud change.
- **Certificates:** no Cloudflare token. Skip the `letsencrypt-dns` resolver (Certificates (a)) and the label change in step 4.4; the production app keeps Coolify's own `letsencrypt` resolver. Use path **(b)**: on the owner's "go" the advisor changes DNS in the owner's browser, waits until `dig +short particl.si @1.1.1.1` and `@8.8.8.8` both show the server, then restarts the proxy (Coolify, Servers, Proxy, Restart) so Traefik asks Let's Encrypt again. Expect about a minute of certificate warnings. No redeploys between steps 4 and 8 (Let's Encrypt allows 5 failed checks per name per hour). On this path, before the DNS switch Traefik serves its own self-signed certificate, so: step 4.6 checks health only (no Let's Encrypt check); the pinned check in step 8 uses `curl -skI --resolve …` and looks only at the status; in step 9 restart the proxy **first** (do the switch-day Traefik read-timeout edit in the same restart), wait at least the lowered TTL, then run the `openssl` Let's Encrypt checks.
- **Firewall:** option **(a)**, Contabo's control-panel firewall, is **ON and verified**: inbound only TCP 22, 80 and 443 from anywhere; everything else is dropped (so UDP 443, 8000, 6001, 6002 and 8080 are closed). Skip option (b), its script and its systemd unit; firewall text further down that opens UDP 443 or limits 22 to the owner is superseded by this box.
  - **Dashboard through SSH:** `ssh -L 8000:localhost:8000 -L 6001:localhost:6001 -L 6002:localhost:6002 <user>@<server>`, then open `http://localhost:8000`. All three ports are needed: 6001 carries live updates and 6002 the terminal used in step 12 and the 3D test.
  - **Keys-only SSH (port 22 is open to everyone):** check `/etc/ssh/sshd_config.d/*.conf` first (a cloud-init file there may say `PasswordAuthentication yes`, and the first value read wins), set `PasswordAuthentication no` and `KbdInteractiveAuthentication no`, reload ssh, confirm with `sshd -T | grep -iE 'passwordauth|kbdinteractive|permitrootlogin'`, and test a key login in a second session before closing the first. Do **not** set `PermitRootLogin no`: Coolify signs in to this server as root with its key (`prohibit-password` is fine). Later, consider limiting 22 to the owner's and advisor's addresses in the same Contabo firewall.
  - **IPv6:** confirm from outside that `curl -6 -m 5 http://[<server IPv6>]:8000` does not answer (Docker publishes ports on IPv6 too; the Contabo rules must cover it).
  - Coolify's own SSH connection to this server stays on the server, so the Contabo firewall does not affect it.
- **Coolify (owner reports v4.4.1):** the advisor confirms the **Stop grace period** field is there (Advanced, Operations) and sets **Stop grace period = 300** and the Traefik read-timeout line on switch day.
- **Turso plan: Scaler.** Point-in-time restore window: **30 days** (Turso docs; check the figure once in the dashboard). That covers the 14-day watch, so restore points A and B stay usable for the whole rollback window.
- **`KEYRING_SECRET`:** the owner has production's exact value.
- **`AI_GATEWAY_API_KEY`:** the owner creates it.
- **Paid 3D test:** not on staging. One render on production after the cutover, only on the owner's "run".
- **Inngest app address:** the repo cannot show it (the serve route sets no address; Inngest's Vercel integration chose it). The owner checks it in step 5.
- **Nightly encrypted backup:** high priority, ideally live before the cutover. It needs the backup hotfix on `main` and the owner's settings (see the restore section).
- **Production app's environment (Coolify app `4dufbrykuka94cedlfjo3jxm`):** what is there now is wrong (`STORAGE_BACKEND=blob`, `DISPATCH_MODE=native`). Set it from the one list in [Switch-day env for the Coolify production app](#switch-day-env-for-the-coolify-production-app), including its "remove" list, before the app is first started in step 4.

**What `main` needs before it can run self-hosted:** the lead keeps that list in the description of PR #566.

Never write the server's IP, the sslip.io address or any secret value in the repo, a chat or a public place. This document names variables and where their values come from; it never holds a value that is secret.

## Production switch, 8 Oct 2026 (as done)

What actually happened, for the record and for the next switch. No secret values here; the restore-point files stay on the owner's machine.

**Certificate path (b)** was used (no Cloudflare token): DNS first, then a proxy restart.

**Code.** `main` at `1b05c2ca` (#575, #563, #564, #565 and #587 = #562 + #566 + `ARG APP_ORIGIN`). Vercel production ran the same commit, healthy, before the switch.

**Checks before the switch (production app, terminal).**
- Keyring check: `KEYRING OK` (`KEYRING_SECRET` equals Vercel's).
- Sandbox: the `node -e` SDK check cannot run in the image. `node -e` from `/app` fails with `ERR_MODULE_NOT_FOUND '@vercel/sandbox'` because Next bundles the SDK into the server chunks of the routes that use it (`/api/workbench/astra-blender/render`, `/api/inngest`, `/api/worker`, `/api/workbench/development`) instead of shipping it in `node_modules`. That is expected. Proof in a running container: `grep -rl 'v2/sandboxes/sessions' /app/.next/server | head -1` prints a chunk path. The credentials were checked instead through the Vercel API (project lookup with `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` = 200), and the snapshot in `ASTRA_BLENDER_SNAPSHOT_ID` exists in that project.
- `/api/health` pinned to the server: `ok:true`, `mock:false`, dispatch `inngest`, database ok, storage ok.
- Restore point A 10:36:26 UTC and restore point B 10:37:56 UTC (`turso db shell <db> .dump` of the platform database and the one workspace database, both non-empty).

**Production app settings (Coolify), as set.**
- Source `main`, Dockerfile build pack, port 3000, as staging.
- **Build arguments: "Managed manually in Dockerfile".** The Dockerfile declares `ARG APP_ORIGIN`, `ARG NEXT_PUBLIC_APP_URL`, `ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY`. To confirm the web-push public key was baked into the client build, run in the app's terminal: `grep -rlF "$NEXT_PUBLIC_VAPID_PUBLIC_KEY" /app/.next/static | head -1` (a path = baked; nothing = not baked, so Settings, Notifications cannot subscribe until it is rebuilt with the value passed at build).
- **sslip.io domains removed**; the domains are `https://particl.si,https://www.particl.si` only.
- **Auto deploy off: manual deploys only.**
- `MAIL_FROM=hello@particl.si` (Resend domain `particl.si` verified).
- Scheduled task `cron-sync` (`node /app/cron-sync.mjs`, every 10 minutes) enabled; first run Success at 10:41 UTC. Then **Vercel Cron Jobs disabled** (Vercel, the project, Settings, Cron Jobs).

**DNS and certificates (Cloudflare).**
- `particl.si` A to the server, `www.particl.si` CNAME to `particl.si`, both **DNS-only (grey)**, TTL 1 minute, no AAAA. Mail records untouched.
- Let's Encrypt certificate issued for `particl.si` (valid to 6 Jan 2027). `www.particl.si` answers **302** to `https://particl.si` with the path and query kept (the plan said 301 or 308; 302 works, and can be made permanent later).
- `particl.app` and `www.particl.app`: one Cloudflare **Redirect Rule** for all requests in the zone, dynamic `concat("https://particl.si", http.request.uri.path)`, **308**, query string kept. Their records are **proxied (orange) to `192.0.2.1`** (a documentation-only address; Cloudflare answers before any origin). `particl.app` is being removed from the Vercel project's domains.

**Inngest.** The app was re-synced to `https://particl.si/api/inngest` (7 functions). The Inngest Vercel integration was never connected, so there was no integration sync to switch off.

**Tests after the switch.**
- Owner: sign-in, uploads (old Blob files and new R2 files), reset email (from `hello@particl.si`, to the inbox, link `https://particl.si/reset/…`), Plans & credits shows "—" for the house workspace (it is billed in dollars by design).
- From outside, 11:39 UTC: DNS A only, no AAAA; Let's Encrypt certificate; `/api/health` 200 ok; home, `/login`, `/robots.txt` 200; sign-in with a wrong password 401; sign-in from a foreign origin 403; media without a session 401; `/api/inngest` without a signature 401; `particl.app` and `www.particl.app` 308 to `particl.si` with the query kept; HSTS header present.

**Rollback (as of 8 Oct).** In Cloudflare, `particl.si` A back to `216.150.1.1` and `www.particl.si` CNAME back to `b619d6cc43a31b33.vercel-dns-016.com` (Vercel's values, saved before the switch; `particl.si` is still listed in the Vercel project's domains). Inngest stays synced to `https://particl.si/api/inngest`: once DNS points back at Vercel that same URL reaches Vercel, so press **Resync** on that URL to refresh it. **Do not** sync to `https://www.particl.app/api/inngest` (the old URL): it now redirects through Cloudflare to `particl.si`. Re-enable Vercel Cron Jobs, disable `cron-sync`, and stop the self-hosted app one TTL later. `particl.app` redirects through Cloudflare, not Vercel, so it needs no change.

## What is in the repo

| File | What |
|---|---|
| `ops/selfhost/Dockerfile` | Node 24, `npm ci`, `next build` (standalone), non-root user, port 3000, HEALTHCHECK on `/api/health` using Node's fetch (the slim image has no curl). |
| `.dockerignore` | Keeps `.git`, `.env*`, docs, tests and `node_modules` out of the build. |
| `next.config.ts` | `output: "standalone"` only when `NEXT_OUTPUT=standalone` (the Dockerfile sets it; Vercel never does). |
| `ops/selfhost/cron-sync.mjs` | The scheduled task: calls `/api/cron/sync` inside the container with `CRON_SECRET` from the container's env. In the image at `/app/cron-sync.mjs`. |
| `ops/selfhost/smoke.sh` | Read-only curl checks (GET only, never signs in, never spends). |
| `ops/selfhost/proposed/proxy-site-loop.patch` | Withdrawn; do not apply. |

## Staging app (reference)

Staging is built and passing; this is what it is, so production can be built the same way.

| Setting | Value |
|---|---|
| Source | Public repository `https://github.com/axy-full/aimighty-workspace`, branch `release/1` (later `main`) |
| Build pack | **Dockerfile**, location `/ops/selfhost/Dockerfile`, base directory `/`, port `3000`. Build production the same way, so what was tested is what ships. |
| Health check | Leave Coolify's own check **off**; the image's HEALTHCHECK counts. |
| Persistent storage | One volume at `/app/.data` (fresh database files on staging; scratch only on production). |
| Limits | Memory `4g`, CPUs `2`. **Auto deploy off.** |
| Databases | Fresh files: `PLATFORM_DATABASE_URL=file:/app/.data/platform.db`, `TURSO_DATABASE_URL=file:/app/.data/legacy.db`, no auth tokens. **Never production's databases or `KEYRING_SECRET`** (the owner does not have the Preview keyring, so staging stays on fresh databases). |
| Secrets | `KEYRING_SECRET`, `SESSION_SECRET`, `CRON_SECRET` generated fresh (`openssl rand -base64 48`). |
| Storage | The **staging** R2 bucket (`STORAGE_BACKEND=r2` + the four `R2_*`). Never production's bucket. |
| Fixed | `ENGINE_MOCK=1`, `CREDIT_USD=0.10`, `PARTICL_DEPLOYMENT=staging`, `SELFHOST_BEHIND_PROXY=1`; `APP_ORIGIN`, `APP_URL`, `NEXT_PUBLIC_APP_URL` = exactly the https address staging is served on (changing it needs a rebuild). |
| Not set | `TURSO_API_*`, `RESEND_*`, `MAIL_FROM`, `STRIPE_*`, `INNGEST_*`, `DISPATCH_MODE` (so it dispatches natively), engine and AI keys; never `VERCEL`, `VERCEL_ENV` or `VERCEL_OIDC_TOKEN` (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` only for the 3D render test below). |
| First account | `/setup` right after the first deploy (the first account there becomes the platform owner). If `/setup` says it is complete and you did not do it: stop, wipe the volume, redeploy. |
| Scheduled task | Name `cron-sync`, command `node /app/cron-sync.mjs`, frequency `*/10 * * * *`, timeout 300 s. Its log should show `cron-sync: 200`. |
| Smoke | `bash ops/selfhost/smoke.sh <staging address>`: all checks pass. |

Only one workspace works on staging: with no `TURSO_API_*`, `lib/provision.ts` refuses to create workspace databases in production mode. That is expected.

Staging is public. Keep it stopped when not in use, or put Traefik basic auth in front.

## Live-copy settings for the production app

The production app is a second Coolify app on the same server, built from `main` exactly like staging, with domain `https://particl.si`. It is first started, then stopped, in cutover step 4 and runs from step 8.

How to read the table:
- **Copy from Vercel** means Vercel, the project, **Settings, Environment Variables**, the **Production** value.
- **Identical** means it must be the same value Vercel production uses, because it decrypts or verifies data already stored, or because it names the same account. "Any valid" means a new key for the same account works just as well.
- Every variable is a **runtime** variable. Only the two `NEXT_PUBLIC_*` names and `APP_ORIGIN` (not secret; `robots.txt` and `sitemap.xml` are generated at build) are also build variables: in Coolify tick **Build Variable** (newer versions: "Available at Buildtime") on those three and **untick it on every other variable**, so no secret reaches the build or the image history. On 8 Oct the production app's **Build arguments** setting was "Managed manually in Dockerfile"; see the check in [Production switch, 8 Oct 2026 (as done)](#production-switch-8-oct-2026-as-done) that the web-push key was baked in.

### Address and proxy

| Name | Value or source | Identical? |
|---|---|---|
| `APP_ORIGIN` | fixed: `https://particl.si` | yes |
| `APP_URL` | fixed: `https://particl.si`. No server code reads it any more (the held-renders email now uses `APP_ORIGIN`); keep it set, harmless | yes |
| `NEXT_PUBLIC_APP_URL` | fixed: `https://particl.si` (**build variable**) | yes |
| `SELFHOST_BEHIND_PROXY` | fixed: `1` | self-host only; never on Vercel |
| `PARTICL_DEPLOYMENT` | fixed: `production` (turns on the live-key and readiness guards Vercel gets from `VERCEL_ENV`) | self-host only |
| `TRUST_CF_CONNECTING_IP` | **unset.** Setting it to `1` without Cloudflare in front lets anyone fake their address and dodge every rate limit and the sign-in lock. It belongs only to the later orange-cloud step. | self-host only |
| `TRUSTED_PROXY_HOPS` | leave **unset** (means 1: the app counts the address Traefik itself saw, `lib/clientIp.ts`) | |
| `CREDIT_USD` | Vercel production's value, exactly (expected `0.10`; see the switch-day section) | **yes** |
| `ENGINE_MOCK` | **unset** (must not be `1` on production) | |

### Databases, keys that unlock stored data, admin

| Name | Value or source | Identical? |
|---|---|---|
| `PLATFORM_DATABASE_URL`, `TURSO_DATABASE_URL` | copy from Vercel (or Turso, the database, its URL) | **yes** (same databases) |
| `PLATFORM_AUTH_TOKEN`, `TURSO_AUTH_TOKEN` | copy from Vercel, or Turso, the database, **Create token** | any valid token for the same databases |
| `TURSO_API_TOKEN` | copy from Vercel, or Turso, **Settings, API tokens**, create | any valid (same organisation) |
| `TURSO_ORG`, `TURSO_GROUP`, `TURSO_API_URL` | copy from Vercel (names, not secrets; `TURSO_API_URL` only if set) | **yes** |
| `KEYRING_SECRET` | copy from Vercel, or the owner's own record | **yes, exactly.** It decrypts every workspace's database token and stored keys, two-step sign-in secrets and recovery codes, and pending invitation proofs. A different value makes all of those unreadable. |
| `SESSION_SECRET` | copy from Vercel, or generate `openssl rand -base64 48` | no. It only salts the anonymous labels used by rate limits and the sign-in lock; sign-in sessions are database tokens and survive a new value. A new value just restarts those counters. |
| `CRON_SECRET` | generate new: `openssl rand -hex 32` (a fresh value is fine; reason in the switch-day table) | no, but **required**: without it `/api/cron/sync` answers 401 in production and the health check's cron status goes stale. The server's own scheduled task reads it from the container. |
| `SUPER_ADMIN_EMAIL` | copy from Vercel | **yes** |
| `WORKSPACE_DB_DIRECTORY`, `OWNER_PRIVACY_SCRUB_LOCAL` | leave **unset** | |

### Storage (R2, old links on Blob)

| Name | Value or source | Identical? |
|---|---|---|
| `STORAGE_BACKEND` | fixed: `r2` | yes |
| `R2_ACCOUNT_ID` | copy from Vercel (Cloudflare dashboard, R2, account details) | **yes** |
| `R2_BUCKET` | copy from Vercel | **yes** (same bucket) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | copy from Vercel, or Cloudflare, **R2, Manage API tokens**, create an "Object Read & Write" token for that bucket | any valid pair for the same bucket |
| `R2_ENDPOINT` | copy only if Vercel sets it; otherwise unset (the app builds `https://<account>.r2.cloudflarestorage.com`) | yes if set |
| `BLOB_READ_WRITE_TOKEN` | copy from Vercel, or Vercel, **Storage**, the Blob store, its token | **yes (same store). Keep it:** with `STORAGE_BACKEND=r2` and this token, the app reads R2 first and falls back to Blob, so old links keep working. Without it they break. |
| `BLOB_USD_PER_GB_MONTH`, `BLOB_USD_PER_GB_TRANSFER` | copy from Vercel if set | yes |

Check the bucket's CORS list contains `https://particl.si`. The origin does not change, so nothing else in R2 changes. Without R2 or Blob, `/api/health` answers 503 (`storage: missing`) and anything kept on the container's disk is lost on the next deploy.

### Background work (Inngest)

| Name | Value or source | Identical? |
|---|---|---|
| `DISPATCH_MODE` | fixed: `inngest` | yes |
| `INNGEST_SIGNING_KEY` | copy from Vercel, or **Inngest dashboard**, the Production environment, **Manage, Signing Key** | **yes** (the environment's key) |
| `INNGEST_EVENT_KEY` | copy from Vercel, or **Inngest dashboard**, Production, **Manage, Event Keys** (a new event key is fine) | any valid key in the same environment |
| `INNGEST_SIGNING_KEY_FALLBACK` | copy only if Vercel has it (only during a signing-key rotation) | yes if set |
| `INNGEST_SERVE_ORIGIN` | fixed: `https://particl.si` (behind the proxy the SDK must not guess its own address) | |
| `INNGEST_STREAMING` | fixed: `true` (harmless with grey cloud; it keeps long steps under Cloudflare's 100 s limit once the names go orange later) | |
| `INNGEST_SERVE_PATH`, `INNGEST_ENV`, `INNGEST_DEV`, `INNGEST_BASE_URL` | leave **unset** (the route is `/api/inngest`) | |

`DISPATCH_MODE=inngest` only takes effect when both keys are set. The re-sync is cutover step 10.

### Mail

| Name | Value or source | Identical? |
|---|---|---|
| `MAIL_FROM` | fixed: `hello@particl.si` (changed 8 Oct; Vercel still sends from `hello@particlstudio.com`) | no, self-host value |
| `RESEND_API_KEY` | copy from Vercel, or Resend, **API Keys**, create one with sending access for `particl.si` (or **All domains**) | any valid |
| `RESEND_BASE_URL` | copy only if Vercel sets it | yes if set |

`particl.si` is **Verified** in Resend, **Domains** (8 Oct). Keep its Resend records, and the `_dmarc` TXT once the owner adds it, in the `particl.si` zone. Nothing changes in the `particlstudio.com` DNS.

### AI, engines, pricing

| Name | Value or source | Identical? |
|---|---|---|
| `AI_GATEWAY_API_KEY` | **OWNER creates** it: Vercel, **AI Gateway, API Keys**. On Vercel the gateway signs in with the deployment's own identity (OIDC), which does not exist off Vercel. Without this key Atomik drafts, prompt enhance and gateway stills fail. | new |
| `AI_GATEWAY_BASE_URL`, `GATEWAY_PROMPT_MODELS`, `REFINE_PROVIDER` | copy from Vercel if set | yes |
| Engine keys: `FAL_KEY`, `ELEVENLABS_API_KEY`, `ARK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `HF_CREDENTIALS` (or `HF_API_KEY_ID` + `HF_API_KEY_SECRET`), `HF_CREDENTIALS_PREVIOUS` | copy from Vercel whichever are set, or a new key from that vendor's dashboard | any valid (same vendor account) |
| Engine settings: `ANTHROPIC_PROMPT_MODEL`, `ANTHROPIC_PROMPT_EFFORT`, `ARK_BASE_URL`, `ARK_TEXT_MODEL`, `GEMINI_BASE_URL`, `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`, `XAI_BASE_URL`, `XAI_MODEL`, `FAL_BASE_URL`, `ELEVENLABS_BASE_URL`, `OPENAI_BASE_URL`, `HF_BASE_URL`, `HF_*` switches and pool settings | copy from Vercel whichever are set | yes |
| Prices and caps: `CREDIT_MARGINS`, `CREDIT_PACKS`, `SIGNUP_CREDITS`, `PLATFORM_ALLOWANCE_USD`, `ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD`, `XAI_RATE_USD_PER_MTOK`, `FAL_RENDER_USD_PER_MP`, `FAL_TRAINER`, `FAL_TRAIN_STEPS`, `FAL_TRAIN_USD_PER_STEP`, `ELEVEN_MUSIC_CREDITS_PER_MINUTE`, `ELEVEN_SFX_CREDITS`, `HF_SOUL_CHARACTER_USD_720P`, `HF_SOUL_CHARACTER_USD_1080P` | copy from Vercel whichever are set | **yes** (customers must see the same prices) |
| Switches: `RIG_AGENT_ENABLED`, `LEGACY_WORKSPACE_NAME` | copy from Vercel if set | yes |

### Billing, live boards, web push

| Name | Value or source | Identical? |
|---|---|---|
| `PAYMENT_PROVIDER` | copy from Vercel (unset means `manual`) | yes |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | copy from Vercel if set | yes. Card checkout is not wired in this code yet (`lib/payments.ts`): there is no Stripe checkout and no webhook route, so these only feed the readiness check. |
| `LIVEBLOCKS_SECRET_KEY` | copy from Vercel, or Liveblocks, the project, **API keys** | same Liveblocks project |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | copy from Vercel (**build variable**) | **yes** |
| `VAPID_PRIVATE_KEY` | copy from Vercel | **yes**, the pair must match. Browsers' notification subscriptions are tied to it. |
| `VAPID_SUBJECT` | copy from Vercel | yes |

### Astra Blender renders (Vercel Sandbox)

| Name | Value or source | Identical? |
|---|---|---|
| `ASTRA_BLENDER_SNAPSHOT_ID` | copy from Vercel (looks like `snap_...`) | **yes** |
| `ASTRA_BLENDER_RATE_CARD` | copy from Vercel | **yes** (it prices renders) |
| `VERCEL_TOKEN` | **OWNER creates** it: Vercel, **Account Settings, Tokens**, scoped to the team | new |
| `VERCEL_TEAM_ID` | Vercel, **Team Settings, General**, Team ID | yes |
| `VERCEL_PROJECT_ID` | Vercel, the project, **Settings, General**, Project ID (the project that owns the snapshot) | yes |

All three `VERCEL_*` names above are needed together; see "Astra Blender renders from the self-hosted host". The same token and team id also let workspace deletion revoke that workspace's gateway key (`lib/purge.ts`).

### Never set on the self-hosted app

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_*` (any), `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_OIDC_TOKEN`. Vercel sets these itself; on another host they switch the app into Vercel behaviour: `VERCEL` alone makes the app read client addresses the Vercel way (anyone can then fake them) and send the AI gateway an OIDC identity it does not have. **Never bulk-paste a `vercel env pull` file into Coolify:** it contains `VERCEL=1`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_*` and `VERCEL_OIDC_TOKEN`. Copy the names in the tables above one by one. Also not added: `NODE_ENV`, `PORT`, `HOSTNAME` (the image sets them) and the script-only names (`PARTICL_BACKUP_*`, `PW_*`, `AIMIGHTY_*`, `PARTICL_URL`, `PARTICL_TOKEN`).

### If Vercel will not show a value (Sensitive)

**Switch night: the "Where to get it" and "= Vercel?" columns of the switch-day table below supersede this table.**

Vercel never shows a **Sensitive** variable again, and `vercel env pull --environment=production` returns it **empty**. A pull is still the quickest way to see which ones are Sensitive: run it in a private folder outside the repo, copy what you need into Coolify, then delete the file. For a value that came back empty:

| Name | Safe path | What breaks if a new value is used instead |
|---|---|---|
| `KEYRING_SECRET` | The owner's own record. Nothing else has it. | **Everything sealed with it:** every workspace's database token (workspaces cannot open their data), stored workspace keys, two-step sign-in and recovery codes, pending invitations. **If there is no record, stop.** The code has no way to re-seal under a new keyring (`lib/keyring.ts` reads one secret). Moving would first need a planned rotation: a reviewed re-seal tool, run against the databases while Vercel is still live. |
| `VAPID_PRIVATE_KEY` (and its public key) | The owner's own record; the public key can also be read from the live site. Otherwise a new pair: see "Web push keys". | Notifications stop for everyone who turned them on, until they subscribe again on the new host (see "Web push keys"). Not data loss. |
| `BLOB_READ_WRITE_TOKEN` | Vercel, **Storage**, the Blob store, its token (unsure of the exact label). | No other value works (it is the store's own token). Without it, old Blob links break. If it cannot be found, do not cut over until every old Blob object is copied to R2 (`scripts/ops/blob-to-r2.mjs`, see "Before Vercel is cancelled"). |
| `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | Inngest dashboard (see the table above). | Nothing; these are the same keys. |
| `PLATFORM_AUTH_TOKEN`, `TURSO_AUTH_TOKEN`, `TURSO_API_TOKEN` | Create a new token in Turso. Creating does not cancel the old one, so Vercel keeps working. | Nothing. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Create a new R2 API token for the same bucket. | Nothing. |
| `RESEND_API_KEY`, `AI_GATEWAY_API_KEY`, engine keys | Create a new key in that vendor's dashboard. Do not **roll** or delete the old one while Vercel is the live site. | Nothing. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe dashboard, **Developers** (API keys, Webhooks). If Stripe only offers to roll the key, set an expiry for the old key so Vercel keeps working through the watch window. | Nothing today (card checkout is not wired). |
| `LIVEBLOCKS_SECRET_KEY` | Liveblocks dashboard, the same project. | Nothing. |
| `SESSION_SECRET` | Generate new. | Nothing that matters (see the table). |
| `CRON_SECRET` | Generate new. | Nothing: the server's scheduled task calls its own container with it, and Vercel Cron (which calls Vercel's own deployment with Vercel's value) is disabled at the switch. Check the cron heartbeat advances after the switch (step 13). |

## Switch-day env for the Coolify production app

The one list for the production app in Coolify (app id `4dufbrykuka94cedlfjo3jxm`). It holds the same names as "Live-copy settings" above, checked against every variable the code reads (the source list is at the end), and settles the values for switch day. Where the two differ, this section wins.

**Owner's facts for switch night (8 Oct 2026, switch at 23:30 IST = 18:00 UTC).** Vercel shows **Sensitive** values as hidden and they cannot be revealed; the owner's old env files are deleted. The owner has `KEYRING_SECRET` in his notes. Vercel production stays deployed as the fallback for 1 to 2 days after the switch, on the **same** databases, R2 bucket and Blob store. Grey cloud.

How to read the table:
- **Where to get it** names one source per row:
  - **(a) owner's notes**;
  - **(b) a provider dashboard or CLI**, with the click path (labels marked "check" could not be confirmed from the provider's current docs; look for the nearest equivalent);
  - **(c) Vercel reveal**: Vercel, the project, **Settings, Environment Variables**, the **Production** value, eye icon. Works only for a value that is **not** Sensitive; never for a secret that was saved as Sensitive;
  - **(d) generate fresh**: `openssl rand -hex 32` on your own machine, pasted straight into the app's env. Never into a chat or a file in the repo.
- **= Vercel?** is one of: **MUST equal Vercel** (with the reason: it unlocks or names something already stored), **fresh is fine** (a new value for the same account, store or database works, and making it does not cancel Vercel's), **fixed** (a value written here), or **self-host only**.
- **Never rotate, roll, revoke or delete a key Vercel production uses** while Vercel is the fallback: make an extra key instead. Never run `turso db tokens invalidate` (it would cut off Vercel and, for a workspace database, the token sealed in the platform database that both hosts use).
- **Build?** **yes** means tick **Build Variable** ("Available at Buildtime") as well; every variable is also a runtime variable. Untick it on every other row.
- Values in `code` are written in full and are not secrets. No secret value is written here. File and line references are to `release/1` at `24e969f1`.
- A row that says "only if Vercel sets it" is left out when Vercel does not have it (the code then uses its default). For a non-secret "only if set" row that Vercel hides, ask the lead before guessing.

| Name | Value | Where to get it | = Vercel? | Build? |
|---|---|---|---|---|
| `APP_ORIGIN` | `https://particl.si` (no slash or path after it) | written here | fixed | **yes** (`robots.txt` and `sitemap.xml` are made at build) |
| `APP_URL` | `https://particl.si` (read by `lib/held.ts` on `main` for held-render email links; required) | written here | fixed | no |
| `NEXT_PUBLIC_APP_URL` | `https://particl.si` | written here | fixed | **yes** |
| `SELFHOST_BEHIND_PROXY` | `1` | written here | self-host only | no |
| `PARTICL_DEPLOYMENT` | `production` | written here | self-host only | no |
| `PLATFORM_DATABASE_URL` | `libsql://<platform db>-<org>.turso.io`, never `file:` | (c) Vercel reveal; or (b) `turso db show <platform db> --url` | **MUST equal Vercel**: it is the platform database both hosts share | no |
| `PLATFORM_AUTH_TOKEN` | secret | (b) `turso db tokens create <platform db>`, or Turso dashboard, the database, **Create Token** (label: check) | **fresh is fine**: any full-access token for the same database; creating one does not cancel Vercel's | no |
| `TURSO_DATABASE_URL` | `libsql://<primary db>-<org>.turso.io`, never `file:` | (c) Vercel reveal; or (b) `turso db show <primary db> --url` | **MUST equal Vercel**: the legacy workspace's database (`lib/platform.ts` line 302 reads it instead of the row's `db_url`) | no |
| `TURSO_AUTH_TOKEN` | secret | (b) `turso db tokens create <primary db>`, or the dashboard as above | **fresh is fine** (same reason as `PLATFORM_AUTH_TOKEN`) | no |
| `TURSO_API_TOKEN` | secret | (b) `turso auth api-tokens mint particl-selfhost` (shown once), or Turso dashboard, **Settings, API Tokens**, create (label: check) | **fresh is fine**: it only creates and deletes workspace databases through Turso's Platform API (`lib/provision.ts`), in the same organisation. **Workspace database tokens are not env variables:** each one is minted when its workspace is created and kept sealed in the platform database (`workspaces.db_token_enc`, `lib/platform.ts` line 295), so there is nothing to copy for them | no |
| `TURSO_ORG` | organisation name | (c) Vercel reveal; or (b) `turso org list` | **MUST equal Vercel**: names the organisation the workspace databases live in | no |
| `TURSO_GROUP` | group name | (c) Vercel reveal; or (b) `turso group list` | **MUST equal Vercel**: new workspace databases are created in it | no |
| `TURSO_API_URL` | only if Vercel sets it | (c) | equal if set | no |
| `KEYRING_SECRET` | secret | **(a) owner's notes** (nothing else has it; Vercel hides it) | **MUST equal Vercel, exactly**: it decrypts every workspace's database token (`workspaces.db_token_enc`) and stored keys, two-step sign-in secrets and recovery codes, and pending invitation proofs. A different value makes all of those unreadable. There is no fresh option (`lib/keyring.ts` reads one secret) | no |
| `SESSION_SECRET` | secret | (d) `openssl rand -hex 32` | **fresh is fine**: it only salts the anonymous labels used by rate limits and the sign-in lock; sign-in sessions are database tokens and survive. A new value restarts those counters | no |
| `CRON_SECRET` | secret | (d) `openssl rand -hex 32` | **fresh is fine.** The server's scheduled task calls its own container, `http://127.0.0.1:3000/api/cron/sync`, with the container's own `CRON_SECRET` (`ops/selfhost/cron-sync.mjs` lines 4 to 8), and the route checks it against that same container's env (`app/api/cron/sync/route.ts` lines 38 to 43). Vercel Cron calls Vercel's own production deployment (a `*.vercel.app` address, per Vercel's docs), never this server, and it is disabled at the switch (step 8). The only other reader is native dispatch's POST to `/api/worker` (`lib/dispatch.ts` line 147), which is not used: with `DISPATCH_MODE=inngest` and both Inngest keys set, `dispatchMode` (line 85) answers `inngest`. Required: without it the route answers 401 and `cron-sync` exits with code 2 | no |
| `SUPER_ADMIN_EMAIL` | an address | (c) Vercel reveal, or the owner knows it | **MUST equal Vercel**: it names the platform admin | no |
| `CREDIT_USD` | e.g. `0.10` | (c) Vercel reveal. If Vercel hides it, read the ledger's recorded unit **read-only**: `turso db shell <platform db> "SELECT unit_usd, paused_since FROM billing_unit WHERE id=1"` (table and columns: `lib/ledgerUnit.ts`, `LEDGER_UNIT_SCHEMA` and `ledgerUnitTx`) | **MUST equal the ledger's unit** (`unit_usd`), which is what Vercel runs at. Paid work is admitted only while `CREDIT_USD` equals that unit (`ledgerOpenTx`); any other value pauses all paid work. Expected `0.1` (owner's decision of 5 Oct), but particl.si ran `0.80` from 3 Oct (`lib/creditConversion.ts`), so read it, do not assume it. If `paused_since` is not empty, Vercel itself is paused right now: stop and ask the lead | no |
| `STORAGE_BACKEND` | `r2` | written here | fixed | no |
| `R2_ACCOUNT_ID` | an id | (c) Vercel reveal; or (b) Cloudflare dashboard, **R2 Object Storage**, Account Details, Account ID | **MUST equal Vercel**: same Cloudflare account | no |
| `R2_BUCKET` | the production media bucket (never staging's) | (c) Vercel reveal; or (b) the bucket's name in **R2 Object Storage** | **MUST equal Vercel**: same bucket, same files | no |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret pair | (b) Cloudflare dashboard, **R2 Object Storage**, **Manage API tokens** (labels: check), **Create API token**: permission **Object Read & Write**, applied to **the media bucket only**, no expiry or one past the watch window. The secret is shown once | **fresh is fine**: any pair with read and write on that bucket; Vercel keeps its own | no |
| `R2_ENDPOINT` | only if Vercel sets it | (c) | equal if set | no |
| `BLOB_READ_WRITE_TOKEN` | secret | First try (c) Vercel reveal: a store-connected variable may not be Sensitive. Otherwise (b) Vercel, **Storage**, the Blob store (the one connected to this project), and its token: the store's **`.env.local`** / **Quickstart** snippet with **Show secret**, or the store's token settings (**check**: Vercel's current docs do not describe where the dashboard shows the token, or any way to rotate it). The CLI has no command that prints it (`vercel blob --help`). | **MUST equal Vercel's store**: a token for the **same** Blob store (old links point into it; with `STORAGE_BACKEND=r2` the app reads R2 first, then Blob). **Do not rotate or regenerate it:** Vercel's docs do not say whether that cancels the old token or updates the connected project, and reports say the project keeps the old value, so Vercel production would lose Blob reads as the fallback. If it cannot be found, old Blob links break on the new host: tell the lead before the switch (the copy to R2 in "Before Vercel is cancelled" is what removes the need) | no |
| `BLOB_USD_PER_GB_MONTH`, `BLOB_USD_PER_GB_TRANSFER` | only if Vercel sets them | (c) | equal if set (prices) | no |
| `DISPATCH_MODE` | `inngest` | written here | fixed | no |
| `INNGEST_SIGNING_KEY` | secret | (b) Inngest dashboard, environment switcher set to **Production**, **Manage**, **Signing Key** (copy the current key) | **MUST equal Vercel**: there is one signing key per Inngest environment, and it must be **this app's Production environment's** key (Inngest signs its calls with it and the SDK checks them). A key from another environment (a branch or test one) fails every call | no |
| `INNGEST_EVENT_KEY` | secret | (b) Inngest dashboard, **Production**, **Manage**, **Event Keys**: copy the existing one or **Create Event Key** | **fresh is fine**, but it must be an event key of the same **Production** environment | no |
| `INNGEST_SIGNING_KEY_FALLBACK` | only if Inngest shows a rotation in progress | (b) same page | equal if set | no |
| `INNGEST_SERVE_ORIGIN` | `https://particl.si` | written here | self-host only | no |
| `INNGEST_STREAMING` | `true` | written here | self-host only | no |
| `MAIL_FROM` | `hello@particl.si` (set 8 Oct; reset email tested: from `hello@particl.si`, inbox, link `https://particl.si/reset/…`). A display name is optional: `Name <hello@particl.si>` | written here | self-host only (Vercel keeps `hello@particlstudio.com`) | no |
| `RESEND_API_KEY` | secret | (b) Resend, **API Keys**, **Create API Key**: permission **Sending access**, domain `particl.si` or **All domains** (in use: the "Onboarding" key, All domains). Shown once | **fresh is fine**, same Resend account. The sending domain `particl.si` must stay **Verified** in Resend, **Domains**; so must `particlstudio.com` while Vercel is the fallback | no |
| `RESEND_BASE_URL` | only if Vercel sets it | (c) | equal if set | no |
| `AI_GATEWAY_API_KEY` | secret | (b) **OWNER creates it**: Vercel, the team, **AI Gateway**, **API Keys**, **Create key** | **new** (Vercel itself signs in with OIDC, which does not exist off Vercel) | no |
| `AI_GATEWAY_BASE_URL`, `GATEWAY_PROMPT_MODELS`, `REFINE_PROVIDER` | only if Vercel sets them | (c) | equal if set | no |
| `FAL_KEY`, `ELEVENLABS_API_KEY`, `ARK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | secret, whichever Vercel lists | (b) each vendor's console, its API keys page, **create** a new key in the **same account** Vercel uses: fal (Dashboard, **Keys**), ElevenLabs (**Developers**, **API Keys**), BytePlus ModelArk (**API Key Management**), Google AI Studio (**Get API key**), OpenAI (**API keys**), xAI Console (**API Keys**), Anthropic Console (**Settings**, **API Keys**). Labels: check | **fresh is fine**, same vendor account (billing and quotas stay together). Do not delete the old keys while Vercel is the fallback | no |
| `HF_CREDENTIALS` (or `HF_API_KEY_ID` + `HF_API_KEY_SECRET`), `HF_CREDENTIALS_PREVIOUS`, `HF_CREDENTIAL_ALIASES`, `HF_CONSUMER_CLIENT_ID` | only if Vercel sets them | (b) a new API key in the same Higgsfield API account (label: check); the alias and client-id names are not secret: (c) | key: fresh is fine; the rest equal if set | no |
| `ANTHROPIC_PROMPT_MODEL`, `ANTHROPIC_PROMPT_EFFORT`, `ARK_BASE_URL`, `ARK_TEXT_MODEL`, `GEMINI_BASE_URL`, `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`, `XAI_BASE_URL`, `XAI_MODEL`, `FAL_BASE_URL`, `ELEVENLABS_BASE_URL`, `OPENAI_BASE_URL`, `HF_BASE_URL` | only if Vercel sets them | (c) | equal if set | no |
| `HF_CINEMA_STUDIO_ENABLED`, `HF_SOUL_CHARACTER_ENABLED`, `HF_CONSUMER_VIDEO_ANALYSIS_ENABLED`, `HF_CORRELATION_HEADER`, `HF_POOL_SIZE`, `HF_POOL_WORKSPACE_SHARE`, `RIG_AGENT_ENABLED`, `LEGACY_WORKSPACE_NAME` | only if Vercel sets them | (c) | equal if set | no |
| `CREDIT_MARGINS`, `CREDIT_PACKS`, `SIGNUP_CREDITS`, `PLATFORM_ALLOWANCE_USD`, `ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD`, `WORKBENCH_ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_ATOMIK_MAX_PROJECT_USD`, `XAI_RATE_USD_PER_MTOK`, `FAL_RENDER_USD_PER_MP`, `FAL_TRAINER`, `FAL_TRAIN_STEPS`, `FAL_TRAIN_USD_PER_STEP`, `ELEVEN_MUSIC_CREDITS_PER_MINUTE`, `ELEVEN_SFX_CREDITS`, `HF_SOUL_CHARACTER_USD_720P`, `HF_SOUL_CHARACTER_USD_1080P`, `HF_CINEMA_STUDIO_SOUND_PRICING`, `SOUL_TRAINING_USD_V2`, `SOUL_TRAINING_USD_CINEMA` | only if Vercel sets them | (c); if one is hidden, ask the lead (do not guess a price) | **MUST equal Vercel** (customers see the same prices on both hosts) | no |
| `PAYMENT_PROVIDER` | (unset means `manual`) | (c) | equal | no |
| `STRIPE_SECRET_KEY` | only if Vercel sets it | (b) Stripe, **Developers**, **API keys**, **Create secret key** in the same account (do not roll the existing one). On production only an `sk_live_` key turns online billing on | fresh is fine, same Stripe account (card checkout is not wired in this code yet) | no |
| `STRIPE_WEBHOOK_SECRET` | only if Vercel sets it | (b) Stripe, **Developers**, **Webhooks**, the endpoint, signing secret | equal if set (this code has no webhook route; it only feeds the readiness check) | no |
| `LIVEBLOCKS_SECRET_KEY` | secret | (b) Liveblocks dashboard, **the same project** Vercel uses, **API keys**, the secret key (copy it if the page shows it; **check** whether a second secret key can be made). Never **roll** it: that would cancel Vercel's | **same project** required (the rooms live there); a new key is fine only if the old one stays valid | no |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | public | (c) Vercel reveal; if hidden, read it from the live site (it is compiled into the browser code, see "Web push keys" below) | **MUST equal Vercel** to keep everyone's existing notification subscriptions (each browser subscribed with this key) | **yes** |
| `VAPID_PRIVATE_KEY` | secret | (a) owner's notes if he has it; otherwise there is no way to recover it: see "Web push keys" below for a new pair | **MUST pair with the public key above**. A new pair is allowed, with the effects listed below | no |
| `VAPID_SUBJECT` | only if Vercel sets it (unset means `mailto:support@particlstudio.com`) | (c) | equal if set | no |
| `ASTRA_BLENDER_SNAPSHOT_ID` | starts `snap_` | (c) Vercel reveal (not a secret; if hidden, the project's Sandbox snapshots list: check) | **MUST equal Vercel**: the snapshot renders start from | no |
| `ASTRA_BLENDER_RATE_CARD` | JSON prices | (c) Vercel reveal; if hidden, ask the lead (do not guess) | **MUST equal Vercel**: it prices renders | no |
| `VERCEL_TOKEN` | secret | (b) **OWNER creates it**: Vercel, **Account Settings**, **Tokens**, **Create**: scope **the team**, expiration **No Expiration** (or put the date in the calendar) | **fresh** (team-scoped); Vercel itself uses OIDC | no |
| `VERCEL_TEAM_ID` | an id | (b) Vercel, **Team Settings**, **General**, Team ID | the same team | no |
| `VERCEL_PROJECT_ID` | an id | (b) Vercel, the project, **Settings**, **General**, Project ID (the project that owns the snapshot) | the same project | no |

`NODE_ENV`, `PORT`, `HOSTNAME`, `NEXT_OUTPUT` and `GIT_COMMIT_SHA` are set by the image (`ops/selfhost/Dockerfile`); do not add them by hand. `GIT_COMMIT_SHA` comes from Coolify's own `SOURCE_COMMIT` (Coolify's "Include Source Commit in Build" setting); without it the error log says `unknown` for the release, nothing else changes. Coolify adds `COOLIFY_*` and `SOURCE_*` names of its own; the app reads none of them at runtime.

**These depend on the Vercel account staying open after hosting moves.** `AI_GATEWAY_API_KEY` (Atomik drafts, prompt enhance, gateway stills), `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` (Astra Blender renders run in Vercel Sandbox, from the snapshot in that project), and `BLOB_READ_WRITE_TOKEN` (old media links, until every old Blob object is copied to R2). Moving the site off Vercel hosting does not move these: if the Vercel team or project is closed, the project deleted, the token revoked or expired, or the bill unpaid, those features stop on the new host too. Give `VERCEL_TOKEN` no expiry, or put its expiry date in the calendar.

**Never set on the production app:**
- `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_OIDC_TOKEN`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` (Vercel's own; off Vercel they switch on Vercel behaviour, such as trusting faked client addresses). Never bulk-paste a `vercel env pull` file.
- `BRANCH_NAME` and `BRANCH` (the Inngest SDK turns them into an environment header).
- `TRUST_CF_CONNECTING_IP` (grey cloud: setting it lets anyone fake their address past every rate limit and the sign-in lock; it belongs to the later orange-cloud step only) and `TRUSTED_PROXY_HOPS`.
- `ENGINE_MOCK` (`1` fakes every engine and no one is charged for real work), `PARTICL_TEST_MOCK_DELAYS` (test-only: it does nothing without `ENGINE_MOCK=1` and off a production build), `CI_DEV_SOURCE_MAPS` (CI only). The code reads no other `*_TEST_*` or mock flag.
- `WORKSPACE_DB_DIRECTORY`, `OWNER_PRIVACY_SCRUB_LOCAL` (local development only).
- Every `INNGEST_*` name not in the table, such as `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_API_BASE_URL`, `INNGEST_EVENT_API_BASE_URL`, `INNGEST_DEVSERVER_URL`, `INNGEST_ENV`, `INNGEST_SERVE_HOST`, `INNGEST_SERVE_PATH`, `INNGEST_ALLOW_IN_BAND_SYNC`, `INNGEST_ENABLE_UNAUTHED_SYNC` (the SDK reads them itself; they point it away from Inngest Cloud's production environment or `/api/inngest`, or loosen its sync check).
- Script-only names: `PARTICL_BACKUP_*`, `PW_*`, `AIMIGHTY_*`, `PARTICL_URL`, `PARTICL_TOKEN`.
- `NODE_ENV`, `PORT`, `HOSTNAME`, `NEXT_OUTPUT`, `GIT_COMMIT_SHA` (the image sets them).

**Remove or change in the current Coolify env** (app `4dufbrykuka94cedlfjo3jxm`), before its first start:
- `STORAGE_BACKEND=blob` → `r2` (with the four `R2_*` above and `BLOB_READ_WRITE_TOKEN` kept for old links).
- `DISPATCH_MODE=native` → `inngest` (with both Inngest keys, `INNGEST_SERVE_ORIGIN` and `INNGEST_STREAMING`).
- `MAIL_FROM` → `hello@particl.si` (done 8 Oct).
- Anything carried over from staging: `file:` database URLs (`PLATFORM_DATABASE_URL`, `TURSO_DATABASE_URL`, including `file:/app/.data/...`), `ENGINE_MOCK`, `PARTICL_DEPLOYMENT=staging`, `CREDIT_USD` if it is not Vercel's value, the staging R2 bucket and its keys, staging's generated `KEYRING_SECRET` (must be production's), the sslip.io or any other non-`https://particl.si` address in `APP_ORIGIN`, `APP_URL`, `NEXT_PUBLIC_APP_URL`.
- Any name in "Never set" above, and any **Build Variable** tick on a row the table marks "no".
- After saving, rebuild (not just restart): `APP_ORIGIN` and the two `NEXT_PUBLIC_*` values are baked in at build.

**Where this list comes from (8 Oct 2026).** A grep of every `process.env` read, `env.NAME` read through a passed-in environment, and quoted variable name (vendor key and base-URL tables, price settings) in `lib/`, `app/`, `components/`, `proxy.ts`, `instrumentation.ts`, `next.config.ts`, the build scripts (`prebuild` runs `scripts/ops/preview-seed.cjs`, which skips without `VERCEL_ENV=preview`; `postinstall` copies the PDF and OCR workers and reads nothing) and `ops/selfhost/`, on `origin/release/1` and `origin/main`, plus the names the Inngest SDK reads by itself. Every name the code reads is in the table or the "Never set" list.
- The switch-day image is built from `main` **after** the hotfix train (#564, #565, #562, #566); those branches were searched too and add no name missing here. `main` already reads `SELFHOST_BEHIND_PROXY` (since #563); `ops/selfhost/` (Dockerfile, `cron-sync.mjs`), `PARTICL_DEPLOYMENT`, `TRUSTED_PROXY_HOPS` and the standalone switch arrive with #562, #565 and #566. Do not build the production image before #566 is on `main`. `main` has no `prebuild` step.
- `main` reads `APP_URL` and `NEXT_PUBLIC_APP_URL` (`lib/held.ts`); Release 1 reads `APP_ORIGIN` there instead. All are set above, so either build sends correct links. Names read only by ops scripts (for example `PARTICL_ALLOW_STAGING_REHEARSAL`, `TURSO_CLI`, `PHASE`) are not app settings and are not listed.
- Release 1 only: `PARTICL_TEST_MOCK_DELAYS` (test-only), `OWNER_PRIVACY_SCRUB_LOCAL`, `VERCEL_BRANCH_URL` (all in "Never set").

### Web push keys

**Reading the public key from the live site** (when Vercel hides it). `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is compiled into the browser code (`main`: `app/(app)/settings/page.tsx`; Release 1: `lib/push-client.ts` line 21). It is public by design. Any one of:
- Signed in on `https://particl.si`, on a browser where notifications are **on**: DevTools, **Console**, paste
  `(async()=>{const s=await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();return s&&btoa(String.fromCharCode(...new Uint8Array(s.options.applicationServerKey))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")})()`
  It prints the key this browser subscribed with (`null` if notifications are off here).
- Signed in, open the page that holds the push code (on the `main` build that runs tonight: **Settings**, where the notifications switch is; on Release 1: a board, with "Notify me when done", or the phone view), DevTools, **Sources**, search all files (Ctrl+Shift+F / Cmd+Option+F) for `applicationServerKey`. The key is the 87-character string starting with `B` next to it (or in the same file). Minified code differs per build: check.

**If `VAPID_PRIVATE_KEY` cannot be recovered**, make a new pair instead (allowed; nothing but notifications is affected):
1. On your own machine, in the repo folder: `npx web-push generate-vapid-keys`. It prints a public and a private key.
2. Set **both** in the production app: the public one as `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (**build variable**: it is baked in, so rebuild) and the private one as `VAPID_PRIVATE_KEY`. Never mix one key of the old pair with one of the new.
3. What happens:
   - Every **existing** browser subscription stops receiving notifications from the new host. The push services refuse a send signed with a different key (403, some services 401), and `lib/push.ts` removes a subscription only on 404 or 410 (the `statusCode === 404 || statusCode === 410` checks; lines 115 and 147 on Release 1, the same on `main`), so those sends fail quietly: a `push failed: 403` line in the app log, nothing shown to anyone, nothing removed.
   - Each person has to subscribe again with the new key. While a browser still holds the old subscription, the page reports notifications as "on" and does not re-subscribe by itself (it only checks that a subscription exists, not which key it was made with).
     - On the build from `main` (tonight's): **Settings**, the notifications switch **off**, then **on**. Turning it off removes the old subscription; turning it on subscribes with the new key.
     - On Release 1 builds (`lib/push-client.ts`, `readState`): there is no "off" control, so "Notify me" (phone) and "Notify me when done" (board) only answer "You'll be told…". The person first clears the browser's notification permission for `particl.si` (browser site settings, Notifications, Reset or Remove; on an iPhone Home Screen app, remove and re-add it: check), then presses "Notify me" again. A small fix (re-subscribe when the stored key differs from the build's key) is proposed to the lead.
   - Nothing else breaks: no data, sign-in, billing or job depends on these keys.
   - **During the fallback window Vercel keeps the old pair.** Subscriptions made on either host live in the same databases, so each host's sends to the other's subscriptions fail quietly the same way. After a rollback to Vercel, people who re-subscribed on the new host have to do it once more.

## Traefik timeouts

**Why.** Some routes run long: finishing an upload and streaming media are allowed up to 800 s, and Inngest steps up to 300 s. Traefik v3 cuts any request whose **body** takes longer than 60 s to arrive (`readTimeout`, default 60 s). Uploads arrive in 3.5 MB pieces, so one piece on a slow phone connection can pass 60 s.
- `writeTimeout` defaults to **0 (no limit)** in Traefik v3. Leave it alone: setting it would cut long downloads.
- `idleTimeout` stays at its default (180 s).

**Where (OWNER).** Coolify, **Servers**, the server, **Proxy**, **Configuration** (the proxy's docker-compose). In the Traefik service's `command:` list, next to the existing `--entrypoints.http.address=:80` and `--entrypoints.https.address=:443`, add exactly these two lines:

```yaml
      - '--entrypoints.http.transport.respondingTimeouts.readTimeout=900s'
      - '--entrypoints.https.transport.respondingTimeouts.readTimeout=900s'
```

900 s is above the longest route (800 s). Coolify names its entrypoints `http` and `https`; if your file uses other names, use those. If the file already has a `writeTimeout` line, raise it to `900s` or remove it.

**Restart.** Save, then click **Restart Proxy** on the same page. Every app on the server drops its connections for a few seconds, so do it when quiet. Afterwards the proxy shows running and staging still answers 200. It is one proxy for both apps, so doing it once covers staging and production.

With grey cloud there is no Cloudflare limit in front, so these Traefik timeouts are the only ones that apply. The 100 s problem only comes back with orange cloud (see the "Later" section).

**Paid text and transcription answer within 25 s.** `POST /api/audio/transcribe`, `/api/atomik/[id]` (a planning turn), `/api/atomik/memory/read`, `/api/atomik/ideas/draft`, `/api/atomik/shots/draft` and `/api/atomik/treatment/scene` answer "still being accepted" (409, `pending`, `Retry-After`) when their run is still going after 25 s, and the run finishes after the reply in `after()` (`answerAfterMs`, `lib/generationRequests.ts`). For a planning turn and a Memory read the browser sends the same saved request again (same Idempotency-Key) until the saved reply is there, for up to 6 minutes (`waitWhilePending`, `lib/pendingReplay.ts`); a transcription asks `/api/generate/check`, as it already did; every other paid send is sent once, as before. The run's continuation is the recovery parent of what it does after the reply, so a deploy that drains after the request has answered still admits it. A replay never starts a second run or a second charge. On SIGTERM, `next start` finishes pending `after()` work before it exits, so give the app container a **stop grace of at least 300 s** (the longest run: 270 s of text, 280 s of transcription). If the process stops before a run ends anyway (a shorter grace, a crash, out of memory), nothing new happens to money; it falls back to what a killed function leaves today: the claim keeps no reply, so every replay is answered "pending" and nothing is sent again; a planning turn's reservation stays held for review (`paid_text_jobs` and its meter row stay `running`); a transcription's check answers from the meter after 10 minutes (`TRANSCRIPTION_STALE_MS`); the run's recovery activities (`paid-request`, `paid-text`) stay open, so a deploy drain sees them; and after 6 minutes the browser shows "Recover the saved request".

**Forwarded headers.**
- Keep Traefik's default of appending to `X-Forwarded-For` (never set `notAppendXForwardedFor`).
- Leave `forwardedHeaders.trustedIPs` unset.
- Never publish the app's port 3000 on the host.
- The app then counts the address Traefik saw (`TRUSTED_PROXY_HOPS` unset = 1).
- If the app logs `[client-ip] ... one shared bucket`, one of these settings is wrong.

**Stop grace period (OWNER).** Coolify, the production app, **Advanced** tab, **Operations**, **Stop grace period (seconds)**: `300`.
- The field needs **Coolify v4.1.0 or newer**. Older versions have no field and wait a fixed 30 s. "Custom Docker Options" does not accept `--stop-timeout`.
- On stop, Next 16 stops taking new requests and finishes in-flight requests and their background work (`after`) before it exits (`next/dist/server/lib/start-server.js`). The Dockerfile's `CMD` is exec form, so Node receives the signal.
- Anything still cut off is picked up by the cron's recovery sweep. Still, redeploy when quiet.

## Domains and DNS

- `particl.si` stays the primary name.
- **`particl.si` and `www.particl.si` are DNS-only (grey cloud)** and point straight at the server, like Vercel's records today. Traefik serves **Let's Encrypt** certificates for both, issued **before** the switch (see "Certificates before the switch").
- In Coolify the production app's **Domains** field is `https://particl.si,https://www.particl.si`. In the app's **General** settings, set **Direction** to **redirect to non-www**, so Traefik sends `www` to `https://particl.si` (a 301 or 308 was planned; on 8 Oct it answers 302, which works).
- **No AAAA record** at cutover. Docker may relay IPv6 connections so that every IPv6 visitor shows up as one address and shares one rate-limit allowance. Remove any AAAA that points at Vercel.
- `particl.app` and `www.particl.app` only redirect. They stay **proxied** (orange) with a Cloudflare redirect rule; no app traffic passes through them, so the 100 s limit does not matter there.
  - **Redirect rule (OWNER, can be made ahead of time).** In the `particl.app` zone: **Rules, Redirect Rules, Create rule**. If hostname is in `particl.app`, `www.particl.app` (or: all incoming requests, as set on 8 Oct), then dynamic redirect to `concat("https://particl.si", http.request.uri.path)`, status 308, **Preserve query string** ticked.

| Name | Record | Proxy | Who answers |
|---|---|---|---|
| `particl.si` | A to `<server IPv4>`, no AAAA | **DNS-only** (grey) | the server (Let's Encrypt) |
| `www.particl.si` | CNAME to `particl.si` | **DNS-only** (grey) | the server, redirects to `particl.si` |
| `particl.app` | A to `192.0.2.1` as set on 8 Oct (any address works; the rule answers first) | proxied (orange) | Cloudflare redirect rule |
| `www.particl.app` | CNAME to `particl.app` | proxied (orange) | Cloudflare redirect rule |

**Do not touch** mail records on any domain (MX, SPF, DKIM, DMARC, Resend's verification records for `particl.si`, including `_dmarc` TXT `v=DMARC1; p=quarantine; adkim=r; aspf=r;`) or the `particlstudio.com` zone. The owner is adding that `_dmarc` record separately; the switch itself changes only the A/CNAME rows above. If there are CAA records on `particl.si`, they must allow Let's Encrypt.

**Checks must reach the server, not Vercel.** While DNS may still point at Vercel (or a resolver still caches it), a plain `curl https://particl.si/` can pass against Vercel. Pin every check to the server:
- `curl -sI --resolve particl.si:443:<server IPv4> https://particl.si/` (and the same with `www.particl.si`);
- `openssl s_client -connect <server IPv4>:443 -servername particl.si </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates` (and with `-servername www.particl.si`): the issuer is Let's Encrypt and the dates are current;
- before trusting any unpinned check after the switch: `dig +short particl.si @1.1.1.1` and `dig +short particl.si @8.8.8.8` both print the server's address.

## Certificates before the switch

Traefik asks Let's Encrypt for a certificate as soon as the app's route appears. With the normal method (HTTP-01), that attempt fails while the names still point at Vercel. Traefik does not retry until its configuration changes, so visitors would get Traefik's self-signed certificate after the switch, and each failed attempt counts against Let's Encrypt's limit of 5 failures per name per hour. So the main path gets the certificates **before** the switch, with a DNS challenge.

**(a) Main path: a DNS-challenge resolver (OWNER, with the advisor), before cutover step 4.**
1. **Cloudflare token.** **My Profile, API Tokens, Create Token**, custom token with permissions **Zone, DNS, Edit** and **Zone, Zone, Read**, zone resources **Include, Specific zone, `particl.si`** only. It is shown once; it never goes into the repo, a chat or a note. If issuance later fails with a zone-lookup error, do **not** widen this token (zone resources apply to every permission in it, so that would also give DNS Edit on every zone); instead create a second token with only **Zone, Zone, Read** and add it as `CF_ZONE_API_TOKEN_FILE` next to the one below.
2. **Token file on the server.** Save it as `/data/coolify/proxy/cf-dns-token` (one line, no trailing space), owner root, mode `600`. Coolify mounts `/data/coolify/proxy` into Traefik at `/traefik` (check the `volumes:` of the proxy compose).
3. **Proxy configuration.** Coolify, **Servers**, the server, **Proxy**, **Configuration**. In the Traefik service add, under `environment:` (add the `environment:` key at the same level as `command:` if the service has none):
   ```yaml
         - CF_DNS_API_TOKEN_FILE=/traefik/cf-dns-token
   ```
   and, in `command:`, a **second** resolver next to Coolify's own `letsencrypt` one (leave that one as it is: staging's sslip.io address keeps using it):
   ```yaml
         - '--certificatesresolvers.letsencrypt-dns.acme.email=<owner email>'
         - '--certificatesresolvers.letsencrypt-dns.acme.storage=/traefik/acme-dns.json'
         - '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=cloudflare'
         - '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53'
   ```
   Save, then **Restart Proxy** (when quiet).
4. **Point the production app at it.** Coolify, the production app, **Configuration, General, Container Labels**. Untick **Readonly labels** if shown. On every `traefik.http.routers.https-…` line ending in `.tls.certresolver=letsencrypt`, change the value to `letsencrypt-dns` (one router for `particl.si`, one for `www.particl.si`). Save. Coolify regenerates labels when Domains or Direction change, so re-check this after any such change.
5. **Check (during step 4, while the app runs once):** the pinned `openssl s_client … -servername particl.si` and `-servername www.particl.si` both name **Let's Encrypt** with current dates, although DNS still points at Vercel. The certificates are stored in `acme-dns.json` and stay valid when the app is stopped and started again. This resolver also keeps renewing behind an orange cloud later.

**(b) Fallback, only if (a) cannot be set up.** No redeploys or domain changes between steps 4 and 8. Switch DNS (step 8), wait until `dig +short particl.si @1.1.1.1` and `@8.8.8.8` both return the server, then immediately **Restart Proxy** so Traefik asks again. Expect about a minute of certificate warnings for visitors who already reach the server. Check with the pinned `openssl` command.

## Firewall on the server (main path, grey cloud)

With grey cloud everyone reaches the server directly, so **80 and 443 stay open to everyone**: TCP 80, TCP 443, and **UDP 443** if HTTP/3 is on (Coolify's proxy may publish `443/udp` and set `--entrypoints.https.http3`). Coolify's own ports and SSH are limited to the owner's addresses.

Plain `ufw` is **not enough** for Docker ports: Docker publishes 80, 443, 8000, 6001, 6002 and 8080 through its own rules, ahead of ufw. Two ways; **the owner confirms which one he uses**.

**(a) Contabo's control-panel firewall**, if the plan has it. Preferred: it filters before traffic reaches the server, so Docker cannot bypass it.
- Allow TCP 80, TCP 443 and UDP 443 from anywhere.
- Allow TCP 22, 8000, 6001, 6002 and 8080 only from the owner's own addresses.
- Deny everything else inbound.

**(b) Rules on the server**, if (a) is not available. The advisor does this as root.
1. **Docker ports.** Save this as `/usr/local/sbin/particl-firewall.sh` (owner root, mode `700`) after filling in the two values at the top. It refuses to run with a placeholder left in, and running it twice changes nothing:
   ```sh
   #!/bin/sh
   set -eu
   IF="<public interface>"    # shown by: ip route get 1.1.1.1
   ADMIN="<owner IPv4>"       # the owner's own address(es), space separated
   [ -n "$IF" ] && [ -n "$ADMIN" ] || { echo "fill in IF and ADMIN"; exit 1; }
   case "$IF" in *"<"*) echo "fill in IF"; exit 1;; esac
   case "$ADMIN" in *"<"*) echo "fill in ADMIN"; exit 1;; esac
   # Coolify and Traefik dashboard ports (published by Docker): owner only.
   iptables -N ADMIN-ONLY 2>/dev/null || iptables -F ADMIN-ONLY
   for a in $ADMIN; do iptables -A ADMIN-ONLY -s "$a" -j RETURN; done
   iptables -A ADMIN-ONLY -j DROP
   for p in 8000 6001 6002 8080; do
     iptables -C DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j ADMIN-ONLY 2>/dev/null ||
     iptables -I DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j ADMIN-ONLY
   done
   # The same ports over IPv6: closed (the owner uses IPv4).
   if command -v ip6tables >/dev/null 2>&1 && ip6tables -L INPUT >/dev/null 2>&1; then
     for p in 8000 6001 6002 8080; do
       ip6tables -C INPUT -p tcp --dport "$p" -j DROP 2>/dev/null || ip6tables -I INPUT -p tcp --dport "$p" -j DROP
       if ip6tables -L DOCKER-USER >/dev/null 2>&1; then
         ip6tables -C DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j DROP 2>/dev/null ||
         ip6tables -I DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j DROP
       fi
     done
   else
     echo "ip6tables not available: IPv6 rules skipped (check with curl -6 from outside)"
   fi
   ```
   Matching only **new inbound** connections keeps the containers' own outgoing calls (Turso, R2, the engines) working.
2. **Keep it after a reboot** with a systemd unit that re-runs the script once Docker is up. Do **not** use `iptables-persistent` / `netfilter-persistent`: it conflicts with ufw (installing it removes ufw) and would also save Docker's own chains. Save as `/etc/systemd/system/particl-firewall.service`:
   ```ini
   [Unit]
   Description=Particl firewall rules for Docker-published ports
   After=docker.service
   Requires=docker.service

   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/particl-firewall.sh
   RemainAfterExit=yes

   [Install]
   WantedBy=multi-user.target
   ```
   Then `systemctl daemon-reload && systemctl enable --now particl-firewall.service`, and `systemctl status particl-firewall.service` shows it ran without error.
3. **SSH (22)** is a host port, so `ufw` covers it. **Order matters:** add the allows first, then enable.
   - Find Coolify's network: `docker network inspect coolify --format '{{(index .IPAM.Config 0).Subnet}}'`. Coolify reaches its own server over SSH from that network; without this allow, Coolify loses the server.
   - `ufw allow from <owner IPv4> to any port 22 proto tcp`
   - `ufw allow from <coolify subnet> to any port 22 proto tcp`
   - Remove any general "allow 22" rule (`ufw status numbered`, then `ufw delete <number>`).
   - `ufw enable` (only now), then `ufw status verbose`: default incoming **deny**, and the two SSH allows listed.
- If the owner's home address changes, he is locked out of Coolify; Contabo's **VNC console** still works (edit `ADMIN`, re-run the script). Once the Coolify dashboard has its own domain over 443 (gate 1), 8000, 6001 and 6002 can be closed to everyone.

**Check from an outside network** (a phone on mobile data, not the owner's allowed address), now and again **after a reboot** of the server:
- `curl -m 10 http://<server IPv4>:8000/`, and the same for `:6001`, `:6002` and `:8080`: each **times out**;
- `curl -6 -m 10 http://[<server IPv6>]:8000/`: **times out** (if the server has IPv6);
- staging still answers on its https address.

## Restore point before production code touches the live databases

The app creates and changes tables on first use. So **before the production app first starts** against the live Turso databases (its first deploy, step 4), and **again just before the DNS switch** (step 8), the owner records a way back.

**Today production has no automated encrypted backup.** The scheduled capture in `.github/workflows/backup.yml` never runs (a manual dry run only plans and tests) because the repository variable `PARTICL_BACKUP_ENABLED` is not `true`. The tooling supports production's R2 + Blob layout (media `dual`, see 2). Owner's plan: **one attended capture first**, with production in maintenance, before Vercel (and its Blob store) is cancelled; a nightly backup without a maintenance window is later work. The verified encrypted bundle goes to a **private R2 bucket**, never a GitHub artifact (the repository is public). The owner's clicks (bucket, tokens, lifecycle rule, GitHub environment `particl-backup` and its secrets) and the night's exact steps are in `docs/backup-restore.md`, "Private backup bucket: owner setup" and "Attended capture runbook". Production's media is read with a read-only R2 token scoped to the media bucket.

**Point A = Turso timestamp plus `.dump` copies; point B = Turso timestamp (a second set of `.dump` copies is optional but recommended).** The full encrypted bundle (see 2) now works with production's layout, but it takes the site down for its window: do **not** run the recovery fence on production without the owner's explicit go.

**1. Turso point-in-time timestamps and `.dump` copies (no tooling).**
- **OWNER:** write down the exact UTC time (for example `2026-10-20T09:00:00Z`) for **point A** (before the first deploy) and **point B** (before the switch). It covers the platform database and **every workspace database** (all databases in the production Turso group).
- Check the plan's window in the Turso dashboard: Free 24 hours, Developer 10 days, Scaler 30 days, Pro 90 days. A point older than the window is gone.
- **OWNER, at point A:** the `.dump` copies, with the exact commands in "Point A tonight" just below. They are readable SQL files on the owner's machine. Keep them private: they hold sealed tokens and password hashes.
- **There is no tooling for this path.** A restore means: `turso db create <new name> --from-db <database> --timestamp <time>` for each database, then, by hand with Claude's help, repointing every workspace's database address and token in the platform database. Those tokens are sealed with `KEYRING_SECRET`, so this needs the original keyring and care. It loses everything written after that time.
- **Prove it once, on copies.**
  - Create a copy of the platform database and of one workspace database at point A.
  - Look at them: `turso db shell <new name> "SELECT count(*) FROM workspaces"` on the platform copy, and see the rows.
  - Delete the copies.
  - `turso db shell` is **not** read-only: on any database, run only `.dump` or `SELECT`.
  - Each copy counts toward the plan's database quota while it exists.

**Point A tonight: exact commands (OWNER; the lead has no Turso access).** Start at **23:00 IST (17:30 UTC)** so it is done by 23:15, before the production app's first start (step 4.6) and the 23:30 switch. Only `.dump` and `SELECT` are run: both are read-only. Never run any other statement in `turso db shell`, and never `turso db destroy` or `turso db tokens invalidate`.

1. Sign in and find the production databases:
   ```sh
   turso auth login
   turso org list                         # the current organisation must be production's (TURSO_ORG); if not: turso org switch <org>
   turso group list                       # the production group (TURSO_GROUP)
   turso db list --group <production group>
   ```
   - **Platform database:** `PLATFORM_DATABASE_URL` has the form `libsql://<db>-<org>.turso.io`; `<db>` is its name in the list. If Vercel hides the URL, it is the database in the list that has the `workspaces` table: `turso db shell <db> "SELECT count(*) FROM workspaces"` answers a number there and "no such table" elsewhere (if more than one answers, stop and ask the lead).
   - **Primary (legacy) workspace database:** the same, from `TURSO_DATABASE_URL`.
   - **Workspace databases**, from the platform database (table and columns: `lib/platform.ts`, `workspaces`):
     ```sh
     turso db shell <platform db> "SELECT id, legacy, db_name, db_url, deleted_at FROM workspaces ORDER BY created_at"
     ```
     Each row's `db_name` is that workspace's Turso database name (also the first part of `db_url`'s host, before `-<org>.turso.io`). The row with `legacy` = 1 uses the primary database instead (`lib/platform.ts` line 302). Rows with `deleted_at` set may still have a database: dump it too if it is in the list.
   - Every name must appear in `turso db list`. Dump **every database in the production group**; one more than needed is harmless.
2. Write the dumps into a new private folder outside any synced or cloud folder (not under iCloud Drive, Desktop or Documents if those sync, Dropbox, Google Drive or OneDrive). Works in bash and zsh:
   ```sh
   umask 077
   mkdir -p -m 700 ~/particl-restore
   D=~/particl-restore/pointA-$(date -u +%Y%m%dT%H%M%SZ)
   mkdir -m 700 "$D"
   date -u +%Y-%m-%dT%H:%M:%SZ | tee "$D/pointA-utc.txt"
   DBS=(<platform db> <primary db> <workspace db 1> <workspace db 2>)   # every name from step 1
   for db in "${DBS[@]}"; do
     turso db shell "$db" .dump > "$D/$db.sql" || echo "FAILED: $db"
   done
   wc -c "$D"/*.sql
   ```
3. Check: one `.sql` file per name in `DBS`, every one **larger than 0 bytes** in the `wc -c` list, and no `FAILED:` line. Re-run the dump for any name that failed or is empty (same command, that one name). A complete dump normally ends with `COMMIT;` (`tail -c 20 "$D/<db>.sql"`; check).
4. **Write down the UTC time** printed into `pointA-utc.txt` (also in the owner's notes): it is restore point A for Turso's point-in-time restore, taken before the first dump. The dumps are taken one database after another while Vercel is live, so each one is that database at its own moment; the Turso timestamp is the one consistent point across all databases.

**2. The full encrypted bundle.** It is the only scripted path. It captures every database and production's media as it is laid out today: new objects on R2, older ones still on Blob, read R2 first (media kind `dual`, `docs/backup-restore.md`). It checks that every file a database row points at exists in one of the two stores, by the app's own rule.
- **OWNER's go first.** Do not run it on production without the owner's explicit go for that window.
- **It needs a maintenance window.** Writes are paused with the recovery fence (`docs/enforced-recovery-fence.md`). While the fence is draining or closed, **every API request and `/api/health` answer 503** (Retry-After 60): the site is effectively down, not read-only. The gate never reopens on its own.
  - `node scripts/ops/recovery-fence.mjs begin NEW_PRIVATE_DIRECTORY INPUT.json`. `INPUT.json` holds `preconditions` (`deployments: [{id, protocol: "particl-recovery-fence-v1"}]`, `oldDeploymentsStopped: true`, `externalWritersExcluded: true`, and an `evidence` string) and `media`, which names the app's own variables (names only, never values):
    ```json
    {
      "kind": "dual",
      "r2": {
        "accountIdEnv": "R2_ACCOUNT_ID",
        "accessKeyIdEnv": "R2_ACCESS_KEY_ID",
        "secretAccessKeyEnv": "R2_SECRET_ACCESS_KEY",
        "bucketEnv": "R2_BUCKET",
        "endpointEnv": "R2_ENDPOINT"
      },
      "blob": { "tokenEnv": "BLOB_READ_WRITE_TOKEN" }
    }
    ```
    Leave out `endpointEnv` if production does not set `R2_ENDPOINT`. Those variables must be set in the operator shell for `seal` (it copies their values into the private `source-env.json`). On Vercel, "old deployments stopped" is hard to make true: plan it with Claude.
  - `status NEW_PRIVATE_DIRECTORY` until nothing is outstanding, then `seal NEW_PRIVATE_DIRECTORY`. It writes `sources.json`, `source-env.json` and `receipt.json` into that directory.
  - Capture: `node scripts/ops/backup-restore.mjs backup <that directory>/sources.json NEW_BUNDLE_DIRECTORY`. Variables come from the operator shell, never the command line: `PARTICL_BACKUP_KEY` (32 random bytes, base64, kept in the password manager), the **original** `KEYRING_SECRET`, and the credentials named in `source-env.json`. Then `restore NEW_BUNDLE_DIRECTORY NEW_OFFLINE_DIRECTORY` and `report NEW_OFFLINE_DIRECTORY` prove it reads back.
  - `node scripts/ops/recovery-fence.mjs resume NEW_PRIVATE_DIRECTORY` to reopen. **On any failure, run `resume` immediately**, so the site is not left down.
- Restoring a bundle into new databases goes through `prepare`. It takes only the offline directory that `restore` produced, and it always invalidates access: it **signs everyone out**, and removes API tokens, review links, password-reset links and consumer sign-in grants. That is right after a real restore, but it is not a quiet rollback.

## Cutover order (grey cloud)

Steps 1 to 7 do not move live traffic. From step 8 the live site is affected. Do not start a step until the one above has passed. Steps marked **OWNER** are done by the owner (with the advisor where noted); unmarked steps are checks.

**Which steps change what (the owner may click the app ones himself).**
- **The PRODUCTION app only** (Coolify, the production app `4dufbrykuka94cedlfjo3jxm`; nothing else on the server changes):
  - creating and configuring the app as in "Staging app (reference)" (source `main`, Dockerfile build pack, port 3000, the `/app/.data` volume, limits, auto deploy off);
  - its environment (step 4.3: the switch-day table, its "remove" list, the Build Variable ticks);
  - its domains, the redirect to non-www and **Stop grace period = 300** (step 4.4; Advanced, Operations);
  - its scheduled task `cron-sync` (step 4.5, saved disabled; enabled in step 8; disabled again on rollback);
  - **Deploy**, Stop and Start (steps 4.6 and 8; rollback 15.2).
- **Server level** (every app on the server; the advisor does these): the Traefik read-timeout lines in Coolify, **Servers**, the server, **Proxy**, **Configuration**, and the proxy **Restart** (see "Traefik timeouts"; step 9 on path (b)). The Contabo firewall and the SSH settings are outside Coolify.
- **Outside the server:** Cloudflare DNS (steps 2, 6, 8), Vercel (steps 4.1, 8's cron switch-off, rollback), Inngest (steps 5, 10), Turso (restore points; read-only).

0. **Gates.** Each gate in "Gates before cutover" is passed, or waived by the owner in writing. Otherwise stop.
1. **Staging runs `main` (OWNER).** Switch the staging app's branch to `main`, rebuild, sign in, run `smoke.sh` on staging. Do not go on until a build of `main` passes. (What `main` needs: PR #566's description.)
   - **Per-address limits check (OWNER, on staging).** Use a test account.
     - From network A (home): enter a wrong password **8 times** until staging says "Too many attempts. Try again in 15 minutes."
     - Then from a phone on mobile data (network B): sign in to the same account with the right password. It must work: limits are counted per address.
     - If network B is blocked too, every visitor shares one address: **stop** and report it.
2. **Lower the TTL (OWNER, a day ahead).** Write down the current records for `particl.si` and `www.particl.si` (type, value, TTL, proxy status) and lower their TTL to the minimum. If `particl.si` is not yet a Cloudflare zone, stop and say so.
3. **Firewall and certificate resolver (OWNER, with the advisor).** As in "Firewall on the server" (including the outside checks) and "Certificates before the switch" (a), steps 1 to 3 (step 4, the labels, is done in cutover step 4).
4. **Production app built, checked once, stopped (OWNER).**
   1. **Required first: deploy the same `main` commit on Vercel**, so the code that changes tables on first use is the same on both hosts sharing the databases.
   2. Record **restore point A** ("Restore point" above): the Turso timestamp, the `.dump` copies, and the restore test on copies. (An encrypted bundle is optional here and only on the owner's go: its fence takes the site to 503 for the window.)
   3. Every variable in "Switch-day env for the Coolify production app" is set and its "remove" list is gone. `TRUST_CF_CONNECTING_IP` and `TRUSTED_PROXY_HOPS` are **unset**. **`CREDIT_USD` is confirmed equal to the ledger's `unit_usd` before the first start** (a wrong value at first start writes `paused_since` into the shared platform row, which persists).
   4. Domains `https://particl.si,https://www.particl.si`, Direction redirect to non-www, stop grace period 300. Labels stay on Coolify's own `letsencrypt` resolver (owner's choices box: no Cloudflare token, certificates path (b)).
   5. Scheduled task: Coolify, the production app, **Scheduled Tasks, + Add**: name `cron-sync`, command `node /app/cron-sync.mjs`, frequency `*/10 * * * *`, timeout 300 s, saved **disabled**. (The script calls `http://127.0.0.1:3000/api/cron/sync` inside the container with `CRON_SECRET`.)
   6. **Deploy** (the first start against the live databases). Check the health check goes green (on certificates path (b) Traefik still serves its own certificate here; that is expected).
   7. **Keyring check (OWNER, in the app's terminal; prints only `KEYRING OK` or `KEYRING MISMATCH`):**
      ```
      node -e 'const c=require("crypto");const{createClient}=require("@libsql/client");(async()=>{const db=createClient({url:process.env.PLATFORM_DATABASE_URL,authToken:process.env.PLATFORM_AUTH_TOKEN});const r=(await db.execute("SELECT db_token_enc FROM workspaces WHERE legacy=0 AND db_token_enc IS NOT NULL LIMIT 1")).rows[0];if(!r)return console.log("no sealed row");const[,iv,tag,ct]=String(r.db_token_enc).split(".");const d=c.createDecipheriv("aes-256-gcm",c.createHash("sha256").update(process.env.KEYRING_SECRET).digest(),Buffer.from(iv,"base64url"));d.setAuthTag(Buffer.from(tag,"base64url"));try{d.update(Buffer.from(ct,"base64url"));d.final();console.log("KEYRING OK")}catch{console.log("KEYRING MISMATCH")}})()'
      ```
      **`KEYRING MISMATCH` means stop: do not switch.** The value from the notes is wrong, and every non-legacy workspace would fail to open (and anything sealed during the window would be written under the wrong key). "no sealed row" means there is nothing to test; then sign in through the pinned host and open a non-legacy workspace instead.
   8. Then **Stop**: production workspaces must not be reconciled by two hosts before the switch.
5. **Inngest: stop Vercel re-syncing (OWNER).**
   - In the Inngest dashboard, check the app's URL (**Apps**, the app): note whether it is `https://particl.si/api/inngest` or a `*.vercel.app` address.
   - In Inngest's **Vercel integration** settings, **turn off sync for this project**. Do not uninstall: that can remove the keys from Vercel.
   - Confirm Vercel Production still lists both Inngest keys.
6. **Redirect rule for `particl.app` (OWNER).** Created and proxied as in "Domains and DNS" (it can already exist).
7. **Restore point B (OWNER).** Write down the UTC time just before step 8.
8. **Switch DNS (OWNER's "go").**
   - Start the production app; wait for its health check to be green; the pinned `curl --resolve` check answers 200.
   - In Cloudflare: `particl.si` A to `<server IPv4>` and `www.particl.si` CNAME to `particl.si`, both **DNS-only (grey)**, no AAAA.
   - Mail records untouched.
   - **Cron moves now, right after the DNS change** (before the Inngest re-sync in step 10):
     1. **OWNER (app):** Coolify, the production app, **Scheduled Tasks**, `cron-sync`: enable it, and **wait for its first successful run** (status 200 in the task's log, within 10 minutes) before the next line.
     2. **Advisor/owner: Vercel, the project, Settings, Cron Jobs, Disable Cron Jobs** (the button is labelled **Disable Cron Jobs** in Vercel's docs, "Managing Cron Jobs", checked 8 Oct 2026). Disabled cron jobs stay listed; nothing is redeployed. Why: Vercel Cron calls Vercel's **own** production deployment (a `*.vercel.app` address, per Vercel's docs), not `particl.si`, so it would otherwise keep running the sync on Vercel, against the same databases, for as long as the fallback deployment stays up.
     - Both crons running for a few minutes is safe: the whole workspace sweep runs under one lease in the platform database, `acquireOperationLease(deps.client, RECONCILIATION_OPERATION, 330_000, start)` (`lib/reconciliation.ts` line 21; lease name `workspace-reconciliation`, line 4; 330 s; table `operation_leases`, `lib/operationLease.ts` lines 42 to 56). A second run while the lease is held does nothing and answers `skipped: "already_running"` (`lib/reconciliation.ts` line 22). Do not leave both on for days.
9. **DNS and certificates.** `dig +short particl.si @1.1.1.1` and `@8.8.8.8` both print the server's address (within the old TTL). The pinned `openssl` checks name Let's Encrypt for both names. Only on fallback (b): restart the proxy now, as described there.
10. **Inngest re-sync (OWNER).**
    - Inngest dashboard, **Apps**, **Sync new app** (or **Resync**) with URL `https://particl.si/api/inngest`; or run `curl -X PUT https://particl.si/api/inngest` once (only after step 9's `dig` shows the server).
    - The app must then show URL `https://particl.si/api/inngest` and **7 functions** (as on 8 Oct). Inngest reaches the server directly (grey cloud).
    - If the URL was a `*.vercel.app` address in step 5, this step is what moves the work: until it is done, Inngest keeps running jobs on Vercel.
11. **Stripe webhook check (OWNER).** Stripe dashboard, **Developers, Webhooks**. This code has no Stripe webhook route, so if an endpoint for `particl.si` exists, it already fails today and nothing changes. Note it; there is nothing to repoint.
12. **Smoke (right after; pinned to the server).**
    - `curl -sI --resolve www.particl.si:443:<server IPv4> 'https://www.particl.si/pricing?x=1'` answers 301, 302 or 308 to `https://particl.si/pricing?x=1` (302 on 8 Oct).
    - `curl -sI 'https://particl.app/pricing?x=1'` and `www.particl.app` answer **308** to `https://particl.si/pricing?x=1` (Cloudflare answers these).
    - `bash ops/selfhost/smoke.sh https://particl.si`, **only after** step 9's `dig` shows the server from this machine too (`dig +short particl.si`): otherwise it may be testing Vercel.
    - Sign in in a browser; a price shows as `N cr`; an old image (from Blob) and a new upload (R2) both display.
    - `curl -s --resolve particl.si:443:<server IPv4> https://particl.si/api/inngest` answers 200 with a function count above 0 and a signing key present (not the 503 "not configured").
    - **No paid press.** In the app's terminal, run:
      `node -e 'console.log(["VERCEL_TOKEN","VERCEL_TEAM_ID","VERCEL_PROJECT_ID","ASTRA_BLENDER_SNAPSHOT_ID","ASTRA_BLENDER_RATE_CARD","AI_GATEWAY_API_KEY","VERCEL","VERCEL_ENV","TRUST_CF_CONNECTING_IP"].map(k=>k+": "+(process.env[k]?"set":"MISSING")).join("  "))'`
      The first six must print `set`; `VERCEL`, `VERCEL_ENV` and `TRUST_CF_CONNECTING_IP` must print **MISSING**.
    - From the outside network: Coolify's ports still time out.
13. **Cron check (OWNER).**
    - `cron-sync` (enabled in step 8) shows `cron-sync: 200` in its log on two runs, and the cron time in the signed-in `/api/health` answer keeps advancing.
    - Vercel, the project, **Settings, Cron Jobs** shows the cron jobs disabled (step 8).
    - If `cron-sync` does not answer 200 (for example 401: `CRON_SECRET` missing in the container), fix it in the app's env. Meanwhile re-enabling Vercel Cron Jobs is safe (the lease, step 8); disable it again once `cron-sync` answers 200.
14. **Watch window: 14 days; Vercel fallback: owner's choice, at least 1–2 days.**
    - Daily: `/api/health`, 5xx in the app log, the cron heartbeat, the Inngest dashboard (failed syncs and runs), `dispatch.refused` and `[client-ip] ... one shared bucket` in the app log.
    - **OWNER:** the first real long job (an Astra render or a dubbing job) completes in the Inngest dashboard.
    - **The Vercel production deployment stays deployed and untouched as the DNS fallback for at least 1–2 days after step 8 (owner, 8 Oct); keep it longer if anything looks wrong.** The Vercel team and project stay in any case (Sandbox renders and its snapshot belong to them). Turso point-in-time restore covers the whole 14-day watch on the Scaler plan (30 days; check the window in the dashboard).
    - The commit in the signed-in health answer comes from `GIT_COMMIT_SHA`, which the Dockerfile sets from Coolify's `SOURCE_COMMIT`. It reads `local` when no commit was passed to the build; that is cosmetic. Do not set `GIT_COMMIT_SHA` by hand.
15. **Rollback (by DNS while Vercel production is still deployed; by restore point within the 14-day watch).**
    1. **OWNER:** in Cloudflare, restore `particl.si` and `www.particl.si` to the values written down in step 2 (grey cloud, as today).
    2. **OWNER:** re-enable Vercel Cron Jobs (Vercel, the project, **Settings, Cron Jobs**, the enable button in place of **Disable Cron Jobs**; its exact label is not in Vercel's docs: check) and disable `cron-sync` on the server. **Keep the production app running** until at least the TTL has passed since the DNS change (plus a few minutes) and `dig +short particl.si @1.1.1.1` and `@8.8.8.8` show Vercel again, so visitors still on the old answer are served. Then stop it.
    3. **OWNER:** once DNS points back at Vercel, press **Resync** on `https://particl.si/api/inngest` in the Inngest dashboard (that URL then reaches Vercel); check it shows 7 functions. The Inngest Vercel integration was never connected (8 Oct), so there is no integration sync to re-enable. Never sync to `https://www.particl.app/api/inngest`: it redirects to `particl.si`.
    4. **Data, ordinary rollback: nothing to copy back.** Both hosts use the **same Turso databases** (platform and workspaces), the **same R2 bucket** and the **same Blob store**. With R2 selected, the self-hosted app keeps nothing durable on its own disk (upload pieces go to R2 too). Everything written during the window is already where Vercel reads it. An upload in progress at the moment of switching may need to be retried.
    5. **Data problem (wrong or damaged rows):** go back to point B (or A) as in "Restore point". This is a hand-made restore from the Turso timestamps, with Claude's help; everything written after that time is lost. It is the owner's decision, not a reflex.
    6. **Never** use Vercel's Instant Rollback to a deployment from before #524 (it predates the credit switchover and would bill the wrong price).
16. **After the window (OWNER).** Retire the Vercel deployment and domains, but **keep the Vercel team, project and snapshot** while Astra renders run on Vercel Sandbox. Rotate exposed keys. Retire Blob only after every old Blob object is copied to R2. Before the Vercel account is closed, follow "Before Vercel is cancelled".

## Astra Blender renders from the self-hosted host

**How it works today (read in code).** The app drives a **Vercel Sandbox** microVM with `@vercel/sandbox` 3.3.0 (`lib/astra-blender/sandbox.ts`). The VM starts from the snapshot in `ASTRA_BLENDER_SNAPSHOT_ID`, in region `iad1`, with 2 vCPUs, an empty environment, no ports and a deny-all network policy. The app writes the inputs in, runs Blender, reads the `.blend`, the PNG preview and the GLB back out, stores them in R2 itself, then stops the VM. The VM never calls the app back.

**How it signs in.**
- **On Vercel:** `credentials()` (sandbox.ts, lines 98 to 102) passes nothing, so the SDK uses the function's own Vercel OIDC identity. No variables needed.
- **Off Vercel:** there is no OIDC identity. The SDK needs all three of `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, which `credentials()` passes when all three are set. With any missing it falls back to OIDC and fails ("Could not get credentials from OIDC context").
- So the self-hosted app needs: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `ASTRA_BLENDER_SNAPSHOT_ID`, `ASTRA_BLENDER_RATE_CARD`. Never `VERCEL_OIDC_TOKEN` (it expires within hours).

**No other Vercel dependency.** The render path reads no `VERCEL_ENV`, `VERCEL_URL` or request origin. There are no callback URLs, and the sandbox never uploads to storage itself: the app moves the files.

**How long, and where it waits.**
- One render: a 180 s ceiling on the VM, 165 s on the Blender command, plus moving inputs (up to 100 MiB) and outputs (up to 320 MiB). The 18 Sep test render took about 8 s.
- The browser never waits on it: the render request answers **202** at once, and the panel polls every 5 s.
- The work runs in the background as the Inngest function `astra-blender-render` (step `render-persist-and-account`, up to 2 retries). That one step is one request from Inngest to `/api/inngest`. With grey cloud it goes straight to the server, so no 100 s limit applies; `INNGEST_STREAMING=true` is already set for the later orange cloud.
- If anything in between cut that request, the app would keep running the render, and Inngest's retry would find the job already started and do nothing, so a second VM is never bought (`runAstraRender` only starts a job that is still queued). The person would see the result late rather than twice.
- From this server the inputs and outputs cross the Atlantic to `iad1`; only a real render shows how long that takes.

**Code change: done (PR #571, merged into `release/1`).** Off Vercel, 3D counts as available only when all three `VERCEL_*` credentials are set (`astraRuntimeStatus`, sandbox.ts line 83); otherwise the panel shows it as not connected and a render is refused before any credits are reserved. Before #571, a missing credential let a render be funded, fail at `Sandbox.create`, and stay `uncertain` with its credits held. `main` needs #571 too (PR #566's list). The step 12 check still confirms the names are set.

**Confirmed by reading code:** the sign-in rule, the five names, no callback or Vercel-address dependency, the 180 s and 165 s limits, Inngest background dispatch with a 202 to the browser, no second VM on a retry, and that `ENGINE_MOCK=1` blocks any render (so staging cannot render as it is set today).

**Only a real render confirms:** that the owner's token, team and project are accepted and can start the snapshot, and the transfer time from this server. (Whether `INNGEST_STREAMING` keeps a long step clear of Cloudflare's 524 only matters for the later orange cloud.)

**Proposed render test (only on the owner's "run"; it costs money).**
1. Free check first: on staging, add the three `VERCEL_*` names. In staging's terminal, `node -e 'import("@vercel/sandbox").then(({Sandbox})=>Sandbox.get({token:process.env.VERCEL_TOKEN,teamId:process.env.VERCEL_TEAM_ID,projectId:process.env.VERCEL_PROJECT_ID,name:"astra-blender-00000000-0000-0000-0000-000000000000",resume:false})).then(()=>console.log("unexpected: found")).catch(e=>console.log("answer:",e?.response?.status??e?.name))'` looks up a VM that does not exist, so nothing is bought. A not-found answer (404) means the credentials are accepted; 401 or 403 means the token, team or project is wrong. The exact error shape is unverified, so read it with Claude, without pasting values.
2. Real render: on staging, add `ASTRA_BLENDER_SNAPSHOT_ID` and `ASTRA_BLENDER_RATE_CARD`, and remove `ENGINE_MOCK` for the test only. Staging has no engine keys, so nothing else can spend. Grant the staging workspace a few credits, run **one** render of a template scene, check that the outputs appear, then set `ENGINE_MOCK=1` again and remove the five names.
3. Cost: at the sample `iad1` rate card in `docs/astra-blender-runtime.md`, at most about US$0.10 for one render, billed to the Vercel team. Staging dispatches natively, so this does not test the Inngest path: that is the first real render after the switch (step 14).

### What replaces Sandbox later

The SOW plans a **worker container** (Phase 3, P8, "many clients") that Inngest hands jobs to (E7R: "server renders in the VPS worker via Inngest"). For Astra Blender that means:
- **What:** a Blender 5.2.2 container from the same official archive, checked against the same SHA256 (`docs/astra-blender-runtime.md`). It runs the same fixed launcher limits (memory, CPU seconds, file sizes) with no network for the render process.
- **Where:** on this server at first (2 vCPUs and 4 GB per render, so few at once next to the app), or a separate CPU or GPU host if volume grows. A GPU only matters if renders move off CPU Cycles.
- **How it is picked up:** the existing Inngest function `astra-blender-render` and its concurrency limits stay (4 at once, 2 per workspace). Only the runtime behind the narrow boundary in `sandbox.ts` (create, write files, run, read file, stop) changes. Job identity, "never buy twice" and settlement stay as they are.
- **What it needs:** a reviewed PR for the adapter; a new rate card for our own compute, since `ASTRA_BLENDER_RATE_CARD` prices Vercel's; the owner's approval of that price; and a host sizing check. Until then, the Vercel team, project and snapshot must stay.

## Before Vercel is cancelled

The owner closes the Vercel account before **27 October 2026**. Closing it deletes the Blob store and stops every other Vercel service the app uses. This section covers both. Nothing here has been run yet.

### 1. Copy every Blob object to R2

**Why.** Older files are still only on Vercel Blob. Today the app reads R2 first and falls back to Blob through `BLOB_READ_WRITE_TOKEN`. When the account closes, anything not on R2 is gone and its links break. The app reads an old file from R2 at the same key: the Blob pathname for a bare key, or the decoded path of an absolute Blob URL (`lib/storage/backend.ts`, `resolveStored`). `scripts/ops/blob-to-r2.mjs` copies to exactly those keys.

**What the script does.**
- It lists every Blob object (paged), then the whole R2 bucket.
- It skips any object R2 already has at the same size. `--deep` also checks it by SHA-256.
- It streams each missing object (memory stays at about 16 MiB per transfer) with a conditional write (`If-None-Match: *`). It never overwrites an R2 object. If R2 already holds different bytes at a key, that is reported as a **conflict**.
- It checks each copy (R2's MD5 ETag for one-piece files, a read-back SHA-256 for multipart). Network faults, 5xx and 429 answers are retried.
- After each verified file it writes one line to `blob-to-r2-progress.jsonl` in the private folder, so rerunning the same command carries on where it stopped.
- The screen shows counts only. Keys, which can contain a customer's file name, go only into report files in the private folder.
- It never deletes anything, on either store.

**Who and where.** The owner or the advisor, on their own machine (or the server's terminal), never on a shared or CI machine. It needs Node 24 and a checkout of this repo with `npm ci` done. Put the production values in a private env file **outside the checkout** (for example `/private/blob-to-r2.env`, `chmod 600`) using the app's own names: `BLOB_READ_WRITE_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_ENDPOINT` only if production sets it. The R2 key needs Object Read & Write on the production bucket. Use one private folder (for example `/private/blob-to-r2`, `chmod 700`) for every run: it holds the progress file and the reports. The script refuses a folder inside the checkout or one that others can read.

**How long.** Unknown until the dry run measures it. The dry run prints the bytes still to copy and, from a timed read of up to 64 MiB (`--probe-mib`), `probe.estimatedCopyMinutes`. That is twice the download time, to allow for the upload too. In September the store held about 404 MB, so expect minutes, not hours, but the dry run decides.

**Run order (stop at any step that does not pass):**
1. **Dry run.** No writes to R2.
   `node --env-file=/private/blob-to-r2.env scripts/ops/blob-to-r2.mjs --dry-run --private-dir /private/blob-to-r2`
   Read `blobObjects`, `blobBytes`, `toCopy`, `toCopyBytes`, `presentSameSize`, `conflicts` and `probe`.
2. **Copy.**
   `node --env-file=/private/blob-to-r2.env scripts/ops/blob-to-r2.mjs --copy --private-dir /private/blob-to-r2`
   If it stops or exits with failures, run the same command again. It resumes. Repeat until `failed` is 0 and a run shows `copied` 0. For a final full check of files that were only matched by size (for example ones the older `migrate-media-r2.mjs` copied), run once more with `--deep`.
   **Conflicts:** each one is a key where R2 already holds a different file. The app already shows the R2 version, so users see no change. The Blob version is lost when Vercel closes. The advisor reads the conflict list in the private report with the owner and decides whether any Blob copy must be kept (downloaded privately) first.
3. **Verify on R2 alone.**
   `node --env-file=/private/blob-to-r2.env --env-file=/private/backup-source.env scripts/ops/blob-to-r2.mjs --verify --private-dir /private/blob-to-r2 --config /private/backup-source.json`
   `--config` is the backup source inventory (database ids and env-variable names, "Capture" in `docs/backup-restore.md`). Its URL/token variables are read-only here. The script snapshots each database into the private folder, checks that every media row resolves on R2 with **no Blob fallback** (the same rules as the backup's r2-only coverage, `verifyMediaReferences`), then deletes the snapshots. With the Blob token in the environment, it also checks that every Blob object is on R2 at its keys. It must print `"ok":true` and `"blobObjectsNotOnR2":0`. If it fails, it names database/table/row ids only. Copy again, then verify again.
4. **Remove `BLOB_READ_WRITE_TOKEN` from the app** (Coolify production app; also Vercel while it still serves) and redeploy. Keep the value in the owner's private record until step 6.
5. **Confirm old links still load.** Signed in, open an old image from before R2, download an old upload, play an old video (it should seek), and open an old review link. `/api/health` still says `r2-configured`. Expect one false alarm: the platform-admin readiness check (`lib/deploymentReadiness.ts`) still counts storage as ready only when the Blob token is set, so it shows storage as not ready. That needs a small fix (accept the R2 variables too). It does not affect the app. If an old file does not load, put the token back, redeploy, and report it.
6. **Only then** can Vercel Blob, and Vercel, be cancelled (after section 2 below).

### 2. Other Vercel services that stop when the account closes

Found by searching the code for `@vercel/` packages, `api.vercel.com`, `vercel.sh` and `VERCEL_*` names. Each needs its replacement live **before** the account closes.

| Service | What uses it | What stops | Replacement needed |
|---|---|---|---|
| **Vercel AI Gateway** (`AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL`, default `https://ai-gateway.vercel.sh/v1`; `@vercel/oidc` on Vercel) | `lib/gateway.ts`, `lib/language-provider.ts`, `lib/enhance.ts`, `lib/gemini.ts`, `lib/vendorImages.ts`, `lib/catalog.ts` | All text models (Atomik, prompt enhance, suite agents, idea/script development), gateway stills, and OpenAI image/speech models when no direct key is set. The gateway credit balance shown in admin. | `openai/*` text already runs direct with `OPENAI_API_KEY` (`docs/openai-direct.md`); stills have a direct Google path with `GEMINI_API_KEY` (`lib/gemini.ts`); prompt enhance has direct Anthropic (`ANTHROPIC_API_KEY`) and BytePlus paths (`lib/enhance.ts`). **Atomik and the suite agents** on Claude, Google, xAI or ByteDance models have **no direct path in the code today**. They need a reviewed change: direct vendor adapters, or another OpenAI-compatible gateway set through `AI_GATEWAY_BASE_URL`, after checking its model ids and prices. Costs feed the rate card, so this needs the owner's approval. |
| **Gateway key minting** (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `api.vercel.com`) | `lib/vercelKeys.ts`, `lib/purge.ts` | Nothing mints keys today (`mintGatewayKey` has no callers). But `revokeGatewayKey` throws once the `VERCEL_*` names are removed or dead, so deleting a workspace that still has a `gateway_key_id` stalls in purge after its files are removed. Before closing, count `SELECT count(*) FROM workspaces WHERE gateway_key_id IS NOT NULL` on the platform database; if it is not 0, ask Claude for a small fix first. | Follows from the gateway choice above: the new provider's per-workspace keys and budgets, or the platform key plus `lib/allowance.ts`. |
| **Vercel Sandbox** (`@vercel/sandbox`; `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `ASTRA_BLENDER_SNAPSHOT_ID`, `ASTRA_BLENDER_RATE_CARD`) | `lib/astra-blender/sandbox.ts`, `scripts/astra-blender-snapshot.mjs` | All Astra Blender (3D) renders. The snapshot is deleted with the account. **Before the account closes, while Vercel still answers:** turn 3D off by removing the three `VERCEL_*` names from the app (new renders are then refused before any charge), then wait until `SELECT count(*) FROM astra_render_jobs WHERE settled=0` is 0 in every workspace database (run it with Claude). A job still unsettled when the account closes can never be reconciled and keeps its credits held. #571 only catches missing names: with names set but dead, 3D still looks connected, and a render could be funded and then fail at `Sandbox.create`. | The worker container in "What replaces Sandbox later": a reviewed adapter PR, a new rate card for our own compute (owner approves the price), and host sizing. Until that lands, 3D is off. |
| **Vercel Blob** (`@vercel/blob`, `BLOB_READ_WRITE_TOKEN`) | `lib/storage/blob.ts`, `scripts/ops/backup-lib.mjs`, `scripts/ops/staging-rehearsal.mjs`, `scripts/ops/migrate-media-r2.mjs` | Every file not yet on R2, and backups or rehearsals configured with `blob` or `dual` media. | Section 1 above. Then switch the nightly backup's media to `{ "kind": "r2", ... }` (`docs/backup-restore.md`). The Blob cost rates (`BLOB_USD_PER_GB_*`, `lib/storageCost.ts`) become meaningless; R2 rates are package 11 in `docs/r2-storage-plan.md`. |
| **Inngest's Vercel integration** | Inngest dashboard (not in code) | Automatic app re-sync and key syncing to Vercel. | Cutover steps 5 and 10 already move the app URL to `https://particl.si/api/inngest`, with the keys set in Coolify. Before closing Vercel, confirm the Inngest app shows that URL and 7 functions. The integration was never connected (8 Oct), so there is nothing to uninstall. |
| **Vercel Cron** (`vercel.json` `crons`, `/api/cron/sync` every 10 min) | `vercel.json` | The reconciliation cron on Vercel. | Cutover step 13 (Coolify scheduled task `cron-sync`). Confirm its heartbeat advances. |
| **Hosting, domains, deployments, previews** (`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_OIDC_TOKEN`) | `lib/site.ts`, `lib/dispatch.ts`, `lib/previewSeed.ts`, `lib/deployment.ts`, `lib/recovery.ts`, `lib/workerProbe.ts`, health routes | The Vercel site, preview deployments and the rollback path in cutover step 15. | The self-hosted app (this document). Off Vercel these names are unset by design ("Never set on the self-hosted app"). Preview deployments have no replacement except the staging app. **Rollback to Vercel ends when the account closes**, so close it only after the 14-day watch (step 14) has passed. |
| **Values only Vercel holds** | Vercel project settings | Any variable not yet copied (Sensitive values cannot be read back). | Copy every value into Coolify or the owner's private record **before** closing ("If Vercel will not show a value"). |

`KEYRING_SECRET`, Turso, R2, Resend, Liveblocks, Stripe, fal, ElevenLabs, BytePlus, Higgsfield API and the other engine keys do not depend on the Vercel account.

## Gates before cutover (SOW section 4)

Each is passed, or waived by the owner in writing (cutover step 0).
1. **P2 finish:** Coolify keys saved, dashboard domain, GitHub App, real visitor addresses, outside monitor, server snapshots. (The server firewall is cutover step 3; the Cloudflare certificate belongs to the later orange-cloud section.)
2. **P3 media:** R2 on (`r2-configured`), media domain with signed links, thumbnails and posters; Blob downloads near zero.
3. **P4 beside Vercel:** the `main` fixes (PR #566's list); self-hosted Inngest sized for 1,000 jobs with per-plan limits; staging with all 12 smoke checks.
4. **The 1,000-job load test** passes on staging.
5. **The credit switchover** (`CREDIT_USD` 0.10) is done on Vercel first, and that database is the one the new host uses.
6. After cutover (not a blocker): cron moved, 14 days of watching, Vercel deployment and domains retired (keep the team, project and snapshot), exposed keys rotated, Blob retired only after every old object is in R2.

## Later: orange cloud (only after every long flow is proven under 100 s)

**Not part of the cutover.** Do this only when the owner decides, after every long flow is proven under 100 s on the live site. Until then `particl.si` and `www.particl.si` stay grey.

**Why it waits.** On a proxied (orange) name, Cloudflare (Free, Pro and Business) returns a **524** when the server sends **no bytes for about 100 s**. Traefik cannot change that.
- Chunked uploads and streamed downloads are fine: bytes keep flowing.
- `POST /api/uploads/finish` no longer risks a 524: it answers within about 10 s (the receipt, or `202` while it assembles in the background), and the browser polls `/api/uploads/session`.
- Inngest steps (an Astra render, a dubbing poll) can pass 100 s. `INNGEST_STREAMING=true` (already set) makes the route answer at once and send a byte every few seconds.
- **Requests that wait silently can pass 100 s:**
  - `/api/audio/transcribe` (waits for the whole transcription);
  - the model calls under `/api/atomik/` (ideas, shot and scene drafts, memory read);
  - `/api/prompt/enhance`, `/api/mcp`, and starting identity training.
- **Proving it:** in the watch window, read how long these took (app log, Inngest run times). If any can pass 100 s, it needs a product change first (answer at once and let the browser poll, or direct-to-storage uploads), each its own PR.

**Steps (OWNER, with the advisor), in this order:**
1. **Staging first.** Put staging on `staging.particl.si`, proxied, and run all of the steps below on it. Staging must stay reachable and its certificate must stay valid through this. The **Coolify dashboard's own domain** must stay reachable too: proxied with the same certificate, or allowed in the firewall for the owner's address.
2. **Certificate behind the orange cloud.**
   - **If the DNS-challenge resolver (`letsencrypt-dns`, main path (a)) is in place, keep it.** It keeps renewing behind the orange cloud, and Full (strict) accepts a Let's Encrypt certificate, so the Origin Certificate below is optional.
   - Otherwise use the Origin Certificate, and **take these names off the HTTP-01 resolver** (`certresolver=letsencrypt` in the app's labels): HTTP-01 renewals can fail behind the orange cloud and Always Use HTTPS.
   - Cloudflare, `particl.si` zone, **SSL/TLS, Origin Server, Create Certificate** for `particl.si` and `*.particl.si`.
   - On the server, save the certificate and key as files under `/data/coolify/proxy/certs/`.
   - In Coolify, **Servers, Proxy, Dynamic Configurations**, add a file that makes them Traefik's **default certificate**: `tls.stores.default.defaultCertificate`, with `certFile` and `keyFile` under `/traefik/certs/`. Verify that mount path in the proxy compose.
   - Never paste the private key anywhere.
   - Check from the server itself: `openssl s_client -connect 127.0.0.1:443 -servername particl.si </dev/null 2>/dev/null | openssl x509 -noout -issuer` names Cloudflare.
3. **SSL/TLS mode Full (strict)** and **Always Use HTTPS** in the `particl.si` zone. The proxied staging name answers 200, not 526.
4. **Bot Fight Mode off** (**Security, Bots**). It challenges Inngest's calls to `/api/inngest`, and on the free plan no rule can exempt a path from it. Add a WAF custom rule that **skips** the other security rules for `/api/inngest` and `/api/worker` (the app hands work to itself at `/api/worker` if the Inngest keys were ever missing).
5. **Cloudflare-only firewall.** Ports 80 and 443 accept only Cloudflare.
   - **(a)** Contabo's control-panel firewall, if the plan has it: TCP 80 and 443 only from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6. **Close UDP 443:** Cloudflare talks to the server over TCP only, so HTTP/3 to the server is no longer needed. Admin ports stay closed as in the 8 Oct box (22 open, keys only).
   - **(b)** Rules on the server, as root. Save as `/usr/local/sbin/particl-cf-only.sh` (root, mode `700`). It keeps a copy of Cloudflare's list, refreshes it only when the download looks complete, and stops without changing anything if it has no usable list, so it never installs a DROP with nothing allowed:
     ```sh
     #!/bin/sh
     set -eu
     IF="<public interface>"    # shown by: ip route get 1.1.1.1
     [ -n "$IF" ] || { echo "fill in IF"; exit 1; }
     case "$IF" in *"<"*) echo "fill in IF"; exit 1;; esac
     LIST=/etc/particl/cf-ips-v4
     mkdir -p /etc/particl
     NEW=$(curl -fsS -m 20 https://www.cloudflare.com/ips-v4 || true)
     if [ "$(printf '%s\n' "$NEW" | grep -c /)" -ge 10 ]; then printf '%s\n' "$NEW" > "$LIST"; fi
     [ -s "$LIST" ] && [ "$(grep -c / "$LIST")" -ge 10 ] || { echo "no usable Cloudflare list: nothing changed"; exit 1; }
     CF4=$(cat "$LIST")
     iptables -N CF-ONLY 2>/dev/null || iptables -F CF-ONLY
     for r in $CF4; do iptables -A CF-ONLY -s "$r" -j RETURN; done
     iptables -A CF-ONLY -j DROP
     for p in 80 443; do
       iptables -C DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j CF-ONLY 2>/dev/null ||
       iptables -I DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j CF-ONLY
     done
     # HTTP/3 (UDP 443): closed to everyone.
     iptables -C DOCKER-USER -i "$IF" -p udp -m conntrack --ctstate NEW --ctorigdstport 443 -j DROP 2>/dev/null ||
     iptables -I DOCKER-USER -i "$IF" -p udp -m conntrack --ctstate NEW --ctorigdstport 443 -j DROP
     # IPv6: no AAAA record, so close 80 and 443 over IPv6.
     if command -v ip6tables >/dev/null 2>&1 && ip6tables -L INPUT >/dev/null 2>&1; then
       for p in 80 443; do
         ip6tables -C INPUT -p tcp --dport "$p" -j DROP 2>/dev/null || ip6tables -I INPUT -p tcp --dport "$p" -j DROP
       done
       ip6tables -C INPUT -p udp --dport 443 -j DROP 2>/dev/null || ip6tables -I INPUT -p udp --dport 443 -j DROP
     else
       echo "ip6tables not available: IPv6 rules skipped (check with curl -6 from outside)"
     fi
     ```
     If `ip6tables -L DOCKER-USER` exists, the advisor adds the same IPv6 drops there. **After a reboot:** add `ExecStart=/usr/local/sbin/particl-cf-only.sh` as a second `ExecStart` line in `particl-firewall.service` (main path (b)), then `systemctl daemon-reload` and `systemctl restart particl-firewall.service`. No `netfilter-persistent`. Cloudflare's list changes now and then; re-running the script picks up the new list.
   - Or remove HTTP/3 from the proxy instead: delete the `--entrypoints.https.http3` line and the `443:443/udp` port in the proxy compose, then restart the proxy.
   - **Check from an outside network:**
     - `curl -m 10 -skI https://<server IPv4>/`: **times out**;
     - `curl -6 -m 10 -skI https://[<server IPv6>]/`: **times out**;
     - `curl --http3-only -m 10 -skI https://<server IPv4>/`: **times out** (needs a curl built with HTTP/3);
     - a proxied name still answers;
     - the same after a reboot of the server.
6. **Switch `particl.si` and `www.particl.si` to proxied (orange).** `dig +short particl.si @1.1.1.1` then shows Cloudflare's addresses, not the server's. Pinned checks go through Cloudflare from now on: `curl -sI https://particl.si/` answers 200 with a `cf-ray` header.
7. **Only now**, with TCP **and** UDP both filtered: set `TRUST_CF_CONNECTING_IP=1` on the production app and redeploy. Then repeat the per-address limits check (network A locked, network B still signs in).
8. **Rollback:** first unset `TRUST_CF_CONNECTING_IP` (redeploy), then set the two records back to grey. Open 80 and 443 to everyone again: remove the `particl-cf-only.sh` `ExecStart` line, delete its `DOCKER-USER` rules (`iptables -S DOCKER-USER`, then `iptables -D` each `CF-ONLY` and UDP 443 line), and restore the main path's firewall (a).
