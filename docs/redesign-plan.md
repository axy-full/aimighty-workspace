# Redesign plan: prototype 12

Written 10 Oct 2026 by the lead, at the owner's request ("write the plan into the repo as you go and build"). This file holds the decisions; the running status is in docs/redesign-progress.md. Research behind it:
- docs/redesign/inventory.md: every prototype URL, screen, size, copy, price and bug.
- docs/redesign/app-map.md: today's app, file by file.
- docs/redesign/cancel-billing.md: job states and what each provider bills on cancel.

## The brief (owner, 10 Oct)

- **The design:** design/particl-prototype-12 is the only design. It replaces design/particl-graphite, and each screen PR deletes the graphite design file(s) it replaces.
- **Switch:** everything is built on release/1 behind the per-workspace switch. It is off for every customer workspace and on only for the internal house workspace.
- **Work order:**
  - P1 Shell
  - P2 Boards
  - P3 Render states
  - P4 Visitors and invite-only join (sign-in: NEEDS AKSHAY)
  - P5 Rig
  - P6 Campaign/Social, Remix, "/" skills
- **Prices:** no credit number is hardcoded. Every price comes from the quote engine. An engine with no live quote path shows "quoted" and is listed in the progress log.
- **Plans:** Starter, Studio and Team, with placeholder prices behind config.
- **Low-credit warning:** shown below 20% of the workspace's plan credits.
- **Fix while building:**
  - Rig fits 1440×900 or scrolls inside its canvas, and the hint pill never covers a node.
  - Shots have no ~100 px row gap.
  - The rendering card's time line stays on one line, and particles never overlap text.
  - The phone join sheet gets "Continue with email".
- **Out of scope:** signed-in phone screens. Keep the current phone layout.

## How the new screens plug in

- **The switch.** `lib/newInterface.ts` reads `session.workspace.newInterface`, through `useNewInterface()`.
  - It is on for the house workspace (`lib/houseWorkspace.ts`) and for workspaces listed in the site setting `newInterfaceWorkspaces`, which is empty by default.
  - It has no schema change and no env. The switch deleted on 6 Oct (`platform_layer` key `interface`) is never read again.
- **One shell, two frames.** Every signed-in screen is /suites (`components/graphite/SuitesShell.tsx`).
  - When the switch is on and the window is desktop-sized (not `use-compact`), SuitesShell renders the new frame, `components/v12/V12Shell.tsx`, instead of the graphite header and body.
  - A screen that has been rebuilt renders its v12 component. A screen not rebuilt yet renders today's graphite component inside the new frame, so the app stays whole at every step.
  - Phone sizes keep today's PhoneApp. Signed-in phone screens are out of scope.
- **Code layout.**
  - New components live in `components/v12/`, one folder per area: `shell/`, `home/`, `make/`, `library/`, `settings/`, `board/`, `render/`, `visitor/`, `rig/`.
  - Shared pieces live in `components/v12/ui/`: Tooltip, IconButton, Pill, Segment, Kbd, Menu, Popover, Dialog/Sheet, Toast and Price.
  - Tokens extend the existing `--gx-*` layer in `app/graphite.css` (inventory §3). There's no second token system.
- **Data.** New screens reuse today's routes and hooks (app-map §1).
  - A screen needing a new API adds it behind the same auth and tenancy checks.
  - A screen needing a schema change waits for its own small migration PR, which is NEEDS AKSHAY; the screen work goes ahead stacked on it.
- **Deleting the old design.** Each screen PR deletes the design/particl-graphite file(s) it replaces, per the table below. Code comments that cite a deleted file are re-pointed to the prototype-12 section that replaces it.
  - Today's graphite components stay as long as customers use them, because the switch is off for them.

## Decisions taken by the lead (overridable)

Each one is listed for the owner in the morning report.

1. **Font order:** keep the repo's (system font first, Geist as fallback, `app/fonts.css`). The prototype's assets README says "no web font".
2. **Toasts:** bottom-centre everywhere, as the README says. The prototype puts some at the top.
3. **Keys:** `A` approves the selected card, and ⌘J toggles the Atomik panel. The prototype also binds `A` to the panel, which clashes with its own "Approve · A" tooltips.
4. **Placeholder names stay in the prototype.** The prototype's brands, studio, people and invite codes are samples. Under CLAUDE.md rule 3 they never appear in components, copy or seed data; screens use the workspace's own data, and tests use neutral names.
5. **No live quote path:** the price reads "quoted", per the owner's instruction, which overrides CLAUDE.md rule 14's "never the bare word quoted" for this build. Each case is listed in the progress log.
6. **Low-credit chip:** shows when `balance < 20%` of the plan's included credits for the cycle.
   - On the Invite plan, whose included credits are 0, the base is the welcome grant.
   - The house workspace pays in dollars, so it never shows the chip, and it sees dollar prices. Screenshots are taken in test workspaces that pay in credits.
7. **Plans on screen:**
   - Starter, Studio and Team, with placeholder credits and prices from one display-only config (`lib/marketing/plans.ts` or a sibling).
   - Checkout keeps today's plans (`lib/plans.ts`), untouched. Mapping the two is NEEDS AKSHAY.
8. **Cancel on a render card** (docs/redesign/cancel-billing.md):
   - It is offered only while the provider still holds the job in its queue, where the provider's docs say nothing is billed. Today that's held takes and Higgsfield API video. Ark and fal cancel APIs exist, but calling them is new money-adjacent code, so that's NEEDS AKSHAY.
   - Once a job is running, the card shows no Cancel: no provider promises a running job isn't billed.
   - Esc never cancels.
9. **Typical times** come from real job history per engine (`generations.duration_ms`, grouped by model), with the prototype's ranges as the fallback when there are fewer than 10 jobs.
10. **The Activity pill** reads today's jobs tray API (`/api/jobs?view=tray`) and approvals.
11. **Library "Uploaded / Generated"** is derived from where an item lives (uploads vs generations), if today's library API can tell them apart. If it can't, that's a migration PR (NEEDS AKSHAY).

## Owner decisions (Akshay, 10 Oct evening)

These settle the lead's decisions above and the open questions in the builder's brief (§13). They win over older documents.

1. **The lead's 11 decisions above: all confirmed.** In particular, "quoted" (shown where an action has no live quote path) overrides CLAUDE.md rule 14's "never the bare word quoted" for this build.
2. **"Rig" stays the view's name.** The UI-text ban on "Rig" is lifted before P5, through a docs PR that updates CLAUDE.md, titled "NEEDS AKSHAY · …".
3. **The new-interface switch stays until launch** (scope v2's "no switch" is overridden until then).
4. **Where the v12 render differs from the brief, build from the brief:**
   - Cancel only while a job is queued at the provider; never on Preparing, Rendering or Saving cards.
   - Elements 4 across, with the last row clearing the Library button and the view switch.
   - Rig fits 1440×900 or scrolls inside its own canvas; the hint pill never covers a node.
   - No ~100 px gap between Shots rows.
   - The render card's time line on one line; no particles over text.
5. **#622 Reuse seed: yes.** The seed is sent in the priced request; the price is unchanged.
6. **Still waiting on the owner (no action):** queued-job Cancel for Ark/fal, the two indexes (`billing_cycles.workspace_id`, `meter_events.created_at`), plan mapping and prices.
7. **Merges:** the lead may merge into release/1 (never main) PRs that are green, reviewed and approved, including money ones the owner has decided (e.g. #622). Never force; stop on a conflict or a red check and report.

8. **More owner decisions (10–11 Oct, night):** #622 Reuse seed: yes. #627's five: all yes (a separate site setting for the visitor pages, off by default; `?workspace=` pre-fill only with an invite code; company/role/size in the existing access-request note; "You don't have access to this board."; keep the test-only join page). Plans mapping: later, with payments. Lip-sync stays "quoted". Google sign-in: later. Whether teammates see each other's boards: still the owner's question; build nothing for it.

## Owner decisions (Akshay, 11 Oct midday)

1. **#627** is merged by the owner; the lead doesn't merge it.
2. **#639 (Cancel for queued fal jobs):**
   - (a) A job is free only on an explicit cancel signal; a 404/410 is not free.
   - (b) A running job stopped after a 202 is free if fal returns no video, and charged if fal answers with an error.
   - (c) A timed-out cancel followed by a 404 with no cancel on record stays charged. Each case is logged (job id, time, provider replies) for review and manual refund.
   - It needs an Opus review and stays open as NEEDS AKSHAY.
3. **#595 privacy text:** name each AI provider that receives prompts or files, with one line on what it receives: Anthropic, OpenAI, Google, xAI, BytePlus, fal, Higgsfield (API), ElevenLabs, Luma, Recraft, and any other engine in use. Remove "Vercel gateway" (no longer used). Keep "older files still in Vercel Blob" only if it is still true. The owner reads the final text before merging.
4. **CI:** add `push: release/1` (full suite after every merge), then the slimmer per-PR set: units, core, the PR's own specs, and the guard set (spend-buttons, switch-off checks, five-minute test, customer smoke). The full suite still runs on any PR touching money, sign-in, tenant separation or shared code. It's one NEEDS AKSHAY PR. A red post-merge run comes before any other merge.
5. **Rig:** show the board bar, and hide it only where it would cover nodes. The lead may merge once green and reviewed.
6. **#631 wording:** "Approve the rest". The lead may merge once green and reviewed.
7. **Flaky tests (workspaceCapDoors, storage-stream-memory):** a small tests-only PR that keeps every assertion. The lead may merge once green and reviewed.
8. **Teammates' boards and Google sign-in:** still later; nothing is built.
9. **Permanent rule:** never edit, weaken or add exceptions to a guard or safety test (spend-buttons, paid routes, privacy, switch-off, one-design, UI-names) to make a check pass. Fix the code instead, and ask the owner if a guard itself looks wrong.
10. **Order, three lanes at most:** the CI PR, then #639, then the small PRs (Rig bar, wording, flakes, #595 text), then P6 resumes (Social kinds, Remix, "/" skills) on top of the merged Campaign board.
11. **#642:** retake the screenshots with the Ask Atomik buttons and add them to the PR for the record.
12. **11 Oct, 13:30–14:15 IST:** the owner deploys #609 to production. Keep #609 green, push nothing to main, and run no heavy work on the server in that window.

## Owner decisions (Akshay, 11 Oct afternoon: launch day)

1. **Freeze release/1 at 65042dca** for today's launch. #639, #645, #648 and #647 go in the next deploy.
2. **Gateway removal** at runbook step 8: set `TEXT_DIRECT=anthropic,google,xai` and `MODEL_CATALOG=static` first, then remove `AI_GATEWAY_API_KEY`.
3. **`RIG_AGENT_ENABLED=1`** (runtime), set in step 2.
4. **New interface:** house workspace only at launch.
5. **#639: option A.** Provider-queued Ark/fal jobs keep Cancel in the new interface, with honest wording: never "nothing billed" before the provider confirms. It needs an Opus re-review and goes in the next deploy.
6. **"/" skills** are built on today's priced paths, provided each "/" item calls exactly the same priced route, with the same price and approval, as its button. Each item is logged as a registry gap (rule 11) to close later.
7. **#647 privacy text** is approved as is: no gateway (it's removed at launch), no Recraft.
8. **platformOwnerPrivacy:179 flake:** a read-only look after the launch, reported to the owner before anything changes.
9. **Close #609 after the launch**, "superseded by the release/1 launch".
10. **Backup is done** (owner): platform-backup-20261011, tenant-backup-20261011 and .sql dumps; integrity ok; restore point 11:03 UTC.

## Owner decisions (Akshay, 11 Oct evening: after launch)

1. **Launch done.** Production runs release/1 (main 3ab53852) since 17:05 IST, 11 Oct.
2. **Gateway removed.** `AI_GATEWAY_API_KEY` is deleted, and `TEXT_DIRECT=anthropic,google,xai` and `MODEL_CATALOG=static` are set. Claude (a workspace-scoped key), OpenAI, Gemini images and Atomik are verified working direct. #649 brings the model list to the verified ids at official prices.
3. **Enhance toggle** in every generating composer, with the owner's tooltip copy: default On, remembered per person, price includes enhancement, viewer labels Enhanced/Raw with "See original". "Improve prompt" is dropped.
4. **Header:** Activity pill and avatar pinned top-right; the Atomik field flexes after the tabs.
5. **House workspace:** at-cost dollar prices everywhere (button, hold line, history); customers see credit prices. The hold line adds "· charged only when it's ready".
6. **Credits & billing** is reachable from the avatar menu for every workspace, the house included (in dollars).
7. **Teammates' boards:** every member of a workspace sees every board in it. Cross-workspace privacy is unchanged and proved by server tests (NEEDS AKSHAY).
8. **Plans and names (final; display config; checkout later; NEEDS AKSHAY):**
   - Individual, monthly: Explore $50 = 500 cr; Create $100 = 1,000 cr; Master $250 = 2,500 cr.
   - Business, per seat per month, one shared workspace, credits pooled, one level per workspace: Business 100 ($100, 1,000 cr/seat), Business 250 ($250, 2,500 cr/seat), Business 500 ($500, 5,000 cr/seat). The card shows "from $100 per seat".
   - Enterprise: "Get in touch".
   - The low-credit warning fires at 20% of the cycle's credits, pooled for Business.
9. **Visitor pages:** "Continue with Google" is hidden on the visitor join sheet until Google sign-in exists, then shown.
10. **v12 for every workspace:** a small PR, merged by the owner after the next deploy is checked.
11. **/admin** is the next design round.
12. **Google sign-in (built tomorrow; NEEDS AKSHAY):** invite-only kept (a new person needs a valid invite; an existing member signs in when the verified Google email matches). No account is ever created from Google alone; scopes `openid email profile`; throttling as today.
13. **Demo:** end of October.
14. **Ownership:** Particl is owned by SensAI Studios LLP.
15. **Remotion:** customer-facing Remotion renders stay off. When on, its $0.01 per render goes into the price.
16. **"Moleculr"** is removed from UI text; the code is fixed, never the guard.
17. **#639** gets option A, plus "N cr held · settles when the engine confirms" after a cancel is sent (NEEDS AKSHAY).

## Owner decisions (Akshay, 11 Oct late night: prototype v14)

1. **Prototype v14** (design/particl-prototype-14) is approved and is now **the one design**; it includes all of v13. v12 stays in the repo for reference.
2. **Order:** finish tonight's queue first. Then Header, Enhance and Plans follow v14 exactly. Then Workspace settings (`?view=settings`), then the Platform console (`?view=admin`).
3. **Build rules where the prototype has placeholders:**
   1. All prices come from the live quote plus margin. The Enhance cost is the real text-model cost inside the one total, never a fixed "+1 cr".
   2. Text-model pickers list only models with a working key, priced from the price table (as in #649). Engines appear only if they're in the registry (check Kling 3.0 Pro and Nano Banana Pro).
   3. The low-credit warning fires at 20% of the month's credits, labelled "Low-credit warning".
   4. House workspace: "House · pays at cost", no plan cards, no Top up, no top-up rows in history.
   5. Plan names and prices come from config (the final plans above). Seats are display-only.
   6. Header tab overflow measures real space (ResizeObserver), not 160 px a tab. Enhance ⓘ opens on hover, focus and tap.
   7. The avatar shows the signed-in person's initials.
   8. No sample names (Maggi, Dune Studies, Canva, ZigZag Films, MAYA, GUIDE, invite codes, Northwind, Lena, etc.) in shipped screens.
4. **Workspace settings (NEEDS AKSHAY):**
   - Admin-only sections are enforced on the server. Members get only Your usage, Plan (read only), Profile and Notifications.
   - Every query is scoped to the signed-in user's workspace. Server tests prove an admin of A can't read or change anything in B (people, usage, billing, limits, rules) by URL or API.
   - Role change, remove member, invites, limits and Delete workspace each get a server test and an audit line.
   - Delete needs the typed name, checked on the server. The last admin can't be removed or demoted.
5. **Platform console (NEEDS AKSHAY):**
   - Owner-only, enforced on the server, and never reachable from a client workspace.
   - Grant credits, Pause/Resume, Invites/Revoke and the Public site switches each get a server test and an audit line.
   - Desktop only for now.
6. Screenshots at 1440 × 900 and 1280 × 800 for each section. Both PRs stay open for the owner's review.

## Owner decisions (Akshay, 11 Oct 23:45 IST)

1. **Merge into release/1 on green CI plus a fresh review of the final head:** #639 (re-reviewed at ca0af4c6), #650, #652 (re-reviewed at ae86e428), #653, #662, #660, #666 and #664. #654, #655 and #656 merge after #661.
2. **#647:**
   - (a) The privacy page is allowed as a guard exception for naming processors.
   - (b) Add a code guard that fails if `VERCEL` or `VERCEL_OIDC_TOKEN` is set in production (the owner is also checking Coolify).
   - Then merge.
3. **#657 Enhance:**
   - The tooltip without the "—" is fine.
   - **The house workspace gets the switch, priced at cost.**
   - Reuse loads the enhanced words, and "See original" stays.
   - Reading "Improve prompt" as the old Enhance row is fine.
   - Board-bar Enhance: not now; a follow-up issue.
   - Then merge.
4. **#663 Google sign-in:** yes to "@gmail.com or a Google-hosted company domain (`hd` claim) only", with an invite still required. **Don't merge** until the owner has set `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` and tested.
5. **#661 Plans:**
   - "Business" everywhere, including the public site; update the 7 Oct guard, since today's plan names supersede it.
   - Per-seat Business pricing is confirmed (seats display-only).
   - Fix the copy Opus flagged, then merge.
6. **#665 v14 for everyone:** do the fixes (five-minute test, global off switch, test-helper race) and merge only after #661. Then send screenshots of a non-house workspace (Home, Make, a board, Settings, billing) and **wait for the owner's yes**.
7. **#667 teammates' boards:**
   - Ship view-only now.
   - Editing comes next, with a "this changed since you opened it, reload" rule (no silent overwrite).
   - The owner seeing the boards of workspaces they're a member of is fine.
   - Fix the wording and the test, then **wait for the owner's yes**.
8. **Workspace settings:**
   - No per-person cap for now.
   - **Workspace admins can change roles** (not owner-only), but nobody can remove or demote the last admin.
   - Name-only profile edit is fine.
9. **Usage:** above 60%, drop to 2 lanes and finish merges and fixes before building anything new.
10. Deploy prep at 08:00 is unchanged.

## Merge rule

The lead merges into release/1 only when all of these hold:
- the PR is screen work with no money, sign-in, migration, secret, env or DNS change;
- CI is green;
- screenshots of each built screen sit beside its prototype URL at 1440×900 and 1280×800 in the PR body;
- a fresh Opus review has approved.

Anything else is titled "NEEDS AKSHAY · …", built fully and left open. Never main, never a deploy, never a paid generation.

Until #612 (CI on PRs into release/1) merges, no redesign PR can merge: each one contains #612's commit. They are made ready and listed in the log.

## Lanes

At most 3 build lanes at once, each in its own worktree (`~/wt/rd-<lane>`), plus the lead (planning, reviews, screenshots, merges, the log).
- Each lane follows ~/lead-notes/LANE-RULES.md: heavy.sh, slot.sh and mock-server.py for browser specs, and only the specs it touches.
- Before each heavy step, a lane checks particl.si /api/health. If its p95 goes over 1 s, the lane pauses heavy work.
- Rule 7 checks: the new frame is desktop-only. Specs at 1440×900 and 1920×1080 check the new screens, with no horizontal overflow. Specs at 360×640, 390×844 and 844×390 check that the phone app is unchanged with the switch on.

## Work items

Flags: **$** money · **AUTH** sign-in · **DB** schema · **ENV** env/secrets. Flagged items are built and left as NEEDS AKSHAY.

| Id | Item | Replaces in design/particl-graphite | Flags |
|---|---|---|---|
| P0 | Switch, prototype import, screenshot tool, plan | — | — |
| A1 | Tokens (`--gx-*` additions, type scale, motion with reduced motion), ui primitives (Tooltip, IconButton, Pill, Segment, Kbd), overlay stack with the Esc order, Toast, tab-title helper; V12Shell frame with today's header | — | — |
| A2 | Header: tabs that hug (+N ▾, ⌘1/⌘2/⌘3…, tab menu), merged Atomik field (⌘K) + panel icon (⌘J), + popover, Activity pill and dropdown, avatar menu (balance shown; Top up opens today's flow unchanged), no credits pill | `Home and header options.dc.html` | — |
| B1 | Price layer: `<Price>` and `useQuote` over the quote routes; a test that fails on any literal "N cr" in components/v12; low-credit rule (20% of plan credits) and chip | — | — |
| B2 | Settings › Credits & billing (display only: balance, plan, cycle, usage; placeholder Starter, Studio and Team cards from config; Top up opens today's flow unchanged) | (Settings part of `Particl Suites.dc.html`) | — (display); any new top-up or payment wiring is $ |
| C1 | Render-state model: states and stages, typical times from job history (API), the "usually 2–4 min · 1:12 so far" line, 90% bar cap, slow at 2× | — | — |
| C2 | Home (signed in): Waiting for you, the wall (pick, Remix), Your boards with kind filters, the shared bar | `Guest Home frames.dc.html` (signed-in parts) | — |
| C3 | Make: justified grid, docked composer, prompt reuse fills the composer, viewer (←/→, Esc, reuse seed) | `Make frames.dc.html` | — |
| C4 | Library tray: search, brand picker, Uploaded/Generated, kinds, masonry, L key | (Library drawer frames in `Studio board frames.dc.html`) | DB? |
| A3 | Right-click menus (card, multi, canvas, Make result, empty space); keyboard map; tooltip audit (every icon has one) | — | — |
| P2-1… | Board kinds and rails (Elements), new-board flow, stage header rule, canvas + right toolbar + first-visit labels, 4-across grid (FIX: Shots gap), the bar with Attach | `Studio board frames.dc.html`, `Particl Suites.dc.html` | DB (kinds/rails persisted, Elements) |
| P3-1… | Render cards (FIX: time line, particles), batch, tab ring, running list, ready toast, tab title, notification opt-in | — | $ (Cancel wiring), ENV (web push keys if needed) |
| P4-… | Visitors, join sheet, request access (+ company size), invite links, no-access page, server-side privacy tests | `Guest Home frames.dc.html`, `Phone frames.dc.html` (visitor parts) | AUTH, DB |
| P5-… | Rig (FIX: fits 1440×900, hint pill) | — | — |
| P6-… | Campaign and Social kinds, Remix, "/" skills | `Ads and Social frames.dc.html`, `Atomik frames.dc.html` | DB? |

The last graphite files (`Particl Suites.dc.html`, README, PROMPT and assets) go when the last screen they describe is rebuilt.

## Screenshots

For each built screen, a `tests/redesign/<screen>.shots.ts` signs in with `signInToRedesign()`, sets the state, and calls `captureBeside(page, "<screen>", "<prototype query>")`.
- Run it with `-c playwright.redesign.config.ts` against a local mock server, through heavy.sh.
- Then run `node scripts/redesign/publish-shots.mjs --pr <n> --from ../redesign-shots/<screen>`, which pushes the images to the `redesign-screenshots` branch (images only, never merged) and prints the table for the PR body.

## Follow-ups (GitHub issues are disabled on this repo, so they live here)

- **Enhance in the board bar** (from #657, owner 11 Oct: not now). In the board bar Atomik plans the steps and writes each prompt, so a switch there would change nothing a person typed. To make it real, enhance each planned still/clip step server-side, with its real text-model cost in the plan's total and approved once (rule 14), and label each take Enhanced/Raw like Make's. Done when: the switch shows in the board bar when a placed image/video card is selected (v14); the plan prices enhancement per step; the approval covers it; tests prove the approved total equals what's shown, and that nothing is enhanced or charged with the switch off.
- **Teammates editing boards** (from #667, owner 11 Oct): next, with a "this changed since you opened it, reload" rule; no silent overwrite.
- **Delete the old interface** (owner, 12 Oct). Planned now, not built until its trigger. **Trigger:** #665 (v14 for everyone) has been live in production and stable for 7 days, meaning no rollback, no switch-off of a customer workspace, and no open regression traced to v14. **Then:** a NEEDS AKSHAY PR that deletes the old interface code and the new-interface switch (`lib/newInterface.ts`, the per-workspace `ni_off:` rows, the global switch in /admin › Site), so only one design exists in the app. **Scope to plan:**
  - the old shell and screens that v14 replaced (the graphite workbench screens, Studio and old Home);
  - their style sheets, which the one-design guard's allow-list then shrinks to zero;
  - the specs that only test the old screens, deleted with them (never weakened). Guard specs that name the switch get the owner's direct word before any change.
  - docs/old-design-inventory.md, emptied.

  **Done when:** no import of the switch remains; the one-design guard's old-sheet allow-list is empty; the five-minute test (v14) and the full suite pass; and screenshots at the five sizes show only v14.
- **Board ids unique across members** (from the #667 review): a teammate's save that names another member's private board id creates a separate copy under their own key, the same as on release/1. If both are later shared, a plain `?id=` link opens the newer one, though the header still names the real maker. Fix: refuse a new save whose id another member already uses, with the unknown-id answer.
- **Who sees Atomik chat steps** (owner, 12 Oct evening). In the approvals queue, members see only their own Atomik chat steps. A workspace admin sees another member's step only when it needs an admin's approval (e.g. the over-200 cr rule from #670), and then only its title and price, never the chat. A small NEEDS AKSHAY PR with an Opus privacy review, after #681 merges.
- **Uploads access** (owner, 12 Oct): a member opens an upload only if they uploaded it, or it's on a board shared with the team, or production or shared work already exposes it. Being built by lane C, NEEDS AKSHAY, with an Opus privacy review.
- **After #681 merges, from the #680 review** (12 Oct):
  - `lib/workAccess.ts`'s `projectMaker` scans and parses every draft on each non-admin check. Swap it for #681's indexed `ownsDraftProject`, so "maker" has one definition.
  - `POST /api/shots` lets any member add shots to any project, a private board's included. Gate it with #681's private-board rule.
  - `POST /api/projects {productionId}` lets any member add a project to any production, a private board's included. Under #681 that would list the production, under the private board's name, to everyone. Gate it with the owner-or-admin rule (#680 round-2 review). Related owner question: in a production holding several people's boards, may any one board's owner rename it or mark it delivered?
  - Setting an element's current version (`app/api/rig/attributes/[id]/current`) clears approvals on takes in other people's shots. Decide whether that side effect should follow the owner-or-admin rule.
- **The phone's Plan & credits page still shows the old plans** (found in the #665 shots, 12 Oct). On phones, Settings › Plan & credits reads "Studio · $49 a month" with Change plan; the desktop shows the owner's final plans from #661 (Explore, Create, Master; Individual/Business). Bring the phone page onto the same plan display, with the owner's yes on screenshots.
- **The workbench warm-up** (`tests/workbench.warmup.ts`, #682) still writes the old `newInterfaceWorkspaces` key, which #665's switch ignores. Harmless; tidy it when #665 lands.
- **Retired plan prices on /billing** (from the #683 review): `components/commercial/BillingClient.tsx:217` still shows a Studio subscriber a "$49 / month" card. No workspace can hold that subscription while checkout is closed. Retire it when checkout work starts, to keep the owner's "no Studio · $49 anywhere".
- **"Current plan" on phones** comes from the subscription alone, while desktop also honours an admin's plan label (#683 review). Display only; align when the phone page next changes.
- **Copy-link nudge, option (c)** (owner, 12 Oct 21:05): "Copy link" on a private board offers "Share with team" first. A small UI follow-up after #681.
- **A disabled member's shared board** (#681 review nit): `draftIsTeamShared` and `projectLister` (`lib/draftProject.ts`) don't require the maker to be active, while `sharedBoardOfProduction` does. So the board stays listed and readable while `?reach` says it can't be opened. Inconsistent, but nothing new leaks. Align them.
- **Admission's agent exemption** (#685 review): `lib/generationAdmission.ts` treats every `agent:*` or server caller as reaching any project. Today only `/api/generate` calls admission, with a person or token, so this can't be reached. Before any server-side run calls admission, resolve the run's owner and check that person's reach.
- **Over-line steps in workspaces not billed in credits** (#688 review): `priceOf` returns null when the workspace isn't in credits, so an admin never sees another member's over-line step there. If those workspaces have a dollar over-line rule, the admin's tap can't be reached from the queue.
- **Flake: `demo-int-board-everyone-workbench.spec.ts:62` at 1920x1080** ("Make sits left of the board's dock"). It failed once in #688's CI (run 38312050459) and passed 5 of 5 locally on release/1 and on the branch. Likely the panel was measured mid-animation. Root-cause it when it recurs.
- **Flake: `demo-s10-phone-make-workbench.spec.ts:59` at 360x640** (`phone-make-go` data-spend "priced" where "unpriced" is expected). It failed once in #668's CI, and with --repeat-each it fails 8-9 of 10 on release/1 0ebd6eb4 too, so state carries between repeats. Not #668. Root-cause it in a small PR.
- **Flake: `enhance-house-v12-workbench.spec.ts:37` at 1440x900** (waits 5 min for the Enhance quote request). It failed once in #686's CI (run 38347765648) and passed on the rerun. #686 doesn't touch Enhance. Root-cause it if it recurs.
- **`board-kinds-v12-workbench` "the kind label cycles…"** looks for toast id `toast`, but the real id is `v12-toast`. It fails the same locally on release/1 (lane A, 13 Oct). Find out why CI doesn't catch it, then fix the spec's selector (not a guard).
- **The owner export includes other members' private-board work** (takes, shots, uploads; noted in the #698 review). It is pre-existing on release/1. Under the owner's 13 Oct point-4 change (admins may open any board in their workspace, and the work belongs to the workspace), the workspace owner exporting all boards is consistent, so it is not a leak. Confirm with the owner when the admin-access PR (board sharing PR 1) lands, and make the export's description say "all boards in the workspace".
- **House price words without an explicit mode** (from the #701 review): about 76 wording calls render credits on the server, then flip to dollars in the browser. That's a brief "cr" flash and a hydration mismatch, house only, with no cross-workspace effect. Thread the session's unit through those callers.
- **Flake check: `dots-centred-workbench.spec.ts:45` at 1920x1080** ("board-header-cast: dots drawn": no bright pixels found). It failed in #691's CI run 38389815513 but passed in #703's run on the same release/1 commit. If it recurs, make the capture wait for the header icon to be painted (#695's own spec).
- **Claude Design round: the docked Atomik panel shows two filled primaries** ("Show me looks · N cr" in QuestionsBlock.tsx, "Draw the storyboard · N cr" in DrawStoryboard.tsx) on a fresh board, against the "one filled primary per screen" rule. With the v15 "changed since" bar it can be three. v15 draws no such panel. This needs a design decision (which one is the next step), then a small PR; the spend-buttons guard applies to both.

- **(14 Oct, from #712; Opus checked 17:37: NOT A LEAK) Raw account ids in same-workspace responses:**
  - `createdBy` (`lib/jobs.ts:253`) and `userId`/`actorId` in notes, chat, shots, identities, atomikDocs and the audit reach only members of the same workspace. No name or email can be derived from them, and the id grants nothing (`team/[id]` masks the resolved target).
  - The platform owner's random `usr_*` id does appear in client workspaces, which only partly honours `supportMemberId`'s "doesn't follow the account" intent.
  - Optional hardening: a viewer-aware `storedAccountIdMaskHere` applied at the response boundary (not in `rowToGeneration`), plus tests in `platformOwnerPrivacy.spec.ts`. The owner decides.
- **(14 Oct 17:37) Side bug, small, privacy:** `lib/starter.ts:123` writes `review_by = createdBy` (an account id; the caller passes `auth.user.id`, `app/api/workbench/projects/route.ts:122`) where every other writer stores a display name.
  - Effect: the starter's approved take shows `reviewBy: "usr_…"`. If a member other than the owner seeded it, a guest on a legacy review link also sees the id.
  - Fix: pass `{ id, name }` and store the name. Test: seed as a member; `reviewBy` and `approvedBy` equal the name, never `/^usr_/`. Server-only; Opus review.
- **(14 Oct 17:34, #712) Takes from before metering are repriced at read time:** `lib/creditSql.ts:5-25` prices takes that have no receipt with today's `margins()`, although its own comment says history must not be repriced. A margin change would change what old takes show. Money: needs the owner.

## Housekeeping rules (owner, 12 Oct)

1. `design/` keeps only `particl-prototype-14` (the design) and `particl-prototype-12` (reference). Older prototype versions are deleted in a small design-files-only PR (#673 removes `design/particl-graphite`).
2. The old interface is deleted 7 days after #665 has been live and stable (see Follow-ups).
3. Droplet hygiene: at the end of each work session, remove finished worktrees, unzipped prototype copies and any test servers, and never leave processes running. Report free disk space (`df -h /`) in each status.

## Owner decisions (Akshay, 12 Oct morning)

1. **Deploy:** the owner merged #671 into main (a merge commit) and is deploying in Coolify. On "deployed", the lead runs read-only post-deploy checks: health/readiness, the sign-in page, the Make price with Enhance on and off, model menus listing Claude, OpenAI, Grok and Gemini, Credits & billing from the avatar, no "Moleculr", and the Google button hidden. No paid generations.
2. **Port 8765:** the owner killed the server. Lanes never bind 0.0.0.0; 127.0.0.1 only.
3. **Guard changes, the owner's direct yes to all five:**
   - #661: the publicSitePages guard says "Business".
   - #661: remove the stale CreditsBilling.tsx exception in tests/helpers/paidRoutes.ts.
   - #665: the five-minute test is rewritten for v14 (lane A's draft).
   - #664: the one-design guard names v14 as the design, with v12 kept as reference.
   - The money export spec (r1-port-credit-units-workbench) pins its seed time.
4. **Merges into release/1** (green CI plus a fresh review of the final head): #664, #667 (view-only), #670, then #661, then #654, #655 and #656.
5. **#670:** one press is one job for the 200 cr line. The house is NOT exempt.
6. **#668 Platform console:**
   - Yes to the platform_audit table. It's a migration, so it ships in the next deploy after the owner's backup.
   - Build the grant_budget_usd monthly cap next.
   - Invites: an "All" filter comes later.
   - Stays NEEDS AKSHAY.
7. **#669 Workspace settings:** narrow /api/usage?rows=1 so members see only their own rows. Stays NEEDS AKSHAY.
8. **#665:** once #661 is in, send screenshots of a non-house workspace and wait for the owner's yes.
9. **Remotion scaffold:** no, not now.
10. **Pricing gaps** (the 25% spend flag; the internal flag's pricing override and margin exclusion): open items, NEEDS AKSHAY, after the console.
11. **Lanes:** keep 3 unless the owner says usage is above 50%. Never touch main, Coolify or deploys.

## Owner decisions (Akshay, 12 Oct midday)

1. **#667: option (a), corrected by the owner.**
   - The existing privacy test lines in `tests/suites-asset-link-workbench.spec.ts` are NOT changed. A sender's private draft, and its uploads, stays unreadable to teammates, exactly as the guard says.
   - Teammates may open, view-only, only boards that are shared in the workspace, never private drafts. No shared flag exists today, so #667 adds an author-set "Share with team" mark. It is private by default, and every existing board stays private.
   - A shared board shows its whole contents to teammates, including its script and uploads.
   - Adding a check that outsiders get nothing is fine (tightening).
   - **The UI (owner, approved):** "Share with team" is one item in the board's existing ⋯ menu and right-click menu, in v14 style. Its one-line tooltip reads "Teammates can view this board. Only you can edit it." No new screen or layout. It goes into the next Claude Design round. The PR includes screenshots of the menu item and of a teammate's view-only board.
   - #667 merges when green, after a fresh review, and goes in the deploy after the Google one.
   - (An earlier message that day chose "teammates see all boards" and a guard restatement. The owner withdrew it; it was never applied.)
2. **Uploads fix, as an extra safety layer.** A separate small PR, NEEDS AKSHAY, with an Opus privacy review. It must not loosen anything that works today. A member opens an upload only if:
   - they uploaded it; or
   - it is attached to a board shared with the team; or
   - it is referenced by production or shared work that already exposes it today.

   Uploads on a private draft, and unattached library uploads, stay the uploader's. Nothing ever crosses workspaces.
3. **Google deploy prerequisites:** `SELFHOST_BEHIND_PROXY=1`, `APP_ORIGIN` and `KEYRING_SECRET` are confirmed in production. The owner set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in Coolify (production only).

## Owner decisions (Akshay, 12 Oct 15:45 IST)

1. **#674:** the owner merges and deploys; the Google test follows.
2. **The live team-canvas hole: YES, build the fix now.**
   - A private board's team canvas, and its listing, are owner-only.
   - Teammates get access only once the board is shared.
   - It must merge before the owner invites any testers. The lead merges it on green CI after an Opus privacy review.
3. **Changing others' work:** only the board's owner or a workspace admin may rename, move, approve, trash, restore or delete takes, shots and projects.
   - Deleting a project: the owner or an admin.
   - API tokens follow the same rule as the person who created them.
   - NEEDS AKSHAY, Opus review.
4. **#675:**
   - Old uploads with no uploader stay open.
   - **A deleted private board's takes (and identities) stay PRIVATE to their owner, not shared.** Change this.
   - Published references and shot presets keep sharing.
   - Keep the owner-only export.
   - The setup-only test edits are confirmed.
   - It ships with #668 in a migration deploy after the owner's backup.
5. **#667:** sharing a board is person-only. Keep.
6. **Repeated answers:**
   - #669's tightened privacy tests are approved.
   - #668: yes to the audit table; build the grant cap after the current merges.
   - Plans: Explore is the sign-up default, with NO automatic monthly credits; Studio, Agency and Production stay hidden.
   - The pricing gaps (the 25% spend flag, the internal flag) come later, NEEDS AKSHAY.

## Owner decision (Akshay, 12 Oct evening)

- Google sign-in is tested on production (invite → Google → joined; plain /login with Google). It stays in Google's **Testing** mode. The owner publishes it once the privacy fixes are live (#681, the canvas hole; the owner-or-admin rule for changing others' work) and before inviting outside testers.

- #681 (the private canvas): merge when green (owner, 12 Oct evening).

## Owner decisions (Akshay, 12 Oct 21:05 IST)

These answer the lead's 21:00 status page.

1. **#681, private-board canvas: option (b).**
   - A copied link to a take on a PRIVATE board shows "a production you can't open" until the owner shares the board. Once it's shared, the link opens view-only.
   - "My direct word: change the take-link privacy guard test to require (b). It's a tightening."
   - (c), offering "Share with team" when copying a link on a private board, is a later small UI follow-up.
   - Merge #681 when green. Top priority tonight.
2. **#680, only the owner or an admin changes others' work.**
   - The setup-only change to the rule-14 guard `demo-gaps-l4-people-only`: "my direct word, yes". No check weakened.
   - Yes to the setup-only edits in never-delete, studioRoutes, mediaMutation, appPagesAuditDb, takesReviewRoute, mediaBindings and shot-filing.
   - Projects with no recorded creator (e.g. the starter) are admin-only. No creator column and no migration now.
   - A production holding several people's boards can be renamed or marked delivered by workspace admins only. Each person manages their own boards.
   - Fresh review on the final head, then merge when green.
3. **#665, v14 for every workspace.**
   - Yes to a small PR making the PHONE plan page match the desktop: Explore $50/500, Create $100/1,000, Master $250/2,500; Business 100/250/500 per seat; Enterprise "Get in touch"; no "Studio · $49" anywhere.
   - Five-minute test: "my direct word, swap the laptop journey to the v14 journey (your 12/12, 7-tap version)".
   - The owner reviews the #665 screenshots and says yes separately, so #665 stays NEEDS AKSHAY.
4. **Sample production:** read-only for every viewer. A small PR, merged when green.
5. **Approvals queue (next build, after #681):**
   - Members see only their own Atomik chat steps.
   - Admins see another member's step only when it needs an admin's tap (e.g. over 200 cr), and then only its title and price.
   - NEEDS AKSHAY, with an Opus privacy review.
6. **Order tonight:**
   - a) #681, #680, sample read-only, then the phone plan page. Each merges into release/1 when green, after a fresh review.
   - b) #654, then #655 and #656, one at a time.
   - c) When release/1 is green with #681 and #680 in, open DEPLOY #2 (deploy/2026-10-13 → main), not merged. List its contents, its migrations (MUST be none) and its env names.
   - d) Bring #675 up to date and review it, ready for deploy #3.
7. **Deploy #3** (the migrations, #675 and #668) is tomorrow morning, after the owner's database backup with their advisor. Prepare its PR only once deploy #2 is live.
8. After deploy #2 is live and the owner has checked it, the owner publishes Google out of Testing and starts inviting testers. Not before.
9. **Usage:** stay at 2 lanes. Sonnet does builds; Opus reviews only money, privacy and sign-in. If the owner reports usage above 75%, drop to 1 lane.
10. **Rules unchanged:**
    - Never touch main, Coolify, Cloudflare, DNS or deploys.
    - No paid generations, and no secrets anywhere.
    - Test servers run on 127.0.0.1 only.
    - Clean up worktrees and temp files at the end of the session.

Status by 09:00 IST: what merged (real PR numbers and commits), deploy #2's PR number and contents, what's NEEDS AKSHAY with the exact yes or no needed, CI state, and disk.

## Owner decisions (Akshay, 13 Oct 09:50 IST)

1. Yes to #685's import-list edits, including moneyRoutes. Merge #685, then move deploy/2026-10-13 (#687) to the new green release/1 head and update #687's description (contents, migrations must be none, env names). Tell the owner when #687 is green.
2. #688:
   - Yes to the setup-only seed change in noVendorCostToCustomers.
   - Yes to the Activity change and the restated tests.
   - Admins may approve another member's over-line step and see its prompt, not the chat.
   - Merge when green after a fresh review. It goes in deploy #2 if green in time, otherwise the next.
3. Yes to the privateCanvas sample tightening in #686. Merge after #685, and include it in #687 if green in time.
4. Admins: no access to other members' private boards.
5. Yes, hide private boards' takes (the takes list and MCP tools) from everyone except the owner. A small PR, with an Opus privacy review.
6. #665: retry the five-minute test swap; the owner approves the permission prompt in the lead's window. Hold #665 until after deploy #2 and the owner's screenshot review.
7. #668:
   - Yes to adding batch to publicLinkOrigin's stand-in.
   - Yes to adding 'admin' to ShellView in r1OldPagesLinks.
   - Deploy #3 (#675 + #668) is this afternoon, after the owner's backup. Prepare its PR once deploy #2 is live.

## Owner decisions (Akshay, 13 Oct, after 09:50)

- **Point 4 changed:** "admins CAN open any board in their own workspace (view, and edit if they choose), and can transfer a board's ownership when a member leaves — the work belongs to the workspace. Members still can't see each other's private boards. Never across workspaces."
  - The lead's plan: deploy #2 ships as built, fail-closed (admins have no access to others' private boards). Admin access and ownership transfer follow in their own PR after deploy #2, with an Opus privacy review.
  - The private-takes PR already lets admins see takes.
  - #675's upload rule follows board reach for admins once that PR lands.
- **New priority build after deploy #2** (before testers if possible, before the investor demo at latest):
  - "Share with team" offers "Can view" or "Can edit".
  - Can edit means teammates edit the same board together, live, on the existing Liveblocks setup, with no silent overwrites.
  - Defaults: in Business workspaces new boards are shared · can edit; in Individual workspaces they are private.
  - NEEDS AKSHAY, with an Opus privacy review. Plan it now, build after deploy #2. Any new screen element goes through Claude Design first.

## Owner decisions (Akshay, 13 Oct late morning): board sharing

- **Answers to the four questions** (docs/plans/board-sharing.md):
  1. An admin opening a private board is logged in the audit AND shown to the board's owner in the board's history ("Viewed by <admin>, <date>"). No notification.
  2. Yes: "Can edit" teammates may render (same caps and 200 cr rule). Client review links stay with the owner and admins only.
  3. Legacy Studio, Agency and Production plans default to private.
  4. Yes: admins see members' private boards in a separate "All boards" view, not on Home.
- **Update, which supersedes the two-stage split:** "the investor demo is pushed; quality comes first. Build the full board sharing plan (all 10 PRs, including live co-editing on Liveblocks) properly, one small PR at a time, each with tests and Opus privacy review — no shortcuts for speed."
- **Order:** deploy #2, then the owner's backup and deploy #3, then the board-sharing PRs.
- Any new screen element goes through Claude Design first. All of it is NEEDS AKSHAY with an Opus privacy review.
- **Usage:** 2 lanes until tomorrow's 13:30 reset, unless the owner says otherwise.

## Owner decisions (Akshay, 13 Oct 12:50)
- Deploying #687 as it is (merged to main 925116fb).
- Yes to #690's studioRoutes import line.
- **Deploy #3** = #675 + #668 + #686 + #688 + #690, whichever are green on release/1.
  - Pin it BEFORE #691 merges.
  - List its contents, the two migrations (#675's uploader_id column, #668's audit table) with what each changes, and the env names.
  - Don't open it until the owner says deploy #2 is checked.
  - After deploy #3 is pinned, merge #691.

## Owner decisions (Akshay, 13 Oct afternoon, from the deploy #2 check)
1. Board sharing: the brief is that teammates EDIT together. The live "view only" is #667's interim step.
   - The "Can edit" PRs move to the FRONT of the queue right after deploy #3.
   - Business workspaces default to "Shared with team · Can edit", with the "changed since you opened it" protection (v15).
   - Until then, the live tooltip reads "Editing together is coming next — for now teammates can view." A small PR, which can ride in deploy #3.
2. Bug: the ⋯ button's dots sit left of centre. Centre the icon in every ⋯ button app-wide, with screenshots before and after. Can ride in deploy #3.
3. Bug: mixed units on one screen (house: "Ask · up to $0.743" beside "8 cr" in the Atomik panel). One screen, one unit, and the house uses the unit its rule already uses on every board price, the Atomik panel included. Dollars are shown with 2 decimals, always rounded UP ($0.743 → $0.75). Money display gets an Opus review. Can ride in deploy #3 if green.
- Deploy #3 = #675, #668, #686, #688, #690, plus these three if green. Tell the owner when it is pinned; the owner does the backup first.

## Owner bug and rule (Akshay, 13 Oct afternoon): deleting cards, undo
- **Bug** (production, house workspace, as owner): cards can't be deleted on the board canvas or in the Rig. First explain WHY (a never-delete rule, #680's check misfiring, or a missing control) before changing anything. If the never-delete guard blocks it, show the exact guard lines for the owner's word.
- **Delete:**
  - The board's owner, a "Can edit" teammate (once that exists) or an admin removes a card from the canvas and the Rig via Delete/Backspace, right-click › Remove and ⋯ › Remove. Multi-select works.
  - Removing shows "Removed · Undo" (a shortcut, not a time limit).
  - A paid take is never destroyed: it goes to the board's Trash (restorable any time) and stays in billing history and the Library. Only empty or unpaid cards (notes, text, frames) are actually deleted.
- **Undo:**
  - Every board keeps a session-long undo history (at least 50 steps). ⌘Z / Ctrl+Z undoes, ⌘⇧Z / Ctrl+Shift+Z redoes.
  - Removing is one step like moves, edits and adds.
  - With Can edit, each person's undo covers only their own changes.
  - Undo never changes billing: no refunds by undo.
- Tests for delete, undo/redo and Trash restore, plus screenshots before and after. Can ride in deploy #3 if green, otherwise the next deploy.

## Owner rule (Akshay, 13 Oct afternoon): one board, four lenses
- **The rule, from now on:** every view (Canvas, List, Strip, Rig) shows the SAME content of the current stage, arranged differently. No view may ever be empty while another has items.
- **Bug** (production, Skoda board, Script stage): Canvas showed nothing while List showed the beats. Fix: Canvas renders script beats as text cards, in order.
- **Defaults:** each stage opens in its natural view (Script → List; Storyboard, Shots, Cast and Elements → Canvas; Cut → Strip). The person's manual switch is remembered per board.
- Audit every stage × view and list the findings before fixing. Tests and screenshots. Can ride in deploy #3 if green, otherwise the next deploy.

## Owner decisions (Akshay, 13 Oct 13:55)
**A. Delete, undo, Trash**
1. The board was "Skoda", the owner's own house board, not the sample. In List, beats can be deleted one at a time; on Canvas and in the Rig nothing can be deleted. That's the bug. **The sample stays editable for its owner and for the platform owner; it is read-only only for other viewers.** Check #686 does this before deploy #3.
2. Delete everywhere: Delete/Backspace, right-click › Remove and ⋯ › Remove, on Canvas, List and Rig, for the board's owner, a Can edit teammate (once that exists) or an admin. If a never-delete guard blocks this, show the exact lines first.
3. Multi-select:
   - List: a tick box on each row (appears on hover, stays once one is ticked), "Select all", and a bar "3 selected · Remove · Cancel"; Shift-click selects a range.
   - Canvas and Rig: drag a box, or ⌘-click.
4. EVERYTHING removed goes to the board's Trash, paid or not (takes, frames, looks, identities, beats, notes, text), restorable any time. Paid items keep their billing record; undo and restore never touch billing.
5. Undo with no time limit: a session undo history per board (50+ steps), ⌘Z / Ctrl+Z undo, ⌘⇧Z / Ctrl+Shift+Z redo. Removing is one step. The "Removed · Undo" toast is only a shortcut. With Can edit, each person's undo covers only their own changes.
6. The Trash screen, and the List tick boxes with the selection bar, go to Claude Design (next round). Build now: delete on Canvas and Rig, the multi-select logic, undo/redo, and Trash server-side. Tests for delete, multi-select, undo/redo and Trash restore.

**B. Remotion (plan only; don't build yet)**
1. Adopted on the Free License (SensAI = 3 people total; the owner is confirming in writing with Remotion). Rendering is self-hosted on our droplet only (no Remotion Lambda/AWS), with only our own templates (users never upload Remotion projects). At 4 people the Company License must be bought; this goes in CLAUDE.md.
2. Price rule: Remotion exports are FREE to customers (0 cr, button "Free") for as long as Remotion charges us nothing. Paid engine steps inside an export (VO, a regenerated shot) are priced as usual. If the licence ever costs us, the owner sets the new price; never add one.
3. Protect the server instead of charging:
   - a separate render worker (like the Blender/Astra worker) with its own limits, starting around 3 CPU / 6–8 GB, 2–3 frames in parallel, no GPU;
   - a queue, with a fair per-workspace limit on exports at once and per hour ("Export queued — 2 ahead of you");
   - measure a real 30 s 1080p export and set the limits from it.
4. First uses: captions on a cut, title and end cards, 16:9 ↔ 9:16, 6/15/30 s cutdowns, final MP4. Later: Export to Premiere/Resolve (XML + media) and a multi-track timeline.
5. The server parts need no design. Every new screen element (Export button, caption styles, format picker, timeline) goes to Claude Design first.
6. The plan lives in docs/plans/remotion.md, with the exact Coolify steps for the owner. The build comes after deploy #3 and the board-sharing PRs. NEEDS AKSHAY.

## Owner answers (Akshay, 13 Oct ~15:50)
1. Remotion licence key: pass licenseKey "free-license" on every server render (it declares Free License eligibility; per Remotion's docs, with no key nothing is sent, and with "free-license" only successful-render events are sent). Note it in CLAUDE.md next to the licence record. Confirm that nothing sent contains customer content.
   - The lead is checking this against the worker's no-egress design before changing anything.
2. Make's results grid shows only takes made in Make. Do it without a new column if possible. If it needs a "made in" field, that's a migration: not in deploy #3, queued for the next migration deploy.
3. Cut stage: opens in Canvas until Strip is built, then in Strip.
- Deploy #3: pin when release/1 is green (adding #695 and #696 if green within the hour), open the PR, and send its contents, both migrations (what each changes, and whether each is safe to roll back) and the env names. The owner takes the backup, then merges.

## Owner decision (Akshay, 13 Oct ~16:10): Remotion licence key
- **Option D:** send NO key and NO events to Remotion. This is allowed under the Free License: server-side with no key, nothing is sent. The worker stays sealed, with no internet.
- **Pin to 4.x.** Before any upgrade to 5.x, flag it to the owner (5.0 may require a key): NEEDS AKSHAY.
- **CLAUDE.md:** "Remotion: Free License, confirmed by Remotion 13 Oct 2026; no licence key, nothing sent to Remotion; pinned to 4.x."
- **Everything else as decided:**
  - the worker's network is like Blender's;
  - limits: 3 CPU / 8 GB, 2 in parallel, 1 per workspace, 6 per hour;
  - #700's migration ships in a later deploy.

## Owner decision (Akshay, 14 Oct 17:08 IST): board design freeze, v17 → v18
Verbatim: "Design freeze on the board UI: I'm redesigning the board in Claude Design (v17 → v18: Atomik column removed, one right-hand context panel replacing the toolbar, centred bottom bar, per-stage settings). Until I approve the final prototype, do NOT build or change board UI: bottom bar, right toolbar/panel, Atomik column, lens switcher position, or stage options. Finish and park any in-flight UI PRs as-is (e.g. four-lenses PR 2) — no new UI work on them. Keep going on server-side work that doesn't depend on the screens: deploy #3 support (backup steps for me), board sharing server PRs, Trash server, Step 0 data plan (job label per take, structured reject reasons, user ids for pick/approve, billed credits on the take), and the provider adapter plans (Runway, Sarvam, sync.so, AWS Rekognition) as registry tools — plans first, no paid calls. Status with real PR numbers."

How the lead applies it:
- **Parked (as they are, no further UI work):** #709 four lenses PR 1; four lenses PR 2 (opened as a draft); #707 delete on the board (its record-to-Trash-first correctness fix is finished, then it parks); undo/redo (`feat/r1-undo`); the board-sharing screens (share submenu, card state icon, real initials, changed-bar polish, transfer and All boards); the Claude Design round items for the board.
- **Continues (server only, no visible board change):** board sharing #702 #704 #705 #708, 8b (compare-and-set on save; uses #708's existing changed bar, no new UI), plan PRs 1, 2 and 4 server parts; Trash server #698; the Step 0 data plan; the provider adapter plans; deploy #3 backup steps.
- **Not board UI, so not frozen:** #701 house units (price wording) and #706 Make's grid. Both were approved before the freeze.
- Anything that would need a new or changed board element stops and is logged as waiting for v18.

## Owner answers (Akshay, 14 Oct evening, recorded 19:15 IST)
Verbatim:
1) #704 guard: yes, on the condition that Opus confirms the newly allowed file only closes live rooms and reads nothing new. Quote this line in the PR.
2) #715 guard move: yes (my 13 Oct rule). Keep other workspaces and plain members refused. Default confirmed: an admin can't start renders on a member's private board. #718: undo has no time limit — confirmed.
3) #716 then #717: merge on green.
4) Deploy #4 = board-sharing stack (#702, #704, #705, #708, #713, then #715, #718) + Trash #698 + Remotion #700 (switch off), one backup-backed deploy, prepared only after deploy #3 has run cleanly for 24 h.
5) #712: job label = A (purpose) AND add the shot type (the recipe: face close-up, pack shot, dialogue, motion transfer, product reveal, etc.) as a second label, e.g. params.shot — Particl Auto routes on it. Other recommendations accepted, including approving takes people-only.
6) #714: order accepted (lip-sync via fal → Sarvam → Rekognition → Runway standby, house only until training-free terms). Voice cloning: not now. Counsel before any customer switch. ADD to the plan: Recraft (raster, vector, vectorize, remove background), Black Forest Labs FLUX.2 (create + multi-reference edit), Google Cloud Vision text detection (GOOGLE_VISION_API_KEY is set), and a Topaz direct vs fal price comparison. Give me the exact Coolify setting NAMES per provider (names only; AWS names distinct from anything R2/S3 reads).
7) Older questions: removing a frame removes its beat (into Trash); Make grid = mine by default with an "Everyone's" filter; Remotion worker network = relay (c); pre-metering takes marked "estimated", no repricing; hide my account id in client workspaces — yes.
8) Design decisions to RECORD only (no building during the freeze): three lenses — Board, List and Rig (Rig stays for customers). Timeline is not a lens: it is the Edit stage. "Cut" is renamed "Edit" and the animatic is its first step (storyboard frames on the timeline, replaced by shots as they render). "Map" as a name is dropped; the node view keeps the name Rig.
9) NEW PRIORITY — Vercel out, server-side, runs during the freeze: plan PR first, then small PRs. (a) Remove dead weight: @ai-sdk/gateway, unused @ai-sdk/* and type-only 'ai' imports, @vercel/oidc, @vercel/sandbox, vercel.json, lib/gateway.ts, lib/engines/vercel.ts, lib/vercelKeys.ts, public/vercel.svg (list every importer first). (b) Replace Atomik's ToolLoopAgent (lib/workbench/rig-agent-planner.ts) with our own tool loop on the provider SDKs already wired — or fold into the LangGraph.js plan (#553); tell me which is smaller and safer; Opus money review; mocked tests. (c) Vercel Blob: report what still lives only on Blob, copy to R2, verify every take/upload/identity opens from R2, then remove @vercel/blob — nothing deleted from Blob without my yes. Keep a guard that fails if Vercel ever comes back.
Real PR numbers in the status page.

How the lead applies it:
- **Item 8 (record only):** the lenses become Board · List · Rig (three; "Canvas" in code and plans is "Board" in the UI; "Strip" and "Map" are dropped as lens names). The Edit stage (renamed from Cut) holds the timeline, and its first step is the animatic. Nothing is built until v18. When built, UI-copy changes follow the UI-names guard.
- **Item 9 is the new top server priority**, after merging what's green.
- **Production storage:** copying Blob to R2, and any inventory of production storage, needs production keys. The lead and lanes never hold them, so the plan gives the owner (or advisor) the exact, read-only and copy-only commands to run. Nothing is deleted from Blob without the owner's yes.

## Owner amendment (Akshay, 14 Oct, 19:29 IST): #714 providers (replaces item 6 above)
Verbatim: "6) #714: order accepted with one change — lip-sync goes DIRECT through sync.so (I'm buying the account; not via fal), including lipsync-2-pro and sync-3. Then Sarvam direct (I'm buying the account), then Rekognition, then Runway standby (house only until training-free terms). Voice cloning: not now. Counsel before any customer switch. Delete the vendor's copy once we've stored the output (sync.so DELETE, Sarvam retention 0). ADD to the plan: Recraft (raster, vector, vectorize, remove background), Black Forest Labs FLUX.2 (create + multi-reference edit), Google Cloud Vision text detection (GOOGLE_VISION_API_KEY is set), and a Topaz direct vs fal price comparison. Give me the exact Coolify setting NAMES per provider (names only; AWS names distinct from anything R2/S3 reads)."

## Owner answers (Akshay, 14 Oct, 20:40 IST)
Verbatim:
1) Standing rule for import-pinning tests: YES — adding an entry is allowed when no assertion is loosened, the PR names the module, and Opus confirms it adds nothing the test is meant to catch; quote this rule in each PR. Removing an entry or loosening any assertion still needs my direct word. This unblocks #704, #708, #713, #715, #717, #718 (incl. Moleculr routes).
2) #704: the two internal lookups (Can-edit board list, their room numbers) within the same workspace, returning nothing, meet "reads nothing new" — yes.
3) #718: yes, a new owner may open the uploads that are ON the transferred board; not the previous owner's other uploads.
4) Merge on green: #720 then #721; #722 including its operationalHealth.spec.ts edit (it makes the public response stricter); #723 with tokens blocked from un-approving — yes.
5) #719 Vercel out — all yes: (1) our own small tool loop; (2) retire 'ai' entirely; (3) text prices from the checked-in list, sourced from each provider's published pricing page, refreshed by a script and reviewed by me monthly; (4) yes per PR for moved tests; (5) I'll revoke leftover gateway keys in Vercel — give me click steps; (6) 3D on our own workers only; (7) cutover after deploy #4 is stable, 7-day watch, Blob kept read-only 30 days after cutover, deletion only with my yes; (8) update the privacy page wording; (9) no more preview deployments — staging is the preview. FYI: Vercel project particlstudio has NO production deployment (checked in the dashboard), so no Vercel cron can run; Git is already disconnected; I'm deleting its old previews.
6) #712: A) params.shotType — yes. B) the 13 types = exactly the shot recipes: Establishing wide, Emotional close-up, Product reveal, Pack shot, Talking to camera, Walk and talk, Action beat, Detail, Over-the-shoulder, Aerial reveal, Slow-motion moment, Match cut, Custom. C) freeze "estimated" figures in their own table — yes.
7) #714: A) yes. B) FLUX.2 direct on the EU endpoint, training opt-out first — yes. C) sync.so: start on the plan I bought; tell me if Creator ($19) is needed for clip length. D) fixed rupee rate, reviewed monthly — yes. E) threshold 90, priced inside Verify, flags for a person, never blocks — yes. F) Sarvam for Indian-language transcripts; ElevenLabs speech-to-text (already wired) for the rest, Grok as backup unless you show Grok is clearly cheaper. G) yes. H) Topaz stays on fal — yes. I) leave sync-3's photo input out — yes.
8) Signed-in checks for deploy #3: I'm skipping them for now; your read-only checks stand.
9) Deploy #4: prepare from ~19:40 IST 15 Oct as proposed; I'll take a fresh backup first.
10) Design: the board freeze now waits for v21 (Agent mode + Director mode), which supersedes v18. Accounts for sync.so and Sarvam are bought; I'll add the Coolify settings by the names in #714.

How the lead applies it:
- Every PR that adds an entry to an import-pinned test quotes rule 1 and names the module, with an Opus confirmation in the PR.
- **The board design freeze now waits for v21.** Everywhere this plan says "v18", read "v21".

## Owner correction (Akshay, 14 Oct, 20:45 IST): #719 item 5
Verbatim: "Correction to 5): I'm NOT deleting particlstudio's previews one by one. They stay until the Vercel cutover is done; then I delete the whole project in one step. Add "delete Vercel project particlstudio" as the last step of the #719 cutover checklist, after the Blob→R2 copy is verified and the 7-day watch passes."

## Owner decision (Akshay, 14 Oct, 21:00 IST): Gemini safety settings
Verbatim:
- Set all four adjustable categories (harassment, hate speech, sexually explicit, dangerous content) to BLOCK_NONE on every Gemini call where the setting is supported. Google's own fixed filters stay as they are; we don't try to get around them.
- One shared config (e.g. lib/geminiSafety.ts) used by every Gemini call, not set per call. Add a test that pins it to BLOCK_NONE so it can't change silently.
- If Gemini still blocks something (its fixed filters): show the user a plain message, charge nothing, and log only the block reason, never the prompt.
- Model id comes from the routing table, never hard-coded. No model names shown in Agent mode.
- Add to the counsel list: Terms of use must say the customer is responsible for what they generate, plus a report/takedown process (India IT Rules).
- Owner-approved. Open the PR, Opus reviews, merge into release/1 on green. Never main.

### Counsel list (collected; before any customer switch or launch-wide terms change)
- Rekognition: biometric consent wording; whether similarity scores must be erased on withdrawal (against never-delete); Particl's DPDP Act role for a customer's cast; transfers to US vendors (#714).
- Voice data for Sarvam and sync.so (#714).
- **Terms of use (owner, 14 Oct 21:00):** the customer is responsible for what they generate; a report/takedown process (India IT Rules), given Gemini's adjustable filters set to BLOCK_NONE.

## Owner decisions (Akshay, 14 Oct, 21:55 IST)
Verbatim:

#715 (admin reach):
- All three must-fixes approved: (1) every admin read on a member's private board (Atomik chat, export of selected takes, single take) goes through the audited check; (2) no admin live-room access at all until the board design is approved and built; (3) admins can't start any paid work on a member's private board (the two Atomik writing tools refuse admins), tests stricter.
- Review Q1: admins may NOT create client review links on a member's private board. Only the owner can. Whoever creates a client link, the board's history says "Client link created by <name>", and the owner sees and can revoke active links.
- Review Q2: API and MCP tokens never get admin reach, read-only or not. A token acts as a plain member whatever its creator's role. Admin reach needs a signed-in admin. Add a test.
- Fresh Opus review again after the fixes; it stays in deploy #4 only if approved.

Guard deadlines (resending my 21:05 answer, my direct word):
- Fix the 20 server-side UI-names files on 15 Oct (real fixes). Don't delay deploy #4 prep.
- Move the remaining 11 screen entries' expiry to 30 Nov 2026, on these conditions: no new entries without my word; each entry is removed in the PR that rebuilds its screen; before moving the 8 spend-button entries, Opus confirms each button still goes through quote + person approval (any that fail get fixed, not extended); the status page shows the remaining count until 0.
- The guard-helper change: approved only if it loosens no assertion and adds no exception. In the PR, say in one line what it changes, and have Opus confirm. If it loosens anything, stop and ask me.

Merges on green into release/1 (never main), each after a fresh Opus approval:
- Step 0: #724, #726, #729, #732.
- Migrations #728 and #731: only if additive (new tables/columns, nothing dropped or renamed, nothing repriced), with the rollback steps written in the PR, and run on staging first. They ship in deploy #4 after my fresh backup.
- #725 and #727, after the guard-helper change lands, and only once: tests block all real network calls (my 20:50 condition) and #725's deadline is tied to the cutover.

## Owner addendum (Akshay, 14 Oct, 22:00 IST) to the 21:55 decisions
Verbatim:
Guard-helper (tests/helpers/ratchet.ts): YES to comparing against the PR's base branch and accepting a later date only with an `extended` record, on these conditions:
- every `extended` record quotes my words with the date and time (e.g. "Owner, 14 Oct 21:55: …"); no record without my direct word in chat;
- an `extended` record can only move a date; it can never add an entry or raise a count (test for it);
- Opus checks every `extended` record in review.
Counts unchanged: 20 server-side UI-names files fixed by 16 Oct; the 3 UI-names screen entries and 8 spend entries move to 30 Nov 2026 under my 21:55 conditions (spend entries confirmed going through quote + person approval first).

#730 Gemini: don't patch the gateway path. Move those Gemini text calls (prompt enhance, Atomik jobs) to the direct Gemini client with the shared safety config, as part of Vercel-out. Removing GEMINI_IMAGE_MODEL: yes. After merge, send me a Droplet Console command that prints whether GEMINI_IMAGE_MODEL and GOOGLE_SAFETY_THRESHOLD exist in each Coolify app (names only), and I'll delete them.
"Model names in Agent mode" now waits for v22 (v21 went back with fixes).

#724 approved: merge on green. #729, #732: merge on green after their fixes and a fresh Opus approval.

How the lead applies it: the board design freeze now waits for **v22** (v21 went back with fixes).

## Owner decisions (Akshay, 14 Oct, 22:50 IST)
Verbatim:
1) #715 guard: YES. ADMIN_TOKEN moves from "sees private boards" to "hidden from" in privateTakes.spec.ts. It's stricter and follows my token rule. Quote this in the PR.
2) Client links: the board's OWNER can create a client link for their own private board, admin or not. Nobody else can make one on someone else's private board (admins included). History line "Client link created by <name>"; the owner sees and can revoke active links.
3) Migrations #728 and #731: a local run on 127.0.0.1 alone does NOT count. Test on a throwaway copy of production instead:
   - Tell me which database each migration touches (platform DB, tenant DBs, or both).
   - Give me, as one Droplet-free list I run on my Mac with the turso CLI tomorrow after my fresh backup: (a) the command to create a throwaway copy, e.g. turso db create mig-test-20261015 --from-db <db> --group <group>; (b) the exact command to apply each migration to that copy only; (c) read-only check queries that print table/column names and row counts, no data; (d) the command to destroy the throwaway copy afterwards.
   - Write the migration files into the repo (no secrets) so I can apply them by file.
   - Only after that passes do they ship in deploy #4. Rollback stays as written in each PR.
4) #738: YES to removing Gemini 2.5 Flash, 2.5 Flash-Lite, 2.5 Pro and 3.8 Flash from the menus, on condition that any saved setting or default pointing at them falls back to Auto with no error and no price change (add a test). The 8 moved tests: send me the list with one line each, and I'll give a yes per PR.
5) Noted: the GEMINI_IMAGE_MODEL / GOOGLE_SAFETY_THRESHOLD check command comes after #730 merges.
6) Deploy #4: prep from ~19:40 IST 15 Oct. I'll do the fresh backup first, then the migration test copy.

## Owner decisions (Akshay, 14 Oct, 23:35 IST)
Verbatim:
1) #742 + #743: ship in deploy #4 (no hotfix tonight; 2 workspaces, deploy #4 is <20 h away with a fresh backup). Fresh Opus review before merge.
   #743: YES to the split you offered: a board the person may READ (incl. a teammate's shared board) feeds Atomik context; spending, step filing and memory writes need "admit" (may file there). Someone else's private board gives neither. Add a test for each.
2) #738: remove all SEVEN from the menus for now. The extra three (3.1-flash-lite, 3.5-flash, 3.7-flash) leave because their price isn't confirmed on Google's page; we never charge on an unconfirmed price. Saved settings pointing at any of the seven read as Auto, same quote, no error (extend AUTO_MODEL_IDS + test). They return in a small PR when the price is confirmed. YES to the 8 test moves exactly as listed.
3) #715:
   a) Admins MAY revoke any client link in their workspace (never create one on someone else's private board). History line "Client link revoked by <name>", visible to the owner.
   b) Admin list views must NOT show other members' private takes without an audit line. Preferred: lists hide them; the admin opens the board (audited). If hiding breaks the control room or another admin screen, name those screens first, then write one deduplicated audit line per list view (same 15-min rule).
   c) Held or deleted boards: NO exception. An admin read is audited the same way.
   Fresh Opus review of #715 after these, as before.

## Owner instructions (Akshay, 15 Oct, 00:15 IST): overnight
Verbatim:
"I'm going to sleep. Keep working through the night within all standing rules, and have a report on the status page by 10:30 IST.

DESIGN
1) Prototype v25 (attached zip: "Particl app v25.html" + "Particl board v25.html" + sources) is approved and replaces v15 as THE design. Import it as design/particl-prototype-25 (design files only, no code) and update the one-design guard to name v25. v15 stays as reference until its screens are rebuilt. This PR may merge into release/1 on green + Opus review.
2) Write the first-version build plan (for my review in the morning): each PR in order (screen + server), smallest useful slice first; what each replaces; which steps need new server work vs screen-only; anything in v25 with no API/provider behind it today (be explicit); what's NEEDS AKSHAY (money, sign-in, migration, env, privacy). My proposed first slice: the Film board end to end in Agent mode, plus Director on Shots, plus Preview everywhere; Social narrated next. Tell me if the code suggests a better first slice.
3) You MAY start the first slice's foundation overnight (the shared top bar/app frame, the card component with the five statuses and ✓/✕, the stepper rail) behind the new-interface switch (house workspace only). Open them as PRs with screenshots at 1440/1280/1920 and an Opus review. Do NOT merge any v25 screen PR until I've approved the plan.
4) Carry into the build: the Brief card shows the brand tile twice; Home's sample counts and tabs must match the board's.

KEEP GOING
5) The 17 Oct deadline chain first: #734 → #736 → #735, then #720 → #721. Merge each on green into release/1 as already approved.
6) Then the other approved PRs on green, two in CI at a time: Step 0 (#724, #729, #732, #723, #726, #740), #730, #738 (with my 23:35 conditions), #742 + #743 (after a fresh Opus review, and #743 with the read/admit split), #715 (only if its fresh Opus review approves my 23:35 answers), #725, #727, #737, #739 (only after its money review approves).
7) Migrations #728 and #731: don't merge yet. Have the throwaway-copy test steps (turso CLI, run by me on my Mac) ready in the report.
8) Deploy #4 prep: the release notes, the exact list of commits/PRs going in, my backup steps, my migration-test steps, and the click steps for Coolify. Nothing deployed; I do that this evening.

LIMITS (unchanged)
- Never main, never deploy, never a paid generation (mocks only), never Coolify/DNS/Cloudflare/GitHub/firewall/SSH settings, never secrets in chat, code or PRs.
- Anything NEEDS AKSHAY stays open. No guard or safety test edited or loosened without my word.
- Cost: Sonnet for builds, Opus only for money/privacy/sign-in reviews and design-import review; at most 2 lanes building at once; no idle polling; on any usage or spend-cap error, stop all lanes cleanly and note it in the report.
- If something needs my decision, park it, move on, and put it in the report. Don't wait on it.

10:30 REPORT (status page), in this order:
1. Decisions needed from me, numbered, each with your recommendation.
2. What merged overnight (PR, one line each).
3. What's open and ready for me (PR, one line each).
4. The first-version build plan.
5. Deploy #4 checklist (backup → migration test → deploy steps).
6. Incidents or slips, if any.
7. /api/health summary and df -h /."

How the lead applies it:
- **Design:** v25 is THE design; the freeze now waits for the owner's approval of the v25 build plan (supersedes v18/v21/v22).
- **Parked, waiting for the owner's word, by the "park and move on" rule:**
  - #738 (the :184 line beyond the 8 listed);
  - #715 (two stricter privateTakes lines; the export decision);
  - #744/#745 (not in the merge list);
  - house style;
  - #740 (stacked on migration #728, so it can't merge without it).
- **Migrations in deploy #4 (#702, #698, #718, #700):** CI is run, but they are not merged until the owner's throwaway-copy test passes ("Only after that passes do they ship in deploy #4").

## Owner answers to the 15 Oct overnight report (15 Oct 2026, 10:45 IST, verbatim)
1) Deploy #4 = option A: release/1 as it is, no migrations, no new env. The migration set is deploy #5, after my copy test.
2) #746: YES to (a): exempt design/particl-prototype-25/ in demo-clean-slate-one-design.spec.ts the same way v15 is. Don't change the pattern. Then merge on green.
3) #743: YES to 1 (stricter). 2: no Atomik context for admins on a member's private board (admins read only through #715's audited path). 3: the sample rule ("editable only by its marker and the platform owner") in a follow-up PR.
4) #715: YES to (a), both stricter lines. (b) Admin exports include private boards, with one audit line per private board per export.
5) #738: YES to the flip at textDirectRequests ~:184 (Gemini true; Grok stays false).
6) #725/#727: YES to option A: remove the dead @vercel/blob mock entry at healthMinimal.spec.ts:47. The per-phase dates are fine.
7) #731: (a) freeze the figure the first time it's read, then never again; it never reads 0. Fresh Opus money review; cap tests unchanged.
8) #744, #745: merge on green after #742/#743, with Opus's two notes added to #745.
9) House style: YES, fix it so only boards the person can read (same workspace) are used, with an Opus privacy review. It goes in deploy #4 only if it's merged and green by 18:00 IST; otherwise deploy #5.
10) v25 foundation: Atomik button on app screens inside the ⌘K bar, none on the board (⌘J there). Accept the tab width with "+N". Dim only the picture, never the words. Then #748–#750 may merge on green after a fresh screenshot check.
11) Build plan #747: approved. First slice = Shots in both modes, inside the new frame, card and rail. Close #709 and #711 as superseded. I'll read the 14 questions and answer them separately.
12) The Coolify env check: I'll run it after deploy #4 is healthy.
13) I'll kill the stray server (pid 610521).
#728: add the @/lib/takeReview entry under my standing rule (module named, Opus check). It stays unmerged until my copy test.
Deploy #4: open deploy/2026-10-15-4 when release/1 is final (by 18:30), with the full PR list. I'll start the backup at ~19:00.

**Lead's note on these answers.** #715's branch carries the board-sharing stack, including the `workbench_projects.updated_by` migration (`addColumn`), and it conflicts with release/1. So under answer 1 it can't ride deploy #4: its two stricter lines (4a) and the export audit (4b) are built now, and #715 ships in deploy #5 with #718. Everything else cleared above has no migration and no new env, so it rides deploy #4 if green on release/1 before 18:30.

## Owner answers, 15 Oct 2026, 12:20 IST (verbatim)
#731 policy: (1) "estimated" marks ONLY takes from before metering (no receipt, frozen figure). Held/discarded/refused takes with a metered refine cost show that cost, unlabelled. (2) A refine-only cost on a failed reservation keeps counting against caps, as release/1 does today. Tests for both; fresh Opus money check of the change.
#745: noted. After #743 merges, confirm in the PR that both privacy rules (unreadable and deleted/removed items) still hold, with their tests.
#748: ⌘J opening the board's Atomik panel in the new interface is fine.
Reviewer git fetch: noted. Remind reviewers: no network, read-only means no fetch either.
The queue and the 18:30 cut-off are as planned. I'll start the backup at ~19:00.

## Owner, 15 Oct 2026, 13:45 IST (verbatim)
BFL_API_KEY is set in Coolify (production only, locked, runtime only; training opt-out done in BFL's dashboard). B1 can use it when built; check the base URL/region matches the EU endpoint. After deploy #4, include BFL_API_KEY in the name-only check.

**Lead's note for B1 (BFL adapter, docs/plans/provider-adapters.md §9 on #714).** `BFL_BASE_URL` is not set, so B1 defaults to `https://api.eu.bfl.ai` in code (never the global `api.bfl.ai`), with a test pinning the default. If `BFL_BASE_URL` is ever set, it must be an `https://` `*.bfl.ai` host. Any polling or result URL BFL returns is followed only when its host is a `bfl.ai` subdomain (no SSRF), and the adapter says in a test which region served the call. `BFL_ENABLED` stays unset until the owner turns it on. No paid call without the owner's yes.

## Owner, 15 Oct 2026, 14:05 IST (verbatim): Topaz goes direct
Topaz goes DIRECT (replaces #714 item H "Topaz stays on fal").
1) New adapter for Topaz Labs' own API, image and video upscale, using TOPAZ_API_KEY (already in Coolify). Same presets and controls as today (lib/topaz.ts), mocks only, Opus money review, NEEDS AKSHAY.
2) Before building: a price table from Topaz's published API rates vs our current fal rates (vendorRates.ts), per image and per second at 720p/1080p/4K, for each model we offer (incl. the Starlight-equivalent). If direct is dearer, show the new customer prices; nothing priced below cost.
3) Data terms: confirm Topaz doesn't train on our uploads and how long it keeps files; delete the vendor's copy after we store the output (same rule as Runway/sync.so).
4) Once qualified on the house workspace (I approve the small paid run), switch and remove the fal Topaz endpoints. fal then keeps only Kling, Bria and Luma reframe.
Queue it after B1 (BFL); not part of deploy #4.

**Lead's queue note.** Provider order is now: sync.so, Sarvam, Rekognition (+ Vision text), Recraft, B1 BFL (EU endpoint), then Topaz direct (T0 price table and data terms, docs only; T1 adapter behind a switch, mocks; T2 the owner-approved house run; T3 the switch and removal of fal's Topaz endpoints). #714's §8 Topaz section and §9 Topaz row ("none: stays on fal") are now wrong and get updated in #714 (docs) when that PR is next touched. Customer prices come from the rate card and the server's price path only; any change to what customers see changes CLAUDE.md § Pricing too and needs the owner's yes.

## Owner, 15 Oct 2026, 14:05 IST (verbatim): bibles, presets, #731
1) Private boards' bibles and board-tied presets: NARROW them, as you recommend. They're readable only by people who can read that board (same rule as private takes and #745). Workspace-level presets not tied to a board stay readable by all members. In deploy #4 if Opus-approved and green by 18:30, otherwise deploy #5. Tests for owner, teammate without access, admin (audited path only).
2) #731: no metering date needed. Particl hasn't launched (no paying customers), so #731 is PARKED until after launch; launch day is the line.

## Owner, 15 Oct 2026, 14:20 and 14:25 IST (verbatim)
14:20, replies to the lead's 14:12 update:
1) My 14:15 note stands: v25 (#746, #748–#750) moves to deploy #5 now, out of today's queue. Deploy #4 = what's merged + #744, #745, #751, #727, #753. Tell me "ready" the moment those are merged and green; don't hold for 18:30. If #753 is the only one left, go without it and ship it as #4b.
2) #753: its CI on 156ae976 showed every job cancelled. Opus approval isn't enough; it needs a real full green run before merge. My yes to merge into release/1 once it's green.
3) The Astra "unavailable" case from #753: in the follow-up PR, make the message say why and what to do ("This uses media from a private board. Ask its owner to share it."), with no board name if the user can't read it.
4) Fix #714's plan line "Topaz stays on fal" in that same follow-up; don't wait until it's next touched.
5) The name-check command is fine as long as it prints only set/missing, never a value.
14:25: done on my side: Sarvam retention set to 0 days; sync.so confirmed no training on our data in writing (kept with company records, not the repo); TOPAZ_API_KEY is production only, locked, not in previews. Record these in the deploy #4 checklist as done. Nothing else from me until you say "ready", then I take the Turso backup.

**Lead's notes.** The 14:15 note never reached the lead's session; acted on the 14:20 message. #752 (the library-tray focus fix, only needed for #746) is held for deploy #5 with v25; its CI run was cancelled. The name check now prints NAME=set/missing only (the earlier gemini yes/no came from reading a value and is removed). #714's provider plan lives only on #714's branch (docs/plans/provider-adapters.md is not on release/1), so the Topaz line is fixed by a commit on #714 and the follow-up PR links it.

## Owner, 15 Oct 2026, 15:35 IST (verbatim): two v25 build rules, plus one measurement today
1) Logo: v25's prototype uses a placeholder (ring + dot, plain "particl"). It is NOT our brand. Every v25 screen uses the real assets already in public/brand (particl-mark-on-dark/light.svg, the horizontal lockup, the app icons, favicon.svg). Add a guard test that fails if the header or favicon uses anything else. Show me a 1440 screenshot of the header in the first v25 PR.
2) Speed, measured now (read-only, no deploy): run Lighthouse (mobile and desktop) from the droplet against particl.si for the home page, sign-in and one board (signed in, house workspace), plus TTFB and the p95 from /api/health. Report Performance score, LCP, INP, CLS and the JS sent to the browser, as a table. Estimate only; change nothing.
3) Speed budget for v25: every v25 screen PR reports the same numbers against the current screen and may not be slower (LCP, INP, JS size). If one is slower, it says why and waits for my word.

**Lead's notes.** (1) applies to #748 (the top bar, the first v25 PR) and every later v25 PR; the brand guard is new (the owner's own instruction, so it may be added). (2) The lead has no session and handles no credentials, so the signed-in board is measured another way (stated in the report). Lighthouse lab runs have no INP (it needs real interactions); Total Blocking Time is reported as the lab stand-in, labelled so. Runs are few, sequential and low-priority because the droplet is production. (3) goes into the v25 build plan (#747) as a rule for every screen PR.

## Viral phase 2 (after Stripe launch): PARKED
Owner, 15 Oct 2026, 16:05 IST (verbatim): "Viral mode, research only, docs only, no code, no keys, no spend.
1) Trend source: TikTok signals first (hashtags, sounds, formats, growth, region = India + global). NEVER download or store other people's videos; signals only.
2) Compare, in a short doc: Zyla's TikTok trend APIs (Trend Tracker / Media Trends / Trend Data Retriever / Capture Trends; check whether they are one product, who runs it, data source, India coverage, sounds, price, the ~12 s response), Tokchart API, EnsembleData, and one Apify actor for TikTok Creative Center. Plus the official ones: YouTube mostPopular by region, Google Trends (alpha / SerpApi), and Instagram hashtag search via Meta. One table: data, India, freshness, price per month at 500 calls a day, terms risk.
3) Propose a provider-neutral "trend signal" adapter (env name TRENDS_API_KEY plus TRENDS_PROVIDER), switch off by default, with a test plan. I'll sign up for trials and set any key in Coolify myself.
4) Park it under "Viral phase 2 (after Stripe launch)" in the plan; don't let it take lanes from deploy #4/#5 or the v25 first slice."

**Lead's notes.** Research runs in a separate research agent (not a build lane), output `docs/plans/viral-trends.md` on redesign/integration. No code, no keys, no sign-ups, no paid calls. Nothing is built until after the Stripe launch and the owner's go.

## Owner, 15 Oct 2026, 16:40 IST (verbatim)
1) Logo: header uses the mark + wordmark (no "STUDIO" line) at small sizes; the full lockup only where it renders large (sign-in, marketing, documents). Yes to the small customer-visible PR for today's header in deploy #5 (real assets, brand guard covers it).
2) #748 JS +93 KB: tell me what it is, and whether it can be lazy-loaded or split. The speed rule is "not slower"; justify or cut it before merge.
3) Viral doc: noted. TikTok is banned in India, so the trend panel shows "rising globally (TikTok)" and "rising in India (YouTube, Google Trends)" as two sources. The cache exception and price wait until after launch.
4) rm -rf: report the exact command and path lane C tried. Standing rule for every lane: no rm -rf or recursive deletes on the droplet. Use a scratch folder under the lane's own worktree and git clean, or ask me. Add it to CLAUDE.md in the next docs PR.
5) Deploy #4: waiting on your "green" for #755.

**Lead's note on 4.** `git clean` is on the owner's banned git-command list (checkout, restore, reset, clean, bare stash, force-push), so the two rules conflict; asked the owner which wins. Until then lanes keep scratch files inside their own worktree and dispose of the whole worktree with `git worktree remove` (non-forced; refuses a dirty tree); no `rm -rf`, no recursive delete, no `git clean`.

## Owner, 15 Oct 2026, 19:10 IST (verbatim): Astra 3D after the Vercel exit
1) Confirm plainly: with vercel unconfigured, does a 3D render on production fail today (unavailable state, no charge)? Read-only answer.
2) I choose option (c), the relay, for ops/render-worker. Build it as a PR (NEEDS AKSHAY), Opus-reviewed, with the egress gate (Verify step 1) as a hard test. No setup on the server until I approve.
3) Before that: tell me the droplet's size (vCPU, RAM) and today's peak use. If 3 workers × 2 vCPU/4 GB would squeeze production, propose 1 worker to start, or a separate small droplet with its monthly cost. Estimate only.
4) Update the feature report wording: 3D blocking's scene editing and export work; cloud renders are "moving to our own server" until this ships.

**Lead's notes.** (4) done in the "Particl: Feature Report" doc. (3) droplet 8 vCPU / 31 GiB; the compose pins cpusets 12-17, which don't exist here (fixed in the relay PR). (c) is a same-host design; a separate droplet would need a different network design. Relay PR built by lane D with one worker by default (cores 6,7). (1) Opus tracing read-only.

## Owner, 15 Oct 2026, 19:30 IST (verbatim; his 16:52, 19:05 and 19:10 notes in one)
DEPLOY #4: done on my side.
- Env: GEMINI_IMAGE_MODEL and GOOGLE_SAFETY_THRESHOLD were never in Coolify. Name check on the production container (qrudklxi8zfj7cskinu3wnty, image 9df26db4): both Gemini names missing; BFL_API_KEY, REKOGNITION x3, TOPAZ_API_KEY, SYNC_API_KEY, SARVAM_API_KEY, SARVAM_USD_PER_INR set; BFL_ENABLED, REKOGNITION_ENABLED, PROMPT_MODELS, GATEWAY_PROMPT_MODELS missing.
- /api/health: signed out = ok + commit only; signed in as me = full detail. Signed-in checks continuing.
ASTRA 3D (your 19:2x trace, answered):
- Production container: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, ASTRA_BLENDER_SNAPSHOT_ID and ASTRA_BLENDER_RATE_CARD all set; ASTRA_RENDER_BACKEND, ASTRA_WORKER_URLS and VERCEL missing. So renders are LIVE on Vercel Sandbox.
- astra_render_jobs: tenant particl-mu1abv3589752p has none; aimighty-workspace has succeeded = 5. Nothing uncertain, nothing held.
- Decision: keep renders on Vercel until the relay is live and verified. Then, in one owner step, I delete the three VERCEL_* names and ASTRA_BLENDER_SNAPSHOT_ID, and you list what to remove on Vercel (project, snapshot) with any ongoing cost.
- Relay: I choose option (c) for ops/render-worker. Build it as a NEEDS AKSHAY PR, Opus-reviewed, with the egress gate as a hard test. First tell me the droplet's vCPU/RAM and today's peak use; if 3 workers × 2 vCPU/4 GB would squeeze production, propose 1 worker or a separate small droplet (monthly cost, estimate only).
- Feature report stays as written ("3D scenes: runs on Vercel Sandbox today").
STILL OPEN from /api/health (read-only answer): videosAtRisk = 1, cron rescued 0. Which take, why not rescued, is its provider URL about to expire?
LOGO: yes, one small deploy #5 PR switches the error page, no-workspace page, guest header and phone top bar to the shared logo; add the phone bar to the brand guard. #748 and #756: good work on the JS.
DEPLOY #4b: #753 plus #752 (the library-tray flake fix, test-only), together, once both are green and Opus-approved. Tell me "ready" and I'll back up first as usual.
git clean: STAYS BANNED. My earlier line was wrong. Lanes never clean folders; every run writes to a new dated folder; old scratch output is left for me. No recursive deletes, no forced worktree removal.
HOUSEKEEPING: at 18:55 the server ran only the production app container plus Coolify's own (no staging app). Name the container that held those three next-server processes at 16:04; don't guess.

**Lead's notes.** Feature report restored to its earlier wording (rev 13 → 16). #752 changes one product file (LibraryTray focus timing) plus one test line, so it gets an Opus review. The three next-server processes started at 11:19:53 UTC = 16:49:53 IST (the deploy #4 minute), not 16:04 (the lead misread their age): container id 0429db0f433c…; the lead cannot run docker, so the name needs `docker inspect --format '{{.Name}} {{.Config.Image}}' 0429db0f433c` from the owner. Vercel cleanup list to prepare for the switch-over step.

## Owner, 15 Oct 2026, 19:55 IST (verbatim)
1) Server load: no limits. The site is being built here and there are no customers, so lanes use whatever they need. Revisit before the Stripe review and the first customers; at that point it's quiet hours or the separate dev box (~$84/month), my call then. Cap simultaneous heavy runs only if that makes CI faster, not to protect the site.
2) videosAtRisk: I'll read /api/admin/console/failed-saves and tell you which take it is. No "Retry save" without my word. Yes to the deploy #5 fix:
   - the counter and the rescuer use the same 72-hour window;
   - older unsaved takes are listed as "lost (older than 3 days)" instead of "at risk" forever;
   - the cron logs a reason for every kind it can't save.
3) #757 (relay): fold the secret-leak fix in with fail-closed (a worker refuses to start if its own egress check fails) and one worker with hard limits (cpus 2, memory 4g). Tell me when Opus approves. Merging it is not server setup; I'll do setup with my advisor after approval.
4) Deploy #4b (#753 + #752): waiting on your "ready". I take the backup first as usual.

**Lead's notes.** (3) already done: #757 Opus-approved at 542be277; CI running; merge into release/1 waits for the owner's explicit yes. (2) lane B builds the fix (deploy #5) with an Opus review. Revisit (1) before the Stripe review.

## Owner, 15 Oct 2026, 20:45 IST (verbatim)
backup done for deploy #4b.
Restore point: 2026-10-15T15:05:30Z (UTC).
Copies (Turso, at that restore point): platform-backup-20261015b (group default, from aimighty-workspace) and tenant-backup-20261015b (group particl-production-tenants, from particl-mu1abv3589752p).
Dumps: both in my encrypted container, both end with COMMIT.
Checks: integrity_check ok on both; workspaces 2 = 2; uploads 4 = 4; generations 2 = 2.
Tell me "green" on #759's own CI and I'll merge and deploy.
Answers:
1) #757: YES, merge into release/1 (files only). Also Opus's optional hardening as a small follow-up: ignore ASTRA_WORKER_TEST_ROOT inside the worker image.
2) #758 badge: show both, e.g. "1 at risk · 2 lost". Lost takes were paid for and need my decision too.
3) #758 scope: fine; the 72-hour window for "at risk", older ones as "lost".
Lanes B and D are free. Start the Stripe-readiness work, no money or migrations without my word:
- Lane B: an 18+ confirmation at sign-up (a required tick: "I'm 18 or older and agree to the Terms"), stored with the date, on every sign-up path. NEEDS AKSHAY (sign-in flow).
- Lane D: drafts in docs/legal/ for my lawyer: Terms, Privacy Policy, Refund Policy (7 days if no credits used) and an Acceptable Use Policy, built on my recorded decisions (18+, no AI tag, no sexual content, consent for real faces, customer handles disclosure, no training on user content, Indian law with arbitration in Mumbai). Mark every clause my lawyer must check. Plus a font and asset licence register (every font and asset rendered into outputs, with its licence).

## Owner, 15 Oct 2026, 22:00 IST (verbatim)
#759 merged as a merge commit; Coolify deploy finished. Run your read-only checks and say "checks passed".
- `kill 610521`: I don't run commands on your side. Confirm what the process is, then stop it yourself.
- #761: I'll answer the 52 owner decisions after my advisor groups them. Meanwhile: list every font and asset marked UNKNOWN with where it is used; request written no-training / no-retention terms from BytePlus, Google, OpenAI, ElevenLabs, Topaz, Bria and Runway (drafts of the email for me to send; don't send anything yourself); and add the Big Buck Bunny credit (CC BY 3.0, Blender Foundation) to the starter production.
- Deploy #5 order noted: #748 → #756 → #762, then #758, on green and Opus review, with my yes per PR.

**Lead's notes.** Checks passed (709497a). pid 610521 = python3 http.server on 127.0.0.1:4799 serving ~/wt/v25-import/design/particl-prototype-25, user agent, orphaned, started 15 Oct 00:38 IST; the lead's `kill` was denied by the session's permission settings (not worked around): needs an allow rule (`/permissions`) or it ends at the next reboot. Lane D: UNKNOWN list + vendor email drafts (nothing sent). Lane C: the Big Buck Bunny credit PR.

## FINAL ENGINE STACK: owner, 15 Oct 2026, 22:15 IST (verbatim; replaces his 22:10 and 22:15 notes)
FINAL ENGINE STACK. Approved. Build it, switch it on, keep it ready. We test it live on particl.si with the Aimighty team. No half measures. This replaces my 22:10 and 22:15 notes.

THE STACK (15 vendors + our server; my advisor's document follows)
In use, keep: BytePlus Seedance 2.5/2.0 · Google (Nano Banana Pro AND Nano Banana 2.1, Veo 3.1, Gemini 3.x, Cloud Vision) · OpenAI GPT Image 2.5 · Anthropic Claude · ElevenLabs · Topaz (direct) · Bria (direct) · Higgsfield · xAI Grok.
Keys already set, wire now: Runway (Act-Two, Aleph 2, Gen-4.5) · sync.so (lipsync-2-pro; sync-3 for hero/4K) · Sarvam (Bulbul, Saaras, dubbing) · Black Forest Labs (FLUX 3 and FLUX.2 identity, replacing fal flux-lora) · AWS Mumbai (Rekognition consent match; MediaConvert Smart Crop, replacing Luma reframe).
New: Recraft V4.1 + V3 (decks, brand assets, sketch/ink/comic storyboards). Tell me the exact env name; I set it in Coolify. Kling 4.0 on fal the day it is live (3.0 Pro until then).
Our server: Remotion + ffmpeg worker (animatic, timeline, titles, subtitles, karaoke captions, narrated assembly, cutdowns, silence cuts, fps conform, H.264 + ProRes mezzanine + DNxHR, stems from our timeline, Download all zip) · Chromium PDF (treatment, pitch, PPM decks) · Blender relay (#757, already merged).
Pro pick menu: Seedance 2.5, Veo 3.1, Kling 4.0, Runway Gen-4.5. Names live in config, never in the design.
Leave out: MiniMax/Hailuo, Suno, Udio, Sora, PlayHT, Luma reframe, any face swap built on InsightFace, Wav2Lip, self-hosted MMAudio. H.265 stays off until my lawyer answers.
Later, on a client need or a bake-off win: HeyGen Avatar IV, Ideogram, FASHN, Hunyuan3D/Tripo, Magnific, AudioShake, Storyblocks, TwelveLabs, Wan 3.0, Gemini Omni Flash. Ask Adobe for a Firefly Reframe quote now.

ORDER
Slice 1: Remotion worker ON + Chromium PDF. Measure one real 30 s 1080p export (time, cost) first.
Slice 2: sync.so, Sarvam, BFL, Runway, Veo 3.1, AWS, Topaz direct (T0–T3).
Slice 3: Nano Banana 2.1 beside Pro; Gemini 3.x for moments, cutdown planning and the vision judge; Cloud Vision label check with exact text diff (never an AI model alone); Recraft; Kling 4.0.
Slice 4: the "later" list, one at a time.

RULES FOR EVERY ENGINE
- Its own PR, titled NEEDS AKSHAY; I say yes per PR; it goes live in the next deploy.
- Before merge: price table from the provider's own page, mock tests, Opus money review, the real provider cost on every ledger line, its own kill switch.
- ON for the house workspace (ws_legacy) and any workspace I list in the site setting; OFF for customer workspaces until launch.
- Spend: the normal per-step approval in the UI is the approval. No separate paid qualification run; the team's first real use is the test. Monthly cap on the house workspace: $500, warning at 80% (say if a cap needs a migration).
- No migrations without my word. Guard tests never weakened. Secrets never in code or chat.
- Data terms: Particl's Terms promise PARTICL does not train on customer content; providers may, under their own policies. No no-training gate on wiring. The Privacy Policy names every provider with a link to its policy. Switch off training/"improve the models" on every account that offers it (ElevenLabs now) and record it. Keep a one-page "where your data goes" table (provider → what is sent → retention → training) in docs/legal and on the site. Fold into #761.
- Consent: every real face passes Rekognition against its consent record before Act-Two, cloning or lip-sync runs.

BAKE-OFFS (the team runs them live; results decide defaults): (a) 8-panel storyboard, two characters, three styles, on Recraft, GPT Image 2.5, Nano Banana Pro and 2.1; (b) 10 real briefs × top 3 video engines; (c) one Hindi lip-sync clip on sync.so.

TESTING WITH THE AIMIGHTY TEAM
Prepare invite links to the house workspace (I send them; one admin, the rest members); a one-page test script per slice (what to try, what "good" looks like, where to report); a feedback board that files bugs to you; fixes back as PRs the same day.

DOCS: update docs/plans/provider-adapters.md (#714), the v25 build plan and the feature report to match; tell me what is missing from #714's env name table.

REPORT daily at 10:30: what is live, what the team found, spend so far, what is blocked on me.
Start with Slice 1 now.

RECRAFT_API_KEY is set in Coolify (production only, locked, runtime only). Nothing else to buy; all stack keys are in place.

Slice 5 (Viral trend panel, after Slice 3): the trend-signal adapter from docs/plans/viral-trends.md. Sources: YouTube mostPopular (IN), Google Trends via SerpApi, TikTok signals via Zyla (hashtags, sounds, formats only; never videos), Instagram hashtag search via Meta once our app is approved. One list with a source badge and a "crossing to India" flag. Tell me the env names; I'll set the keys when you're ready for them.

## Owner, 15 Oct 2026, 22:20 IST (verbatim): standing yes for tonight
I'm off until 11:00. Work through the night on the engine stack (my 22:15 note, Slice 1 first, then Slice 2).

STANDING YES FOR TONIGHT, into release/1 only: a PR may merge without waiting for me if ALL of these hold: CI green 24/24 on the final head; a fresh Opus review approved it with no open must-fix; it changes no migration, no env name, no money behaviour (prices, quotes, approvals, ledger), no sign-in, no guard test, no DNS/Coolify/Cloudflare; and it is on the approved stack. Anything outside that: open it as NEEDS AKSHAY and move on. Never main. Never deploy. Never touch Coolify or env.
Engines may ship ON for the house workspace, but NO paid generation runs tonight: no bake-off, no qualification render, no "quick check" with real credits. Mock tests only until the team starts testing with me.
Rules in force: no rm -rf / recursive deletes / forced worktree removal; git clean banned; each run writes to a new dated folder; no secrets in code, PRs or chat; guard tests never weakened; Pro-pick names in config.
Also tonight: the "where your data goes" table and Privacy Policy provider list into #761 (docs only); the daily-report format; the test script for Slice 1; the Aimighty invite links drafted; the #714 env-name table updated.
If anything looks wrong on production (health commit, errors, latency), stop merging, don't fix production, and put it at the top of the report.
REPORT at 10:30 on the status page: what merged (PR, head, Opus verdict), what is NEEDS AKSHAY and why, what is blocked on me, spend (should be $0), and anything that broke. I'll check at 11:00.

**Lead's reading.** Most engine PRs add env names and prices, so they will be NEEDS AKSHAY, not auto-merged. The standing yes covers PRs with none of the listed changes (e.g. worker internals without a new env name, compositions, docs). The Remotion measurement is CPU-only on our own sample media (no engine call, no credits).

## Owner, 15 Oct 2026 (late evening, verbatim): screen sizes
Screen sizes: add 2560×1440 (27-inch monitors and scaled 4K) and 1728×1117 (16-inch MacBook Pro) to the screenshot and walk checks, alongside 1440×900, 1280×800 and 1920×1080. For every v25 screen PR from #748 on, attach all five. At 2560×1440 check the opposite of overflow: no stranded cards, no unreadable small text, the three bars still centred, the canvas scaling up rather than leaving dead space. Report anything that looks wrong; don't redesign to fix it.

## Owner, 15 Oct 2026, 22:30 IST (verbatim): large-screen rules for every v25 screen PR (replaces the earlier screen-size note)
large-screen rules for every v25 screen PR, from #748 on.
1) Sizes: test and screenshot at five viewports: 1280×800, 1440×900, 1728×1117 (16-inch MacBook Pro), 1920×1080, 2560×1440 (27-inch monitors and scaled 4K). Attach all five to every screen PR.
2) Scaling: on viewports wider than 1440 px the board canvas scales up to fill the space (bigger cards, same layout, text and chips scale with the cards, like Figma zoom-to-fit). The rail, top bar, bottom bar and buttons stay at normal size and stay centred. Today at 2560×1440 the cards sit in the top half with the bottom third empty; that is the bug to fix. CSS in the screen PRs, no new design round.
3) Sharpness: text, icons, buttons and the logo are vector (SVG) at every size, never bitmaps. Every picture on the board (thumbnails, frames, stills, previews) is served at the size the screen needs, with 2× versions for Retina and large monitors (srcset/sizes), and is never upscaled past its real pixels. Any soft or pixelated image in the 1728 or 2560 screenshots is a must-fix.
4) Checks at 2560×1440: no stranded cards, no text under 12 px, no dead space below the cards, the three bars centred, no horizontal scroll. Report anything that looks wrong; don't redesign to fix it.

**Lead's note.** Conflict with rule 3: public/brand has the wordmark and lockups as PNG only (the mark is SVG), so #748/#756/#762 draw the wordmark as a bitmap; an SVG wordmark is needed from the owner's brand files (asked). Until then the PNG @4x stays, flagged as a must-fix in each PR.

## Owner, 16 Oct 2026, 10:55 IST (verbatim; replaces his 10:30, 10:40, 10:45 and 10:50 messages)
Owner (Akshay, 16 Oct, 10:55): answers to the overnight report, in one note. This replaces my 10:30, 10:40, 10:45 and 10:50 messages.

1) CONSENT AND LIKENESS, FINAL
- Rekognition is OUT. Remove the face check from #771 and from every engine PR. No face matching anywhere, ever; no consent-photo table or migration. REKOGNITION_* keys stay set but are read by nothing; remove them from #714's env table as "not used".
- Keep only a lightweight consent record on uploaded real faces: a tick ("I have this person's permission") and an optional NOC file, stored with the asset, never checked automatically.
- Particl does not block or screen prompts for resemblance to real people. Providers' own filters apply and their refusals are shown as they come. Storyboards, animatics and pitch decks may name real people as casting references.
- Terms (#761): any likeness or real face in generated content is the sole responsibility of the person generating it; likeness references are for pre-production and pitching; publishing a real person's likeness needs that person's rights; sexual content stays prohibited. Record that this was my decision.
- Re-run Opus on #771, #776, #780 and #785 after the change.

2) DEPLOY #5: order #748 → #756 → #762 → #758. Yes to #748's two assertion changes. Merge #748 into release/1 now; run CI on #756 and #762 in turn; tell me when all four are green. I back up and deploy.

3) SLICE 1: yes to all four (#699 env names; #700 export_jobs table after a backup; #766 guard-type additions; #768 tmpfs 3840). REMOTION_EXPORT_QUEUE_EXPIRY_MS becomes a constant. PDF_EXPORTS and REMOTION_EXPORTS stay unset until the worker runs behind its relay. DNxHR: dropped for now; ProRes mezzanine + H.264 only; say so in the delivery copy.

4) enginesOnWorkspaces: one list, house only, until launch. Split per engine before the first customer is listed.

5) #765 house cap: approve editing the three guards to the cap. UTC month, metered cost, from 1 Oct. The team may see engine dollars. Read allowance_usd before the deploy and tell me the value.

6) AGENTS: build "Approve at N cr" on prepared jobs as the next UI PR; bring render_shot in line; keep prompt text visible.

7) ENGINES: Gemini 3.x: a dated price step as its own PR, then build it (tell me if my key doesn't list 3.8). BFL: let house use settle the megapixel unit. Topaz: Developer plan, $0.10 per credit; cap stills at 24 MP. Recraft: raster-only for now. Sarvam: your buffer recommendation, in the PR. Pro pick: yes to lib/proPick.ts with a site override. Kling 4.0 (#787) stays inert until it's on fal with a real price.

8) PROVIDER TERMS: I send the BFL and sync.so emails today and switch Sarvam training off (tell me where that switch is). Lip-sync and Runway stay house-only until counsel answers.

9) SMALL: #763 and #764 as recommended. Wordmark SVG coming from my brand files. Sample clip: a 1920 px frame from the house workspace. I'll check RUNWAY_API_KEY in Coolify today. pid 610521: leave it; I reboot at the next deploy window.

10) ENV: give me every Coolify name to set, grouped by slice, one list, "set / leave unset" against each, with the two Gemini and three Rekognition names marked "remove / unused".

**Lead's notes.** This replaces the 22:15 rule "every real face passes Rekognition against its consent record before Act-Two, cloning or lip-sync runs": Rekognition is out by the owner's decision of 16 Oct 10:55. The two Gemini names are GEMINI_IMAGE_MODEL and GOOGLE_SAFETY_THRESHOLD (never set in Coolify per the 15 Oct name check).

## Owner, 16 Oct 2026, 11:00 IST (verbatim)
Owner (Akshay, 16 Oct, 11:00): answers to your four questions.
1) [Question 1: use your own recommendation.]
2) #763 and #764: yes, these defaults. #763 ships as is (existing accounts aren't asked; the tick names the Terms, which gain the 18+ line via #761). #764 keeps "Big Buck Bunny © Blender Foundation, CC BY 3.0".
3) Sample clip: large-screen tests only, as a fixture for the 2560 sharpness checks, never shown to customers. Pick a house take with no real person in it. Big Buck Bunny stays as the starter sample.
4) Voice consent: same as faces. A tick when a voice is cloned or uploaded ("I have this person's permission") plus an optional NOC, stored with the voice. Never a blocking check in lip-sync (#776) or anywhere else. Stock voices need nothing. ElevenLabs' own verification for Professional clones still applies (theirs, not ours). The person generating is responsible, per the Terms.
Carry on with my 10:55 note.

**Lead's notes.** Question 1 was the merge timing: Slice 1 and #763/#764 merge after deploy #5 (the recommendation). The lead and lanes have no production data access, so a house take must come from the owner as a file; otherwise the fixture is a generated 1920x1080 test pattern (ours, no person).

## Owner, 16 Oct 2026, 11:50 IST (verbatim)
Owner (Akshay, 16 Oct, 11:50): answers to your 11:35 update, in one note.

1) CONSENT RECORD: keep it. On any uploaded real face and any cloned or uploaded voice, store a tick ("I have this person's permission") and an optional NOC file with the asset. Never checked automatically, never blocks an engine. This is what my 10:55 and 11:00 notes asked for. The Terms still carry the responsibility.

2) AGENT UPLOAD ACCESS: yes to your check before BFL, Runway and lip-sync; good catch. Fix the site-settings save bug in #788 (it dropped the engine workspace list) before #788 merges.

3) KLING 4.0 IS OUT: read the model id and per-second prices (720p, 1080p, 4K, with and without audio) from fal's own Kling 4.0 page, put them in #787 in place of the placeholder, Opus money review. It replaces Kling 3.0 Pro in the Pro pick; keep 3.0 Pro as a fallback in config. If fal doesn't list it yet, tell me and give me the source you found.

4) DNXHR IS BACK: add a full ffmpeg build to the export worker image (pinned version, checksum verified) so we write DNxHR HQ/HQX for Avid and broadcast, alongside H.264 and ProRes. Record its licence in the asset register. Put DNxHR back in the delivery copy once it's tested.

5) ENV LIST: write it into redesign/integration yourself as docs/plans/coolify-env-16oct.md (docs only, no secrets). Leave the refused worktree as is.

6) RENDER_SHOT: put the PR up with every test change listed; I'll answer them together.

7) DEPLOY #5: tell me when #762 is green; I back up and deploy. allowance_usd, RUNWAY_API_KEY and the Sarvam switches are coming from me shortly.

**Lead's notes.** (1) Storing the tick needs one additive column on uploads plus a settings-key map for ElevenLabs clone ids (no new table); taken as the owner's word for that schema change, built as its own NEEDS AKSHAY PR. (2) #788 already carries the writeSite fix (Opus: the bug is latent in the engine stack, not on release/1). (3) Kling 4.0 is not on fal as of 16 Oct ~12:00 IST (v4 OpenAPI 404; fal's Kling pages list v3, v3 Turbo, O3); kling.ai's homepage says "All-New Kling 4.0". #787 stays inert. (4) Pinned build chosen: BtbN FFmpeg-Builds autobuild-2026-09-30-13-08 (a month-end release, kept long-term), ffmpeg-n8.1.3-9-g29e619e767-linux64-lgpl-8.1.tar.xz, sha256 dfa863a00ca81f1bdf58a372b18cff4820f0017e55de32778de8ecd8ed92a02e, LGPL build (has the dnxhd encoder; no GPL parts needed for DNxHR), verified on the droplet in ~/lead-notes/ffmpeg-dl-20261016.

## Owner, 16 Oct 2026, 12:05 IST (verbatim): standing yes
Owner (Akshay, 16 Oct, 12:05): STANDING YES. From now on, merge any PR into release/1 yourself, without waiting for me, when ALL of these hold:
- CI green 24/24 on the final head;
- a fresh Opus review approved it with no open must-fix (money PRs: Opus money review approved);
- it does not weaken, delete or loosen any guard test or security check (any such change still needs my word; batch them for me once a day at 10:30);
- merges are into release/1 only; never main.
This includes engine, money, env-name and migration PRs (migrations still ship only in a deploy after my backup).
Still mine: merging release/1 into main and every deploy (backup first, then I press Deploy). Prepare one deploy PR per day when release/1 has changes, with migrations and new env names listed at the top, and tell me "ready".
Use the speed: work the 36-PR v25 plan and the engine slices in parallel; give me the dated plan I asked for at 12:00.

**Lead's notes.** Replaces the 15 Oct 22:20 standing yes. Deploy #5 stays the four PRs (#748, #756, #762, #758): its deploy PR is cut from release/1 at the commit after #758, before any other merge. No 12:00 message reached the lead; the dated plan is written from the 12:05 note.

## Owner, 16 Oct 2026, 12:15 IST (verbatim): investor demo
Owner (Akshay, 16 Oct, 12:15): INVESTOR DEMO, 31 Oct. This now sets priorities.
Demo story: one 30 s ad, brief to final film, in English AND Hindi, in the new design on the house workspace: Home → new project → board (Pitch, Brief, Script, Cast, Storyboard, Shots) in Agent and Director → lip-synced Hindi version → export MP4 + Treatment/Pitch deck PDF.
1) Re-order the v25 plan and engine slices around that path. Give me the dated list of PRs on it by 13:00 today; everything off the path waits until after 31 Oct.
2) Engines on the path: Seedance 2.5, Veo 3.1, Kling 4.0, Nano Banana Pro/2.1, Recraft, BFL identity, ElevenLabs, Sarvam, sync.so, Remotion export, Chromium PDF. These must be live on the house workspace by 24 Oct so the Aimighty team can make the demo film from 24 to 27 Oct.
3) Feature freeze 28 Oct: fixes only after that. 29 to 30 Oct: rehearsal and fixes. Prepare a demo checklist and a fallback sample project with everything pre-rendered.
4) Pricing page, credits, project spend and client review links must work in the new design. Checkout in Stripe test mode only if Stripe's invite allows it; otherwise show the pricing page.
5) Daily at 10:30: progress against this path, risks to 31 Oct, and my questions in one batch.

**Lead's note.** The dated list is docs/plans/demo-31oct-plan.md; it supersedes docs/plans/dated-plan-16oct.md until 31 Oct.

## Owner, 16 Oct 2026, 12:20 IST (verbatim): answers to the demo plan
Owner (Akshay, 16 Oct, 12:20): answers to the demo plan.
1) Stripe: [I'll confirm test keys today / no test mode: show the pricing page only].
2) Export worker: I create the stack and relay with my advisor by Mon 19. Remotion: we'll buy the paid licence before launch; the demo runs on the free tier.
3) Cast: AI-made characters only. Keep the consent record off the demo path.
4) One deck PDF with a Treatment cover and a Pitch cover: yes.
5) Hindi lip-sync on hero shots only; final call after the 24 Oct test clip.
6) Invites: [names and emails] from Sat 24.
7) allowance_usd and RUNWAY_API_KEY: coming from me today.
Build slack into the plan: with the answers above, move the feature freeze to 27 Oct, aim for the full path live on 23 Oct, and list what you'd cut first if a day slips (my order: Director-mode polish, then Kling 4.0, then the Pitch cover).

**Lead's notes.** Items 1 and 6 still carry the owner's placeholders (Stripe test keys to be confirmed; invite names and emails to come). The demo plan is re-dated: full path live Fri 23 Oct, team film Sat 24 to Mon 26, freeze Tue 27, rehearsal 28 to 30.

## Owner, 16 Oct 2026, 13:15 IST (verbatim): Enhance bug
Owner (Akshay, 16 Oct, 13:15): BUG, high priority, on the demo path. The Enhance button for prompts doesn't work on particl.si: either generation doesn't start for a long time ("thinking"/enhancing) or nothing happens at all.
1) Reproduce on production in the house workspace (Make and the board's generate dock, images and video), signed in, read-only first: time each step, capture the network calls and server logs for /api/enhance (or whatever Enhance calls), the model it uses, the provider response and any error.
2) Check whether deploy #4 broke it: the gateway removal (#737/#739), Gemini direct (#738), the removed Gemini models, or a missing env name. Say plainly what the cause is.
3) Fix it so that: Enhance shows a visible "Enhancing…" state; it times out after ~8 s and falls back to the original prompt with a short note ("Couldn't enhance; used your prompt as written"); it never fails silently; pressing Generate never waits on Enhance unless the person pressed Enhance themselves; the enhanced prompt appears in the box before anything is spent so the person can edit it; its cost (if any) is shown and recorded.
4) Tests for: success, slow provider (timeout + fallback), provider error, missing key. Opus review.
5) Ship it in the next deploy; auto-merge into release/1 on green as usual. Tell me the cause and the fix in the next report.

**Lead's note.** The lead cannot sign in to production or read its logs (no account, no container access); anonymous POST /api/prompt/enhance answers 401 in 0.15-0.31 s, so auth and routing are up. Diagnosis is from the deployed code (main 709497a); the owner's browser trace confirms it.

## Owner, 16 Oct 2026, 15:05 IST: sharpness, Agent and Director, decks, editing, carry-overs

Recorded by the lead. Sections 1 and 3 to 6 are verbatim. Section 2 sets pricing and sourcing policy, which CLAUDE.md § Pricing keeps out of this repo; the lead holds it verbatim privately. What follows for section 2 is only what the product says or does in the open.

**1) SHARPNESS TARGET: APPLE 5K/6K.** Screenshots for every v25/v26 screen PR at 1280×800, 1440×900, 1728×1117, 1920×1080, 2560×1440 and 3008×1692, the last two with deviceScaleFactor 2 (Studio Display, Pro Display XDR). Canvas scaling uses real layout sizes, never CSS transform/zoom on text (if #748 uses zoom, convert it). All UI and the logo vector; borders snapped to device pixels; every image served at ≥2× its displayed size via srcset; full-screen preview uses the 4K rendition when one exists; video posters at the same density. Any soft text, blurry border or upscaled image in those screenshots is a must-fix. Add an automated check that fails when an <img> is displayed larger than its natural size ÷ 2.

**2) AGENT vs DIRECTOR (public part).**
- **Agent mode:** Particl picks engines, plans, writes, designs and checks. No engine names are shown. Each Agent quote is ONE all-in credit price, shown before approval and charged exactly, with no breakdown. The pricing page says only that Agent mode jobs use more credits than Director mode because Particl directs the work end to end. The rule is server-side, in config; the owner sets the numbers.
- **Director mode:** every feature offers as many engines as we can (text, image, cover/design, video, voice, lip-sync, upscale, music…), each with name, strengths, limits and price per unit, on all plans. This replaces "Pro pick admins only" and "models named only in Pro pick". Director breadth comes through aggregators (fal, Runway API, Replicate, OpenRouter for text).
- **The 31 Oct demo runs in Agent mode on the house workspace.** Director engine breadth comes after the demo unless it's already wired.

**3) DECKS: 2SLIDES PARKED, WE BUILD OUR OWN TREATMENT BUILDER** (after 31 Oct; spec in docs/plans/deck-editor.md). Do NOT wire the 2Slides API; drop it from the env plan. The full flow, section library and spikes are as the owner wrote them; docs/plans/deck-editor.md carries them verbatim.

**4) EDITING IS THE CORNERSTONE** (deck first, then every output in the app)
- Click any element to edit it (text, image, colour, position, size); a text change never costs a render.
- Regenerate one thing only (one image, one paragraph, one page visual), never the whole deck.
- "Change this…" on any selection in plain words, using the mode's engine choice.
- Version history per page and per element: compare side by side, restore any.
- Unlimited undo/redo, lock elements, comments, duplicate a page to try an alternative.

Apply the same standard to board cards, shots and stills: every output is editable at the smallest unit.

**5) CARRY-OVERS**
- **BFL FLUX Upscale beside Topaz Astra 2:**
  - Same BFL_API_KEY. Precise is the default; Creative only by explicit choice, with a "faces and products may change" note.
  - Live on the house workspace by Wed 21 Oct.
  - **UPSCALE BAKE-OFF Thu 22 Oct:** 3 house clips (face close-up, product, wide), 5 s each, both engines at 2× and 4K, ~$30–40. Exact estimate first, and run only on the owner's yes. A side-by-side page with zoomed crops, cost and time; the owner picks the default.
- **Bake-off list** with dates, estimates and owners: storyboard (Recraft / GPT Image 2.5 / Nano Banana Pro and 2.1, 8 panels, two characters, three styles), 10-brief video, Hindi lip-sync test clip, upscale.
- **Evolink vs BytePlus:** we stay direct with BytePlus for Seedance 2.5; Evolink resells it about 25–30% higher. Confirm the BytePlus rates from its own price page and compare video-reference/edit rates. Report only.
- **Repo:**
  - A full-history gitleaks scan found no secrets. Add gitleaks to CI as a required check.
  - Estimate only: going private (Actions minutes, what breaks, a self-hosted option).
  - The owner updates the repo description himself.
- **Google Stitch** is not a deck engine; don't build on it.

**6) Coming today from the owner:** allowance_usd for ws_legacy, whether RUNWAY_API_KEY is set, and the Sarvam switches.

## Owner, 16 Oct 2026, 15:50 IST: answers, advisor findings, v26 design first, resolution, Enhance loader, public site

Recorded by the lead, verbatim except A.8's cost thresholds, which are engine costs and are held privately.

**A. Decisions**
1. **Agent numbers:** after the private page. Put the Agent proposal, the Director engine lists with prices and the Seedance BytePlus vs Evolink comparison on that one page. "Charged exactly" is NOT needed for the demo; it ships after 31 Oct with Stripe. For the demo, Agent shows one all-in quote on the house workspace.
2. **Batches:** a multi-shot press and the Hindi plan are each judged as ONE job against the 200 cr line, with one approval that shows the total. Add a guard test proving a batch over the line asks, even when every shot in it is under the line.
3. **Board zoom:** PAUSE converting the board zoom to real layout, and pause any restyling, until the v26 zip arrives; v26 sets the layout per width.
4. **The owner's own zoom:** pinch and +/- zoom are exempt while zooming; text must redraw sharp once the zoom stops.
5. **Screenshots:** 2560×1440 at BOTH 1× and 2×; 3008×1692 at 2×.
6. **Logo:** wordmark and mark SVGs are coming from the owner. Build lockups from them; never redraw.
7. **#809:** yes. Free when the writer never answers, times out or errors.
8. **#809:** yes, Opus 5.5 is the default writer at 1 cr, with Sonnet 5.5 behind it. Report the real cost of the first 50 presses on the house workspace against the owner's thresholds (held privately).
9. **#807: NO as written.**
   - Pin the full new message exactly, including the no-charge sentence when the server sends it.
   - Name the server test that proves a refused press is never billed.
   - The tooltip, exactly and pinned word for word: "Enhance — Particl rewrites your prompt for the chosen engine (light, camera, detail) and puts it in the box for you to edit. 1 credit per press, free if it fails. Make sends the box exactly as it is."
10. **create_board:** yes, add it to the list of MCP tools that write (this makes the guard stricter). Merge #806 only after Opus approves it and CI is green.
11. **#810:** yes to Chrome for Testing as the backup PDF printer. Pin the exact version and verify its checksum in the Dockerfile; 4 → 5 stages is fine. It stays a draft until the Mon 19 worker test decides.
12. **Polotno:** the owner starts the trial on Mon 26 so it covers Thu 29. Tell him what it needs (key, env name, allowed domain); he sets keys himself, never in chat.
13. **Deploy #5 (#799):** the owner does backup → merge → Deploy. Run the read-only checks when he says "deployed".
14. **The two processes:** the owner checks them himself before stopping them.
15–19. Stripe test keys, invite names, allowance_usd, the Runway key and the Sarvam switches are coming from the owner.
20. **TEXT_DIRECT and MODEL_CATALOG:** set in the deploy that ships #809, not today. Put both in that deploy PR's "before you press Deploy" list with exact values, and say whether ANTHROPIC_API_KEY must be set.
21. **secrets:** marked required only after #796 merges and the check has run on one PR. **Code-owner review: NO.** Every PR comes from the owner's account and GitHub won't let him approve his own, so it would block release/1 merges; revisit when a second person reviews.
22. **#790:** yes, a 480p take is the draft for Seedance. Yes to the listed test changes (setup only, every assertion stayed), as long as a test proves Auto never starts a 720p/1080p take or anything over the line. Merge only on green CI.

**B. The advisor's findings**
1. **uploads.real_face_consent:** yes, one additive, nullable column, written only by a signed-in person's action, never checked automatically, never blocking. Build it AFTER 31 Oct, and flag it as a migration in that deploy PR.
2. **Remotion licence:** passing no key is fine; the Free License covers companies with a total headcount of 3 or fewer, counting contractors on the Remotion project. Add a licence note to ops/render-worker/README.md: we render only our own compositions, users never upload Remotion code, and a 4th person means buying the Company License. Report its price (report only).
3. **The Hindi lip-sync test clip moves from Sat 24 to Tue 20.** Estimate first; it runs only on the owner's yes.
4. **Kling 4.0:** check whether Kling's own API offers 4.0 today; if so, the price and env name (report only). Kling 3.0 Pro stands in until then.

**C. v26 design comes first.**
- The owner sends Claude Design a v26 brief: built for 5K/6K; every screen including the visitor pages, with Dune Studies as the sample project; Agent vs Director with engine pickers; a resolution control; the Enhance loader; the treatment builder; a hand-off package (tokens.css, a component sheet, a URL per state, an image-slot list). The zip is the source for the look.
- Until it arrives, keep going on what design can't do: lane C's whole-pixel fix, srcset and picture widths, the 4K rendition in full-screen preview, posters from the take, the automated image-density check, the screenshot job.
- When it arrives: estimate which demo-path screens can take the v26 look before the 27 Oct freeze; nothing else moves on the demo path. Make sure the real Dune Studies images are available at 4K for v26's photo slots, and report which are smaller.

**D. Resolution must be a visible choice.**
- In Make and Director (column, pop-ups), a Resolution control beside Ratio and Length.
  - Options come from each engine's own list, validated on the server.
  - Each option is priced by the quote engine.
  - Options the engine can't do are greyed out with "not on this engine".
- Draft/Final become presets (Draft = 480p, Final = 1080p); the resolution stays visible and changeable.
- Native 4K and upscaled 4K are separate options.
- The resolution shows in every card and take status line, in Preview and on Library tiles.
- The Agent Brief gets one question: "Deliver at 1080p or 4K?"
- **Timing:** Make and Shots before the freeze if it fits in a day without moving the demo path; otherwise right after 31 Oct.
- **Money rules apply:** an Opus money review, and a guard test that the server refuses a resolution the engine doesn't list.

**E. Enhance needs a real loader** (#807/#809, before the freeze).
- Stream the rewrite into the prompt box word by word; the 8 s limit applies to the first words arriving.
- **Waiting:**
  - the button shows the dot-arc loader with "Enhancing…" and is disabled (one press = at most one charge);
  - the box dims, with a light sweep and a progress line toward 8 s;
  - at 2 s, "Rewriting for the chosen engine: light, camera, detail" (no engine names in Agent mode).
- **Done:** briefly highlight the changed words, plus an "Undo enhance" chip that restores the original text.
- **Cancel and failure:** Esc/Cancel before any words arrive charges nothing. A stream cut off midway counts as failed: restore the original, charge nothing, and show "Couldn't enhance this time. Nothing was charged." with Try again.
- **Accessibility:** respect reduced motion; announce states to screen readers (aria-busy, a live region).
- **Tests:** a cancelled or cut-off press is never billed, and a double press charges once.
- **Screenshots:** every state at 1440 and 3008 @2×. Match v26 when the zip arrives.

**F. The public site still shows the old design.**
- When the v26 zip arrives, build the visitor pages in the v26 look, reusing today's join, request-access and invite flows unchanged (no sign-in or auth change).
- Make them what a signed-out visitor sees at "/", behind the existing site switches; the owner flips them after seeing them on staging.
- Target: live before 31 Oct; estimate when the zip arrives.
- Report today: which Public site switches are on, which workspace is the sample workspace, and whether its Dune Studies board is complete.

**G. Also**
- Spikes in freeze week are fine as mocks only.
- Nothing merges to the demo path after 27 Oct without the owner's yes.
- The repo stays public until after 31 Oct.

## Owner, 16 Oct 2026, 17:05 IST: design reset (v26 rejected, v27 with Claude Design)

Recorded by the lead from the owner's 17:05 message.

**v26 from Claude Design is REJECTED as cluttered.** It stays only as the feature list.

**v27 is a reset, now with Claude Design:**
- Home in the InVideo shape: one prompt box, then tabs for Film types, Projects, Engines and Showcase.
- Boards stay ours.
- Both side rails become hover docks: 48 px icons that expand on hover.
- Nothing shows until it's touched.
- Space opens Quick Look on any card, everywhere.
- One floating command bar at the bottom of every screen: Agent chat and the Director action both live there.
- Cards are a full-bleed picture with one line and a status dot.
- The treatment page fills the screen, with a filmstrip at the bottom.

**The + opens ten film types**, each with its own steps and model stack: Feature film · Ad film · UGC · Product video · Music video · Short film · Microdrama · Pre-vis/animatic · Trend clip · Social.

**Pause all restyling until the v27 zip arrives.** Keep going on:
- lane C's whole-pixel fix;
- lane J (srcset, 4K preview, posters from the take, the image-size check, the screenshot job);
- the resolution control logic;
- the Enhance loader behaviour;
- the demo path.

**Draft, for the owner's review:** the steps of each of the ten film types and which engines each needs, marking anything not in the current stack. Report only, no spend.

## Owner, 16 Oct 2026, evening: design reset (v28 brief), product decisions, treatment builder update

Recorded by the lead. Sections 2 to 4 are verbatim; section 1 is verbatim less one private aside. Section 3's text is carried in `docs/plans/deck-editor.md` § 1.4.

**1. v27.** On 16:53 I sent Claude Design a reset brief after rejecting v26 as cluttered. v27 came back; I reviewed it screen by screen and a v28 brief has gone out. v26 stays only as the feature list. Rule from now: FIRST DESIGN, THEN CODE. Pause all restyling/layout work (including the board-zoom-to-layout change) until I approve v28. Keep lane C's whole-pixel fix and lane J's sharpness work as already agreed. Nothing here moves the 31 Oct demo path or the 27 Oct freeze.

**2. Product decisions** (record in docs/redesign-plan.md; build after v28 is approved unless you show me it's safe before the freeze):
- a) Director mode = full manual control. No "Auto" engine in Director: picker opens empty, Render disabled until an engine is picked. New setting "Takes" (1–4), priced per take by the quote engine, server-validated. Agent routing is unchanged.
- b) Enhance: Director only (not in Agent). Shown as an Atomik button. My yes to replace the long tooltip with hover label "Enhance prompt" + second line "1 credit · free if it fails". Update v12-enhance.spec.ts to that wording. The full no-charge message in tests/unit/enhanceStableKey.spec.ts stays pinned exactly as I said for #807 — do not weaken it. Writer unchanged and never named.
- c) The bottom bar is Atomik (our agent name). Top search becomes "Search or go to".
- d) Batch "Select all shots with <character>" must come from Particl's own record of who was cast in each shot when it was made — never face matching (Rekognition is out). Tell me whether that cast-per-shot record exists today; if it needs a migration, flag it as a migration for after 31 Oct, don't build it now.
- e) Batch changes: "Try on 1" then "Apply to N · price" = ONE job, one approval, cancelled shots not charged (matches the money guard).
- f) Agent questions always offer chips + "Other" + "Decide for me"; "Decide for me" picks are shown on the plan card and stay changeable. Max 3 questions per step.
- g) Never show internal rules in UI copy (v27 printed "no breakdown, no engine names" on the plan card).

**3. Treatment builder spec update** (still built after 31 Oct; Wed 28 / Thu 29 spikes and Fri 30 recommendation unchanged). Verbatim in `docs/plans/deck-editor.md` § 1.4.

**4.** Reply with: which of 2a–2g can land before the 27 Oct freeze without touching the demo path (with a date each), and which wait for after 31 Oct. No new PRs for v28 layouts until I approve the zip.

**Lead's notes:**
- The 17:05 entry above already records v27; this entry adds the v28 brief and the rule "first design, then code".
- The board-zoom change was already paused (15:50, A.3); it stays paused until v28 is approved.
- 2b replaces the #807 tooltip pinned at 15:50 (A.9). The no-charge message A.9 pinned in `tests/unit/enhanceStableKey.spec.ts` stays exactly as pinned.
- The lead's answer to section 4, and to 2d's question, is in the 17 Oct 10:30 report.

## Owner, 16 Oct 2026, late evening: v29 direction, and six data PRs before the freeze

Recorded by the lead, verbatim less one aside about who decides pricing.

> v29 direction, so you can plan the week.
>
> What changes: the board becomes a canvas with one frame per step (Luma style), the Atomik bar grows a card that asks up to three questions, shows the approach with one price and ticks a checklist as jobs finish, Director mode gets a composer of picture tiles (engine, resolution, takes, length, references and so on), and Quick Look becomes a viewer with an Info / Edit / Comments inspector. Design first: the v29 prototype is being made tonight. No v29 interface PRs until I approve the zip. Pause any restyling of the current app.
>
> What you can land before the 27 Oct freeze, each as its own small PR into release/1 with CI 24/24 and a fresh Opus approval, no interface changes:
> 1. Per-shot ledger. Every job writes production, step, shot, mode, engine, settings, credits quoted, credits charged (0 on fail or cancel), result id, started and finished times.
> 2. Job receipts. A read model per production: what ran, what it cost, what failed, in order.
> 3. Elements. An @handle unique per workspace, a kind (cast, prop, wardrobe, location, reference) and an Active/Draft flag. The library is ours; Higgsfield's API has no reference-elements endpoint, so we store references and pass them per call.
> 4. Board pages. A frame per step per production with an order and a page id, so steps can have their own links later.
> 5. Settings. Two new fields with defaults: ask_before_generating (on) and a monthly spend limit with a paused state (no behaviour yet).
> 6. Soul ID. Higgsfield API on our key is confirmed (POST /v1/custom-references, Key auth). A client stub behind a feature flag, no spend, no UI.
>
> Do not change the pricing line (200 cr per job, 480p drafts first) or any money behaviour. The export worker is still due Monday 19. The bake-off slots on Tue 20, Wed 21 and Thu 22 stand.
>
> By Friday, tell me which of 1 to 6 you can land before the 27th, with real PR numbers once they exist.

**Lead's note:** v29 replaces the v28 brief in the entry above as the design to wait for. Every item there that waits "until v28 is approved" now waits for the v29 zip.

## Owner, 17 Oct 2026: Particl v30, the build starts (Phase A before the freeze, Phase B after the v30 zip)

Recorded by the lead, verbatim less one aside about who signs off money changes (marked […]). This replaces the 16 Oct late-evening six-item list: its items are inside Phase A below.

> Particl v30 — the build starts now. Read all of this before you open a branch.
>
> WHAT IS CHANGING
> Particl keeps its shell (Studio · Gen · Workspace, the project selector, the step rail, one canvas, a right-hand inspector) and loses the left column. Underneath, the product becomes: one production per film type with a step list; an infinite canvas with one frame per canvas step; cards (stills, clips, audio, text) and plates (empty cards that take inputs and become a storyboard sheet or a shot); links between them; two document steps (Brief, Script) with an in-app reader and editor; two modes, Agent and Director, that share the data and differ in who decides; and a money model where talking is free, making is quoted before it runs and billed as it is made. The approved v30 prototype arrives from Claude Design this week; the interface is built from that zip, not from this message. What you build now is everything under the interface.
>
> GROUND RULES (unchanged from the handover)
> - Branch from release/1, PR into release/1, small PRs, one concern each. CI must be 24/24. A fresh Opus approval on every PR; a money review on anything that touches credits, quotes, receipts or limits. Never weaken a guard or security test. You never touch main, deploys, DNS, Coolify or Cloudflare; when a step needs Akshay, write it click by click.
> - No secrets in chat, code, PRs or the repo (the repo is public). Every key is set by Akshay in Coolify; you read config only. The engine routing table and all vendor prices live in server config, never in a client bundle, never in a migration, never in a test fixture.
> - No rm -rf, no recursive deletes, no git clean, no forced worktree removal. Never invent PR numbers, commits or results; report real ones or say "not yet".
> - Money behaviour that exists today stays exactly as it is until […] signs off: the 200 cr per-job line, 480p drafts first, the $500 house cap, credit = US$0.10. Margins are per service and will come from Akshay's cost sheet; until then every margin is a named placeholder in config, flagged, never a number typed into code.
>
> RULES THE CODE MUST ENFORCE
> 1. Agent jobs never expose an engine: not in the API, not in History, not in receipts, not in exports, not in error messages. Director jobs expose everything they chose. A test asserts both.
> 2. Nothing in a delivered file says it was generated: strip all metadata from every output before it reaches storage (ffmpeg -map_metadata -1 for video and audio, exiftool -all= for stills); a test asserts no metadata remains. Engines that visibly mark paid output are never in the routing table.
> 3. Talking is free, making is charged. A quote is computed and stored before any job runs; the actual is stored when it finishes; both appear on the receipt. A failed or cancelled job is 0 when the vendor refunds it and its cost plus margin when the vendor bills us; the refund status is a field, not a guess. Uploads and the user's own edits are never billed. Reading any imported document for understanding is a billed job.
> 4. Every spend shows its price before it runs; the API refuses a spending action that has no quote attached.
> 5. Director mode offers the full catalogue of wired engines, alphabetical, with prices, none pre-selected, none flagged; the catalogue endpoint is the only place engine names leave the server, and only for Director requests.
> 6. Switching modes loses nothing. Recreate on an Agent take hands Director an empty engine.
>
> PHASE A — LAND BEFORE THE 27 OCT FREEZE (no visible interface changes; everything behind flags)
> 1. Production model. Tables for productions (type, step list by type), frames (one per canvas step, position, order), nodes (kind: still · clip · audio · text · document · plate · detail · element; frame, position, status draft · final · 4k · kept · failed; takes as versions), links (from node to plate with a role: cast, frame, angle, camera move, environment, prop, brand, product, look), and detail nodes with typed values (angle, camera move, lighting, action, note). Beats belong to a breakdown table and are the source for plates: a beat creates a dashed plate in Storyboard and Shots; the two stay linked.
> 2. Documents. Brief and Script as documents with versions; Fountain as the internal format for scripts; selections with Atomik edits as tracked changes we diff ourselves. Import pipeline on Inngest: .docx (mammoth), .pdf (text layer), .fdx/.fdxt (XML), .pptx and .xls/.xlsx (text and images), images (.jpg .png .svg .tiff) through Tesseract OCR. Viewing conversions through LibreOffice headless — spike first: can the droplet carry it, or do we need a conversion service.
> 3. Jobs and money. A jobs table: production, step, node, command, mode, product (generation · reading · research · analysis · writing · layers · enhance · render · upscale), engine (private), quote, actual, vendor cost, refund status, status queued · running · done · failed · cancelled, timestamps. A commands table for Agent mode: one row per instruction with its quote and total. Receipts per step. The monthly spend limit per workspace with a paused state, and ask_before_every_take defaulting to off.
> 4. Pricing engine. A product-and-cost table in config (engine × resolution × length for generations; pages, sources and minutes bands for reading, research, analysis and writing; layers; enhance; renders) with cost and margin columns; quotes computed from it; the sheet from Akshay fills the numbers later. Nothing about it reaches the client except credit prices.
> 5. History read models. Agent: one row per command — instruction, production, step, date, total credits, the cards it made. Director: itemised with engine, settings, inputs, prompt. Aggregate by production, member and month, with CSV export. Every row links to its card.
> 6. Library. Elements with an @handle unique per workspace, kind (character · environment · prop · wardrobe · brand · product · reference · audio), origin (generated · uploaded), active/draft, the original stored untouched and any crop as a separate derived file. A links table so any gen can be linked to any production and step, before, during or after it is made, many to many.
> 7. Search. One endpoint behind ⌘F over productions, cards, prompts, handles, library and history — FTS in Turso — returning matches on the current canvas first.
> 8. Collaboration. Liveblocks rooms per production with presence for named cursors. Check our plan covers the text-editor and comments products; report what it does and doesn't.
> 9. Visitor bar backend. A separate endpoint with its own limited instructions that contain nothing about routing or prices; a cheap model; short answers; rate limit per visitor; it never calls a generation engine. Add a test that feeds it the usual extraction attempts and asserts nothing about engines leaks.
> 10. Carry-overs. Soul ID client stub behind a flag (Higgsfield API, key auth, no spend). The export worker is still due Monday 19.
>
> THREE CHECKS TO REPORT BY FRIDAY, WITH EVIDENCE
> - Liveblocks: which products our plan includes.
> - LibreOffice headless on the droplet: memory and time for a 40-page .pptx and a 20-sheet .xlsx, or the case for a conversion service.
> - Tesseract: accuracy on five real scanned briefs Akshay gives you, two of them in Hindi; where it fails, the fallback is the multimodal model we already pay for.
>
> PHASE B — AFTER THE V30 ZIP IS APPROVED (from 2 Nov, in this order, one PR per item)
> Shell (top bar, rail, mode switch) → canvas, frames and cards with wires on selection and Show rig → the bar: Agent card states and Director tiles → Space and i → the Library drawer → the document editor on TipTap with Atomik selections → Breakdown cards and list → Add node and plates → Look and the treatment builder (Polotno if the 26 Oct trial holds) → Deliver table and exports → Gen → Workspace → visitor page with its bar → phone.
>
> REPORTING
> A short note each evening: what landed (real PR numbers), what's next, what's blocked. Nothing invented. Questions go to Akshay in plain language; where an answer changes money or security, wait for it.

## Owner, 17 Oct 2026, ~16:50 IST: answers to the Phase A update

Recorded by the lead, verbatim less the asides about who signs off money changes (marked […]). Three brackets were unfilled when sent (items 1, 2 and 21); the lead holds the money-changing PRs in item 1 until the owner confirms it.

> Answers to the Phase A update. Numbered as you numbered them.
> BLOCKING NOW
>
> 1. [Akshay: yes/no] The 31 Oct demo is on. The approved PRs keep merging under the standing yes of 16 Oct: CI 24/24, fresh Opus approval, money review done on #765, #815, #809, #814 and #800, nothing weakened.
> 2. Yes, open the ⌘K fix as a PR. Yes, delete the expired waiver — removing a waiver restores the guard, it doesn't weaken one. Make's switch says "Image". [Akshay: or "Images"]
>
> MONEY OR SECURITY
> 3. Ask before every take: off by default. Approval happens once per step, on the quote; that is the person approving spend. The per-take ask stays as a setting a workspace can turn on.
> 4. Yes: store the refund status on every job now; keep today's billing behaviour until […] signs off.
> 5. Metadata: build the strip behind a switch with a second position that keeps one standard marker, default strip. The owner's decision is that nothing says generated; counsel will look at Article 50 and the vendor terms. For that, list which vendors' terms say what about provenance, with the clause quoted and linked — no paraphrase.
> 6. Yes: vendor prices in a server-only file set on Coolify; today's rate file and its tests untouched until sign-off. Margins are per service and arrive later as config, never in code.
> 7. Yes: the catalogue-only rule on every new v30 endpoint now; the old screens in Phase B, listed.
> 8. Atomik's planning turn is free in v30: questions, the approach, the quote. Build it behind a switch, leave today's billing on until […] signs off — a charge going away is still a money change.
> 9. Scanned PDFs go to the multimodal model as a billed Reading job (the OCR band), once import runs in its own container. Until then, refuse them with a plain message.
> 10. Yes, one conversion-and-import container, no network, two jobs at a time, 1.5 GB, 120 s per document, killed on timeout. Write Akshay the click-by-click Coolify steps, and state the droplet's total memory and today's headroom in the same note, since the droplet is also production.
> PRODUCT
> 11. Ten film types. Steps, in order:
> Ad film: Pitch deck · Brief · Script · Breakdown · Look · Elements · Storyboard · Shots · Edit · Deliver
> Feature: Brief · Script · Breakdown · Look · Elements · Storyboard · Shots · Edit · Deliver (board grouped by scene; a representative scene before scaling)
> Short film: Brief · Script · Breakdown · Look · Elements · Storyboard · Sound · Shots · Edit · Deliver
> UGC: Brief · Creator · Hook · Script · Shots · Captions · Deliver
> Product video: Brief · Product · Look · Storyboard · Shots · Edit · Deliver
> Music video: Track · Beat map · Look · Elements · Storyboard · Animatic · Shots · Edit · Deliver
> Microdrama: Series bible · Episodes · Elements · Storyboard · Shots · Edit · Deliver
> Pre-vis: Brief · Breakdown · Set map · Elements · Storyboard · Animatic · Shots · Handoff
> Trend clip: Source · Format breakdown · Swap-ins · Copy · Shots · Captions · Deliver
> Social: Deliverables · Hook · Copy · Design · Visuals · Captions · Deliver
> Brief and Script are document steps; Deliver is a table; the rest are canvas steps. Keep them in server config as you have them.
> 12. Kept means the user pressed Keep on a take. Picked is choosing among options and is a step on the way; approved is not a separate state.
> 13. Yes, one beat can become several shots; a shot belongs to one beat.
> 14. The Brief is new: a document step for the client's material. Today's treatment stays as the deck inside Look.
> 15. Yes, History includes earlier work: backfill from the meter records; rows missing a field show "before History".
> 16. Reference, in the Look pack. Not wardrobe.
> 17. Calendar month, UTC, like the house cap. Reaching it finishes the running job, starts nothing new, and shows Paused with Continue (owner raises the limit) and Stop.
> 18. After 31 Oct, as you recommend.
> 19. Refuse old .xls with "save as .xlsx". State your proposed import limits in one line; they're fine unless they block a 100-page brand book.
> INPUTS
> 20. Five scanned briefs, two in Hindi, by Monday evening. Make the typed transcripts with the multimodal model first; Akshay corrects them.
> 21. Liveblocks plan name: Akshay reads it from the dashboard with your steps. [Akshay: plan name]
> 22. Export worker on Coolify by Mon 19, with your click-by-click steps.
> FREEZE PRIORITY
> With two CI runs an hour, order the queue: the demo-path PRs first, then Phase A in this order — steps and frames (#818), Library (#820), jobs with quotes and refund status, spend-limit settings, the visitor bar backend, History read models. Document import, search and Liveblocks changes wait for after the 31st; import needs the container anyway. Deploy #8 on Fri 23 stays the last feature deploy. Keep the evening note going: landed with real numbers, next, blocked.

## Owner, 17 Oct 2026, ~17:45 IST: answers to update two

Recorded by the lead, verbatim. Four brackets were unfilled when sent; item 1 (the demo yes or no) is held for the owner's own answer.

> Answers to update two.
>
> 1. [Akshay: YES or NO] The 31 Oct demo is on. The five money PRs (#765, #815, #809, #814, #800) merge under the standing yes, and the demo build lanes restart now.
> 2. [Akshay] #750: tell me in one line which plan its title refers to and what it changes; if it's the v25 plan already approved, edit the title and merge; if not, hold.
> 3. Yes: add the visitor bar's screen file to the never-shown list, the same way lib/vendorNames.ts is declared. That extends a guard; it doesn't weaken one.
> 4. Visitor bar: [Akshay] I will create its own Anthropic key with a hard monthly limit and set it in Coolify; tell me the exact env var name. Its usage goes in the ledger as house spend, marked "visitor". Limits: 20 messages per visitor per day, 400 characters per message, 2,000 messages a day across the site; the bar says "That's all for today — request access to continue" when a limit is hit.
> 5. Spend settings: the house limit stays in dollars as it is today. Only the workspace owner may raise the monthly limit. A pause lifts automatically when the new calendar month starts, UTC.
> 6. Metadata: build the switch, keep it on "don't strip" by default until counsel has read the note. No vendor metadata is removed from any output until then. Send the note to Akshay for counsel, with the three unreachable documents listed so counsel reads them directly.
> 7. Uploads: never skip a limit. A file whose size can't be read is converted first (HEIC to JPEG on the server) and then checked; if it still can't be read, it's refused with a plain message.
>
> Also: "Images" on the Make row is fine [Akshay: or "Image"]. The droplet plan is fine — lower the agent allowance while both workers run, and tell me the number you set it to.

## Owner, 17 Oct 2026, ~18:00 IST: answers to the 17:54 update (verbatim)

> 1. YES — the 31 Oct demo is on. The five money PRs (#765, #815, #809, #814, #800) merge under the standing yes, and the demo build lanes restart now. [Akshay: change to NO if that's wrong]
> 2. Uploads: after 31 Oct, and in this order — HEIC conversion first, the never-skip rule only once conversion exists. Nothing refuses an iPhone photo in demo week; today's behaviour stays until then.
> 3. Yes: removing the spend limit counts as raising it. Owner only.
> 4. Agreed, not yet. A refunded failure shows 0 cr on the receipt and the word refund never appears; vendor refunds stay internal.
> 5. Mine: the visitor bar's key with a hard monthly limit, set in Coolify as VISITOR_BAR_ANTHROPIC_API_KEY, tonight or tomorrow; the Liveblocks plan name tomorrow; the export worker and relay by Monday 19 from your steps; the five scanned briefs by Monday evening.
>
> One more: #750 — one line on what it changes, before it merges.

**Lead's notes:** the five money PRs merge only on CI 24/24, a fresh Opus approval and a done money review (#765 and #800 have both; #815 has a must-fix in progress; #809 and #814 are under money review). Demo lanes B, C, D, F and H restarted 17 Oct evening; I and J follow when capacity allows.

## Owner, 18 Oct 2026, ~23:00 IST: answers to the lead's 18 Oct summary (with the advisor)

The advisor drafted these answers, and the owner confirmed them as his own, "all eight as written". They are verbatim below, with the advisor's recommendation marks removed.

> 1 Demo screens: v25. The 31 Oct demo runs on the live v25 screens. v30 is superseded: the design is settled at v31.2 (Claude Design, in review now) and the interface plan from it replaces v25/v29 for Phase B. Build nothing in the interface until the approved v31.2 zip is in the repo as THE design.
> 2 Money PRs under the standing yes: yes, for #765, #800 and #814, each only with a full CI pass at the merged head and a posted Opus money approval. #815 and #809 not until their cancel bugs are fixed and re-reviewed.
> 3 #763: yes, merge after CI and review.
> 4 #808's guard lists: yes to adding the plan_step route to the two lists, only once its two failing guard tests pass; the price-on-renders and engine-in-reason bugs fixed first.
> 5 Fix lanes: yes. Mocks only, nothing spent, within 5 cores / 20 GB. Order: #815 cancel, #809 cancel, #808, then #818's step lists.
> 6 #750: hold; merge only after item 1 is confirmed v25.
> 7 Library origin: a trained likeness is "uploaded" (a real person, carries the consent tick); anything made from it is "generated".
> 8 Commit trailer: sign as Opus 5.5, the model that runs.
>
> Data-model work you can start now, in lanes, behind switches, no interface: (a) the production record: what Atomik carries forward (brief, script and what changed, beats, treatment, look pack, elements with handles, uploads with reading notes, keeps and rejections), pinned or removed per item, free; (b) Sent status with its step (Draft · Kept · Sent → step), distinct from Kept; (c) make nodes typed by output (Image · Storyboard sheet · Video · Audio · Lip-sync · Script revision · Deck page · Upscale · Layers) with inputs as rows, bundles of cards, and the shot as the card that holds its takes; (d) step order per film type with Sound after Shots, Breakdown renamed Beats and folded into Script as views, Treatment as its own step after Script; #818's lists change to this before its switch goes on.
>
> Money behaviour (decided 18 Oct, supersedes 16–17 Oct): a Preflight card before every quote; everything Atomik makes is charged and quoted first, including plans, research, analysis and text revisions as Reading · Research · Analysis · Writing bands; the quote and the Preflight card are free; Atomik's own check of its work is free and never a line; Enhance 1 cr with no Undo; "Options" is a priced chip; Agent History one line per command; no engine name in Agent mode anywhere, History included. Bring CLAUDE.md to this, not to the 16–17 Oct wording, in a docs PR.
>
> Spikes next: the Polotno spike first (JSON writer from a deck-system spec, polotno-node render, PPTX and MP4 fidelity checked by you, not taken from their page; template and stock panels removed); then the Tiptap 3 screenplay node set with Fountain and .fdx import/export and open-source pagination; then evaluate OpenVideo Editor (designcombo/react-video-editor) for the Edit timeline with Remotion/ffmpeg for renders.
>
> Loose end: your 17 Oct vendor-terms note counted "the Vercel gateway" among eight vendors. Say which code path still references it and whether a gateway key name exists in Coolify (names only).
>
> Deploy #6 stays the owner's: backup first, then main, then deploy; before it, verify whether RIG_AGENT_ENABLED gates #805's API action and say so.
>
> Morning note at 10:30 IST, real PR numbers, nothing invented, "not yet" where not done.

## Owner, 19 Oct 2026, ~00:20 IST: answers to the lead's 00:07 update (with the advisor)

Verbatim, minus the advisor's recommendation marks.

> New questions
> 1 Enhance: price as it costs, shown before pressing. 1 cr for an ordinary prompt; a long prompt in a heavier script quotes 2 cr. No byte cap on the prompt, no lower reasoning allowance. The final figure comes from the business manager; build the quote path, not the number.
> 2 #815: yes. If a press's total would pass the workspace cap, refuse at the quote with the pause card; no shot starts.
> 3 #800: yes, 403 for an Atomik id with no run behind it; the fixture edit is allowed for that purpose only.
> 4 #765: yes, a second 80% warning after the cap is raised.
> 5 #765 follow-up: yes, add /api/usage/house-cap to the engine-dollars guard.
> 6 #700: yes under the standing yes with its money and privacy review; the export_jobs table ships only on the owner's deploy after backup. #811: yes, after #791 and #750 merge, with its own Opus review.
>
> #817, Q12–Q26 (these replace your recommendations where they differ)
> Q12 Keep is a separate mark (kept_at, kept_by), not today's approved. Today's approved is a commit; the commit is Sent. Every reader of "approved" (export, review links, shot locks) follows Sent on output steps and Kept on Look and Elements. Name each reader in its PR.
> Q13 yes and yes: Send does not need Keep; a card shows both.
> Q14 only takes sent back, with the reason given.
> Q15 one card per shot, not one sheet per beat: a beat makes one plate in Storyboard and one in Shots ("from Script · beat 4"). A Storyboard sheet is a make-node output whose panels become frames inside the shot cards.
> Q16 Sound after Shots in every film type that has Shots and Edit: Ad film, Feature, Short film, Music video, Product video, Microdrama. It is reached from the + tile (Sound · Edit · Deliver) and does not change what a new production shows.
> Q17 Treatment, on by default: Ad film, Feature, Short film, Music video. Available from the + tile's list, off by default: UGC, Product video, Microdrama, Pre-vis, Trend clip, Social.
> Q18 fold: Pitch deck is gone from Ad film; its deck is the Treatment step, with the ad film's section library. One deck per production.
> Q19 neither canvas nor document: a third surface, deck. Content stays in treatments and treatment_versions; the page format is settled by the Polotno spike (one JSON per page). No deck pages as canvas cards.
> Q20 yes, Pre-vis gets Script opened on the Beats view.
> Q21 later; unchanged in Phase A.
> Q22 untouched.
> Q23 questions are free and write no job; a plan is a Writing job, quoted first.
> Q24 Script revision: Writing. Deck page: one quoted job per page covering its words and its pictures; nothing built before the spike.
> Q25 both, each shown with who, with Undo.
> Q26 once per file; no shot triggers a reading.
>
> The ten lists, final for A1b (every Script has the Beats view; Sound, Edit and Deliver sit behind + where they are not opened by default):
> Ad film: Brief · Script · Treatment · Look · Elements · Storyboard · Shots · + Sound · Edit · Deliver
> Feature: Brief · Script · Treatment · Look · Elements · Storyboard · Shots · + Sound · Edit · Deliver
> Short film: Brief · Script · Treatment · Look · Elements · Storyboard · Shots · + Sound · Edit · Deliver
> Music video: Track · Beat map · Treatment · Look · Elements · Storyboard · Animatic · Shots · + Sound · Edit · Deliver
> Product video: Brief · Product · Look · Storyboard · Shots · + Sound · Edit · Deliver (Treatment optional)
> UGC: Brief · Creator · Hook · Script · Shots · Captions · Deliver (Treatment optional)
> Microdrama: Series bible · Episodes · Elements · Storyboard · Shots · + Sound · Edit · Deliver (Treatment optional)
> Pre-vis: Brief · Script · Set map · Elements · Storyboard · Animatic · Shots · Handoff (Treatment optional)
> Trend clip: Source · Format breakdown · Swap-ins · Copy · Shots · Captions · Deliver (Treatment optional)
> Social: Deliverables · Hook · Copy · Design · Visuals · Captions · Deliver (Treatment optional)
>
> Deploy #6 stays the owner's. Keep the draft current with #763's rollback note and the /admin allowance check. The gateway removal is its own small PR after the queue.
>
> Morning note at 10:30 IST, real PR numbers, nothing invented.

## Owner, 19 Oct 2026, ~19:00 IST: answers to the lead's 16:03 note (with the advisor)

Recorded by the lead. Item 1 is summarised by PR number only, because this file is public and must not name engine routing or prices; the full text is in the lead's private notes. Everything else is verbatim.

> First, release/1. Run 39237031538 failed at 11:00 UTC: workbench shard 9 at 33/36 sub-shards, the same as before #840, and shard 1 at 26/36. #840 merged with the browser suite skipped at its head, which is not 24/24; from now on any PR that touches tests/*.spec.ts or claims to fix the suite runs the full plan at its head before merge. Nothing merges until release/1 is green. Report the failing test names and the real cause of a 33/36 shard; "flaky at 1920" is not a cause. #800, #809 and #808 need a fresh Opus approval at their current heads before they merge.

1. Engine PRs (summary): #777–#787 are held until the server-only price file exists. That file is built next (Phase A item 4: its path set on the self-host platform, today's `lib/vendorRates.ts` untouched, tests on placeholders, never a vendor dollar in a fixture), with a click-by-click step for the owner, names only. Then #776 moves onto it, because the demo needs it. #814 follows #776 only if its bake-off is still on. #777 and #786 wait for a yes/no from Akshay. The other ten wait until after 31 Oct.

> 2 Dollar figures: yes, remove them from #814, #784 and #776; list the PR numbers whose edit history the owner must delete.
> 3 House cap: no warning on a lowering; /admin shows the new standing.
> 4 R1 yes for Ad film, Feature, Short film, Music video, Product video and Microdrama; no for UGC, Trend clip, Social and Pre-vis, whose last steps are on the rail as in the 19 Oct lists. R2 no: Storyboard's card is the shot with its panels as frames; Shots' card holds takes; a storyboard frame enters a Shots node as its Start frame row. R3 yes.
> 5 Yes: the monthly spend limit in credits, with Paused, is the budget ceiling of rule 14. The engine-dollar allowance behind #765 is the platform's guard, a separate object, never shown to a customer. #835 builds on that.
> 6 Deploy #6 is the owner's and waits for a green release/1. Backups: the scheduled job is inert by design (PARTICL_BACKUP_ENABLED unset, as docs/backup-restore.md says), so "skipped" is its normal state and not an alarm; stop reporting it as one. The pre-deploy backup is the manual routine from deploy #5.
>
> The stall from 10:15 to 15:52: check your own session log and the machine (load, memory, OOM kills) for that window and give the cause, or say "unknown" with what you checked. Add a line to the status page whenever an hour passes with no progress, so the owner sees it.
>
> Morning note at 10:30 IST, real PR numbers, nothing invented.

## Owner, 19 Oct 2026, ~19:45 IST: second round (with the advisor)

Recorded by the lead. Engine items are summarised by PR number only, because this file is public.

- **Queue:** the old queue scripts stop; nothing else runs in CI until release/1 is green.
- **#809, yes.** Owner, verbatim: "every Enhance failure is free: an unanswered or failed call replaces nothing, so nothing was made and nothing is charged; a cancelled press is never billed; a double press charges once. A successful Enhance is charged at the price shown before pressing (the 19 Oct answer on long prompts stands: price as it costs, shown first; the business chat sets the figure)."
- **#777** stays held with the others until after 31 Oct.
- **#786, yes.** Its engine is never named in Agent mode. In Director mode every still engine is offered by name with its price, with by-hand beside them. Order: the price file, then #776, then #786.
- **The price file**
  - A file mount on the self-host platform does not block a second server. Only the app reads prices; workers never do.
  - It is mounted on production and on staging, at `/etc/particl/vendor-prices.json`, readable by the app's user. It is never in the image or the repo.
  - **A converter:** a script the owner runs on his own machine. It turns a CSV export of the cost sheet into the JSON, with a validator: every engine, resolution and length the registry knows has a row; nothing negative; dollars only. A sample CSV in the repo uses obviously fake numbers. The real numbers never leave his machine except into the self-host platform.
- **Liveblocks:** the plan is Pro.
- **Scanned briefs:** the five scanned briefs (two in Hindi) arrive Wednesday 21 Oct.
- **Polotno:** the spike runs keyless until its PR names the variable.

## Owner, 19 Oct 2026 (received 20 Oct, ~01:00 IST): guardrail 4 retired

Recorded by the lead. Owner, verbatim: "the 200 cr per-job line (guardrail 4) is retired. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with its Paused state. #815 keeps "a multi-shot press is one job, one approval for the total" and drops the guardrail-4 check; a press whose total would pass the workspace cap is refused at the quote. Update CLAUDE.md's pricing section and the rulebook in the docs PR; a money review on the #815 change. Nothing else in the money behaviour changes."

- **#815:** the batch guardrail-4 check is removed, and the press is refused at the quote when its total would pass the workspace cap. It gets a money review before merge.
- **Docs PR (CLAUDE.md):** guardrail 4 is struck in CLAUDE.md's pricing section and in the scope of work. The scope of work is read as the rulebook: `docs/particl-sow-v1.md` §7A and `docs/particl-sow-2026-10-04.md` rule 14 / §10.
- **Unchanged:** the per-job line on single jobs stays in the code until the owner asks for a PR to remove it.
- **Open:** whether Auto mode (spending without a tap) stays, given "every job is approved on its quote".

## Owner, 20 Oct 2026, ~01:20 IST: answers to the 19 Oct status page

Recorded by the lead.

1. **Guardrail 4.** Verbatim: "Guardrail 4 is retired everywhere, single jobs included: no per-job line in the product. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with Paused. Strike it in CLAUDE.md and the scope with a dated note in the owner's words, and in the code with its own money review; keep the workspace cap and the house cap exactly as they are." This widens the earlier answer: the code PR removes the line everywhere, under a money review.
2. **Attended capture:** the night of Wednesday 21 Oct into Thursday 22 Oct, 02:00–03:00 IST. The fallback is the same hour on Friday 23 Oct. The lead writes the owner a click-by-click, with the undo for each step and the abort condition at every stage.
3. **The price file (#843)** merges under the standing yes after a full 24/24 run at its head. #776's lip-sync goes on top of it. The owner mounts the file once #843 is on release/1; it is the only variable, and only names are used in chat.
4. **The twenty other PRs with "$" in their descriptions:** list which hold vendor prices and which hold caps. Strip the vendor prices; the owner then deletes their edit history.
5. **Deploy #6** waits for the owner, who takes it when release/1 is green, with the backup first.

## Owner, 20 Oct 2026, ~13:30 IST: answers to the 13:20 update (with the advisor)

Recorded by the lead, verbatim:

1. "Q1: B. An admin sets a ceiling per token in credits per month; every paid request from a token or an MCP client carries its approved quote; a token with no ceiling can only prepare and price. With that, retire guardrail 4 in the code (branch feat/retire-guardrail-4) after its money review and a full run."
2. "Q2 Auto goes: every job is approved on its quote; "Ask before every take" off means one approval per step. Q3 a big Atomik step still goes to an admin, keyed to the workspace cap, never to a fixed figure. Q4 the per-render ask over 200 cr goes. Q5 the balance check, token ceilings, run limits, project caps and the per-shot rule stay."
3. "House cap: yes, a third warning after a second raise; never twice at the same figure."
4. "#852: yes, merge under the standing yes, off behind RECRAFT_ENABLED. The first real Recraft run needs its own yes with the estimate. Close #786."
5. "Demo: the card says Sent. "Other" needs a line, one word is enough. The demo runs v25's Film steps as they are; v30's lists stay behind their switch. A viewer's mode on a teammate's board is their own and kept. The base language is English and does not count toward the twelve."
6. "Capture: Thursday 22 Oct, 02:00–03:00 IST. The owner takes the Wednesday prerequisites at 12:00 and 18:00; first on that list is rotating every production credential the old Vercel project still holds (the self-host platform first, then removed from Vercel), with the undo for each step. Write that one click by click, names only, before the rest."
7. "The owner places SYNC_API_KEY now and RECRAFT_API_KEY once #852 is on release/1, both switches unset; VENDOR_PRICES_PATH and the mounted file with them. Say in the morning note that the names landed, from the readiness endpoint, never the values."
8. "Deploy #6 stays the owner's, after the capture."

## Owner, 20 Oct 2026, 16:50 IST: answers on #854 and the 15:15 questions

Recorded by the lead, verbatim:

"#854 (token ceilings): yes on the money, once its full run is 24/24 at b3dd17c5. Its six questions:
1. Yes: add quoteShot to /api/openapi and the one NOT_SPENDING entry for it in tests/helpers/paidRoutes.ts — that entry is my word, not a lane's.
2. Yes, revoking members' tokens by an admin as a follow-up.
3. Confirmed: the house in dollars, every other workspace in credits.
4. Yes, an identity-stills quote step as a follow-up.
A. Yes: a person's Release of a held take made by a no-ceiling token is that person's approval and starts it, recorded under the person. Who may release is unchanged.
C. Yes: a token with a ceiling spends inside it whatever the workspace's Ask setting — the ceiling is the standing approval. lip_sync follows the same rule once Auto goes, so the two tools behave alike."

"15:15 questions:
A. "The workspace cap" in Q3 is the per-shot rule cap in lib/approvalRule.ts. The monthly limit is a stop (Paused), never an escalation.
B. Right: until A4 lands, one approval per job on its quote. The switch arrives with A4."

"Wording: keep both ("One line, optional · ⏎" / "One word is enough · ⏎", label "Why")."

"Guardrail-4 removal: open its PR after #854 merges, rebased on it, with the money review posted. I say yes on the PR, not the branch."

"Keys and the price file are mine. Nothing for you there."

Lead's note: #854's run at b3dd17c5 failed on one browser fixture (a token minted with no ceiling expected to render), so the yes, pinned to that head, is asked again for the fixed head.

## Owner, 21 Oct 2026, 01:30 IST: LangGraph, the demo date, one app, Langfuse

- 21 Oct 2026: **Atomik's loop is built on LangGraph.js** (final; SOW S2). Library only (`@langchain/langgraph` pinned, `@langchain/core` as its dependency, nothing else from LangChain); the money gate does not move; checkpoints are tenant rows; Inngest is the one owner of time; three slices before the demo; design note first, before any code.

Recorded by the lead, verbatim (item 1 restates the 16:50 answers of 20 Oct above, unchanged; the yes stays pinned to b3dd17c5):

"2. There is no staging app. The droplet runs one Coolify application, and it is production. Read "production and staging" in your notes as production only: the price file, the Langfuse names and every new setting go to that one app. A staging app (same image, the staging Turso group, its own R2 bucket, ENGINE_MOCK=1, staging.particl.si) is P4 from the 5 Oct handover and comes after deploy #6, as its own PR; nothing before the capture."

"3. Langfuse is set up: EU region (cloud.langfuse.com), one project "particl". Keys are in Coolify on the one app under LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, LANGFUSE_ENVIRONMENT=production; LANGFUSE_ENABLED is unset and stays unset until I turn it on after deploy #6.
One PR, standing yes after Opus (no money logic): trace every model call Atomik makes — chat turns, the board planner, Enhance, condense, memory ranking, Verify, the development kinds — through the AI SDK's telemetry hook into Langfuse. Each trace tagged: workspace id, run or chat id, step, mode (agent / director), band, model, effort, tokens in / out / cached, vendor cost, latency, outcome (answered / refused / failed / timed out), environment. Never prompt text or outputs (SOW §13 item 8): record inputs and outputs off. Off unless LANGFUSE_ENABLED is exactly 1. In CI, trace to a stub and assert every model call site is covered (a closed list, like paidRoutes). Pin the SDK."

"4. LangGraph: final. Atomik's loop — plan → preflight → quote → approve → drafts → check → fix → final → review → remember — is built on LangGraph.js, as SOW S2 says. Rules:
a. Library only: @langchain/langgraph pinned, @langchain/core as its dependency, nothing else from LangChain — no chains, no LangChain model wrappers, no LangGraph Platform, no LangSmith. Nodes call the existing AI SDK / direct provider paths. Tracing stays on Langfuse.
b. The money gate does not move. A person approves spend in Particl's code (plan-approval, isPersonApprover, the spend reservation, admission). LangGraph's interrupt pauses the graph for that approval; it never grants it. Every paid node goes through admission and the quote as now; the money tests run unchanged against the graph.
c. Checkpoints are tenant rows: checkpoint and state tables in the workspace's database with workspace_id on every row (rule 2); no shared store across workspaces. There is no Turso checkpointer in the box: a BaseCheckpointSaver on libSQL (the SQLite saver's shape), or justify another in the design note.
d. One owner of time: Inngest keeps retries, leases and wakeups and calls the graph to run or resume; the graph never sleeps or schedules on its own.
e. Slices, in order, each a PR with full CI, Opus review and a money review where it spends: (1) foundation — graph skeleton, the checkpointer, the Inngest handshake, Langfuse on every node, the money gate untouched; (2) the chips plan; (3) the board ask, with the planner reading the whole production (brief, script beats, kept Look, Elements, frames, cast, memory, rules, History) as a context node. Chat/Make, Genie, the development kinds and Import come after the demo. The old run/step machine stays until a slice passes the same suite and the money tests on the graph, and is removed in that slice's PR, never left beside it.
f. Design note first — graph shape, checkpointer, handshake, test plan, your estimate — before any code. Record the decision as a dated line under Owner decisions in docs/redesign-plan.md and in the restart message."

"5. The demo comes after LangGraph, and its date follows the work: slices 1–3 green on release/1, deploy #7, a rehearsal, then the demo. Go/no-go on 1 November: if 1–3 are not green on release/1 by then, the demo runs on the old machine on the first date I set, and LangGraph continues behind it. The 31 October date is off. The capture (Thu 22 Oct, 02:00 IST), deploy #6 after it, and Vercel off on the 27th do not move."

"6. Keys and the price file are mine; nothing for you there."

## Owner, 21 Oct 2026, ~10:30 IST: #854, #811, Director, Langfuse, the LangGraph design note's 16 answers, the demo

- 21 Oct 2026: **the demo comes as soon as possible, on the graph, with every element in place.** The owner: "I want the demo asap. I don't care about the date, but it has to be with all elements in place. A full working unit." This drops the fixed date, the 5 November checkpoint and the fallback to today's machine that option [A] in the design note had offered. It replaces the 1 November go/no-go. The lead reads it as: slices 1–3 green on release/1, then deploy #7, then a rehearsal, then the demo, with no date. What "all elements" takes in is asked separately.
- 21 Oct 2026: **sequence.** The money PRs in flight land first (#854, the guardrail-4 PR, #811, the Director follow-ups, the #815 press fix), and slice 1 rebases on them.

Verbatim:

"#854: fresh yes at 553b10b9. Put it back on the queue; merge on a full 24/24 at that head.
The Make phone test: yes, fix it to check what the button settles on (stricter), as its own PR, under the standing yes.
#811 (Director on Shots): yes at 73da41b8. Its questions: (1) no split — a press is at most 24 shots, with the plan's own line ("up to 24 at a time; pick some"); a bigger job is two presses, two approvals. (2) Yes, Atomik may prepare a press: it fills it, prices it, and a person taps. (3) Yes, the approval binds the total: per-shot shifts that keep the total at or under the approved figure run; a higher total asks again.
Director follow-ups: (a) yes, fix the #815 press route (a repeated press near the cap shows the running press) as its own money PR. (b) Retry's price is only the shots left: what failed unbilled re-runs under the same approval; what was charged stays charged. (c) No — held approvals expire as plans do (7 days); an expired one asks again at the current price. (d) Yes, offer "Render again" on a charged failure, as a new quote and a new approval, with what the failed one cost shown.
Langfuse: (1) project members are platform admins only. (2) Count both, distinguished: ours as "refused" with sent:false, the provider's as the provider's. (3) Yes, trace the image, video and voice engines later, with the ledger PR; ids only."

"LangGraph design note — by number:
1 Yes: the per-render functions stay as they are; the graph drives them.
2 Yes: cut by phase. My "chips plan / board ask" were names; the phases are the units.
3 Yes: the four packages come along, never imported; the allowlist and the LangSmith refusal are the fences.
4 (answered separately, below)
5 Yes: the cron, the card-read nudge and the native worker stay as wakers; wake_at onto step.sleepUntil as its own small PR after slice 2, cron as the safety net.
6 Yes: keep the database lease.
7 Yes: amend S2 in slice 1's PR, dated — the gates are plan approval, isPersonApprover, the reservation and admission.
8 Leave the old run tables; no PR for now.
9 Plain JSON with no revival is the goal: test both in slice 1 and adopt plain if the suite passes; the default is the fallback, not the choice.
10 Yes, "final" passes through in slices 1–3 — and the all-in quote (drafts, finals and up to two fixes under one approval, 18 Oct) is the first item after slice 3, on the graph, with its money review.
11 Yes, drop the 600 ms pause.
12 Langfuse is merged (#855, #856): slice 1 can start; session.id = runId.
13 Yes: cap the context node at the cost sheet's planning assumption (30k input tokens) so the "up to N cr" holds; money review and my yes in that PR.
14 Yes, "remember" does nothing in 1–3; later it proposes, a person keeps.
15 Yes, the LangSmith refusal pauses the run with its reason on the health page.
16 I'll confirm Turso's encryption at rest from the console; no design change.
Sequence: the money PRs in flight (#854, the guardrail-4 PR, #811, the Director follow-ups, the #815 press fix) land first; slice 1 rebases on them. No LangGraph code before 2 and 4 above are answered — they are now."

Question 4: "Okay so answer for 4. I want the demo asap. I don't care about the date, but it has to be with all elements in place. A full working unit"

## Owner, 21 Oct 2026, 12:30 IST: today's decisions, in the order to work them

The verbatim text is kept by the lead. It names engines, vendors and operations, which this public file leaves out. The rules for everything below: a design note comes before any code on something new (sections D–I); every PR that spends or touches a money path gets an Opus money review; nothing here moves the money gates; and no prompt text goes into a trace, a checkpoint or a graph.

**A. Today's operations (the owner's; the lead watches and prepares)**
- 21 Oct 2026: credential rotation before the capture is replaced by a pause. The old hosting project's variables are deleted and the project is paused. The production app keeps its variable names. No key is rotated before the capture.
- 21 Oct 2026: the recovery fence's points. The old hosting project is paused, not fenced. The production app's id plus its commit is the deployment id. Every worker that holds storage keys is listed. Background dispatch is not paused. The sync cron stays on.
- 21 Oct 2026: model-call tracing is switched on in production config. There is no deploy before the capture; deploy #6 (the owner's) picks the setting up, and then the owner confirms the traces show numbers and no words.
- 21 Oct 2026: the render worker moves off the old hosting on Thursday or Friday, following ops/render-worker, with the lead watching. The old-media → R2 copy and its verify run the same day. The 27 Oct cancellation of the old hosting goes ahead only if both are green; otherwise it moves a month.
- 21 Oct 2026: one app, no staging. Staging (P4) comes after deploy #6, as its own PR.

**B. Money PRs in flight: these land first, in this order**
1. #857 (the stricter Make phone test), under the standing yes.
2. #854 at 553b10b9: merge on a full 24/24 run against today's release/1.
3. #858 at d908e82d: yes on a full 24/24. A first press keeps matching its quote exactly. "Binds the total" applies only to retries and held approvals.
4. The press-recovery client PR:
   - Retry costs only the shots left;
   - a held approval expires after 7 days;
   - Render again is a new quote that shows what the failed take cost;
   - "up to 24 at a time", with no split over 24;
   - Atomik may prepare a press, and a person taps;
   - the approval binds the total.
5. The guardrail-4 removal PR, rebased on #854, with its money review posted. Auto is gone everywhere.
- 21 Oct 2026: rule 14 gains the capped-token wording, as a dated amendment in the owner's words.
- 21 Oct 2026: engines #777–#787 stay held until after the demo. When they return, they go onto the price file.
- 21 Oct 2026: model-call tracing (restated). The tracing project's members are platform admins only. Refusals are counted both as ours (sent:false) and as the provider's. Engines are traced later, with the ledger.

**C. LangGraph (final) and the demo**
- 21 Oct 2026: the design note's 16 answers stand as recorded this morning.
  - Slice 1 starts after B, and slices are cut by phase.
  - Each slice deletes the old driving code it replaces. The per-render money code is untouched.
  - Checkpoints are tenant rows on libSQL, and Inngest owns time.
  - The serde is plain JSON if it passes.
  - Slice 3 caps the context node at 30k tokens, with a money review and the owner's yes.
- 21 Oct 2026: **the demo is a full working unit**:
  - **The path:** brief in → beats → kit → frames → shots → sound → cut → deliver.
  - **How it runs:** in Agent mode, end to end on the demo production.
  - **What that takes:** slices 1–3 plus Import v1 (H), with Chat/Make as it runs today.
  - **Left out:** Genie and the development kinds.
  - **Date:** none. Import v1 is estimated, in the design note's style, after slice 1.
- 21 Oct 2026: the first item after slice 3 is the all-in quote on the graph, with its money review: drafts, finals and up to two fixes per shot under one approval (18 Oct). Next, Verify is wired in as the free self-check, with the fix loop running under the allowance.

**D. The ledger (the truth, in Turso)**

A lane beside slice 1 that touches no `rig-agent*` file. A design note comes first, covering the schema, the index, the lineage tool, the digests, the privacy tests and the backfill.

- 21 Oct 2026: every generation, Director rows included, gets a provenance row. The row records:
  - the command and who gave it, the mode, and the step and beat;
  - the inputs with their roles;
  - the engine, mode and size (agent-private);
  - the person's words and Atomik's rewrite (the rewrite is agent-private);
  - the quote and the charge;
  - the check verdict, the fix number and what changed;
  - the parent assets;
  - the person's action (Keep, Sent, or ✕ with a reason);
  - timestamps.
- 21 Oct 2026: agent-private fields are never served: not in an API response, an export, a History line, a receipt or an error. A closed-list guard fails CI if a route starts to serve them.
- 21 Oct 2026: how the planner uses the record.
  - It reads the record's index (one line per asset) on every call.
  - `lineage(asset)` is a tool that fetches a chain on demand.
  - A digest is written at each Sent.

**E. A graph index (decided), after the ledger**
- 21 Oct 2026: a dependent back-end index. It is never the front end, never the truth, never exposed as a query surface and never offered as a service; under its licence it is an internal component only.
  - One named graph per workspace, holding ids only.
  - Projected from the ledger by a sync worker, and rebuildable with one command.
  - The agent reaches it only through fixed, parameterised queries (lineage, related, where-appears), never free-form queries from a model.
- 21 Oct 2026: before any PR, a two-day spike on the house's own productions, reported with numbers. Vectors stay in Turso if the graph engine's disappoint.
- 21 Oct 2026: the graph runs as a container on the droplet's internal network, with no published port and persistence on. Its dump goes into the backup and the capture runbook. A fallback engine is named.

**F. Cross-production search (decided)**

A lane beside slice 1.

- 21 Oct 2026: version 1 lives in the workspace's database, as a take index built from the ledger with a libSQL vector column.
  - workspace_id is on every row, private boards are excluded, and existing generations are backfilled.
  - Search is SQL filters plus `vector_top_k`, in one query.
  - The Library gets a plain-language box; Atomik turns the sentence into filters and a query.
  - "Use in this production" copies the kept take or still into the current Library, with its lineage.
- 21 Oct 2026: embeddings come from one pinned model on an existing provider key; models are never mixed. Search is free to the person. The embedding and parse calls are cost rows for the sheet and are traced as ids and counts only.

**G. The interview, the read-back and show-then-ask (design note first)**
- 21 Oct 2026: the questions are about the film, never the craft. They come from a slot-filling engine: slots are schemas, and the catalogue sits in the platform layer, per film type × step.
  - **Filling:** every slot is filled first from what already exists.
  - **What is asked:** only a slot that is empty and changes the money or the film.
  - **How:** one question at a time, with chips and "Decide for me" beside each. At most three per step.
  - **Decided slots:** shown together as one line with Change. A slot answered once is never asked again. What the director has already decided is locked.
- 21 Oct 2026: the Brief interview is the owner's ten groups, answerable in one monologue.
- 21 Oct 2026: the read-back.
  - Before any plan, a read-back page shows one page in the director's own words, with Change on every line.
  - It seeds the Treatment.
- 21 Oct 2026: show, then ask.
  - Every craft step opens with a proposal to react to.
  - A bare question comes only where there is no default and a price is attached.
  - ✕ reasons feed the next question.
- 21 Oct 2026: preflight shows the kit it joined, with one-tap fixes.
  - Shots inherit their beat's kit.
  - A name that matches nothing is asked about, never rendered silently.
  - No card says join, wire, reference or element.
- 21 Oct 2026: hide the how (as decided 16–18 Oct).
  - **What Agent mode shows:** the what and the price, never the engine, mode, rewritten prompt, fix path or routing.
  - **Switching modes:** allowed per step, per person. Each mode prices its own work, and no allowance carries across.
  - **The plan:** a priced band whether or not it runs.

**H. Import v1 (part of the demo unit; design note first)**
- 21 Oct 2026: "+ Import" goes on Home and on the Script and Storyboard steps, with drop-anywhere on those two steps and the camera roll on the phone.
  - Anything is accepted, and nothing is ever "unsupported".
  - Everything imported lands in the Library as uploaded.
- 21 Oct 2026: Atomik reads an import into beats, in plain words.
  - Guessed fields are marked, and its questions are batched into one preflight.
  - Name matching against the Library asks once.
  - The reading is a priced Reading band, shown before it runs.
- 21 Oct 2026: two rules for drawings.
  - A drawing says where things are and what happens, never what things look like.
  - A drawing is never a first frame. It becomes the beat's storyboard frame first, and the kept frame is what the shot starts on.
- 21 Oct 2026: an evaluation set of real amateur inputs runs on every change.

**I. Narration (with G; design note first)**
- 21 Oct 2026: Talk on the bar at every step and on the phone. Clips arrive by tap-to-record or as voice-note uploads.
  - Transcription runs on existing provider keys, with a language-hinted fallback for Hindi-first clips once it has been tested on the owner's voice.
  - Audio goes to the workspace's R2. The transcript goes into the production record as the person's own words.
  - A "Here's what I heard" card shows the open gaps.
  - The narration is re-read to fill the interview's slots, and later clips override earlier ones.
  - Narration never spends and never reaches tracing. It is proposed as free to the person, to be confirmed in the note.

**J. Not decided: do not start**
- 21 Oct 2026: none of these start until the owner sends their own instruction:
  - the per-step model and effort policy;
  - the engine-doc mismatches;
  - model version changes;
  - Director list changes;
  - the joining rule as the Auto default;
  - the business sheet's open items.

**Order of lanes**
- 21 Oct 2026:
  1. B first.
  2. Then, in parallel lanes: C slice 1, D, F, and the G/H/I design notes. None of these touches `rig-agent*`.
  3. E's spike, once D's schema is agreed.
- Nothing new merges while a slice's rebase is pending.
- Every design note goes to the owner, with its estimate, before any code.

## Owner, 21 Oct 2026 (afternoon): SOW amendment, ruleset, dataset, stepset

- 21 Oct 2026: the owner's ruleset (R1–R15), dataset (D1–D8) and stepset (S1–S2) are added to docs/particl-sow-v1.md as "Amendment, 21 October 2026", in his words. That PR is docs only. **[money]** items (R11, the agent margin factor) get their own code PR under a money review. **[schema]** items (R7, the film record) go to the owner before any migration.

The owner's words, mirrored:


### Ruleset

**R1 Positioning (owner):** tools like Artlist cater to those who "walk, talk and speak film"; Particl gives "structured filmmaking in the hands of every other person with a keen interest." Every screen and line of copy is judged against that person (extends ground rule 6).

**R2 Questions are derived, never fixed.** Each step has a checklist of decisions (D1). The agent fills it from everything known (brief, interview, earlier steps, the film record, house defaults); each row is known / assumed / open. Only open rows that change the result or the price are asked — in the film's own nouns, at most three per step, the agent's pick preselected. Assumed rows read "I assumed … · Change". A gap no checklist lists may be asked only in the fixed shapes (something to point at, chips, a default, "talk"). Which rows get asked is deterministic and tested on mocked briefs: a brief that says "Hindi VO" is never asked the language question.

**R3 Judge, don't specify.** Every step shows a proposal first; the question is answered by pointing. "Decide for me" is the default; "Just make it" runs every default to one read-back page and one quote. "Options" is priced, sits at the cheapest stage that answers, and the button says so ("Options · 3 frames · 9 cr"). Options are never free.

**R4 Genre (owner):** "each film comes in its own genre." Set once in the Brief, never asked again; it keys per-genre defaults and chip sets at every step (D2). The three options the agent shows are all inside the genre, differing on the axis the genre cares about.

**R5 Continuity.** The storyboard is planned as coverage from D3. Side of the line, time of day and light are scene rows set once. Frames are drawn from the kept cast stills and the kept look. The free self-check flags a crossed line, a missing reaction or a wrong eyeline with one-tap fixes ("Flip" · "Add reaction frame · 3 cr"). "Play as a cut" (animatic, free) is a view on every rail. A frame is the first frame of its shot; "Continue from here" seeds the next shot from the end of the last.

**R6 Shot by shot (owner: "a very step by step and shot by shot process").** Agent mode runs Storyboard and Shots one item at a time. The plan is approved once as "up to N cr"; the person's Keep on item N releases item N+1; stopping charges only what was made. "Board all" / "Shoot all" are chips at the same per-item price with the self-check as the gate between items — offered, never the default. Director mode is one card at a time; the multi-shot press stays as its batch (#815).

**R7 The film record [schema].** One record per film: every checklist row (value, source), every change (when, why — the chip pressed), the interview as spoken, every kept and rejected take with its reason, every approval. It is the agent's only input: every turn loads the whole record (a digest per step always; full detail on demand from the index). It is the LangGraph state, checkpointed as tenant rows. Changes ripple: a changed row lists what downstream it touches and offers "Carry the change", priced if anything is remade. Test: at Deliver, for every mocked film, the agent answers "what did they say at Brief about X" from the record alone; Langfuse shows which rows each turn read.

**R8 Two modes, further apart; no third mode.** Agent is the default front door ("What are we making?" — the interview). Director sits behind one line, "I speak film", and opens with Import or a blank board. Agent: plain words; film words underlined with a one-line definition on hover (tap on phone); works in films; one all-in quote per command; review is Keep · Change something · Options; phone-first. Director: film words, engines, settings, the rate card; works in shots; the take grid; desktop-first. One bridge, one direction: a shot opened in Director mode opens with no engine and no prompt. Nothing in Agent ever shows the how.

**R9 "?" on every step.** A card of three lines (what this step is · what you do · what comes next) and a 15-second loop. Opens itself once on a stranger's first visit to a step, then waits behind "?". Last line "Show me on my film" runs Atomik on the person's own project, priced as a planning turn. Cards are static text shipped with the app (D5); loops load lazily from storage (Cloudflare R2); nothing generated live. On the phone, a sheet.

**R10 Director mode, comprehensive:** angle, shot size, move, light, camera, lens, depth of field, frame rate, grain — pickers with pictures, Auto default, folded in the Inspector (rule 13). They write prompt lines through the rule library and set an engine parameter only where one exists. This is the camera bank of ground rule 3: platform list, workspace additions. The panel's "?" says a camera or lens name nudges the look; no engine simulates the glass. None of it appears in Agent mode.

**R11 Agent margin [money] (owner: "Agent mode is the money maker").** One factor applied in the quote path to agent-originated jobs: AGENT_PRICE_FACTOR, env-set, default 1.0 until the owner sets the number, read nowhere else, shown nowhere; the all-in quote hides the breakdown. The number is the owner's.

**R12 Recipes by outcome.** The + menu offers five or six outcomes per rail in plain words ("Make my product the hero"); each is upload + ≤4 chips + one quote, built as a board skill (rule 12). Techniques live inside Options at a step, priced. Not a preset gallery.

**R13 Elements for people who own nothing.** ~~A stock cast and stock places in the platform layer, pickable in one tap;~~ a voice bound to each cast member; a real face needs consent on file; a character sheet from 1–5 photos with one hint: "even lighting and a plain background works best."

**R14 Money copy [money] (owner's call, later):** plan cards in films ("about two 30-second ads a month"); price on the button; Top up on the button when short; a 480p draft row on the rate card.

**R15 Not taken from Artlist:** engines in the user's face, Unlimited tiers, a second canvas, hover-only prices, an agent that names the engine, a prompt asked of the person.

### Dataset (tables in code, platform layer, overridable per workspace)

**D1 Checklists** — per rail × step, one row per decision: id · what it sets downstream · default source (brief field / earlier step / rail / house history / none) · money attached · question shape (pick one / A-B / yes-no / tap the frame / upload) · decide-for-me allowed. Beside lib/productionModel/filmTypes.ts.

**D2 Genre table** — ten genres per rail × the steps that vary: Script pacing and beat count; Treatment deck style and "what's off" chips; Look palettes and chips; Storyboard coverage bias; Shots duration and move defaults; Sound moods and voice sets; Edit rhythm and end-on default. The owner writes the rows.

**D3 Coverage patterns** — dialogue → shot/reverse on one side of the line; action → action then reaction; entering → wide then close; product → approach then detail; screen-direction rules.

**D4 Picker vocabularies and the camera bank** (R10), a picture per item.

**D5 "?" cards** — rails × steps × three lines (the Ad film set is written and approved: the product speaks, not Atomik) + one loop per step.

**D6 Glossary** — film words, one-line definition, thumbnail; feeds Agent underlines and Director tooltips. One vocabulary (rule 5).

**D7 Recipes per rail** (R12); ~~stock cast and places (R13)~~.

**D8 House defaults** — a row a workspace has answered the same way three times becomes its default and stops being asked (from the ledger).

### Stepset

**S1** The per-step catalogue (Script → Deliver, plus the other rails' extra stages) is the example bank for D1, not a fixed list: each stage opens with a proposal, a judging prompt, at most three bare questions only where no default exists and money is attached, and what each answer sets and carries forward.

**S2 Agent mode sequence:** Brief (interview, genre) → read-back "How I'll make it" → Script → Treatment → Look → Elements → Storyboard (shot by shot; play as a cut) → Shots (shot by shot; preflight; one quote) → Sound → Edit → Deliver. A stranger is asked once; nothing is asked twice.

## Owner, 21 Oct 2026: answers on the SOW amendment's conflicts, and #860

- 21 Oct 2026: **#860** yes at 89825b7b, for that head only, and only once the CI rerun is green. A new commit needs a new yes. If the rerun fails again, #860 comes off the queue and the lead says what failed.
- 21 Oct 2026: **R9** reads "loops load lazily from storage (Cloudflare R2)". #861 was already merged, so this went into the follow-up docs PR #862.
- 21 Oct 2026: **R11 vs rule 11.** Rule 11 stays: the same tool costs the same through every path. The agent factor is a mode price, keyed on who chose the engine.
  - A job Atomik routed carries `AGENT_PRICE_FACTOR` whatever path started it; a job whose caller chose the engine never does.
  - That sentence goes in rule 11 and § Pricing.
  - The public rate card stays the Director rate card, and Agent prices are the all-in quote.
  - Platform-admin margin reporting includes the factor; nothing customer-facing shows it.
- 21 Oct 2026: **R8/R15 vs rule 13.** In Agent mode, the Auto line shows the what and the price ("Final · 5 s · 51 cr · Change"). Rule 13's engine-named example becomes the Director example; the label changes, not the rule.
- 21 Oct 2026: **R5 vs rule 14.** The self-check is free to the person and absorbed as a cost row in admin reporting (18 Oct: "Atomik's own check of its work is free and is never a line"). The planning-turn sentence covers Atomik's thinking for the person.
- 21 Oct 2026: **R14** is [money]. The 480p draft row is a rate-card change and gets its own money PR when the owner calls it.
- 21 Oct 2026: **R7 and tracing.** Ids and timings only, never words. The interview as spoken lives in the film record in Turso and nowhere else; tracing logs row ids.
- 21 Oct 2026: **R6.** One approval; Keep releases the next item, with no second tap.
- 21 Oct 2026: **R8.** "No third mode" means Agent and Director, and the Ask/Auto spend setting is a separate thing. The owner also wrote "(Auto's ceiling stays until I decide whether Auto stays)". That conflicts with his 20 Oct "Q2 Auto goes" and his 21 Oct 12:30 "Auto gone everywhere", so the lead has asked him which stands. The guardrail-4 PR, which removes Auto, is held until he answers.
- 21 Oct 2026: **correction to R13 and D7 (the owner):** strike "a stock cast and stock places in the platform layer, pickable in one tap" and "stock cast and places (R13)". Particl ships no stock elements, cast or environments. Every element is the person's own, uploaded from references or generated from the script line under the plan's quote. Atomik teaches the newcomer how: the Elements "?" card, "Show me on my film", the upload hint "even lighting and a plain background works best", and the consent tick for a real face. Everything else in R13 stands.

## Owner, 21 Oct 2026: additions to the amendment (R16–R18, R3 amended, D6)

These are recorded in docs/particl-sow-v1.md, "Additions, 21 October 2026", in the owner's words. The glossary draft is docs/glossary-d6-draft.md. The docs PR comes first, then the code PRs.

- 21 Oct 2026: **R16, file names are Particl's.** Every file a person downloads, exports or sees in the Library is renamed on the way out, to `prtcl-<project>-s<shot>-t<take>-a<asset>-<yyyymmdd>.<ext>`.
  - For things without a shot, the shot slot names the kind: el, lk, tr, sd or ms.
  - The vendor's file name never reaches a person.
  - Metadata fields that name a tool, encoder or software are stripped.
  - **[legal, owner]** Invisible watermarks and signed provenance manifests stay until the owner decides with counsel.
  - The code PR lists every reader of a file name.
- 21 Oct 2026: **R17, failures never name the vendor.**
  - In Agent mode, a failure reads "Nothing billed" (or what it cost) in Particl's words.
  - In Director mode, the refusal is rewritten in plain words.
  - The vendor's own message never appears.
- 21 Oct 2026: **R18, Quick Look tools by mode.**
  - The lasso, the element selector and "Change this · one quote" are Agent mode only.
  - The Director's Quick Look judges and compares; the Director fixes by hand through Inputs and the prompt.
- 21 Oct 2026: **R3 amended.** Options are never free: the three frames are billed, and the ideation behind them is billed as a band.
- 21 Oct 2026: **D6.** The glossary draft has about 150 words, each marked A or D. The owner edits it; then it ships as data, with a thumbnail or loop per entry.

## Owner, 21 Oct 2026: export and render pricing (restates 13 Oct)

- 21 Oct 2026: **rendering what has already been made and billed is free.** That covers the cut, 1080p masters, cutdowns and reframes that are crops, captions, the technical check, and Export to editor. The button reads "Free", and a receipt carries no line for it.
- 21 Oct 2026: **another tool's processing inside the render is a priced engine step**, with Particl's markup, quoted before the press. That covers 4K upscale (or a native 4K re-render), Re-frame that repaints, lip-sync, voice and music. The export button then shows one figure, the paid steps' total, and never a breakdown of the free parts.
- 21 Oct 2026: **4K** is free only if the takes were made and billed at 4K. Otherwise it is priced as the upscale it is.
- 21 Oct 2026: only the owner changes this. Prices come from the rate card path.

## Owner, 21 Oct 2026: spend approvals and the monthly limit [money] (advisor's reading pending the owner's line-by-line confirmation)

- 21 Oct 2026, the owner's words: "no pausing cards, let team members gen to their hearts content till their credits run out. no need for admins to approve a take when they're flying away to a place with no network and nobody to approve a take."
- The advisor's reading, which the owner confirms line by line. **Pending: no code until he does.**
  1. The workspace approval rule (a step over the rule's cap needs an admin; lib/approvalRule.ts) is retired. Every member approves their own spend from the workspace pool, with their own tap on the quote. "Only a person approves spending" stands: Atomik, tokens and MCP callers still cannot approve.
  2. The monthly spend limit stays as a mechanism, off by default. When a workspace sets one and reaches it, there is no Paused card: the quote button reads "Monthly limit reached · ask <owner>", and only the owner changes or removes the limit (17 Oct). Workspaces that set no limit spend until the balance is zero, where Top up is offered at the quote, as today.
  3. The house cap (Particl's own ceiling on platform spend) is not a customer rule and stays exactly as it is.
  4. "Ask before every take" remains a person's own setting for their own presses. Ask is the default. Auto's fate is still the owner's decision.
  5. Code: one PR removes the approval-rule gate and the Paused card, under a money review. CLAUDE.md § Owner decisions and the SOW get the dated note. The 19–20 Oct sentence "the only automatic stop is the workspace's monthly spend limit with its Paused state" is struck and replaced by lines 2 and 3.
- What line 1 would change: rule 14's sentence "A plan's approval follows the workspace's rule in lib/approvalRule.ts: a step over the rule's cap needs an admin", the owner's 20 Oct Q3 ("a big Atomik step still goes to an admin, keyed to the workspace cap"), and the guardrail-4 PR, which keeps that admin gate.

## Owner, 21 Oct 2026: spend approvals confirmed; Auto retired; "free"; 4K and reframes

- 21 Oct 2026: **all five lines are confirmed, in the owner's words.**
  - **Approval:** the admin approval rule is retired. Every member approves their own spend with their own tap on the quote. Atomik, tokens and MCP callers still never approve.
  - **What this strikes:** his 20 Oct Q3 ("a big Atomik step still goes to an admin") and rule 14's sentence "a step over the rule's cap needs an admin". Both are struck with this dated note.
  - **The monthly limit** stays as a mechanism: off by default, owner-only, with no Paused card. The button reads "Monthly limit reached · ask <owner>".
  - **The house cap** stays exactly as it is.
- 21 Oct 2026: **Auto is retired.** Every job is approved on its quote by the person pressing. The "Ask before every take" setting goes; line 4 becomes "no per-person spend setting".
- 21 Oct 2026: **order.** Guardrail-4 is no longer held: land it first, then the approval-rule PR on top, each under its own money review. The owner approves the code PRs on their money reviews.
- 21 Oct 2026: **"free"** is lowercase everywhere, the rule 14 spelling.
- 21 Oct 2026: **4K and reframes.** A crop is free. A 4K master is priced as the upscale unless the takes were made and billed at 4K. A reframe that repaints is priced. Rendering what was already made and billed is free.
- 21 Oct 2026: **the 4K-refusal fix** is described to the owner in one line, with its PR number, before it moves.
- 21 Oct 2026, the owner's answers to the scope's three questions:
  1. Work already waiting for an admin goes back to its own person at a fresh quote: **yes**. It starts only on their tap; a claim already rendering finishes.
  2. Production caps still need an admin's Unlock: **yes**.
  3. "Limit is settable by the admin in settings."
     - The lead's reading, to be built unless the owner corrects it: the limit is in Settings for every workspace, not behind V30_SPEND_LIMIT.
     - Any admin may set a first limit or lower one (17 Oct). Only the owner raises or removes it (his "owner-only").
     - A4's manual "pause spending" goes ("no pausing cards").
