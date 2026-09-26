# Particl — takeover handoff and SOW (26 Sep 2026, ~21:00 IST)

Everything a new Claude account needs to pick this work up from exactly where it stopped. Read §1–§3 before touching anything, then work through §9 (the SOW) in order.

- **Repo:** github.com/axy-full/aimighty-workspace. It is **public**, so CI runners cost nothing.
- **Production:** www.particl.app. The Vercel project is `particlstudio`, and it auto-deploys `main`.
- **main at handoff:** `6d7f438c` (Merge #365).
- **State of this session:** nothing is running. Both workflows, every agent, all CI watchers and every dev server were stopped on purpose, and all committed work is on GitHub (§5, §6).

---

## 1. Owner's standing rules (binding)

**Money and spending**
- Every paid provider test needs a stated spending ceiling, and a previous approval is not a budget.
- Anything that posts publicly or deploys a site needs an explicit confirmation on top of the price approval.
- Never trigger generations against customer workspaces. Local work runs `ENGINE_MOCK=1` with mocked routes only.

**Secrets, accounts and data**
- Never rotate `KEYRING_SECRET`.
- Never create a Vercel project, GitHub org or Inngest org.
- Don't handle secret values: keys stay sealed and are never returned to the browser. The owner never types passwords for you.
- **Never delete team data.** Deletes hide or archive only (`lib/archive.ts`), and data is kept indefinitely.
- Particl is standalone: never list or reuse the higgsfield.ai site's own characters, media or generations. The connected account is an engine, not a library.
- Browsing the owner's Higgsfield account is read-only: no generations, no spend, no edits. Never solve CAPTCHAs.

**Code and tests**
- Extend the existing `/api` routes and `lib`; never rebuild them.
- Never use serif fonts.
- Never hard-code `/private/tmp` paths in a spec. Screenshots are opt-in through an environment variable (see `VIRAL_SHOTS` in `tests/hf-viral-real-runs-workbench.spec.ts`).
- `CLAUDE.md` / `AGENTS.md` ground rules:
  - tenant isolation;
  - no client or person names;
  - one vocabulary (Takes / Productions / Generate);
  - five viewports (360x640, 390x844, 844x390, 1440x900, 1920x1080);
  - no horizontal overflow;
  - targets of at least 44 px on phones;
  - small PRs; prose is a cost.
- Next.js 16.3.5 is not the Next you know. Read `node_modules/next/dist/docs` before using an unfamiliar API. It uses `proxy.ts`, not middleware.

**Git and merging**
- Commit author must be `axy-full <275056119+axy-full@users.noreply.github.com>`, or Vercel silently blocks the deploy. End every commit with `Co-Authored-By: Claude …` and every PR body with the Claude Code line.
- **Never merge red. Never use `--admin`.**
- Merge with `gh pr merge <n> --repo axy-full/aimighty-workspace --merge`, run as a standalone command. This repo uses merge commits.
- The owner's standing approval: "merge and deploy as and when they become green", for this effort's PRs.
- PRs opened by other sessions (#371, #372) have **not** been merged. Confirm with the owner first.

**Agents**
- At most **15 agents at once**, counting workflow agents and background agents together.

---

## 2. Environment and tooling

**Where things live**
- **Checkout:** `/Users/axy/Documents/Codex/2026-09-13/vercel-plugin-vercel-openai-curated-remote-4/work/` holds one git worktree per branch. `glass` is the usual base for new worktrees: `git -C work/glass worktree add ../<name> -b <branch> origin/main`.
- **node_modules:**
  - For a webpack dev server: `ln -s ../glass/node_modules node_modules`.
  - Turbopack panics on a symlinked `node_modules`. Clone it instead: `cp -cR ../glass/node_modules ./node_modules` (an APFS clone, 7 s, no extra disk).
- **public/vendor** is gitignored and needed by the OCR unit specs. Copy it from `../glass/public/vendor`, or run `node scripts/copy-ocr-worker.mjs` and `node scripts/copy-pdf-worker.mjs`.
- **Local handoff folder (not in git):** `work/HANDOFF-2026-09-26/`. It contains:
  - `reports/higgsfield-notes.md` — the Higgsfield reference study. Kept out of this public repo on purpose.
  - `reports/audit.json` — the full audit, 257 findings.
  - `reports/audit-groups/`, `reports/ideas/`, `reports/final/`, `reports/prior/` — every workflow report.
  - `workflow-scripts/` — the three Claude workflow scripts: audit fix groups, Higgsfield ideas, and the drafts three-way merge.
  - `dev-scripts/` — one dev-server script per worktree.
  - `ci-scripts/watch-prs.sh` and `ci-scripts/rerun-when-done.sh`.
  - `mem-spike/` — the reproduction scripts and every memory log from §7.
  - `memory/` — a copy of the previous account's project memory. `particl-production-suite.md` is the long day-by-day log.

**GitHub**
- The `gh` CLI is signed out. Get a token from the git credential store:
  ```bash
  export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | awk -F= '/^password=/{print $2}')
  ```
- zsh gotcha: in `"$b:refs/heads/$b"`, `$b:r` is a history modifier. Write `"${b}:refs/heads/${b}"`.

**Dev server pattern**
Each worktree has its own port and its own database directory:
```bash
cd <worktree>
export ENGINE_MOCK=1 APP_ORIGIN=http://localhost:<port> PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/<name>/platform.db TURSO_DATABASE_URL=file:/private/tmp/particl-suites/<name>/legacy.db
exec ./node_modules/.bin/next dev --webpack -p <port>
```
- `/private/tmp` is wiped on reboot. That's fine for test databases, but keep scripts in the handoff folder.
- Ports used so far:

| Port | Worktree |
|---|---|
| 4790 | glass (drafts) |
| 4841 | hf-gen |
| 4842 | hf-jobs |
| 4843 | hf-takes |
| 4844 | hf-workspace |
| 4845 | hf-shell |
| 4846 | hf-connected |
| 4847 | hf-atomik |
| 4848 | hf-agents |
| 4862 | pr365 |
| 4863 | pr364 |
| 4864 | pr366 |
| 4865 | pr368 |
| 4867 | pr367 |
| 4868 | pr376 |
| 4869 | pr377 |
| 4891 | mem-spike |

- Stop servers by PID, never with `pkill` by name: other sessions run dev servers too.

**Running specs locally**
`cdn.playwright.dev` is blocked, so use installed Chrome:
```bash
PW_CHANNEL=chrome PW_BASE_URL=http://localhost:<port> PW_PLATFORM_DATABASE_URL=file:/private/tmp/particl-suites/<name>/platform.db \
  ./node_modules/.bin/playwright test --config=playwright.workbench.config.ts <spec> --output /private/tmp/particl-suites/<name>/pw-x
PW_BASE_URL=http://localhost:4999 ./node_modules/.bin/playwright test --project=unit            # unit project, no server needed
./node_modules/.bin/tsc --noEmit -p . && ./node_modules/.bin/eslint <files>
```
- Sign in with `tests/helpers/workbenchLocal.ts` `signInLocally`.
- Browser specs open the live SQLite databases with `createClient({ url, timeout: 10_000 })`. Keep that busy timeout (#378).

**CI** (`.github/workflows/verify.yml`)
- **Jobs:**
  - `unit`: 3 shards;
  - `core`: npm audit, lint, the ops rehearsals, `scripts/account-http-rehearsal.mjs`, `next build`, bundle privacy;
  - `browser-shards`: `{workbench, customer} × 12`, Turbopack `npm run dev`, a 30-minute timeout, with the `[resources]` monitor printing memory every 30 s.
- **Required checks:** `browser (workbench)` and `browser (customer)`.
- **Shards take contiguous runs of test files** (project-major, then file name). A spec that tours many heavy pages kills whichever shard holds it (§7).
- Re-run only the failed jobs of a finished run: `gh run rerun <run-id> --failed --repo axy-full/aimighty-workspace`.
- `ci-scripts/watch-prs.sh <pr…>` prints GREEN or FAILED per PR.
- `ci-scripts/rerun-when-done.sh <pr> <run-id>` waits for the run, re-runs failed jobs once, and reports.
- To read a failed shard:
  ```bash
  gh api repos/axy-full/aimighty-workspace/actions/jobs/<job-id>/logs | grep -E "✘|shutdown signal|[resources]"
  ```
  Failure artifacts (`browser-failure-<suite>-<shard>`) contain `dev-ci.log` and the traces.
- **Known flakes:**
  - `management-scope.spec.ts:6` on a cold dev server;
  - the `color-workbench.spec.ts:96` LUT pixel read at 390;
  - `workspace-switchover` "bare old URL".
- **Fixed in this effort:** SQLITE_BUSY (#378), 43.99997 px targets (#381), the recovery-codes race (#379).

---

## 3. What landed (merged to main, auto-deployed by Vercel)

| PR | What |
|---|---|
| #351 | Public marketing site: seven pages on the Graphite theme, served by `proxy.ts` at `/`, `/studio`, `/business`, `/viral`, `/atomik`, `/workspace` and `/pricing` for visitors |
| #352 | Gen pipeline audit fixes: refunds for refused renders, no stuck jobs |
| #353 | Storage audit: iPhone review playback, audio uploads, whole archives |
| #354 | Suites shell audit: no stranded paid jobs, working Retry and Library |
| #355 | Workbench lib audit: Atomik recovery, phone JPEGs, 4,000-node limit |
| #356 | CI flakes: preview focus steal, busy test databases |
| #357 | Half-made sweep: Workspace tabs, Atomik gate, shell |
| #358 | Other UI audit: money, dead ends, hand-offs |
| #359 | Higgsfield-consumer audit: free stuck slots, keep jobs across reconnects |
| #360 | Idea 11: Business uses only Particl's own picks, and "Use in Image ads" works |
| #361 | Suites Atomik UI audit: real prices, capped Continue |
| #362 | Astra upscale spec race |
| #363 | Studio API audit |
| #364 | Workspace lib audit: recover connected renders, per-project undo, honest retries |
| #365 | Identity and admin audit: restorable deletes, safer invites, authenticator reset. Also adds `SUPER_ADMIN_EMAIL=platform-owner@example.test` to CI, `tests/account-identity.spec.ts` and `tests/platform-desk.spec.ts` |
| #366 | Idea 8: Gen model sheet with search, Recent, spec chips and a price on every row |
| #369 | Workspace UI audit |
| #370 | Money audit: credit prices, full statements, hidden takes stay spent |
| #373 | Atomik, crew, cast, rules and MCP audit |
| #374 | Workbench UI audit |
| #378 | Tests: a 10 s busy timeout on every browser spec's database client |
| #379 | CI: 12 browser shards per suite, and the security spec waits for recovery codes. A webpack CI server was tried and reverted; see the PR body |
| #380 | Other-engines audit: Grok voices, xAI refusals, one-megapixel squares, bounded ElevenLabs listing |
| #381 | Tests: 44 px checks round sub-pixel noise (`Math.round(h*100)/100`) |

Of the 18 audit fix groups, 16 are merged. **Still open:** `app-pages` (#375) and `drafts` (branch `fix/rig-leave-save`, §6).

---

## 4. Open PRs: state and exact next step

| PR | Branch → base | Head | CI at handoff | Next step |
|---|---|---|---|---|
| #367 | `feat/hf-connected-jobs-finish` → main | `86b633bd` | 25 passed, 5 pending | Main was merged by an agent, which reconciled idea 2 with #364's connected-job model. Watch CI and merge when green. Then do #377. |
| #377 | `feat/hf-polling-backoff` → `feat/hf-connected-jobs-finish` | `2f9c71ef` | No CI (base isn't main) | Idea 16. It holds a committed merge of #367's updated branch. The agent was stopped while **rewriting the browser spec for the collector-fed model**, so check `git log` and `tests/hf-polling-backoff-workbench.spec.ts` and finish that. After #367 merges: `gh pr edit 377 --base main`, merge main, run tsc/lint/unit/specs, push, wait for CI. |
| #368 | `feat/hf-viral-real-runs` → main | `341bee97` | Failed workbench shard 1 | The failure is the 43.99997 px flake, which main fixed in #381. **Merge main in** (clean) and push. |
| #376 | `feat/hf-recreate-recipe` → main | `7e601db9` | Failed workbench shard 1 | Idea 7. A **real failure**: `tests/hf-recreate-recipe-workbench.spec.ts:289` "a gone first reference: the words are renumbered to the well…" fails at **360x640** with `card rows hidden`. The Recreate card's rows are hidden on the smallest phone. Fix it, merge main, push. |
| #375 | `fix/audit-app-pages` → main | `e83a6871` | Failed workbench shards 1 and 8: **runner shutdown at 14 GB** | Its audit spec is now seven files with spread-out names. The shutdowns are the dev-server memory problem in §7. Either fix §7 first, or re-run the failed jobs until they pass. |
| #371 | `fix/upload-stream-abort` → main (another session) | `fbc7aa33` | 24/24 green | Fixes the uncaught `AbortError` in `openUploadStream` when a viewer leaves; §7 confirmed the same bug independently. Recommended, but **ask the owner before merging**. |
| #372 | `fix/held-est-usd` → main (another session) | `18f6c597` | 24/24 green | A held take shows credits, never vendor dollars. **Ask the owner before merging.** |

---

## 5. Higgsfield-benchmark ideas (28)

The specs are in `ideas/idea-NN.json`: title, area, the gap with file:line evidence, the target experience, likely files, priority and effort. They were built in 8 tracks of stacked branches, one worktree per track (`work/hf-<track>`).

| # | Idea | Status | Branch |
|---|---|---|---|
| 0 | Gen saves over the latest project, not a stale copy | Covered by the drafts redesign (§6) | `fix/rig-leave-save` |
| 1 | Jobs tray instead of a one-slot pill | **Built and reviewed.** Both reviews say fix-first: 17 issues, 7 major. See `reviews/idea-01-*` | `feat/hf-jobs-tray` @`03a0d8fa` (stacked on #377) |
| 2 | Connected jobs finish after the user leaves | PR #367 | `feat/hf-connected-jobs-finish` |
| 3 | Takes 2–4 as one priced batch | Not started. **Build it after the drafts redesign merges.** | — |
| 4 | A way out when credits run out | Not started | — |
| 5 | One card contract (skeletons, status, reasons) | Partial, from a pre-crash build | `feat/hf-card-contract` @`3ee685cf` |
| 6 | Takes as the review desk | Not started | — |
| 7 | Recreate carries the full recipe | PR #376 | `feat/hf-recreate-recipe` |
| 8 | Model picker with search, chips and price | **Merged** #366 | — |
| 9 | Approve Atomik runs inside /suites | Not started | — |
| 10 | First run that teaches | Not started | — |
| 11 | Business standalone pickers | **Merged** #360 | — |
| 12 | "Next" actions on every take | Not started | — |
| 13 | Film vocabulary as prompt tokens | **Built and reviewed.** Both reviews say fix-first: 15 issues, 4 major. See `reviews/idea-13-*` | `feat/hf-film-vocabulary` @`39c315e4` (stacked on #376) |
| 14 | One-click priced buttons in stages | Not started | — |
| 15 | Typed errors, one next step each | Not started | — |
| 16 | Polling with backoff and jitter | PR #377 | `feat/hf-polling-backoff` |
| 17 | Viral shows real runs; Send to Edit | PR #368 | `feat/hf-viral-real-runs` |
| 18 | Confirmations say what happened and link to it | **Done:** built, reviewed and corrected. **Open its PR** once #368 merges (it's stacked on it). Title and body are in `reviews/idea-18-final-report.json` | `feat/hf-honest-confirmations` @`a4f8f593` |
| 19 | Role-aware connected surfaces for members | WIP, unfinished and untested | `feat/hf-role-aware-connected` @`0a32bd4f` |
| 20 | Tools & connections replaces Skills | WIP | `feat/hf-tools-connections` @`faf0b280` |
| 21 | Error boundaries per panel, Suites 404/error pages | Partial plus WIP | `feat/hf-error-boundaries` @`617713dc` |
| 22 | Chat-first phone Gen | Not started | — |
| 23 | Gen audio voices and length; 3D wired or dropped | Not started | — |
| 24 | Plans and credits as media | WIP | `feat/hf-plans-as-media` @`0ef1b3e4` |
| 25 | Usage ledger per job | Not started | — |
| 26 | Lightbox browses the list, deep links | Not started | — |
| 27 | Agent stages keep notes, speak in credits | WIP | `feat/hf-agent-notes-credits` @`50a4ccb4` |

**About the WIP commits:**
- They're labelled "WIP (unfinished, untested)". Their agents were stopped mid-build, and the commits exist so nothing is only on one laptop.
- Before continuing any of them: `git diff` against the previous branch in its track, then run tsc, lint and the specs.

**Stacking order within each track**
Each idea branches from the previous one:

| Track | Ideas in order |
|---|---|
| gen | 8 → 7 → 13 → 23 → 22 |
| connected | 11 → 17 → 18 → 19 |
| jobs | 2 → 16 → 1 → 15 |
| takes | 5 → 6 → 26 → 12 → 14 |
| shell | 21 → 10 → 9 |
| workspace | 24 → 25 → 4 |
| atomik | 20 |
| agents | 27 |

Once a base PR merges, retarget the next PR in its track to main and merge main into it.

**Resuming with the workflow:**
- The script is `HANDOFF-2026-09-26/workflow-scripts/higgsfield-ideas-*.js`. It builds, then runs code and experience reviews, then corrects. It runs 3 tracks at a time and supports restart-from-step.
- The handoff copy's `SCRATCH` already points at `HANDOFF-2026-09-26/reports`, which holds `ideas/` and `higgsfield-notes.md`.
- Ready-made args are in `HANDOFF-2026-09-26/workflow-scripts/ideas-workflow-args.json`: all 8 tracks, with `from` = 2, 7, 8, 11, 16, 17 and 18 `done`, and 13 and 1 `correct`. `priorDir` is `HANDOFF-2026-09-26/reports/prior`, which holds `idea-build-<n>-<slug>.json` and `idea-review-<n>-{code,ux}.json`, including those for 13 and 1.
- The WIP ideas resume as builds: the script's setup step keeps the partial work already on each branch.
- Before re-running, update the `from` map for anything already merged. The owner's cap of 15 agents includes these.

---

## 6. Other work in progress

**Drafts three-way merge redesign plus draft-area audit fixes** — `fix/rig-leave-save` @`fae5e827`, worktree `work/glass`
- The owner-approved design replaces replaying steps with `merge3(base, mine, theirs)` in `lib/workbench/merge.ts`, merging arrays of objects by id.
- 7 commits ahead of main, **169 behind**. It needs a main merge, which will conflict in the draft, Rig and composer files.
- **Round 1:** adversarial verification ran, then a correction round (see `reviews/drafts-r1-correction-report.json`).
- **Round 2:** verification found more majors:

| File | Findings |
|---|---|
| `reviews/drafts-r2-merge-algebra.json` | 5 major, 6 minor |
| `reviews/drafts-r2-loss-dup.json` | 10 major, 3 minor |
| `reviews/drafts-r2-canvas-undo.json` | 4 major, 2 minor |
| `reviews/drafts-r2-composer-money.json` | 3 major, 5 minor |

  - Among the round-2 majors: a line edit reverting a large edit past 1,000 lines; neighbouring-line edits treated as conflicts; merged drafts the server then refuses; the Rig re-sending the other window's canvas changes; a new prompt replaying and billing the old prompt's lost request.
  - **Round 2's correction was stopped mid-way.** `fae5e827` "Drafts: a merge keeps what each window did, and no edit is left behind" is its partial output.
  - Next: finish the round-2 corrections, re-verify, merge main, open the PR.

**`fix/audit-core`**
- One commit not in main, no PR: "Credit workspaces see credits, not the vendor's dollars, in analytics and token…".
- Check whether #370 or #372 superseded it. If not, open a PR.

**`feat/rig-zoom-pan`**
- One commit from 24 Sep, "Rig canvas: zoom and pan in the Suites graph". Pushed at handoff; never reviewed or PR'd.

**`codex/astra-active-recovery`**
- An old local-only branch from 15 Sep, not pushed. Probably stale.

**Worktree hygiene**
- `work/hf-gen` has four throwaway, untracked review specs: `tests/zz-review-13*-workbench.spec.ts`. Delete them before running suites there.

---

## 7. The CI memory problem — findings to date (not solved)

**Symptom**
- On GitHub's 16 GB runners, a browser shard's Turbopack `next dev` server (`next-server` in the `[resources]` lines) jumps by about 9–11 GB within 30 s and stays there. GitHub then shuts the runner down: `The runner has received a shutdown signal`.
- On customer shards it shows up right after `gen.spec.ts:604` (the stale Gen tab upload test, 1440 only) as the next spec starts. Main's own run 36246185414 survived at 13.97 GB.
- On workbench shards it shows up when one shard compiles many legacy (app) pages.

**Mitigations already landed**
- 12 shards (#379).
- Specs that tour many pages split across files whose names sort apart:
  - #375: `atomik-pages-audit`, `projects-legacy-pages`, `rig-canvas-audit`, `shot-builder-handoff`, `entry-points-audit`, `legacy-pages-sideways` and `studio-pages-sideways`;
  - #365: `account-identity` and `platform-desk`.
- These reduce but **do not remove** the shutdowns.

**Reproduction** (scripts in `HANDOFF-2026-09-26/mem-spike/`)
- Worktree `work/mem-spike`, branch `fix/upload-memory-spike` at main, no commits. It has a real `node_modules` clone so Turbopack runs.
- Server on port 4891. Measure with `top -l 1 -pid <pid> -stats mem`: macOS RSS hides compressed pages, so don't trust it.
- `triple-json.sh` gives a fresh `.next` and runs `gen.spec`, `management-scope` and `paid-action` at `customer-1440x900`, with per-test start times.

| Run (Turbopack unless noted) | Peak |
|---|---|
| webpack, stale-tab test alone | 2.6 GB |
| Turbopack, stale-tab test alone, then 60 s idle | 2.0 GB, flat |
| `gen.spec` alone / `paid-action` alone / `management-scope` alone (cold) | 1.9 / 2.1 / 2.8 GB |
| `gen.spec`, then compile the account pages and APIs with `curl` only | 4.0 GB, back to 1.1 GB |
| `gen.spec` → `management-scope` → `paid-action`, fresh `.next` | **≥12 GB** (safety kill) |
| same, dev filesystem cache **off** (`turbopackFileSystemCacheForDev: false`) | **≥12 GB** |
| same, `turbopackMemoryEviction: 'full'` | **≥12 GB** (lower before the spike) |
| same, `--max-old-space-size=3072` | **≥11 GB**, no V8 OOM, so the growth is **native** |
| same, with the `openUploadStream` abort fix (0 uncaught errors) | **≥11 GB** |
| stale-tab test → `management-scope` | 6.1 GB |
| the two other Gen tests → `management-scope` (no stale test) | 6.1 GB |

**Conclusions**
1. It happens **only in the Turbopack dev server**, so production isn't affected.
2. The memory is **native**: a 3 GB V8 heap cap doesn't bound it. It grows about 300–650 MB/s for 20–35 s.
3. It is **not**:
   - a request flood (request counts are ordinary);
   - the dev filesystem cache;
   - Turbopack's eviction policy;
   - the upload test itself;
   - the uncaught `AbortError`.
4. It needs heavy pages, above all `/generate`, to have been used in **real browser sessions** earlier in the same server, followed by **new browser pages** whose routes compile cold. Compiling the same routes with `curl` alone doesn't blow up.
5. The working hypothesis (unproven): Turbopack's hot-reload/update work for browser clients, including ones already closed, grows with each new compile.

**Next steps, in order**
- (a) **Robust CI fix, recommended:** restart the dev server between sub-shards.
  - Each browser job runs 2–3 sub-shards in sequence, e.g. shard `i` runs `--shard=(3i-2)/36`, `(3i-1)/36` and `(3i)/36`, with a fresh `npm run dev` before each. Keep the 12-job matrix.
  - Memory then resets well before it can reach 16 GB. Keep the `[resources]` monitor to prove it.
  - Keep both the per-suite required checks and the test counts identical.
- (b) Try a Next patch release, since Turbopack changes quickly. Also check `NEXT_EXPERIMENTAL_SERVER_COMPONENTS_HMR_CANCELLATION`, which appears in Next's source.
- (c) If there's time: a minimal repro for an upstream Next.js issue.

**Rejected, don't repeat**
- A webpack dev server in CI: memory was fine at 2–11 GB, but tests that pass on Turbopack failed deterministically. See the #379 PR body.
- `next start`: `NODE_ENV=production` enables the keyring, provisioning and dispatch gates, which breaks local sign-in.

---

## 8. Business spec test gap (from the #360 merge)
In `tests/suites-business-workbench.spec.ts` (~line 266), "an ad the server no longer knows is forgotten…; a lost submit reply is read, never re-sent" registers its `page.route("**/api/higgsfield/consumer/generation")` **before** `open()`. `open()` registers a generic handler afterwards, and later routes win, so the 404 path and the lost-submit path never run.

Fix: give `open()` a hook for extra routes registered after its own, or register the test's route after `open()` and before navigating. Then make the assertions actually exercise the 404 and 503 paths. `lib/shell/use-connected-job.ts` has since moved (#364, #367), so re-check the expected flows.

---

## 9. SOW — pending work, in order

Work in small PRs off `origin/main`. Every PR must pass tsc, eslint and the unit project, run the affected browser specs locally at all five sizes, and go green on CI before merging.

**P0 — land what's open**
1. **#367**, then **#377**: retarget #377 to main, finish its browser spec rewrite, merge main.
   - *Done when:* both are green and merged; `feat/hf-jobs-tray` (idea 1) is retargeted onto main.
2. **#368**: merge main.
   - *Done when:* green and merged. Then open **idea 18's PR** from `feat/hf-honest-confirmations`, retargeted to main after #368, using the prepared body.
3. **#376**: fix the 360x640 `card rows hidden` failure in `hf-recreate-recipe-workbench.spec.ts:289`.
   - *Done when:* green and merged. Then rebase idea 13's stack: merge main into `feat/hf-film-vocabulary`.
4. **#375**: make it pass (after P0-5, or by re-running jobs), then merge.
5. **CI memory, §7(a):** sub-shards with a dev-server restart.
   - *Done when:* three consecutive full CI runs on main have no runner shutdown and a peak `next-server` under 10 GB in every shard.
6. Ask the owner about **#371** and **#372**. Merge them if approved: both are green.

**P1 — finish what's half-built**
7. **Drafts redesign** (`fix/rig-leave-save`): correct every major in `reviews/drafts-r2-*.json`, re-verify adversarially, merge main (expect conflicts in the draft, Rig and composer files; keep both sides' intent), then open the PR.
   - *Done when:* green and merged, with the owner's merge3 design intact.
   - After it merges: **idea 3**, batched takes 2–4 as one priced batch.
8. **Idea 13** (`feat/hf-film-vocabulary`): fix `reviews/idea-13-review-{code,ux}.json`, including:
   - Recreate not taking setup words back out of the prompt;
   - connected-path setup restore;
   - `#` typeahead taking over Enter and Tab after ordinary hashtags;
   - 'Rack focus' combined with camera moves.

   Then open the PR (stacked on #376, or on main once #376 merges).
9. **Idea 1** (`feat/hf-jobs-tray`): fix `reviews/idea-01-review-{code,ux}.json`, including:
   - header overflow at 844x390;
   - the pill's counts not matching its rows;
   - takes named by internal codes;
   - "Open in Takes" not opening the clicked take;
   - `updated_at` used as the finish time;
   - the "approved price" being recomputed.
10. **WIP ideas 19, 20, 21, 24, 27 and 5:** finish each build, run both review lenses (correctness and experience at five sizes), correct, open PRs.
11. **Not started:** 4, 6, 9, 10, 12, 14, 15, 22, 23, 25, 26, and 3 (after the drafts redesign). Build from `ideas/idea-NN.json` in the same build → two reviews → correct loop. Respect the track stacking in §5, or start from main where a track's base has merged.

**P2 — loose ends**
12. The Business spec test gap in §8.
13. `fix/audit-core`: check it against #370 and #372, then open a PR or retire the branch.
14. `feat/rig-zoom-pan`: review it at five sizes and open a PR.
15. **Marketing site:** replace `public/marketing/screens/*.jpg` with real app captures.
    - Take them with mock data on a local server: no client or person names, and no Higgsfield media.
    - The site is `app/(marketing)/site/_pages/*`, served by `proxy.ts`. Prices are computed live by `lib/marketing/prices.server.ts`, so never hard-code numbers.
16. **Housekeeping:** delete the `zz-review-13*` specs in `work/hf-gen`, and clean up finished worktrees. Removing worktrees and branches is fine; team data is never deleted.

---

## 10. Files in this folder
- `README.md` — this handoff.
- `ideas/idea-00.json` … `idea-27.json` — the 28 idea specs.
- `reviews/` — open review findings and final reports:
  - idea 1: build report plus code and experience reviews;
  - idea 13: build report plus code and experience reviews;
  - idea 18: final corrected report, including the PR title and body;
  - the drafts round-1 correction report and the four round-2 verification reports.

Everything else — the Higgsfield notes, the full audit, the workflow scripts, the dev and CI scripts, the memory logs and the previous account's memory — is in the local `work/HANDOFF-2026-09-26/` folder described in §2.
