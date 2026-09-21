# Particl — handoff (last updated 21 September 2026)

You are taking over a live product. This is what it is, what changed in the last two days, the rules that are
binding, what is proven and what only looks proven, and what to do next. Read this, then
[`docs/handoff/status.md`](status.md) for the running record, then `CLAUDE.md` for the ground rules.

`main` was `e4c1610` when this was last updated, deployed, type-checking clean and green on CI. The
write-up is kept current in place, so check the git log for anything newer than that commit.

If you are a new Claude Code session, [`START-HERE.md`](START-HERE.md) is the opening prompt to follow.

---

## 1. The first ten minutes

- **Repo:** `axy-full/aimighty-workspace`. Next.js 16 · React 19 · TypeScript · Tailwind v4 · Node 24.
- **Production:** <https://www.particl.app> (Vercel project `particlstudio`). `GET /api/health` answers
  `{ok, mock:false, dispatch:{mode}, database, storage}` — read it before and after anything you ship.
- **The owner signs in on the built-in browser pane.** Owner-only routes refuse API tokens. Browser fetches to
  workbench routes need `X-Workbench-Scope: particl-active-<workspaceId>-<userId>`, read from `/api/me`.
- **Work in git worktrees off `origin/main`**, one per concern, `node_modules` symlinked from the main checkout.
  Turbopack rejects that symlink, so run dev servers as `npx next dev --webpack -p <your own port>`.
- **One concern per PR.** Full CI (`.github/workflows/verify.yml`, ~15–20 min) before merge. Never `--admin`,
  never merge red.

## 2. What the product is

Four suites over one project, one shared state layer:

| Suite | Pages |
| --- | --- |
| Particl Production Studio | Brief & Script · Boards · Cast & Elements · Astra 3D · Rig · Takes · Edit & Sound · Deliver |
| Atomik Super Agent | Agent · Runs · Generate · Recipes · Builds · Skills · Models · Approvals · Budget |
| Moleculr Business Suite | Marketing Studio |
| Subatomik Viral Studio | Motion Transfer · Object Swap · Shorts · Sources · Compare · History |

**Surfaces.** The redesigned workspace lives at `/workspace` and is now the **default** for desktop: `/`,
`/workbench`, `/atomik` and `/subatomik` switch a desktop visitor into it, mapping the page and the selection
(`lib/workspace/switchover.ts`). `?shell=legacy` returns to the old shell for 30 days (a `particl_shell` cookie,
written in the server-rendered HTML — not an effect, that ordering was a real bug); `?shell=new` clears it;
`WORKSPACE_IS_DEFAULT` in the same file turns the whole thing off in one line.

**Phones** get their own shell at `/workspace` below 768px (`components/workspace/mobile/*`): 54px header,
five-tab dock, pinned action bar, four bottom sheets, drill-down Projects → Suite → Page. It is a different
shell over the **same** state layer. The switch-over gate still sends phones from the *old* routes to
`/workbench`; flipping that is the last outstanding step of the redesign (§9).

## 3. Binding rules

These are owner decisions and repo law. Breaking one is a defect, not a preference.

1. **Nothing paid dispatches without an approval gate showing the exact live price.** Quote → approve the exact
   figure → single durable claim → poll → collect the original → file into the project. A stale or missing quote
   blocks. `lib/workspace/run-engine.ts` enforces it by construction: a dispatch executor needs an
   `ApprovedQuote` token only `approve()` can mint.
2. **One credit is US$0.10** (`creditUsd()` in `lib/creditTerms.ts`, overridable by `CREDIT_USD`). Every
   conversion and every printed rate derives from it — no second definition anywhere. Customers are billed
   `usd × margin / creditUsd`, margin 1.5 (`LAUNCH_MARGIN`).
3. **Connected-account credits are the provider's currency, not ours.** Never convert them at our rate, never
   call them ten cents, never name the provider. A unit test pins that the connected files do not import the rate.
4. **Model names:** real names for models we integrate directly (Seedance 2.5, Kling 3.0, Nano Banana 2, Eleven
   v3, GPT-6 Astra, Claude Fable 5.1, Gemini…); neutral names only for the connected catalogue. Higgsfield,
   Supercomputer, Genjutsu and Soul ID are never printed. `displayModelName()` in `lib/models.ts` is the single
   label producer; `tests/unit/noVendorNamesInUi.spec.ts` bans only the connected vocabulary.
5. **Phones are first class** (CLAUDE.md rule 7). Every change ships with Playwright at 360×640, 390×844,
   844×390, 1440×900 and 1920×1080. Phone floors: nothing under 12px, every target ≥44×44 (a segmented option
   may be 40px inside a 44px control), the Atomik ring is the **only** loader, exact sheet chrome. One shared
   guard: `tests/phoneFloors.ts`.
6. **No simulation.** Progress comes from real jobs; a plan step advances when its backend call returns; a plan
   with no backend says "Not runnable yet — …" and never animates.
7. **Every counter derives from state.** No hardcoded totals, no prototype fixture names or numbers in shipped
   copy, no studio/client/person names in source (`Dune Studies`, `Mira`, `ZigZag Films` are fixtures).
8. **Extend the existing `/api` routes and `lib`; never rebuild them.** Owner rule, stated twice.
9. **`#7C7C84` is the dimmest permitted functional label.** Numbers format `toLocaleString("en-US")`.
10. **Paid provider tests need an explicitly approved ceiling each time.** A previous approval is not a budget.
    Stripe and Meta remain out of scope.

## 4. Where things live

| Area | Path |
| --- | --- |
| New workspace state, navigation, plans, cost | `lib/workspace/*` (`state.tsx`, `navigation.ts`, `pages.ts`, `plans.ts`, `run-engine.ts`, `shots.ts`, `takes.ts`, `cost.ts`, `composer.ts`, `switchover.ts`, `mobile.ts`, `progress.ts`) |
| Desktop shell and pages | `components/workspace/*`, page bodies in `components/workspace/pages/registry.tsx` |
| Phone shell, screens, sheets | `components/workspace/mobile/*`, styles `app/workspace-mobile.css` |
| Design tokens | `app/workspace.css` (`--pxw-*`, all scoped under `.pxw`) |
| Old shell (still serving phones from old routes, and every page the new shell has no home for) | `components/workbench/Studio.tsx`, `components/shell/*`, `components/suites/*` |
| Connected account (MCP `mcp.higgsfield.ai`) | `lib/higgsfield-consumer/*`, routes `app/api/higgsfield/consumer/*` |
| Pricing and credits | `lib/creditTerms.ts`, `lib/vendorPricing.ts`, `lib/models.ts`, `lib/rateTable.ts`, `lib/packs.ts` |
| Jobs, dispatch, storage | `lib/jobs.ts`, `lib/dispatch.ts` + `/api/worker`, `lib/storage/*` |

**Designs.** Desktop and phone handoffs (tokens, shell, pages, state, mobile) were supplied as
`design_handoff_particl_workspace/` with two HTML prototypes. The prototypes are references — their runtime
(`support.js`) must never be ported, and their fixture data stands in for API responses. The repo's own earlier
mobile spec is `design/particl-v2-mobile/README.md`.

## 5. What shipped 19–21 September

Roughly fifty PRs. Grouped:

- **Astra Blender + direct OpenAI released** (#192 and follow-ups #193–#199).
- **Dispatch:** Inngest replaced by native dispatch through `/api/worker`, then restored on the owner's choice —
  production currently runs `dispatch.mode: "inngest"` against the org *SensAI Studios LLP*, app synced manually
  at `https://www.particl.app/api/inngest`. Re-sync in Inngest → Apps after a deploy that changes functions.
  `DISPATCH_MODE=native` + redeploy reverts.
- **Workspace redesign**, desktop: tokens and primitives, shell, navigation with selection repair, Home, Rig
  (list + graph + Inspector + generation), Takes, Cast & Elements, Edit & Sound, the spec-card pages for every
  remaining page, the Atomik panel with priced gates, the ⌘K palette and keyboard map, Marketing Studio extracted
  from `Studio.tsx` and mounted in the workspace, and the switch-over that made it the default.
- **A global Generate composer** (#263): top-bar button, Home, palette, `G`. Type → model → prompt → references,
  exact price on the button, re-quoted on click, workspace credits by default with a connected-account switch.
  No project? It creates "Untitled" rather than blocking. It reuses Rig's and Atomik Generate's dispatch code —
  both now call the same extracted functions.
- **Phone build** (#264–#268): shell, six page templates + Edit & Sound, Make, Settings, the four sheets.
- **Naming:** vendor names removed (#231), then real model names restored for direct integrations (#262).
- **Connected account:** toolset guard (#226), planner reads + priced connected steps (#228), presets and
  batches (#234), workflows as recipes and slash commands (#240), audio policy + voice picker (#225), reframe
  (#227), Shorts (#230), explainer browsing (#235), plus the defect fixes in §6.

### 21 September

- **One credit is US$0.10, stated once and derived everywhere** (#270). The calculations already agreed; two
  places that *said* the rate were typed by hand (the billing page, and the browser's fallback rate table) and
  now derive. The rate is printed under the phone Settings balance, in both credit tooltips and on `/billing`.
- **The credit slot is always mounted** on desktop and phone (#267, #269): the figure, `— cr` when unknown, or
  `—` for a workspace billed in dollars, each with a title saying why.
- **The switch-over gate decides once per page load** (#272). It used to re-decide on every viewport change,
  so a landscape phone whose height crossed 500px (keyboard closing, browser chrome) could be redirected into the
  desktop workspace mid-session. The decision is now taken while the document parses, by a probe in
  `app/layout.tsx`'s `<head>`, and latched.
- **The Make wall's day grouping is tested against a clock the test owns** (#273), proven one minute either side
  of local midnight.

## 6. The connected account: what is proven, and the lesson

**Proven with real money on 20 September (30.4 connected credits total):** an image generation *with a reference
image* (1 cr), a 4-second video (2.4 cr), a reframe of that video (15 cr), and a Shorts session with its clip
(12 cr). All four were collected into the project with checksums.

**Five defects were found — four of them before spending anything**, each of which would have charged the owner
and then discarded the result:

1. The status reply is nested in a top-level list; our reader only looked for a bare object (#251).
2. The echoed media `role` is the media **kind**, not the slot name we sent (#253).
3. `data.type` is per-kind (`media_input`, `video_input`, `audio_input`), not one spelling (#255).
4. An audio job echoes an **extra** media entry we never sent — the voice — so a strict length check refused it (#261).
5. Shorts prices `credits` (integer, charged) and `credits_exact` (fractional); we required them to be equal, so
   every real quote failed (#256).

Every one had the same cause: **a shape recorded from one sample and assumed to hold everywhere**, with fixtures
written from the assumption rather than from life. `tests/fixtures/connectedStatusEnvelopes.ts` now records real
envelopes with dates and provenance. **Follow that rule.** Before trusting a connected shape, read it with a free
read-only call and check it in.

**Still unproven:** batch generation, preset runs and the transform (genjutsu) path end-to-end; the marketing
templates and video-analysis status readers (this connection does not advertise the first, and the account holds
no analysis, so neither reply can be produced without paying — both readers accept either shape and say so).

**Tools with no price path** (cannot pass the gate contract until one approved run establishes a price): voice
clone, video analysis, virality predictor, personal clipper, sandbox, marketplace apps, 3D scene builder,
websites, and the connected agent API.

## 7. Testing, CI and the traps

```bash
# unit
PW_BASE_URL=http://localhost:<port> PLAYWRIGHT_BROWSERS_PATH=/private/tmp/particl-playwright \
  npx playwright test --project=unit tests/unit/<spec> --output=/private/tmp/<yours>
# browser (five viewports), against your own mock dev server
ENGINE_MOCK=1 APP_ORIGIN=http://localhost:<port> PW_BASE_URL=http://localhost:<port> \
PLATFORM_DATABASE_URL=file:/private/tmp/<yours>/platform.db \
PW_PLATFORM_DATABASE_URL=file:/private/tmp/<yours>/platform.db \
TURSO_DATABASE_URL=file:/private/tmp/<yours>/legacy.db PW_CHANNEL=chrome \
  npx playwright test --config=playwright.workbench.config.ts <spec> --output=/private/tmp/<yours>
```

- **CI runs six browser shards per suite with a 30-minute ceiling** (#243). Shards were being cancelled at 25.
- **Never hard-code `/private/tmp/...` in a spec.** It does not exist on the Linux runners; three PRs failed this
  way. Use `info.outputPath(...)`.
- **Known environment-only failures**, in a linked worktree but not the main checkout: `screenplayOcr`
  (pinned package hashes vs the symlinked `node_modules`) and `localDatabaseClient` (timing under load).
  Verify against a clean `origin/main` tree before calling anything a flake.
- **One Playwright run at a time** per machine; give every worktree its own port and `/private/tmp` paths.
- npm's audit endpoint had an outage on 19 September and failed the `core` job; that one is genuinely external.
- **CI runs `npm run dev` — Turbopack, from cold.** A worktree with a symlinked `node_modules` is forced onto
  `next dev --webpack`, and a warm local server hydrates faster than CI's first compile. Both differences hid a
  real bug on 20 September. When a spec passes locally and fails on CI, reproduce CI's shape before re-running:
  clone `node_modules` with `cp -Rc` (APFS, seconds, near-zero disk) and run the real `npm run dev`, or hold
  `/_next/static/*.js` back a few seconds to simulate the cold compile.
- **Do not re-run a red job twice and call it a flake.** Check whether main is green on the same spec first; if
  it is, the branch is implicated. Two of 20 September's "flakes" were a stale merge base and a genuine race.
- **A stale merge base looks like a flaky test.** If two PRs edit the same lines, CI tests a merge tree that
  cannot be built cleanly. Rebase on current `origin/main` before diagnosing anything subtle.

## 8. Deploying and verifying

Vercel deploys `main` automatically. After a merge: wait for the commit status, read `/api/health`, then check
the actual surface in the browser pane (the owner is signed in). Verify **live**, not just in CI — the phone
credit slot, the switch-over mapping and the Rig estimate were all confirmed that way, and one live check
disproved an agent's conclusion that a bug was only a test artefact.

## 9. The queue, in order

Nothing of ours is open at `e4c1610`. The queue:

1. **Flip the phone redirect — waiting on the owner.** The switch-over gate still sends phones from the old
   routes to `/workbench`. The phone build is merged and live at `/workspace` and was checked on production at
   phone size in an emulated window. The owner was asked whether to flip on that evidence plus the tests, or to
   try `particl.app/workspace` on a real phone first. Do not flip until they answer. When they do, it is one
   concern in `lib/workspace/switchover.ts` / `components/switchover/SwitchoverGate.tsx`, and the 52 specs that
   call `legacyShell()` for phones will need their phone assertions reconsidered.
2. **Unify the phone's shell choice on rotation, if it ever misbehaves.** `MOBILE_QUERY` is deliberately *live*
   (it only picks which shell `/workspace` draws, with state preserved across a swap). A landscape phone whose
   keyboard closes can briefly draw the desktop shell. Cosmetic; fix on evidence, with a narrower height clause.
3. **Atomik parity backlog** (the owner's standard is full parity with the connected provider's agent):
   memory, schedules with an owner credit ceiling, Soul/Reference pickers, AI Employees, marketplace apps, the
   connected agent API (spends inside a turn with no prior quote — off by default), owner-only websites, and our
   own connectors. Source: [`connected-capability-audit-2026-09-19.md`](connected-capability-audit-2026-09-19.md), checked in beside this file.
4. **Backends that do not exist**, each blocking a plan that currently says so honestly: Boards generation (a
   board is a `Shot` citing an existing asset — no prompt, engine, ratio or resolution; the SOW records the board
   pipeline as unbuilt), takes triage, builds, skills, on-demand budget reconcile, Viral Studio sources re-hash.
5. **Paid qualifications still owed** under a stated ceiling: batch, preset, genjutsu, marketing v2 first run,
   an identity render, and Astra on a non-legacy workspace.
6. **Stale PRs from before the takeover:** #123–#131 (old SOW surfaces) and #135–#141 (dependency bumps). Close
   or land them deliberately.

## 10. Owner decisions pending

- **Refund/cash-out wording.** The Settings card shows `balance × $0.10` beside the balance. That is what was
  paid, at no margin, so it cannot imply a better rate — but the product states no refund policy. If credits are
  non-refundable, that line wants a few words. Do not invent the policy.
- **Auto top-up** does not exist: no field, setting or route. The phone Settings card omits the switch rather
  than faking it. Building it is a feature, not a fix.
- **Composer renders add a Rig shot.** `/api/generate` needs a shot to attach the take to, so each composer
  render creates one named from the prompt. The owner may want them grouped or hidden.
- **Segmented control background** on Rig/Takes moved to the prototype's `#0E0E10` when two waves disagreed. A
  one-line revert if the darker panel was wanted.
- **Icons:** the desktop shell uses lucide-react; the phone build uses the repo's own `components/Icons.tsx` as
  the mobile design requires. Unifying them is a decision, not a bug.

## 11. Hazards

- **Never rotate `KEYRING_SECRET`.** Never create a Vercel project, GitHub org or Inngest org.
- **Subagents will refuse consent relayed through another agent** for real spending or publishing — correctly.
  Paid steps must be driven by the session that holds the owner's own instruction.
- **The permission classifier** blocks some things outright: `vercel env pull`, marketplace SSO navigation,
  scraping env-var pages. Ask the owner rather than working around it.
- **Two live surfaces cost double** until the old shell is retired: every change may need doing twice, and 52
  specs carry a `legacyShell()` helper to ask for the old one.
- **The owner's own workspace is the legacy one:** it bills in dollars, holds no credit balance, and the worker
  probe refuses it. Do not read "no credits" as a bug there.

## 12. Notes for whoever writes the next handoff

Update [`docs/handoff/status.md`](status.md) as you go — it is the running record, and it is written to be true
rather than flattering. Record what you *proved*, with the command and the counts, and record what you only
assumed. Most of the expensive defects in this codebase were assumptions that read like facts.
