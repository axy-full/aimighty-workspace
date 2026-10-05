repo: axy-full/aimighty-workspace
branch: main
path: components/, app/, lib/, docs/, CLAUDE.md

## Last sync
date: 2026-10-04T15:40:00Z
### Updated in this project
- Round "the board, made easy" complete (steps 1–8 of PROMPT.md) in Particl Suites.dc.html: header option B (Home · project · Make · Atomik), one Studio board per production with the outline rail, Ads and Social boards, Make as a panel, Atomik everywhere (⌘K, panel, control room in four places, Settings in five sections), the phone (judge, not make); README.md rewritten as the single handoff (IA old → new, tokens, every screen and state, actions, money rules, keys, names, placeholders, open decisions)
- Rate card re-read from CLAUDE.md § Pricing: Seedance 2.5 8.6 cr/s at 1080p (43 cr · 5 s), Kling 3.0 Standard 1.4 cr/s (7 cr · 5 s), Nano Banana Pro 3 cr, Nano Banana 2 1 cr, Topaz Astra 23/38 cr per 5 s, identity training 54 cr, enhance 1 cr; ElevenLabs and Atomik thinking shown as live estimates ("up to N cr")
- Money rules from lib/approvalRule.ts (the 200 cr platform line) re-stated with this round's 40 cr per-shot admin rule, the 80 % budget pause, Ask/Auto and the fix allowance (README § 5)

## Previous sync
date: 2026-10-04T10:12:36Z
### Updated in this project
- Step 1 system pass (names, type floor, prices as "N cr" / "up to N cr" / "free"); step 3 of the earlier PROMPT: Atomik's eight pages from lib/shell/ia.ts, lib/shell/tools-connections.ts, lib/approvalRule.ts, docs/atomik-model-policy.md, docs/atomik-models.md, components/graphite/AtomikGate.tsx, components/graphite/atomik/*; step 2: Gen in the Suites shell from components/graphite/GenView.tsx + ModelSheet.tsx

## Sync history
- 2026-10-02T16:55:00Z — Step 1 of the earlier PROMPT: IA from lib/shell/ia.ts; Higgsfield catalogue, higgsfield-* skills, Business › Ads and Soul wording removed per CLAUDE.md rule 10 / lib/shell/connected-capability.ts
- 2026-09-28T12:36:00Z — Particl Suites.dc.html (Graphite) rebuilt on the four-suite shell; Studio's ten stages from components/graphite/production/*
- 2026-09-16T06:05:21Z — Particl iPhone.dc.html rebuilt from components/workbench/mobile-ui.tsx and design/particl-v2-mobile
- 2026-09-15T19:40:00Z — Studio, Gen, Workspace, Particl v2 routes rebuilt from components/workbench/*, components/make/*, app/(app)/*
- 2026-09-15T18:25:10Z — first read of shell, STAGES, Gen workspace, mobile nav

## Screen map
Each screen of Particl Suites.dc.html → the repo source it replaces (→) or extends (+).

| Screen (URL) | Repo source |
|---|---|
| Header B, suite pill, Jobs, credits, avatar menu (every screen) | → components/graphite/Header.tsx, StageStrip.tsx (removed: no stage strip); lib/shell/ia.ts (replaced by README § 1) |
| Home (?view=home) | → app/(app)/productions/page.tsx, components/workbench/Studio.tsx (Home); + components/ProductionNav.tsx |
| Studio board canvas, rail, tool pill, zoom/minimap/list (?view=board) | → components/workbench/production-graph.tsx, lib/workbench/node-graph.ts (the Rig), app/(app)/rig/canvas/[boardId]; docs/handoff/nodegraph/README.md |
| Board › Brief and questions (frame=b, d) | → components/graphite/production/BriefStage.tsx, components/workbench/ScriptPanel.tsx; app/(app)/atomik/ideas, treatment |
| Board › Looks and Storyboard, List view (frame=c, d) | → components/graphite/production/BeatsStage.tsx, BeatGraph.tsx, components/workbench/production-crew.tsx (StoryboardPanel); app/(app)/atomik/breakdown, shots |
| Board › Approval card, pause card (frame=e, f2) | + components/graphite/AtomikGate.tsx, AtomikRunDialog.tsx, lib/approvalRule.ts |
| Board › Shots rendering, take card, Inspector, Review mode (frame=f, g, k, l) | → app/(app)/shots/[id], takes/[id], components/ShotBindings.tsx, ProvenanceCard.tsx, components/graphite/Inspector.tsx |
| Board › Cast, Environment, Elements, consent (frame=h) | → components/graphite/production/CastStage.tsx, EnvironmentStage.tsx; + a consent record (new) |
| Board › 3D blocking (Inspector › Advanced) | → components/graphite/production/AstraOutputs.tsx |
| Board › Cut and Deliver (frame=i) | → components/graphite/production/EditStage.tsx, components/workbench/SequenceColor.tsx, SoundMix.tsx, EditVersions.tsx, MovieExport.tsx, lib/workbench/studio-export.ts |
| Board › Crew review (frame=m) | → components/workbench/production-crew.tsx (CrewPanel), lib/workbench/crew.ts |
| Board › Project record (frame=n), History drawer (frame=p) | + app/(app)/pipelines, docs/durable-production-pipelines.md; app/(app)/statements |
| Board › Library drawer (frame=o) | → components/graphite/Library.tsx, app/(app)/library/page.tsx, components/make/GenAssetLibrary.tsx |
| Make panel, type switch, engine line, fill, made, Recent (make=…) | → components/make/GenWorkspace.tsx, Composer.tsx, components/graphite/GenView.tsx, ModelSheet.tsx, lib/models.ts; Seedance Edit / upscales → components/make/SeedanceEdit.tsx, AstraUpscale.tsx, TopazImageUpscale.tsx (now card actions) |
| Make › Motion transfer, Object swap (make=motion, swap) | → the Subatomik Viral Studio pages (lib/shell/ia.ts viral), components/graphite/viral/* |
| Ads board (kind=ads&frame=1–3) | → the Moleculr Business Suite pages (lib/shell/ia.ts business), components/graphite/business/*; poster Designer → the Design page |
| Social board (kind=social&frame=1–2) | + new (clips, hook review, effects, narrated video, posts); publishing → app/(app)/connect |
| ⌘K (palette=1&q=…) | → components/graphite/Palette.tsx; + Atomik commands (new) |
| Atomik panel, Ask Atomik how (atomik=1, how) | → components/graphite/atomik/*, AtomikRunDialog.tsx, components/atomik/ModelPicker.tsx |
| Control room › Approvals, Activity, Skills, Memory (?suite=atomik&page=…) | → components/graphite/atomik/{Memory,Skills,Tools}View.tsx, lib/shell/tools-connections.ts, lib/approvalRule.ts; Budget/Models/Tools tabs fold into Settings |
| Settings › Team, Plan & credits, Spending rules, Connections, Advanced (?view=workspace&ws=…) | → app/(app)/settings/page.tsx, team/page.tsx, usage/page.tsx, components/management/*, app/(auth)/billing, app/(auth)/pricing, CLAUDE.md § Pricing; MCP → mcp/README.md, app/(app)/platform |
| Phone (?device=phone&screen=…) | → components/workbench/mobile-ui.tsx (MobileNavigation, MobilePanel), app/workbench/mobile.css, design/particl-v2-mobile/README.md |
