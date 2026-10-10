<!-- Research for the redesign build, 10 Oct 2026: read-only map of release/1's current app. Facts, not decisions: docs/redesign-plan.md decides. -->
# Particl app map for the redesign (release/1, read-only research, 9 Oct 2026)

Repo: /home/agent/aimighty-workspace @ release/1 f59d853f (the worktree /home/agent/wt/rd-p0 is the same tree plus one CI commit).
All paths are relative to the repo root. Nothing was edited. No .env files or private dirs were read.

---

## 0. The facts that shape every lane

- **One shell page.** Every signed-in screen is `app/suites/page.tsx` → `shellBootstrap` → `components/graphite/SuitesApp.tsx:34-41` → `components/graphite/SuitesShell.tsx:67-497`.
  - Screens are chosen by query params through the registry `lib/shell/screens.ts:32-42` (home, board, board-ads, board-social, make, atomik, control-room, settings, phone).
  - Screen components are lazy-loaded in `components/graphite/screens.tsx:24-29`.
- **Old routes are redirects.** Almost every `app/(app)/*` page only redirects (`followOldRoute`; the table is `lib/shell/old-routes.ts:135-214`).
  - Only `/report`, `/privacy`, `/statements/[month]`, `/platform`, `/terms`, `/admin` and `/policy` still render, inside the legacy `(app)` layout (`app/(app)/layout.tsx:64` → `components/shell/Shell.tsx`).
- **Navigation API** is `lib/shell/state.tsx:60-131`: `openMake :86`, `goWorkspace :92`, `goHome :110`, `goBoard :112`, `openAtomik :116`, `setPalette :130`, `openCtx :131`. The provider is at `:227`.
- **Phone is a separate app.** Below the compact line (`lib/shell/use-compact.ts` COMPACT_QUERY: narrower than 768 px, or coarse pointer and at most 500 px tall, so 844x390 counts as a phone) `PhoneApp` (`components/graphite/phone/`) replaces the header, strip, body and tab bar (`SuitesShell.tsx:353-372`).
- **The design source** is `design/particl-graphite/` (README.md, PROMPT.md, `Particl Suites.dc.html` and others). Every screen module in it is marked `landed: true`:
  - `components/graphite/home/routes.ts:9`, `phone/routes.ts:12`, `atomik/panel/routes.ts:10`
  - `lib/shell/make.ts:174`, `lib/shell/ads-social.ts:10,33`, `lib/shell/settings.ts:113`

---

## 1. Current shell and screens

### 1.1 Header / top bar
- **Component:** `components/graphite/Header.tsx`, mounted at `SuitesShell.tsx:373`. It is 56 px; layout notes at `:18-28`.
- **Tabs ("segments"):** Home · Project (name and swatch) · Make · Atomik.
  - Defined in `lib/shell/ia.ts:126-132` (`HEADER_SEGMENT`); rendered at `Header.tsx:101-115`.
  - Lit state `:38-45`; navigation `goTo` `:75-83`; Make's Alt+M hint `:107`; context pill (HOME/BOARD/ADS/SOCIAL/ATOMIK/SETTINGS) `:46-48`.
  - Phone: `components/graphite/TabBar.tsx:5-11` (Home · Record · Make · Atomik).
  - Page strip under the header: `components/graphite/StageStrip.tsx:8-52`, hidden on board, Make and Settings (`:18`).
- **Atomik field:** the header has no input. The Atomik segment opens Atomik's panel (`Header.tsx:82`).
  - The panel textarea is `components/graphite/atomik/panel/AtomikPanel.tsx:229-232` (`data-testid="atomik-input"`), mounted by `AtomikMount` (`screens.tsx:106-116`).
  - Data: `components/atomik/AtomikProvider.tsx` → `/api/atomik` (`:163, :259, :421`); `use-atomik-panel.ts:18-21` → GET `/api/plans`.
- **⌘K:**
  - Button `Header.tsx:116-120`; palette `components/graphite/Palette.tsx:21-103` (placeholder "Search, or tell Atomik what to do", `:73`).
  - Ranking `lib/shell/palette.ts` (row types `:8-21`, at most 12 rows `:25-26`).
  - Items are Studio rail regions plus the project's library assets (`Palette.tsx:43-47`). Atomik cards Approve/Make/Ask at `:95-97`; the Ask handoff is `SuitesShell.tsx:282-288`.
- **Credits pill:** `Header.tsx:124-129` → `shell.goWorkspace("credits")`.
  - The value is `account.credits.balance` (`Header.tsx:32`) from `useAccount`, which reads GET `/api/me` on mount, every 30 s, on visibility change and on a refresh event (`lib/workspace/data.ts:239-260`).
  - Initial value: `lib/shell/bootstrap.server.ts:46-49`. Label: `lib/workspace/format.ts:45`.
  - Amber `data-low` when the balance is below the last price quoted on this screen (`lib/workspace/last-quote.ts:31-33`, `Header.tsx:35-36`). This is not percentage-based.
- **Activity:** there is no "Activity" control in the header. There is a **Jobs pill and tray**: `components/graphite/JobsTray.tsx` (`JobsPill :21-45`, tray `:85-131`, rows `:133-199`; Esc `:98`).
  - Data: `lib/shell/use-jobs-tray.tsx` → GET `/api/jobs?view=tray` (`:152`); release a held job with POST `/api/jobs/:id/release` (`:226`).
  - Early-refresh bus: `lib/shell/jobs-bus.ts:9-25` (window event `particl:jobs`).
  - Server rows: `lib/jobsTray.ts` and `lib/jobsTray.server.ts`.
  - The control room has an Activity page: `components/graphite/control-room/ActivityView.tsx`, data `lib/control-room/use-activity.ts:39` → `/api/control-room/activity`.
- **Avatar menu:** `components/graphite/SettingsMenu.tsx:16-17` (Team · Plan & credits · Spending rules · Connections · Advanced · Sign out).

### 1.2 Home (signed in)
- **Route:** `/suites?view=home` (old `/` → `old-routes.ts:142`; `components/graphite/home/routes.ts:7-18`).
- **Component:** `components/graphite/home/HomeView.tsx:43-71`, made of BriefBox ("What are we making?"), StartFooter, TemplateRow, WaitingStrip and ProjectGrid.
- **Data:**
  - `useProjects` → GET/PUT `/api/workbench/projects` (`lib/workspace/data.ts:60,81,138`); starter project via POST `{action:"starter"}` (`SuitesShell.tsx:319-326`).
  - Approvals: `lib/control-room/use-approvals.ts:57` → `/api/control-room/approvals`.
  - Start price: `home/use-thinking-price.ts:33-42` → GET `/api/workbench/team-canvas?agent=1&board=new`.
  - Start flow: `home/start.ts:20-41`. Covers: `use-project-cards.ts:50` → `/api/workbench/library`.
  - Templates: Film, Ad campaign, Social clips, "Start from a script" (`home/home-model.ts:33-43`).

### 1.3 Make
- **Route:** `/suites?make=video|image|audio|recent|motion|swap|upscale` (`lib/shell/make.ts:14-19`). Old `/generate`, `/images`, `/audio`, `/make/[kind]` and `/studio/shot` land here.
- **Components:** `components/graphite/MakePanel.tsx:10-15` → `make/Make.tsx` (440 px panel; Make|Recent tabs `:49-51`), plus `make/Compose.tsx`, `make/EngineList.tsx` and `make/UpscaleTool.tsx`.
  - Mounted at `SuitesShell.tsx:417-423`. Esc closes it (`:249`); Alt+M toggles it (`:253`).
- **Composer hook:** `make/use-make.ts`.
  - Price comes from GET `/api/workbench/engines` (`:309`).
  - Submit: `lib/workspace/generate-submit.ts` → `/api/generate` or `/api/audio` (`:43-45`); lost-reply recovery via `/api/generate/check` (`:128`).
- **Grid (Recent):** `make/Recent.tsx:35-110`. It is a virtualised single column, not a grid (`:83`).
  - Chips All · Takes · Unfiled · Filed (`lib/shell/make.ts:65-86`). Cards are `components/graphite/TakeTile.tsx`.
- **Viewer:**
  - Clicking a card opens the board Shots region with the take in the Inspector (`Recent.tsx:47`; `board/inspector/BoardInspector.tsx`, `TakeBody.tsx`).
  - Full-screen previewer: `components/PreviewLayer.tsx`, mounted in `app/layout.tsx:69`. It opens with ⤢, double-click, Space or long-press; steps with ←/→; closes with Esc (`:34-37, :220-222`). It offers Recreate / Use as reference / Copy link (`:185-187`) via `lib/shell/preview-bridge.ts` (`SuitesShell.tsx:167-203`).
- **Prompt reuse:** called "Again" / "Recreate" / "Retry".
  - `Recent.tsx:120-137`, priced by `lib/shell/use-recreate-price.ts:15-40` → `lib/shell/recreate-price.ts:37-87`.
  - `useRecreate` (`lib/shell/use-asset-actions.ts:21-32`) calls `shell.openMake(recreatePreset(...))`; recipe loading is in `use-make.ts:137-236`.
  - Also available from the context menu "retry" (`SuitesShell.tsx:137`) and the jobs tray (`JobsTray.tsx:159-166`).
  - There is no "Copy prompt" in /suites; it exists only in the legacy `components/ContextMenu.tsx:18`.

### 1.4 Library
- **There is no Library page.** `/library` → Make › Recent (`old-routes.ts:159`).
  - The board has a Library drawer: `components/graphite/board/drawers/Drawers.tsx:34-67`. ⌘K "open-library" calls `goBoard({drawer:"library"})` (`SuitesShell.tsx:119`).
  - Data: GET `/api/workbench/library` (`lib/workspace/library.ts:89,631`).
- **Uploads vs generated:**
  - `asset.origin: "generation"|"upload"` (`lib/workspace/library.ts:592-593`).
  - `take.kind: "GEN"|"UPLOAD"` (`lib/workspace/takes.ts:89`).
  - Only generated takes get Again (`Recent.tsx:57,68`).
- **Kinds:**
  - Drawer: All · Images · Video · Audio · Cast (`Drawers.tsx:31,47-49`).
  - Tile badge: IMAGE/VIDEO/AUDIO/FILE (`TakeTile.tsx:30`).
- **Search:** there is no in-library search. Asset search exists only in ⌘K (`Palette.tsx:46`).
- **Brand:** brand is not a Library concept. The brand kit lives on the Ads board's Brand rail.
  - `components/graphite/business/BrandTool.tsx:15-22`, used by `board/ads/AdsOverlay.tsx:11`.
  - Extraction: POST `/api/workbench/moleculr/extract-brand` (`board/ads/reads.ts:50-51`).

### 1.5 Settings
- **Route:** `/suites?view=workspace&tab=team|credits|rules|connections|advanced&open=<fold>` (`lib/shell/settings.ts:5-8,17-23`; fold ids `:40-41`).
- **Component:** `components/graphite/settings/SettingsView.tsx:60-64`.
- **Sections:**
  - **Team** (`team/TeamSection.tsx`): `/api/team`, `/api/team/[id]`, `/api/team/invites/[code]` and `/send`, `/api/account/security`, `/api/workspaces/audit`, `/api/workspaces/security`.
  - **Plan & credits** (`credits/CreditsSection.tsx`):
    - Content: Balance with Top up (`:98`), Plan (`:117`), and folds for Packs/requests (`:129`), Credit history (`:143`), Credits per take (`:154`), Usage (`:175`) and Statements (`:190`).
    - APIs: GET `/api/billing` (`:37`), `/api/workspaces/topups` (GET/POST/DELETE `:38,65,81`), `/api/usage?rows=1&month=` (`:41`), `/api/usage` (`:171`), `/api/statements` (`:187`).
  - **Spending rules** (`rules/RulesSection.tsx`, `BudgetSection.tsx`): PATCH `/api/settings`, `/api/projects`, `/api/workbench/ask-admin`.
  - **Connections** (`connections/ConnectionsSection.tsx`): `/api/tokens`.
  - **Advanced** (`advanced/AdvancedSection.tsx`): `/api/settings`, `/api/workspaces/keys`, PATCH `/api/workspaces`, `/api/export`.

### 1.6 Boards (one engine)
- **Route:** `/suites?view=board&kind=studio|ads|social&region=&drawer=&list=&review=&frame=` (`lib/board/routes.ts:9-26`).
  - Old canvas, rig, shots, takes and elements routes map in at `old-routes.ts:171-191`.
- **Kinds:** `components/graphite/board/kinds.ts:9`. Mount: `screens.tsx:65-80`. With no project, `FirstRun` shows instead (`:69-74`).
- **Main component:** `board/BoardView.tsx` (React Flow). Parts:
  - Rail `:534`, BoardCanvas `:537`, EmptyBoard `:549`, ToolPill `:550`, BoardInspector `:559`, Drawers `:47`.
  - Atomik dock: `board/agent/BoardAgentPanel.tsx:94`. Review mode: `board/review/`.
- **Stage rails:**
  - Studio: Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver (`lib/board/regions.ts:18-26`).
  - Ads: Brand · Product · Hooks · Formats · Ads · Adapt · Deliver (`board/ads/index.ts:31-38`).
  - Social: Source · Clips · Hooks · Effects · Posts (`board/social/index.ts:26-32`).
  - Drawers: Library · History · 3D scene (`board/Rail.tsx:13-19`).
- **Elements:** the Cast region, "Cast, environment and elements" (`regions.ts:35-38`), using `cards/cast/CastCard.tsx`. Writes go to `/api/rig/elements/:id` (`components/workspace/rig/RigProvider.tsx:785,806`). There is no Elements panel.
- **Card kinds:** `board/cards/{board,cast,cut,deliver,doc,group,looks,plan,questions,storyboard,take}`.
- **Toolbar:** `board/ToolPill.tsx:14-24`:
  - Select V, Frame F (disabled, with a reason), Note N, Text T, Image I, Video ⇧V, Audio ⇧A, Upload U.
- **Data:** `RigProvider` (951 lines; `SuitesApp.tsx:37`):
  - Projects: `/api/workbench/projects?id=`. Team canvas: `use-team-canvas`.
  - Quotes: `/api/generate/quote`, then POST `/api/generate` (`RigProvider.tsx:45-66`).
  - History: `/api/workbench/team-canvas?productionId=&history=1` (`Drawers.tsx:86`).

### 1.7 Rig
- **There is no Rig screen.** "The Rig is the board itself" (`lib/board/routes.ts:13-14`).
  - `/rig/run/[id]`, `/pipelines` and `/dashboard` → `?suite=atomik&page=runs` (`old-routes.ts:204-205`).
  - Rig delete/undo: `lib/shell/rig-commands.ts` (`SuitesShell.tsx:151-159`).
- **Control room:** Approvals · Activity · Skills · Memory (`components/graphite/control-room/pages.ts:8-13`, `ControlRoom.tsx`).

### 1.8 Context menus
- **Component:** `components/graphite/ContextMenu.tsx:7-33`, mounted at `SuitesShell.tsx:454`.
- **Model:** `lib/shell/context-menu.ts`. Commands `:21-26`; order `ctxItems :62-75`; ⌘C/X/V/D/Z/R and ⌫ `:105-121`.
- **Opening:** `onContextMenu` on the shell root reads `[data-ctx]` (`SuitesShell.tsx:269-276, :363`). Targets: `TakeTile.tsx:155` and `Drawers.tsx:57`. Dispatch: `SuitesShell.tsx:101-150`.
- **Legacy:** `components/ContextMenu.tsx`, only in the `(app)` layout (`app/(app)/layout.tsx:65`).

### 1.9 Keyboard
- **Shell keymap** (`SuitesShell.tsx:232-267`):
  - ⌘/Ctrl+K: palette (`:239`).
  - Esc closes in order: context menu → palette → agent sheet → composer → Atomik panel → Make (`:240-250`).
  - Alt+M: Make (`:251-253`).
- **Board** (`BoardView.tsx:379-402`): 0/⌘0 fit view; Esc clears tool, then drawer, then selection; ⌫ deletes; L toggles list; V, ⇧V, ⇧A, N, T, I, U pick tools.
- **Review** (`board/review/review-model.ts:56-68`; `ReviewMode.tsx:132-151`): J/K/A/R/C, Space, Esc.
- **⌘J does nothing in /suites.** It exists only in the legacy shell (`components/shell/Shell.tsx:77-86`, toggles the Atomik rail) and on Guest Home (`components/graphite/guest/GuestHome.tsx:66-70`, where ⌘K/⌘J/⌘/ open the sign-up sheet). The design maps ⌘J to the Inspector (design README:202).
- **"/":** no handler anywhere.
- **Other Esc handlers:** `Header.tsx:52-56`, `JobsTray.tsx:98`, `PreviewLayer.tsx:220`, `BoardInspector.tsx:51`, `SuitesShell.tsx:457`.

### 1.10 Tooltips
- **There is no Tooltip component.** There are about 147 native `title=` attributes in `components/graphite`.
  - Examples: `Header.tsx:107,126`, `ToolPill.tsx:35`, `Price.tsx:25` (price hover shows dollars via `usePriceTitle :40`; `lib/shell/price-words.ts:8-13,81`).
  - `components/ui/` has Button, Chip, Menu, Sheet, Toast, but no Tooltip.

### 1.11 Render-state UI
- **TakeTile** (`components/graphite/TakeTile.tsx`):
  - Faces: media / live spinner / held / failed "!" / stopped "–" / unavailable (`:43-48`).
  - Chip from `takeChip` (`lib/workspace/takes.ts:212-226`): Queued / Rendering / Held · needs N cr / Failed / Cancelled / Picked / Approved / Changes.
  - Reason, charge and Release lines `:99-124`; skeletons `:182-195`.
- **Make Recent in-flight:** ring plus chip (`Recent.tsx:86-97`).
- **Board TakeCard** (`board/cards/take/TakeCard.tsx:71-100`):
  - "Queued" badge; progress bar with "about N min left", capped at 95%.
  - The typical time is the median of at least 3 earlier same-key takes in the library (`take-model.ts:159-202`, `typicalRenderMs :172`, `renderEstimate :190+`).
  - Failed: "Nothing billed" plus Retry.
  - Phone: `phone/StatesScreen.tsx:97-111`.
- **Jobs tray row:** stage, elapsed (`lib/jobsTray.ts:454`), price, a % ring when progress is known, otherwise an indeterminate bar (`JobsTray.tsx:181-189`). Progress is always null today (`lib/jobsTray.ts:12-14`).
- **Notify me when done:** `board/NotifyWhenDone.tsx:23`, `phone/NotifyButton.tsx`.

### 1.12 Guest / visitor
- **Routing:** `proxy.ts:16-35` rewrites `/`, `/atomik`, `/settings` and `/pricing` to `/site/*` for a visitor with no session cookie and no app params. `/studio`, `/ads` and `/social` always go to the site.
- **Site router:** `app/(marketing)/site/[[...slug]]/page.tsx`:
  - Pages: Gen, Studio, Ads, Social, Atomik, Settings, Pricing (`:25-33`).
  - At `/` it renders GuestHome when `readSite().guestHome` is on (`:50-61`). That is a global admin switch (`lib/site/settings.ts:3-10`).
- **Guest components:** `components/graphite/guest/` (GuestHome `:16-28`, GuestHeader, GuestBox, GuestSample, SignupSheet → GET `/api/auth/signup?code=` `:35`, RequestAccess → `/api/access-request`).
  - `lib/guest/*`: after sign-up the guest's brief becomes the first board (`lib/guest/first-board.ts:12-20`, from `app/(auth)/signup/page.tsx:9`).
- **Signed out at /suites:** redirected to sign-in (`lib/shell/bootstrap.server.ts:43`). Signed in with no workspace: `NoWorkspace` (`app/suites/page.tsx:46`).
- **Client review (no login):** `app/review/[token]/page.tsx` → `components/graphite/security/ClientReview`.

### 1.13 Invite / join
- **Workspace invite page:** `app/(auth)/invite/[code]/page.tsx`:
  - GET/POST `/api/auth/accept` (`:32,42,60`), then `router.push("/")` (`:49`).
  - Server: `app/api/auth/accept/route.ts:163-173` → `acceptWorkspaceInvitation` (`lib/teamInvitations.ts:302`) and `lib/accountInvitationSession.ts:19`.
  - Mailed link: `/invite/<code>?m=<proof>` (`teamInvitations.ts:257-258`).
- **Creating invites** in Settings › Team: POST `/api/team`; `/api/team/invites/[code]` (DELETE) and `/send`.
- **Sign-up:** `app/(auth)/signup/page.tsx` (`?invite=`, invite-only "Request access", or open):
  - POST `/api/auth/signup` (`:133,164`), `/verify` (`:101`), `/signup/resend` (`:197`), then to `data.next` or `/suites` (`:182`).
- **Other auth pages:**
  - `/welcome`, `/login` (WelcomeSignIn).
  - `/setup`: the first account becomes the platform owner and owns the house workspace (`lib/auth.ts:447-468`).
  - `/billing` and `/pricing`: legacy `components/commercial/{BillingClient,PricingClient}.tsx` → `/api/plans`.

---

## 2. A per-workspace UI switch without a schema change

### 2.1 What the client knows about the workspace today
- **Shell bootstrap** (`lib/shell/bootstrap.server.ts:53-72`) puts these on `session`:
  - `workspace: {id, name, slug, suspended, suspendedReason, internalTest, ownerName}` (`:59-63`)
  - `role`, `owner`, `superAdmin`, `workspaces[]`, `credits` (`{creditUsd, granted, used, balance}` or null), `models`, `setup`, `rates`
- **Type:** `SessionWorkspace` in `lib/session.tsx:26-30`; `Session` at `:36-59`.
- **Legacy (app) layout** builds the same shape without `ownerName` (`app/(app)/layout.tsx:41-61`).
- **`/api/me`** returns a similar workspace object plus `platformKeys` (`app/api/me/route.ts:27`). The shell's `useAccount` polls it for credits only.
- **`legacy` is not sent to the client.** It exists only server-side on `TenantWorkspace.legacy` (`lib/tenant.ts:22`).
  - The house workspace is id `ws_legacy`, slug `aimighty`, `legacy=1` (`lib/auth.ts:454-457`, `lib/platform.ts:451-456`).
  - The canonical test is `isHouseWorkspace(ws)` (`lib/houseWorkspace.ts:26-30`, compares the id to `HOUSE_WORKSPACE_ID="ws_legacy"`). It is already used by billing (`lib/credits.ts:17-19`) and by `currentContext` (`lib/auth.ts:137`).
  - The slug is visible to the client, but keying on "aimighty" in source would break CLAUDE.md rule 3 (no workspace names in code). Key on `isHouseWorkspace`, which is the platform's own constant.
- **`internalTest`** (`workspaces.internal_test`, `lib/platform.ts:324,399`) is already on the session. Only the platform admin sets it (`app/api/admin/workspaces/[id]/route.ts:69-71`). It already means "real engine calls allowed / previews publish", so do not overload it in production.

### 2.2 Precedent: a switch existed and was deleted (6 Oct)
- **Commits:** `7f2c99c9` added it; `44e2a770` added the admin chips and test helper; `d43fe250` removed it ("Release 1: the new-interface switch is gone").
- **Shape** (see `git show d43fe250^:lib/shell/new-interface{,.server,-model}.ts`):
  - Data: one JSON row in the existing platform table `platform_layer`, key `interface`, value `{everyone:boolean, workspaces:string[]}`. No migration.
  - Server: `newInterfaceEnabled(wsId)` read in `shellBootstrap` and put on `session.workspace.newInterface`.
  - Client: `useNewInterface()` = `useSession().workspace?.newInterface === true`.
  - Routing: `route(asked, on)` in `app/suites/page.tsx` and `SuitesApp.tsx`.
- **Caution:** the commit says "the platform_layer 'interface' row is no longer read; no migration, the row stays". Production may still hold an old `interface` row listing customer or demo workspace ids, or even `everyone:true`. **Do not read the old key again.** Use a new key, or no row at all.

### 2.3 Proposal: where to compute `newInterface`
**Placement:**
- Compute it once, server-side, in `shellBootstrap` at `lib/shell/bootstrap.server.ts:59-63`, inside `session.workspace`:
  ```ts
  newInterface: newInterfaceFor(ctx.workspace),   // new lib/shell/new-interface.server.ts
  ```
- `newInterfaceFor(ws)` returns `isHouseWorkspace(ws) || testOverride(ws)`. A failed read means off.
- Add `newInterface?: boolean` to `SessionWorkspace` (`lib/session.tsx:26-30`). Absent means off.
- Restore `useNewInterface()` from `d43fe250^` (it reads the session; no request, no flicker).
- **Do not add it** to `app/(app)/layout.tsx:46` or `/api/me`. The legacy layout only serves the seven policy/admin pages, and a visitor has no workspace, so it is off for them.
- `app/suites/page.tsx:50` (`route(asked)`) is the place where a switch-dependent server redirect would go, if new screens need their own addresses.

**Tests (the snag):** browser tests never land in the house workspace.
- `signInLocally` (`tests/helpers/workbenchLocal.ts:25-69`) inserts a `signup_invites` row into the local platform DB and POSTs `/api/auth/signup`.
- That creates a fresh non-legacy workspace with slug `browser-<code>-xxxxxxxx` and plan `invite` (`lib/workspaceProvisioning.ts:151-157, 283-285, 321`). `isHouseWorkspace` alone would therefore be off in every spec.
- **Recommended test override (no schema change, no new env var):**
  - Honour a new `platform_layer` key (for example `interface_preview`, value `{workspaces:[ids]}`) **only when `ENGINE_MOCK=1` and `NODE_ENV !== "production"`** (`lib/mock.ts:19,31`; the same guard as `PARTICL_TEST_MOCK_DELAYS`).
  - Change `tests/helpers/newInterface.ts` `signInWithNewInterface` (today an alias of `signInLocally`, `:8-10`) to also insert that row for the new workspace id through `localPlatformDbUrl()`. This is the same SQL-in-helper pattern `signInLocally` already uses.
  - Production ignores the row entirely, so it can only ever be on for the house.
- **Alternatives:**
  - (a) In mock mode only, treat `internalTest` as on (tests set it with `UPDATE workspaces SET internal_test=1`). Simpler, but it reuses a flag that means something else.
  - (b) An env var. `docs/selfhost-test.md:317` says the code reads no other test/mock flag, so that doc would have to change.
- **Staging:** it runs `ENGINE_MOCK=1` (`docs/selfhost-test.md:92`), so the override would also work on staging. Decide whether that is wanted.

### 2.4 Gap for the owner: the house workspace pays in dollars
- For the house, `creditsApply()` is false (`lib/credits.ts:17-19`). As a result:
  - `session.credits` is null (`creditStateFor` returns null, `:21-25`).
  - The rate table is in **USD** (`bootstrap.server.ts:71`), and quotes come back as `unit:"usd"` (`lib/admissionTypes.ts:15`).
  - The header pill shows dollars, and the low-balance check is disabled when `rates.unit === "usd"` (`Header.tsx:36`).
- So in the only workspace where the new UI would be on, the prototype's `N cr` prices, credits pill and "less than 20% left" warning have nothing to show, or would show engine dollars.
- **Owner decision needed:** either show the house dollar figures in the new UI, or let the house see credits for display. The latter has margin implications; see the `lib/credits.ts:32-46` comment.
- Browser tests run in a credit workspace, so screenshots there will show `cr` correctly.

---

## 3. Prices: the server price path, and endpoints per engine

### 3.1 Core
- **`lib/creditTerms.ts`:**
  - `creditUsd()` defaults to $0.10, override `CREDIT_USD` (`:35-38`).
  - `margins()` (`:49-63`, launch "*" 1.5, override `CREDIT_MARGINS`).
  - `marginKeyOf` (`:66-71`).
  - `billCreditsWith`/`billCredits` = ceil(usd × margin / perCredit), at least 1 (`:79-86`).
- **`lib/quote.ts`:**
  - `quoteOf(units)` → `{totalCredits, unitCredits, units, usd, lines}`; batches multiply before rounding (`:130-164`).
  - `publicQuote` strips usd (`:107-113`).
  - `verdictOf` gates: approval, then allowance, then cap, then held (`:219-296`).
  - TTL 120 s (`:308-328`).
- **`lib/credits.ts`:** `quotedCredits` (`:47-49`); `creditCheck` returns 402 when short (`:66-82`).
- **Vendor rates:** `lib/vendorRates.ts:64-212`:
  - Seedance 2.5 `dreamina-seedance-2-5-260628` `:84`
  - Kling Standard `fal-ai/kling-video/v3/standard` `:110`
  - Kling Pro `fal-ai/kling-video/v3/pro` `:121`
  - Topaz video `topaz/upscale/video/creative` `:132`
  - Topaz image `fal-ai/topaz/upscale/image` `:153`
  - Nano Banana Pro `gemini-3-pro-image` `:168`
  - Nano Banana 2 `gemini-3.1-flash-image` `:177`
  - ElevenLabs `:247-268`
- **Browser rate table** (already in credits, no margin): `buildRateTable` (`lib/rateTable.server.ts:20-67`), sent on the session/bootstrap and `/api/me`.
  - Client estimators: `lib/rateTable.ts:101-173`, `lib/composerQuote.ts:6-29`.
- **Price words:** `lib/shell/price-words.ts:20-157` (`priceWords`/`priceView`, `{kind:"up-to"}`, hover dollars, `shortByWords`); `lib/spend.ts:15-35` (`{upTo}` → "up to N cr").
  - Component: `components/graphite/Price.tsx`. Make figures: `lib/shell/make-price.ts:34-77`.

### 3.2 Quote endpoints (request → response)
| Endpoint | Request | Response | Lib |
|---|---|---|---|
| **POST `/api/generate/quote`** (`app/api/generate/quote/route.ts:10-31`) | Same body as `/api/generate` (`lib/workbench/generation-request.ts:15-80`): `{prompt, model, projectId, shotId?, ratio, resolution, duration, references[], firstFrameAssetId?, batchId?, variation?, draft?, task?, sourceGenId?, sourceUploadId?, topaz?, …}`. Browser needs header `X-Workbench-Scope` (`lib/workbench/request-scope.ts:12-22`) | `AdmissionQuote {fingerprint, estimatedCredits, price, unit:"cr"\|"usd", approximate?, ceilingCredits?}` (`lib/admissionTypes.ts:12-24`) | `prepareGeneration` (`lib/generationAdmission.ts:2412`) |
| **GET `/api/workbench/engines`** (`app/api/workbench/engines/route.ts:8-60`) | List: `aspect, pickRatio, pickResolution, pickDuration, pickDraft, pickSound, uploadId*, genId*, seconds…`; single: `model, resolution, ratio, duration, audio=1` | List: `{models:[{id,label,kind,rate:{credits,resolution,ratio,duration,approximate?,sound?}}], audio:{sound,music}}`; single: `{models, credits, inputSeconds, hasVideoInput, approximate?}` | `lib/workbench/media-quote.ts:109-204`. Marketing/identity models get 409 "needs a live quote" (`:43`) |
| POST `/api/audio` `{quoteOnly:true, task:"speech"\|"sound"\|"music"\|"dialogue"\|"voiceChange", …}` | `lib/audioAdmission.ts:65,166-329` | `{estimatedCredits, price, unit, sourceSeconds?, minutes?}` (`:343-349`) | `executeAudioAdmission` |
| POST `/api/audio/dub` `{quoteOnly}` | `{sourceUploadId\|sourceGenId, sourceLang, targetLang, mode, projectId}` | `{estimatedCredits, price, unit, sourceSeconds, minutes, mode}` (`lib/dubbing.ts:123-179`) | |
| POST `/api/audio/transcribe` `{quoteOnly}` | route `:13-32` | `{estimatedCredits,…}` | |
| POST `/api/rig/quote` | `{port:"elementId:attributeId:versionId", projectId?}` | `{impact:{choices[{quote: PublicQuote, verdict}]}}` (`lib/impact.ts:42-63`) | `impactOf` |
| POST `/api/atomik` `{quoteOnly:true}` | `{text, model:"auto", effort, projectId, attachments}` (`app/api/atomik/route.ts:83-98`) | `PaidTextQuote {model, effort, estimateCredits}` (`lib/paidText.ts:105`; usd stripped, `lib/workbench/atomik-response.ts:3-13`) | `runTurn` |
| POST `/api/atomik/{shots,ideas}/draft`, `/api/atomik/treatment/scene`, `/api/atomik/memory/read`, `/api/prompt/enhance` `{quoteOnly}` | route-specific | `PaidTextQuote` | `quotePaidText` |
| **GET `/api/workbench/team-canvas?agent=1[&board=new]`** (route `:59-74`) | `productionId`, `projectId`, `attachment*` | `{agent:{enabled, run, ask:{limit, jobCeiling, planning}}}` (`lib/workbench/rig-agent.ts:240-294`) | `rigAgentState` / `newBoardAskTerms` |
| GET `/api/workbench/budget` | `productionId, runId?` | `{…, plan:{atMost, line}}` (route `:20-43`) | `planGateQuote` |
| GET `/api/plans`, `/api/billing` | — | rate card `rates: RateGroup[]`, `reach`, plans, packs | `rateCard`, `plansWithReach` |

- **Client hooks:**
  - `useBodyQuote` (`lib/shell/use-quote.ts:23-54`; POST `/api/generate/quote`, 400 ms debounce, `approximate` → `upTo`).
  - `quoteDispatch` (`lib/workspace/generate-submit.ts:162-185`).
  - `useStageQuotes` (`lib/production/use-stage-quotes.ts:10-64`).
  - `useRecreatePrice`.
  - `useAtomikQuote` (`lib/useAtomikQuote.ts:8-41`).
- **Live provider estimates** (Higgsfield API key): genjutsu (`lib/genjutsu.ts:47-66`), soul (`lib/soulRender.ts:123-133`), marketing (`lib/higgsfieldMarketing.ts:441`). These are surfaced only through `/api/generate/quote`, tagged `approximate`. There is no fal pricing call.

### 3.3 Per prototype price
| Prototype price | Existing source | Notes |
|---|---|---|
| Seedance 2.5 | GET `/api/workbench/engines?model=dreamina-seedance-2-5-260628&resolution=1080p&ratio=16:9&duration=5` (button) / POST `/api/generate/quote` (exact) | 480p draft: `pickDraft=1` / `draft:true` (`media-quote.ts:174-176`); Make default `make-price.ts:34-40` |
| Kling 3.0 Standard / Pro | Same two endpoints, `fal-ai/kling-video/v3/standard` and `/pro` | audio via `audio=1` |
| Nano Banana 2 / Pro | Same, `gemini-3.1-flash-image` / `gemini-3-pro-image` | `estimateImageCostUsd` (`media-quote.ts:118`) |
| Upscale (Topaz) | POST `/api/generate/quote` with `videoUpscaleBody` / `imageUpscaleBody` (`lib/shell/upscale.ts:37-66`) | already used by `make/UpscaleTool.tsx:52` |
| Lip-sync (Sync / others) | **No quote path, no engine.** Only on the retired Higgsfield sign-in path (`lib/higgsfield-consumer/tools.ts:30,54`; 410 `retired.ts:16-35`) | Nearest is ElevenLabs Dub (POST `/api/audio/dub {quoteOnly}`). Standalone lip-sync needs an engine first; the UI cannot show "quoted" (rule 14), so hide it or show it as unavailable |
| ElevenLabs audio | POST `/api/audio {quoteOnly:true, task}`; sound/music rates before typing from GET `/api/workbench/engines` → `audio` | speech is per character and "waits for the button" (`media-quote.ts:193-195`); Make shows "up to N cr" (`make-price.ts:54-56`) |
| Make turnaround | **No code** (only a crew string, `lib/workbench/crew.ts:4`) | could be priced as N still bodies via `/api/generate/quote` (the cast 3:4 sheet is `lib/production/cast.ts:46-47`); needs a definition |
| Board start | GET `/api/workbench/team-canvas?agent=1&board=new` → `agent.ask.planning` ("Start · up to N cr") | `rig-agent.ts:285-294`; `home/use-thinking-price.ts:33-42` |
| Atomik thinking per ask | Planning turn: same `ask.planning` (reserved at the ceiling, settled at use, `rig-agent.ts:65-69, 276-282`). Chat: POST `/api/atomik {quoteOnly}` → `estimateCredits` | design shows "up to 9 cr" (Gaps A README:3-14) |
| Moodboard | **None.** Moodboard is a legacy node type that only collects refs (`lib/workbench/node-graph.ts:7`) | the board itself is free; stills from it go through `/api/generate/quote` |
| Variations | Per take × count (`lib/variations.ts:6`: video 1-4, images 1/2/4/8); `batchTotal`/`shownTotal` (`lib/workspace/composer.ts:500-513`); bodies carry `batchId`/`variation` | through `/api/generate/quote` |
| Start from a tile | **No code.** Recreate-from-take is `quoteRecreate` (`lib/shell/recreate-price.ts:37-87`) | if "start from" means Recreate, use that; otherwise it needs a definition |
| Redraw / Fix / Change | Change on a clip: Seedance Edit body (`board/inspector/inspector-model.ts:39-56`) → `/api/generate/quote`. Change on a still opens Make (`TakeBody.tsx:85`). Redraw: only storyboard line drawings (`lib/production/boards.ts:113-125`), a still body. Plan fixes: `agent.fix`, drawn from the plan allowance (at most 2 per shot), priced when its turn comes (`lib/workbench/plan-approval.ts:28-33`; `rig-agent.ts:660-667`); `POST /api/rig/runs/[id]/fix` carries no price | no inpaint tool (`lib/stillTools.ts:10-15`: outpaint, cutout, upscale) |

**Rule 14 conflict:** the brief says "UI must show 'quoted'", but CLAUDE.md rule 14 says never use the bare word "quoted". Use "up to N cr" where an estimate exists; where none exists the owner must choose the wording (for example "price at the button") or the action must wait for an engine.

---

## 4. Plans and credits
- **Plans:** `lib/plans.ts`:
  - `PlanId = invite|studio|agency|production` (`:23`).
  - `DEFAULT_PLANS` (`:40-46`): Invite $0, 0 included (its 250 is a one-time welcome grant); Studio $49 / 400 cr; Agency $199 / 1,600; Production $999 / 9,000.
  - **There are no Starter or Team plans.** Those names are packs (`lib/packs.ts`; CLAUDE.md § Packs).
  - The admin console can override plans (`lib/platformLayer.ts:156-159,236-240`; `app/(app)/admin/page.tsx:492-504`).
  - Ceilings: `lib/planLimits.ts:22-56`.
- **Columns** (all exist; no schema change needed):
  - `workspaces.plan_id` is the admin label (`lib/platform.ts:85,399`; `setWorkspacePlan :861-867`); provisioning writes `invite`.
  - Billing tables (`lib/billingLedger.ts:15-35`): `billing_subscriptions(plan_id,status,interval,current_period_*)`, `billing_paid_periods(plan_id, included_credits,…)`, `billing_cycles(starts_at, ends_at, credits, grant_id)`, `billing_lots(kind, credits, drawn, expires_at,…)`, `billing_debits`, `billing_allocations`.
- **Effective plan:** `planOf(ws)` = paid entitlement, else the admin label (`lib/platform.ts:839-849`; `effectivePlanId` `lib/billingLedger.ts:798-807`). It is server-side only; **no API returns it**. `/api/billing` returns `subscription.planId` (the paid subscription only).
- **Balance:**
  - `billingStateFor(wsId)` (`lib/billingLedger.ts:417-483`) returns `credits{creditUsd, granted, used, balance, includedBalance, purchasedBalance, bonusBalance, otherBalance, expiredCredits, nextExpiryAt}`, plus `subscription`, `lots` and `cycles[{id,startsAt,endsAt,credits,invoiceId}]`.
  - `creditStateFor` trims this to `{creditUsd, granted, used, balance}` (`lib/credits.ts:21-25`), which is what the session and `/api/me` get.
  - GET `/api/billing` returns the full state (`app/api/billing/route.ts:40-53`).
  - Spending order: included, then welcome/manual, then bonus, then purchase (`lib/billingLedger.ts:372`). The cycle grant is materialised at `:205-246`.
- **"Less than 20% of plan credits remain":**
  - Denominator: the current cycle's `credits` (`cycles.find(c => c.startsAt <= now && now < c.endsAt)`), falling back to `planById(plans, subscription.planId).includedCredits`.
  - Numerator: `credits.includedBalance`, or `credits.balance` if packs should count. That choice is the owner's.
  - Low when `numerator < 0.2 × denominator`.
  - Edge cases:
    - Invite has 0 included: use the welcome grant (`signupCredits()`, 250) or skip the warning.
    - No subscription: no warning.
    - An admin-labelled plan grants nothing (`docs/subscribed-workspaces.md:17`).
    - The house has no credits: no warning.
  - To show it in the header without an extra fetch, add `includedBalance` and the cycle credits to `creditStateFor` / `SessionCredits` (`lib/session.tsx:35`). That is a type change, not a schema change. Otherwise read `/api/billing`, as Settings already does.
- **Placeholder plan prices (display only):**
  - Safest: `lib/marketing/plans.ts:9-28` (copy-only `PLAN_AUDIENCE`/`planLines`, read by the site pricing page `app/(marketing)/site/_pages/pricing/index.tsx:8-22` → `PlanCards.tsx:46-55`). Nothing in billing reads it.
  - Avoid `DEFAULT_PLANS[].priceUsd`. It is "the one figure a plan is sold on" (`lib/plans.ts:28`), and `subscriptionPriceCents` would charge from it (`lib/billingConfig.ts:6-15`); changing it changes CLAUDE.md § Tiers and needs the owner.
  - Payments are not wired today: provider "manual", and `startCheckout` throws (`lib/payments.ts:14-30`).

---

## 5. Render jobs
- **States:** `generations.status` (free TEXT, `lib/db.ts:107-124`) is one of:
  - `held`: before spend; `params.held.why` is `credits` or `slots` (`lib/held.ts:24-43`).
  - `queued`: video insert (`lib/generationAdmission.ts:2243`); fal `IN_QUEUE` (`lib/engines/fal.ts:98`); Ark mapping `lib/ark.ts:456-464`.
  - `running`: stills are inserted running (`generationAdmission.ts:1616`); video once accepted (`lib/submitVideo.ts:107-120`).
  - Terminal: `succeeded | failed | cancelled` (`lib/jobs.ts:394`).
  - **There is no `storing` status.** Storing happens inside `running` and is measured in `store_ms`.
- **Other state sets:**
  - Jobs tray display stages: `submitting|queued|rendering|confirming|held|unconfirmed|complete|failed|cancelled|aside` (`lib/jobsTray.ts:31`). A `held` row with `why="slots"` shows as "Queued".
  - Meter states: `running|succeeded|failed`. A cancel is metered as failed (`lib/meter.ts:39`; `lib/generationSettlement.ts:51`).
- **Queue position:** nothing shows one today (only a "Queued" label: `TakeCard.tsx:74`). Possible sources:
  - fal `queue_position` is typed (`lib/fal.ts:44-46`) but dropped in `lib/engines/fal.ts:95-104` (`raw: st` is not stored). It is the only real provider position.
  - Our provider pool: `provider_pool(id, workspace_id, pool, queued_at, admitted_at, left_at)` (`lib/providerPool.ts:158-171`); `servingOrder()` computes places (`:115-128`); `poolVerdict` gives `ahead` (`:97-101`); `waitingIn()` `:281`. Only the `higgsfield` pool exists (`:39,50`).
  - Workspace slot wait: rank by `created_at` among `held` rows with `why="slots"` (`lib/held.ts:24-34`; `lib/limits.ts:31-75`). This is computable; no column needed.
  - Ark, Higgsfield and xAI give no position. xAI gives `progress` 0-99.
- **Typical times:**
  - `generations` columns (tenant DB): `created_at`, `settled_at` (`lib/db.ts:1103`; triggers `:1205-1215`), `duration_ms` (`:1046`; `lib/jobs.ts:562-564`), and the stage split `queue_ms, refine_ms, submit_ms, engine_ms, notice_ms, store_ms` (`:1071-1072`, explained `:1055-1064`).
  - Group by `model`, `provider`, `kind`, `task`, `params` (duration/resolution). There is no `started_at`; use `created_at + queue_ms`.
  - Ark's `engine_ms` includes Ark's own queue time. fal and Higgsfield have no vendor timestamps.
  - Platform-wide: `meter_events(engine, model, kind, status, duration_ms, created_at, updated_at)` (`lib/platform.ts:153-169`).
  - Existing aggregates:
    - `engineHealth()` avg/max per engine and model (`lib/meter.ts:369-388`).
    - Per-stage medians by kind (`lib/creditUsage.ts:90,135`; `app/api/usage/route.ts:96-108,349`).
    - Client median per key from the library (`take-model.ts:172`).
- **Cancel endpoints:**
  - Higgsfield video (API key) only: POST `/api/generations/[id]/cancel` (`app/api/generations/[id]/cancel/route.ts:13-31`; creator or admin).
    - It calls `cancelGenjutsuVideo` (`lib/genjutsuVideo.ts:166-192`), which cancels **only while the provider says queued**: `POST /requests/{ref}/cancel`, expects 202 (`lib/engines/higgsfield.ts:260-270`).
    - The route returns `requested`; the collector settles it later. Used in the UI only by Motion transfer and Object swap (`ViralView.tsx:246,454,545`; `lib/shell/use-key-take.ts:32`).
  - The adapter interface has `cancel?` (`lib/engines/types.ts:82`) and `cancelUrl` (`:39`); only Higgsfield implements them. fal's `cancel_url` is typed but unused (`lib/fal.ts:39`). Ark has no DELETE.
  - Held jobs: `PATCH /api/jobs/[id] {discard:true}` or DELETE → `discardHeldJob` (`lib/held.ts:101-121`) sets cancelled at cost 0. Trash/DELETE of queued or running jobs is refused (`app/api/jobs/[id]/route.ts:18,100,237`).
  - Group/plan stop: `GroupCard.tsx:55`; `MoneyStates.tsx:217` ("Stop · keep what's made").
  - There is **no cancel on the board TakeCard or in the Jobs tray.**
- **Credits on cancel:**
  - `meter()` debits the estimate at start (`lib/meter.ts:~197-203`).
  - Settlement replaces the debit; failed or cancelled at cost 0 releases it (`:176-231`).
  - Held-ceiling jobs settle at the reported cost, capped at the quote (`:82-95`).
  - Every provider has `billsFailures: false` (`lib/providers.ts:49-240`).
  - Expired or orphaned jobs fail at 0 with `outcomeUncertain` (`lib/jobs.ts:878-900`); the vendor may still bill.

---

## 6. What providers charge when a job is cancelled (public docs)
| Provider (our path) | Cancel API | What can be cancelled | Billing on cancel |
|---|---|---|---|
| BytePlus ModelArk Seedance (`lib/ark.ts`) | `DELETE /api/v3/contents/generations/tasks/{id}` | queued only; running is refused | Not charged (only successful videos are billed). Our code: no DELETE yet |
| fal (Kling; Topaz via fal) | `PUT queue.fal.run/{model}/requests/{id}/cancel` | IN_QUEUE: never runs. IN_PROGRESS: signal only, "may still complete" | Queued: free (billed on successful output). In progress: docs silent, may bill |
| Higgsfield API | `POST /requests/{id}/cancel` (202; 400 once started) | queued only | Docs silent on cancel; failed/NSFW/timeout are refunded. Our code labels cancel `not_charged` (`lib/providerOutcome.ts:37,200`) |
| xAI Grok Imagine | none | — | docs silent; we cannot stop it |
| ElevenLabs | Dubbing `DELETE /v1/dubbing/{id}`; no cancel for TTS/SFX/music | delete does not stop a running dub | API dub: no refund once running. TTS aborted stream: docs silent |
| Topaz direct API (not our path) | video `DELETE /video/{id}` (+ `GET …/cancel-estimate`); image `DELETE /cancel/{process_id}` | anything not finished | Video: full refund before processing, prorated plus a penalty mid-way. We use Topaz through fal, so fal's rules apply |
| Sync labs (sync.so) | none (DELETE only on terminal jobs; 409 while processing) | — | docs silent; billed on output frames. Not in our product (only on the retired Higgsfield sign-in path) |
| OpenAI images | none for Images API (only `/v1/responses/{id}/cancel` for background responses) | — | docs silent; a forum post says usage is still recorded |
| Google Gemini / Nano Banana / Imagen / Veo | images are synchronous; Veo LRO has no documented cancel | — | Veo billed on success only; cancel: docs silent |

- **URLs:**
  - ModelArk:
    - https://docs.byteplus.com/en/docs/ModelArk/cancel-or-delete-video-generation-tasks-api
    - https://docs.byteplus.com/en/docs/ModelArk/get-video-generation-task-api
    - https://docs.byteplus.com/en/docs/ModelArk/model-pricing
  - fal:
    - https://fal.ai/docs/model-apis/model-endpoints/queue
    - https://fal.ai/docs/model-apis/pricing
  - Higgsfield:
    - https://docs.higgsfield.ai/docs/concepts/requests
    - https://docs.higgsfield.ai/docs/help/faq.md
  - xAI:
    - https://docs.x.ai/openapi.json
    - https://docs.x.ai/developers/model-capabilities/video/generation.md
  - ElevenLabs:
    - https://elevenlabs.io/docs/overview/capabilities/dubbing
    - https://elevenlabs.io/docs/api-reference/dubbing/delete
    - https://elevenlabs.io/docs/help-center/product/dubbing/how-much-does-dubbing-cost
  - Topaz:
    - https://developer.topazlabs.com/reference/video/cancel-request/cancel-video-request.md
    - https://developer.topazlabs.com/reference/video/cancel-estimate/estimate-cancellation-outcome.md
    - https://developer.topazlabs.com/reference/image/cancel/cancel.md
  - Sync:
    - https://sync.so/docs/openapi.json
    - https://sync.so/docs/product/billing.md
  - OpenAI:
    - https://developers.openai.com/api/reference/resources/responses/methods/cancel
    - https://developers.openai.com/api/docs/guides/image-generation
    - https://community.openai.com/t/cancelling-stream-does-not-show-usage/1377768
  - Google:
    - https://ai.google.dev/gemini-api/docs/veo
    - https://ai.google.dev/api/all-methods
    - https://ai.google.dev/gemini-api/docs/pricing
- **Conclusion for the UI:** a free Cancel is safe only while the job is **queued**, on Ark, fal and Higgsfield, or while it is **held** (ours, always free).
  - Once a job is running, or on xAI, OpenAI, Google, ElevenLabs TTS or Sync, Cancel at best drops the result, and the vendor probably still bills.
  - The UI should say so ("Stop · may still be charged") or not offer Cancel. The owner must decide whether a cancelled running job is billed to the customer.
- **Unverified notes:** the helper saw OpenAI's Sora Videos API shut down on 24 Sep 2026, and `gemini-2.5-flash-image` listed with a shutdown on 2 Oct 2026. Not checked against our gateway ids.

---

## 7. Test infrastructure
- **`playwright.workbench.config.ts`** has **no webServer**; start the server yourself.
  - base `PW_BASE_URL || http://localhost:4551` (`:19`).
  - Projects: `workbench-api` (`*workbench-api.spec.ts`), plus `workbench-{360x640,390x844,844x390,1440x900,1920x1080}` for `(workbench|movie-export).spec.ts` (`:3-9,:28-39`). Widths under 900 get isMobile and hasTouch.
  - 1 worker, 0 retries, output `../workbench-test-results`.
- **`playwright.customer.config.ts`:** also no webServer; 12 named specs (`:11-12`); `customer-WxH` at the same five sizes.
- **`playwright.config.ts`:** starts `npm run dev -- -p 4551` itself (`:56-61`) **without ENGINE_MOCK**, so signed-in specs skip.
- **`playwright.five-minute.config.ts`:** globalSetup `tests/five-minute.warmup.ts` (refuses a non-mock server); runs at 1440x900 and 390x844.
- **Mocks:** the only switch is `ENGINE_MOCK=1` (`lib/mock.ts:19`, reported by `/api/health` → `mock`, `app/api/health/route.ts:127,147`), plus `PARTICL_TEST_MOCK_DELAYS=1` (`lib/mock.ts:31`).
- **Databases:** libSQL files only:
  - Platform: `PLATFORM_DATABASE_URL ?? TURSO_DATABASE_URL ?? file:.data/ark.db` (`lib/platform.ts:36`).
  - Each workspace gets its own file DB (`lib/provision.ts:34`).
- **CI** (`.github/workflows/verify.yml`):
  - Env: `ENGINE_MOCK=1`, `PARTICL_TEST_MOCK_DELAYS=1`, `PLATFORM_DATABASE_URL = PW_PLATFORM_DATABASE_URL = file:.data/browser-platform.db`, `TURSO_DATABASE_URL = file:.data/browser-legacy.db`, `SUPER_ADMIN_EMAIL=platform-owner@example.test` (`:123-140`).
  - Steps: `setsid npm run dev -- -p 4551` (`:182`), warm-up `node scripts/warm-dev-routes.mjs` (`:227`), then `--shard=k/36` (`:233`).
- **Sign-in:**
  - `signInLocally` (`tests/helpers/workbenchLocal.ts:25-69`) creates a fresh owner and fresh non-house workspace on plan invite.
  - Members: `joinLocallyAsMember` (`:80-106`).
  - `signedInWarm(page)` (`tests/helpers/r1-gaps.ts:23-29`) grants 2000 cr by SQL and opens `/suites?view=home`.
  - Plan by SQL: `UPDATE workspaces SET plan_id='studio'` (`tests/demo-s02-home-workbench.spec.ts:38-47`).
  - Route mocks: `tests/helpers/workspaceFixtures.ts` (`mockLibrary`, `forbidPaidWork :100`, `assertNoClipping :109`).
  - Phone vs desktop: `tests/helpers/shellMode.ts` (`isCompact`, `shellIsPhone`).
  - Phone floors: `tests/phoneFloors.ts:59-218`.
- **Screenshots:** there is no `toHaveScreenshot` and no baselines.
  - Specs write PNGs to an env-named directory (for example `R1_GAP_SHOTS`, used by `shoot()` in `tests/helpers/r1-gaps.ts:79-82`, with animations disabled), or to `testInfo.outputPath`.
  - Rule: write only to an env-named or git-ignored directory (`docs/subscribed-workspaces.md:69`).
- **Fastest way to run one spec for one screen:**
  ```
  ENGINE_MOCK=1 npm run dev -- -p 4551            # terminal 1 (Turbopack dev; `next start` cannot serve these specs, docs/subscribed-workspaces.md:72-73)
  PW_BASE_URL=http://localhost:4551 PW_PLATFORM_DATABASE_URL=file:.data/ark.db \
    npx playwright test --config=playwright.workbench.config.ts tests/<screen>-workbench.spec.ts \
    --project=workbench-1440x900 [-g "<title>"]   # PW_CHANNEL=chrome if no bundled chromium
  ```
  - `PW_PLATFORM_DATABASE_URL` must match the server's platform DB.
- **Rule 7 viewports** (CLAUDE.md:13): 360×640, 390×844, 844×390, 1440×900, 1920×1080. Requirements: no horizontal overflow, primary actions reachable, sheets clear of the home indicator, no stranded whitespace above 1600 px. 360/390/844x390 render the **phone app**.

---

## 8. What release/1 already has (extend, don't rebuild)
**Already built:**
- Header with segments, ⌘K palette with Atomik cards, Jobs pill and tray, credits pill with amber low state.
- Home (BriefBox, templates, waiting strip, project grid).
- Make panel (Compose, EngineList, Upscale, Recent).
- One board engine with Studio, Ads and Social rails, ToolPill, Inspector, drawers and Review mode (J/K/A/R).
- Settings in five sections; control room (Approvals, Activity, Skills, Memory).
- Phone app; Guest Home; client review link.
- Notify me when done; Undo toasts.
- Money states: short by N cr and Top up, 80% budget pause (`board/cards/plan/money-state.ts:18-30,103`), "Nothing billed" with Retry.
- Price hover in dollars (`components/graphite/Price.tsx`).
- ETA "about N min left" on board take cards.
- Variations (batch takes); Fix/Change with words (TakeCard `:163,:213,:239`; `inspector/change-intent.ts`; phone `FixSheet.tsx`).
- Line drawings, Cut-out, Record consent, Ask the crew.

**Partial:**
- Cancel exists only for Higgsfield Motion/Swap takes and for held jobs.
- Activity is a Jobs tray plus a control-room page; there is no "Activity" header control.
- The low-credit warning compares the balance to the last quote, not to a percentage.
- Moodboard exists only as a legacy node folded into Looks.

**Missing:**
- The interface switch (deleted 6 Oct; see §2.2 to restore).
- Tooltip component; ⌘J (Inspector); "/" shortcut.
- Queue position; ETA in the Jobs tray and Make Recent.
- Per-tile Cancel for Ark and fal queued jobs.
- Library search, and Library as a destination.
- Turnaround; "Start from a tile"; Redraw as a general action; lip-sync engine.
- Plan or included-credit data on the session.
