repo: axy-full/aimighty-workspace
branch: main
path: components/, app/, lib/workbench/, docs/, tests/

## Last sync
date: 2026-10-02T17:40:00Z
### Updated in this project
- Step 2 of PROMPT.md: Gen built inside the Suites shell (Video · Images · Audio, one composer with Auto/Enhance · 1 cr, Shot control, References well fed by the Library, model sheet, Takes & assets wall grouped by day with File to shot, Seedance Edit, Astra and Topaz upscales) from components/graphite/GenView.tsx + ModelSheet.tsx copy and the earlier Particl Gen.dc.html layout
- Engines limited to the CLAUDE.md rate card (Seedance 2.5/2.0, Kling 3.0 Standard/Pro, Nano Banana 2/Pro, Topaz Astra, ElevenLabs quoted, Identity 54 cr); actions without a card row read "quoted"
- Step 1 follow-ups: suite name "Moleculr Business Suite", Setup hint, Viral motion-library row removed

## Previous sync
date: 2026-10-02T16:55:00Z
### Updated in this project
- Step 1 of PROMPT.md in Particl Suites.dc.html: IA re-read from lib/shell/ia.ts (Atomik = "Atomik Agent", mark AGENT, eight pages incl. Memory and Skills; Business pages Image ads · Setup · Brand · Product · Format · Hooks · Reference · Design; Cast hint "Characters that stay themselves")
- Removed per CLAUDE.md rule 10 / lib/shell/connected-capability.ts: the Higgsfield catalogue model group, the higgsfield-* skills, Business › Ads, Cast's reference elements and Soul ID/Soul Cinema wording
- Rate card re-read from CLAUDE.md § Pricing (unchanged)

## Sync history
- 2026-09-28T12:36:00Z — New Particl Suites.dc.html (Graphite look) rebuilt on the repo's four-suite shell: lib/shell/ia.ts IA, header segment, stage strip, project head, Library (Tools | Assets), Inspector, ⌘K palette, right-click menu with undo, Jobs tray; Studio's ten stages built from components/graphite/production/* copy
- 2026-09-16T06:05:21Z
### Updated in this project
- Rebuilt Particl iPhone.dc.html: Studio mobile (MobileNavigation Home · Workflow · Canvas · Takes · Edit, MobilePanel sheets for workflow / Add to canvas / Node controls / Atomik / settings / project, every stage) + Particl v2 mobile M1–M10 (dock, header, bottom sheets, pinned priced primary, Atomik compact/expanded, slot inspector, New asset, Composer, Settings)
- Overview canvas now shows 30 phone frames alongside desktop
- 2026-09-15T19:40:00Z — Rebuilt Studio (Home + 10 stages + Atomik rail + 12 dialogs) from Studio.tsx, production-graph.tsx, ScriptPanel, SequenceColor, SoundMix, EditVersions, MovieExport, GenerationDialog, AtomikRunDialog; built Gen from GenWorkspace.tsx + tests/gen.spec.ts; Workspace (settings · team · billing · usage · security · activity), pricing/packs from CLAUDE.md, auth flows; Particl v2 routes (productions · project · shots · media · canvas · shot bindings · provenance · rig canvas/recipe/run · pipelines · library · Atomik ideas/treatment/breakdown/shot list · connect/platform/admin)
- Rebuilt Studio (Home + 10 stages + Atomik rail + 12 dialogs) from Studio.tsx, production-graph.tsx, ScriptPanel, SequenceColor, SoundMix, EditVersions, MovieExport, GenerationDialog, AtomikRunDialog, crew.ts
- Built Gen from GenWorkspace.tsx + tests/gen.spec.ts (Composer, Shot control chips, engines/rate card, Takes & assets wall, Seedance Edit, Astra/Topaz)
- Built Workspace (settings · team · billing · usage · security · activity), pricing tiers/packs from CLAUDE.md, auth flows (login · signup · invite · reset · setup · welcome)
- Built Particl v2 routes (productions · project · shots · media · canvas · shot bindings · provenance · rig canvas/recipe/run · pipelines · library · Atomik ideas/treatment/breakdown/shot list · connect · platform · admin · terms/privacy/policy/report) and refreshed iPhone tabs + overview canvas

- 2026-09-15T18:25:10Z — first read of shell, STAGES, Gen workspace, mobile nav; gap analysis vs the public look-around prototype

## Screen map
| Screen (prototype) | Repo source |
|---|---|
| Particl Suites.dc.html · shell | lib/shell/ia.ts, components/graphite/{Header,StageStrip,Library,Inspector,Palette,ContextMenu,JobsTray}.tsx, design/particl-suites/{README,FINAL_SPEC}.md |
| Particl Suites.dc.html · Studio stages | components/graphite/production/{BriefStage,BeatsStage,BeatGraph,EnvironmentStage,CastStage,AstraOutputs,EditStage}.tsx |
| Particl Suites.dc.html · Gen (?view=gen&mode=video|images|audio&task=edit|upscale) | components/graphite/GenView.tsx, ModelSheet.tsx, lib/models.ts, CLAUDE.md § Pricing |
| Particl.dc.html — shell, project bar, Home, stages brief/moodboard/characters/elements/assets | components/workbench/Studio.tsx, lib/workbench/studio.ts, components/workbench/WorkspaceMenu.tsx, components/studio/StudioNavigation |
| Particl.dc.html?stage=canvas | components/workbench/production-graph.tsx, lib/workbench/node-graph.ts |
| Particl.dc.html?stage=script | components/workbench/ScriptPanel.tsx, ScreenplayOcrReview.tsx |
| Particl.dc.html?stage=storyboard | components/workbench/production-crew.tsx (StoryboardPanel) |
| Particl.dc.html?stage=edit | components/workbench/SequenceColor.tsx, SoundMix.tsx, EditVersions.tsx, TimelinePreview.tsx |
| Particl.dc.html?stage=export | components/workbench/MovieExport.tsx, lib/workbench/studio-export.ts |
| Particl.dc.html rail + dialogs run/models | production-crew.tsx (CrewPanel), lib/workbench/crew.ts, AtomikRunDialog.tsx, components/atomik/ModelPicker.tsx |
| Particl.dc.html dialog generate | components/workbench/GenerationDialog.tsx |
| Particl Gen.dc.html | components/make/GenWorkspace.tsx, Composer.tsx, GenAssetLibrary.tsx, SeedanceEdit.tsx, AstraUpscale.tsx, TopazImageUpscale.tsx, components/Studio.tsx (shot control), tests/gen.spec.ts |
| Particl Workspace.dc.html tabs | app/(app)/settings/page.tsx, team/page.tsx, usage/page.tsx, components/management/*, app/(auth)/billing, app/(app)/statements |
| Particl Workspace.dc.html?screen=pricing | app/(auth)/pricing, CLAUDE.md §Pricing |
| Particl Workspace.dc.html auth screens | app/(auth)/login, signup, invite/[code], reset, reset/[token], setup, welcome; components/WelcomeSignIn.tsx, RequestAccess.tsx |
| Particl Productions.dc.html?screen=productions/project/shots/media/canvas | app/(app)/productions/page.tsx, projects/[id]/page.tsx, productions/[prod]/[project]/shots, media, projects/[id]/canvas, components/ProductionNav.tsx |
| …?screen=shot/provenance/rig/recipe/run | app/(app)/shots/[id], takes/[id], rig/canvas/[boardId], rig/recipes, rig/run/[runId]; docs/handoff/nodegraph/README.md; components/ShotBindings.tsx, ProvenanceCard.tsx, ImpactSheet.tsx |
| …?screen=pipelines | app/(app)/pipelines, docs/durable-production-pipelines.md |
| …?screen=library/refs/unfiled | app/(app)/library/page.tsx |
| …?screen=ideas/treatment/breakdown/shotlist | app/(app)/atomik/ideas, treatment, breakdown, shots; components/ModeSwitch.tsx |
| …?screen=connect/platform/admin/terms/privacy/policy/report | app/(app)/connect, platform, admin, terms, privacy, policy, report |
| Particl iPhone.dc.html · Studio (?tab=…&sheet=…) | components/workbench/mobile-ui.tsx (MobileNavigation, MobilePanel), production-graph.tsx (mobile header/list/sheets), app/workbench/mobile.css |
| Particl iPhone.dc.html · v2 mobile (?app=v2&screen=…) | design/particl-v2-mobile/README.md (M1–M10: dock, header, sheets, pinned primary, per-screen notes) |
