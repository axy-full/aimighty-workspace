# Claude Code prompt — paste this as the first message

Read `design_handoff_particl_suites/README.md` in full before writing any code, then implement the redesign in this repository.

## What you are building
Replace the current four-suite UI of `axy-full/aimighty-workspace` with the **Particl Suites** shell exactly as shown in `design_handoff_particl_suites/Particl Suites.dc.html` (open it in a browser — it is a click-through design reference, not code to copy). Screenshots of every screen are in `design_handoff_particl_suites/screenshots/` (captured at 924px, i.e. the narrow overlay layout; ≥1280px is three columns as the README describes).

Non-negotiables (from the README):
1. **One shell.** Header (particl trail mark · Studio | Gen | Business | Viral | Atomik segment · ⌘K search · credits pill · avatar), a numbered stage strip per suite, and a three-column body: Library (280px, Tools | Assets) · stage · Inspector (320px, ⌘J). Below 1280px the side panels become overlays toggled from the project head.
2. **One composer.** Every tool/app is a preset that opens Gen (or the page's own composer) pre-configured. No second interface anywhere.
3. **One credit balance.** Remove every "workspace credits vs connected account" toggle. Quotes are shown live, in `cr`, on the button.
4. **Assets on every page.** Library › Assets is always present; every asset tile is `draggable` (`text/plain` = asset id) and can be dropped on any reference well or Rig node.
5. **Every card is a button.** Cards, tool rows and list rows route somewhere (a Gen preset, another stage, or a detail in the Inspector). Nothing ends in a toast alone.
6. **Graphite tokens only** (README › Design tokens): `#000` root, `#0D0D10` panels, `#17171B` cards with `1px rgba(255,255,255,0.10)`, `#1B1B1F` inputs, accent `#0A84FF`, text `#F5F5F7`, SF/Geist, radii 8/6/4, easing `cubic-bezier(.2,.7,.2,1)`. No gradients on UI, no shadows except the context menu, flat thumbnails.

## Suites and pages
- **Studio**: 01 Brief · 02 Boards · 03 Cast · 04 Astra · 05 Rig · 06 Takes · 07 Edit · 08 Deliver. Rig is a node graph with **typed ports** (Image `#0A84FF`, Direction `#F5F5F7`, Colour `#FF9F0A`, Take `#30D158`, Audio `#BF5AF2`): click output → click type-matching input to wire, mismatches refused, Esc cancels, click a wired input to unplug, **lasso** on empty canvas (⇧ adds, Group/Bypass/Clear pill), drop assets on nodes, Inspector › Inputs/Versions read the live wiring. Also a List view of shots.
- **Business** = Higgsfield Marketing Studio only: 01 Ads (`marketing_studio_video`: 9 modes, product incl. Click-to-Ad URL, avatar, hook, setting, ad reference, aspect, 15/30 s, 480p/720p, audio, ≤14 reference stills with roles `image|start_image|end_image`), 02 Image ads (`dtc-ads generate`: ad format **required**, brand kit, product ≤1, avatar ≤1, aspect, 1k/2k/4k, quality, batch 1–20), 03 Setup (products, avatars, hooks, settings, ad references, brand kits). Enforce: hooks/settings only for `ugc, ugc_how_to, ugc_unboxing, product_review, ugc_virtual_try_on`, and never together with an ad reference — disabled chips with a tooltip, not hidden.
- **Viral** = Higgsfield Genjutsu only: 01 Motion Transfer (`genjutsu/motion-transfer/v1.0`), 02 Object Swap (`genjutsu/object-swap/v1.0`) — exactly one source video 4–30 s + up to 30 **ordered** reference images, 480p/720p/1080p, optional prompt, live estimate required (stale/missing blocks submit) — and 03 History.
- **Atomik** = the supercomputer: 01 Agent (chat + plan card with per-step price and Approve), 02 Runs, 03 Approvals, 04 Budget, 05 Models, 06 Skills (the `higgsfield-ai/skills` packs).
- **Gen**: Video | Images | Audio | 3D; model sheet (Studio engines · Higgsfield catalogue); prompt with `@name` citations and `raw:` bypass; references well with per-model roles; aspect and resolution chips; **Length as a `<select>` of every second 4–30 s** for any video engine (clamp server-side per engine and show the clamped value); Generate audio toggle; Takes stepper 1–4; Results grid with progress rings.
- **Workspace**: General (incl. **Prompt enhancer: Higgsfield | Claude | OpenAI**), People, Plans & credits, Usage, Engines, Security.

## Cross-cutting behaviour
- **Prompt enhancer** in every composer: *Enhance* button + *Auto* toggle; result card with *Use this* / *Keep mine*; 1 cr; never on `raw:` prompts. New `POST /api/prompt/enhance { prompt, provider, model, mode }` routing to Higgsfield `enhance_prompt`, Anthropic or OpenAI per the workspace setting. Instruction for all providers: one concrete prompt ordered *subject + setting + style; camera (lens, angle, motion verbs for video); lighting; medium*; keep `@Image1/@Video1/@name` verbatim; < 80 words; negatives phrased positively; output only the prompt.
- **Right-click menu everywhere** (suppressed in inputs): Copy ⌘C · Cut ⌘X · Paste ⌘V · Duplicate ⌘D · — · [asset: Use as reference · Open in Inspector] [node: Bypass · Unplug all inputs] · Move to… · Retry ⌘R · — · Delete ⌫ · Undo ⌘Z; on empty space add Generate here… · Open Library · Toggle Inspector. Target = nearest `[data-ctx="asset:id|node:id"]`, else the current selection. Every mutation pushes an inverse onto a 20-deep undo stack. Position at the cursor, flip/clamp to the viewport, close on click-away/Esc. Shortcuts work without the menu when focus is not in a field.
- **⌘K palette**: Generate, suites, every page, Workspace, models, assets, "Ask Atomik: …"; Enter runs the top hit.
- **Jobs**: submit → running pill in the header → progress ring in Results → take prepended to assets with `NEW`, toast "… saved to Takes · x cr settled", credits debited; failed renders never billed. Blocked states show the reason inline next to the disabled button.

## How to work
- Use the existing Next.js app-router structure, `components/workbench/ui/*` and `components/ui/*`, TypeScript, and the existing routes, actions and rate card (`CLAUDE.md`, `lib/workspace/composer.ts`). Keep all current endpoints, roles and prices; add only the enhancer route and the Higgsfield composer routes listed under README › Backend contracts.
- Follow README › **Suggested build order** (shell → Gen → assets/drag-drop → Studio + Rig → Business/Viral → Atomik/Workspace). Ship each step as a working, navigable increment; do not leave dead buttons.
- Match the prototype's copy verbatim; match tokens and spacing exactly; keep every string the README marks as sample data behind real data.
- Before you finish each step, open the prototype side by side and diff behaviour: navigation, drag/drop, wiring, lasso, context menu, enhancer, quotes.
- Ask me only when the README and the prototype genuinely disagree; otherwise the README wins.

Start by reading the README, then list the files you plan to create or change for step 1 (the shell) before coding.
