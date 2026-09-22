# Handoff: Particl · Graphite redesign — rebuilt from `axy-full/aimighty-workspace`

## Overview
A visual-only redesign of the Particl production studio in an Apple-grade dark aesthetic ("Graphite": pure-black canvas, hairline-separated flat panels, one blue accent, SF-style sans). **Every feature, control and string comes from the repository at `main` (commit tree 585546748fee, read 15 Sep 2026)** — routes, stage names, menu items, dialog copy, rate card, tiers. Nothing was invented; where the code renders data (projects, takes, ledger rows) the prototypes carry the repo's own sample production (*Dune Studies*, `lib/workbench/studio.ts → seedProject()`) plus the Northline sample from `docs/handoff/nodegraph`.

## About the design files
The `.dc.html` files are **design references built in HTML** — click-through prototypes of look and behaviour, not code to ship. Recreate them inside the Next.js app using its existing components (`components/workbench/ui/*`, `components/ui/*`, the management CSS) and keep every endpoint, role and price as they are. Open any file directly in a browser (`support.js` and `ios-frame.jsx` must sit beside it).

Deep links (all files accept URL params):
- `Particl.dc.html?stage=brief|script|moodboard|characters|elements|canvas|storyboard|assets|edit|export` · `?home=1` · `?home=1&welcome=1` · `?dialog=run|generate|models|project|node|reference|shortcuts|connections|review|asset|bins|import` · `?atomik=closed` · `?auth=out`
- `Particl Gen.dc.html?mode=video|images|audio&tab=takes&task=edit|upscale`
- `Particl Workspace.dc.html?tab=settings|team|billing|usage|security|activity` · `?screen=pricing|login|signup|invite|reset|newpw|setup|welcome`
- `Particl Productions.dc.html?screen=productions|project|shots|media|canvas|shot|provenance|rig|recipe|run|pipelines|library|refs|unfiled|ideas|treatment|breakdown|shotlist|connect|platform|admin|terms|privacy|policy|report`
- `Particl iPhone.dc.html?tab=home|workflow|canvas|takes|edit`
- `Particl Canvas.dc.html` — every screen above as live frames.

## Fidelity
**High-fidelity** for visuals and interaction structure. Copy is verbatim from source (`Studio.tsx`, `production-graph.tsx`, `ScriptPanel.tsx`, `SequenceColor.tsx`, `SoundMix.tsx`, `EditVersions.tsx`, `MovieExport.tsx`, `GenerationDialog.tsx`, `AtomikRunDialog.tsx`, `production-crew.tsx`, `crew.ts`, `WorkspaceMenu.tsx`, `AccountMenu.tsx`, `AtomikButton.tsx`, `ModeSwitch.tsx`, `GenWorkspace.tsx`, the `app/(app)` pages, `CLAUDE.md` pricing). Where a component's exact prose was not reachable in source (e.g. the Composer's hint text, section blurbs on the asset stages), the words are the repo's own hints (`STAGES[].hint`) or product docs — flagged as such where they appear.

## Repo → prototype map
| Repo surface | File / param |
|---|---|
| `app/workbench` · `components/workbench/Studio.tsx` (shell, Home, 10 stages, project bar, save/bible banners) | `Particl.dc.html` |
| `production-graph.tsx` (Node studio, library, inspector, versions, wiring, context menus) | `Particl.dc.html?stage=canvas` |
| `ScriptPanel.tsx` / `production-crew.tsx` / `SequenceColor.tsx` / `SoundMix.tsx` / `EditVersions.tsx` / `MovieExport.tsx` | stages script · storyboard · edit · export |
| `GenerationDialog.tsx` · `AtomikRunDialog.tsx` · `ModelPicker.tsx` · `design-review.tsx` | dialogs generate · run · models · review |
| Atomik rail (`CrewPanel`, Genie/Crew/Context, `⌘J`) | `Particl.dc.html` right rail |
| `components/make/*` (Composer, GenAssetLibrary, SeedanceEdit, Astra/Topaz upscale) | `Particl Gen.dc.html` |
| `app/(app)/settings` · `team` · `usage` · `app/(auth)/billing` · `pricing` · `account/security` · `management/*` | `Particl Workspace.dc.html` |
| `app/(auth)/login` · `signup` · `invite` · `reset` · `setup` · `welcome` | `Particl Workspace.dc.html?screen=…` |
| `app/(app)/productions` · `projects/[id]` · `…/shots` · `…/media` · `…/canvas` · `shots/[id]` · `takes/[id]` | `Particl Productions.dc.html` |
| `app/(app)/rig/*` (`docs/handoff/nodegraph`) · `pipelines` · `library` | `Particl Productions.dc.html?screen=rig|recipe|run|pipelines|library` |
| `app/(app)/atomik/ideas|treatment|breakdown|shots` · `connect` · `platform` · `admin` · `terms|privacy|policy|report` | `Particl Productions.dc.html?screen=…` |
| `components/workbench/mobile-ui.tsx` (Home · Workflow · Canvas · Takes · Edit, sheets) | `Particl iPhone.dc.html` |

## Design tokens (Graphite, dark only)
Colors — root `#000000`; panel `#0D0D10`; card `#17171B` + `1px rgba(255,255,255,0.10)`; input/tile `#1B1B1F` + `rgba(255,255,255,0.08)` (hover `#26262B`); segment track `#1C1C20`, selected `#3A3A40`; hairline strong `rgba(255,255,255,0.09)` (1px gaps between flat panels), hairline `rgba(255,255,255,0.08)`, dashed `rgba(255,255,255,0.16)`; text `#F5F5F7` / `rgba(235,235,245,.6)` / `.45–.5` / `.4` eyebrow / `.35`; accent `#0A84FF` (hover `#2D95FF`), accent text `#6EB4FF`, tint `rgba(10,132,255,0.14)`, selection ring `0 0 0 3px rgba(10,132,255,0.22)`; success `#30D158`/`#4CD964`; warning `#FF9F0A`/`#FFB340`.
Type — `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Geist, system-ui, sans-serif`; mono `ui-monospace, Menlo`. Display 36–44/600/−0.035em · page h1 26–32/600 · panel title 14–15/600 · body 13 · controls 12/500 (primary 600) · meta 11 · eyebrow 10/500/+0.1em uppercase · mono numerals 10–12. No serif anywhere.
Radii — panels 0 (hairline-separated) · cards/popovers 8 · buttons/inputs 6 · segment track 6 / button 4 · pills 999 · iPhone cards 12, sheet top 18.
Motion — `cubic-bezier(.2,.7,.2,1)`; screen change fade+6px 400ms; cards pop 300ms; segments 200ms; Atomik rail slide 300ms; genie glow breathes 3s; render progress bar 2.4s.

## Interactions carried over from code
Stage rail groups (Develop 01–02 · Create 03–05 · Finish 06–10) · Atomik `⌘J` with `Ask Atomik` → `Atomik · RUNNING/PLAN` states · project switch + Publish project bible (version bump) · save state (Saving/Saved/Not saved + Retry/Download current work) · bible-conflict banner (`Save & load latest shared context`) · Scene breakdown checkboxes → `Build N scene nodes` · node lock/duplicate/remove, port-to-port wiring with `Esc` cancel, bypass, department, tool stack (Grade/Transform/Mask/Mix/Direction sliders), versions · `Generate a new take` → budget-exhausted error → `Recover submitted take` (same request, no second charge) · `Plan with Genie` quote (2 cr / 8 cr at High effort) → plan card → `Build in my space` · Edit timeline with playhead, Sequence look/LUT, Named cuts, Sound mix lanes · Delivery package/EDL/Final movie · Gen render disabled until a prompt exists, quote on the button, reference video raises the quote and blocks Seedance 2.0, Seedance Edit `Review edit cost` → `Generate edit · 24 cr` → interrupted → `Recover edit` · Takes wall grouped by day with File to shot / Use prompt / Edit / Upscale · Workspace save/discard with Unsaved changes, invitations, ledger filters, packs, tiers with annual −20%.

## Files
`Particl.dc.html` · `Particl Gen.dc.html` · `Particl Workspace.dc.html` · `Particl Productions.dc.html` · `Particl iPhone.dc.html` · `Particl Canvas.dc.html` · `support.js` + `ios-frame.jsx` (runtime) · `github.md` (source map) · `particl-feature-map.md` (original public-site inventory, superseded by the repo map).


## Mobile (added 2026-09-16)
Particl iPhone.dc.html now covers every phone screen:
- Studio (workbench mobile): ?tab=home|brief|script|moodboard|characters|elements|canvas|storyboard|takes|edit|export · &sheet=workflow|library|inspector|atomik|settings|project
- Particl v2 mobile M1–M10: ?app=v2&screen=productions|media|make|rig|run|library|settings · &v2tab=Shots|Boards|Approve|Media · &sheet=atomik|shotMenu|slot|newAsset|composer
- Mobile rules: header 52px, ≥44pt targets, bottom sheets (#0F1116, 36×4 grabber, scrim rgba(5,6,8,.55)), one pinned priced primary per screen (outlined while a sheet is open), 2-up grids, edge-bleeding pill rows.
Particl Canvas.dc.html shows all desktop + 30 phone frames; each label opens the live screen.
