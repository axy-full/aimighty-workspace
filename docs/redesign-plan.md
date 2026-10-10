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
