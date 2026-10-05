# Platform plan: server, media and Docker (P2, P3, P4)

Status as of 5 October 2026. This is a plan, not a record of changes. It describes the work that moves Particl's media to R2 behind Cloudflare and runs a second copy of the app in Docker at staging.particl.si, while particl.si stays on Vercel.

This file is public. It holds no addresses, open ports, bucket names, keys, prices or vendor figures. Where a step needs one, it says so in words (for example `<server address>`) and the owner fills it in from his own notes. The owner's private notes hold the real values.

## 0. Rules that apply to everything below

- **Owner gate.** Anything that touches money, sign-in, accounts, secrets, environment variables, DNS or database migrations waits for the owner's merge. Each PR below is tagged `[SIGN-IN]`, `[ENV]`, `[STORAGE]` or `[MONEY]` where it needs him.
- **Nothing changes in Cloudflare, Coolify, Vercel, Turso or the server's control panel except by the owner.** Claude prepares text, reads results the owner pastes (never secrets), and writes code on branches.
- **No real generation on previews or in CI.** Tests use `ENGINE_MOCK=1`, mocked routes and local databases.
- **No Docker on the author's Mac.** Container checks run in GitHub Actions or on Coolify.
- **Demo week.** Nothing here should land on particl.si during the demo unless the owner asks for it.

Terms: **Vercel** serves particl.si today. **Coolify** is the self-hosted deploy dashboard on the new server. **R2** is Cloudflare's object storage. **Inngest** is the background-job service, self-hosted in P4.

---

## 1. P2: the server (owner's hands)

P2 has no code. Every item lives in the owner's own accounts (the host's control panel, Coolify, Cloudflare, GitHub, the password manager, the monitor). "Unknown" means it was not recorded as done; treat it as open until the check under it passes.

### 1.1 Status

| # | Item | Status | Whose |
|---|---|---|---|
| 1 | Coolify claimed (admin account, two-factor on) | **Done** (3 Oct) | Owner |
| 2 | Coolify's keys saved in the password manager | **Unknown** | Owner |
| 3 | One origin certificate for `particl.si` and `*.particl.si`, loaded into Coolify's proxy | **Unknown** | Owner |
| 4 | `coolify.particl.si` (proxied) set as Coolify's instance address | **Open** | Owner |
| 5 | GitHub App installed on this repository only | **Open** (needs 4) | Owner |
| 6 | Cloudflare-only firewall in the host's control panel | **Open** | Owner |
| 7 | Real visitor addresses (proxy trusts Cloudflare's ranges) | **Unknown** | Owner for the proxy; code side is P4-3 |
| 8 | Outside monitor, plus Uptime Kuma | **Unknown** | Owner |
| 9 | VPS snapshots | **Open** | Owner |
| 10 | Swap | **Done** (3 Oct) | Owner |
| 11 | Backups: Coolify's own backups go to a private R2 bucket | **Done** (3 Oct) | Owner |

### 1.2 Order

2, 3, 4, 5, 7, 6, 8, 9. Reasons:

- 3 before 4: the zone is SSL "Full (strict)", so Cloudflare refuses to reach the dashboard until the origin presents a valid certificate.
- 4 before 5: GitHub calls Coolify back at that address.
- 4 and 7 before 6: the firewall step closes the dashboard's own ports, and step 7 restarts the proxy.
- Take a manual snapshot (9) before step 6.

### 1.3 The owner's steps for each open or unknown item

**P2-2. Save Coolify's keys (5 minutes)**

1. Open Terminal on the Mac and sign in to the server over SSH as usual.
2. Print Coolify's environment file (`/data/coolify/source/.env`) with `sudo cat`.
3. Copy the whole output into a new secure note in the password manager, titled "Coolify .env (VPS)". Paste it nowhere else.
4. Run `clear` and close the Terminal window.

Check: the note contains a line starting `APP_KEY=`. Coolify cannot be restored without this file.

**P2-3. Origin certificate (15 minutes)**

1. Cloudflare dashboard, zone `particl.si`, SSL/TLS, Origin Server, Create Certificate.
2. Keep "Generate private key and CSR with Cloudflare", key type RSA (2048).
3. Hostnames: `particl.si` and `*.particl.si`. Validity: 15 years. Create.
4. Save the certificate and the private key to two files on the Mac. The key is shown once. Put both into the password manager too.
5. Copy the two files to the server's temporary folder with `scp`.
6. On the server, move them into Coolify's proxy certificate folder (`/data/coolify/proxy/certs/`), with the folder readable only by root and the key file mode 600.
7. In Coolify: Servers, the server, Proxy, Dynamic Configurations. Add a file `cloudflare-origin.yaml` that lists the certificate and key paths as seen from inside the proxy container (the host folder `/data/coolify/proxy/` appears as `/traefik/`):
   ```yaml
   tls:
     certificates:
       - certFile: /traefik/certs/<certificate file>
         keyFile: /traefik/certs/<key file>
   ```
8. Delete the two files from the Mac once they are in the password manager.

Check, on the server: `openssl s_client` against the local HTTPS port with `-servername coolify.particl.si`, piped to `openssl x509 -noout -issuer -dates`. The issuer names Cloudflare's Origin CA and the end date is about 15 years out. If another certificate shows, read Coolify's proxy log.

**P2-4. coolify.particl.si (10 minutes)**

1. Cloudflare, zone `particl.si`, DNS, Add record: type A, name `coolify`, value `<server address>`, **Proxied** (orange cloud), TTL Auto.
2. Coolify, Settings, Configuration, General, URL: `https://coolify.particl.si`. Save.
3. Open it in a private window and sign in with two-factor.

Check: the page loads with a padlock; `dig +short coolify.particl.si` on the Mac shows Cloudflare's addresses, not the server's; a deployment log streams live (the realtime connection also goes through the domain).

**P2-5. GitHub App (10 minutes, after P2-4)**

1. Coolify, Sources, Add, GitHub App, name it (for example `particl-coolify`), Register.
2. GitHub opens. Create the app under the `axy-full` account, then Install it: choose "Only select repositories" and pick `axy-full/aimighty-workspace`.
3. Back in Coolify the source shows as connected.

Check: Coolify, any project, New, Application, "Private Repository (with GitHub App)" lists exactly one repository. Cancel there; P4 creates the application later.

**P2-7. Real visitor addresses (10 minutes; do it before the firewall because it restarts the proxy)**

1. Copy the IPv4 ranges from Cloudflare's published list (`https://www.cloudflare.com/ips-v4`).
2. Coolify, Servers, the server, Proxy, Configuration (the proxy's compose file).
3. Under `command:` add one line for each entry point, `http` and `https`, setting `forwardedHeaders.trustedIPs` to the ranges joined by commas with no spaces.
4. Save, then Restart Proxy, and wait for "Running".

Optional check: add a proxied A record `whoami`; in Coolify deploy the `traefik/whoami` image on `whoami.particl.si`; the `X-Forwarded-For` line should start with your own public address. Then stop that resource and delete the record.

Note: P4-3 makes the app read Cloudflare's own header for the sign-in lock, so the lock no longer depends on this step. The proxy's logs and other services on the box still do.

**P2-6. Cloudflare-only firewall (20 minutes; keep one SSH session open the whole time)**

Use the host control panel's firewall, not `ufw`: ports that Docker publishes skip `ufw`.

1. Control panel, the VPS, Security, Firewall, Add Firewall, name it (for example `cloudflare-only`).
2. Add rules. First, accept TCP port 22 from the office address only.
3. For each Cloudflare IPv4 range, add two accept rules: TCP 443 and TCP 80 from that range. The IPv6 list is not needed while the records are A records.
4. Add no rule for Coolify's own dashboard and realtime ports. The firewall drops everything it does not accept. Once the dashboard works on its domain (P2-4), those ports are no longer needed.
5. Activate the firewall for this server. It applies within a couple of minutes.
6. If you are locked out: control panel, Firewall, deactivate. Nothing on the server itself changed.

Check from the Mac on the office network: plain HTTP and HTTPS to the server's address both time out, the dashboard's old direct port times out, SSH still works, and `https://coolify.particl.si` still loads. If the office address changes, edit the port-22 rule.

**P2-8. Outside monitor (15 minutes)**

1. Create a free UptimeRobot or Better Stack account. Install its phone app and allow notifications.
2. New monitor: HTTP(s), name "particl.si health", URL `https://particl.si/api/health`, every 5 minutes, alerts by email and phone.
3. Add a second monitor for `https://coolify.particl.si`, and later `https://staging.particl.si/api/health` once P4 exists.
4. Optional: Coolify, New, Service, Uptime Kuma, on a proxied domain such as `status.particl.si`, with the same checks.

Check: point the particl.si monitor at a path that answers 404, confirm the phone gets a "down" alert within one or two intervals, then point it back and confirm the "up" alert.

**P2-9. Snapshots (5 minutes)**

1. Control panel, the VPS, Backups and Monitoring, Snapshots and Backups.
2. Confirm an automatic weekly backup dated within the last 7 days is listed.
3. Press Create snapshot before each risky change: P2-6, the first P4 deploy, and the P5 evening. The host keeps one manual snapshot at a time.

### 1.4 Gate to P3 and P4

All four must be true:

- the dashboard loads at `coolify.particl.si` through Cloudflare;
- GitHub is connected;
- the outside monitor alerts the owner's phone;
- from the Mac, plain HTTP to the server's address times out.

### 1.5 Standing checklist (check once, then monthly)

| Item | Check |
|---|---|
| SSH by key only | On the server, `sshd -T` shows password authentication off |
| Unattended security upgrades | `systemctl is-enabled unattended-upgrades` says `enabled` |
| Coolify: automatic updates and deploy-failure notifications to the phone | Coolify, Settings and Notifications |
| Cloudflare: Always Use HTTPS, managed WAF rules, a rate limit on sign-in and invite routes | Cloudflare, zone `particl.si`. These act only once records are proxied (P5) |
| Secrets in the password manager: the keyring and session secrets, Coolify's environment file, the origin key | Password manager |

---

## 2. P3: storage on R2 and media through Cloudflare (on Vercel first)

P3 works the same on Vercel or on the new server, so it goes first. Goal: grids load small cached thumbnails from `media.particl.si` instead of full originals through app functions.

### 2.1 What the code does today

- R2 is built and switched off. `STORAGE_BACKEND=r2` selects it (`lib/storage/backend.ts`). With R2 on, reads fall back to Blob on a miss; writes touch R2 only. The copy tool exists: `scripts/ops/migrate-media-r2.mjs` and `lib/storage/migrate.mjs`.
- Every media view is a function call: `/api/media/<id>` checks the signed-in person and the take, then redirects (302) to a short-lived presigned storage link. Signed links change on each call, so the browser cannot reuse them.
- Grids (`components/LazyMedia.tsx`, used by about 45 files) load **full originals** for stills, and capture video posters **in the browser** (kept in local storage).
- The board canvas and a few other places use an in-function `sharp` preview (`app/api/workbench/preview/[kind]/[id]/route.ts`).
- Review links stream originals through the app on purpose, so revoking a link takes effect at once.
- Open gaps listed in `docs/r2-storage-plan.md`: `lib/deploymentReadiness.ts` requires the Blob token; the backup scripts read Blob only; `app/api/platform/route.ts` labels any cloud backend as Blob.
- **Pixel readers must stay same-origin** (they read image data in the browser, and the movie page's CSP only allows its own origin): movie export (`lib/workbench/render-movie.ts`), frame-to-file in `components/Theatre.tsx`, `lib/videoFrameCapture.ts`, `lib/workbench/atomik-video-frames.ts`, `lib/workbench/node-graph.ts`. They keep using the `?stream=1` proxy path.

### 2.2 Design decisions

1. **The app's media URLs do not change.** Rows, API fields and the DOM keep `/api/media/<id>` and `/api/uploads/<id>`. Two query forms are added: `?w=480` (thumbnail) and `?poster=1` (video poster). The route authorises exactly as today, then redirects to a signed `media.particl.si` link. The redirect itself stays `private, no-store`; the media it points to is what gets cached. Preview, drag and drop and stored pipeline references all parse these URLs, so they must not change.
2. **Token format.** Cloudflare's documented timed-HMAC token, `<path>?verify=<timestamp>-<mac>`, with the mac an HMAC-SHA256 over path and timestamp, URL-safe base64, no padding. The timestamp rounds down to the hour so links repeat and cache. The WAF rule's lifetime is **7200 seconds** (two hours), so a link minted at the end of an hour does not die a minute later.
3. **Two settings switch it on:** `MEDIA_ORIGIN` (Production uses `media.particl.si`, Preview uses a separate testing domain) and `MEDIA_TOKEN_SECRET`. Unset means today's presigned path, exactly. Unsetting `MEDIA_ORIGIN` is also the one-line kill switch.
4. **Who gets a link.** Only keys that pass the workspace-ownership check (`assertWorkspaceKey` in `lib/storage.ts`), and only inline-safe content types (the CDN cannot override a content type). Other uploads keep streaming as attachments. The owner adds a response-header rule on the media domain so a stored HTML or SVG file cannot run there.
5. **Originals** (full viewer, hover-play) load from the media domain. Downloads keep their file name through R2's presigned content-disposition. A player re-requests the app URL once on a 403, in case a link outlived its two hours.
6. **Posters** are made by Cloudflare Media Transformations (frame mode), fetched by the server with a valid token, and stored in R2 beside the original. A cron stage makes them, so the completion paths next to billing stay untouched. Until a poster exists, `?poster=1` redirects to the on-the-fly frame URL.
7. **A spike before the grid PR** (on the testing domain and testing bucket) answers two questions: does an image-transformation request without a token get blocked, and does one with a token succeed (so the transformation's own fetch of the original is not blocked)? If either fails, thumbnails are made once with `sharp` (already a dependency) and stored beside the original as plain signed objects, and the in-browser poster capture stays until a later package can make posters on a worker.

### 2.3 PRs and the owner's hand steps, in order

| Step | What | Needs the owner's merge? |
|---|---|---|
| **P3-1** | Measurement script and the `thumbSrc()` helper | No: an ops script and a pure helper, no runtime change |
| **P3-2** | R2 readiness: readiness check, platform label, runbook | Yes `[STORAGE][ENV]` |
| **Hand A** | Buckets, tokens, settings, copy, CORS, switch, copy again | Owner |
| **P3-3** | Signed links: `lib/media-cdn.ts`, media, uploads and preview routes, link helper | Yes `[STORAGE][ENV]` (inert until the settings exist) |
| **Hand B** | Token rule, domain, cache rule, transformations, header rule, Preview settings, spike, Production settings | Owner |
| **P3-4** | Grids use thumbnails and posters | Yes: owner's preview check (not behind the new-interface switch) |
| **P3-5** | Server-made posters: maker, cron stage, route prefers the stored poster | Yes `[STORAGE]` |
| **P3-6** | Delete the in-browser poster capture and its local storage | Yes: owner's preview check |
| **P3-7** | R2 in the backup tool | Yes `[ENV]` (backups, secrets) |

**P3-1 `ops/measure-media`**

- Files: `scripts/ops/measure-media.mjs` (new); a section in `docs/r2-migration.md`; `thumbSrc(url, w = 480)` in `lib/format.ts` beside `posterSrc`.
- The script drives a headed browser with a fresh private profile. The owner signs in himself in the window; the script never sees credentials. It writes JSON outside the repo with query strings (signed links) stripped.
- `thumbSrc` maps `/api/media/<id>` and `/api/uploads/<id>` to `?w=480` and leaves anything else alone. Today's routes ignore `w`, so nothing changes yet. Other work can code against it now.
- Test: a helper unit test (`tests/unit/media-urls.spec.ts`). Gate: CI green.

**P3-2 `storage/r2-readiness`**

- `lib/deploymentReadiness.ts`: accept the four R2 settings when `STORAGE_BACKEND=r2`. `app/api/platform/route.ts`: report the real backend kind. `docs/r2-migration.md`: the cutover list, including the CDN steps in Hand B.
- Tests: readiness unit tests (Blob, R2, local); the platform route label. Gate: full unit run and the owner's merge.

**Hand A: storage to R2** (owner; any quiet day, never the same evening as a credit or money change)

1. Cloudflare, R2, Create bucket: one for production and one for testing, location hint Asia-Pacific, public access (r2.dev) left **off**.
2. R2, Manage API tokens: one token per bucket, "Object Read & Write", applied to that bucket only. Save both key pairs in the password manager.
3. Vercel, Settings, Environment Variables, all marked Sensitive: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Production gets the production pair, Preview the testing pair. Do **not** set `STORAGE_BACKEND` yet.
4. Copy, from the Mac (Node 24), with the env file and reports kept in a private folder outside the repo: first run `scripts/ops/migrate-media-r2.mjs` for an inventory report, then again with `--apply --transfers 4` and a copy report. A non-zero exit means a conflict or failure: stop and tell Claude the counts (never the file names or keys).
5. CORS on each bucket: allowed origins are the exact site origins (the preview origins for the testing bucket); methods GET and HEAD; request headers `Range` and `If-Range`; exposed headers `Content-Length`, `Content-Range`, `Accept-Ranges`, `Content-Type`, `ETag`.
6. Switch: set `STORAGE_BACKEND=r2` on Production and redeploy. Signed in, `/api/health` should say `r2-configured`. Test an upload, a download and scrubbing a video.
7. Copy again to catch files written during the switch. Keep the Blob token and every Blob file until P5 has run two clean weeks.

**P3-3 `media/signed-links`**

- New `lib/media-cdn.ts`: `mediaCdnConfigured()`, `signMediaPath(path, now)`, `cdnLink(key, { width?, poster? })`. New `scripts/ops/media-link.mjs`: prints one signed link for the spike, reading the secret from the environment and never echoing it.
- `app/api/media/[id]/route.ts`, only when the CDN is configured and not for `download` or `stream`: the default redirect goes to the signed original; `?w=480` to the image-transformation URL; `?poster=1` to the stored poster or the frame URL; `?download=1` on R2 to a presigned URL with content-disposition.
- `app/api/uploads/[id]/route.ts`: the same treatment, inline-safe types only. `app/api/workbench/preview/[kind]/[id]/route.ts`: redirect to a width-640 thumbnail when configured; the `sharp` path stays as fallback.
- With the settings unset, behaviour is identical to today.
- Tests: token vectors computed the way Cloudflare's documented example does; hour rounding; URL-safe base64; token is the last query parameter; another workspace's key is refused; the content-type allowlist; every redirect is `no-store`; `stream=1` and `download` unchanged; CDN off means unchanged; tenant isolation (a member of workspace A cannot get a link for B's media).
- Gates: typecheck, lint, full unit, bounded build with the bundle spec, the existing `originalAssetDownloads` and `workspaceLibrary` specs stay green, owner's merge.

**Hand B: the CDN** (owner; run on the testing bucket and testing domain first, repeat on production after the spike passes)

1. **Token rule first**, before the domain exists. Cloudflare, zone `particl.si`, Security, WAF, Custom rules: block when the host is the media host and the request fails `is_timed_hmac_valid_v0` with a 7200-second lifetime and the URL-safe flag. Make the secret on the Mac with `openssl rand -hex 32`; the same value goes into Vercel's `MEDIA_TOKEN_SECRET`. Use a different secret for the testing domain. (Token authentication needs the zone's plan to include it.)
2. **Domain:** R2, the bucket, Settings, Custom Domains, add the media host. Leave r2.dev off.
3. **Cache rule** for the media host: eligible for cache; edge TTL set to ignore the origin's cache-control header (objects carry `private`) for one month; browser TTL override of one hour; cache key ignores the query string (safe because the WAF checks every token before the cache is reached).
4. **Transformations:** Images, Transformations, enable for the zone (this also enables Media Transformations for posters).
5. **Response header rule** for the media host: `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
6. **Vercel, Preview first:** set `MEDIA_ORIGIN` to the testing media host and that domain's `MEDIA_TOKEN_SECRET`; redeploy a preview.
7. **Spike**, with links from `scripts/ops/media-link.mjs`:

   | Request | Expected |
   |---|---|
   | signed original | 200; the second request shows `cf-cache-status: HIT` |
   | the same link with one character changed | 403 |
   | original with no token | 403 |
   | signed image-transformation URL | 200, `image/webp` or `image/avif` |
   | image-transformation URL with no token | 403 |
   | signed media-transformation frame URL on a video | 200, `image/jpeg` |

   If any of the last three misbehave, use the fallback in section 2.2, decision 7.
8. **Production:** only after `STORAGE_BACKEND=r2` and a verified copy, set `MEDIA_ORIGIN` and `MEDIA_TOKEN_SECRET` on Production and redeploy.

**P3-4 `media/grid-thumbnails`**

- `components/LazyMedia.tsx`: stills use `thumbSrc(url)`; videos show `<img src="...?poster=1">` and on error fall back to today's capture (kept until P3-6). Hover-play and the full viewer keep the original and re-request once on error (`components/PreviewLayer.tsx`, `components/Theatre.tsx`).
- Display-only `?stream=1` users switch to thumbnails (for example `components/make/UnfiledWall.tsx`, display source only). `lib/workbench/node-graph.ts` uses the same-origin `?stream=1`. The PR lists every other image or video that shows an app media URL outside `LazyMedia` and says what it changed (about 55 files build `/api/media/` URLs).
- Unchanged: stored values and API fields. `lib/genLibrary.ts` keeps `?stream=1` because `lib/pipeline/compile.ts` compares it.
- Tests: helper unit tests; Library, wall and board-canvas browser specs at 360x640, 390x844, 844x390, 1440x900 and 1920x1080 (tiles use `<img>`, no overflow); the existing `stream=1` specs stay green. Gates: full unit, build, those browser specs, and the owner's preview check. Timing: after the demo unless the owner wants the speed for it.

**P3-5 `media/server-posters`**

- New `lib/media-posters.ts`: fetch the signed frame URL (30 second timeout, `image/jpeg`, under 2 MB) and store it in R2 without overwriting. A `posters` stage in `app/api/cron/sync/route.ts`, after the storage-size stage: at most 8 per workspace per tick, inside the deadline, with its cursor in tenant settings (no new table, no migration). The route prefers the stored poster.
- Tests: maker and stage with a fake fetch and an in-memory backend; tenant isolation; no paid provider call anywhere. Gate: full unit and the owner's merge.

**P3-6 `media/drop-browser-posters`**

- Removes the in-browser capture, its queue and its local-storage keys, with a one-time clean-up of the old keys. Keeps every `?stream=1` path. Lands after P3-5's stage reports no take without a poster in production. Gates: the five-size browser specs and the owner's preview.

**P3-7 `backup/r2`**

- `scripts/ops/backup-lib.mjs` and `scripts/ops/staging-rehearsal.mjs` go through `lib/storage/backend` so they read R2 and Blob; restores go to R2. Tests in `tests/ops/*.test.mjs` against an in-memory S3 fake.
- Recommended order: land it **before** Hand A step 6, so nothing is written where the backup cannot read it. Gate: owner.

### 2.4 Measurements, before and after

| Measure | How (the P3-1 script) |
|---|---|
| Bytes | Encoded bytes received until the grid settles, split by host: app, storage API, media host |
| Requests | Count by host, and the number of app media calls (`/api/media`, `/api/uploads`, `/api/workbench/preview`) |
| Time to a visible grid | Navigation start until every tile in the first viewport shows a decoded image or poster; plus largest contentful paint |
| Edge cache | `cf-cache-status` counts on the second visit |

- **Pages:** the Library of the owner's own workspace with 50 or more takes (mixed stills and videos), and one board canvas.
- **Runs:** cold (cache cleared) and warm (second visit), three each, median, at 1440x900 and 390x844.
- **When:** (1) a baseline before Hand A step 6; (2) after step 6 (R2 only); (3) after P3-4 plus Hand B (thumbnails); (4) after P3-5 and P3-6 (server posters).
- **Who:** the owner, signed in himself, on particl.si. It is read-only browsing with no generation. A preview run needs his confirmation that the Preview database is separate, and a seeded test workspace.
- **Expected direction, not a promise:** stills go from full originals to thumbnails a fraction of the size; videos go from a partial read plus an in-browser decode per tile to one small poster; warm visits come from the browser for the hour and from Cloudflare's edge after that.
- **Gate to P4:** `/api/health` says `r2-configured`; a 50+ take library loads small thumbnails from the media host with `cf-cache-status: HIT` on the second visit; Blob downloads on Vercel's usage page drop close to zero.

### 2.5 What stays the same

- **Per-workspace authorisation.** Every link is minted by the app after the tenant, user and row checks, only for keys the ownership check accepts. The CDN decides nothing; the WAF only checks the app's signature.
- **Same-origin `?stream=1`** and every pixel reader in section 2.1.
- **Review links** keep streaming originals through the app, so revocation is immediate.
- **Stored data:** rows, stored URLs and API fields do not change. No migration.
- **Cache invariant:** `private, no-store` on authenticated responses, the redirects included.
- **Out of scope:** generation, pricing and polling.

### 2.6 Risks

- **Bearer links.** A media link works for whoever holds it, for up to two hours. Removing a member does not cut links already handed out. Review originals are not affected.
- **Edge cache** is not purged when media is deleted; the cached copy can outlive the delete until evicted. Purge-by-URL on delete is a later option.
- **CORS on cached objects.** A cached copy can carry another origin's allow-origin header, which is why pixel reads stay same-origin.
- **Transformations** above the free monthly allowance are metered by Cloudflare (the owner watches the usage page), and very long masters keep the fallback.
- **The `private` header on stored objects.** If `HIT` never appears despite the cache rule, a follow-up changes the cache header for new writes only.

---

## 3. P4: Docker and Inngest at staging.particl.si

The server runs the same app at `staging.particl.si` while Vercel keeps serving `particl.si`. Coolify builds from GitHub with a Dockerfile.

**Staging shares the live database and storage.** Anything paid that runs there is real. Use only the owner's internal workspace, with his yes each time. The credit switchover is done (particl.si has run at the new credit unit since 5 October), so the old unit mismatch risk is gone, but the Coolify setting for the credit unit must still match the ledger's unit exactly.

### 3.1 Why a helper is needed

Inside Docker the app sees its own address as an internal one, so same-origin checks reject every form post and sign-in with 403, and review links carry the internal address. There are about 19 request-origin sites across 18 files: `withTenant` in `lib/auth.ts` (every form post on the routes that use it), `sameOriginProblem` in `lib/accountDb.ts` (sign-in, sign-out, sign-up, resend, reset, accept invite, setup, verify, account security, workspace create and switch), the collab token route, several workbench routes, the transcribe route, `app/api/shares/route.ts` (review links), `app/api/openapi/route.ts`, `app/api/mcp/route.ts`, and the signup routes. Existing helpers to fold into the new one with behaviour unchanged: `lib/site.ts` (`siteOrigin`), `lib/mail.ts` (`inviteOrigin`), `lib/held.ts` (`siteUrl`), `lib/dispatch.ts` (`dispatchOrigin`), `lib/billingConfig.ts` (`billingOrigin`, which keeps its strict https rule), `lib/crew/mcp.ts`, `app/layout.tsx`. Also check the `/site` redirect built in `proxy.ts`.

### 3.2 PRs in order

Tags: `[SIGN-IN]`, `[ENV]`, `[MONEY]` need the owner's merge.

**P4-1 `vps/dockerfile`** (no owner hands; inert on Vercel)

- `Dockerfile`, three stages on a Node 24 slim image. Deps: copy the manifests, `public/open-source/` (a local tarball dependency lives there) and the two postinstall scripts (`scripts/copy-pdf-worker.mjs`, `scripts/copy-ocr-worker.mjs`), then `npm ci`. Build: `NEXT_OUTPUT=standalone`, build arguments for `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and the source commit, then `npm run build`. Run: copy the standalone output, static files and `public/`; set `NODE_ENV=production`, the listen port and `PARTICL_STANDALONE=1`; a data folder owned by the `node` user; run as `node`; a `HEALTHCHECK` on `/api/health`.
- `.dockerignore`: leave out `.git`, `node_modules`, `.next`, `docs`, `design`, `tests`, every `.env*`, local data, `.vercel`, logs and test output. Keep `public` and the two postinstall scripts.
- `next.config.ts`: add `...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),` beside the existing spreads. Vercel builds do not set it.
- `env.vps.template`: setting **names and comments only**, built from the code, never values. It says which `VERCEL_*` names to drop and which three to keep (see section 4).
- `.github/workflows/docker.yml` (new, path-filtered plus manual run): build the image; run it with `ENGINE_MOCK=1`, a throwaway local database and random test secrets made in the job; put a local TLS proxy in front; assert `/api/health` answers JSON with the database ok; load `/login` and the public pages.
- Gates: `npm run build` without `NEXT_OUTPUT`, the bundle spec, the new docker job green, a green Vercel preview build. This PR can merge without the owner's merge gate (no runtime change on Vercel); tell him.

**P4-2 `vps/public-origin`** `[SIGN-IN]`

- In `lib/site.ts`: `publicOrigin(req)` returns `APP_ORIGIN` **only inside the image** (`PARTICL_STANDALONE=1`); a missing value fails closed with a 503 that names the setting. Everywhere else it returns the request's own origin exactly as today (see section 4 for why). `sameOriginProblem(req)` becomes the one check for all the form-post sites. `internalOrigin()` is `WORKER_ORIGIN` or else the public origin, for the MCP route's calls back into the app; its links use the public origin.
- Move the other sites and helpers in section 3.1 onto it. Remove the hard-coded fallback host in `lib/higgsfield-consumer/oauth.ts` (a sign-in flow, so the owner's). Fix the `proxy.ts` redirect if its Location is wrong behind the proxy.
- Tests: helper unit tests (Vercel or local mode, standalone mode, standalone with no `APP_ORIGIN`, trailing slash); route tests with an internal request URL and an `Origin` of the staging host (allowed) or an unrelated host (403), covering login, logout, setup and one `withTenant` POST; the shares link uses the public origin; MCP calls go to the internal origin while its links use the public one; the docker job adds setup, sign out, sign in through the local proxy, all expecting 200.
- Gates: full unit, build, docker job, owner's merge.

**P4-3 `vps/client-address`** `[SIGN-IN][ENV]`

- New `lib/client-address.ts`: `clientAddress(req)` reads `cf-connecting-ip` **only when `CLIENT_IP_HEADER=cf-connecting-ip`** is set; otherwise today's rule (first `x-forwarded-for` entry, then `x-real-ip`). Used by `sourceKey` in `lib/auth.ts` (login, reset, signup, resend locks), `app/api/access-request/route.ts` and `app/api/report/route.ts`.
- Tests: without the setting a forged `cf-connecting-ip` changes nothing; with it a forged first `x-forwarded-for` entry changes nothing; eight failures lock only that address and email.
- Owner: set the setting on Coolify only, after P2-6.

**P4-4 `vps/limits-as-settings`** `[ENV][MONEY: how many paid jobs run at once]`

- Inngest limits become settings (`INNGEST_CONCURRENCY`, `INNGEST_WORKSPACE_CONCURRENCY`, defaults unchanged) where they are hard-coded in `lib/workers.ts` and `lib/workbench/development-worker.ts`. The one-run-per-production rule stays fixed (correctness, not capacity). Native mode gets `WORKER_SLOT_LIMIT` and `WORKER_SLOT_WORKSPACE_LIMIT` (`lib/worker-slots.ts`).
- Jobs at once by plan (Invite 2, Studio 5, Agency 15, Production 50) sit beside the default plans in `lib/plans.ts` and are read by `limitsFor` (`lib/limits.ts`) only when `WORKSPACE_JOB_LIMIT_DEFAULT` is set. Unset, today's default stands, so Vercel is unchanged. A workspace's own override still wins. A job over the limit already waits rather than failing.
- Tests: env parsing (a bad value falls back); **Inngest function config identical to today's when unset** (it is a registration contract); `limitsFor` with and without the table.

**P4-5 `vps/worker-origin-and-deadline`** `[ENV][MONEY: paid background work]`

- `dispatchOrigin` (`lib/dispatch.ts`) prefers `WORKER_ORIGIN` (the app's own loopback address), then `APP_ORIGIN`, so background work does not leave the box and come back through Cloudflare.
- New `lib/work-deadline.ts` runs work inside an abort signal that fires at 300 seconds; `recoveryFetch` (`lib/recovery.ts`) and the R2 request handler (`lib/storage/r2.ts`) join it so in-flight I/O stops. An aborted mutation is already recorded as uncertain and never bought twice. Applied to `/api/worker`'s continuation, the cron body and its `after()` continuations, every `after()` through `reserveRecoveryContinuation`, and the Inngest step bodies. Only inside the image; on Vercel the platform already enforces it.
- A worker slot is released only once the work has actually stopped; stuck work frees its slot when the 330-second TTL expires.
- Tests: deadline unit tests with fake timers; a handler stuck on a fetch is aborted at 300 seconds; the worker route records the timeout and does not free the slot early; the cron deadline.

**P4-6 `vps/app-env`** `[ENV][MONEY: billing guard]`

- Read `APP_ENV`, falling back to `VERCEL_ENV`, at the payment-provider live-key guard (`lib/billingConfig.ts`), `lib/deploymentReadiness.ts`, `instrumentation.ts` and `lib/workerProbe.ts`. Region and commit fall back to `APP_REGION` and `GIT_COMMIT`. The deployment id falls back to `APP_DEPLOYMENT_ID` or `GIT_COMMIT` after the Vercel names, otherwise every server deploy records as "local" in the recovery fence.
- Tests: unit tests for each fallback order.

**P4-7a `vps/long-waits`** (owner's preview)

- MCP `wait_for_render` (`lib/mcp.ts`): maximum wait 270 down to 110 seconds, default 240 down to 100; the tool already says "call again".
- Uploads (`lib/uploadClient.ts`): treat 502, 504 and 524 from `/api/uploads/finish` as "still finishing" and poll `/api/uploads/session` (the server already persists the result).
- Tests: unit tests for both.

**P4-7b `vps/atomik-turn-handover`** `[MONEY]`

- `POST /api/atomik/[id]` still waits up to 100 seconds. If the turn is still running it answers 202 with the chat (status "thinking") and finishes under the deadline. The client polls the existing GET. The Atomik panel work must handle the 202.
- Tests: route tests for a fast and a slow turn, plus the client.

**P4-7c `vps/paid-text-heartbeat`** `[MONEY]`

- Routes: the four Atomik drafts (ideas, shots, treatment scene, memory read), `prompt/enhance` and `audio/transcribe`. With an opt-in header, after admission and the price check, a reply not ready within 25 seconds becomes a 200 stream of whitespace heartbeats every 20 seconds, then the JSON; a late failure goes in the body as `{error, status}`. Callers send the header and read errors from the body (found by grep). The crew rounds SSE stream (`app/api/crew/sessions/[id]/rounds/route.ts`) gets `: keep-alive` comments.
- Tests: routes, clients, and a browser check on one draft page at the five sizes.

**P4-8 `docs/particl-si`** (owner's preview: public text and `CLAUDE.md`)

- Replace the old `particl.app` address in `CLAUDE.md`, `README.md`, `docs/particl-sow.md` and the marketing window labels (`app/(marketing)/site/_pages/{gen,studio,viral,workspace}/index.tsx`). Leave history docs alone. A unit test checks that no source file outside history docs names the old address. The address itself still comes only from `APP_ORIGIN`, `APP_URL` and `NEXT_PUBLIC_APP_URL`.

Every P4 PR runs typecheck, lint (zero errors), full unit, the bounded build plus the bundle spec, and the docker job.

### 3.3 The owner's Coolify steps

Do these after P4-1 to P4-6 have merged and the P2 gate is passed.

1. **Application.** Coolify, Projects, add `particl`, environment `staging`, New, Application: Private Repository (with GitHub App), the app from P2-5, repository `aimighty-workspace`, branch `main`, build pack **Dockerfile**, exposed port 3000.
2. **Domain.** `https://staging.particl.si`. In Cloudflare add a proxied A record `staging` to the server (as in P2-4).
3. **Storage.** Persistent Storage: a small volume mounted at the app's data folder (`/app/.data`).
4. **Inngest.** New, Docker Compose, from Inngest's self-hosting example (server, Postgres, Redis). Start the server with new event and signing keys (`openssl rand -hex 32`, kept only in Coolify), 100 queue workers, and the SDK URL pointing at the app container's `/api/inngest`. Publish its dashboard on the loopback interface only and open it through an SSH tunnel. Tick "Connect to predefined network" so the app and Inngest reach each other by container name.
5. **Settings.** Pull Vercel's settings again and clean them as `env.vps.template` says:
   - delete `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_OIDC_TOKEN`, `VERCEL_GIT_*`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_PROJECT_PRODUCTION_URL` and any empty values;
   - **keep `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`** (section 4);
   - **stop if `KEYRING_SECRET` is blank**; take it from the password manager;
   - paste in Coolify's Developer view and tick **Build Variable** on `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY`;
   - set `APP_ORIGIN`, `APP_URL`, `NEXT_PUBLIC_APP_URL` to `https://staging.particl.si`; `APP_ENV=staging`; `APP_REGION` to a label for the server's region; `DISPATCH_MODE=inngest` with its event key, signing key, base URL, serve origin and `INNGEST_DEV=0`; `WORKER_ORIGIN` to the app's loopback address; `CLIENT_IP_HEADER=cf-connecting-ip` (only after P2-6); `WORKSPACE_JOB_LIMIT_DEFAULT`; `CREDIT_USD` set to the same value as Vercel Production and the ledger; storage and media as on Vercel Production (`STORAGE_BACKEND`, `R2_*`, `MEDIA_ORIGIN`, `MEDIA_TOKEN_SECRET`);
   - leave the two Inngest concurrency settings at their defaults on staging, because staging runs real jobs. Raise them only on a separate load-test copy.
6. **Health check.** Path `/api/health`, port 3000.
7. **Post-deployment command**, so each deploy re-registers the functions with Inngest: a one-line Node `fetch` of the app's own `/api/inngest` with method PUT, exiting non-zero if it fails. If Coolify offers "Include source commit in build", tick it so `/api/health` shows the commit.
8. **CORS.** Add `https://staging.particl.si` to the production bucket's allowed origins. Leave the cron on Vercel; staging gets no scheduled task.
9. **Deploy.** Take a snapshot first, then deploy and read the build log.
10. **Database latency.** Time the signed-in `/api/health` on staging and on particl.si a few times each in the browser's Network panel. Both read the same databases, so this is a like-for-like comparison.

### 3.4 The 12-step smoke test on staging

Free steps, as soon as it deploys:

1. Sign in, then sign out.
2. Signed-in `/api/health` shows the database, `r2-configured` and `dispatch: inngest`.
3. A client workspace works: its stored keys read through `KEYRING_SECRET`.
4. The Library and a board load, and a teammate in another browser sees edits live (this also exercises the collab origin check).
5. A new review link starts with `https://staging.particl.si`. Revoke it afterwards.
8. A file over 100 MB uploads (in 3.5 MB chunks).
11. An invite email to the owner's own address arrives with the right link.
12. Coolify's log shows no errors through all of the above.

Extra check for P2-7 and P4-3: eight wrong passwords for a non-existent email from the Mac lock only that address; from a phone on mobile data the same email can still try.

Paid steps (internal workspace only, with the owner's yes, cost stated first):

2b. A cheap still shows up as a run in the Inngest dashboard.
6. One cheap still: quote, run, the result lands.
7. One short video lands and scrubs smoothly.
9. Atomik answers in chat, and the call shows on the model provider's usage page, not Vercel's (needs the direct-provider package).
10. A 3D blocking render completes through the Vercel Sandbox.

**Gate to P5:** all 12 pass; the 1,000-job load test passes on a separate staging copy with its own database and bucket; P4-7a, P4-7b and P4-7c have merged.

### 3.5 Which PRs need the owner's merge

| PR | Owner's merge? | Why |
|---|---|---|
| P4-1 Dockerfile and docker CI job | No (tell him) | Inert on Vercel; no env, sign-in, storage or money change |
| P4-2 public origin | **Yes** `[SIGN-IN]` | Changes how every sign-in and form post is checked |
| P4-3 client address | **Yes** `[SIGN-IN][ENV]` | Changes the sign-in lock key; adds a setting |
| P4-4 limits as settings | **Yes** `[ENV][MONEY]` | Changes how many paid jobs can run at once |
| P4-5 worker origin and deadline | **Yes** `[ENV][MONEY]` | Changes paid background work |
| P4-6 app environment names | **Yes** `[ENV][MONEY]` | Touches the payment-provider live-key guard |
| P4-7a long waits | Owner's preview | Outside agents' API and upload client |
| P4-7b Atomik turn handover | **Yes** `[MONEY]` | Paid route |
| P4-7c paid-text heartbeat | **Yes** `[MONEY]` | Paid routes |
| P4-8 docs | Owner's preview | Public text and `CLAUDE.md` |
| P3-1 | No | Ops script and pure helper |
| P3-2, P3-3, P3-5, P3-7 | **Yes** | Storage, secrets, backups |
| P3-4, P3-6 | Owner's preview | UI not behind the new-interface switch |

### 3.6 Risks

- **Standalone tracing can miss a dynamically loaded file** (the PDF and OCR workers, the audio encoder, the S3 SDK). The docker job and a staging walk-through catch it; the fix is `outputFileTracingIncludes`.
- **A deploy restarts the container** and kills in-flight `after()` work. The recovery fence and the cron recover it; test it. Ask Coolify for a long stop grace period.
- **Pages and renders share one container** until a separate worker container exists. Watch memory against the 80% line in the standing checklist.

---

## 4. Notes carried from 5 October

1. **Staging shares the live database, so no paid work there until the credit switchover.** The switchover is now done: particl.si has run at the new credit unit since 5 October. The rule narrows to this: staging's credit-unit setting must equal the ledger's unit, and any paid step still runs only in the internal workspace with the owner's yes, because it is real work on the live database.
2. **Keep the Blender sandbox credentials when cleaning the env file.** "Delete the `VERCEL*` lines" would also remove `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. The 3D blocking renders need all three off Vercel (`lib/astra-blender/sandbox.ts`); without them the code falls back to an identity token that exists only on Vercel. Keep them in `env.vps.template`'s "keep" list and in Coolify.
3. **Rework paid routes that can outlast Cloudflare's 125-second limit before P5.** Behind Cloudflare, a response must start within 125 seconds (the proxy read timeout, not changeable on lower plans), and a stream must not go quiet that long. A customer must never be charged for a request Cloudflare cut off. The routes and the fix for each:

   | Route | Today | Fix |
   |---|---|---|
   | Atomik turn (`atomik/[id]` POST) | Synchronous | 202 plus poll (P4-7b) |
   | Four Atomik drafts, `prompt/enhance`, `audio/transcribe` | Synchronous | Heartbeat stream (P4-7c) |
   | Crew rounds (`crew/sessions/[id]/rounds`) | SSE, a turn can be silent | Keep-alive comments (P4-7c) |
   | MCP `wait_for_render` | Holds up to 270 s | 110 s maximum (P4-7a) |
   | `uploads/finish` | Assembles up to 2 GiB synchronously | Client polls on 524 (P4-7a) |
   | `jobs/[id]` GET, `export` GET, `soul/identities` GET | Can run long inline | Watch; move work into `after()` or stream if a 524 is seen |
   | `higgsfield/consumer/*` | Sign-in features | Retire before P5 under the API-and-loginless-only rule (separate PR, owner) |

   Already safe (answer 202, use `after()`, stream or redirect): `media/[id]`, `uploads/[id]`, `workbench/media/[id]`, `review/[token]/media/[genId]`, `export/selects`, `workspaces`, `workbench/development`, `workbench/atomik`, `workbench/astra-blender/render`, `pipelines/[id]`, `jobs`, `generate`, `audio`, `audio/dub`, `auth/signup`, `auth/verify`. The internal routes `worker`, `inngest` and `cron/sync` never go through Cloudflare on the server.
4. **The `APP_ORIGIN` helper must not break preview sign-ins.** Production has `APP_ORIGIN` set to the production address. If Preview also has it and the helper prefers it, every sign-in and form post on a preview URL gets a 403, which breaks the owner's preview checks. So `publicOrigin` uses `APP_ORIGIN` only inside the Docker image (a flag set in the Dockerfile) and keeps the request's own origin everywhere else, exactly as today. A test covers a preview-style request with `APP_ORIGIN` set and the flag off.
5. **`cf-connecting-ip` is trusted only behind Cloudflare.** On Vercel today (DNS only, no Cloudflare in front) a client can send its own `cf-connecting-ip` and get a fresh lock key on every attempt. Behind Cloudflare it is the first `x-forwarded-for` entry that a client can forge. So the app reads `cf-connecting-ip` only when `CLIENT_IP_HEADER=cf-connecting-ip` is set, and that setting goes on Coolify only, after the P2 firewall is on (so nothing but Cloudflare can reach the server).

## 5. Order of work and what waits

Code can be written and tested on branches now, inert by default; almost none of it merges without the owner. Suggested order for one lane: P4-1, P4-2, P3-1, P3-3, P4-3 to P4-6, P3-2. P3-4 onward come after the demo. The P5 cutover checklist and the P8 package (load test, separate worker container, error tracing) are outside this document; P5 needs every gate above plus the credit switchover steps already completed.
