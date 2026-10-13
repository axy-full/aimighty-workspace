# release/1 to production: fast launch (today, Sun 11 Oct 2026)

For the owner and his advisor. Written Sun 11 Oct against `release/1` at 65042dca. Nothing in it has been done yet.

**Where things stand.** particl.si runs `main` and has no real users besides the team. `release/1` is 1,350 commits ahead, and main has nothing `release/1` lacks, so the merge is clean. Deploys are a Coolify **Deploy** on the DigitalOcean box. Today `curl https://particl.si/api/health` answers `{"ok":true,"mock":false,"dispatch":{"mode":"inngest"},"database":"ok","storage":"ok",…}`, with no `commit` field. `release/1` adds that field, so it shows when the new build is live.

**The one thing that can break.** Removing `AI_GATEWAY_API_KEY` only works if `TEXT_DIRECT` and `MODEL_CATALOG` are set first (§2, §10 step 8). Without them, Claude, Gemini and Grok text stops: Atomik can only use OpenAI models, and the prompt writer and idea/shot drafting fail.

---

## 1. Backup (just before the deploy)

Turso keeps point-in-time restore. The Scaler plan has a 30-day window (docs/selfhost-test.md, line 20). The "restore point" is just the exact time you write down. On top of that, take a plain SQL export of every database.

**Which databases.**

| Database | How to find its name |
|---|---|
| Platform | The host in `PLATFORM_DATABASE_URL`. If that's unset, `TURSO_DATABASE_URL`. The name is the part before `-<org>.turso.io` (lib/platform.ts:36). |
| House workspace (`ws_legacy`) | The host in `TURSO_DATABASE_URL` (lib/platform.ts:304). It may be the same database as the platform one. |
| Every other workspace | `particl-<slug>-<4 chars>`, made by lib/provision.ts:28 in `TURSO_ORG` (group `TURSO_GROUP`, default `default`). Each name is in `workspaces.db_name`. |

**Commands** (on your laptop or the box, wherever the `turso` CLI is logged in to the org):

```sh
mkdir -p ~/particl-backups/2026-10-11-predeploy && cd ~/particl-backups/2026-10-11-predeploy
date -u +%Y-%m-%dT%H:%M:%SZ | tee restore-point.txt          # the PITR timestamp
turso db list | tee dbs.txt                                     # every database in the org
turso db shell <platform-db> "SELECT id, slug, db_name, legacy, deleted_at FROM workspaces" | tee workspaces.txt
for db in $(turso db list | awk 'NR>1 {print $1}'); do
  turso db shell "$db" .dump > "$db.sql" || echo "FAILED $db" | tee -a failed.txt
done
```

`turso db export <db>` writes a SQLite file instead, if your CLI version has it (`turso db export --help`). Either is fine.

**Check the backup** (2 minutes):

1. `failed.txt` doesn't exist.
2. There's one `.sql` file per line of `dbs.txt` (minus the header line).
3. Every `db_name` in `workspaces.txt` has a file.
4. Load the platform dump and run a query:
   ```sh
   sqlite3 /tmp/p.db < <platform-db>.sql
   sqlite3 /tmp/p.db "PRAGMA integrity_check; SELECT count(*) FROM workspaces; SELECT count(*) FROM accounts;"
   ```
   It should print `ok` and two non-zero counts.
5. Copy the folder to a second place (your laptop, if you ran this on the box).

Media in R2 (and old Blob media) isn't touched by this deploy, so it doesn't need a copy.

**Restoring** (only if §7 says so): `turso db create <db>-restore --from-db <db> --timestamp $(cat restore-point.txt)`. Then point the env var at the new database, or load the `.sql` back in. Restoring signs nobody out; it only rewinds data.

## 2. Env vars release/1 needs

These are names only, from grepping `process.env.*` and `env.*` across app/, lib/, scripts/, ops/, mcp/, proxy.ts, next.config.ts and instrumentation.ts at `origin/release/1`, plus lib/vendorKeys.ts, which reads vendor keys by name. The readiness list is lib/deploymentReadiness.ts. Signed in as platform owner, `https://particl.si/api/admin/readiness` shows each check as true/false, before and after the deploy.

**New in release/1** (main never reads these, so production doesn't have them):

| Name | Set to | Where it's read | When |
|---|---|---|---|
| `WEB_CONCURRENCY` | `3` | ops/selfhost/cluster.mjs (default 3; `1` is the rollback switch) | Before the deploy |
| `WORKER_ORIGIN` | `http://127.0.0.1:3000` | lib/dispatch.ts:89 (only used by native dispatch; production uses Inngest, so this is a fallback) | Before the deploy |
| **`TEXT_DIRECT`** | `anthropic,google,xai` | lib/textDirectVendors.ts:12, lib/textRoute.ts:103 | **Before removing the gateway** (step 8) |
| **`MODEL_CATALOG`** | `static` | lib/catalog.ts:224 | **Before removing the gateway** (step 8) |
| `WORKER_HEAP_MB` | leave unset (896 MB per process) | ops/selfhost/cluster.mjs | — |
| `CLUSTER_*` (6 names) | leave unset (defaults) | ops/selfhost/cluster.mjs | — |
| `PROMPT_MODELS` | leave unset (`GATEWAY_PROMPT_MODELS` is still read) | lib/enhance.ts | — |
| `MAX_PROVIDER_VIDEO_BYTES`, `VIDEO_TRANSFER_CONCURRENCY` | leave unset (1 GiB default) | lib/storage.ts | — |
| `ASTRA_RENDER_BACKEND`, `ASTRA_WORKER_*` | leave unset (Vercel Sandbox, as today) | lib/astra-blender/backend.ts | — |

Main reads `APP_URL` and `NEXT_PUBLIC_APP_URL`, but release/1 doesn't any more. Leaving them set is harmless.

**Required, and main already reads them**, so production has them while it's healthy (check in Coolify):

| Group | Names |
|---|---|
| Databases | `PLATFORM_DATABASE_URL` + `PLATFORM_AUTH_TOKEN` (or the `TURSO_*` pair), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `TURSO_API_TOKEN`, `TURSO_ORG` (`TURSO_GROUP` optional) |
| Secrets | `KEYRING_SECRET` (32+ chars), `SESSION_SECRET`, `CRON_SECRET` |
| Storage | `STORAGE_BACKEND=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`R2_ENDPOINT` optional). Keep `BLOB_READ_WRITE_TOKEN` for older media. |
| Mail | `RESEND_API_KEY`, `MAIL_FROM` |
| Origin / proxy | `APP_ORIGIN=https://particl.si`, plus `SELFHOST_BEHIND_PROXY`, `TRUST_CF_CONNECTING_IP`, `TRUSTED_PROXY_HOPS` as they are now |
| Background work | `DISPATCH_MODE=inngest`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`. `INNGEST_SERVE_ORIGIN` and `INNGEST_STREAMING` are read by the Inngest SDK. |
| Deployment | `PARTICL_DEPLOYMENT=production`, `SUPER_ADMIN_EMAIL` |
| Boards (live presence) | `LIVEBLOCKS_SECRET_KEY` (lib/collab.ts) |
| Push | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (also a build arg), `VAPID_PRIVATE_KEY` (`VAPID_SUBJECT` optional) |
| Astra renders | `ASTRA_BLENDER_SNAPSHOT_ID`, `ASTRA_BLENDER_RATE_CARD`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` |

**Vendor keys:**

| Name | In production | Note |
|---|---|---|
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `ARK_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `HF_CREDENTIALS` | yes | |
| `ANTHROPIC_API_KEY` | added today | While production is still on **main**, this key alone switches main's prompt writer to Claude direct (main's lib/enhance.ts, `refineProvider`). That's expected and harmless. On release/1 the key does nothing until `TEXT_DIRECT` lists `anthropic`. |
| `AI_GATEWAY_API_KEY` | yes | Removed in step 8, after `TEXT_DIRECT` and `MODEL_CATALOG` are set |

**Must stay unset:** `ENGINE_MOCK` (it must not be `1`; readiness check "generation"), `OWNER_PRIVACY_SCRUB_LOCAL` and `PARTICL_ALLOW_STAGING_REHEARSAL`.

**Optional with defaults** (don't add any): `CREDIT_USD` (0.10, lib/creditTerms.ts:36), `CREDIT_MARGINS`, `CREDIT_PACKS`, `SIGNUP_CREDITS`, `PLATFORM_ALLOWANCE_USD`, `ATOMIK_MAX_REQUEST_USD`, `WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD`, the `*_BASE_URL`s, `ARK_TEXT_MODEL`, `XAI_MODEL`, `GEMINI_IMAGE_MODEL`, `GOOGLE_SAFETY_THRESHOLD`, `HF_*` toggles and rates, `FAL_TRAIN*`, `ELEVEN_*`, `BLOB_USD_*`, `WARM_*`, `REFINE_PROVIDER`, `ANTHROPIC_PROMPT_*`, `LEGACY_WORKSPACE_NAME`, and `PAYMENT_PROVIDER`/`STRIPE_*` (billing is off today: "Online subscriptions are being connected").

**`RIG_AGENT_ENABLED`** (lib/workbench/rig-agent.ts:91) is the owner's call. Unset in production means **Atomik's board building is off**. Main reads it too, so today's value carries over. Set it to `1` only if Atomik should build on boards from day one.

**Test and script only** (never in Coolify): `PARTICL_TEST_MOCK_DELAYS`, `PWTEST_SHARD_WEIGHTS`, `CI_DEV_SOURCE_MAPS`, `GITHUB_*`, `RUNNER_TEMP`, `ASTRA_WORKER_TEST_ROOT`, `SOURCE_*`/`TARGET_*`, `STRIP_BLOCKING_DB_*`, `PARTICL_BACKUP_*`, `AIMIGHTY_*`, `PARTICL_URL`/`PARTICL_TOKEN`, `TURSO_CLI`.

## 3. Open sign-up

- **The setting.** `openSignup` lives in the platform database's `platform_layer` row `site` (lib/site/settings.ts). It's new in release/1 and off by default. Main has no such switch: sign-up is closed today because billing isn't configured.
- **Today:** `curl -s https://particl.si/api/auth/signup` answers `"open":false`, with the reason "Online subscriptions are being connected".
- **After the deploy:** the same curl should answer `"open":false` and `"inviteOnly":true` (app/api/auth/signup/route.ts:139). In **/admin → Site** the chip should read **Open sign-up · off**. Don't press it. Invitation links work as before.

## 4. Schema changes (applied on boot)

There is no migrations folder and no script to run. Each database adds what it lacks the first time it's used (`CREATE … IF NOT EXISTS`, `ADD COLUMN`). Every change below is additive. Nothing is dropped, renamed or re-defaulted, and no new boot-time `UPDATE`/`DELETE` was added in lib/db.ts or lib/platform.ts.

| Change | Database | Safe? |
|---|---|---|
| New tables: `api_token_grants`, `sample_lifts`, `identity_consents`, `consent_recordings`, `prepared_jobs`, `review_link_scopes`, `review_verdicts`, `review_link_hits`, `rig_plan_approvals` | workspace / platform | Additive. Main ignores them. |
| New nullable columns: `atomik_messages.ledger`, `atomik_spend.ledger`, `generations.refine_ledger`, `meter_events.hold_band`, `meter_events.overrun_usd`, `paid_text_jobs.reconcile_lease`, `astra_render_jobs.claimed_at`, `upload_sessions.failure`, `rig_agent_runs.attachments`, `rig_agent_steps.approval_id`, `rig_agent_steps.fix_of` | both | Additive |
| #637: `billing_cycles_ws` on `billing_cycles(workspace_id)`, `meter_events_created` on `meter_events(created_at)` | platform | Additive. The first start builds them while holding the write lock. Production's tables are small (no real users), so expect seconds. |
| Indexes on the new tables: `identity_consents_subject`, `prepared_jobs_state`, `review_verdicts_gen`, `sample_lifts_one_open` | workspace | Additive, on empty tables |

**One thing a rollback can trip on** (from the 9 Oct analysis): release/1 saves `production.blocking` and `production.boards.looks` into project JSON. Main's schema for those objects is `.strict()`, so after a rollback main refuses to save a project that release/1 has touched. With no customers, that only affects projects the team edits on release/1. `scripts/ops/strip-production-blocking.mjs` strips `blocking` (not `looks`).

## 5. New interface (prototype 12)

**How it works.** lib/newInterface.ts:11 turns it on for the house workspace (`ws_legacy`) and for any workspace id in the site setting `newInterfaceWorkspaces` (up to 50). It's read in app/(app)/layout.tsx:47, /api/me, /api/billing and lib/shell/bootstrap.server.ts. Off, a workspace sees the graphite screens: release/1's Home, board, Make, Atomik, Control room and Settings. Those are still all new compared with today's particl.si.

**Recommendation: don't turn it on for every workspace at launch.** Keep the standing owner decision: on for the house workspace, off for everyone else.

- **Why:** the v12 screens are still being built lane by lane (docs/redesign-progress.md), and five actions still show "quoted" instead of a live price. The five-minute test (rule 17) runs on the graphite screens, not v12.
- **The trade-off:** your own house workspace shows v12. An invited person sees graphite. That's a split, but each side is consistent.
- **To show v12 to a team workspace,** add its id to the list. There's no button for this on the /admin card. Signed in as platform owner on particl.si, run this in the browser console:
  ```js
  fetch('/api/admin/site',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({newInterfaceWorkspaces:['<ws_id>']})})
  ```
  The ids are in /admin → Workspaces.
- **If you want everyone on v12 anyway,** that's a code PR merged before the deploy, not a setting. lib/newInterface.ts:13 becomes `return true;`. It also has to change tests/unit/newInterfaceSwitch.spec.ts, which asserts the current rule, so it's a reviewed PR, not a one-line hotfix.

## 6. Smoke tests (after the deploy)

| # | Where | Look for |
|---|---|---|
| 1 | `curl -s https://particl.si/api/health` | `"ok":true`, `"mock":false`, `"dispatch":{"mode":"inngest"}`, `"database":"ok"`, `"storage":"ok"`, and **`"commit":"<first 7 of main's new head>"`** (field `commit`, app/api/health/route.ts:138, from `GIT_COMMIT_SHA`/`SOURCE_COMMIT`, lib/deployment.ts:79) |
| 2 | `curl -s https://particl.si/api/auth/signup` | `"open":false,"inviteOnly":true` |
| 3 | https://particl.si/login, then https://particl.si/admin | Signs in. The Workspaces header shows the same count as before the deploy. Open sign-up is off. |
| 4 | https://particl.si/api/admin/readiness (signed in) | `"ready":true`; no required check false |
| 5 | https://particl.si/api/health (signed in) | `providers[]`: `gemini` via `key`, `openai` via `key`. `mail.configured: true`. `cron` shows a run within 10 min of the deploy. |
| 6 | Inngest dashboard → Apps → particl → **Resync** (`https://particl.si/api/inngest`) | Synced, 6 functions: probe, render, astra-render, dubbing, rig-agent, development worker |
| 7 | Open a production and its board | The board loads and live presence works (two tabs see each other) |
| 8 | **Internal test workspace only** (flagged internal in /admin; otherwise the house workspace): one **Standard still, Nano Banana 2, 512 = 1 cr**. The owner says yes first. | The image lands in the take and appears in the Library. The price on the button reads `1 cr`. |
| 9 | Atomik in the same workspace: one short question | It answers. A planning turn is a real text call: the price shows before you approve, and the owner approves. |

## 7. Rollback

**Plain words.** Coolify keeps the previous image. Open the app in Coolify → **Rollback** tab → pick the image from before today (main) → **Rollback**. The site is back on main in about a minute. Before you deploy, check that the main image is listed there; Coolify keeps 2 images by default ("Docker images to keep").

**Before rolling back to main:**

- If you've already removed `AI_GATEWAY_API_KEY`, **put it back first.** Main needs the gateway for Atomik, the catalogue and the prompt writer.
- `TEXT_DIRECT`, `MODEL_CATALOG`, `WEB_CONCURRENCY` and `WORKER_ORIGIN` can stay. Main ignores them, and main's image runs `node server.js`, not `cluster.mjs`.

**Data written in between:**

- The new tables, columns and indexes stay. Main ignores them.
- A project the team edited on release/1 may refuse to save on main (§4). Run `scripts/ops/strip-production-blocking.mjs` for that project, or re-create it.
- **Use the Turso restore point only** if main misbehaves on data in a way that matters. With no customers, that's unlikely. Anything done after the timestamp is lost.

## 8. Dropped from the old plan

| Item | Why it's dropped |
|---|---|
| 7-day staging soak | No real users. A rollback is a minute in Coolify, and the backup covers the data. |
| Rollback-compat backport to main | It only protects projects edited on release/1. With no customers, that's the team's own projects; strip or restore if it ever comes up (§7). |
| Money-sweep measurement | Two sweeps run on the first cron pass (app/api/cron/sync/route.ts). See the rows below. |

The two sweeps:

- **Paid text** (`reconcilePaidTextJobs`, lib/paidText.ts:455). It refunds each workspace's `paid_text_jobs` rows in `queued`/`running`/`uncertain` with no response and older than 30 min, 10 per run. Main never runs this pass.
- **Cinema** (`expireUnansweredCinemaTakes`, lib/genjutsuVideo.ts:210). It fails Higgsfield Cinema `generations` still `queued`/`running` after 24 h, 5 per run, with `cost_usd=0`.

How many rows they touch **can't be known without production database access**. No fixture models it. With no real users, the expected number is about 0: at most a few of the team's own stuck jobs, which get refunded or released. That is the right outcome.

## 9. #609 vs release/1

- **Deploy release/1 directly. Don't merge #609.** #609 backports #606 (multi-process, `WEB_CONCURRENCY`) to main, and release/1 already has #606 (b3e95735). Merging #609 first would put a commit on main that release/1 lacks, which turns a clean merge into a possible conflict, all to ship code that arrives anyway. Close #609 once release/1 is on main.
- **How release/1 reaches main: reuse #546.** GitHub allows only one open PR per branch pair, and #546 is already `release/1 → main`, so a fresh PR would be refused while #546 is open. Retitle it **"Release 1 → main (launch, Sun 11 Oct)"** and replace its "do not merge" body.
- **Merge with "Create a merge commit"**, never squash or rebase. Squash would flatten 1,350 commits into one and split the branches' history. Main isn't branch-protected, so wait for #546's checks to go green on release/1's final commit before merging.

## 10. Runbook (owner, in order)

| Step | Do | Check before going on |
|---|---|---|
| 0 | Freeze `release/1`: tell the lead "freeze"; nothing more merges into it. Note its head sha. | The post-merge full run on that sha (Actions → Verify, event `push`, branch release/1) is green, **and** #546's checks are green on that sha |
| 1 | **Backup** (§1) | The §1 check passes; `restore-point.txt` is saved |
| 2 | Coolify → app → **Configuration**: Resource limits **CPUs 3**, **Memory 6 GB**. **Environment variables**: `WEB_CONCURRENCY=3`, `WORKER_ORIGIN=http://127.0.0.1:3000` (runtime, not build). **General/Advanced**: **Include Source Commit in Build** on. Confirm `ENGINE_MOCK` isn't set and `ANTHROPIC_API_KEY` is. **Save** (don't deploy yet). | Rollback tab lists the current main image |
| 3 | GitHub: merge **#546** with **Create a merge commit** | `main` head = the merge commit; note its first 7 characters |
| 4 | Coolify → **Deploy** | Build log ends successfully; the container is healthy |
| 5 | `curl -s https://particl.si/api/health` | `"commit"` = the 7 characters from step 3; `ok`, `database`, `storage` as in §6 |
| 6 | Inngest → Resync; smoke tests §6 rows 2–7 | All pass |
| 7 | Sign in → internal test workspace → board → **one Standard still (Nano Banana 2, 512): 1 cr**, owner's yes | Image lands; button read `1 cr` |
| 8 | Coolify env: **add `TEXT_DIRECT=anthropic,google,xai` and `MODEL_CATALOG=static`, then remove `AI_GATEWAY_API_KEY`** → **Restart** | `/api/health` (signed in): `anthropic` configured via `key`, `vercel` not configured |
| 9 | Atomik: one short question (owner approves the price). The prompt writer: one **Enhance** on a short prompt. | Both answer. Atomik's model menu still lists Claude. |

**Why step 8 needs the two extra variables** (checked in code):

- **Routing.** lib/textRoute.ts:103 sends a model to its own provider only when its vendor is in `TEXT_DIRECT`. Otherwise it goes through the gateway: `gatewayPost` → `gatewayAuth`, which throws "The model gateway is unreachable" (lib/gateway.ts:44). The default text models are all Claude (lib/platformLayer.ts:108: enhance `claude-sonnet-5`, idea and shot `claude-opus-5`), and so is the Atomik Auto list (lib/atomikModelPolicy.ts:112).
- **The catalogue.** With `MODEL_CATALOG` unset, lib/catalog.ts:241 drops every non-OpenAI model once the gateway is unreachable. Atomik would fall back to `openai/gpt-5.5`, and the Enhance route (app/api/prompt/enhance/route.ts:59) would lose its Claude choices. `MODEL_CATALOG=static` serves lib/modelCatalog.json (priced 8 Oct), keeping each vendor whose key is set (`callable`, lib/catalog.ts:203).
- **Once set,** Claude, Gemini and Grok text go direct with `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `XAI_API_KEY` (lib/language-provider.ts:48, lib/textDirect.ts:35). OpenAI was already direct.
- **Images don't need the gateway once their keys are set.** Stills go to Google with `GEMINI_API_KEY` (`stillsDoor`, lib/gemini.ts:49). OpenAI and xAI images go direct with their keys (lib/vendorImages.ts:75).
- **Still unverified:** the provider model ids in lib/textRoute.ts:41 (`claude-opus-5`, `claude-sonnet-5`, `gemini-3.x`, `grok-4.x`). The code itself says to check them against each provider's `/v1/models` during this smoke run. Step 9 is that check for Claude. Run one Gemini and one Grok text call if you use them.

## 11. If a check fails

| Failed at | Do |
|---|---|
| 1 Backup | Stop. Nothing has changed. Fix the export, then start again. |
| 2 Coolify settings | Put the values back as they were. Nothing is deployed yet. |
| 3 Merge | If you merged and haven't deployed, leave it. Production only changes when you press Deploy. (Reverting the merge on main is optional.) |
| 4 Build fails | Production keeps running main; nothing to undo. Send the build log to the lead. |
| 5 `commit` wrong or `ok` false | Coolify → Rollback to the main image (§7). Then `curl /api/health`: no `commit` field means you're back on main. |
| 6 Smoke test fails | Small and isolated (for example, one page): note it and carry on. Sign-in, /admin, the database or storage: roll back (§7). |
| 7 Still fails | If it says "Nothing billed", retry once. If it fails again, roll back and send the error text. |
| 8–9 Atomik or Enhance fails after removing the gateway | **Put `AI_GATEWAY_API_KEY` back → Restart.** You're on release/1 with the gateway, as at step 7. Leave `TEXT_DIRECT`/`MODEL_CATALOG` set or remove them; either works with the key back. No image rollback needed. |
| Later: data looks wrong | Restore the affected database from the restore point into a new database (§1) and compare before switching anything. |

## 12. Counts in /admin

**Today, read-only, before and after the deploy** (no code change; the same `turso` login as §1). Run against the platform database:

```sh
turso db shell <platform-db> "SELECT count(*) AS workspaces FROM workspaces WHERE deleted_at IS NULL"
turso db shell <platform-db> "SELECT count(*) AS people FROM accounts WHERE deleted_at IS NULL"
turso db shell <platform-db> "SELECT kind, count(*) AS grants, COALESCE(sum(credits),0) AS credits FROM credit_grants GROUP BY kind"
```

These only read. Write the three answers next to `restore-point.txt`; after the deploy they should be the same.


**What /admin shows today** (app/(app)/admin/page.tsx, data from `/api/admin/invites`, platform owner only):

- **Workspaces: yes.** Go to https://particl.si/admin and scroll to **Workspaces**. The header reads "*N* on this deployment, *M* deleted".
- **Users: only per workspace.** Each row shows "*n* members". There's no total, and adding the rows up counts a person once per workspace they belong to.
- **Credit grants: only per workspace, as amounts.** Each row's 30-day cell shows granted credits split free/paid (`grantsByKind`, lib/platform.ts:628). There's no platform total and no count of grants.

**Smallest read-only addition** (described here, not built). Add one `totals` object to the existing owner-only `GET /api/admin/invites`, and show it as one line under the Workspaces header, for example "12 workspaces · 31 people · 18 grants (2,450 free cr · 0 paid cr)". It's counts only, with no names or emails, and reads the platform database only:

- `SELECT count(*) FROM workspaces WHERE deleted_at IS NULL`
- `SELECT count(*) FROM accounts WHERE deleted_at IS NULL`
- `SELECT kind, count(*), COALESCE(sum(credits),0) FROM credit_grants GROUP BY kind`

That's about 15 lines plus one unit test, behind the existing `requireSuperAdmin`.
