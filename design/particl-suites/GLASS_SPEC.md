# Particl · Glass — macOS 27 desktop + iOS 27 mobile (handoff v4, 22 Sep 2026)

**Repo:** `axy-full/aimighty-workspace`. **Supersedes** `FINAL_SPEC.md §6 (flair layer)` and `MOBILE_ADDENDUM.md` for visuals. IA, contracts, backend wiring and the order of work in `FINAL_SPEC.md §1–5` stay exactly as they are — this document changes **only the material and the mobile Home**.

## Files
- `Particl macOS 27.dc.html` — desktop, every screen and action, Liquid Glass. Open beside the app at 1440 and 1180.
- `Particl Mobile iOS 27.dc.html` — mobile web app in an iPhone frame; Home is the suite picker.
- `Particl Crew macOS 27.dc.html` — Crew room in the same material (first pass; inherits everything below).
- `support.js`, `image-slot.js`, `ios-frame.jsx` must sit beside them.

## 1 · The material (both platforms)

Implement as **one new CSS layer** `app/glass.css` loaded after `app/graphite.css`; keep every `--gx-*` token, add `--gl-*` and swap the surfaces. Nothing in component logic changes.

```
--gl-wallpaper: radial-gradient(1200px 700px at 12% -10%,#1D3A73 0%,rgba(29,58,115,0) 60%),
                radial-gradient(1000px 600px at 95% 0%,#4A1E6B 0%,rgba(74,30,107,0) 55%),
                radial-gradient(900px 700px at 50% 115%,#0E3F4F 0%,rgba(14,63,79,0) 60%),
                linear-gradient(180deg,#07070C,#0B0B12);          /* the ground the glass refracts */
--gl-panel:     rgba(28,28,34,0.55);   /* islands: toolbar, Library, stage, Inspector */
--gl-panel-2:   rgba(28,28,34,0.72);   /* dialogs, menus, ports */
--gl-sheet:     rgba(28,28,34,0.78);   /* iOS bottom sheets */
--gl-overlay:   rgba(24,24,30,0.86);   /* narrow-width Library/Inspector overlays over busy content */
--gl-blur:      blur(40px) saturate(180%);        /* islands, dialogs, sheets */
--gl-blur-sm:   blur(12px);                       /* badges, avatar, port cores */
--gl-scrim:     rgba(6,6,12,0.45) + blur(18px) saturate(140%);
--gl-edge:      1px solid rgba(255,255,255,0.14); /* island border */
--gl-spec:      inset 0 1px 0 rgba(255,255,255,0.20);            /* specular top edge */
--gl-lift:      0 18px 50px rgba(0,0,0,0.45);     /* island shadow; dialogs 0 24px 70px .55 */
--gl-fill-1:    rgba(255,255,255,0.06)  border rgba(255,255,255,0.12)   /* cards */
--gl-fill-2:    rgba(255,255,255,0.07)  border rgba(255,255,255,0.12) + inset 0 1px 0 rgba(255,255,255,0.10)  /* inputs, tiles, secondary buttons */
--gl-fill-3:    rgba(255,255,255,0.03)  /* thumbnail wells */
--gl-hover:     rgba(255,255,255,0.13)
--gl-card-grad: linear-gradient(180deg,rgba(255,255,255,0.09),rgba(255,255,255,0.04))  /* raised cards */
--gl-thumb:     linear-gradient(180deg,rgba(255,255,255,0.28),rgba(255,255,255,0.16)) + 0 2px 8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.12)  /* selected segment thumb */
--gl-track:     rgba(255,255,255,0.07) border .12, inset 0 1px 0 rgba(255,255,255,0.12), inset 0 2px 6px rgba(0,0,0,.35), padding 4px, radius 999
--gl-dashed:    rgba(255,255,255,0.04) + 1px dashed rgba(255,255,255,0.22)   /* drop wells */
--gl-primary:   linear-gradient(180deg,#5FAAFF,#0A84FF 60%,#0A6FE0); inset 0 1px 0 rgba(255,255,255,.32), 0 8px 22px rgba(10,132,255,.35); hover brightness(1.08)
--gl-badge:     rgba(20,20,26,0.55) + blur(12px) + border rgba(255,255,255,0.14), radius 999   /* kind/duration badges on thumbnails */
--gl-new:       linear-gradient(180deg,#5FAAFF,#0A84FF) + inset 0 1px 0 rgba(255,255,255,.35)   /* NEW badge */
```

**Radii (concentric):** islands 22 · dialogs/menus/sheets 16–20 (iOS sheet top 30) · cards 14–16 · Rig nodes 16 · thumbnails 12 · poster tiles 12 · tag tiles 12 (36–40px squares) · icon buttons 10–11 (28–32px squares) · **all controls, chips, segment tracks and thumbs, badges, list rows in menus: 999 (capsule)**. Rule: anything that is a *box with content* (thumbnail, well, node, card, lane) keeps a 12–16 radius; anything you *press* is a capsule.

**Hairlines are gone.** Panels no longer touch: desktop islands sit on the wallpaper with **10px gutters**; the only remaining 1px lines are the island edges (`--gl-edge`) and row dividers `rgba(255,255,255,0.06)`.

**Text** unchanged (`#F5F5F7`, `.6/.45/.35` secondaries); accent `#0A84FF`, accent text `#6EB4FF`; status dots unchanged.

**Header aurora** stays but at ~35 % / 28 % opacity so it reads as a tint inside the glass, not paint on black. Suite tints, dot grid, gradient baseline and mark glow carry over from `FINAL_SPEC §6`.

**Fallback:** where `backdrop-filter` is unsupported (`@supports not (backdrop-filter: blur(1px))`), raise the panel alphas to .92 and drop the blur — the layout is identical.

## 2 · Desktop — macOS 27 (`Particl macOS 27.dc.html`)

Same IA as `FINAL_SPEC` (Studio · Gen · Business · Viral · Atomik · Crew; Workspace). What changes:

- **Window**: root paints `--gl-wallpaper`. Four floating islands: **toolbar** (64px, margin 10 10 0, radius 22), **stage capsule** (48px, margin 10 10 0, radius 999, `rgba(28,28,34,0.45)`), then the body grid `[Library 280] [stage 1fr] [Inspector 320]` with `gap:10px; padding:10px`. Each island = `--gl-panel` + `--gl-blur` + `--gl-edge` + `--gl-spec` + `--gl-lift`, radius 22.
- **Suite picker** and every segmented control = `--gl-track` capsule with `--gl-thumb`. Suite glyphs, signature dots and colour logic unchanged.
- **Controls**: header buttons 32px capsules; page primary 34px capsule; Gen *Generate* 44px capsule `--gl-primary`; chips 28px capsules; toggles unchanged (34×20).
- **Cards** `--gl-card-grad` + `--gl-edge`; **inputs/tiles** `--gl-fill-2`; **drop wells** `--gl-dashed`; thumbnails 12px on `--gl-fill-3`; selection ring `0 0 0 2px #0A84FF, 0 0 0 5px rgba(10,132,255,.22)` at radius 12.
- **Rig**: node cards radius 16 with `blur(24px) saturate(160%)`; ports 14px with `--gl-panel-2` core + `blur(8px)` and the type-coloured 1.5px ring; edges, lasso, wiring unchanged.
- **⌘K palette, model sheet, context menu**: `--gl-panel-2` + `--gl-blur`, radius 16–20, over `--gl-scrim`; menu rows are 30px capsules.
- **Library › Tools** framed groups keep their department-tinted 36px tag tiles (radius 12); tab thumbs are capsules; kind-dot chips are capsules.
- **Narrow (<1280)**: Library/Inspector overlays use `--gl-overlay`, inset 10px top/bottom, radius 22, shadow `0 24px 70px rgba(0,0,0,.6)`.
- **Inspector** still hides three ways (`×`, page-head toggle, `⌘J`); still preview is the fixed 180px card.

## 3 · Mobile — iOS 27 (`Particl Mobile iOS 27.dc.html`)

Breakpoint `< 768px`, safe-area aware. Everything below is what the prototype does.

**Shell**
- Root paints `--gl-wallpaper`. **Top bar** is a floating island (margin 50 10 0 under the status bar, radius 24, `--gl-panel`): particl mark + context badge (HOME · STUDIO · GEN · BUSINESS · VIRAL · ATOMIK · CREW · ASSETS · WORKSPACE), credits (mono), avatar; second row = project poster switcher + save state.
- **Tab bar** is a floating glass capsule: `left/right 12px, bottom 22px, height 66px, padding 6px, radius 999`, `--gl-panel` + `--gl-blur` + edge + spec + lift. Five tabs: **Home · Gen · Suites · Assets · More**. Active tab = capsule pill `linear-gradient(180deg,rgba(255,255,255,0.26),rgba(255,255,255,0.12))`, `0 4px 14px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.28)`, white icon with `drop-shadow(0 0 6px rgba(10,132,255,.8))`, white 10.5px label. Content scroll regions carry `padding-bottom: 110px` so nothing hides under the bar.
- **Sheets** slide up (`om-up .32s`): `--gl-sheet` + `--gl-blur`, radius 30 30 0 0, top edge `rgba(255,255,255,0.18)`, grabber 36×5 at `.25`, over `--gl-scrim`.
- Tap targets ≥ 44px everywhere; chips 44px tall on mobile.

**Home = the suite picker (new).** Eyebrow = project name; display title **"Where to?"** (34/700/−0.04em, gradient text). A 2-column grid of **suite tiles**, min-height 158, radius 22, `--gl-card-grad` + edge + `inset 0 1px 0 rgba(255,255,255,.14), 0 14px 34px rgba(0,0,0,.4)`; each tile: a colour glow blob top-right (`blur(28px)`, colour at 40 %), a 44px icon tile (radius 14, `linear-gradient(160deg,<c>CC,<c>66)`, glow `0 8px 20px <c>55`), name 19/700, one-line description, and a **live fact** in mono in the suite colour:
- **Studio** `#0A84FF` — "Brief to delivery, eight stages." · fact `n of 8 done` → opens the Studio stage grid (the old home) with a *Home* back button.
- **Gen** `#BF5AF2` — "Video, images, audio, 3D — one composer." · fact `n rendering` / `Seedance 2.5 ready` → Gen tab.
- **Business** `#FF9F0A` — "Marketing Studio: product, presenter, ad." · `UGC · 15 s · 40 cr` → Suites tab, Business.
- **Viral** `#FF453A` — "Genjutsu: motion transfer, object swap." · `1 source · 22 cr` → Suites, Viral.
- **Atomik** `#30D158` — "Plans, prices, waits for your word." · `n awaiting approval` → Suites, Atomik.
- **Crew** `#BF5AF2` — "One Grok agent per department." · `7 seats` → Suites, Crew (hidden when `showCrewTab` is false).
Below the grid one 56px capsule row **Assets · n in <project> ›**. Nothing else on Home — no stage grid, no "up next", no recent takes; those live behind Studio and Assets.

**Studio (behind the Studio tile)**: the eight stage cards (2-col, 96px, glass, glowing status dot), *Up next* card with the quoted Generate, Recent takes. Stage screens, Takes, Gen composer (sticky Generate CTA), Business/Viral composers, Atomik lists, Assets grid with kind-dot filter chips, More (enhancer selector Higgsfield | Claude | OpenAI, packs, People/Usage/Engines/Security rows) — all as before, re-skinned with §1.

## 4 · Implementation notes for the repo

- Put the wallpaper on the shell root (`components/graphite/SuitesShell.tsx` wrapper) and make `Header`, `StageStrip`, `Library`, the stage `<main>` and `Inspector` islands; replace the `1px` grid gap with `10px` + `10px` padding.
- `backdrop-filter` on five simultaneous islands is fine on Apple GPUs; on Windows/Chromium keep blur ≤ 40px and avoid nesting blurred elements more than two deep (badges inside cards inside islands is the maximum in the prototype).
- Keep `--gx-*` for spacing/type; the glass layer only overrides `background`, `border`, `box-shadow`, `border-radius`, `backdrop-filter`.
- Mobile: implement Home as a new route/view (`view: 'home'`) that the bottom tab **Home** and the top-bar mark both return to; `studioStages` state opens the old home as *Studio*.
- Motion tokens unchanged (`om-in`, `om-pop`, `om-up`, `om-fade`, `om-drift`, `om-breathe`).

## 5 · Acceptance
Desktop at 1440: wallpaper visible in 10px gutters; four islands with specular top edge; every control a capsule, every thumbnail 12px; ⌘K and model sheet are glass over a light scrim; context-menu rows are capsules; Rig nodes glass with glass-cored ports. Mobile at 402×874: Home shows only "Where to?" + six tiles + Assets row; tab bar floats 22px above the bottom with the active pill; Studio tile opens the stage grid with a *Home* back; sheets are glass; nothing hides under the tab bar.
