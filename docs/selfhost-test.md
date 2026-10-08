# Self-hosted Particl: staging, production settings and the cutover

For the owner. The app runs in Coolify (Traefik v3 proxy) on the server **contabo**. DNS is on Cloudflare. **Files only:** nothing in Vercel, Cloudflare, DNS, Turso, Inngest, Stripe or the server is changed by this document. The owner runs every step, and **nothing in "Cutover order" happens without the owner's "go".**

**Where things stand (8 Oct 2026).**
- **Staging PASSED** on `release/1` at `c287f044`: Dockerfile build, served on a temporary sslip.io `https` address, `/setup` sign-in, workspace rename, an upload to the **staging R2 bucket** with its thumbnail, `/api/health` ok.
- **Live** is `particl.si` and `www.particl.si` on Vercel. `particl.app` and `www.particl.app` are on Cloudflare and only need the redirect.
- **Owner's decision for the cutover:** `particl.si` and `www.particl.si` stay **DNS-only (grey cloud)**, as they are today with Vercel. Visitors reach the server directly, so Cloudflare's 100-second limit does not apply. Orange cloud comes later, only after every long flow is proven under 100 s (see the last "Later" section).
- Production on Vercel today: storage `r2-configured` (R2 for new files, old links still on Vercel Blob), `DISPATCH_MODE=inngest`, mail from `hello@particlstudio.com`, AI through the Vercel AI Gateway, Astra Blender renders in use (Vercel Sandbox).

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

**What `main` needs before it can run self-hosted:** the lead keeps that list in the description of PR #566.

Never write the server's IP, the sslip.io address or any secret value in the repo, a chat or a public place. This document names variables and where their values come from; it never holds a value that is secret.

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
- Every variable is a **runtime** variable. Only the two `NEXT_PUBLIC_*` names are build variables: in Coolify tick **Build Variable** (newer versions: "Available at Buildtime") on those two and **untick it on every other variable**, so no secret reaches the build or the image history.

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
| `CREDIT_USD` | fixed: `0.10` | yes |
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
| `CRON_SECRET` | **copy from Vercel** (generate a new one only if it is Sensitive; then check after the switch that the cron heartbeat still advances) | not strictly, but **required**: without it `/api/cron/sync` answers 401 in production and the health check's cron status goes stale. The server's own scheduled task reads it from the container. |
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
| `MAIL_FROM` | fixed: `hello@particlstudio.com` | yes |
| `RESEND_API_KEY` | copy from Vercel, or Resend, **API Keys**, create one with sending access for `particlstudio.com` | any valid |
| `RESEND_BASE_URL` | copy only if Vercel sets it | yes if set |

Nothing changes in the `particlstudio.com` DNS; it is not one of the domains being moved.

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

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_OIDC_TOKEN`. Vercel sets these itself; on another host they switch the app into Vercel behaviour: `VERCEL` alone makes the app read client addresses the Vercel way (anyone can then fake them) and send the AI gateway an OIDC identity it does not have. **Never bulk-paste a `vercel env pull` file into Coolify:** it contains `VERCEL=1`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_*` and `VERCEL_OIDC_TOKEN`. Copy the names in the tables above one by one. Also not added: `NODE_ENV`, `PORT`, `HOSTNAME` (the image sets them) and the script-only names (`PARTICL_BACKUP_*`, `PW_*`, `AIMIGHTY_*`, `PARTICL_URL`, `PARTICL_TOKEN`).

### If Vercel will not show a value (Sensitive)

Vercel never shows a **Sensitive** variable again, and `vercel env pull --environment=production` returns it **empty**. A pull is still the quickest way to see which ones are Sensitive: run it in a private folder outside the repo, copy what you need into Coolify, then delete the file. For a value that came back empty:

| Name | Safe path | What breaks if a new value is used instead |
|---|---|---|
| `KEYRING_SECRET` | The owner's own record. Nothing else has it. | **Everything sealed with it:** every workspace's database token (workspaces cannot open their data), stored workspace keys, two-step sign-in and recovery codes, pending invitations. **If there is no record, stop.** The code has no way to re-seal under a new keyring (`lib/keyring.ts` reads one secret). Moving would first need a planned rotation: a reviewed re-seal tool, run against the databases while Vercel is still live. |
| `VAPID_PRIVATE_KEY` (and its public key) | The owner's own record. | Notifications stop for everyone who turned them on, until they turn them on again in the new app. Not data loss. |
| `BLOB_READ_WRITE_TOKEN` | Vercel, **Storage**, the Blob store, its token (unsure of the exact label). | No other value works (it is the store's own token). Without it, old Blob links break. If it cannot be found, do not cut over until every old Blob object is copied to R2 (`scripts/ops/migrate-media-r2.mjs`, gate 2). |
| `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | Inngest dashboard (see the table above). | Nothing; these are the same keys. |
| `PLATFORM_AUTH_TOKEN`, `TURSO_AUTH_TOKEN`, `TURSO_API_TOKEN` | Create a new token in Turso. Creating does not cancel the old one, so Vercel keeps working. | Nothing. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Create a new R2 API token for the same bucket. | Nothing. |
| `RESEND_API_KEY`, `AI_GATEWAY_API_KEY`, engine keys | Create a new key in that vendor's dashboard. Do not **roll** or delete the old one while Vercel is the live site. | Nothing. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe dashboard, **Developers** (API keys, Webhooks). If Stripe only offers to roll the key, set an expiry for the old key so Vercel keeps working through the watch window. | Nothing today (card checkout is not wired). |
| `LIVEBLOCKS_SECRET_KEY` | Liveblocks dashboard, the same project. | Nothing. |
| `SESSION_SECRET` | Generate new. | Nothing that matters (see the table). |
| `CRON_SECRET` | Generate new. | Nothing, provided the server's scheduled task runs with it: check the cron heartbeat advances after the switch (step 13). |

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
- In Coolify the production app's **Domains** field is `https://particl.si,https://www.particl.si`. In the app's **General** settings, set **Direction** to **redirect to non-www**, so Traefik sends `www` to `https://particl.si` (a 301 or 308).
- **No AAAA record** at cutover. Docker may relay IPv6 connections so that every IPv6 visitor shows up as one address and shares one rate-limit allowance. Remove any AAAA that points at Vercel.
- `particl.app` and `www.particl.app` only redirect. They stay **proxied** (orange) with a Cloudflare redirect rule; no app traffic passes through them, so the 100 s limit does not matter there.
  - **Redirect rule (OWNER, can be made ahead of time).** In the `particl.app` zone: **Rules, Redirect Rules, Create rule**. If hostname is in `particl.app`, `www.particl.app`, then dynamic redirect to `concat("https://particl.si", http.request.uri.path)`, status 308, **Preserve query string** ticked.

| Name | Record | Proxy | Who answers |
|---|---|---|---|
| `particl.si` | A to `<server IPv4>`, no AAAA | **DNS-only** (grey) | the server (Let's Encrypt) |
| `www.particl.si` | CNAME to `particl.si` | **DNS-only** (grey) | the server, redirects to `particl.si` |
| `particl.app` | A to `<server IPv4>` (any address works; the rule answers first) | proxied (orange) | Cloudflare redirect rule |
| `www.particl.app` | CNAME to `particl.app` | proxied (orange) | Cloudflare redirect rule |

**Do not touch** mail records on any domain (MX, SPF, DKIM, DMARC, the mail sender's verification records) or the `particlstudio.com` zone. If there are CAA records on `particl.si`, they must allow Let's Encrypt.

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

**Today production has no automated encrypted backup.** The scheduled capture in `.github/workflows/backup.yml` never runs (a manual dry run only plans and tests) because the repository variable `PARTICL_BACKUP_ENABLED` is not `true`. The tooling now supports production's R2 + Blob layout (media `dual`, see 2), so turning it on is the owner's settings change, not code. **OWNER, only when deciding to:** in the GitHub environment `particl-backup` (restricted to `main`), set the secrets `PARTICL_BACKUP_SOURCE_JSON` (the source inventory, with `media` as in 2: names only), `PARTICL_BACKUP_ENV_JSON` (a JSON object with the values of every variable that inventory names: the database URLs/tokens, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` if used, `BLOB_READ_WRITE_TOKEN`, and the original `KEYRING_SECRET`), `PARTICL_BACKUP_KEY` and `PARTICL_BACKUP_QUIESCENCE_JSON`; then the repository variable `PARTICL_BACKUP_ENABLED=true`. A read-only R2 token scoped to the bucket is enough. Each capture still needs a real maintenance fence (`docs/backup-restore.md`, "Prepared daily workflow"), and the job's 45-minute limit and artifact size must fit R2 and Blob together.

**Point A = Turso timestamp plus `.dump` copies; point B = Turso timestamp (a second set of `.dump` copies is optional but recommended).** The full encrypted bundle (see 2) now works with production's layout, but it takes the site down for its window: do **not** run the recovery fence on production without the owner's explicit go.

**1. Turso point-in-time timestamps and `.dump` copies (no tooling).**
- **OWNER:** write down the exact UTC time (for example `2026-10-20T09:00:00Z`) for **point A** (before the first deploy) and **point B** (before the switch). It covers the platform database and **every workspace database** (all databases in the production Turso group).
- Check the plan's window in the Turso dashboard: Free 24 hours, Developer 10 days, Scaler 30 days, Pro 90 days. A point older than the window is gone.
- **OWNER, at point A:** `turso db shell <database> .dump > <database>-pointA.sql` for each database. This saves a readable SQL file on the owner's machine. Keep it private: it holds sealed tokens and password hashes.
- **There is no tooling for this path.** A restore means: `turso db create <new name> --from-db <database> --timestamp <time>` for each database, then, by hand with Claude's help, repointing every workspace's database address and token in the platform database. Those tokens are sealed with `KEYRING_SECRET`, so this needs the original keyring and care. It loses everything written after that time.
- **Prove it once, on copies.**
  - Create a copy of the platform database and of one workspace database at point A.
  - Look at them: `turso db shell <new name> "SELECT count(*) FROM workspaces"` on the platform copy, and see the rows.
  - Delete the copies.
  - `turso db shell` is **not** read-only: on any database, run only `.dump` or `SELECT`.
  - Each copy counts toward the plan's database quota while it exists.

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
   3. Every variable in "Live-copy settings" is set. `TRUST_CF_CONNECTING_IP` and `TRUSTED_PROXY_HOPS` are **unset**.
   4. Domains `https://particl.si,https://www.particl.si`, Direction redirect to non-www, stop grace period 300, labels on `letsencrypt-dns`.
   5. Scheduled task: Coolify, the production app, **Scheduled Tasks, + Add**: name `cron-sync`, command `node /app/cron-sync.mjs`, frequency `*/10 * * * *`, timeout 300 s, saved **disabled**. (The script calls `http://127.0.0.1:3000/api/cron/sync` inside the container with `CRON_SECRET`.)
   6. **Deploy** (the first start against the live databases). Check the health check goes green and the pinned certificate check names Let's Encrypt for both names ("Certificates before the switch", check 5). Then **Stop**: production workspaces must not be reconciled by two hosts before the switch.
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
9. **DNS and certificates.** `dig +short particl.si @1.1.1.1` and `@8.8.8.8` both print the server's address (within the old TTL). The pinned `openssl` checks name Let's Encrypt for both names. Only on fallback (b): restart the proxy now, as described there.
10. **Inngest re-sync (OWNER).**
    - Inngest dashboard, **Apps**, **Sync new app** (or **Resync**) with URL `https://particl.si/api/inngest`; or run `curl -X PUT https://particl.si/api/inngest` once (only after step 9's `dig` shows the server).
    - The app must then show URL `https://particl.si/api/inngest` and **6 functions**. Inngest reaches the server directly (grey cloud).
    - If the URL was a `*.vercel.app` address in step 5, this step is what moves the work: until it is done, Inngest keeps running jobs on Vercel.
11. **Stripe webhook check (OWNER).** Stripe dashboard, **Developers, Webhooks**. This code has no Stripe webhook route, so if an endpoint for `particl.si` exists, it already fails today and nothing changes. Note it; there is nothing to repoint.
12. **Smoke (right after; pinned to the server).**
    - `curl -sI --resolve www.particl.si:443:<server IPv4> 'https://www.particl.si/pricing?x=1'` answers 301 or 308 to `https://particl.si/pricing?x=1`.
    - `curl -sI 'https://particl.app/pricing?x=1'` and `www.particl.app` answer **308** to `https://particl.si/pricing?x=1` (Cloudflare answers these).
    - `bash ops/selfhost/smoke.sh https://particl.si`, **only after** step 9's `dig` shows the server from this machine too (`dig +short particl.si`): otherwise it may be testing Vercel.
    - Sign in in a browser; a price shows as `N cr`; an old image (from Blob) and a new upload (R2) both display.
    - `curl -s --resolve particl.si:443:<server IPv4> https://particl.si/api/inngest` answers 200 with a function count above 0 and a signing key present (not the 503 "not configured").
    - **No paid press.** In the app's terminal, run:
      `node -e 'console.log(["VERCEL_TOKEN","VERCEL_TEAM_ID","VERCEL_PROJECT_ID","ASTRA_BLENDER_SNAPSHOT_ID","ASTRA_BLENDER_RATE_CARD","AI_GATEWAY_API_KEY","VERCEL","VERCEL_ENV","TRUST_CF_CONNECTING_IP"].map(k=>k+": "+(process.env[k]?"set":"MISSING")).join("  "))'`
      The first six must print `set`; `VERCEL`, `VERCEL_ENV` and `TRUST_CF_CONNECTING_IP` must print **MISSING**.
    - From the outside network: Coolify's ports still time out.
13. **Cron moves (OWNER).**
    - Enable `cron-sync` on the server. Its log shows `cron-sync: 200` on two runs, and the cron time in the signed-in `/api/health` answer keeps advancing.
    - Only then disable the Vercel cron. Vercel's cron runs on Vercel until then, so there is no gap.
    - The brief overlap is safe (the heartbeat is leased); do not leave both on.
14. **Watch window: 14 days.**
    - Daily: `/api/health`, 5xx in the app log, the cron heartbeat, the Inngest dashboard (failed syncs and runs), `dispatch.refused` and `[client-ip] ... one shared bucket` in the app log.
    - **OWNER:** the first real long job (an Astra render or a dubbing job) completes in the Inngest dashboard.
    - **The Vercel project, deployment and domain settings stay deployed and untouched for at least 14 days after step 8.**
    - The commit in the signed-in health answer comes from `GIT_COMMIT_SHA`, which the Dockerfile sets from Coolify's `SOURCE_COMMIT`. It reads `local` when no commit was passed to the build; that is cosmetic. Do not set `GIT_COMMIT_SHA` by hand.
15. **Rollback (any time in the 14 days).**
    1. **OWNER:** in Cloudflare, restore `particl.si` and `www.particl.si` to the values written down in step 2 (grey cloud, as today).
    2. **OWNER:** re-enable the Vercel cron and disable `cron-sync` on the server. **Keep the production app running** until at least the TTL has passed since the DNS change (plus a few minutes) and `dig +short particl.si @1.1.1.1` and `@8.8.8.8` show Vercel again, so visitors still on the old answer are served. Then stop it.
    3. **OWNER:** re-enable the Inngest Vercel integration's sync for the project and resync, so Inngest's app URL points at Vercel again; check it shows 6 functions.
    4. **Data, ordinary rollback: nothing to copy back.** Both hosts use the **same Turso databases** (platform and workspaces), the **same R2 bucket** and the **same Blob store**. With R2 selected, the self-hosted app keeps nothing durable on its own disk (upload pieces go to R2 too). Everything written during the window is already where Vercel reads it. An upload in progress at the moment of switching may need to be retried.
    5. **Data problem (wrong or damaged rows):** go back to point B (or A) as in "Restore point". This is a hand-made restore from the Turso timestamps, with Claude's help; everything written after that time is lost. It is the owner's decision, not a reflex.
    6. **Never** use Vercel's Instant Rollback to a deployment from before #524 (it predates the credit switchover and would bill the wrong price).
16. **After the window (OWNER).** Retire the Vercel deployment and domains, but **keep the Vercel team, project and snapshot** while Astra renders run on Vercel Sandbox. Rotate exposed keys. Retire Blob only after every old Blob object is copied to R2.

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
- Inngest steps (an Astra render, a dubbing poll) can pass 100 s. `INNGEST_STREAMING=true` (already set) makes the route answer at once and send a byte every few seconds.
- **Requests that wait silently can pass 100 s:**
  - `POST /api/uploads/finish` (assembles up to 2 GB before it answers; a retry recovers);
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
