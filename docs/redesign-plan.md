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
