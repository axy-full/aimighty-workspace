repo: axy-full/aimighty-workspace
branch: main

## Last sync
date: 2026-09-22T09:40:00Z
### Updated in this project
- Glass theme: Particl macOS 27.dc.html (desktop, Liquid Glass islands, capsule controls) and Particl Mobile iOS 27.dc.html (floating tab bar, Home = suite picker); Crew first pass
- Wrote design_handoff_particl_suites/GLASS_SPEC.md (--gl-* layer over --gx-*, radii rules, mobile Home) + CLAUDE_CODE_PROMPT_GLASS.md

## Sync history
- 2026-09-21T18:32:00Z — delta spec against the shipped Graphite shell; FINAL_SPEC.md + CLAUDE_CODE_PROMPT_FINAL.md
- 2026-09-21T10:56:39Z — Business = Marketing Studio, Viral = Genjutsu, Atomik = supercomputer; one balance; per-second length; draggable assets
- 2026-09-21T10:05:00Z — Graphite design re-wired to the four-suite workflow; Gen with the Higgsfield catalogue and prompt enhancer
- 2026-09-21T09:31:00Z — first read of the four-suite IA, shell, composer pricing and the higgsfield-ai/skills catalogue; neumorphic prototype

## Screen map
| Screen | Built from |
|---|---|
| Shell: rail, top bar, ⌘K, Assets drawer | components/workspace/WorkspaceShell.tsx, TopBar.tsx, Palette.tsx, Library.tsx, lib/workspace/palette.ts |
| Create (composer + results + prompt enhancer + model sheet) | components/workspace/GenerateComposer.tsx, lib/workspace/composer.ts, lib/models.ts (rates via CLAUDE.md), higgsfield-ai/skills model-catalog.md + prompt-engineering.md |
| Studio (8 stages) | lib/suites.ts PAGES.particl, lib/workspace/pages.ts, lib/workspace/spec-cards.ts, components/workspace/pages/* |
| Apps (Moleculr + Subatomik + tools + Higgsfield workflows) | lib/suites.ts (moleculr, subatomik), spec-cards.ts marketing/motion/swap/sources/compare/history, components/make/* upscales, higgsfield workflows.md |
| Assets | components/workspace/Library.tsx, app/(app)/library/page.tsx, README uploads section |
| Atomik (runs, recipes, approvals, budget, models, skills, builds) | lib/workspace/pages.ts PAGES.atomik, spec-cards.ts atomik pages |
| Workspace (general, team, credits, usage, engines, security) | app/(app)/settings, team, usage, billing; components/management/* ; docs/higgsfield-soul-integration.md |
