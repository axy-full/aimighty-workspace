# Self-hosted Particl: staging, production settings and the cutover

For the owner. The app runs in Coolify (Traefik v3 proxy) on the server **contabo**. DNS is on Cloudflare. **Files only:** nothing in Vercel, Cloudflare, DNS, Turso, Inngest, Stripe or the server is changed by this document. The owner runs every step, and **nothing in "Cutover order" happens without the owner's "go".**

**Where things stand (8 Oct 2026).**
- **Staging PASSED** on `release/1` at `c287f044`: Dockerfile build, served on a temporary sslip.io `https` address, `/setup` sign-in, workspace rename, an upload to the **staging R2 bucket** with its thumbnail, `/api/health` ok.
- **Live** is `particl.si` and `www.particl.si` on Vercel. `particl.app` and `www.particl.app` are on Cloudflare and only need the redirect.
- **Owner's decision for the cutover:** `particl.si` and `www.particl.si` stay **DNS-only (grey cloud)**, as they are today with Vercel. Visitors reach the server directly, so Cloudflare's 100-second limit does not apply. Orange cloud comes later, only after every long flow is proven under 100 s (see the last "Later" section).
- Production on Vercel today: storage `r2-configured` (R2 for new files, old links still on Vercel Blob), `DISPATCH_MODE=inngest`, mail from `hello@particlstudio.com`, AI through the Vercel AI Gateway, Astra Blender renders in use (Vercel Sandbox).

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
| Not set | `TURSO_API_*`, `RESEND_*`, `MAIL_FROM`, `STRIPE_*`, `INNGEST_*`, `DISPATCH_MODE` (so it dispatches natively), engine and AI keys, any `VERCEL*`. |
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
- **`particl.si` and `www.particl.si` are DNS-only (grey cloud)** and point straight at the server, like Vercel's records today. Traefik gets **Let's Encrypt** certificates for both (HTTP-01 works with grey cloud).
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

## Firewall on the server (main path, grey cloud)

With grey cloud everyone reaches the server directly, so **80 and 443 stay open to everyone**: TCP 80, TCP 443, and **UDP 443** if HTTP/3 is on (Coolify's proxy may publish `443/udp` and set `--entrypoints.https.http3`). Coolify's own ports and SSH are limited to the owner's addresses.

Plain `ufw` is **not enough** for Docker ports: Docker publishes 80, 443, 8000, 6001, 6002 and 8080 through its own rules, ahead of ufw. Two ways; **the owner confirms which one he uses**:

- **(a) Contabo's control-panel firewall**, if the plan has it (preferred: it filters before traffic reaches the server, so Docker cannot bypass it):
  - allow TCP 80, TCP 443 and UDP 443 from anywhere;
  - allow TCP 22, 8000, 6001, 6002 and 8080 only from the owner's own addresses;
  - deny everything else inbound.
- **(b) Rules on the server**, if (a) is not available. The advisor runs this as root, after filling in the two values at the top. It refuses to run with the placeholders left in:
  ```sh
  #!/bin/sh
  set -eu
  IF="<public interface>"    # shown by: ip route get 1.1.1.1
  ADMIN="<owner IPv4>"       # the owner's own address(es), space separated
  case "$IF$ADMIN" in *"<"*|"") echo "fill in IF and ADMIN first"; exit 1;; esac
  # Coolify and Traefik dashboard ports (published by Docker): owner only.
  iptables -N ADMIN-ONLY 2>/dev/null || iptables -F ADMIN-ONLY
  for a in $ADMIN; do iptables -A ADMIN-ONLY -s "$a" -j RETURN; done
  iptables -A ADMIN-ONLY -j DROP
  for p in 8000 6001 6002 8080; do
    iptables -C DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j ADMIN-ONLY 2>/dev/null ||
    iptables -I DOCKER-USER -i "$IF" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j ADMIN-ONLY
  done
  # The same ports over IPv6: closed (the owner uses IPv4).
  for p in 8000 6001 6002 8080; do
    ip6tables -C INPUT -p tcp --dport "$p" -j DROP 2>/dev/null || ip6tables -I INPUT -p tcp --dport "$p" -j DROP
    if ip6tables -L DOCKER-USER >/dev/null 2>&1; then
      ip6tables -C DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j DROP 2>/dev/null ||
      ip6tables -I DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport "$p" -j DROP
    fi
  done
  ```
  - Matching only **new inbound** connections keeps the containers' own outgoing calls (Turso, R2, the engines) working.
  - **SSH (22)** is a host port, so `ufw` covers it: `ufw allow from <owner IPv4> to any port 22 proto tcp`, then remove any general "allow 22" rule.
  - **Trap:** Coolify reaches its own server over SSH from its Docker network. Also allow SSH from the Docker bridge range (`ufw allow from 10.0.0.0/8 to any port 22 proto tcp`; the advisor checks the range with `docker network inspect coolify`). Otherwise Coolify loses the server.
  - Make the rules survive a reboot (for example `apt install iptables-persistent`, then `netfilter-persistent save`). The advisor confirms.
- If the owner's home address changes, he is locked out of Coolify; Contabo's **VNC console** still works. Once the Coolify dashboard has its own domain over 443 (gate 1), 8000, 6001 and 6002 can be closed to everyone.
- **Check from an outside network** (a phone on mobile data, not the owner's allowed address):
  - `curl -m 10 http://<server IPv4>:8000/`, and the same for `:6001`, `:6002` and `:8080`: each **times out**;
  - `curl -6 -m 10 http://[<server IPv6>]:8000/`: **times out** (if the server has IPv6);
  - staging still answers on its https address.

## Restore point before production code touches the live databases

The app creates and changes tables on first use. So **before the production app first starts** against the live Turso databases (its first deploy, step 4), and **again just before the DNS switch** (step 8), the owner records a way back.

1. **OWNER: write down the exact UTC time** (for example `2026-10-20T09:00:00Z`) for **restore point A** (before the first deploy) and **restore point B** (before the switch). Do this for the platform database and **every workspace database**: all databases in the production Turso group, as listed in the Turso dashboard.
2. **OWNER: check the Turso plan's point-in-time window** (Turso dashboard, the organisation's plan): Free 24 hours, Developer 10 days, Scaler 30 days, Pro 90 days.
   - If the window is shorter than the 14-day watch window, also take a full encrypted backup with `scripts/ops/backup-restore.mjs backup` (see `docs/backup-restore.md`, "Capture"). That tool needs a short maintenance window with writes paused, so do it in the same quiet window.
3. **Prove a restore works, on a copy:**
   - Create a copy of the platform database and one workspace database at restore point A: `turso db create <new name> --from-db <database> --timestamp <time>`.
   - Open each copy read-only (`turso db shell <new name> "SELECT count(*) FROM workspaces"` on the platform copy) and see that the rows are there.
   - Delete the copies.
   - Never paste database URLs or tokens into chat.
4. A restore creates **new** databases with new addresses. The platform database stores each workspace's database address, so a real restore also needs those rows repointed (`scripts/ops/prepare-restore.mjs`, "Restore into new infrastructure" in `docs/backup-restore.md`). Claude prepares the exact steps on the day if it is ever needed.

## Cutover order (grey cloud)

Steps 1 to 7 do not move live traffic. From step 8 the live site is affected. Do not start a step until the one above has passed. Steps marked **OWNER** are done by the owner (with the advisor where noted); unmarked steps are checks.

0. **Gates.** Each gate in "Gates before cutover" is passed, or waived by the owner in writing. Otherwise stop.
1. **Staging runs `main` (OWNER).** Switch the staging app's branch to `main`, rebuild, sign in, run `smoke.sh` on staging. Do not go on until a build of `main` passes. (What `main` needs: PR #566's description.)
   - **Per-address limits check (OWNER, on staging).** Use a test account.
     - From network A (home): enter a wrong password **8 times** until staging says "Too many attempts. Try again in 15 minutes."
     - Then from a phone on mobile data (network B): sign in to the same account with the right password. It must work: limits are counted per address.
     - If network B is blocked too, every visitor shares one address: **stop** and report it.
2. **Lower the TTL (OWNER, a day ahead).** Write down the current records for `particl.si` and `www.particl.si` (type, value, TTL, proxy status) and lower their TTL to the minimum. If `particl.si` is not yet a Cloudflare zone, stop and say so.
3. **Firewall (OWNER, with the advisor).** As in "Firewall on the server", including the outside checks.
4. **Production app built and stopped (OWNER).** First record **restore point A** ("Restore point" above), including the restore test on a copy. Then:
   - Every variable in "Live-copy settings" is set. `TRUST_CF_CONNECTING_IP` and `TRUSTED_PROXY_HOPS` are **unset**.
   - Domains `https://particl.si,https://www.particl.si`, Direction redirect to non-www, stop grace period 300.
   - Scheduled task: Coolify, the production app, **Scheduled Tasks, + Add**: name `cron-sync`, command `node /app/cron-sync.mjs`, frequency `*/10 * * * *`, timeout 300 s, saved **disabled**. (The script calls `http://127.0.0.1:3000/api/cron/sync` inside the container with `CRON_SECRET`.)
   - **Deploy** (this is the first start against the live databases), check the health check goes green, then **Stop**. Production workspaces must not be reconciled by two hosts before the switch.
   - Traefik will fail to get a certificate at this point (the names still point at Vercel); that is expected.
   - **Recommended:** deploy the same `main` commit on Vercel too, so both hosts run identical code against the same databases during the window.
5. **Inngest: stop Vercel re-syncing (OWNER).**
   - In the Inngest dashboard, check the app's URL (**Apps**, the app): note whether it is `https://particl.si/api/inngest` or a `*.vercel.app` address.
   - In Inngest's **Vercel integration** settings, **turn off sync for this project**. Do not uninstall: that can remove the keys from Vercel.
   - Confirm Vercel Production still lists both Inngest keys.
6. **Redirect rule for `particl.app` (OWNER).** Created and proxied as in "Domains and DNS" (it can already exist).
7. **Restore point B (OWNER).** Write down the UTC time just before step 8.
8. **Switch DNS (OWNER's "go").**
   - Start the production app; wait for its health check to be green.
   - In Cloudflare: `particl.si` A to `<server IPv4>` and `www.particl.si` CNAME to `particl.si`, both **DNS-only (grey)**, no AAAA.
   - Mail records untouched.
9. **Certificates.** Within a few minutes, `curl -sI https://particl.si/` answers 200 **without** `-k`, and `openssl s_client -connect particl.si:443 -servername particl.si </dev/null 2>/dev/null | openssl x509 -noout -issuer` names Let's Encrypt. The same for `www.particl.si`. For the first minutes, visitors may see a certificate warning until Let's Encrypt issues. If there is still no certificate after 10 minutes: **OWNER:** Coolify, **Servers, Proxy, Restart Proxy**.
10. **Inngest re-sync (OWNER).**
    - Inngest dashboard, **Apps**, **Sync new app** (or **Resync**) with URL `https://particl.si/api/inngest`; or run `curl -X PUT https://particl.si/api/inngest` once.
    - The app must then show URL `https://particl.si/api/inngest` and **6 functions**. Inngest reaches the server directly (grey cloud).
    - If the URL was a `*.vercel.app` address in step 5, this step is what moves the work: until it is done, Inngest keeps running jobs on Vercel.
11. **Stripe webhook check (OWNER).** Stripe dashboard, **Developers, Webhooks**. This code has no Stripe webhook route, so if an endpoint for `particl.si` exists, it already fails today and nothing changes. Note it; there is nothing to repoint.
12. **Smoke (right after).**
    - `curl -sI 'https://www.particl.si/pricing?x=1'` answers 301 or 308 to `https://particl.si/pricing?x=1`.
    - `curl -sI 'https://particl.app/pricing?x=1'` and `www.particl.app` answer **308** to `https://particl.si/pricing?x=1`.
    - `bash ops/selfhost/smoke.sh https://particl.si` passes.
    - Sign in in a browser; a price shows as `N cr`; an old image (from Blob) and a new upload (R2) both display.
    - `curl -s https://particl.si/api/inngest` answers 200 with a function count above 0 and a signing key present (not the 503 "not configured").
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
    2. **OWNER:** re-enable the Vercel cron; disable `cron-sync` on the server; stop the production app.
    3. **OWNER:** re-enable the Inngest Vercel integration's sync for the project and resync, so Inngest's app URL points at Vercel again; check it shows 6 functions.
    4. **Data, ordinary rollback: nothing to copy back.** Both hosts use the **same Turso databases** (platform and workspaces), the **same R2 bucket** and the **same Blob store**. With R2 selected, the self-hosted app keeps nothing durable on its own disk (upload pieces go to R2 too). Everything written during the window is already where Vercel reads it. An upload in progress at the moment of switching may need to be retried.
    5. **Data problem (wrong or damaged rows):** restore from restore point B (or A) as in "Restore point". Everything written after that time is lost, so this is the owner's decision, made with Claude, not a reflex.
    6. **Never** use Vercel's Instant Rollback to a deployment from before #524 (it predates the credit switchover and would bill the wrong price).
16. **After the window (OWNER).** Retire the Vercel deployment and domains, but **keep the Vercel team, project and snapshot** while Astra renders run on Vercel Sandbox. Rotate exposed keys. Retire Blob only after every old Blob object is copied to R2.

## Astra Blender renders from the self-hosted host

**How it works today (read in code).** The app drives a **Vercel Sandbox** microVM with `@vercel/sandbox` 3.3.0 (`lib/astra-blender/sandbox.ts`). The VM starts from the snapshot in `ASTRA_BLENDER_SNAPSHOT_ID`, in region `iad1`, with 2 vCPUs, an empty environment, no ports and a deny-all network policy. The app writes the inputs in, runs Blender, reads the `.blend`, the PNG preview and the GLB back out, stores them in R2 itself, then stops the VM. The VM never calls the app back.

**How it signs in.**
- **On Vercel:** `credentials()` (sandbox.ts, lines 93 to 97) passes nothing, so the SDK uses the function's own Vercel OIDC identity. No variables needed.
- **Off Vercel:** there is no OIDC identity. The SDK needs all three of `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, which `credentials()` passes when all three are set. With any missing it falls back to OIDC and fails ("Could not get credentials from OIDC context").
- So the self-hosted app needs: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `ASTRA_BLENDER_SNAPSHOT_ID`, `ASTRA_BLENDER_RATE_CARD`. Never `VERCEL_OIDC_TOKEN` (it expires within hours).

**No other Vercel dependency.** The render path reads no `VERCEL_ENV`, `VERCEL_URL` or request origin. There are no callback URLs, and the sandbox never uploads to storage itself: the app moves the files.

**How long, and where it waits.**
- One render: a 180 s ceiling on the VM, 165 s on the Blender command, plus moving inputs (up to 100 MiB) and outputs (up to 320 MiB). The 18 Sep test render took about 8 s.
- The browser never waits on it: the render request answers **202** at once, and the panel polls every 5 s.
- The work runs in the background as the Inngest function `astra-blender-render` (step `render-persist-and-account`, up to 2 retries). That one step is one request from Inngest to `/api/inngest`. With grey cloud it goes straight to the server, so no 100 s limit applies; `INNGEST_STREAMING=true` is already set for the later orange cloud.
- If anything in between cut that request, the app would keep running the render, and Inngest's retry would find the job already started and do nothing, so a second VM is never bought (`runAstraRender` only starts a job that is still queued). The person would see the result late rather than twice.
- From this server the inputs and outputs cross the Atlantic to `iad1`; only a real render shows how long that takes.

**Code change.** None is required if all five names are set. One guard is in **PR #571 (pending review)**: off Vercel, 3D counts as available only with all three `VERCEL_*` credentials; otherwise renders are refused before any charge. Why it is needed:
- **The problem:** if the three `VERCEL_*` names are missing off Vercel, the panel still offers the render (`astraRuntimeStatus`, sandbox.ts lines 79 to 90, checks only the snapshot; `astraRenderAvailability`, render-jobs.ts line 90, adds only the rate card). The job is then claimed and funded, and `Sandbox.create` fails. The job is marked `uncertain` with its credits held (render-jobs.ts line 244), and reconciliation cannot clear it, because `getAstraRenderStatus` fails the same way (render-jobs.ts line 277).
- **The fix (PR #571):** `astraRuntimeStatus` reports not configured, with a plain reason, when off Vercel and the three credentials are not all set.
- Until #571 is on the branch that is deployed, the step 12 check (the first six names `set`) covers it.

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
2. **Origin Certificate.**
   - Cloudflare, `particl.si` zone, **SSL/TLS, Origin Server, Create Certificate** for `particl.si` and `*.particl.si`.
   - On the server, save the certificate and key as files under `/data/coolify/proxy/certs/`.
   - In Coolify, **Servers, Proxy, Dynamic Configurations**, add a file that makes them Traefik's **default certificate**: `tls.stores.default.defaultCertificate`, with `certFile` and `keyFile` under `/traefik/certs/`. Verify that mount path in the proxy compose.
   - Never paste the private key anywhere.
   - Check from the server itself: `openssl s_client -connect 127.0.0.1:443 -servername particl.si </dev/null 2>/dev/null | openssl x509 -noout -issuer` names Cloudflare.
3. **SSL/TLS mode Full (strict)** and **Always Use HTTPS** in the `particl.si` zone. The proxied staging name answers 200, not 526.
4. **Bot Fight Mode off** (**Security, Bots**). It challenges Inngest's calls to `/api/inngest`, and on the free plan no rule can exempt a path from it. Add a WAF custom rule that **skips** the other security rules for `/api/inngest` and `/api/worker` (the app hands work to itself at `/api/worker` if the Inngest keys were ever missing).
5. **Cloudflare-only firewall.** Ports 80 and 443 accept only Cloudflare.
   - **(a)** Contabo's control-panel firewall, if the plan has it: TCP 80 and 443 only from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6. **Close UDP 443:** Cloudflare talks to the server over TCP only, so HTTP/3 to the server is no longer needed. Admin ports stay owner-only as before.
   - **(b)** Rules on the server, as root. The script stops if the downloaded list looks empty, so it never installs a DROP with nothing allowed:
     ```sh
     #!/bin/sh
     set -eu
     IF="<public interface>"    # shown by: ip route get 1.1.1.1
     case "$IF" in *"<"*|"") echo "fill in IF first"; exit 1;; esac
     CF4=$(curl -fsS https://www.cloudflare.com/ips-v4)
     [ "$(printf '%s\n' "$CF4" | grep -c /)" -ge 10 ] || { echo "Cloudflare list looks empty: nothing changed"; exit 1; }
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
     for p in 80 443; do
       ip6tables -C INPUT -p tcp --dport "$p" -j DROP 2>/dev/null || ip6tables -I INPUT -p tcp --dport "$p" -j DROP
     done
     ip6tables -C INPUT -p udp --dport 443 -j DROP 2>/dev/null || ip6tables -I INPUT -p udp --dport 443 -j DROP
     ```
     If `ip6tables -L DOCKER-USER` exists, the advisor adds the same IPv6 drops there. Save the rules so they survive a reboot. Cloudflare's list changes now and then, so re-run the script when it does.
   - Or remove HTTP/3 from the proxy instead: delete the `--entrypoints.https.http3` line and the `443:443/udp` port in the proxy compose, then restart the proxy.
   - **Check from an outside network:**
     - `curl -m 10 -skI https://<server IPv4>/`: **times out**;
     - `curl -6 -m 10 -skI https://[<server IPv6>]/`: **times out**;
     - `curl --http3-only -m 10 -skI https://<server IPv4>/`: **times out** (needs a curl built with HTTP/3);
     - a proxied name still answers.
6. **Switch `particl.si` and `www.particl.si` to proxied (orange).**
7. **Only now**, with TCP **and** UDP both filtered: set `TRUST_CF_CONNECTING_IP=1` on the production app and redeploy. Then repeat the per-address limits check (network A locked, network B still signs in).
8. **Rollback:** set the two records back to grey and unset `TRUST_CF_CONNECTING_IP` (redeploy). The firewall must let everyone reach 80 and 443 again, as in the main path.
