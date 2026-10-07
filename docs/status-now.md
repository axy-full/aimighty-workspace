# Status now: 8 October 2026, 03:23 IST, Release 1 lead moved to "contabo"

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. **Owner, 18:45: move off Vercel today if possible.** Report on Vercel dependencies, env names, sign-in/URL needs, the particl.app redirect and Nixpacks sent in chat. The sign-in fix is in release/1 for the owner's test (applies to main too; main only on the owner's go). Before production: the public-link fix (running), AI_GATEWAY_API_KEY, the VERCEL_ENV guards, Traefik's read timeout. The reported home-page loop was not reproduced on main or release/1 and is withdrawn; a loop on the test address would come from a layer in front of the app.

**Demo postponed (owner, about 17:30 IST); no date yet. The Thursday merge train is cancelled. Nothing merges to main and nothing deploys to production without the owner's "go".**
Order of work: (a) CI on `release/1` fully green; (b) finish the Thursday list's AT RISK and WON'T MAKE IT items, with an estimate per item; (c) move prep for Coolify on a test address, files only. Then a proposed demo date and the `release/1` → main plan.

**Lead:** the session on "contabo" took over from the "vps" session at about 15:50 IST. Deny rules checked: `git restore` and `docker ps` are both refused.
**Integration preview:** `release/1` (draft #546) = 60bf3fe4. The preview is mocked: no engine keys, ENGINE_MOCK set. The preview runs on the staging databases.

## In `release/1` since 15:00
- 3D blocking part B (`build/gaps-l2` 44cda874, Opus PASS; owner yes to Q7: staging only, production only in a later train after a Turso backup branch).
- `fix/r1-ci-worker-probe-env` (Opus PASS).
- Workspace switch (tenancy; four review rounds, PASS): switching saves every editor's pending edit first (board, team canvas, Edit & Sound), freezes edits behind a veil, then switches; a failed save switches nothing. Main needs the owner's yes. Customer test 3 can be deleted on the owner's go.
- `chore/r1-old-shell-branches` (PASS): the old Business/Crew/Inspector/Library screens and ~150 unreachable files are cut; every old address proved to redirect.
- Five-minute test + phone review Undo (PASS): passes on desktop and phone; approving the last take on the phone keeps its Undo. Phone tap budget 9 pending question 13.
- `fix/r1-production-deployment-flag` (Opus PASS): off Vercel, `PARTICL_DEPLOYMENT=production|staging` replaces the VERCEL_ENV guards; Vercel identical. Main port: **draft PR #562, reviewed, waits for the owner's go.**
- `ops/selfhost-runbook-cutover` (four review rounds, PASS): `docs/selfhost-test.md` is the owner's runbook: staging with fresh empty databases (do `/setup` right after deploy); production specifics (R2, Inngest with `INNGEST_STREAMING=true` and re-point steps, mail, AI Gateway, Astra sandbox stays on Vercel); exact Traefik timeout lines; cutover order with the hPanel firewall limited to Cloudflare, Full (strict) with an Origin Certificate, Bot Fight Mode off, rollback.
- `fix/r1-d0-check` (Opus FAIL, fixed, delta PASS): D0 shell checked at five sizes (57 screenshots). Jobs pill stays on an empty tray; Library-drawer takes open the asset menu and select themselves; right-click Recreate priced from the server and disabled in the sample; Delete goes to trash with Undo.
- `chore/r1-dead-old-pages` (Opus FAIL, fixed, PASS): 155 unreachable old source files and 22 old specs deleted; ratchets only lowered.
- `fix/r1-blocking-float` (PASS): the last CI failure.
- `fix/r1-ci-make` (two fix rounds, delta PASS): Make composer specs ported; no price shows while a recipe's references load; Takes chips readable (Cinema's "at most 3N" whole); a draft's final runs to success in an API test.
- `fix/r1-client-ip-behind-proxy` (PASS, delta PASS): behind the proxy, rate limits key on the address the proxy saw, never a visitor-set header; Vercel unchanged. Needs the Cloudflare-only firewall before cutover.
- `admin/workspace-cap-field` (two mediums fixed, delta PASS): "Particl demo" cap set by the platform owner in /admin; every paid path refuses at the hold; desk shows engine dollars only. Main needs the owner's yes.
- `fix/r1-ci-settings` (Opus FAIL, fixed, delta PASS): Settings, credits and retired-account specs ported; no vendor dollars anywhere a customer looks; phone Home bar fits; workspace rename holds.
- `fix/r1-review-lows` (Opus PASS after one fix): the sample hides "price pending"; the spend audit only skips marked navigation buttons and checks each tool's own priced button; the phone Make shows a failed press; landscape phones get 44 px targets; old "save first" messages reworded.
- `fix/r1-public-origin-links` (Opus PASS): reset, invite, sign-up and top-up links are never built from request headers and fail closed on a self-hosted server without APP_ORIGIN; review, share, MCP and OpenAPI links use the public address. Vercel unchanged.
- `money/r1-make-stale-claim` (Opus FAIL, reworked, delta PASS; owner yes): a tab that lost its reply checks that request first and sends nothing if it landed; changed words always send. Found by the CI lane: before this, video sent one extra paid request, image batches the whole batch again, audio one extra.
- `fix/r1-signin-behind-proxy` (Opus PASS; owner yes: release/1 only): behind the proxy, `SELFHOST_BEHIND_PROXY=1` makes every origin check accept exactly APP_ORIGIN; Vercel unchanged. **The owner checks it on the test address next** (https; steps in `docs/selfhost-test.md`).
- PR #561 `ops/selfhost-test-address` (Opus FAIL on the runbook: a plain platform copy names production workspace databases; fixed; delta PASS): Dockerfile, standalone output behind a flag, cron-sync, smoke test, runbook with the staging-set and keyring rules, a check of every workspace address before the scheduled task, Build Variable only on NEXT_PUBLIC_*, the particl.app redirect and DNS for all four names, and what changes when production leaves Vercel.
- `fix/r1-ci-board` (Opus PASS): board, phone, Guest Home off, palette, sample workspace, spend buttons; phone fault buttons 44 px.
- `fix/r1-blocking-sample-remake` (Opus PASS): the sample no longer offers 3D blocking's priced Remake. Optional polish queued: hide the disabled "price pending" button too, and a rendered test.
- Platform-owner privacy (`fix/r1-platform-owner-private`, delta review PASS) and its follow-up (`fix/r1-owner-privacy-followup`).
- `fix/r1-ci-privacy-tests` (Opus PASS): the 3 failing unit tests fixed in the tests only. Cause: `workerProbe.spec.ts` leaves `VERCEL_ENV=preview` set for every later spec, so the guard rightly refused. The guard is unchanged and safe on production.

## CI on `release/1`
- No full CI run has finished since yesterday: each merge cancelled the run before it. Run 37604935678 on 3ca30197 is the first to run through.
- Run 37604935678 on 3ca30197 finished red: 3 unit tests and about 240 browser tests (35 spec files).
  - unit: 3 tests in `platformOwnerPrivacy.spec.ts`. The follow-up's new "production only" guard refuses the tests' local run (they don't set the opt-in).
  - browser: mostly specs still driving the old Gen composer, the old Workspace pane and the retired connected account; plus money specs (no vendor dollars, credit value on phone, batch takes, recovery race, spend buttons) that must be ported, never dropped.
- Run 37615298051 on ac03f878: all 3 unit shards green (first green unit run on `release/1`); browser shards still running.
- On "contabo", 3ca30197: typecheck clean; unit 3,950 passed, 3 failed (the same three), 7 skipped.
- CI on 0ce3c338: 19 of 20 jobs green (all unit); one browser shard hung. Everything reviewed tonight is now in `release/1` (48193cc4); its CI run is going.
- `bundle.spec` (a stale test after the old-screen cut; no live price path was lost; reviewed PASS) now proves the browser asks the server's quote routes and holds no vendor rate in any form. In `release/1` 60bf3fe4; its CI run is going.
- Fix lanes running since 16:20, one branch each, merged into `release/1` only after a fresh review (Opus where money, sign-in or tenancy):
  - `fix/r1-ci-make`: the Make composer specs (prices, batches, model picker).
  - `fix/r1-ci-settings`: Settings, credits, no vendor dollars, retired connected account.

## Staging build
The `.dockerignore` fix is in `release/1`: staging can build from `release/1` again.

## In flight
| Branch | State |
|---|---|
| Hotfix PRs to main (owner yes; merge only on "go") | **All five reviewed PASS, ready for the owner's go:** #563 sign-in behind the proxy → #564 public links (after #563) → #565 rate limits → #562 production flag. **#566 self-host build files** (Docker build fix included, PASS) |
| Release 1 remaining list | sent: `docs/r1-remaining.md` (this branch). Owner: list B in, list C out |
| image-ad variants and presets | No frame in the handoff (only one card, one Make at 3 cr). Nothing built. Brief for Claude Design: `docs/design-brief-image-ad-versions.md` (this branch). Logic already in code |
| `fix/r1-blocking-sample-remake` (on top of B) | the sample hides Remake's priced button; building |

## Owner's answers (23:55)
Main smoke-built with Railpack on the server (200), stopped until the hotfixes are on main. Staging = https://staging.particl.si. particl.app already on Cloudflare (only the redirect). YES to small reviewed hotfix PRs to main, merged on "go". Owner creates AI_GATEWAY_API_KEY. A code change replaces the VERCEL_ENV guards. Exact Traefik timeout lines and the full cutover order (orange cloud, Full (strict), origin certificate, Cloudflare-only firewall, rollback) go in the runbook. Demo cap: $0, 100 cr grant only on "run", Atomik text counts, no "cheap engines". Image-ad versions and Atomik's idea draft: out of Release 1. Customer test 3: port its two checks, delete on "go".

## Owner's answers (17:40)
Scope: list B in (image-ad variants; phone gets "Open this on a larger screen" now, frames later); list C out. Stale-tab fix: yes. Q7: yes. Dunes: v4 at 233 cr in "Particl sample"; "Particl demo" for live presses only, capped at 100 cr, cheap engines only; nothing generates without the owner's "run". Price check on production after a merge. Sample lift ends with the run. Privacy rewrite: yes after the owner sees dry-run counts and a Turso backup copy. Q4/Q5: yes.

## Waiting on the owner
1. Yes before main on the reviewed work already in `release/1`: #556 money states, #540/#559 Cinema, sample paid-off, old pages (#558 has its yes).
2. Customer test 3 (`tests/customer.spec.ts:568`, skipped because it drives the old shell): checks that an unsaved project edit is saved in the current workspace before a workspace switch, and that a refused switch leaves the project editable. Recommended: port these two checks to the new switch in Settings › Team, then delete the old test. Delete on the owner's "go".

3. Self-hosted test address: it needs staging copies of the platform and workspace databases and a staging Blob store. The test address keeps the cron off, so it doesn't run beside Vercel's.

4. Image-ad versions and presets: no design frame exists. The brief for Claude Design is `docs/design-brief-image-ad-versions.md` on this branch. Draw it, or drop the item from Release 1?

5. Atomik's idea draft (a paid 2 cr write; nothing in the app calls it now): does it come back in Release 1, and where (a board card or Atomik's sheet)? Recommended: not in Release 1; its old race test stays marked as waiting.
6. Found while fixing: the phone's Make shows nothing when a press fails. A UI fix is queued (list A).

7. "Particl demo": the cap counts engine dollars, not billed credits, so the real 100 cr wall is a 100 cr credit grant (with the engine cap alongside). Keep the cap at $0 and raise it only on your "run"? "Cheap engines only" doesn't exist yet: a per-workspace engine list needs a platform database migration (your yes), about 1–1.5 days. Do Atomik's text models count too?

8. Make's "Draft first": a draft's 1080p final has no button anywhere in Release 1 (it lived on the old Inspector). Put "Make the 1080p final · N cr" on the draft's Recent card (recommended), or hide "Draft first" until it has a home, so nobody pays for a draft whose final can't be reached?
9. Make's words box takes no paste, drop or Attach (the 25 September rule says every prompt box takes media). Add it (recommended; no money), or exempt Make?
10. A sent take no longer announces when it lands (Make closes on send). Bring the announcement back from the jobs tray (recommended, not blocking)?

11. Right-click menu: write "free" on the free items? (The design doesn't; left as drawn.)
12. The public site's nav says Studio · Ads · Social while the app calls them templates: change it?

13. Five-minute test, phone taps: the real phone path takes 9 taps; the old budget of 7 never counted Start. Accept 9 (matches desktop), or keep 7 and change the phone to stay on the plan screen after Build (saves one tap; plan-approval money code, its own reviewed change)?

14. Cloudflare cuts a proxied request that sends nothing for about 100 s. Upload "finish" (assembling files up to 2 GB) will fail on large files once particl.si is behind Cloudflare. Options: upload straight to storage (recommended; a build item), Cloudflare Enterprise timeouts, or an unproxied upload address (conflicts with the Cloudflare-only firewall). Which?
15. The old platform gates (R2 on, self-hosted Inngest, the 1,000-job load test, 12 staging smoke checks incl. a paid run, credit switchover on Vercel first): keep them before cutover, or waive some explicitly?

16. The old 3D render panel is gone with the old Inspector, so the paid 3D render route has no screen. Does a 3D render panel come back? If yes, its money-recovery tests need a home before it is paid.
17. Workspace switch: fix it to wait for the unsaved edit (recommended; tenancy, reviewed), then port customer test 3's checks onto it and delete the old test on your "go"?

18. (Update: no code change needed: `INNGEST_STREAMING=true` on production keeps long steps alive through Cloudflare; verify on the first long run after cutover.) Background steps longer than Cloudflare's ~100 s (Astra render finish up to 165 s, dubbing polls, still/audio render, Atomik steps) would be cut (524) and retried once particl.si is behind Cloudflare: try Inngest's streaming mode (small reviewed PR, tested on staging; recommended), Cloudflare Enterprise, or an unproxied Inngest address (conflicts with the firewall)?

19. **3D (Astra) renders in Release 1 (High):** release/1 has had no screen to start or follow a render since 5 Oct (old `page=astra` addresses redirect to the board, decision 42); production (main) still has the panel and renders are in active use. Server side (quote, approval, paid route, tests) is intact. Recommended: bring the render panel back alone in a board drawer (restored from git; no "GPT-6 Astra"), with the two "3D blocking → Open" links pointing at it. The handoff has no frame for it: build it as described, or have it drawn in Claude Design first?

## Machine
GitHub rejected every push from about 20:33 to 20:47 and again from about 22:20 to 22:30 IST ("fatal error in commit_refs", GitHub's side); nothing was lost.
