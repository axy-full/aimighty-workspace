# Scale-out runbook: more processes, then more servers

For the owner. Written 9 Oct 2026, when production was one Coolify app on the DigitalOcean droplet **particl-app** (BLR1, 8 vCPU / 32 GB), DNS-only (grey cloud) on Cloudflare, and Let's Encrypt certificates from Coolify's Traefik. **Files only:** nothing in DigitalOcean, Coolify, Cloudflare, DNS, Turso, Inngest or R2 is changed by this document. The owner runs every step, and nothing here happens without the owner's "go".

There are three stages:

| Stage | What it is | Registry? | Load balancer? |
|---|---|---|---|
| **A. Several processes, one server** (today's target) | `WEB_CONCURRENCY` copies of the app in one container (`ops/selfhost/cluster.mjs`) | **No** | **No** |
| **B. Same server, streaming storage** | provider files stream to R2; no whole video in memory | No | No |
| **C. Two or more servers** (later, only when needed) | the same image on 2+ droplets behind a load balancer | **Yes** | **Yes** |

**With one server, which is how things stand today, no registry and no load balancer are needed.** Coolify builds the image on particl-app and runs it there. Stages A and B ship as two separate deploys; their exact Coolify changes and checks are in their PR descriptions. The rest of this document is about stage C.

## 1. What already works on several servers

The app was written for many Vercel instances at once, so most state already lives outside the process. Audit of 9 Oct (release/1 @ f59d853f):

| Thing | Where it lives | Several servers |
|---|---|---|
| Platform and workspace databases | Turso (`libsql://`), one platform DB plus one per workspace | shared; fine |
| Sessions and sign-in lockout | platform DB (`sessions`, `login_attempts`) | fine |
| Money: reservations, charges, refunds, idempotency keys | DB transactions, UNIQUE keys, conditional `UPDATE … WHERE` | fine |
| Generation limits, review-link limits | counted from DB rows | fine |
| Media, uploads, chunks | R2 (`STORAGE_BACKEND=r2`; health answers 503 if production falls back to local disk) | fine |
| Upload sessions (chunk leases, finish lease) | tenant DB `upload_sessions`, `upload_chunks` | any server takes any chunk |
| Cron | `/api/cron/sync` under the `operation_leases` lease (`lib/reconciliation.ts`) | runs once; see §2 |
| Inngest | stateless `serve()`; registered at `https://particl.si/api/inngest` | fine through the load balancer |
| Worker concurrency, dispatch claims | platform DB (`worker_slots`, `render_dispatches`) | fine |
| In-memory caches (projects 15 s, settings 10 s, catalogues up to 1 h) | each process | another process can be stale for up to the TTL. The spend reservation reads settings fresh (stage A PR). |
| Ask-an-admin and preset-staleness throttles | moved to `operation_leases` in the stage A PR | fine |
| `.data/` | scratch only on production | **must stop being a Coolify volume** before stage C (§3.1) |

Things that still assume one server, and how each is handled:

- **Persistent volume at `/app/.data`.** Coolify refuses to add a second server to an app with persistent storage. Production keeps only scratch there, so stage C removes the volume (§3.1).
- **Upload finish runs in the process that claimed it** (`after()` under a 20-minute DB lease). If that server dies mid-finish, the upload resumes when the lease expires, up to 20 minutes later. Nothing is lost or charged twice. Accepted.
- **Work after the reply (`after()`, about 37 places).** It finishes inside the process that answered. A server that is stopped gets the 300 s stop grace. A server that crashes leaves recovery records in the DB, and the next cron or replay picks them up, as on Vercel.
- **The client address.** Behind a load balancer, the app must still see the visitor's address. Otherwise everyone shares one sign-in-lock and rate-limit bucket. §3.4 covers this. Never go live on stage C without the check in §5.
- **Build skew during a deploy.** For a short time, two servers run different builds. A page from the new build can ask the old server for a script and get a 404. §4 covers this.
- **Same image everywhere.** Each server must run the identical image (same Next build ID, same static files). That is what the registry is for (§3.2).
- **Secrets.** `SESSION_SECRET`, `KEYRING_SECRET`, `CRON_SECRET`, the Inngest keys and every other variable must be identical on every server. Coolify keeps one environment per app, so this holds automatically.

## 2. Cron: the DB lease, not "one node only"

**Decision: the DB lease.** The sweep already takes `acquireOperationLease(platformDb, "workspace-reconciliation", 330 s)` and saves its cursor as it goes. A second call while the lease is held answers `skipped: "already_running"`. So the guarantee is "at most one sweep at a time, however many servers fire the task", and it is already in production.

- Keep the Coolify scheduled task `cron-sync` (`node /app/cron-sync.mjs`, `*/10 * * * *`, timeout 300 s). It calls `127.0.0.1:3000/api/cron/sync` inside its own container, so the cluster hands it to one of that server's processes.
- If Coolify runs the task on every server in stage C, the extra calls are no-ops (`already_running`). If it runs only on the primary, the sweep still runs. Either way the result is correct. The lease also means a dead primary does not stop cron once another server runs the task.
- Check: the scheduled-task log shows `cron-sync: 200`. When two run at once, one body says `"skipped":"already_running"`.

## 3. Stage C: add a second server

Do this only when one server is not enough: CPU stays above about 70 % at peak with `WEB_CONCURRENCY` already tuned, or you want to survive losing a droplet. Before starting, the workshop (lead and agents) must not run on the new droplet.

### 3.1 Prepare the app (on the one server, no traffic change)

1. **Remove the `/app/.data` volume.** Coolify, the production app, **Persistent Storage**: delete the `/app/.data` volume. The image already creates `/app/.data` owned by the app user, so it becomes per-container scratch.
   - First confirm production does not use it. `STORAGE_BACKEND=r2`, both database URLs are `libsql://`, and `/api/health` shows `"storage":"ok"` on R2 and `"database":"turso"`.
   - Then Deploy and run the stage A checks again.
2. **Healthcheck on.** Coolify, the app, **Health check**: enabled, path `/api/health`, port 3000. The Dockerfile's `HEALTHCHECK` also works. Coolify's rolling update (start the new container, wait for healthy, then stop the old one) needs this and needs **no host port mapping**.

### 3.2 Registry (needed from stage C on)

Coolify builds once and the other servers pull the same image. Its docs: "Coolify requires **Image** before it can deploy an application to additional servers."

1. Create a registry repository. **DigitalOcean Container Registry**, same region (BLR1). The Basic plan (5 GB) is enough for a few image tags; the Starter plan (500 MB) is too small for this image. GitHub Container Registry (`ghcr.io/axy-full/…`, private package) also works.
2. On **each** server, log the SSH user Coolify uses (root) in to the registry: `docker login registry.digitalocean.com` with a DigitalOcean API token. Give the primary push and pull rights; the others need pull only. Run this as root on the server; it is an owner step.
3. Coolify, the app, **General**, **Container image**, **Image**: `registry.digitalocean.com/<registry>/particl`. Deploy once on the single server and check the tag appears in the registry.

### 3.3 Second droplet

1. Create droplet **particl-app-2** in **BLR1**, same CPU architecture (x86_64), Ubuntu 24.04, in the **same VPC** as particl-app. Size: it serves only the app (no workshop), so a smaller plan works. The baseline is particl-app's own plan.
2. **DO Cloud Firewall** for both app droplets:
   - 22 from the owner only;
   - 80 and 443 **from the load balancer only** (DigitalOcean lets a firewall rule name the load balancer as a source);
   - nothing else.
   - The Coolify UI stays behind the SSH tunnel. Never use a public IP allowlist.
3. Coolify, **Servers, + Add**: the new droplet's address and SSH key; **Validate** (Coolify installs Docker and its proxy). The proxy must be **Traefik**, as on particl-app; Coolify rejects mixed proxy types.
4. **Certificates.** With two servers behind one name, Let's Encrypt's HTTP-01 check lands on whichever server the load balancer picks, so it fails half the time. Switch both servers to the **DNS challenge** before adding the load balancer. The steps are already written in `docs/selfhost-test.md`, "Certificates before the switch", path (a): a Cloudflare token limited to `particl.si` DNS, the token file and the `letsencrypt-dns` resolver. Do this on both servers and check with the pinned `openssl s_client … -servername particl.si` against **each server's own IP**.
5. Coolify, the production app, **Servers**, **Add another server**: particl-app-2, its standalone Docker network. Then **Deploy on that server only**. Coolify pulls the image from the registry.
6. **Test the new server directly** before it gets traffic: `curl -sk --resolve particl.si:443:<particl-app-2 IP> https://particl.si/api/health` shows `ok:true` and the **same 7-char commit** as particl-app.

### 3.4 Load balancer

**Recommended: a DigitalOcean regional Load Balancer** in BLR1, 1 node, in the VPC:

| Setting | Value | Why |
|---|---|---|
| Forwarding | **TCP 443 → 443** (TLS passthrough) and TCP 80 → 80 | each server's Traefik keeps its own Let's Encrypt (DNS-challenge) certificate; DigitalOcean can only issue certificates for domains whose DNS it hosts, and particl.si is on Cloudflare |
| **PROXY protocol** | **on**, and Traefik's entrypoints trust it from the VPC range only: `--entrypoints.https.proxyProtocol.trustedIPs=<VPC CIDR>` (same for `http`), in Coolify, Servers, each server, Proxy, Configuration | without it every visitor arrives from the load balancer's address and shares one rate-limit and sign-in-lock bucket. `TRUSTED_PROXY_HOPS` stays **unset** (1): Traefik writes the real address into `X-Forwarded-For`. |
| Health check | HTTP, port 80, path `/api/health`, interval 10 s, unhealthy after 3 | see the note below on the Host header |
| HTTP idle timeout | the maximum (600 s) | upload finish and media streams may run up to 800 s; Inngest steps up to 300 s |
| Sticky sessions | not available with TCP passthrough | skew is handled in §4 |

**Health check and Host.** Traefik routes by host name, and DigitalOcean's health check does not send `Host: particl.si`. Add one router that answers `/api/health` on any host, as a container label on the app: Coolify, the app, **Container Labels**. Use the app's own service name from the generated labels:

```
traefik.http.routers.lb-health.rule=Path(`/api/health`)
traefik.http.routers.lb-health.entrypoints=http
traefik.http.routers.lb-health.priority=1
traefik.http.routers.lb-health.service=<the app's generated service name>
```

Check it on each server, from inside the VPC, before attaching it: `curl -s http://<server private IP>/api/health`. On the test droplet, also check that the health check still passes with PROXY protocol on. If it does not, use a TCP 443 health check instead, which is weaker: it only proves Traefik is up.

**DNS.** Cloudflare: `particl.si` A → the load balancer's IP, still **DNS-only (grey)**. Lower the TTL a day ahead, as on 8 Oct. `www` stays a CNAME to `particl.si`.

**Alternative: Cloudflare Load Balancing**, for when the names go orange-cloud (`docs/selfhost-test.md`, "Later"). Cloudflare ends TLS, health monitors can send `Host: particl.si`, session affinity by cookie is available, and the client address comes from `CF-Connecting-IP`. Set `TRUST_CF_CONNECTING_IP=1` only then, and firewall the servers to Cloudflare's ranges. It brings Cloudflare's 100 s response limit, which the owner has deferred until every long flow is proven under 100 s. So it is not the first choice.

### 3.5 Go live

1. Attach particl-app first and wait for healthy, then particl-app-2.
2. Switch DNS to the load balancer.
3. Run the checks in §5.
4. Inngest: no change. It is synced to `https://particl.si/api/inngest`, which now reaches the load balancer. Press **Resync** once anyway and check the function count (7).

## 4. Deploys without downtime

**One server (stages A and B).** With the health check on and no host port mapping, Coolify does a rolling update: it starts the new container and waits for `/api/health`. Then it moves traffic and stops the old container, giving it the stop grace (300 s). Inside the old container, `cluster.mjs` passes SIGTERM to every process. Each one stops taking new connections, finishes its requests, and exits.

**Two servers (stage C).** Deploy one server at a time:

1. In the load balancer, take server 1 out of rotation: remove it from the load balancer's droplets, or tag-filter it out. Wait 5 minutes for open requests and Inngest steps (up to 300 s) to finish.
2. Coolify, the app, **Servers**: **Deploy** on server 1 only. Check `curl -sk --resolve particl.si:443:<server 1 IP> https://particl.si/api/health` shows the new commit.
3. Put server 1 back. Take server 2 out and repeat.

Between steps 1 and 3 both builds can serve for a minute. Two things keep that harmless:
- Old pages keep working against the old server, and a page that asks the new server for an old script gets a 404, so the browser reloads.
- To make that reload automatic, set Next's deployment id from the commit before stage C: `ENV NEXT_DEPLOYMENT_ID=${SOURCE_COMMIT}` in the Dockerfile's build stage, where the `SOURCE_COMMIT` argument is already passed. Next 16 then sends the id with every navigation and does a full reload when the server's id differs, instead of failing a client navigation (`node_modules/next/dist/docs/…/deploymentId.md`). This is a small change with its own review, made when stage C is scheduled. It is not needed with one server.

**Rollback.** Coolify, the app, **Deployments**: redeploy the previous image (the registry keeps it), one server at a time as above. For stage A only, `WEB_CONCURRENCY=1` and a redeploy restores one process.

## 5. Checks after going live on two servers

- `curl -s https://particl.si/api/health` 20 times: always `ok:true`, always the same commit.
- **Client address.** Sign in with a wrong password from two different networks. Each locks out **only itself**. Then check the app logs for the "shared bucket" warning (`lib/clientIp.ts`): there must be none.
- Upload a large file (chunks spread over both servers) and a reference image. Both finish.
- A cheap generation completes, its video saves, and it plays.
- `cron-sync` log: `200`. When two run at once, one says `already_running`.
- Inngest dashboard: 7 functions, the `worker/probe` round trip succeeds (`/api/admin/readiness`).
- Stop the app on one server (Coolify, Servers, Stop on that server). The site stays up, and the load balancer marks it down within 30 s. Start it again. Coolify's docs also say to test a whole droplet failure (power off), not only a stopped container.

## 6. Remove a server

1. Load balancer: remove the droplet; wait 5 minutes.
2. Coolify, the app, **Servers**: **Remove from server** (it stops the app there and asks for the server name).
3. Coolify, **Servers**: delete the server. In DigitalOcean, destroy the droplet, then check the firewall and load balancer no longer name it.
4. With one server left, the load balancer can stay (1 target) or go: to drop it, point `particl.si` A back at the server (lower the TTL first). Each server keeps its own certificate, so nothing else changes.

## 7. Costs (USD per month; check the prices when ordering)

| Item | Stage A/B (one server) | Stage C (two servers) |
|---|---|---|
| Second droplet | 0 | same plan as particl-app. DigitalOcean lists 8 vCPU / 32 GB at about **$192** (shared CPU) or **$252** (General Purpose, dedicated); a smaller plan is fine for an app-only server |
| Regional load balancer | 0 | **$12** per load-balancer node (1 node) |
| Container registry | 0 | DigitalOcean Basic about **$5** (5 GB), or GHCR |
| Cloudflare Load Balancing (alternative) | 0 | from about **$5** (2 origins, 60 s health checks; faster checks and more origins cost extra) |
| Bandwidth | included with the droplets | the load balancer adds none |

Stage C total: about **$209–$269** a month on top of today, mostly the droplet.

Sources: [Coolify multi-server deployments](https://coolify.io/docs/core/infrastructure/scaling/multi-server-deployments), [Coolify cloud load balancing](https://coolify.io/docs/core/infrastructure/scaling/cloud-load-balancing), [DigitalOcean load balancer pricing](https://docs.digitalocean.com/products/networking/load-balancers/details/pricing), [DigitalOcean droplet plans](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/).
