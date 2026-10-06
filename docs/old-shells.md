# Old shells

The live shell is `/suites` (`app/suites/page.tsx` → `components/graphite/SuitesShell.tsx`). Three older shells still serve routes: `/workspace`, `/workbench`, and everything under `app/(app)/`. In phase D0 (the Graphite redesign, `design/particl-graphite/`) these routes keep working and are only re-pointed at the new design tokens. Retiring a route — redirect it to its `/suites` page, then delete its components and stylesheets — happens in D1, once every replacement page exists. This file is the inventory that decision is checked against.

## How to read the table

- **Replacement URLs** use the params `/suites` actually reads: `project`, `suite`, `page`, `sel`, `asset` (`lib/workspace/navigation.ts › fromSearch`) and `view`, `tab`, `sp`, `cp`, `import` (`lib/shell/state.tsx › readParams`, `SHELL_PARAMS`). `page` is a state-layer page id; `sp` picks the shell page where several share one backing page (`lib/shell/ia.ts`). `/suites` reads no `mode` param: Gen's Video / Images / Audio choice is composer state, not URL state.
- **Redirected today** means a signed-in account with a workspace never sees the old page. "Switch-over" is `switchNowOrGate` (`lib/workspace/switchover.server.ts`) plus `SwitchoverGate`; it is skipped for `?shell=legacy` or the `particl_shell=legacy` cookie, for the legacy-only params `new`, `atomik`, `view`, and for anyone without a workspace.
- **Tests** are spec files under `tests/` that navigate to the route. `desktop.spec.ts` and `mobile.spec.ts` do it through their `ROUTES` lists.
- **Stylesheets** lists only sheets `/suites` does not also load (import graph walked from each page file and its layouts). Every `app/(app)/` route additionally loads three sheets through `app/(app)/layout.tsx` → `components/shell/Shell.tsx`: `components/suites/suite-navigation.css`, `components/studio/studio-navigation.css`, `components/atomik/marketing-studio-entry.module.css`. They are not repeated per row.

## Routes

| Route | Rendered by today | `/suites` replacement | Redirected today? | Tests | Sheets not shared with `/suites` |
|---|---|---|---|---|---|
| **`/workspace`** | | | | | |
| `/workspace` | `app/workspace/page.tsx` → `components/workspace/WorkspaceApp.tsx` | `/suites?project=<id>&suite=<suite>&page=<page>` — same state layer, same query. Missing: Atomik `generate`, `recipes`, `builds` and Viral `shorts`, `sources`, `compare` have no shell page and open the suite's first page | No. A visitor with no app params gets the public page (`proxy.ts` rewrite to `/site/workspace`) | `workspace-shell-workbench`, `workspace-takes-workbench`, `workspace-cast-workbench`, `workspace-edit-workbench`, `workspace-atomik-workbench`, `workspace-switchover-workbench` +19 more | `components/workspace/mobile/mobile.css` |
| **`/workbench`** | | | | | |
| `/workbench` | `app/workbench/page.tsx` → `components/workbench/Studio.tsx` | `/suites?project=<id>&suite=particl` (no stage); `?stage=X` → `&page=<brief\|boards\|cast\|astra\|rig\|takes\|edit\|deliver>`; `?suite=moleculr&page=<section>` → `&suite=moleculr&page=marketing#<section>`. Missing: `atomik=marketing` and `view=workspace` flows; an account with no workspace is sent here by `/suites` itself | Yes (switch-over), with the exceptions above | `workbench`, `rig-workbench`, `editorial-workbench`, `sound-workbench`, `screenplay-workbench`, `workspace-switchover-workbench` +32 more | `app/workbench/mobile.css`, `phone-layout.css`, `phone-stages.css`, `project-first.css`; `components/studio/project-navigation.css`, `studio-navigation.css`; `components/suites/suite-navigation.css`; `components/switchover/switchover.css`; `components/workbench/MarketingStudioPanel.module.css`, `SequenceColor.module.css`, `canvas-selection.module.css`, `editorial.module.css` |
| `/workbench/movie` | `app/workbench/movie/page.tsx` → `components/workbench/MoviePage.tsx` | none yet — `/suites?suite=particl&page=deliver` mounts the same `MovieExport`, but the `?snapshot=` hand-off (`lib/workbench/movie-handoff.ts`, used by pipeline runs) still opens this route | No | `movie-export` (by click), `workspace-security`, `workspace-switchover-workbench` | `app/workbench/phone-stages.css` |
| **`app/(app)/` — entry points** | | | | | |
| `/` | `app/(app)/page.tsx` → `components/suites/SuiteHome.tsx` | `/suites?suite=particl` (a `suite` param is kept) | Yes (switch-over). A visitor with no app params gets the public site (`proxy.ts`) | `desktop`, `entry-points-audit-workbench`, `atomik-suite-workbench`, `moleculr-workbench`, `color-workbench`, `ui-floors-audit-workbench` +1 more | `components/switchover/switchover.css` |
| `/atomik` | `app/(app)/atomik/page.tsx` → `components/suites/AtomikSuite.tsx` | `/suites?project=<id>&suite=atomik&page=<page>` (default `runs`). Missing: `page=generate` and `page=recipes` have no shell page | Yes (switch-over). A visitor with no app params gets `/site/atomik` (`proxy.ts`) | `atomik-suite-workbench`, `atomik-audit-workbench`, `atomik-skills-workbench`, `atomik-key-steps-workbench`, `atomik-late-render-workbench`, `atomik-no-account-workbench` +1 more | `components/switchover/switchover.css` |
| `/subatomik` | `app/(app)/subatomik/page.tsx` → `components/suites/SubatomikWorkspace.tsx` | `/suites?project=<id>&suite=subatomik&page=<motion\|swap>`. Missing: `page=shorts` has no shell page | Yes (switch-over) | `subatomik-workbench`, `video-frame-workbench`, `workspace-switchover-workbench` | `components/switchover/switchover.css` |
| `/subatomic` | `app/(app)/subatomic/page.tsx` → `redirect()` | as `/subatomik` | Yes — `redirect()` to `/subatomik`, which then switches | `moleculr-workbench` | — |
| **`app/(app)/` — generate** | | | | | |
| `/generate` | `app/(app)/generate/page.tsx` → `components/make/GenWorkspace.tsx` | `/suites?view=gen`. Missing: the deep-link params `mode`, `task`, `source`, `ref`, `promptFrom` are not read | No | `gen`, `gen-asset-library`, `astra-gen`, `topaz-gen`, `project-generation-workbench`, `shot-builder-handoff-workbench` +4 more | — |
| `/images`, `/audio` | `app/(app)/images/page.tsx`, `audio/page.tsx` → `redirect()` | `/suites?view=gen` (mode not mapped) | To `/generate?mode=…` only (`lib/genRoute.ts`) | `entry-points-audit-workbench` (`/images`, by request) | — |
| `/make/[kind]` | `app/(app)/make/[kind]/page.tsx` → `redirect()` | `/suites?view=gen` (mode not mapped) | To `/generate?mode=…` only; unknown kind is a 404 | `composer-audio`, `composer-batch`, `gen-asset-library`, `desktop`, `mobile` | — |
| `/studio/shot` | `app/(app)/studio/shot/page.tsx` (page is the component) | none yet — no camera and shot builder page; it hands off to `/generate` | No | `shot-builder-handoff-workbench`, `studio-pages-sideways-workbench`, `desktop`, `mobile` | — |
| **`app/(app)/` — library and productions** | | | | | |
| `/library` | `app/(app)/library/page.tsx` → `components/workbench/ProjectLibraryPage.tsx`, `components/make/GenAssetLibrary.tsx`, `UnfiledWall.tsx` | none yet — the shell's Library is a panel of the open project with no URL; closest page is `/suites?project=<id>&page=takes`. Missing: cross-production lens, References, Unfiled, `all` / `view` params | No | `project-library-workbench`, `project-first-workbench`, `audit-other-ui-workbench`, `paid-action`, `suite-navigation-workbench`, `desktop` +2 more | `app/(app)/library/mobile.css`, `components/studio/projects-library.css` |
| `/all` | `app/(app)/all/page.tsx` → `redirect()` | none yet (follows `/library`) | To `/library?all=1&view=unfiled` only | none | — |
| `/productions` | `app/(app)/productions/page.tsx` (page is the component) | with the new interface on, Home `/suites?view=home` (projects as cards). Missing: the productions list's totals and caps page | No | `desktop`, `mobile`, `no-vendor-dollars-workbench` | `components/studio/projects-library.css` |
| `/productions/[prod]/[project]/media` | `…/media/page.tsx` → `components/production/ProductionHeader.tsx`, `MediaTile.tsx` | none yet — closest `/suites?project=<id>&page=takes`. Missing: production and project ids are not mapped to the draft `project` id | No | `no-vendor-dollars-workbench`, `legacy-pages-sideways-workbench` | — |
| `/productions/[prod]/[project]/shots` | `…/shots/page.tsx` → `components/production/ProductionHeader.tsx` | none yet — closest `/suites?project=<id>&page=brief&sp=beats`. Missing: id mapping as above; move between productions | No | `audit-other-ui-workbench`, `remaining-paths-lost-reply-workbench`, `no-vendor-dollars-workbench` | — |
| `/projects/[id]` | `app/(app)/projects/[id]/page.tsx` → `components/ProductionNav.tsx`, `Analytics.tsx` | none yet — no per-project cost overview | No | `projects-legacy-pages-workbench`, `legacy-pages-sideways-workbench`, `no-vendor-dollars-workbench` | — |
| `/projects/[id]/canvas` | `…/canvas/page.tsx` → `components/ProductionNav.tsx` | none yet — no sequence wall (refs / wall / time) | No | `projects-legacy-pages-workbench`, `desktop` | — |
| `/canvas/[id]` | `app/(app)/canvas/[id]/page.tsx` → `redirect()` | none yet (follows `/projects/[id]/canvas`) | To `/projects/[id]/canvas` only | none | — |
| `/projects/[id]/rig/elements` | `…/rig/elements/page.tsx` → `components/ImpactSheet.tsx` | none yet — closest `/suites?project=<id>&page=cast`. Missing: version swap with the impact panel | No | `legacy-pages-sideways-workbench`, `desktop`, `mobile` | — |
| **`app/(app)/` — rig and takes** | | | | | |
| `/rig/canvas/[boardId]` | `app/(app)/rig/canvas/[boardId]/page.tsx` → `components/rig/RigBar.tsx`, `PhoneBoard.tsx` | `/suites?project=<draft id>&page=rig&import=<boardId>` (`lib/workspace/rig-import.ts › newRigHref`). Missing: a draft id must be resolved first; `new`, `shot` params | No | `rig-canvas-audit-workbench`, `rig-canvas-lost-reply-workbench`, `rig-canvas-unpriced-workbench`, `suites-rig-import-workbench`, `audit-other-ui-workbench`, `desktop` +1 more | — |
| `/rig/recipes/[projectId]` | `app/(app)/rig/recipes/[projectId]/page.tsx` → `components/rig/RigBar.tsx` | none yet — the state layer has a `recipes` page but the shell has no tab for it | No | `legacy-rig-run-workbench`, `desktop`, `mobile` | — |
| `/rig/run/[runId]` | `app/(app)/rig/run/[runId]/page.tsx` → `redirect()` | `/suites?suite=atomik&page=runs` once `/pipelines` moves | To `/pipelines` only | `legacy-rig-run-workbench`, `desktop`, `mobile` | — |
| `/pipelines` | `app/(app)/pipelines/page.tsx` → `components/pipeline/PipelineWorkspace.tsx` | `/suites?project=<id>&suite=atomik&page=runs` (same `PipelineBuilder` / `PipelineRun`). Missing: `projectId` param not mapped | No | `pipelines`, `workspace-switchover-workbench` | — |
| `/takes/[id]` | `app/(app)/takes/[id]/page.tsx` → `components/ProvenanceCard.tsx` | none yet — closest `/suites?page=takes&asset=generation:<id>`. Missing: the provenance card (`/api/rig/provenance`) | No | `desktop`, `mobile` | — |
| `/shots/[id]` | `app/(app)/shots/[id]/page.tsx` → `components/ShotBindings.tsx` | none yet — no shot bindings view (`/api/rig/bindings`) | No | `desktop`, `mobile` | — |
| `/elements/[id]` | `app/(app)/elements/[id]/page.tsx` → `components/ElementScreen.tsx` | none yet — closest `/suites?project=<id>&page=cast`. Missing: one element's ports and versions by URL | No | `desktop`, `mobile` | — |
| **`app/(app)/` — Atomik planning** | | | | | |
| `/atomik/ideas` | `app/(app)/atomik/ideas/page.tsx` (page is the component) | none yet — no ideas board | No | `paid-action`, `desktop`, `mobile` | — |
| `/atomik/treatment` | `app/(app)/atomik/treatment/page.tsx` | none yet — closest `/suites?project=<id>&page=brief`. Missing: treatment drafts are not carried over | No | `atomik-audit-workbench`, `desktop`, `mobile` | — |
| `/atomik/breakdown` | `app/(app)/atomik/breakdown/page.tsx` | none yet — closest `/suites?project=<id>&page=brief&sp=beats` | No | `atomik-pages-audit-workbench`, `audit-money-workbench`, `desktop`, `mobile` | — |
| `/atomik/shots` | `app/(app)/atomik/shots/page.tsx` | none yet — closest `/suites?project=<id>&page=brief&sp=beats` | No | `atomik-pages-audit-workbench`, `no-vendor-dollars-workbench`, `studio-pages-sideways-workbench`, `desktop`, `mobile` | — |
| **`app/(app)/` — workspace management** | | | | | |
| `/settings` | `app/(app)/settings/page.tsx` → `components/management/ManagementPage.tsx` | `/suites?view=workspace&tab=general` (engines: `tab=engines`). Missing: the `#engines`, `#defaults`, `#storage` anchors the state layer still links to | No | `workspace-audit`, `management-scope`, `customer`, `higgsfield-verify-workbench`, `soul-identity-workbench`, `desktop` +1 more | — |
| `/team` | `app/(app)/team/page.tsx` → `components/management/ManagementPage.tsx`, `WorkspaceSecurity.tsx` | `/suites?view=workspace&tab=people` (security: `tab=security`) | No | `account-identity`, `customer`, `management-scope`, `workspace-security` | `components/management/account-security.module.css` |
| `/usage` | `app/(app)/usage/page.tsx` → `components/management/ManagementPage.tsx`, `ConsumerCreditActivity.tsx` | `/suites?view=workspace&tab=usage`; `tab=dashboard` for the dashboard | No | `customer`, `higgsfield-consumer-usage-workbench`, `signin-retired-workbench`, `desktop`, `mobile` | — |
| `/dashboard` | `app/(app)/dashboard/page.tsx` → `redirect()` | `/suites?view=workspace&tab=dashboard` | To `/usage` only | none | — |
| `/statements/[month]` | `app/(app)/statements/[month]/page.tsx` (page is the component) | none yet — the Workspace view links here for the printable statement (`lib/shell/workspace-view.ts › statementHref`) | No | `audit-money-workbench`, `desktop`, `mobile` | — |
| `/connect` | `app/(app)/connect/page.tsx` → `components/Tokens.tsx` | `/suites?suite=atomik&page=skills` (Tools & connections has tokens and setup). Missing: Workspace › Engines still links to `/connect` (`components/graphite/ConnectRow.tsx`) | No | `connect-tokens-workbench`, `management-scope`, `mobile` | — |
| **`app/(app)/` — platform and public pages** | | | | | |
| `/admin` | `app/(app)/admin/page.tsx` (page is the component) | none yet — the Workspace view links here for the platform owner; no platform desk in the shell | No | `platform-desk`, `hf-shared-key-workbench`, `remaining-paths-lost-reply-workbench`, `mobile` | — |
| `/platform` | `app/(app)/platform/page.tsx` | none yet — no platform answers page | No | `mobile` | — |
| `/report` | `app/(app)/report/page.tsx` | none yet — public form; needs a home outside the old shell layout | No | `mobile` | — |
| `/policy`, `/privacy`, `/terms` | `app/(app)/<route>/page.tsx` → `components/PolicyPage.tsx` | none yet — public pages; need a home outside the old shell layout | No | `desktop`, `mobile`; `/terms` also `entry-points-audit-workbench` | — |

## Suites screens behind the new-interface switch

Besides the routes above, `/suites` itself still draws today's screens for every workspace that does not have the new interface on. The switch is per workspace (`lib/shell/new-interface.ts`; the platform owner turns it on from `/admin`, and "Everyone" last). Each new screen is one entry module, listed in the registry (`lib/shell/screens.ts`), with its address rows in its own routing module. Until a screen's `landed` flag is true, its new address opens today's page for it.

**One rule for every PR that lands a screen:** while any workspace still sees the old screen, the old screen stays and gets a row here, with the screen that replaces it. The PR that turns the switch on for everyone deletes every old screen listed here (components, stylesheets, assets, tests) and the switch-off rows in the routing modules. A screen with no customer path left is deleted in the PR that lands its replacement.

Rows are appended by the PR that lands the replacement, in the same table, one per old screen.

| Old screen (switch off) | Where it lives today | Replaced by (switch on) | Entry module | Routing module | Deleted in |
|---|---|---|---|---|---|
| Studio overview, and the phone's Home (`?suite=particl&page=brief&sp=stages`, `sp=home`) | `components/graphite/mobile/StudioHome.tsx`, `components/graphite/mobile/SuiteHome.tsx` | Home, `?view=home` | `components/graphite/home/HomeView.tsx` | `components/graphite/home/routes.ts` | the switch-flip PR |
| The production graph on `/workbench` | `components/workbench/production-graph.tsx` (still imported by `components/workbench/Studio.tsx`) | The board | `components/graphite/board/BoardView.tsx` | `lib/board/routes.ts` | with `/workbench`, in D1 |
| Business pages (`?suite=moleculr&page=marketing&sp=setup\|brand\|product\|reference\|format\|hooks\|dtc\|design`) | `components/graphite/business/{BusinessSuite,BusinessView,BusinessOwnView,BrandTool,ProductTool,FormatTool,HooksTool,ReferenceTool,DesignTool,ParticlSetup,PresetPicker,own-kit,use-own-agent}`, `business.css`, `business-own.css`; the Business pages in `lib/shell/ia.ts`; specs `suites-business-workbench`, `suites-business-own-workbench`, `suites-business-own-agents-workbench`; units `businessOwn`, `suitesBusiness`, `businessStandalone`. Until the flip, the Ads board's Edit panels mount `BrandTool`, `ProductTool`, `ReferenceTool`, `HooksTool` and `FormatTool`, and its cards call `own-kit`'s helpers; the flip PR moves them into `components/graphite/board/ads/` before it deletes the pages | The Ads board, `?view=board&kind=ads` (Brand kit, Product facts, Reference ad, Hooks, Format briefs, the image-ad card, the poster Designer) | `components/graphite/board/ads/index.ts` | `lib/shell/ads-social.ts` | the switch-flip PR |
| Viral › History page (`?suite=subatomik&page=history`) | `components/graphite/viral/ViralView.tsx` (`ViralView`; `HistoryView` is exported as `ViralHistory` for the Social board's drawer and stays until the flip) | The Social board's History drawer, and Make › Recent | `components/graphite/board/social/index.ts` | `lib/shell/ads-social.ts` | the switch-flip PR |
| Atomik's Agent page (`?suite=atomik&page=agent`) | `components/workspace/pages/*` (Agent) | Atomik's panel, `&atomik=1`, over any screen | `components/graphite/atomik/panel/AtomikPanel.tsx` | `components/graphite/atomik/panel/routes.ts` | the switch-flip PR |
| Atomik's Runs, Approvals, Memory and Skills pages | `components/workspace/pages/*`, `components/graphite/atomik/*` | The control room, at the same addresses | `components/graphite/control-room/ControlRoom.tsx` | `lib/control-room/routes.ts` | the switch-flip PR |
| Workspace's seven tabs, Atomik's Budget, Models and Tools pages (`?view=workspace&tab=…`) | `components/graphite/WorkspaceView.tsx` (People, Security, Plans, Usage, General, Engines), `components/graphite/atomik/ToolsView.tsx` and `ToolsInspector`, `components/graphite/ConnectRow.tsx`, and `Budget` and `Models` in `components/suites/AtomikSuite.tsx`. `ManagementDashboard.tsx` stays until Activity (control room) lands | Settings in five sections, `?view=workspace&tab=team\|credits\|rules\|connections\|advanced` (`&open=` unfolds a fold) | `components/graphite/settings/SettingsView.tsx` | `lib/shell/settings.ts` | the switch-flip PR |
| Settings options only the old `/settings` page has: file naming, delivery copies, lock new assets, training preference, notifications, which engines Atomik may propose, delete workspace | `app/(app)/settings/page.tsx` | none yet: needs a home before `/settings` retires | — | — | D1 (not built in the demo push) |
| The phone's header, page strip and tab bar | `components/graphite/TabBar.tsx`, `phone.css`, the compact rows of `Header.tsx` and `StageStrip.tsx` | The phone's own screens, at compact widths or with `device=phone` | `components/graphite/phone/PhoneApp.tsx` | `components/graphite/phone/routes.ts` | the switch-flip PR |
| Make's panel as it is today: `MakePanelToday` (Video · Images · Audio · Edit tabs, the controls under the composer, the Results grid), its engine sheet `components/graphite/ModelSheet.tsx` (used by nothing else), and the rules in `make.css` above its `.gx-mk` block | `components/graphite/MakePanel.tsx`, `ModelSheet.tsx`, `make.css` | Make as `design/particl-graphite/` draws it (README § 3.2), `components/graphite/make/*` | `components/graphite/MakePanel.tsx` | `lib/shell/make.ts` | the switch-flip PR, with the specs that drive today's panel |

The Rig's data layer stays when these go: `components/workspace/rig/RigProvider.tsx`, `use-team-canvas.ts`, `use-cutouts.ts` and the `lib/workspace/rig-*` models are what the board reads. `RigImport.tsx` stays until the board shows an import.

## Deleted by the board PR (6 Oct 2026)

Owner decision 42 (5 Oct night): the canvas is the whole production. Studio, Ads and Social are one board for every workspace, switch on or off, and the ten Studio stage pages of `/suites` are gone: Brief, Beats, Storyboards, Environment, Cast, Astra 3D, Rig, Takes, Edit & Sound and Deliver. Each old address (the app's spelling, the design file's, and a take link copied before) opens the board's region for it: the table is `lib/shell/stage-redirects.ts`, held by `tests/unit/demo-board-stage-redirects.spec.ts` and `tests/demo-board-stage-redirects-workbench.spec.ts`. Studio's overview and the phone's "Where to?" stay as Home's until the switch flips (its stage cards open the board's regions).

Gone with them: `StageView`, `BriefStage`, `BeatsStage`, `BeatGraph`, `StoryboardStage`, `EnvironmentStage`, `CastStage`, `EditStage`, `AstraOutputs`, the Rig library (`RigLibrary`), `VerifyBadge`, the Beats undo and node-graph logic, the Takes desk's list logic, the take hand-over letterbox, their rules in `production.css`, `shell.css`, `rig.css`, `rig-verify.css` and `phone.css`, and the browser specs that drove them.

What the stage pages did that the board does not draw yet (each was a page-only control; its code is listed so a card can take it over):

| Was on | Not on the board yet | Code left in the repo |
|---|---|---|
| Brief & Script | the script writer and its redraft, the Final Draft and PDF import, the script editor | `components/workbench/ScriptPanel.tsx`, `DevelopmentPanel.tsx`, `lib/production/notes.ts`, the screenplay readers in `lib/` |
| Beats & Shots | the breakdown that writes the beat sheet from a script; the beat node graph | `lib/production/beats.ts` (the board edits the same sheet) |
| Storyboards | line drawings, frame prompts and revisions | `lib/production/boards.ts` |
| Takes | the Takes desk's own filters. Transcribe is on the board now: the Transcribe action on a video or audio reference card and on Social's source card, with its transcript panel (`components/graphite/board/transcribe/`) | `lib/workbench/transcription-request.ts` (the board's `use-transcribe.ts` sends through it) |
| Cast and Environment | the Soul render of a character, plates chosen and added on a place | `lib/production/cast-render.ts`, `CastIdentities.tsx` (the cast card's Inspector hosts Build identity) |
| Astra 3D | 3D blocking: no card hosts the tool | `components/astra-blender/*`, `components/workspace/spec/tools/AstraTool.tsx` (unmounted) |
| Rig | the cut-out (priced), card lock and history on the old canvas, the Rig's own agent wiring | `components/workspace/rig/*` (the old `/workspace` shell still mounts the Rig page; the board reads `RigProvider` and the `lib/workspace/rig-*` models) |
| Edit & Sound, Deliver | nothing: the Cut and Deliver cards open the existing editor and exporter over the board | `EditPage.tsx`, `MovieExport.tsx` stay |

The old `/workspace` and `/workbench` shells keep their own page bodies (`components/workspace/pages/*`) until D1. Business's pages and Viral's History page are not shown to anyone either: their addresses open the Ads board and the Social board's History drawer (`lib/shell/ads-social.ts`); their components stay until the flip PR deletes them (`ViralHistory` is the History drawer's body). Crew's page is the same: `?view=crew` opens the board's Crew review (`lib/board/routes.ts`).

## `/suites` pieces the new interface replaces

With the new interface switched on, these `/suites` pieces are not shown; with it off, customers still use them. They are deleted in the switch-flip PR.

### Atomik: ⌘K, the panel and "Ask Atomik how"

| Piece (switch off) | Rendered by | Replacement (switch on) | Tests that go with it |
|---|---|---|---|
| ⌘K's suite index (Generate, suites, stage pages, Crew pages, Workspace tabs) and its "Ask Atomik: …" row, which hands the words to the Agent page | `components/graphite/Palette.tsx` › `PaletteDialog`, `lib/shell/palette.ts` › `paletteIndex`, `searchPalette` | ⌘K as search and Atomik in one box: `AtomikPalette` in the same file, `newPaletteIndex`, `searchNewPalette`, the cards in `components/graphite/atomik/panel/` | `tests/unit/suitesShell.spec.ts` (palette cases), `tests/suites-shell-workbench.spec.ts` (palette cases) |
| Atomik › Agent `?suite=atomik&page=agent` | `components/workspace/spec/tools/AtomikTool.tsx` (agent branch) → `components/suites/SuiteAgentPanel.tsx`, `components/atomik/threads/ThreadsPanel.tsx`, `ThreadSwitcher.tsx`, `threads.module.css` | Atomik's panel `&atomik=1` (`components/graphite/atomik/panel/AtomikPanel.tsx`) on the same thread engine (`components/atomik/AtomikProvider.tsx`); the plan card on the board. `SuiteAgentPanel` stays while `AtomikSuite`, `SubatomikWorkspace` and `Studio` import it | `tests/atomik-threads-workbench.spec.ts` (Agent page cases), `tests/suite-agent-workbench.spec.ts` |
| The page's Atomik plan sheet and its gate row under the stage strip | `components/graphite/AtomikSheet.tsx`, `AtomikGate.tsx`, `lib/shell/atomik-sheet.ts` | Waiting runs reach people through the control room's Approvals and Atomik's panel; the stage pages they sit on retire with the board | `tests/suites-atomik-gate-workbench.spec.ts`, parts of `tests/unit/atomikNoAccount.spec.ts` and `tests/unit/suitesShellAudit.spec.ts` |
| Make's panel as it is today | `components/graphite/MakePanel.tsx` | Make re-laid out behind the switch (the switch-off panel stays as it is) | `components/graphite/MakePanel.tsx` | `lib/shell/make.ts` | the switch-flip PR |
| The public site's homepage, `/` for a signed-out visitor (Guest Home off, the default) | `app/(marketing)/site/_pages/gen/index.tsx`, `components/marketing/HeroPrompt.tsx`, their `.mk-hero*` and `.mk-prompt*` rules in `components/marketing/marketing.css` | Guest Home, `/` signed out with the site-wide /admin "Guest Home" setting on (design README § 3.7) | `components/graphite/guest/GuestHome.tsx` | `app/(marketing)/site/[[...slug]]/page.tsx` (reads `lib/site/settings.server.ts`) | The PR after the owner turns Guest Home on for good: the homepage and its copy are deleted; /pricing stays its own page |

## Notes that change what D1 can delete

- `/suites` still imports old-shell code: `components/suites/AtomikSuite.tsx`, `SubatomikWorkspace.tsx`, `MoleculrWorkspace.tsx`, `components/workbench/MovieExport.tsx`, `ProjectLibraryPage.tsx` and `components/management/ManagementPage.tsx`. Retiring a route does not make these deletable.
- Four `/workbench` sheets are shared: `app/workbench/workbench.css`, `desk.css`, `graphite.css` and `editorial-graphite.css` reach `/suites` through `components/workspace/spec/tools/studio-css.ts`. `components/workspace/workspace.css` and `components/workspace/pages/assets.css` are shared the same way.
- `WORKSPACE_TABS` in `lib/shell/ia.ts` still carries each tab's old `href` (`/settings`, `/team`, `/usage`, …). Those go when the routes do.
- Specs that assert the old shell ask for it through `tests/helpers/legacyShell.ts`; the helper and its call sites go with the old shell.

## Suites screens behind the new-interface switch

Screens inside `/suites` that customers still see while the new interface is off, each with what replaces it when it is on. They stay until the switch is on for everyone, and are deleted in that PR.

| Old screen (switch off) | Rendered by | Replacement (switch on) | Tests that go with it |
|---|---|---|---|
| Studio overview, `?suite=particl&page=brief&sp=stages` (the desktop's Home today; on a phone, the Studio stage grid) | `components/graphite/mobile/StudioHome.tsx`; `lib/shell/studio-home.ts` (`stageCards`, `upNext`, `recentTakes`, `runningTakes`, `startsEmpty`, `FIRST_RUN_STEPS`; Home uses `savedAt` and `recentProjects`, which move into `components/graphite/home/` first); the `.gx-home*`, `.gx-first*` and `.gx-recent*` rules in `components/graphite/shell.css` and `phone.css`. `components/graphite/FirstRun.tsx` stays while the stage pages use it | Desktop: Home `?view=home` (`components/graphite/home/HomeView.tsx`). Phone: the phone's Home and Record | `tests/unit/suitesStudioHome.spec.ts`, `tests/suites-phone-home-workbench.spec.ts`, and the Studio-home parts of `suites-shell-audit`, `suite-navigation`, `ui-floors-audit` and `hf-phone-chrome` |

## Before a route is retired

- [ ] The replacement page exists in `/suites` and covers what the old page did — no "none yet" left in its row.
- [ ] Every deep-link param the old route reads is mapped to `/suites` params (or deliberately dropped and listed here), and the redirect is added to `lib/workspace/switchover.ts` with a unit test both ways.
- [ ] Nothing in `/suites`, `lib/shell` or `lib/workspace` links to the old route any more.
- [ ] Its tests are moved to the `/suites` page or deleted with the behaviour; `desktop.spec.ts` and `mobile.spec.ts` `ROUTES` are updated; the five viewports still pass.
- [ ] Its components are not imported by `/suites`, then deleted.
- [ ] Its unshared stylesheets (last column) are deleted, and shared ones are left alone.
- [ ] This file and `docs/workspace-switchover.md` are updated in the same PR.
- [ ] Its row leaves `PENDING` in `lib/shell/ia.ts` (every route here is listed there, retired by D1; `tests/unit/shellRedirects.spec.ts` checks the two agree).

## Suites screens behind the new-interface switch

Screens customers still see while the switch is off. Each is deleted in the switch-flip PR, not before.

| Old screen | Replaced by (switch on) | Its tests |
|---|---|---|
| The phone's Home, "Where to?" (`components/graphite/mobile/SuiteHome.tsx`; the `.gx-where*` block in `components/graphite/shell.css`; `suiteTiles` and `assetsRowLabel` in `lib/shell/studio-home.ts`) | The phone's Home (`components/graphite/phone/HomeScreen.tsx`): what needs you, then projects | `tests/suites-phone-home-workbench.spec.ts`; the suite-tile cases in `tests/unit/suitesStudioHome.spec.ts` |
| The phone's Studio stage grid (`components/graphite/mobile/StudioHome.tsx` on a phone; the `.gx-home*` block in `components/graphite/shell.css`). On a desktop the same component is the Studio overview, which Home replaces | The phone's Home (projects) and the phone's Record; on a desktop, Home (`components/graphite/home/HomeView.tsx`) | `tests/suites-phone-home-workbench.spec.ts`; `tests/unit/suitesStudioHome.spec.ts` |
| The phone's tab bar Home · Gen · Suites · Assets · More (`components/graphite/TabBar.tsx`) and the phone-only `home` and `stages` pages in `lib/shell/ia.ts` | The phone's tabs Home · Record · Make · Atomik (`components/graphite/phone/PhoneChrome.tsx`) | `tests/hf-phone-chrome-workbench.spec.ts` |
| The old shell's compact phone chrome (`components/graphite/phone.css`) | The phone's own header, tabs and screens (`components/graphite/phone/phone-screens.css`) | `tests/hf-phone-chrome-workbench.spec.ts` |
Old screens that customers still use while the switch is off. Each is deleted in the switch-flip PR, with its sheets and tests, once nothing else imports it.

| Old screen | Files | Replaced by (switch on) | Notes |
|---|---|---|---|
| The production graph on `/workbench` | `components/workbench/production-graph.tsx` | The board | Still imported by `components/workbench/Studio.tsx` (the `/workbench` row above). |

## `/suites` pages replaced behind the new interface

With the new interface on (`lib/shell/new-interface.ts`), these pages render their replacement; with it off, customers keep the old page. Each old page is deleted in the switch-flip PR, with its components, sheets and tests, once no customer path uses it.

| Old page (switch off) | Rendered by today | Replacement (switch on) | Not covered yet |
|---|---|---|---|
| `?suite=atomik&page=approvals` | `components/suites/AtomikSuite.tsx` (its approvals branch, per project) with `components/pipeline/PipelineRun.tsx` | Control room › Approvals: `components/graphite/control-room/` over `GET /api/control-room/approvals`, one queue across projects (held takes, Atomik's board builds and renders, a plan's next step) | Pipeline runs that need a decision are not in the new queue (lead decision 15). `AtomikSuite.tsx`, `atomik-suite.module.css` and `atomik-suite-data.ts` go only when Activity, Budget and Models are replaced too |
| `?suite=atomik&page=runs` | `components/suites/AtomikSuite.tsx` (its runs branch, per project: pipeline runs) with `components/suites/SuiteAgentPanel.tsx`, `components/pipeline/PipelineBuilder.tsx`, `PipelineRun.tsx` | Control room › Activity: `components/graphite/control-room/ActivityView.tsx` over `GET /api/control-room/activity`, Atomik's threads and board runs with each step priced and settled, and what every project settled | Pipeline runs and Studio stage-agent runs are not listed (lead decision 15); building a new pipeline has no place in the new interface yet. `/pipelines` and `/rig/run/[runId]` point here once retired |
| `?suite=atomik&page=agent&sp=saved-skills` | `components/graphite/atomik/SkillsView.tsx`, `skills-view.module.css` | Control room › Skills: `components/graphite/control-room/SkillsRoom.tsx` on the same skills routes (`lib/shell/use-skills.ts`) | Archive and Restore are not on the new page yet. The new page reuses `EditSkill` (exported from the old view) and `SaveSkillDialog`; both move or go with the old view at the flip |
| `?suite=atomik&page=agent&sp=memory` | `components/graphite/atomik/MemoryView.tsx` | Control room › Memory: `components/graphite/control-room/MemoryRoom.tsx` on the same memory routes (`lib/shell/use-memory.ts`); Read with Atomik is today's paid read (`AtomikRead`, exported, with the new price words) | Import from another assistant, editing an entry and remembering a Library item (Reference, an identity) are not on the new page yet; the brand-kit block is today's card. `AtomikRead` and `BrandKitMemory` move or go with the old view at the flip |

## Release 1: the Business specs now run on the Ads board

`suites-business-workbench`, `suites-business-own-workbench`, `suites-business-own-agents-workbench` and their helper `tests/helpers/businessOwn.ts` open the Ads board at the card each old Business address is redirected to (`lib/shell/ads-social.ts`), and keep every price, spend and "nothing sent until a person presses" assertion there. Setup and the member page-shell checks have no page left; the Setup list is the Brand, Product and Reference cards. A phone draws no canvas, so the board's tests skip phone widths with that reason, and one phone test asserts that the old addresses open the Record. Two tests are `test.fixme` until the owner decides: the old Image ads page's build names (2.5 Flare) and its preset catalogue exist only in `BusinessView.tsx` (`ImageAdsView`, `PresetPicker`), which no address reaches; port them to the board's image-ad card, or accept the loss and delete both tests with those components.
