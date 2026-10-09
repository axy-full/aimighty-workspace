# Taking `release/1` to production (plan only)

Status: **plan**, written 9 Oct 2026 for the owner. Nothing in it has been done. The owner picks the date after reading it.

Production (particl.si) runs `main` at 367ad430. `release/1` (f59d853f) is 1,002 commits ahead, and main has no commit `release/1` lacks. Until `release/1` ships, every infrastructure fix needs its own backport to main (#609 is the first). This plan is about shipping `release/1` as a whole.

## The short version

`release/1` is **not ready for a date yet**. Four things should be done first, in this order:

1. **Make rollback real.** Ship a small "rollback-compat" backport to `main` first. It makes main accept the project fields `release/1` writes. Without it, after a rollback, main cannot save any project that `release/1` has touched (see risk 2).
2. **Stand up a production-shaped staging and soak it.** Run the frozen release candidate against *copies* of production's databases, not fresh SQLite. `release/1` has never run on Turso or on production data.
3. **Decide the two money sweeps.** On its first cron run, `release/1` refunds old uncertain paid-text jobs and fails stuck Cinema takes. Measure exactly which rows that touches on the staging copies, then the owner decides: allow, or ship with those cron stages switched off for the first days.
4. **Accept, or build, a switch for the new interface.** The new interface has no customer switch, and the old one is gone. Either the owner accepts all-or-nothing, or we add a switch before the date (estimate: several days).

After those, cutover is a normal Deploy with a 24-hour watch, below.

## 1. What is on staging today

- **The last recorded staging pass** was `release/1` at **c287f044**, on the old Contabo Coolify behind a temporary sslip.io address (docs/selfhost-test.md, top). It checked:
  - the image build;
  - `/setup` sign-in;
  - renaming a workspace;
  - one upload to the staging R2 bucket, with its thumbnail;
  - `/api/health`.
- **Its databases were fresh SQLite files** (`file:/app/.data/…`). It ran with `ENGINE_MOCK=1` and `PARTICL_DEPLOYMENT=staging`, with native dispatch (no Inngest), and with no Stripe and no Turso API. It had **one workspace**.
- **Never exercised there:** per-workspace Turso databases, several workspaces, Inngest, the money paths with real data, and any production-shaped data.
- `release/1` is now **213 commits past c287f044**.
- **Unknown:**
  - Contabo is closing, and I found no record of a staging app on the DigitalOcean droplet, so staging may not exist any more.
  - I can't tell which commit any staging runs today, or whether the Vercel preview (#546) still runs.
- **CI** ("Verify Particl") passed on f59d853f (8 Oct). CI uses mocks and local databases, too.

## 2. What it changes in production's databases

There is no migrations folder. Each database builds its own schema in code the first time it is used (`CREATE … IF NOT EXISTS`, additive `ADD COLUMN`).

**Additive, and main ignores it (safe to keep after a rollback):**
- **New tables:**
  - `api_token_grants`
  - `sample_lifts`
  - `identity_consents`, `consent_recordings`
  - `prepared_jobs`
  - `review_link_scopes`, `review_verdicts`, `review_link_hits`
  - `rig_plan_approvals`
- **New nullable columns:**
  - `atomik_messages.ledger`, `atomik_spend.ledger`
  - `generations.refine_ledger`
  - `meter_events.hold_band`, `meter_events.overrun_usd`
  - `paid_text_jobs.reconcile_lease`
  - `astra_render_jobs.claimed_at`
  - `upload_sessions.failure`
- Nothing is dropped or renamed, and no default changes.

**Rewrites existing rows automatically, on the first cron run** (every 10 minutes after the deploy). A rollback cannot undo these:
- **Paid text** (`reconcilePaidTextJobs`, lib/paidText.ts): every `paid_text_jobs` row that is `queued`, `running` or `uncertain`, has no response and is older than 30 minutes is marked `refunded`, and its meter event fails, so the credits come back. That includes rows main left behind.
- **Cinema** (`cinema_unanswered`, lib/genjutsuVideo.ts): Cinema Studio takes unanswered for over 24 hours, old ones included, are failed with `cost_usd=0`, their hold is released and they are settled.
- **Connected-account collection is off:** Higgsfield jobs still in flight on connected accounts are no longer collected.

**Rewrites rows when used:**
- Opening a client workspace mirrors the platform owner into its `users` table as "Particl support" (lib/platform.ts). This stays after a rollback.
- An owner-privacy scrub exists in admin. It runs a dry run first, and once applied it can't be undone.

**JSON inside project rows: the main rollback hazard.**
- `release/1` saves `production.blocking` and `production.boards.looks`/`look` into project bodies.
- Main's schema for those objects is `.strict()`. Once a project holds them, **main refuses to save that project**, and Atomik's parse of it fails.
- `scripts/ops/strip-production-blocking.mjs` strips only `blocking` and `scriptVersions`. Nothing strips `looks`.
- Prerequisite 1 fixes this before the date. Main learns the new fields as optional, so a rollback just works.

## 3. Switches that keep things off for customers

**The new interface has no switch.** It was removed on purpose ("every screen shows for everyone", d43fe250), and main's `?shell=legacy` escape is gone too (docs/workspace-switchover.md). On deploy, every customer gets all of the following at once:
- the new Home, the board canvas, the Make and Atomik panels and ⌘K;
- the Control room;
- the five-section Settings;
- the phone bar and phone review;
- autosave;
- review links with verdicts;
- the old stage pages turned into redirects, with `/business`, `/viral` and `/workspace` answering 308.

**What does have a switch:**

| Switch | Default | Where | Note |
|---|---|---|---|
| `openSignup` | **off** | /admin → site settings | **Behaviour change:** main opens self-serve sign-up whenever Turso, mail and billing are configured. On `release/1` sign-up needs an invite until this is on. Check what production does today and set it to match *before* the deploy. |
| `guestHome` | off | /admin → site settings | |
| `HF_CINEMA_STUDIO_ENABLED` | on | env | `0` hides Cinema Studio |
| `ASTRA_RENDER_BACKEND`, `TEXT_DIRECT`, `MODEL_CATALOG` | today's behaviour | env | Opt-in, all optional |

**Changes to existing customer workflows, with no switch:**
- Identity training now **requires a consent record**, and is refused for API tokens.
- Collection of connected-account jobs stops.
- A token with any scope other than `render` now reads as read-only (before, anything but `read` counted as `render`).

**Option for prerequisite 4:** a site setting `newInterface` (on by default for admins and the internal workspace, off for customers) that falls back to the old pages. This needs the old shell restored behind it, so it is real work, not a flag flip: estimate several days plus its own review. The alternative is to accept all-or-nothing and rely on the soak.

## 4. Smoke tests

**Safe against production (no spend, no sign-ups):**
- `ops/selfhost/smoke.sh https://particl.si`: 9 GET checks, never signs in.
- `/api/health`: `ok`, and `commit` equals the release candidate's short SHA.
- `/api/admin/readiness?billing=1` (super-admin): configuration and probes, including the Inngest worker probe receipt.
- `/api/health?deep=1` (super-admin): writes one small probe object to storage, with no generation spend.
- The manual post-switch checklist in docs/selfhost-test.md (sign in, open a workspace, upload, Library plays, cron-sync 200).

**Owner-run (small real spend, internal workspace only):**
- One cheap still and one short video through the Make panel.
- Check: settled, stored (`stored_url` set), billed once, and the at-risk count is 0.

**Not for production:** the five-minute and customer Playwright configs (they need mocks and sign people up) and `scripts/ops/staging-rehearsal.mjs`. These run on staging.

## 5. Staging and soak

1. **Freeze a release candidate.**
   - Merge what is open (#606, #607, #608, the at-risk alert, the reference-upload limit), then tag `r1-rc1`.
   - Nothing else lands on it except fixes found during the soak, and each fix makes a new rc.
2. **Staging on the droplet's Coolify,** as a second app beside production, with its own domain:
   - **Databases:** Turso branches (copies) of production's platform database and of every workspace database, taken at one point in time. That is production-shaped data with no effect on production. It needs the owner's yes and a Turso token decision.
   - **Isolation:**
     - `ENGINE_MOCK=1`.
     - **Mail off**: staging must never email real customers from copied data.
     - Stripe test keys or off.
     - Its own Inngest app.
     - A staging R2 bucket. Objects that copied rows point at are read-only, or are missing, and that's acceptable.
   - **Process count:** `WEB_CONCURRENCY` as production will have it (3), because Turso doesn't have the SQLite lock problem.
3. **On the first staging cron run,** record exactly what the money sweeps change:
   - paid-text rows refunded, with their credits;
   - Cinema takes failed;
   - connected jobs dropped.

   This is the evidence for prerequisite 3.
4. **Soak for 7 days,** with at least 3 working days of real internal use.
   - **Daily:**
     - smoke.sh, readiness, and the customer and five-minute Playwright configs against staging;
     - cron-sync 200 every run;
     - no 5xx in the logs;
     - at-risk 0;
     - memory within limits;
     - `recovery_activities` with nothing `uncertain`.
   - **Once:**
     - open, edit and save the 20 largest copied projects;
     - roll staging back to main + rollback-compat, check those projects still save, then roll forward again.

   This rehearses the rollback.
5. **Exit:** 7 clean days, the rollback rehearsal passed, and the owner's answers to prerequisites 3 and 4.

## 6. Cutover (the day)

1. **Before:**
   - Announce a window.
   - Confirm main + rollback-compat is live on production and has been for at least a day.
   - Record the time, for a Turso point-in-time restore if needed.
   - Export the platform database.
   - Set `openSignup` to match today.
2. **Deploy:** merge `r1-rc1` into main, then the owner clicks Deploy. Re-sync Inngest at `https://particl.si/api/inngest`.
3. **Within 15 minutes:**
   - the safe smoke tests in §4;
   - the health commit equals the rc;
   - the readiness worker probe succeeds;
   - the owner's cheap still and video.
4. **Watch 24 hours:**
   - logs, memory, cron-sync;
   - the at-risk alert;
   - support email;
   - the first cron run's money-sweep log lines match the staging numbers.

   The rollback decision window is these 24 hours.

## 7. Rollback

- **Code:**
  - Coolify **Rollback** tab → the previous image (main + rollback-compat). This takes seconds.
  - Then re-sync Inngest.
  - Inngest function ids are the same on both, so no run is stranded by a rename. A run sleeping mid-`step.sleep` (Astra) may not resume correctly on main. Check the Inngest dashboard and re-run anything stuck.
- **Schema:** nothing to do. New tables and columns are ignored by main.
- **Project JSON:** handled by rollback-compat. Without it, strip `blocking` with the existing script and `looks` with an extended one, and expect some projects to be unsaveable until stripped.
- **Can't be undone, and should be accepted in advance:**
  - money-sweep refunds and failures, with their ledger rows;
  - "Particl support" user rows;
  - consent and prepared-job rows (unused on main);
  - emails already sent;
  - browsers' cached 308 redirects for `/business`, `/viral`, `/workspace` and `/site/*`, which persist until the browser drops them.
- **Restoring data** instead (last resort):
  - Turso point-in-time restore (30 days on Scaler) has no tooling here.
  - It means repointing every workspace's sealed database address and token, losing every write after the restore point, and signing everyone out.
  - The nightly encrypted backup isn't live yet. Making it live is worth doing before the date.

## Risks, most severe first

1. **Never tested on Turso or production data.** Staging was SQLite with one workspace, 213 commits ago. §5 fixes this.
2. **A rollback leaves projects main can't save** (the strict `production`/`boards` schema). Prerequisite 1 fixes this.
3. **The first cron run refunds and fails existing money rows,** and that can't be undone. Prerequisite 3 measures it first.
4. **The new interface is all-or-nothing for customers.** There's no switch and no legacy escape.
5. **Self-serve sign-up may close silently** (`openSignup` defaults to off).
6. **No live automated backup.** Data recovery is Turso point-in-time restore plus manual repointing.
7. **Changed customer workflows:** consent is required for identity training, connected-account collection stops, and token scope reads stricter.
8. **Inngest Astra runs that sleep across the deploy or a rollback** may need a manual re-run.
9. **Persisting side effects:** the "Particl support" mirror rows and cached 308s.
10. **The release keeps moving.** Freeze the rc before staging it, or the soak proves nothing.

## What it needs from the owner

- **Yes/no:** Turso branch copies of production for staging, plus the token decision.
- **Yes/no:** build rollback-compat for main now. It's small, and the lead recommends it.
- **After the staging numbers:** allow the money sweeps, or ship with them off at first.
- **The interface:** all-or-nothing, or build the `newInterface` switch first.
- **The date.**
