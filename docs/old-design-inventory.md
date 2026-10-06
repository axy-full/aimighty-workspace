# Old design inventory

Written 5 Oct 2026 on the clean slate (PR #528, `design/clean-slate`). It lists everything an older design left in the repo once the clean slate has merged, who still imports it, and which PR or stream deletes it. The owner's rule: `design/particl-graphite/` is the only design and `app/graphite.css` the only token set. By Thursday 8 October evening this inventory is empty, except the items in "Kept, with a reason and a date" (§7), each of which names why and until when.

`tests/unit/one-design-guard.spec.ts` holds the line while the list shrinks: it fails if a deleted path comes back, if an old style sheet is added, if a new sheet reads anything but `app/graphite.css`, or if UI text gains a retired name. `tests/unit/one-design-baseline.json` is its allow-list of live old sheets and its per-file counts of retired words. Both only go down. Every path they still allow appears in this file (the guard checks that), so a PR that deletes a file removes its baseline entry (`UPDATE_ONE_DESIGN_BASELINE=1`) and may remove its row here.

## How to read this

- **Deleting PR or stream** names who removes the item. Streams are the current push's: 1 switch and shell, 2 Home, 3 board canvas, 4 board cards 1 (brief, looks, storyboard, plan), 5 board cards 2 (shots, cast, cut, deliver, Inspector), 6 Make, 7 Atomik, 8 control room, 9 Settings, 10 phone, 11 Ads and Social, 12 sample production, 15 marketing site. **Flip PR** is the PR that turns the new interface on for everyone and deletes the old shells (the owner's yes). **D1** is the retire-routes work after it. **Orphan sweep** is a small cleanup PR for files nothing imports; it needs an owner (§9).
- **Imported by** is read from the import graph of this branch (source files; tests are counted separately). "none" means no source file imports it.
- **Target** is a date. The owner's target for all of it is Thu 8 Oct evening; the 5 Oct evening order is that each PR which ships a screen deletes the screen and sheets it replaces, so the target is that stream's PR date. Where customers still see the old screen with the switch off, the row says so and the flip PR is the fallback.
- **Replacement** says which screen of `design/particl-graphite/` takes over (README § 1.2 and `docs/handoff-diff.md`).

## 0. Counts

| Kind | Items | Goes to zero by |
|---|---|---|
| Docs deleted by #528 (confirmed) | 83 files (`docs/handoff/` 49, `docs/phase-0/` 33, `docs/four-suites-v2-plan.md` 1) | done |
| Docs still in the repo from older designs or plans | 27 doc files in §1b: 8 to delete (older briefs, plans and retired-feature docs), 1 to rename or delete, 16 to re-path or rename, 2 SOW files kept for the owner; plus two lines in `CLAUDE.md` and `brand/atomik/README.md` | Thu 8 Oct |
| Style sheets (all `.css`, tracked) | 86: `app/graphite.css` (the one token set), `app/fonts.css` (fonts), and **84 old sheets** (84 on the allow-list) | Thu 8 Oct; the kept ones in §7 |
| Second token names (alias layers over `app/graphite.css`, no values of their own) | 4: `app/globals.css` (83 names), `app/workbench/workbench.css` (80), `components/workspace/workspace.css` (71), and the `--graphite-*` block (22) inside `app/graphite.css` itself. Plus `components/suites/four-suites.css` (909 lines of the old four-suite look), loaded by `app/layout.tsx` on every page | flip PR / D1 |
| Marketing and UI copy from the old structure | 56 files, 174 occurrences (the baseline; 30 in 8 marketing files are already fixed on `site/copy-names`) | Thu 8 Oct |
| Old screens: routes (§4) and the `/suites` pages (§4b) | 44 route page files in the three old shells; 32 pages in `/suites` (the 10 Studio stages are deleted since 6 Oct: 2 Home pages, 8 Business, 3 Viral, 8 Atomik, 7 Workspace tabs, 3 Crew, Gen) | streams 2-11, flip PR |
| Source files of old screens (§6) | 337 to delete, of which 26 are orphans nothing imports; 10 shell files stream 1 rebuilds in place; 85 kept with a reason | streams 2-11, flip PR |
| Exports and pictures of old screens | 5 screenshots on the marketing pages (§8) | stream 15 |

**Board PR, 6 Oct (owner decision 42: the canvas is the whole production).** The ten Studio stage pages of `/suites`, their components (`StageView`, `BriefStage`, `BeatsStage`, `BeatGraph`, `StoryboardStage`, `EnvironmentStage`, `CastStage`, `EditStage`, `AstraOutputs`, the Rig library, `VerifyBadge`), their helpers (`beat-graph`, `beats-undo`, `takes-desk`, `take-handover`), their rules in `production.css`, `shell.css` and `rig.css`, and the browser specs that drove them are gone. Studio, Ads and Social are one board for every workspace, with the switch on or off. Each old address (the app's spelling, the design file's, and a copied take link) is redirected to the board's region: the table is `lib/shell/stage-redirects.ts`, held by `tests/unit/demo-board-stage-redirects.spec.ts` and `tests/demo-board-stage-redirects-workbench.spec.ts`. The old `/workspace` and `/workbench` shells keep their own page bodies until D1.

Items with no owner yet are listed in §9. The headline ones: the 3D blocking tool (Astra Blender, 9 files and 3 sheets plus the Astra stage pages), the editor and tool panels the handoff opens as they are, the primitive sets (`components/ui`, `components/workspace/ui`), the old app pages no frame draws, the orphan sweep, and the stale docs.

## 1. Docs and plans

### 1a. Deleted by #528 (confirmed against `git diff origin/main...HEAD`)

| Path | Kind | Imported by | Deleting PR | Target |
|---|---|---|---|---|
| `docs/handoff/` (49 files: the takeover notes, 28 ideas, 14 reviews, node-graph README, status) | docs, plan | docs and sheets that cited it; all references were rewritten | #528 | done |
| `docs/phase-0/` (33 screenshots of the pre-Graphite screens) | export | none | #528 | done |
| `docs/four-suites-v2-plan.md` | plan | none | #528 | done |
| `public/marketing/screens/studio-cast.jpg`, `studio-takes.jpg`, `workspace-general-enhancer.jpg` | export | the marketing pages (references removed) | #528 | done |
| `app/workbench/mobile-handoff.css`, `app/workbench/mobile-handoff-stages.css`, `components/studio/legacy-graphite.css` | style sheet | none (renamed to `phone-layout.css`, `phone-stages.css`, `projects-library.css`: see §2) | #528 renamed them; later PRs delete them | see §2 |

The guard's tombstone list (`tests/unit/one-design-guard.spec.ts`) fails if any of these returns. Only `design/particl-graphite/` remains under `design/`; the guard also fails on a second design folder, a `.dc.html` export or `support.js` outside it, and any path named for a "round 1". Round 1 of the guest Home is not in the repo.

### 1b. Still in the repo

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `docs/old-shells.md` | plan (old-shell inventory) | cited by the sheets of the old shells, `docs/workspace-switchover.md` | flip PR / D1 (lead): deleted with the last old route; this file replaces it | Thu 8 Oct, needs the owner's yes |
| `docs/workspace-switchover.md` | plan (the switch-over to the `/suites` shell) | 13 files cite it (comments, specs) | flip PR / D1 (lead) | Thu 8 Oct, needs the owner's yes |
| `docs/four-suite-workspace.md` | older design brief ("the September 2026 four-suite design brief") | `lib/providerPool.ts` (a comment), `docs/particl-sow.md` | orphan sweep: delete, and drop the two citations | Tue 6 Oct |
| `docs/four-suite-apis.md` | plan with old names (Moleculr Business Suite, "three suites") | one citation | orphan sweep: delete, or rename to Ads/Social if the API notes are still wanted (lead) | Tue 6 Oct |
| `docs/production-workbench.md` | older design doc (the 13 September `/workbench` redesign) | one citation | flip PR / D1 with `/workbench` | Thu 8 Oct, needs the owner's yes |
| `docs/rig-bug-inventory.md` | inventory of the old Rig canvas (`production-graph.tsx`) | none | stream 3 (the board replaces that canvas) | Thu 8 Oct |
| `docs/atomik-generation.md` | retired-feature doc (marked "Retired 28 September") | none | orphan sweep: delete; history keeps it | Tue 6 Oct |
| `docs/connected-qualification-2026-09-20.md` | retired-feature report (marked "Historical") | none | orphan sweep: delete; history keeps it | Tue 6 Oct |
| `docs/higgsfield-soul-integration.md` | retired-feature doc (Soul, 35 mentions of old names) | none | stream 9 (Identity in Settings) renames it, or the orphan sweep deletes it | Thu 8 Oct |
| `docs/subatomik-genjutsu.md` | engineering doc under the old names (Subatomik, Genjutsu) | one citation | stream 11 (Social) + stream 6 (Motion transfer, Object swap): rename to the new names | Thu 8 Oct |
| `docs/moleculr-provider-capabilities.md` | engineering doc under the old name (Moleculr) | one citation | stream 11 (Ads): rename | Thu 8 Oct |
| `docs/gen-seedance-edit.md`, `docs/seedance-draft-final.md`, `docs/astra-video-upscale.md`, `docs/topaz-image-upscale.md` | feature docs that say where it lives in the old UI ("Gen → Video → Engine") | specs and code comments | stream 6 (Make): re-path to Make and say "Topaz upscale" | Thu 8 Oct |
| `docs/sequence-color.md`, `docs/sound-mix.md`, `docs/screenplay-import.md`, `docs/agentic-development.md`, `docs/editorial-history.md`, `docs/studio-delivery-spec.md` | feature docs that say where it lives in the old UI ("Studio → Script", "Edit → Sequence color") | specs and code comments | streams 4 and 5: re-path to the board regions | Thu 8 Oct |
| `docs/durable-production-pipelines.md` | feature doc ("linked from Studio at /pipelines") | two citations | stream 8 (Activity) | Thu 8 Oct |
| `docs/security-history.md`, `docs/workspace-security-policy.md`, `docs/account-security.md` | feature docs that say "Settings → Activity", "People →" (the old Workspace tabs) | specs and code comments | stream 9 (Settings) | Thu 8 Oct |
| `docs/particl-sow.md`, `docs/particl-sow-2026-10-04.md` | the owner's SOW: 65 and 44 mentions of the old suite names, and an IA that predates README § 1 | `CLAUDE.md` and the guard's notes cite them | KEPT: the SOW of record. The owner amends or retires it; no stream may edit it | owner (see §9) |
| `CLAUDE.md` (lines 13 and 18 say "Rig") | plan / rules text | read by every agent | PR #525 (docs handover, lead) | with #525 |
| `brand/atomik/README.md` (cites "Atomik Brand Assets.dc.html", an export that is not in the repo) | export reference | none | orphan sweep: drop the line | Tue 6 Oct |

`docs/handoff-diff.md` and `docs/handover-2026-10-05.md` (PR #525) are history and are exempt from the guard; so is the design folder.

## 2. Style sheets and token files

Every tracked `.css` (86 files) is listed. "Token debt" is how many custom properties the sheet defines itself, and how many names it reads that `app/graphite.css` does not define (they come from the alias layers in `app/globals.css`, `app/workbench/workbench.css` or `components/workspace/workspace.css`). The new design needs neither: a replacement sheet sits beside its component and reads graphite tokens only.

| Sheet | Lines | Kind | Imported by | Token debt | Replacement screen | Deleting PR or stream | Target |
|---|---|---|---|---|---|---|---|
| `app/(app)/library/mobile.css` | 40 | screen sheet | `app/(app)/library/page.tsx` | none | Library drawer, Make > Recent | stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |
| `app/(app)/statements/[month]/statement.css` | 21 | screen sheet | `app/(app)/statements/[month]/page.tsx` | 0 own, 2 foreign | none drawn | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/studio/shot/shot.css` | 36 | screen sheet | `app/(app)/studio/shot/page.tsx` | 0 own, 12 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(marketing)/site/_pages/atomik/atomik.module.css` | 56 | module sheet | `app/(marketing)/site/_pages/atomik/index.tsx` | none | guest Home (stream 15, waits for the owner's frames) | stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/pricing/pricing.module.css` | 82 | module sheet | `app/(marketing)/site/_pages/pricing/PlanCards.tsx`, `app/(marketing)/site/_pages/pricing/index.tsx` | 1 own, 0 foreign | guest Home (stream 15, waits for the owner's frames) | stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/studio/studio.module.css` | 55 | module sheet | `app/(marketing)/site/_pages/studio/index.tsx` | 1 own, 0 foreign | guest Home (stream 15, waits for the owner's frames) | stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/fonts.css` | 12 | fonts (kept) | `app/layout.tsx` | 2 own, 0 foreign | - | kept: fonts, not tokens | - |
| `app/globals.css` | 1370 | token alias layer + shared rules | `app/layout.tsx` | 83 own, 7 foreign | graphite.css tokens; Tailwind import and base rules stay, the alias :root, @theme and the old primitives go with the last old screen | stream 1 (shell) + flip PR / D1 (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/graphite.css` | 199 | token set (kept) | `app/layout.tsx` | defines the set (141); carries the `--graphite-*` alias block and `--gx-suite-*` dots (see below) | - | kept: the one token set | - |
| `app/review/[token]/review.css` | 37 | screen sheet | `app/review/[token]/page.tsx` | 0 own, 8 foreign | none drawn | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/workbench/desk.css` | 105 | screen sheet | `app/workbench/movie/page.tsx`, `app/workbench/page.tsx`, `components/workspace/spec/tools/studio-css.ts` | 2 own, 16 foreign | board sheets beside their components (streams 3, 4, 5) | streams 3, 4, 5 (stage pages go) + D1 retire /workbench (lead) | Thu 8 Oct |
| `app/workbench/editorial-graphite.css` | 420 | screen sheet | `app/workbench/page.tsx`, `components/workspace/spec/tools/studio-css.ts` | none | board sheets beside their components (streams 3, 4, 5) | streams 3, 4, 5 (stage pages go) + D1 retire /workbench (lead) | Thu 8 Oct |
| `app/workbench/graphite.css` | 327 | screen sheet | `app/workbench/page.tsx`, `components/workspace/spec/tools/studio-css.ts` | 0 own, 1 foreign | board sheets beside their components (streams 3, 4, 5) | streams 3, 4, 5 (stage pages go) + D1 retire /workbench (lead) | Thu 8 Oct |
| `app/workbench/mobile.css` | 46 | screen sheet | `app/workbench/page.tsx` | 2 own, 16 foreign | phone screens (stream 10) | stream 10 (phone) + D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/workbench/phone-layout.css` | 163 | screen sheet | `app/workbench/page.tsx` | 0 own, 13 foreign | phone screens (stream 10) | stream 10 (phone) + D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/workbench/phone-stages.css` | 714 | screen sheet | `app/workbench/movie/page.tsx`, `app/workbench/page.tsx` | 0 own, 1 foreign | phone screens (stream 10) | stream 10 (phone) + D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/workbench/project-first.css` | 30 | screen sheet | `app/workbench/page.tsx` | 0 own, 4 foreign | /suites board regions (streams 3, 4, 5) | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/workbench/workbench.css` | 117 | token alias layer + shell sheet | `app/workbench/movie/page.tsx`, `app/workbench/page.tsx`, `components/workspace/spec/tools/studio-css.ts` | 80 own, 6 foreign | board sheets beside their components (streams 3, 4, 5) | streams 3, 4, 5 (stage pages go) + D1 retire /workbench (lead) | Thu 8 Oct |
| `components/Compare.css` | 51 | screen sheet | `components/Compare.tsx` | 0 own, 4 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/DragLayer.css` | 5 | screen sheet | `components/DragLayer.tsx` | none | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/ElementScreen.css` | 214 | screen sheet | `components/ElementScreen.tsx` | 0 own, 20 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ImpactSheet.css` | 87 | screen sheet | `components/ImpactSheet.tsx` | 0 own, 18 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/PaneDivider.css` | 28 | screen sheet | `components/PaneDivider.tsx` | 0 own, 1 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/PreviewLayer.css` | 46 | screen sheet | `components/PreviewLayer.tsx` | 0 own, 1 foreign | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/PromptAttach.css` | 17 | screen sheet | `components/PromptAttach.tsx`, `components/graphite/production/use-agent-attachments.tsx` | none | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/ProvenanceCard.css` | 61 | screen sheet | `components/ProvenanceCard.tsx` | 0 own, 12 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/QueueStrip.css` | 18 | screen sheet | `components/QueueStrip.tsx` | 0 own, 7 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ShotBindings.css` | 358 | screen sheet | `components/ShotBindings.tsx` | 0 own, 24 foreign | none drawn | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/astra-blender/astra-blender.module.css` | 228 | module sheet | `components/astra-blender/AstraBlenderWorkspace.tsx`, `components/astra-blender/AstraViewport.tsx` | 8 own, 0 foreign | 3D blocking, a tool on a shot card (README 1.2); no stream plans it | UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/astra-integration.module.css` | 21 | module sheet | `components/astra-blender/AstraAgentPanel.tsx`, `components/astra-blender/AstraExportPanel.tsx`, `components/astra-blender/AstraNativeSourcePanel.tsx`, `components/astra-blender/AstraStudio.tsx` | 0 own, 2 foreign | 3D blocking, a tool on a shot card (README 1.2); no stream plans it | UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/astra-render.module.css` | 70 | module sheet | `components/astra-blender/AstraRenderPanel.tsx` | none | 3D blocking, a tool on a shot card (README 1.2); no stream plans it | UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/atomik/ModelPicker.module.css` | 116 | module sheet | `components/atomik/ModelPicker.tsx` | 0 own, 4 foreign | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/atomik/marketing-studio-entry.module.css` | 61 | module sheet | `components/atomik/MarketingStudioEntry.tsx` | 0 own, 6 foreign | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/atomik/skills/skills.module.css` | 106 | module sheet | `components/atomik/skills/ComposerSkills.tsx`, `components/atomik/skills/SkillForms.tsx` | none | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/atomik/threads/threads.module.css` | 83 | module sheet | `components/atomik/threads/ThreadSwitcher.tsx`, `components/atomik/threads/ThreadsPanel.tsx` | 0 own, 8 foreign | Atomik panel (stream 7) | stream 7 (Atomik) | Thu 8 Oct |
| `components/auth-mobile.css` | 129 | screen sheet | `components/AuthCard.tsx`, `components/WelcomeSignIn.tsx` | 1 own, 0 foreign | none drawn (sign-up page copy: stream 15, frames pending) | kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/commercial.css` | 435 | screen sheet | `app/(auth)/pricing/page.tsx`, `app/(auth)/signup/page.tsx` (until `site/guest-home`, which draws /signup on Graphite, decision 41) | 1 own, 0 foreign | none drawn (sign-up page copy: stream 15, frames pending) | kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/media-reach.css` | 267 | screen sheet | `components/commercial/MediaReach.tsx` | 1 own, 2 foreign | none drawn (sign-up page copy: stream 15, frames pending) | kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/graphite/atomik/skills-view.module.css` | 48 | module sheet | `components/graphite/atomik/SkillsView.tsx` | none | Approvals, Activity, Skills, Memory (stream 8) | stream 8 (control room) | Thu 8 Oct |
| `components/graphite/business/business-own.css` | 143 | screen sheet | `components/graphite/business/BusinessSuite.tsx` | 3 own, 0 foreign | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/business.css` | 85 | screen sheet | `app/suites/page.tsx` | none | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/crew/crew.css` | 119 | screen sheet | `app/suites/page.tsx` | none | Crew review panel inside boards (stream 7) | stream 7 (Atomik: Crew review, frame m) | Thu 8 Oct |
| `components/graphite/fault.css` | 94 | screen sheet | `components/graphite/FaultPage.tsx`, `components/graphite/PanelFault.tsx` | none | none drawn | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `components/graphite/phone.css` | 193 | screen sheet | `app/suites/page.tsx` | 3 own, 0 foreign | phone tabs Home, Record, Make, Atomik (stream 10) | stream 10 (phone) | Thu 8 Oct |
| `components/graphite/production/production.css` | 372 | screen sheet | `app/suites/page.tsx` | 2 own, 2 foreign | board sheets beside their components (streams 3, 4, 5) | streams 3, 4, 5 (the stage pages' sheet) | Thu 8 Oct |
| `components/graphite/shell.css` | 1440 | screen sheet | `app/(marketing)/site/layout.tsx`, `app/suites/page.tsx`, `components/graphite/FaultPage.tsx` | 4 own, 9 foreign | the new shell sheet (stream 1) | stream 1 (shell): rewrites it onto the new header; the marketing layout still imports it | Thu 8 Oct |
| `components/graphite/viral/viral.css` | 55 | screen sheet | `app/suites/page.tsx` | 1 own, 0 foreign | Make > Motion transfer, Object swap; Social board | stream 6 (Make quick tools) + stream 11 (Social history) | Thu 8 Oct |
| `components/make/gen.module.css` | 1781 | module sheet | `app/(app)/library/page.tsx`, `components/make/AstraUpscale.tsx`, `components/make/Composer.tsx`, `components/make/GenAssetLibrary.tsx`, `components/make/GenLoading.tsx`, `components/make/GenWorkspace.tsx`, `components/make/SeedanceEdit.tsx`, `components/make/TopazImageUpscale.tsx`, `components/make/UnfiledWall.tsx`, `components/workbench/ProjectAssetLibrary.tsx`, `components/workbench/ProjectLibraryPage.tsx` | 10 own, 0 foreign | Make panel (stream 6) | stream 6 (Make) | Thu 8 Oct |
| `components/make/seedance-edit.module.css` | 92 | module sheet | `components/make/AstraUpscale.tsx`, `components/make/SeedanceEdit.tsx`, `components/make/TopazImageUpscale.tsx` | 0 own, 6 foreign | Make panel (stream 6) | stream 6 (Make) | Thu 8 Oct |
| `components/management/account-security.module.css` | 2 | module sheet | `components/management/AccountSecurity.tsx`, `components/management/WorkspaceSecurity.tsx` | none | none drawn (sign-up page copy: stream 15, frames pending) | kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/management/management.css` | 975 | screen sheet | `components/management/ManagementPage.tsx` | 7 own, 0 foreign | Settings sections; Activity | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/workspace-audit.module.css` | 52 | module sheet | `components/management/WorkspaceAudit.tsx` | none | Settings sections; Activity | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/marketing/marketing.css` | 199 | screen sheet | `app/(marketing)/site/layout.tsx` | 1 own, 1 foreign | guest Home (stream 15, waits for the owner's frames) | stream 15 (copy now; old homepage retires when guest Home is live); its `.mk-hero*` and `.mk-prompt*` rules go with the homepage in `site/guest-home-on` | Thu 8 Oct |
| `components/pipeline/pipeline.module.css` | 576 | module sheet | `components/pipeline/PipelineBuilder.tsx`, `components/pipeline/PipelineRun.tsx`, `components/pipeline/PipelineWorkspace.tsx`, `components/suites/AtomikSuite.tsx` | 16 own, 0 foreign | Control room > Activity (stream 8) | stream 8 (Activity) | Thu 8 Oct |
| `components/studio/project-navigation.css` | 20 | screen sheet | `app/workbench/page.tsx`, `components/studio/ProjectStudioHeader.tsx` | none | /suites | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/studio/projects-library.css` | 392 | screen sheet | `app/(app)/library/page.tsx`, `app/(app)/productions/page.tsx` | none | Home projects, the board | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `components/studio/studio-navigation.css` | 93 | screen sheet | `components/studio/StudioNavigation.tsx` | 0 own, 1 foreign | /suites | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/suites/atomik-generate.module.css` | 66 | module sheet | `components/suites/AtomikVoiceTools.tsx`, `components/suites/ConsumerShorts.tsx` | none | none: nothing imports it and no route reaches it | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/suites/atomik-suite.module.css` | 519 | module sheet | `components/suites/AtomikSuite.tsx` | 17 own, 1 foreign | Approvals, Activity, Skills, Memory (stream 8) | stream 8 (control room) | Thu 8 Oct |
| `components/suites/consumer-marketing-video.module.css` | 24 | module sheet | `components/suites/ConsumerMarketingVideo.tsx` | none | none: nothing imports it and no route reaches it | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/suites/four-suites.css` | 910 | screen sheet | `app/layout.tsx`, `app/workbench/page.tsx` | 1 own, 1 foreign | none: the four-suite workspace look is the old design | flip PR, then D1 (lead): imported by app/layout.tsx for every page | Thu 8 Oct (needs the owner's yes) |
| `components/suites/marketing-presets.module.css` | 147 | module sheet | `components/suites/MarketingPresets.tsx` | none | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/marketing-templates.module.css` | 54 | module sheet | `components/suites/MarketingTemplates.tsx` | none | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/moleculr-creative.module.css` | 375 | module sheet | `components/suites/BrandImport.tsx`, `components/suites/BrandKitEditor.tsx`, `components/suites/CreativeTemplateBrowser.tsx`, `components/suites/MoleculrWorkspace.tsx`, `components/suites/ProductProfileEditor.tsx` | none | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/poster-designer.module.css` | 2 | module sheet | `components/suites/PosterDesigner.tsx` | 0 own, 1 foreign | Ads and Social boards (stream 11) | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/subatomik.module.css` | 99 | module sheet | `components/suites/ReferenceImagePreview.tsx`, `components/suites/SubatomikWorkspace.tsx`, `components/suites/SyncedVideoComparison.tsx` | 1 own, 1 foreign | Social board; Make > Motion transfer, Object swap | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/suite-agent.module.css` | 11 | module sheet | `components/suites/SuiteAgentPanel.tsx` | none | Atomik panel (stream 7) | stream 7 (Atomik) | Thu 8 Oct |
| `components/suites/suite-navigation.css` | 402 | screen sheet | `components/suites/SuiteNavigation.tsx` | 0 own, 2 foreign | /suites | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/switchover/switchover.css` | 58 | screen sheet | `components/switchover/SwitchoverGate.tsx` | none | /suites | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/upload-recovery.module.css` | 100 | module sheet | `components/UploadRecovery.tsx` | none | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/workbench/MarketingStudioPanel.module.css` | 342 | module sheet | `components/workbench/MarketingStudioPanel.tsx`, `components/workbench/Studio.tsx` | 0 own, 6 foreign | /suites board regions (streams 3, 4, 5) | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/SequenceColor.module.css` | 126 | module sheet | `components/workbench/SequenceColor.tsx`, `components/workbench/Studio.tsx` | none | /suites board regions (streams 3, 4, 5) | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/SoundGenerate.module.css` | 189 | module sheet | `components/workbench/SoundGenerate.tsx` | none | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/SoundMix.module.css` | 223 | module sheet | `components/workbench/SequenceColor.tsx`, `components/workbench/SoundMix.tsx` | none | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/action-menu.module.css` | 127 | module sheet | `components/workbench/ActionMenu.tsx` | 0 own, 4 foreign | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/canvas-selection.module.css` | 149 | module sheet | `components/workbench/production-graph.tsx` | 0 own, 5 foreign | /suites board regions (streams 3, 4, 5) | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/development-panel.module.css` | 77 | module sheet | `components/workbench/DevelopmentPanel.tsx` | none | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/editorial.module.css` | 192 | module sheet | `components/workbench/AssetBins.tsx`, `components/workbench/EditVersions.tsx` | 2 own, 2 foreign | /suites board regions (streams 3, 4, 5) | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/project-asset-library.module.css` | 22 | module sheet | `components/workbench/ProjectAssetLibrary.tsx`, `components/workbench/ProjectLibraryPage.tsx` | 0 own, 8 foreign | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/script-panel.module.css` | 410 | module sheet | `components/workbench/ScreenplayOcrReview.tsx`, `components/workbench/ScriptPanel.tsx` | none | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/soul-identity-panel.module.css` | 56 | module sheet | `components/workbench/SoulIdentityPanel.tsx` | 0 own, 7 foreign | none drawn: the handoff opens the existing editor/tool as it is (README 3: Cut > Open Edit & Sound) | UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workspace/mobile/mobile.css` | 1656 | screen sheet | `app/workspace/page.tsx` | 0 own, 54 foreign | phone screens (stream 10) | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/pages/assets.css` | 188 | screen sheet | `components/workspace/mobile/pages/CardsPages.tsx`, `components/workspace/mobile/pages/FormPage.tsx`, `components/workspace/pages/CastPage.tsx`, `components/workspace/pages/EditPage.tsx`, `components/workspace/pages/TakesPage.tsx` | 0 own, 26 foreign | Shots, Cast, Cut regions (stream 5) | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/rig/rig-verify.css` | 78 | screen sheet | `components/workspace/rig/RigVerify.tsx` | 0 own, 12 foreign | - | kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/workspace/rig/rig.css` | 425 | screen sheet | `components/workspace/rig/RigCardInspector.tsx`, `components/workspace/rig/RigImport.tsx`, `components/workspace/rig/RigInspector.tsx`, `components/workspace/rig/RigPage.tsx` | 0 own, 36 foreign | the board, `?view=board` (stream 3) | stream 3 (board canvas) | Thu 8 Oct |
| `components/workspace/workspace.css` | 843 | token alias layer + shell sheet | `app/suites/page.tsx`, `app/workspace/page.tsx` | 71 own, 0 foreign | /suites: Home, board, Settings (streams 2, 3, 9); phone: stream 10 | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |

Notes on specific sheets:

- The three #528 renamed: `app/workbench/phone-layout.css` (was the mobile hand-off sheet), `app/workbench/phone-stages.css`, `components/studio/projects-library.css`. They are renamed, not replaced: the screens they style (the `/workbench` phone shell, the `/library` and `/productions` pages) are deleted by the rows above.
- `app/workbench/project-first.css` (29 lines) and `app/workbench/editorial-graphite.css` (419) are the `/workbench` Studio's project-first and editorial layouts. `app/workbench/graphite.css` (326) is its Graphite re-skin. All three go with the stage pages and the Studio board (streams 3, 4, 5); `studio-css.ts` loads them for `/suites` stage pages, so stream 1 removes that import in the same PR.
- `components/graphite/shell.css` (1,439 lines) is imported by the marketing layout (`app/(marketing)/site/layout.tsx`) and `FaultPage` as well as `/suites`. Stream 1 rewrites it onto the new header; stream 15 must not lose the marketing layout's styles in the process (rule: no live page broken or unstyled).
- `components/suites/four-suites.css` (909) is imported by `app/layout.tsx`, so it loads on every page. Deleting it is an edit to the root layout: the flip PR, with the lead.
- Inside `app/graphite.css` (the kept token set): the "Older names" `--graphite-*` alias block (22 names, deleted with the last old sheet that reads them), the `--gx-suite-business`, `--gx-suite-viral` and `--gx-suite-crew` dots (old suite structure), `--gx-w-library: 280px` and `--gx-w-inspector: 320px` and `--gx-h-strip: 46px` (the fixed columns and page strip the new design removes; the master Inspector is 340). Stream 1 owns the cleanup, Thu 8 Oct. The guard allows the token set to change; it does not check these names.
- Sheets for `@xyflow/react` (stream 3, `deps/react-flow`) are not tracked here: they come from the package.

## 3. Copy: the old structure in UI text

Counted by `tests/helpers/uiStrings.ts`: JSX text and user-visible string literals in `components/`, `app/` (including API messages) and `lib/shell/`, never comments, identifiers or comparisons. Words: Moleculr, Subatomik, Rig, Genjutsu, Soul, Higgsfield, and Astra unless the same string says Topaz; phrases: Five suites, Four suites, Production Studio, Business Suite, Viral Studio, Opens in Gen, Open in Gen. The checked-in baseline is the table below; it only goes down.

**Baseline: 56 files, 174 occurrences** (Rig 65, Astra 49, Moleculr 13, Subatomik 11, Production Studio 8, Viral Studio 10, Business Suite 7, Five suites 3, Genjutsu 3, Open(s) in Gen 3, Four suites 1, Higgsfield 1, Soul 0). Outside the guard's scope there are 117 more in 44 `lib/` files (`lib/workspace`, `lib/workbench`, `lib/astra-blender`, `lib/suites.ts`, `lib/vendorNames.ts` and others, no owner: §9).

`site/copy-names` (stream 15, step 1; commits `0e242056`, `f53f4605`) rewrites the marketing copy. Measured by running the same scanner on that branch, it takes 8 files from 30 occurrences to 0: the five suite pages, `app/(marketing)/site/layout.tsx`, `components/marketing/HeroPrompt.tsx` and `SharedBottom.tsx`. That includes "Five suites in one shell: Gen, the Production Studio, the Business Suite, the Viral Studio…" (`gen/index.tsx` and the layout description) and "Opens in Gen" (`HeroPrompt.tsx`). It leaves 144 occurrences in 48 files. When it merges, run the baseline update to lower those eight entries.

| File | Occurrences | Words | Example (first hit) | Fixed by | Target |
|---|---|---|---|---|---|
| `app/(app)/productions/[prod]/[project]/shots/page.tsx` | 1 | Rig 1 | Open in Rig | goes with the file: stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `app/(app)/productions/page.tsx` | 1 | Rig 1 | Rig · assets | goes with the file: stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `app/(app)/rig/canvas/[boardId]/page.tsx` | 8 | Rig 8 | Reload this page in the intended account and workspace before opening  | goes with the file: stream 3 (board canvas) | Thu 8 Oct |
| `app/(app)/rig/recipes/[projectId]/page.tsx` | 1 | Rig 1 | Sign in to open the Rig. | goes with the file: stream 3 (board canvas) | Thu 8 Oct |
| `app/(app)/subatomik/page.tsx` | 4 | Subatomik 2, Viral Studio 2 | Subatomik Viral Studio · Particl | goes with the file: stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `app/(marketing)/site/_pages/atomik/index.tsx` | 2 | Rig 2 | Plain-language planning against the saved project and the references y | `site/copy-names` (stream 15) | merge of that PR |
| `app/(marketing)/site/_pages/business/index.tsx` | 6 | Business Suite 3, Moleculr 2, Rig 1 | Business Suite | `site/copy-names` (stream 15) | merge of that PR |
| `app/(marketing)/site/_pages/gen/index.tsx` | 4 | Five suites 1, Production Studio 1, Business Suite 1, Viral Studio 1 | Five suites in one shell: Gen, the Production Studio, the Business Sui | `site/copy-names` (stream 15) | merge of that PR |
| `app/(marketing)/site/_pages/studio/index.tsx` | 10 | Rig 6, Production Studio 3, Astra 1 | Production Studio | `site/copy-names` (stream 15) | merge of that PR |
| `app/(marketing)/site/_pages/viral/index.tsx` | 4 | Viral Studio 3, Subatomik 1 | Viral Studio | `site/copy-names` (stream 15) | merge of that PR |
| `app/(marketing)/site/layout.tsx` | 1 | Five suites 1 | The studio's own room for making shots. Five suites in one shell. | `site/copy-names` (stream 15) | merge of that PR |
| `app/layout.tsx` | 1 | Production Studio 1 | Particl Production Studio | stream 1 / lead: the home-screen app title says "Particl Production Studio" | Thu 8 Oct |
| `app/workbench/page.tsx` | 1 | Production Studio 1 | Particl — Production Studio | goes with the file: flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/ElementScreen.tsx` | 1 | Rig 1 | Rig | goes with the file; UNOWNED (§9): old app route with no replacement | Thu 8 Oct |
| `components/ProductionNav.tsx` | 1 | Rig 1 | Rig | goes with the file; UNOWNED (§9): old app route with no replacement | Thu 8 Oct |
| `components/ShotBindings.tsx` | 1 | Rig 1 | Rig | goes with the file; UNOWNED (§9): old app route with no replacement | Thu 8 Oct |
| `components/assets/NewAssetSheet.tsx` | 6 | Rig 6 | Rig · Canvas | goes with the file: stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |
| `components/astra-blender/AstraAgentPanel.tsx` | 15 | Astra 15 | Astra | goes with the file; UNOWNED (§9): Astra Blender workspace (3D) | Thu 8 Oct |
| `components/astra-blender/AstraBlenderWorkspace.tsx` | 7 | Astra 7 | Astra | goes with the file; UNOWNED (§9): Astra Blender workspace (3D) | Thu 8 Oct |
| `components/astra-blender/AstraStudio.tsx` | 3 | Astra 3 | Astra | goes with the file; UNOWNED (§9): Astra Blender workspace (3D) | Thu 8 Oct |
| `components/atomik/MarketingStudioEntry.tsx` | 3 | Moleculr 3 | Open Moleculr | goes with the file: stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/NextActionPanel.tsx` | 1 | Astra 1 | Astra chooses the output size, usually 4K, and keeps the clip’s length | stream 5: say "Topaz upscale" | Thu 8 Oct |
| `components/graphite/SuitesShell.tsx` | 3 | Rig 3 | Open the Rig to delete a shot. | stream 1 (rebuilt in place) | Thu 8 Oct |
| `components/graphite/business/FormatTool.tsx` | 1 | Open in Gen 1 | Open in Gen | goes with the file: stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/crew/CrewView.tsx` | 4 | Rig 3, Open in Gen 1 | A draft shot on the Rig | goes with the file: stream 7 (Atomik: Crew review, frame m) | Thu 8 Oct |
| `components/graphite/mobile/StudioHome.tsx` | 1 | Rig 1 | Open in Rig | goes with the file: stream 2 (Home) + stream 10 (phone Home) | Thu 8 Oct |
| `components/graphite/production/RigExtras.tsx` | 1 | Rig 1 | Rig library | goes with the file: stream 3 (board canvas) | Thu 8 Oct |
| `components/graphite/production/TimelineCut.tsx` | 1 | Rig 1 | No takes yet — render them in Storyboards, Cast, Rig or Edit. | goes with the file: stream 5 (cards 2) | Thu 8 Oct |
| `components/make/AstraUpscale.tsx` | 10 | Astra 10 | Choose a video for Astra upscale. | stream 6 (Make): say "Topaz upscale"; the file is the Topaz Astra upscale form | Thu 8 Oct |
| `components/management/OpenAIConnection.tsx` | 2 | Astra 2 | Astra appears in this key’s model catalogue. | stream 9 (Settings > Advanced): the model-catalogue note | Thu 8 Oct |
| `components/marketing/HeroPrompt.tsx` | 1 | Opens in Gen 1 | Opens in Gen | `site/copy-names` (stream 15) | merge of that PR |
| `components/marketing/SharedBottom.tsx` | 2 | Five suites 1, Rig 1 | Five suites · one workspace · one shell | `site/copy-names` (stream 15) | merge of that PR |
| `components/rig/RigBar.tsx` | 2 | Rig 2 | Rig | goes with the file: stream 3 (board canvas) | Thu 8 Oct |
| `components/suites/CreativeTemplateBrowser.tsx` | 2 | Moleculr 2 | Moleculr originals | goes with the file: stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MarketingPresets.tsx` | 1 | Moleculr 1 | Render your creative direction, or use an available Ads preset. Provid | goes with the file: stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MarketingStudioFlow.tsx` | 4 | Rig 3, Moleculr 1 | Rendered poster · editable layers retained in Moleculr Design | goes with the file: stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MoleculrWorkspace.tsx` | 3 | Moleculr 1, Business Suite 1, Rig 1 | Moleculr Business Suite / | goes with the file: stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/SubatomikWorkspace.tsx` | 9 | Subatomik 6, Viral Studio 2, Rig 1 | Subatomik Viral Studio | goes with the file: stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/SuiteAgentPanel.tsx` | 2 | Rig 2 | Added to Rig | goes with the file: stream 7 (Atomik) | Thu 8 Oct |
| `components/suites/SuiteHome.tsx` | 1 | Four suites 1 | Four suites. One connected workspace. | goes with the file: stream 2 (Home) | Thu 8 Oct |
| `components/workbench/AtomikRunDialog.tsx` | 1 | Astra 1 | Build with Astra | UNOWNED: "Build with Astra" (3D blocking tool) | Thu 8 Oct |
| `components/workbench/Studio.tsx` | 6 | Astra 3, Rig 2, Moleculr 1 | Opening Astra… | goes with the file: flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/inspector/CastInspector.tsx` | 1 | Rig 1 | Use in Rig | goes with the file: stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/pages/registry.tsx` | 1 | Rig 1 | Shots blocked in the 3D runtime and exported back to Rig as a layout. | goes with the file: stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/rig/RigProvider.tsx` | 2 | Rig 2 | {} is back in the Rig | stream 3 (the board's data layer stays; two toasts reword) | Thu 8 Oct |
| `components/workspace/rig/use-team-canvas.ts` | 1 | Rig 1 | Your last Rig edit did not reach the team, and the team's version repl | stream 3 (one message rewords) | Thu 8 Oct |
| `components/workspace/spec/tools/AstraTool.tsx` | 1 | Astra 1 | Astra | goes with the file; UNOWNED (§9): Astra 3D stage tool | Thu 8 Oct |
| `lib/shell/confirmations.ts` | 3 | Rig 3 | Added to Rig · {} | stream 3 ("Added to Rig" confirmations; reword to Board) | Thu 8 Oct |
| `lib/shell/enhancer.ts` | 1 | Higgsfield 1 | You rewrite a rough idea into ONE concrete generation prompt. These ar | stream 6 (the prompt enhancer's system prompt names the vendor; not shown to people, but counted) | Thu 8 Oct |
| `lib/shell/ia.ts` | 16 | Production Studio 2, Astra 2, Rig 2, Moleculr 2, Business Suite 2, Subatomik 2, Viral Studio 2, Genjutsu 2 | Particl Production Studio | stream 1 (rewritten from README section 1) | Thu 8 Oct |
| `lib/shell/production-tools.ts` | 1 | Rig 1 | Download · Send to Rig | stream 5 ("Send to Rig") | Thu 8 Oct |
| `lib/shell/studio-home.ts` | 1 | Genjutsu 1 | Genjutsu: motion transfer, object swap. | stream 2 (the file goes with the old Studio overview) | Thu 8 Oct |
| `lib/shell/tools-connections.ts` | 2 | Astra 2 | Astra 3D | stream 9 (Settings: Advanced > Tools; "Astra 3D" becomes 3D blocking) | Thu 8 Oct |

Marketing copy that the scanner cannot see: the five marketing screenshots carry the old product's names inside the picture (§8); `public/campaign/*.webp` and the seed names in `lib/workbench/studio.ts` are placeholder-name material (brief rule 9), owned by streams 12 and 15.

## 4. Old shells: routes

**The old homepage (owner, decision 41; dated Thu 8 Oct).** `/` signed out today is the Gen page (`app/(marketing)/site/_pages/gen/index.tsx`), its hero prompt (`components/marketing/HeroPrompt.tsx`), its copy, its `.mk-hero*` and `.mk-prompt*` rules in `components/marketing/marketing.css` and its screenshot `public/marketing/screens/gen-composer-blank.jpg`. All of it is deleted in the same step as turning Guest Home on: stream 15's follow-up PR `site/guest-home-on` (stacked on `site/guest-home`) deletes them and makes Guest Home the only `/` for a signed-out visitor; it merges when the owner turns Guest Home on. /pricing and the other `/site/*` pages stay. Target: Thu 8 Oct.

From `docs/old-shells.md`, which this inventory supersedes as the deletion list. Three shells still serve routes: `/workspace`, `/workbench` and the pages under `app/(app)/`; the live `/suites` shell is the 3 October build (`components/graphite/`) that the D0 PRs and stream 1 rebuild. "Imported by" for a route is the Next.js router; the components a route renders are in §6.

| Route | Entry file | Kind | Replacement screen | Deleting PR or stream | Target |
|---|---|---|---|---|---|
| `/workspace` | `app/workspace/page.tsx` | shell | /suites: Home, board, Settings; phone: stream 10 | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `/workbench` | `app/workbench/page.tsx` | shell | board regions: `?stage=X` maps to `&region=` (stream 1 table); Marketing Studio to the Ads board | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `/workbench/movie` | `app/workbench/movie/page.tsx` | screen | Deliver card (stream 5). The `?snapshot=` hand-off from pipeline runs (`lib/workbench/movie-handoff.ts`) still opens this route: no stream owns it | UNOWNED | Thu 8 Oct |
| `/` | `app/(app)/page.tsx` | screen | Home `?view=home` (stream 2) | stream 2 (Home) | Thu 8 Oct |
| `/atomik` | `app/(app)/atomik/page.tsx` | screen | Control room + panel (streams 7, 8) | stream 7 / stream 8 (Atomik) | Thu 8 Oct |
| `/subatomik, /subatomic` | `app/(app)/subatomik/page.tsx` | screen | Social board (stream 11); Make > Motion transfer, Object swap (stream 6) | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `/generate, /images, /audio, /make/[kind]` | `app/(app)/generate/page.tsx` | screen + redirects | Make panel (stream 6); the redirects become `&make=` links | stream 6 (Make) | Thu 8 Oct |
| `/studio/shot` | `app/(app)/studio/shot/page.tsx` | screen | none drawn (the shot builder hands off to /generate) | UNOWNED: no frame draws this route | Thu 8 Oct |
| `/library, /all` | `app/(app)/library/page.tsx` | screen | Library drawer (stream 3), Make > Recent (stream 6) | stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |
| `/productions` | `app/(app)/productions/page.tsx` | screen | Home: projects as cards (stream 2) | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `/productions/[prod]/[project]/media, /shots` | `app/(app)/productions/[prod]/[project]/media/page.tsx` | screen | the board: Shots region, Library drawer (streams 3, 5) | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `/projects/[id], /projects/[id]/canvas, /projects/[id]/rig/elements, /canvas/[id]` | `app/(app)/projects/[id]/page.tsx` | screen | none drawn (per-project cost overview, sequence wall, element versions); nearest: Project record (frame n, stream 7), Activity (stream 8), Cast region (stream 5) | UNOWNED: no frame draws this route | Thu 8 Oct |
| `/rig/canvas/[boardId], /rig/recipes/[projectId], /rig/run/[runId]` | `app/(app)/rig/canvas/[boardId]/page.tsx` | screen | the board (stream 3); runs: Activity (stream 8); recipes: none drawn | stream 3 (board canvas) | Thu 8 Oct |
| `/pipelines` | `app/(app)/pipelines/page.tsx` | screen | Control room > Activity (stream 8) | stream 8 (Activity) | Thu 8 Oct |
| `/takes/[id], /shots/[id], /elements/[id]` | `app/(app)/takes/[id]/page.tsx` | screen | none drawn (provenance card, shot bindings, element screen); nearest: take card and Inspector (stream 5) | UNOWNED: no frame draws this route | Thu 8 Oct |
| `/atomik/ideas, /treatment, /breakdown, /shots` | `app/(app)/atomik/ideas/page.tsx` | screen | none drawn; nearest: Brief and Storyboard regions (stream 4) | UNOWNED: no frame draws this route | Thu 8 Oct |
| `/settings, /team, /usage, /dashboard, /connect` | `app/(app)/settings/page.tsx` | screen | Settings sections (stream 9); /dashboard: Activity (stream 8) | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `/statements/[month]` | `app/(app)/statements/[month]/page.tsx` | floor | none drawn (printable statement) | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `/admin, /platform, /report` | `app/(app)/admin/page.tsx` | floor | none drawn | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `/policy, /privacy, /terms` | `app/(app)/policy/page.tsx` | floor | none drawn (public pages) | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `/review/[token]` | `app/review/[token]/page.tsx` | floor | none drawn (client review link) | kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `/login, /welcome, /signup, /reset, /invite/[code], /setup, /account/security, /billing, /pricing` | `app/(auth)/login/page.tsx` | floor | none drawn; sign-up copy: stream 15 (frames pending) | kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `/` signed out: the old homepage (Gen page, its hero prompt) | `app/(marketing)/site/_pages/gen/index.tsx` | floor | Guest Home (design README § 3.7; `site/guest-home`, behind the /admin "Guest Home" setting) | stream 15: deleted with its copy and styles by `site/guest-home-on`, merged in the same step as turning Guest Home on (owner, decision 41) | Thu 8 Oct |
| `/site/*: Studio, Business, Viral, Atomik, Workspace, Pricing` | `app/(marketing)/site/[[...slug]]/page.tsx` | floor | guest Home (stream 15, waits for the owner's frames); copy now: `site/copy-names` | stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |

The redirect pages (`/images`, `/audio`, `/make/[kind]`, `/all`, `/canvas/[id]`, `/dashboard`, `/subatomic`, `/rig/run/[runId]`) stay as one-line redirects to the new URLs until the flip; they carry no design.

### 4b. The live `/suites` shell's own pages

`/suites` is the 3 October Graphite build. With the switch on, README § 1.2 replaces its pages. They are in `lib/shell/ia.ts` (`SHELL_SUITES`, `HEADER_SEGMENT`, `WORKSPACE_TABS`), which is replaced by README § 1 (stream 1).

| Pages (query form) | Component | Replacement | Deleting PR or stream | Target |
|---|---|---|---|---|
| ~~Studio: Brief, Beats, Storyboards, Environment, Cast, Astra 3D, Rig, Takes, Edit & Sound, Deliver~~ (`page=brief`, `sp=beats`, `page=boards`, `sp=environment`, `page=cast`, `astra`, `rig`, `takes`, `edit`, `deliver`) | `production/{Brief,Beats,Storyboard,Environment,Cast,Edit}Stage`, `BeatGraph`, `AstraOutputs`, `StageView`, the Rig library | the board's regions (table in `lib/shell/stage-redirects.ts`) | **DELETED by the board PR, 6 Oct** (owner decision 42): every address redirects to its region, for every workspace. Left in the repo on purpose, unmounted: `spec/tools/AstraTool` and `astra-blender/*` (3D blocking has no card yet), `RigPage` and friends (the old `/workspace` shell still mounts them) | done |
| Studio overview and the phone's "Where to?" (`sp=stages`, `sp=home`) | `mobile/StudioHome`, `mobile/SuiteHome` | Home; phone Home and Record | streams 2 and 10 | Thu 8 Oct |
| Business, 8 pages (`suite=business`) | `business/*`, `suites/MoleculrWorkspace` | Ads board | stream 11 | Thu 8 Oct |
| Viral, 3 pages (`suite=viral`) | `viral/ViralView`, `suites/SubatomikWorkspace` | Make quick tools; Social board; Make > Recent | streams 6 and 11 | Thu 8 Oct |
| Atomik, 8 pages (`suite=atomik`) | `suites/AtomikSuite`, `atomik/*View`, `ToolsView` | Atomik panel; Approvals, Activity, Skills, Memory; Settings | streams 7, 8, 9 | Thu 8 Oct |
| Workspace, 7 tabs (`view=workspace`) | `WorkspaceView`, `UsageLedger`, `ManagementDashboard` | Settings (five sections), Activity | streams 8 and 9 | Thu 8 Oct |
| Crew, 3 pages (`view=crew`) | `crew/CrewView` | Crew review (frame m), Project record (frame n) | stream 7 | Thu 8 Oct |
| Gen (`view=gen`) | `GenView`, `ModelSheet` | Make panel | stream 6 | Thu 8 Oct |

## 5. Old structure in lib

Code that encodes the old information architecture, as opposed to data logic the new screens reuse.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `lib/shell/ia.ts` | IA (suites, pages, header segment, workspace tabs) | `app/(marketing)/site/_pages/workspace/index.tsx`, `components/graphite/FaultPage.tsx`, `components/graphite/Header.tsx` +19 | stream 1: replaced by README § 1; the redirect table keeps the old links | Thu 8 Oct |
| `lib/shell/studio-home.ts` | Studio overview model | `components/graphite/FirstRun.tsx`, `components/graphite/mobile/StudioHome.tsx`, `components/graphite/mobile/SuiteHome.tsx` +3 | stream 2 (flip PR deletes it) | Thu 8 Oct |
| `lib/shell/atomik-sheet.ts` | page-plan sheet model | `components/graphite/AtomikSheet.tsx`, `tests/unit/suitesShellAudit.spec.ts` | stream 7 | Thu 8 Oct |
| `lib/shell/workspace-view.ts` | Workspace tabs model | `components/graphite/WorkspaceView.tsx`, `tests/unit/creditsOut.spec.ts`, `tests/unit/suitesWorkspaceView.spec.ts` | stream 9 | Thu 8 Oct |
| `lib/shell/tools-connections.ts` | Tools & connections page model | `components/graphite/atomik/ToolsView.tsx`, `tests/unit/toolsConnections.spec.ts` | stream 9 | Thu 8 Oct |
| `lib/shell/palette.ts` | old ⌘K index (suites, stage pages, Crew pages) | `components/graphite/Palette.tsx`, `tests/unit/suitesShell.spec.ts` | stream 7 | Thu 8 Oct |
| `lib/shell/business.ts` | Business page helpers (the connected-account half was retired 2 Oct) | `components/graphite/business/BusinessView.tsx`, `lib/higgsfield-consumer/marketing-records.ts`, `lib/higgsfield-consumer/marketing-setup.ts` +7 | stream 11 | Thu 8 Oct |
| `lib/shell/business-own.ts` | Business own-tools model | `components/graphite/PageHead.tsx`, `components/graphite/business/BrandTool.tsx`, `components/graphite/business/BusinessOwnView.tsx` +8 | stream 11 | Thu 8 Oct |
| `lib/shell/image-ads.ts` | image-ads page model | `components/graphite/business/BusinessView.tsx`, `components/graphite/business/PresetPicker.tsx`, `lib/shell/use-marketing-presets.ts` +3 | stream 11 | Thu 8 Oct |
| `lib/shell/use-business.ts` | hook with no importer but one test | `tests/unit/pollBackoff.spec.ts` | stream 11 cleanup | Thu 8 Oct |
| `lib/shell/viral.ts` | Viral pages model | `components/graphite/mobile/SuiteHome.tsx`, `components/graphite/viral/ViralView.tsx`, `tests/unit/generateSubmit.spec.ts` +3 | streams 6 and 11 | Thu 8 Oct |
| `lib/shell/workflows.ts` | Generate workflows model (feature retired 28 Sep) | `components/graphite/tools/WorkflowHost.tsx`, `tests/unit/suitesWorkflows.spec.ts` | orphan sweep | Tue 6 Oct |
| `lib/shell/use-connected-job.ts` | retired sign-in feature hook | `tests/unit/pollBackoff.spec.ts`, `tests/unit/suitesShellAudit.spec.ts` | orphan sweep | Tue 6 Oct |
| `lib/suites.ts` | old suite registry (Gen, Studio, Business, Viral, Atomik) | `app/(app)/subatomic/page.tsx`, `components/atomik/MarketingStudioEntry.tsx`, `components/graphite/PageHead.tsx` +29 | stream 1 | Thu 8 Oct |
| `lib/nav.ts` | old top-bar navigation, no importer | none | orphan sweep | Tue 6 Oct |
| `lib/shortcuts.ts` | old shortcut list, no importer | none | orphan sweep | Tue 6 Oct |
| `lib/genRoute.ts` | `/generate?mode=` links | `app/(app)/audio/page.tsx`, `app/(app)/images/page.tsx`, `app/(app)/make/[kind]/page.tsx` | stream 6 | Thu 8 Oct |
| `lib/workspace/switchover.ts` | old-shell redirects | `components/switchover/DeviceProbe.tsx`, `components/switchover/SwitchoverGate.tsx`, `components/workspace/AccountMenu.tsx` +7 | flip PR / D1 | Thu 8 Oct |
| `lib/workspace/switchover.server.ts` | old-shell redirects | `app/(app)/atomik/page.tsx`, `app/(app)/page.tsx`, `app/(app)/subatomik/page.tsx` +1 | flip PR / D1 | Thu 8 Oct |
| `tests/helpers/legacyShell.ts` | test helper that opens the old shell (used in 56 specs) | 56 specs | flip PR / D1, with the old-shell specs | Thu 8 Oct |

## 6. Source files of old screens

Every component and route file under `components/` and `app/` (API routes excluded) is classified. Files marked as data layer are not designs and are not listed; their strings are covered by §3.

### 6a. To delete

#### ORPHAN: dead code from an older design (26)

Replacement: none: nothing imports it and no route reaches it. Deleting: orphan sweep (small PR, lead to assign). Target: Tue 6 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/Canvas.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/Cast.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/CreditStrip.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/ElementSheet.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/GenGrid.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/ModeSwitch.tsx` | component | `components/TopBar.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/Panel.tsx` | component | `components/WorkspaceSettings.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/Review.tsx` | component | `components/Theatre.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/Runway.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/SectionNav.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/Studio.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/Theatre.tsx` | component | `components/GenGrid.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/TopBar.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/WorkspaceSettings.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/graphite/DeveloperApiRow.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/graphite/tools/WorkflowHost.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/management/ConsumerVideoVerification.tsx` | component | `components/management/HiggsfieldConsumerConnection.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/management/HiggsfieldConsumerConnection.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/shell/AccountMenu.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/shell/AtomikButton.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/studio/ProjectStudioHeader.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/suites/AtomikVoiceTools.tsx` | component | `components/graphite/tools/WorkflowHost.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/suites/ConsumerMarketingVideo.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/suites/ConsumerShorts.tsx` | component | `components/workspace/pages/ShortsPage.tsx` | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/workspace/mobile/pages/FormPage.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |
| `components/workspace/pages/ShortsPage.tsx` | component | none | orphan sweep (small PR, lead to assign) | Tue 6 Oct |

#### S_STRIP: 46 px page strip, gone in README 1 (4)

Replacement: the board outline rail (stream 3). Deleting: stream 1 / stream 3 (page strip goes). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/PageHead.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 1 / stream 3 (page strip goes) | Thu 8 Oct |
| `components/graphite/ProjectHead.tsx` | component | `components/graphite/FirstRun.tsx`, `components/graphite/SuitesShell.tsx` | stream 1 / stream 3 (page strip goes) | Thu 8 Oct |
| `components/graphite/StageStrip.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 1 / stream 3 (page strip goes) | Thu 8 Oct |

#### S_HOME: Studio overview / phone Where to? (3)

Replacement: Home `?view=home` (stream 2); phone Home (stream 10). Deleting: stream 2 (Home) + stream 10 (phone Home). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/FirstRun.tsx` | component | `components/graphite/SuitesShell.tsx`, `components/graphite/mobile/StudioHome.tsx` | stream 2 (Home) + stream 10 (phone Home) | Thu 8 Oct |
| `components/graphite/mobile/StudioHome.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 2 (Home) + stream 10 (phone Home) | Thu 8 Oct |
| `components/graphite/mobile/SuiteHome.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 2 (Home) + stream 10 (phone Home) | Thu 8 Oct |

#### S_TABBAR: old phone tab bar (1)

Replacement: phone tabs Home, Record, Make, Atomik (stream 10). Deleting: stream 10 (phone). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/TabBar.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 10 (phone) | Thu 8 Oct |

#### S_BRIEF: Studio stage pages 1-3 (5)

Replacement: Brief, Looks, Storyboard regions (stream 4). Deleting: stream 4 (cards 1). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/FilmVocabulary.tsx` | component | `components/graphite/GenView.tsx` | stream 4 (cards 1) | Thu 8 Oct |

#### S_CAST: Studio stage pages (6)

Replacement: Cast, Shots, Cut, Deliver (stream 5). Deleting: stream 5 (cards 2). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/production/CastIdentities.tsx` | component | `components/graphite/board/inspector/CastBody.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/production/TimelineCut.tsx` | component | `components/workspace/pages/EditPage.tsx` | stream 5 (cards 2) | Thu 8 Oct |

#### S_TAKES: old take tiles and Inspector (9)

Replacement: board Inspector, take card, review mode (stream 5). Deleting: stream 5 (cards 2). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/AssetInspector.tsx` | component | `components/graphite/Inspector.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/AssetLinkCard.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/AssetNextActions.tsx` | component | `components/graphite/AssetInspector.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/DraftFinal.tsx` | component | `components/graphite/AssetInspector.tsx`, `components/graphite/GenView.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/Inspector.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/NextActionPanel.tsx` | component | `components/graphite/AssetNextActions.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/ReleaseTake.tsx` | component | `components/graphite/AssetInspector.tsx`, `components/graphite/TakeTile.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/TakeStrip.tsx` | component | `components/graphite/DraftFinal.tsx`, `components/graphite/GenView.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/graphite/TakeTile.tsx` | component | `components/graphite/AssetInspector.tsx`, `components/graphite/GenView.tsx`, `components/graphite/Library.tsx` +4 | stream 5 (cards 2) | Thu 8 Oct |

#### S_RIGEXTRAS: Rig library (3)

Replacement: Library drawer (stream 3). Deleting: stream 3 (board canvas). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/Library.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/graphite/LibraryMore.tsx` | component | `components/graphite/Library.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/graphite/production/RigExtras.tsx` | component | `components/graphite/SuitesShell.tsx`, `components/workspace/rig/RigInspector.tsx`, `components/workspace/rig/RigList.tsx` | stream 3 (board canvas) | Thu 8 Oct |

#### S_ASTRA_OUT: Astra outputs page (1)

Replacement: 3D blocking tool on a shot card; no stream plans it. Deleting: UNOWNED: 3D blocking outputs. Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|

#### S_HELPERS_S4S5: helpers of the old stage pages (7)

Replacement: the cards' own logic (lib/production/*). Deleting: streams 4 and 5 (helpers that go with their rows). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/production/AgentAction.tsx` | component | `components/graphite/production/RigExtras.tsx` | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |
| `components/graphite/production/AgentBar.tsx` | component | `components/graphite/production/RigExtras.tsx`, `components/workspace/rig/RigVerify.tsx` | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |
| `components/graphite/production/agent-price.ts` | module | `components/graphite/production/AgentAction.tsx`, `components/workbench/DevelopmentPanel.tsx` | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |
| `components/graphite/production/use-agent-attachments.tsx` | hook | `components/workbench/DevelopmentPanel.tsx` | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |
| `components/graphite/production/use-agent-runs.ts` | hook | `components/graphite/production/AgentAction.tsx`, `components/graphite/production/RigExtras.tsx`, `components/workspace/rig/RigVerify.tsx` | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |
| `components/graphite/production/use-stage-facts.ts` | hook | `components/graphite/business/BusinessOwnView.tsx` | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |
| `components/graphite/production/use-stage-quotes.ts` | hook | none | streams 4 and 5 (helpers that go with their rows) | Thu 8 Oct |

#### S_MAKE: Gen page (3)

Replacement: Make panel (stream 6). Deleting: stream 6 (Make). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/GenView.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/graphite/ModelSheet.tsx` | component | `components/graphite/GenView.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/graphite/tools/SeedanceEditHost.tsx` | component | `components/graphite/MakePanel.tsx`, `components/graphite/board/inspector/TakeBody.tsx` | stream 6 (Make) | Thu 8 Oct |

#### S_ATOMIK_GATE: page-plan sheet and gate (2)

Replacement: Approvals (stream 8) and the Atomik panel (stream 7). Deleting: stream 7 (Atomik). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/AtomikGate.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 7 (Atomik) | Thu 8 Oct |
| `components/graphite/AtomikSheet.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 7 (Atomik) | Thu 8 Oct |

#### S_CREW: Crew destination (1)

Replacement: Crew review panel inside boards (stream 7). Deleting: stream 7 (Atomik: Crew review, frame m). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/crew/CrewView.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 7 (Atomik: Crew review, frame m) | Thu 8 Oct |

#### S_CONTROL: Atomik pages (6)

Replacement: Approvals, Activity, Skills, Memory (stream 8). Deleting: stream 8 (control room). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/ManagementDashboard.tsx` | component | `components/graphite/WorkspaceView.tsx` | stream 8 (control room) | Thu 8 Oct |
| `components/graphite/OwnerRunCard.tsx` | component | `components/graphite/board/cards/cast/CastCard.tsx`, `components/graphite/tools/WorkflowHost.tsx` | stream 8 (control room) | Thu 8 Oct |
| `components/graphite/atomik/MemoryView.tsx` | component | `components/graphite/AssetInspector.tsx`, `components/graphite/Inspector.tsx`, `components/graphite/SuitesShell.tsx` | stream 8 (control room) | Thu 8 Oct |
| `components/graphite/atomik/SkillsView.tsx` | component | `components/graphite/Inspector.tsx`, `components/graphite/SuitesShell.tsx` | stream 8 (control room) | Thu 8 Oct |
| `components/suites/AtomikSuite.tsx` | component | `app/(app)/atomik/page.tsx`, `components/workspace/spec/tools/AtomikTool.tsx` | stream 8 (control room) | Thu 8 Oct |
| `components/suites/atomik-suite-data.ts` | module | `components/suites/AtomikSuite.tsx`, `components/workspace/spec/tools/AtomikTool.tsx`, `tests/unit/atomikSuite.spec.ts` | stream 8 (control room) | Thu 8 Oct |

#### S_SETTINGS: Workspace tabs (6)

Replacement: Settings sections (stream 9). Deleting: stream 9 (Settings). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/ConnectRow.tsx` | component | `components/graphite/WorkspaceView.tsx` | stream 9 (Settings) | Thu 8 Oct |
| `components/graphite/ConnectedAccountRow.tsx` | component | `components/graphite/WorkspaceView.tsx` | stream 9 (Settings) | Thu 8 Oct |
| `components/graphite/UsageLedger.tsx` | component | `components/graphite/AssetInspector.tsx`, `components/graphite/WorkspaceView.tsx` | stream 9 (Settings) | Thu 8 Oct |
| `components/graphite/WorkspaceView.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 9 (Settings) | Thu 8 Oct |
| `components/graphite/atomik/ToolsView.tsx` | component | `components/graphite/Inspector.tsx`, `components/graphite/SuitesShell.tsx` | stream 9 (Settings) | Thu 8 Oct |
| `components/graphite/crew/XaiEngineRow.tsx` | component | `components/graphite/WorkspaceView.tsx` | stream 9 (Settings) | Thu 8 Oct |

#### S_ADS: Business and Viral suites (24)

Replacement: Ads and Social boards (stream 11). Deleting: stream 11 (Ads and Social). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/atomik/MarketingStudioEntry.tsx` | component | `components/atomik/AtomikRail.tsx`, `components/atomik/AtomikSheet.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/BrandTool.tsx` | component | `components/graphite/business/BusinessOwnView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/BusinessOwnView.tsx` | component | `components/graphite/business/BusinessSuite.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/BusinessSuite.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/BusinessView.tsx` | component | `components/graphite/business/BusinessSuite.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/DesignTool.tsx` | component | `components/graphite/business/BusinessOwnView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/FormatTool.tsx` | component | `components/graphite/business/BusinessOwnView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/HooksTool.tsx` | component | `components/graphite/business/BusinessOwnView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/ParticlSetup.tsx` | component | `components/graphite/business/BusinessSuite.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/PresetPicker.tsx` | component | `components/graphite/business/BusinessView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/ProductTool.tsx` | component | `components/graphite/business/BusinessOwnView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/ReferenceTool.tsx` | component | `components/graphite/business/BusinessOwnView.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/own-kit.tsx` | module | `components/graphite/business/BrandTool.tsx`, `components/graphite/business/DesignTool.tsx`, `components/graphite/business/FormatTool.tsx` +4 | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/graphite/business/use-own-agent.ts` | hook | `components/graphite/business/HooksTool.tsx`, `components/graphite/business/ReferenceTool.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/BrandImport.tsx` | component | `components/suites/BrandKitEditor.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/BrandKitEditor.tsx` | component | `components/suites/MoleculrWorkspace.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/CreativeTemplateBrowser.tsx` | component | `components/suites/MoleculrWorkspace.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MarketingPresets.tsx` | component | `components/suites/MoleculrWorkspace.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MarketingStudioFlow.tsx` | component | `components/workbench/Studio.tsx`, `components/workspace/spec/tools/MarketingTool.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MarketingTemplates.tsx` | component | `components/suites/MoleculrWorkspace.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/MoleculrWorkspace.tsx` | component | `components/suites/MarketingStudioFlow.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/PosterDesigner.tsx` | component | `components/suites/MarketingStudioFlow.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/ProductProfileEditor.tsx` | component | `components/suites/MoleculrWorkspace.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/suites/ReferenceAd.tsx` | component | `components/suites/MoleculrWorkspace.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |

#### S_VIRAL_TOOLS: Viral suite (1)

Replacement: Make > Motion transfer, Object swap; Social board. Deleting: stream 6 (Make quick tools) + stream 11 (Social history). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/graphite/viral/ViralView.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 6 (Make quick tools) + stream 11 (Social history) | Thu 8 Oct |

#### RIG_UI: the Rig page (5)

Replacement: the board, `?view=board` (stream 3). Deleting: stream 3 (board canvas). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/rig/RigBoard.tsx` | component | `components/workspace/rig/RigGraph.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/workspace/rig/RigGraph.tsx` | component | `components/workspace/rig/RigPage.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/workspace/rig/RigList.tsx` | component | `components/workspace/rig/RigPage.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/workspace/rig/RigPage.tsx` | component | `components/workspace/pages/registry.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/workspace/rig/TeamPresence.tsx` | component | `components/workspace/rig/RigPage.tsx` | stream 3 (board canvas) | Thu 8 Oct |

#### RIG_INSPECT: Rig inspectors (2)

Replacement: board Inspector (stream 5). Deleting: stream 5 (cards 2). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/rig/RigCardInspector.tsx` | component | `components/workspace/inspector/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/rig/RigInspector.tsx` | component | `components/workspace/inspector/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |

#### RIG_AGENT: Rig run card (1)

Replacement: docked Atomik panel (stream 7); plan part in stream 4's plan card. Deleting: stream 7 (Atomik). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/rig/RigAgentCard.tsx` | component | `components/workspace/rig/RigPage.tsx` | stream 7 (Atomik) | Thu 8 Oct |

#### WS_SHELL: the /workspace shell (19)

Replacement: /suites: Home, board, Settings (streams 2, 3, 9); phone: stream 10. Deleting: flip PR, then D1 retire /workspace (lead). Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/workspace/page.tsx` | route file | Next.js router | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/AccountMenu.tsx` | component | `components/workspace/TopBar.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/AtomikPanel.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/Breadcrumb.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/GenerateComposer.tsx` | component | `components/graphite/SuitesShell.tsx`, `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/GenerationStrip.tsx` | component | `components/graphite/SuitesShell.tsx`, `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/Home.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/Inspector.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/Library.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/PageHeader.tsx` | component | `components/graphite/PageHead.tsx`, `components/workspace/WorkspaceShell.tsx`, `components/workspace/mobile/MobileShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/Palette.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ProjectHeader.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/StageTabs.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/StatusBar.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/TopBar.tsx` | component | `components/workspace/WorkspaceShell.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/VirtualItems.tsx` | component | `components/graphite/Library.tsx`, `components/graphite/MakePanel.tsx`, `components/graphite/make/Recent.tsx` +2 | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/WorkspaceApp.tsx` | component | `app/workspace/page.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/WorkspaceShell.tsx` | component | `components/graphite/SuitesShell.tsx`, `components/workspace/WorkspaceApp.tsx`, `components/workspace/rig/RigProvider.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/icons.ts` | module | `components/workspace/Home.tsx`, `components/workspace/Library.tsx` | flip PR, then D1 retire /workspace (lead) | Thu 8 Oct (needs the owner's yes) |

#### WS_PHONE: the /workspace phone shell (27)

Replacement: phone screens (stream 10). Deleting: stream 10 (phone) + D1 retire /workspace. Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/mobile/MakeComposer.tsx` | component | `components/workspace/mobile/MobileShell.tsx`, `components/workspace/mobile/screens/MakeScreen.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileActionBar.tsx` | component | `components/workspace/mobile/MakeComposer.tsx`, `components/workspace/mobile/MobileShell.tsx`, `components/workspace/mobile/screens/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileDock.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileGenerationStrip.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileHeader.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileRing.tsx` | component | `components/workspace/mobile/MobileActionBar.tsx`, `components/workspace/mobile/MobileGenerationStrip.tsx`, `components/workspace/mobile/MobileSheet.tsx` +4 | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileSheet.tsx` | component | `components/workspace/mobile/MakeComposer.tsx`, `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/MobileShell.tsx` | component | `components/workspace/WorkspaceApp.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/SuiteMenu.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/AccordionPage.tsx` | component | `components/workspace/mobile/screens/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/CardsPages.tsx` | component | `components/workspace/mobile/screens/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/EditSoundPage.tsx` | component | `components/workspace/mobile/screens/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/FlowPage.tsx` | component | `components/workspace/mobile/pages/RigTemplate.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/RigTemplate.tsx` | component | `components/workspace/mobile/screens/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/RowsPage.tsx` | component | `components/workspace/mobile/screens/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/pages/ShotListPage.tsx` | component | `components/workspace/mobile/pages/RigTemplate.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/screens/MakeScreen.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/screens/PageScreen.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/screens/ProjectsScreen.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/screens/SettingsScreen.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/screens/SuiteScreen.tsx` | component | `components/workspace/mobile/MobileShell.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/screens/registry.tsx` | module | `components/workspace/mobile/MobileShell.tsx`, `components/workspace/mobile/pages/AccordionPage.tsx`, `components/workspace/mobile/pages/CardsPages.tsx` +4 | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/sheets/AtomikSheet.tsx` | component | `components/workspace/mobile/sheets/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/sheets/InspectorSheet.tsx` | component | `components/workspace/mobile/sheets/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/sheets/LibrarySheet.tsx` | component | `components/workspace/mobile/sheets/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/sheets/SearchSheet.tsx` | component | `components/workspace/mobile/sheets/registry.tsx` | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/mobile/sheets/registry.tsx` | module | `components/workspace/mobile/MobileShell.tsx`, `components/workspace/mobile/sheets/AtomikSheet.tsx`, `components/workspace/mobile/sheets/InspectorSheet.tsx` +3 | stream 10 (phone) + D1 retire /workspace | Thu 8 Oct (needs the owner's yes) |

#### WS_UI: the /workspace primitives (10)

Replacement: the new screens' own components; no shared primitive set is planned. Deleting: D1 retire /workspace, with its last importer (lead). Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/ui/Button.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/Field.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/IconTile.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/Keycap.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/Kicker.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/Segmented.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/StatusPill.tsx` | component | `components/workspace/mobile/pages/ShotListPage.tsx`, `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/Stepper.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/Toast.tsx` | component | `components/workspace/ui/index.ts` | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/ui/index.ts` | module | `components/workspace/AtomikPanel.tsx`, `components/workspace/Breadcrumb.tsx`, `components/workspace/GenerateComposer.tsx` +23 | D1 retire /workspace, with its last importer (lead) | Thu 8 Oct (needs the owner's yes) |

#### WS_SPEC_BRIEF: stage page tool (2)

Replacement: Brief region, Storyboard region (stream 4). Deleting: stream 4 (cards 1). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/spec/tools/BoardsTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | stream 4 (cards 1) | Thu 8 Oct |
| `components/workspace/spec/tools/BriefTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | stream 4 (cards 1) | Thu 8 Oct |

#### WS_SPEC_SHOTS: stage page tool (1)

Replacement: Shots, Cast, Cut, Deliver (stream 5). Deleting: stream 5 (cards 2). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/spec/tools/DeliverTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | stream 5 (cards 2) | Thu 8 Oct |

#### WS_SPEC_ATOMIK: Atomik stage page tool (1)

Replacement: Atomik panel and docked panel (stream 7). Deleting: stream 7 (Atomik). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/spec/tools/AtomikTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | stream 7 (Atomik) | Thu 8 Oct |

#### WS_SPEC_ADS: Business/Viral stage page tool (3)

Replacement: Ads and Social boards (stream 11). Deleting: stream 11 (Ads and Social). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/spec/tools/MarketingPlanPanel.tsx` | component | `components/workspace/spec/tools/MarketingTool.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/workspace/spec/tools/MarketingTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |
| `components/workspace/spec/tools/SubatomikTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | stream 11 (Ads and Social) | Thu 8 Oct |

#### WS_SPEC_ASTRA: Astra 3D stage tool (1)

Replacement: 3D blocking, a tool on a shot card (README 1.2); no stream plans it. Deleting: UNOWNED: 3D blocking tool. Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/spec/tools/AstraTool.tsx` | component | `components/workspace/spec/SpecTool.tsx` | UNOWNED: 3D blocking tool | Thu 8 Oct |

#### WS_SPEC_SHELL: the stage-page frame (6)

Replacement: the board (stream 3). Deleting: D1 retire /workspace + stage pages (lead). Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/spec/SpecInspector.tsx` | component | `components/workspace/inspector/registry.tsx` | D1 retire /workspace + stage pages (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/spec/SpecPage.tsx` | component | `components/workspace/pages/registry.tsx` | D1 retire /workspace + stage pages (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/spec/SpecTool.tsx` | component | `components/workspace/pages/registry.tsx`, `components/workspace/spec/SpecPage.tsx` | D1 retire /workspace + stage pages (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/spec/tools/DraftStatus.tsx` | component | `components/workspace/pages/ShortsPage.tsx`, `components/workspace/spec/tools/AstraTool.tsx`, `components/workspace/spec/tools/BoardsTool.tsx` +3 | D1 retire /workspace + stage pages (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/spec/tools/studio-css.ts` | module | `components/workspace/spec/tools/AstraTool.tsx`, `components/workspace/spec/tools/BoardsTool.tsx`, `components/workspace/spec/tools/BriefTool.tsx` +2 | D1 retire /workspace + stage pages (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workspace/spec/use-spec-data.ts` | hook | `components/graphite/board/cards/group/GroupCard.tsx`, `components/workspace/mobile/pages/RowsPage.tsx`, `components/workspace/spec/SpecPage.tsx` | D1 retire /workspace + stage pages (lead) | Thu 8 Oct (needs the owner's yes) |

#### WS_PAGES: stage pages (4)

Replacement: Shots, Cast, Cut regions (stream 5). Deleting: stream 5 (cards 2). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/pages/CastPage.tsx` | component | `components/workspace/inspector/CastInspector.tsx`, `components/workspace/mobile/pages/CardsPages.tsx`, `components/workspace/pages/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/pages/EditPage.tsx` | component | `components/workspace/pages/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/pages/TakesPage.tsx` | component | `components/workspace/inspector/TakeInspector.tsx`, `components/workspace/mobile/pages/CardsPages.tsx`, `components/workspace/pages/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/pages/registry.tsx` | module | `components/graphite/SuitesShell.tsx`, `components/workspace/WorkspaceShell.tsx`, `components/workspace/pages/CastPage.tsx` +4 | stream 5 (cards 2) | Thu 8 Oct |

#### WS_INSPECT: old take/cast Inspector (4)

Replacement: board Inspector and take card (stream 5). Deleting: stream 5 (cards 2). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workspace/inspector/CastInspector.tsx` | component | `components/workspace/inspector/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/inspector/MediaPreview.tsx` | component | `components/workspace/inspector/CastInspector.tsx`, `components/workspace/inspector/TakeInspector.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/inspector/TakeInspector.tsx` | component | `components/workspace/inspector/registry.tsx` | stream 5 (cards 2) | Thu 8 Oct |
| `components/workspace/inspector/registry.tsx` | module | `components/graphite/Inspector.tsx`, `components/workspace/Inspector.tsx`, `components/workspace/inspector/CastInspector.tsx` +4 | stream 5 (cards 2) | Thu 8 Oct |

#### WB_SHELL: the /workbench shell (14)

Replacement: /suites board regions (streams 3, 4, 5). Deleting: flip PR, then D1 retire /workbench (lead). Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/workbench/movie/page.tsx` | route file | Next.js router | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/workbench/page.tsx` | route file | Next.js router | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/AssetBins.tsx` | component | `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/AtomikResizer.tsx` | component | `components/atomik/AtomikRail.tsx`, `components/atomik/AtomikSheet.tsx`, `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/EditVersions.tsx` | component | `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/MarketingStudioPanel.tsx` | component | `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/MoviePage.tsx` | component | `app/workbench/movie/page.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/SequenceColor.tsx` | component | `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/Studio.tsx` | component | `app/workbench/page.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/WorkspaceMenu.tsx` | component | `components/studio/StudioNavigation.tsx`, `components/suites/SuiteAccountShell.tsx`, `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/design-review.tsx` | module | `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/mobile-ui.tsx` | module | `components/shell/Shell.tsx`, `components/studio/StudioNavigation.tsx`, `components/suites/SuiteAccountShell.tsx` +4 | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/production-crew.tsx` | module | `components/workbench/Studio.tsx`, `components/workspace/spec/tools/BoardsTool.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/production-graph.tsx` | module | `components/workbench/Studio.tsx` | flip PR, then D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |

#### WB_UI: the /workbench primitives (shadcn set) (15)

Replacement: the new screens' own components. Deleting: D1 retire /workbench (lead). Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/workbench/ui/button.tsx` | module | `components/workbench/AtomikRunDialog.tsx`, `components/workbench/GenerationDialog.tsx`, `components/workbench/SoulIdentityPanel.tsx` +5 | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/checkbox.tsx` | module | `components/workbench/Studio.tsx`, `components/workbench/production-graph.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/dialog.tsx` | module | `components/astra-blender/AstraRenderPanel.tsx`, `components/workbench/AssetBins.tsx`, `components/workbench/AtomikRunDialog.tsx` +3 | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/dropdown-menu.tsx` | module | `components/shell/Header.tsx`, `components/studio/ProjectStudioHeader.tsx`, `components/suites/SuiteHome.tsx` +3 | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/input.tsx` | module | `components/workbench/ui/sidebar.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/select.tsx` | module | `components/workbench/Studio.tsx`, `components/workbench/production-graph.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/separator.tsx` | module | `components/workbench/ui/sidebar.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/sheet.tsx` | module | `components/studio/StudioNavigation.tsx`, `components/workbench/mobile-ui.tsx`, `components/workbench/ui/sidebar.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/sidebar.tsx` | module | `components/workbench/Studio.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/skeleton.tsx` | module | `components/workbench/ui/sidebar.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/slider.tsx` | module | `components/workbench/Studio.tsx`, `components/workbench/production-graph.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/sonner.tsx` | module | `components/workbench/Studio.tsx`, `components/workspace/spec/SpecTool.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/tabs.tsx` | module | `components/workbench/Studio.tsx`, `components/workbench/production-graph.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/ui/tooltip.tsx` | module | `components/workbench/Studio.tsx`, `components/workbench/production-graph.tsx`, `components/workbench/ui/sidebar.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/workbench/use-mobile.ts` | hook | `components/workbench/ui/sidebar.tsx` | D1 retire /workbench (lead) | Thu 8 Oct (needs the owner's yes) |

#### A_SUITE_HOME: old app Home (2)

Replacement: Home (stream 2). Deleting: stream 2 (Home). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/page.tsx` | route file | Next.js router | stream 2 (Home) | Thu 8 Oct |
| `components/suites/SuiteHome.tsx` | component | `app/(app)/page.tsx` | stream 2 (Home) | Thu 8 Oct |

#### A_MAKE: /generate page (11)

Replacement: Make panel (stream 6). Deleting: stream 6 (Make). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/audio/page.tsx` | route file | Next.js router | stream 6 (Make) | Thu 8 Oct |
| `app/(app)/generate/page.tsx` | route file | Next.js router | stream 6 (Make) | Thu 8 Oct |
| `app/(app)/images/page.tsx` | route file | Next.js router | stream 6 (Make) | Thu 8 Oct |
| `app/(app)/make/[kind]/page.tsx` | route file | Next.js router | stream 6 (Make) | Thu 8 Oct |
| `components/make/AstraUpscale.tsx` | component | `components/make/GenWorkspace.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/make/Composer.tsx` | component | `components/make/GenWorkspace.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/make/GenLoading.tsx` | component | `app/(app)/generate/page.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/make/GenWorkspace.tsx` | component | `app/(app)/generate/page.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/make/SeedanceEdit.tsx` | component | `components/graphite/tools/SeedanceEditHost.tsx`, `components/make/GenWorkspace.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/make/TopazImageUpscale.tsx` | component | `components/make/GenWorkspace.tsx` | stream 6 (Make) | Thu 8 Oct |
| `components/make/UnfiledWall.tsx` | component | `app/(app)/library/page.tsx` | stream 6 (Make) | Thu 8 Oct |

#### A_LIB: /library page (4)

Replacement: Library drawer, Make > Recent. Deleting: stream 3 (Library drawer) + stream 6 (Make > Recent). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/all/page.tsx` | route file | Next.js router | stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |
| `app/(app)/library/page.tsx` | route file | Next.js router | stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |
| `components/assets/NewAssetSheet.tsx` | component | `app/(app)/library/page.tsx`, `app/(app)/productions/[prod]/[project]/shots/page.tsx`, `app/(app)/rig/canvas/[boardId]/page.tsx` +1 | stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |
| `components/make/GenAssetLibrary.tsx` | component | `app/(app)/library/page.tsx`, `components/make/GenWorkspace.tsx`, `components/suites/ConsumerShorts.tsx` +3 | stream 3 (Library drawer) + stream 6 (Make > Recent) | Thu 8 Oct |

#### A_PROD: /productions pages (5)

Replacement: Home projects, the board. Deleting: stream 2 (Home: projects) + stream 3 (board). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/productions/[prod]/[project]/media/page.tsx` | route file | Next.js router | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `app/(app)/productions/[prod]/[project]/shots/page.tsx` | route file | Next.js router | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `app/(app)/productions/page.tsx` | route file | Next.js router | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `components/production/MediaTile.tsx` | component | `app/(app)/productions/[prod]/[project]/media/page.tsx` | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |
| `components/production/ProductionHeader.tsx` | component | `app/(app)/productions/[prod]/[project]/media/page.tsx`, `app/(app)/productions/[prod]/[project]/shots/page.tsx`, `app/(app)/productions/page.tsx` | stream 2 (Home: projects) + stream 3 (board) | Thu 8 Oct |

#### A_RIG_PAGES: /rig pages (6)

Replacement: the board. Deleting: stream 3 (board canvas). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/rig/canvas/[boardId]/page.tsx` | route file | Next.js router | stream 3 (board canvas) | Thu 8 Oct |
| `app/(app)/rig/recipes/[projectId]/page.tsx` | route file | Next.js router | stream 3 (board canvas) | Thu 8 Oct |
| `app/(app)/rig/run/[runId]/page.tsx` | route file | Next.js router | stream 3 (board canvas) | Thu 8 Oct |
| `components/rig/PhoneBoard.tsx` | component | `app/(app)/rig/canvas/[boardId]/page.tsx` | stream 3 (board canvas) | Thu 8 Oct |
| `components/rig/RigBar.tsx` | component | `app/(app)/rig/canvas/[boardId]/page.tsx`, `app/(app)/rig/recipes/[projectId]/page.tsx`, `tests/unit/legacyRigRun.spec.ts` | stream 3 (board canvas) | Thu 8 Oct |
| `components/rig/nodes.ts` | module | `app/(app)/rig/canvas/[boardId]/page.tsx`, `components/rig/PhoneBoard.tsx`, `tests/unit/appPagesAudit.spec.ts` | stream 3 (board canvas) | Thu 8 Oct |

#### A_PIPE: /pipelines (4)

Replacement: Control room > Activity (stream 8). Deleting: stream 8 (Activity). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/pipelines/page.tsx` | route file | Next.js router | stream 8 (Activity) | Thu 8 Oct |
| `components/pipeline/PipelineBuilder.tsx` | component | `components/pipeline/PipelineWorkspace.tsx`, `components/suites/AtomikSuite.tsx` | stream 8 (Activity) | Thu 8 Oct |
| `components/pipeline/PipelineRun.tsx` | component | `components/pipeline/PipelineWorkspace.tsx`, `components/suites/AtomikSuite.tsx` | stream 8 (Activity) | Thu 8 Oct |
| `components/pipeline/PipelineWorkspace.tsx` | component | `app/(app)/pipelines/page.tsx` | stream 8 (Activity) | Thu 8 Oct |

#### A_SETTINGS: /settings /team /usage /connect (12)

Replacement: Settings sections; Activity. Deleting: stream 9 (Settings) + stream 8 (Activity). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/connect/page.tsx` | route file | Next.js router | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `app/(app)/dashboard/page.tsx` | route file | Next.js router | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `app/(app)/settings/page.tsx` | route file | Next.js router | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `app/(app)/team/page.tsx` | route file | Next.js router | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `app/(app)/usage/page.tsx` | route file | Next.js router | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/Tokens.tsx` | component | `app/(app)/connect/page.tsx` | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/ConsumerCreditActivity.tsx` | component | `app/(app)/usage/page.tsx` | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/HiggsfieldConnection.tsx` | component | `app/(app)/settings/page.tsx` | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/ManagementPage.tsx` | component | `app/(app)/settings/page.tsx`, `app/(app)/team/page.tsx`, `app/(app)/usage/page.tsx` +8 | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/OpenAIConnection.tsx` | component | `app/(app)/settings/page.tsx` | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/WorkspaceAudit.tsx` | component | `app/(app)/settings/page.tsx`, `components/graphite/WorkspaceView.tsx` | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |
| `components/management/WorkspaceSecurity.tsx` | component | `app/(app)/team/page.tsx` | stream 9 (Settings) + stream 8 (Activity) | Thu 8 Oct |

#### A_ATOMIK_PAGES: old Atomik suite pages (2)

Replacement: Atomik panel, control room. Deleting: stream 7 / stream 8 (Atomik). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/atomik/layout.tsx` | route file | Next.js router | stream 7 / stream 8 (Atomik) | Thu 8 Oct |
| `app/(app)/atomik/page.tsx` | route file | Next.js router | stream 7 / stream 8 (Atomik) | Thu 8 Oct |

#### A_SUBATOMIK: Subatomik page (8)

Replacement: Social board; Make > Motion transfer, Object swap. Deleting: stream 11 (Social) + stream 6 (Make quick tools). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/subatomic/page.tsx` | route file | Next.js router | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `app/(app)/subatomik/page.tsx` | route file | Next.js router | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/FrameExtractControls.tsx` | component | `components/suites/SubatomikWorkspace.tsx` | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/ReferenceImagePreview.tsx` | component | `components/suites/SubatomikWorkspace.tsx` | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/SubatomikWorkspace.tsx` | component | `app/(app)/subatomik/page.tsx`, `components/workspace/spec/tools/SubatomikTool.tsx` | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/SyncedVideoComparison.tsx` | component | `components/suites/SubatomikWorkspace.tsx` | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/subatomik-directions.ts` | module | `components/suites/SubatomikWorkspace.tsx` | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |
| `components/suites/subatomik-recreate.ts` | module | `components/suites/SubatomikWorkspace.tsx`, `tests/unit/subatomikRecreate.spec.ts` | stream 11 (Social) + stream 6 (Make quick tools) | Thu 8 Oct |

#### A_ATOMIK_UI: old Atomik rail/sheet (4)

Replacement: Atomik panel (stream 7). Deleting: stream 7 (Atomik). Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/atomik/threads/ThreadSwitcher.tsx` | component | `components/atomik/AtomikRail.tsx`, `components/atomik/AtomikSheet.tsx`, `components/atomik/threads/ThreadsPanel.tsx` | stream 7 (Atomik) | Thu 8 Oct |
| `components/atomik/threads/ThreadsPanel.tsx` | component | `components/workspace/spec/tools/AtomikTool.tsx` | stream 7 (Atomik) | Thu 8 Oct |
| `components/suites/SuiteAgentPanel.tsx` | component | `components/suites/AtomikSuite.tsx`, `components/suites/SubatomikWorkspace.tsx`, `components/workbench/Studio.tsx` +1 | stream 7 (Atomik) | Thu 8 Oct |
| `components/suites/SuiteProjectContext.tsx` | component | `components/shell/Shell.tsx`, `components/suites/SubatomikWorkspace.tsx`, `components/suites/SuiteHome.tsx` +1 | stream 7 (Atomik) | Thu 8 Oct |

#### A_NOFRAME: old app route with no replacement (27)

Replacement: none drawn. Deleting: UNOWNED: no frame draws this route. Target: Thu 8 Oct.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/atomik/breakdown/loading.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/breakdown/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/ideas/loading.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/ideas/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/shots/loading.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/shots/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/treatment/loading.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/atomik/treatment/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/canvas/[id]/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/elements/[id]/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/projects/[id]/canvas/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/projects/[id]/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/projects/[id]/rig/elements/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/shots/[id]/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/studio/shot/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `app/(app)/takes/[id]/page.tsx` | route file | Next.js router | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/Analytics.tsx` | component | `app/(app)/projects/[id]/page.tsx`, `app/(app)/usage/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/Compare.tsx` | component | `components/Feed.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ContextMenu.tsx` | component | `app/(app)/layout.tsx`, `components/Theatre.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ElementScreen.tsx` | component | `app/(app)/elements/[id]/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/Feed.tsx` | component | `app/(app)/projects/[id]/canvas/page.tsx`, `app/(app)/usage/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ImpactSheet.tsx` | component | `app/(app)/projects/[id]/rig/elements/page.tsx`, `components/ElementScreen.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/PaneDivider.tsx` | component | `app/(app)/projects/[id]/canvas/page.tsx`, `app/(app)/studio/shot/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ProductionNav.tsx` | component | `app/(app)/projects/[id]/canvas/page.tsx`, `app/(app)/projects/[id]/page.tsx`, `app/(app)/projects/[id]/rig/elements/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ProvenanceCard.tsx` | component | `app/(app)/takes/[id]/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/QueueStrip.tsx` | component | `components/Feed.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |
| `components/ShotBindings.tsx` | component | `app/(app)/shots/[id]/page.tsx` | UNOWNED: no frame draws this route | Thu 8 Oct |

#### A_SHELL: old app shell (13)

Replacement: /suites. Deleting: flip PR, then D1 retire app shell (lead). Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/(app)/error.tsx` | route file | Next.js router | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `app/(app)/layout.tsx` | route file | Next.js router | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/atomik/AtomikRail.tsx` | component | `components/shell/Shell.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/atomik/AtomikSheet.tsx` | component | `components/shell/Shell.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/shell/Dock.tsx` | component | `components/shell/Shell.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/shell/Header.tsx` | component | `components/shell/Shell.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/shell/Shell.tsx` | component | `app/(app)/layout.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/shell/SuspendedBar.tsx` | component | `components/shell/Shell.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/studio/StudioNavigation.tsx` | component | `components/shell/Header.tsx`, `components/studio/ProjectStudioHeader.tsx`, `components/suites/SuiteAccountShell.tsx` +1 | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/suites/SuiteAccountShell.tsx` | component | `app/(auth)/account/security/page.tsx`, `app/(auth)/billing/page.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/suites/SuiteNavigation.tsx` | component | `components/shell/Dock.tsx`, `components/shell/Header.tsx`, `components/shell/Shell.tsx` +2 | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/switchover/DeviceProbe.tsx` | component | `app/layout.tsx` | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |
| `components/switchover/SwitchoverGate.tsx` | component | `app/(app)/atomik/page.tsx`, `app/(app)/page.tsx`, `app/(app)/subatomik/page.tsx` +1 | flip PR, then D1 retire app shell (lead) | Thu 8 Oct (needs the owner's yes) |

#### A_PRIMS: old app primitives (16)

Replacement: the new screens' own components. Deleting: D1 retire (lead), with last importer. Target: Thu 8 Oct (needs the owner's yes).

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `components/ui/Button.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/CapBar.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Chip.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Mark.tsx` | component | `components/AuthCard.tsx`, `components/WelcomeSignIn.tsx`, `components/graphite/FaultPage.tsx` +4 | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/MediaCard.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Menu.tsx` | component | `app/(app)/library/page.tsx`, `app/(app)/productions/[prod]/[project]/shots/page.tsx`, `app/(app)/rig/canvas/[boardId]/page.tsx` +4 | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Mono.tsx` | component | `components/shell/AccountMenu.tsx`, `components/ui/CapBar.tsx`, `components/ui/MediaCard.tsx` +5 | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/PinnedBar.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Placeholder.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Rail.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Segmented.tsx` | component | `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Sheet.tsx` | component | `components/assets/NewAssetSheet.tsx`, `components/rig/PhoneBoard.tsx`, `components/ui/Menu.tsx` +1 | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/StateDot.tsx` | component | `components/ui/MediaCard.tsx`, `components/ui/index.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Stepper.tsx` | component | `components/ui/index.ts`, `lib/productions.ts` | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/Toast.tsx` | component | `app/(app)/library/page.tsx`, `app/(app)/productions/[prod]/[project]/shots/page.tsx`, `app/(app)/rig/canvas/[boardId]/page.tsx` +13 | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |
| `components/ui/index.ts` | module | `app/(app)/library/page.tsx`, `app/(app)/productions/[prod]/[project]/media/page.tsx`, `app/(app)/productions/[prod]/[project]/shots/page.tsx` +12 | D1 retire (lead), with last importer | Thu 8 Oct (needs the owner's yes) |

### 6b. Rebuilt in place by stream 1 (the live shell)

These are the 3 October shell. They are not deleted; the D0 PRs and stream 1 rewrite them to header B and the new shell, and the old pieces inside them (the 46 px page strip, the suite pills) go with that rewrite.

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `app/suites/error.tsx` | route file | Next.js router | stream 1 | Thu 8 Oct |
| `app/suites/page.tsx` | route file | Next.js router | stream 1 | Thu 8 Oct |
| `components/graphite/ContextMenu.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/Header.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/JobsTray.tsx` | component | `components/graphite/Header.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/Palette.tsx` | component | `components/graphite/SuitesShell.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/ResumedJobs.tsx` | component | `components/graphite/GenView.tsx`, `components/graphite/viral/ViralView.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/SuitesApp.tsx` | component | `app/suites/page.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/SuitesShell.tsx` | component | `components/graphite/SuitesApp.tsx` | stream 1 | Thu 8 Oct |
| `components/graphite/icons.tsx` | module | `components/graphite/FaultPage.tsx`, `components/graphite/Header.tsx`, `components/graphite/JobsTray.tsx` +11 | stream 1 | Thu 8 Oct |

### 6c. Data layer and shared logic (not designs, not listed for deletion)

`app/error.tsx`, `app/global-error.tsx`, `app/layout.tsx`, `app/not-found.tsx`, `app/robots.ts`, `app/sitemap.ts`, `components/AtomikMark.tsx`, `components/Boundary.tsx`, `components/DragLayer.tsx`, `components/GenCard.tsx`, `components/Icons.tsx`, `components/LazyMedia.tsx`, `components/ParticlMark.tsx`, `components/PreviewLayer.tsx`, `components/PromptAttach.tsx`, `components/RequestAccess.tsx`, `components/SharedKeyCard.tsx`, `components/UploadRecovery.tsx`, `components/ViewportGuard.tsx`, `components/atomik/AtomikLoading.tsx`, `components/atomik/AtomikProvider.tsx`, `components/atomik/ChatComposer.tsx`, `components/atomik/Loader.tsx`, `components/atomik/MentionText.tsx`, `components/atomik/ModelMenu.tsx`, `components/atomik/ModelPicker.tsx`, `components/atomik/PickProduction.tsx`, `components/atomik/QuotedAtomikAction.tsx`, `components/atomik/Ring.tsx`, `components/atomik/skills/ComposerSkills.tsx`, `components/atomik/skills/SkillForms.tsx`, `components/atomik/skills/useSkillRunOpens.ts`, `components/atomik/threads/useThreadSends.ts`, `components/dialog.tsx`, `components/workspace/rig/RigImport.tsx`, `components/workspace/rig/RigProvider.tsx`, `components/workspace/rig/RigVerify.tsx`, `components/workspace/rig/VerifyBadge.tsx`, `components/workspace/rig/use-cutouts.ts`, `components/workspace/rig/use-team-canvas.ts`, `components/workspace/rig/use-verifications.ts`.

## 7. Kept, with a reason and a date

These stay past the clean slate. Each has a reason and the date it is reviewed again; none is allowed to grow. They are all on the guard's allow-list (sheets) or baseline (words).

| Path | Kind | Imported by | Why it stays | Until / next review |
|---|---|---|---|---|
| `app/graphite.css` | token set | `app/layout.tsx` | the one token set | permanent |
| `app/fonts.css` | fonts | `app/layout.tsx` | `@font-face` only (Outfit and Kode Mono for the wordmark, Geist as the README's type fallback); defines no colour or spacing | permanent |
| `app/(app)/admin/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/platform/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/policy/layout.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/policy/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/privacy/layout.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/privacy/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/report/layout.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/report/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/statements/[month]/layout.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/statements/[month]/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/terms/layout.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/terms/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/review/[token]/layout.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/review/[token]/page.tsx` | source | Next.js router | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `components/PolicyPage.tsx` | source | `app/(app)/policy/page.tsx`, `app/(app)/privacy/page.tsx`, `app/(app)/terms/page.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `components/graphite/FaultPage.tsx` | source | `app/suites/error.tsx`, `components/graphite/NotFoundView.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `components/graphite/NotFoundView.tsx` | source | `app/not-found.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `components/graphite/PanelFault.tsx` | source | `components/graphite/FaultPage.tsx`, `components/graphite/GenView.tsx`, `components/graphite/SuitesShell.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(app)/statements/[month]/statement.css` | sheet | `app/(app)/statements/[month]/page.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/review/[token]/review.css` | sheet | `app/review/[token]/page.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `components/graphite/fault.css` | sheet | `components/graphite/FaultPage.tsx`, `components/graphite/PanelFault.tsx` | page the handoff does not draw: kept: no frame in the design (reading floor, #515) | Thu 8 Oct |
| `app/(auth)/account/security/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/billing/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/invite/[code]/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/layout.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/login/layout.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/login/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/pricing/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/reset/[token]/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/reset/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/setup/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/signup/layout.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/signup/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5); `site/guest-home` redraws it on Graphite (the sign-up sheet's frame) with the invitation pre-filled, owner-gated (decision 41) | Thu 8 Oct |
| `app/(auth)/welcome/layout.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(auth)/welcome/page.tsx` | source | Next.js router | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/AuthCard.tsx` | source | `app/(auth)/invite/[code]/page.tsx`, `app/(auth)/reset/[token]/page.tsx`, `app/(auth)/reset/page.tsx` +2 | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/ParticlIntro.tsx` | source | `app/(auth)/welcome/page.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/WelcomeSignIn.tsx` | source | `app/(auth)/login/page.tsx`, `app/(auth)/welcome/page.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/BillingClient.tsx` | source | `app/(auth)/billing/page.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/CommercialLayout.tsx` | source | `components/commercial/PricingClient.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/MediaReach.tsx` | source | `components/commercial/BillingClient.tsx`, `components/commercial/PricingClient.tsx`, `components/graphite/WorkspaceView.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/PricingClient.tsx` | source | `app/(auth)/pricing/page.tsx`, `components/commercial/BillingClient.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/management/AccountSecurity.tsx` | source | `app/(auth)/account/security/page.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/auth-mobile.css` | sheet | `components/AuthCard.tsx`, `components/WelcomeSignIn.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/commercial.css` | sheet | `app/(auth)/pricing/page.tsx`, `app/(auth)/signup/page.tsx` (until `site/guest-home`, which draws /signup on Graphite, decision 41) | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/commercial/media-reach.css` | sheet | `components/commercial/MediaReach.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `components/management/account-security.module.css` | sheet | `components/management/AccountSecurity.tsx`, `components/management/WorkspaceSecurity.tsx` | sign-in, sign-up, billing pages: kept: sign-in and accounts need the owner (rule 5) | Thu 8 Oct |
| `app/(marketing)/site/[[...slug]]/page.tsx` | source | Next.js router | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/atomik/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/business/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/gen/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old homepage: stream 15: deleted with its copy and styles by `site/guest-home-on`, merged in the same step as turning Guest Home on (owner, decision 41) | Thu 8 Oct |
| `app/(marketing)/site/_pages/pricing/PlanCards.tsx` | source | `app/(marketing)/site/_pages/pricing/index.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/pricing/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/studio/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/viral/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/workspace/index.tsx` | source | `app/(marketing)/site/[[...slug]]/page.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/layout.tsx` | source | Next.js router | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/AccessForm.tsx` | source | `components/marketing/SharedBottom.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/ActiveTab.tsx` | source | `components/marketing/SiteChrome.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/HeroPrompt.tsx` | source | `app/(marketing)/site/_pages/gen/index.tsx` | the old homepage: stream 15: deleted with its copy and styles by `site/guest-home-on`, merged in the same step as turning Guest Home on (owner, decision 41) | Thu 8 Oct |
| `components/marketing/SharedBottom.tsx` | source | `components/marketing/SitePage.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/SiteChrome.tsx` | source | `components/marketing/SitePage.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/SitePage.tsx` | source | `app/(marketing)/site/_pages/atomik/index.tsx`, `app/(marketing)/site/_pages/business/index.tsx`, `app/(marketing)/site/_pages/gen/index.tsx` +4 | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/ui.tsx` | source | `app/(marketing)/site/_pages/atomik/index.tsx`, `app/(marketing)/site/_pages/business/index.tsx`, `app/(marketing)/site/_pages/gen/index.tsx` +6 | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/atomik/atomik.module.css` | sheet | `app/(marketing)/site/_pages/atomik/index.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/pricing/pricing.module.css` | sheet | `app/(marketing)/site/_pages/pricing/PlanCards.tsx`, `app/(marketing)/site/_pages/pricing/index.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `app/(marketing)/site/_pages/studio/studio.module.css` | sheet | `app/(marketing)/site/_pages/studio/index.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live) | Thu 8 Oct |
| `components/marketing/marketing.css` | sheet | `app/(marketing)/site/layout.tsx` | the old marketing site: stream 15 (copy now; old homepage retires when guest Home is live); its `.mk-hero*` and `.mk-prompt*` rules go with the homepage in `site/guest-home-on` | Thu 8 Oct |
| `components/workbench/ActionMenu.tsx` | source | `components/Cast.tsx`, `components/make/GenAssetLibrary.tsx`, `components/workbench/Studio.tsx` +1 | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/AssetPreview.tsx` | source | `components/pipeline/PipelineRun.tsx`, `components/suites/MarketingPresets.tsx`, `components/suites/MoleculrWorkspace.tsx` +3 | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/AtomikRunDialog.tsx` | source | `components/astra-blender/AstraAgentPanel.tsx`, `components/graphite/business/HooksTool.tsx`, `components/graphite/business/ReferenceTool.tsx` +3 | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/ColorPreview.tsx` | source | `components/workbench/TimelinePreview.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/DevelopmentPanel.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/spec/tools/BriefTool.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/DraftUploadInput.tsx` | source | `components/workspace/spec/tools/MarketingTool.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/GenerationDialog.tsx` | source | `components/astra-blender/AstraAgentPanel.tsx`, `components/astra-blender/AstraExportPanel.tsx`, `components/astra-blender/AstraRenderPanel.tsx` +23 | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/MovieExport.tsx` | source | `components/workbench/MoviePage.tsx`, `components/workspace/spec/tools/DeliverTool.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/NumberDraftInput.tsx` | source | `components/workbench/GenerationDialog.tsx`, `components/workbench/SoundGenerate.tsx`, `components/workbench/SoundMix.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/ProjectAssetLibrary.tsx` | source | `components/workbench/ProjectLibraryPage.tsx`, `components/workbench/Studio.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/ProjectLibraryPage.tsx` | source | `app/(app)/library/page.tsx`, `components/make/GenWorkspace.tsx`, `components/suites/SubatomikWorkspace.tsx` +1 | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/ScreenplayOcrReview.tsx` | source | `components/workbench/ScriptPanel.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/ScriptPanel.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/spec/tools/BriefTool.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/SoulIdentityPanel.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/pages/CastPage.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/SoundGenerate.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/pages/EditPage.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/SoundMix.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/pages/EditPage.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/TimelinePreview.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/pages/EditPage.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/use-production-jobs.ts` | source | `components/workbench/MarketingStudioPanel.tsx`, `components/workbench/Studio.tsx`, `components/workspace/pages/EditPage.tsx` +1 | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/use-sound-placements.ts` | source | `components/workbench/SoundGenerate.tsx`, `components/workbench/Studio.tsx`, `components/workspace/pages/EditPage.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/SoundGenerate.module.css` | sheet | `components/workbench/SoundGenerate.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/SoundMix.module.css` | sheet | `components/workbench/SequenceColor.tsx`, `components/workbench/SoundMix.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/action-menu.module.css` | sheet | `components/workbench/ActionMenu.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/development-panel.module.css` | sheet | `components/workbench/DevelopmentPanel.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/project-asset-library.module.css` | sheet | `components/workbench/ProjectAssetLibrary.tsx`, `components/workbench/ProjectLibraryPage.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/script-panel.module.css` | sheet | `components/workbench/ScreenplayOcrReview.tsx`, `components/workbench/ScriptPanel.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/workbench/soul-identity-panel.module.css` | sheet | `components/workbench/SoulIdentityPanel.tsx` | functional editor or tool with no frame: UNOWNED: tool restyle (lead/owner to decide) | Thu 8 Oct |
| `components/astra-blender/AstraAgentPanel.tsx` | source | `components/astra-blender/AstraStudio.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/AstraBlenderWorkspace.tsx` | source | `components/astra-blender/AstraStudio.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/AstraExportPanel.tsx` | source | `components/astra-blender/AstraStudio.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/AstraNativeSourcePanel.tsx` | source | `components/astra-blender/AstraStudio.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/AstraRenderPanel.tsx` | source | `components/astra-blender/AstraStudio.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/AstraStudio.tsx` | source | `components/workbench/Studio.tsx`, `components/workspace/spec/tools/AstraTool.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/AstraViewport.tsx` | source | `components/astra-blender/AstraBlenderWorkspace.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/astra-render-recovery.ts` | source | `components/astra-blender/AstraRenderPanel.tsx`, `tests/astra-render-workbench.spec.ts`, `tests/unit/astraRenderRecovery.spec.ts` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/types.ts` | source | `components/astra-blender/AstraBlenderWorkspace.tsx`, `components/astra-blender/AstraViewport.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/astra-blender.module.css` | sheet | `components/astra-blender/AstraBlenderWorkspace.tsx`, `components/astra-blender/AstraViewport.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/astra-integration.module.css` | sheet | `components/astra-blender/AstraAgentPanel.tsx`, `components/astra-blender/AstraExportPanel.tsx`, `components/astra-blender/AstraNativeSourcePanel.tsx`, `components/astra-blender/AstraStudio.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/astra-blender/astra-render.module.css` | sheet | `components/astra-blender/AstraRenderPanel.tsx` | Astra Blender workspace (3D): UNOWNED: 3D blocking tool | Thu 8 Oct |
| `components/DragLayer.css` | sheet | `components/DragLayer.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/PreviewLayer.css` | sheet | `components/PreviewLayer.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/PromptAttach.css` | sheet | `components/PromptAttach.tsx`, `components/graphite/production/use-agent-attachments.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/atomik/ModelPicker.module.css` | sheet | `components/atomik/ModelPicker.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/atomik/skills/skills.module.css` | sheet | `components/atomik/skills/ComposerSkills.tsx`, `components/atomik/skills/SkillForms.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/upload-recovery.module.css` | sheet | `components/UploadRecovery.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |
| `components/workspace/rig/rig-verify.css` | sheet | `components/workspace/rig/RigVerify.tsx` | shared widget sheet, no screen of its own: kept: shared widget used by the new screens; restyle review (lead) | Thu 8 Oct |

## 8. Exports and pictures of old screens

| Path | Kind | Imported by | Deleting PR or stream | Target |
|---|---|---|---|---|
| `public/marketing/screens/gen-composer-blank.jpg` | export: screenshot of the Gen composer | `app/(marketing)/site/_pages/gen/index.tsx` | stream 15: deleted with the homepage by `site/guest-home-on` (decision 41); was: stream 15 step 2 (landing page, after the owner's frames) retakes it from the Make panel | after the new screens merge; owner to confirm date (§9) |
| `public/marketing/screens/studio-rig-canvas.jpg` | export: screenshot of the Rig canvas (path label "particl.app / dune-studies / rig": a placeholder name too) | `app/(marketing)/site/_pages/studio/index.tsx` | stream 15 step 2: retake from the board | after the new screens merge; owner to confirm date (§9) |
| `public/marketing/screens/viral-history.jpg` | export: screenshot of Viral History | `app/(marketing)/site/_pages/viral/index.tsx` | stream 15 step 2: retake from the Social board | after the new screens merge; owner to confirm date (§9) |
| `public/marketing/screens/workspace-plans-credits.jpg` | export: screenshot of Workspace > Plans & credits | `app/(marketing)/site/_pages/workspace/index.tsx` | stream 15 step 2: retake from Settings > Plan & credits | after the new screens merge; owner to confirm date (§9) |
| `public/marketing/screens/palette-cmd-k.jpg` | export: screenshot of the old ⌘K palette | `components/marketing/SharedBottom.tsx` | stream 15 step 2: retake from #513's palette | after the new screens merge; owner to confirm date (§9) |

The marketing pictures are old-design exports that depend on the new screens existing, so they cannot go before the demo. Until they are retaken the marketing pages name the old interface inside the picture; stream 15 can drop the five `<Window>` blocks instead if the owner prefers no picture to an old one.

`design/particl-graphite/` is the one design export in the repo (the 4 October handoff). No older Claude Design bundle, round or export is tracked anywhere else: `git ls-files` finds no `.dc.html` or `support.js` outside it.

## 9. No owner yet

Items no stream plan covers. Each needs a name from the lead or an answer from the owner before Thursday.

1. **3D blocking (Astra Blender).** `components/astra-blender/*` (9 files, 3 sheets), `spec/tools/AstraTool.tsx`, `AtomikRunDialog` "Build with Astra" (the Astra outputs page is deleted with the stage pages; the tool itself has no host in `/suites` now), and 49 "Astra" strings. README § 1.2 makes it "a tool on a shot card (Inspector › Advanced)", but no stream plans it. Until someone does, the strings stay in the baseline.
2. **Editors and tool panels the handoff opens as they are** (`components/workbench/` Script, Development, Sound, Sequence color, Movie export, Identity panel, Asset library, Generation dialog; their module sheets). The handoff says "Open Edit & Sound opens the existing editor" and draws no restyle. They read graphite tokens already (most). Decision needed: keep them as tools with a restyle review, or assign each to a stream. Listed in §7 until then.
3. **Primitive sets.** `components/ui/*` (16 files, built from the 3 October README) and `components/workspace/ui/*` (10) are two old component sets; no plan builds a replacement, so the new screens either reuse them or each ship their own. Decide before the flip PR.
4. **Old app pages no frame draws:** `/projects/[id]` and its canvas and element pages, `/takes/[id]`, `/shots/[id]`, `/elements/[id]`, `/studio/shot`, `/atomik/ideas|treatment|breakdown|shots`, `/rig/recipes`, `/workbench/movie` (the `?snapshot=` hand-off from pipeline runs). They retire only if the owner accepts losing them, or Claude Design draws them.
5. **Pages the handoff does not draw and that stay:** `/statements`, `/admin`, `/platform`, `/report`, `/policy`, `/privacy`, `/terms`, `/review/[token]`, the sign-in and billing pages. Listed in §7; they need a restyle onto tokens or a frame. The brief names #515 (the reading floor) for this.
6. **Orphan sweep.** 26 source files and 2 sheets that nothing imports and no route reaches: a one-PR deletion with no behaviour change. Assign it; this inventory proposes Tue 6 Oct. Same PR: four stale docs and one stale line in `brand/atomik/README.md` (§1b).
7. **`lib/` outside `lib/shell/`** holds 117 more retired-name strings in 44 files (`lib/workspace`, `lib/workbench`, `lib/astra-blender`, `lib/suites.ts`, `lib/vendorNames.ts`, …). The guard scans `lib/shell/` only, as briefed. Widening the scan is a one-line change plus a baseline, if the lead wants it.
8. **`docs/particl-sow.md` and `docs/particl-sow-2026-10-04.md`** carry the old suite names and IA; only the owner amends them.
9. **The marketing pictures** (§8) wait for the new screens; the date is the owner's.
10. **The marketing site waits for guest Home.** Its pages, sheets and components (§7) stay until the owner's three guest-Home frames arrive and stream 15 builds step 2. Thursday's target for them is the copy only (`site/copy-names`); the structure has no date until the frames do.
11. **`components/graphite/shell.css` and `four-suites.css`** are loaded by pages the shell streams do not own (the marketing layout, the root layout). The flip PR has to move those imports first.

