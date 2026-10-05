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
| `/workbench` | `app/workbench/page.tsx` → `components/workbench/Studio.tsx` | `/suites?project=<id>&suite=particl` (no stage); `?stage=X` → `&page=<brief\|boards\|cast\|astra\|rig\|takes\|edit\|deliver>`; `?suite=moleculr&page=<section>` → `&suite=moleculr&page=marketing#<section>`. Missing: `atomik=marketing` and `view=workspace` flows; an account with no workspace is sent here by `/suites` itself | Yes (switch-over), with the exceptions above | `workbench`, `rig-workbench`, `editorial-workbench`, `sound-workbench`, `screenplay-workbench`, `workspace-switchover-workbench` +32 more | `app/workbench/mobile.css`, `mobile-handoff.css`, `mobile-handoff-stages.css`, `project-first.css`; `components/studio/project-navigation.css`, `studio-navigation.css`; `components/suites/suite-navigation.css`; `components/switchover/switchover.css`; `components/workbench/MarketingStudioPanel.module.css`, `SequenceColor.module.css`, `canvas-selection.module.css`, `editorial.module.css` |
| `/workbench/movie` | `app/workbench/movie/page.tsx` → `components/workbench/MoviePage.tsx` | none yet — `/suites?suite=particl&page=deliver` mounts the same `MovieExport`, but the `?snapshot=` hand-off (`lib/workbench/movie-handoff.ts`, used by pipeline runs) still opens this route | No | `movie-export` (by click), `workspace-security`, `workspace-switchover-workbench` | `app/workbench/mobile-handoff-stages.css` |
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
| `/library` | `app/(app)/library/page.tsx` → `components/workbench/ProjectLibraryPage.tsx`, `components/make/GenAssetLibrary.tsx`, `UnfiledWall.tsx` | none yet — the shell's Library is a panel of the open project with no URL; closest page is `/suites?project=<id>&page=takes`. Missing: cross-production lens, References, Unfiled, `all` / `view` params | No | `project-library-workbench`, `project-first-workbench`, `audit-other-ui-workbench`, `paid-action`, `suite-navigation-workbench`, `desktop` +2 more | `app/(app)/library/mobile.css`, `components/studio/legacy-graphite.css` |
| `/all` | `app/(app)/all/page.tsx` → `redirect()` | none yet (follows `/library`) | To `/library?all=1&view=unfiled` only | none | — |
| `/productions` | `app/(app)/productions/page.tsx` (page is the component) | with the new interface on, Home `/suites?view=home` (projects as cards). Missing: the productions list's totals and caps page | No | `desktop`, `mobile`, `no-vendor-dollars-workbench` | `components/studio/legacy-graphite.css` |
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
| Studio stages and the Rig (`?suite=particl&page=brief\|boards\|cast\|astra\|rig\|takes\|edit\|deliver`) | `components/graphite/production/*`, `components/workspace/rig/*`, the Library and Inspector columns | The board, `?view=board` and its regions | `components/graphite/board/BoardView.tsx` | `lib/board/routes.ts` | the switch-flip PR |
| Business pages (`?suite=moleculr&page=marketing&sp=…`) and Viral History | `components/graphite/business/*`, `components/graphite/viral/*` | The Ads and Social boards, `?view=board&kind=ads\|social` | `components/graphite/board/BoardView.tsx` (by kind) | `lib/shell/ads-social.ts` | the switch-flip PR |
| Atomik's Agent page (`?suite=atomik&page=agent`) | `components/workspace/pages/*` (Agent) | Atomik's panel, `&atomik=1`, over any screen | `components/graphite/atomik/panel/AtomikPanel.tsx` | `components/graphite/atomik/panel/routes.ts` | the switch-flip PR |
| Atomik's Runs, Approvals, Memory and Skills pages | `components/workspace/pages/*`, `components/graphite/atomik/*` | The control room, at the same addresses | `components/graphite/control-room/ControlRoom.tsx` | `lib/control-room/routes.ts` | the switch-flip PR |
| Workspace's seven tabs, Atomik's Budget, Models and Tools pages (`?view=workspace&tab=…`) | `components/graphite/WorkspaceView.tsx`, `components/management/*` | Settings in five sections, `?view=workspace&tab=team\|credits\|rules\|connections\|advanced` | `components/graphite/settings/SettingsView.tsx` | `lib/shell/settings.ts` | the switch-flip PR |
| The phone's header, page strip and tab bar | `components/graphite/TabBar.tsx`, `phone.css`, the compact rows of `Header.tsx` and `StageStrip.tsx` | The phone's own screens, at compact widths or with `device=phone` | `components/graphite/phone/PhoneApp.tsx` | `components/graphite/phone/routes.ts` | the switch-flip PR |
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
