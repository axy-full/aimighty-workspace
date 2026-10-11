<!-- Research for the redesign build, 10 Oct 2026: read-only reading of design/particl-prototype-12 (line refs L… are to "Particl prototype.dc.html"). Facts, not decisions: docs/redesign-plan.md decides. -->
# Particl prototype v12: build inventory

Source: `/home/agent/design-inbox/proto12/particl-prototype-12/` (README.txt, CHANGES.txt, `Particl prototype.dc.html`, `Prototype v12 screens.dc.html`, support.js). I read it as text only; nothing was executed. Previous design: `design/particl-graphite/` (README.md, PROMPT.md, CHANGES.txt, Gaps A/B READMEs, github.md, *.dc.html).

Conventions:
- **URL** means `Particl prototype.dc.html` followed by the query shown.
- **L###** is a line number in `Particl prototype.dc.html`. The file has 857 lines and some are very long: the template is L33–L400 and the logic is L401–L855.
- **[PRICE]** marks a number that must come from the live quote engine, the ledger or plan config, never a literal (see § 12).
- `support.js` is byte-identical to graphite's (the DC runtime). It is not app code.
- The prototype defines **no CSS variables**. Every style is inline. The token list in § 3 was derived by counting the values used.
- Some computed values in the logic are **never rendered** by the template (dead code): `jobs` (running list with time left), `proposal*` (Atomik proposes stages), `autoLabel`, `nowText/hasNext`, `kindDimmed`, `templates`, `oneSeg`, `creditsTitle`, `toolsOpen`, `menuAt`. Build from the README's intent, not from these.

---

## 1 · Every URL parameter the code reads

All params are parsed in the constructor (L405–L428). After the first interaction, `syncUrl` (L432–L433) pushState-rewrites the URL to the canonical form `?view=…&project=…&stage=…&frame=N|card=id`. `readUrl` (popstate) reads only view, project, stage, frame and card.

| Param | Values | Effect | Notes |
|---|---|---|---|
| `view` | `home` (default) · `make` · `board` · `library` · `billing` | page | `billing` = Settings › Credits & billing |
| `project` | `maggi` (default) · `dune` · `canva` · `social` · `recipe` · `pitch` · `launch` · `other` (guest only) | board shown | kinds: maggi/dune/pitch Film · canva Social-clips · social Social-narrated · recipe Pre-vis · launch Campaign |
| `stage` | any stage label (URL-encoded) | stage shown | default = kind's first-open stage (Film→Storyboard, Pre-vis→PPM deck, Campaign→Formats, Social→Scenes, Social clips→Clips). Also reachable but not on any rail: `Locations`, `Shot list` |
| `v` | `canvas` (default) · `list` · `strip` · `rig` | board view | |
| `frame` | 0–7 | selects storyboard Shot N+1 (shows the on-card toolbar and the selection chip) | also used by `send` |
| `card` | card id | selection (readUrl only) | |
| `new` | `1` | new-board composer (fresh board tab "New board") | with `kind=` |
| `kind` | `Film` · `Pre-vis` · `Campaign` · `Social` → new-board kind; any other value (e.g. `Products`) → Library tray kind filter | dual use | |
| `propose` | `agency` · `pitch` (prefill the ask) · `film/previs/campaign/social/full` | sets text; the proposal card itself is not rendered | dead |
| `import` | `1` | storyboard_v3.pdf imported state | |
| `tabs` | 1–7 (capped at 7) | number of open board tabs | 4 shown, then "+N ▾" |
| `plus` | `1` | **+ popover** open | |
| `activity` | `1` | **Activity dropdown** (Needs you / Running) | README's `jobs=1` is **not read**. Use `activity=1` |
| `atomik` | `1` | **Atomik side panel** (⌘J) open | |
| `palette` + `q` | `palette=1&q=text` | **⌘K palette** with a query | |
| `q` (without palette) | text | prefills the Home bar; `q=%2F` opens the **"/" skills** list on Home | |
| `credits` | `low` | balance 60 cr → **low-credit chip** | default balance 1,240 |
| `drawer` | `Library` · `History` | **Library tray** (360 px) / History drawer (280 px; its button is hidden) | |
| `lib` | `1` | same as `drawer=Library` | |
| `src` | `Uploaded` · `Generated` | tray source segment | |
| `libkind` | `Characters` · `Locations` · `Props` · `Products` · `Mandatories` · `Everything made` · (library page) `Storyboards/Stills/Clips/Sound` | tray kind chip / library "Everything made" view | |
| `sel` | library item name | Library page inspector selection (default MAYA) | |
| `pick` | `film` · `ad` · `social` · `gold` · `board` · `blue` | Home wall tile picked → brand/length/aspect sheet in the bar | |
| `one` | `1` | dead (just-one toggle not rendered) | |
| `waiting` | `0` | hides "Waiting for you" on Home | |
| `mk` | `Auto` · `Image` · `Video` · `Audio` · `Remix` · `Edit` | Make mode | |
| `op` | Remix op (`Cut into clips`, `Transfer motion`, `Swap an object`, `Add an effect`) or Edit op | Make op | |
| `mode` | `remix` → Make Remix; `ask` · `above` · `run` → board autonomy | dual use | |
| `viewer` | `1` | **Make viewer** open on result 1, take 1 | |
| `ctx` | `1` | intended to open the Make right-click menu. It does nothing because `menuOpen` is overwritten by `menu` (L420 vs L425) and `menuAt` is never rendered | **gap** |
| `menu` | `1` | board ⋯ menu (Versions · Export · Spend · Autonomy) | |
| `add` | `1` | "+ Stage" presets popover | |
| `rail` | `edit` | rail edit demo (renaming stage 3, row menu on stage 6) | |
| `first` | `1` | right toolbar first-visit labels + "Got it" | |
| `tools` | `1` | sets toolsOpen (no visible UI) | dead |
| `details` | `1` | Details pop-over for the selected frame | needs `frame=` |
| `render` | `queued` · `preparing` · `rendering` · `saving` · `slow` · `failed` · `batch` · `ready` | render state on Shots (forces cast approved, 8 frames drawn, shots approved) | `ready` also fires the toast and the tab title |
| `render` | `1` with `view=make` | Make tiles rendering | |
| `render` | `1` with `v=rig` | Rig Shot 3 node rendering | |
| `demo` | `reveal` | reveal animation on Shot 3 (plays once, after 1.4 s) | |
| `notify` | `1` | "Tell me when it's done" opt-in pill | |
| `rig` | `input` · `impact` · `expand` · `recipes` | Rig: MAYA selected · "Change MAYA" impact · Shot 4 expanded · Recipes | |
| `guest` | `1` | visitor mode | |
| `join` | `start` · `make` · `upload` · `ask` · `download` · `plus` · `library` · `price` | join sheet open, titled by reason | |
| `requested` | `1` | request-access confirmation | |
| `invite` | `team` · `new` · `expired` | invite banner + sheet | |
| `step` | `plan` (`name` is read but equals the default) | new-workspace plan step | |
| `joined` | `1` | after joining: signed-in Home, prompt prefilled | |
| `device` | `phone` | 390 × 844 visitor shell | visitor screens only |
| `drag` | `1` · `tab` | drag-and-drop demo ghost (tile / tab) | |
| `send` | `1` | Send sheet (WhatsApp/Email/Copy link) | with `frame=` |
| `client` | `1` | cards marked by the client | |
| `feedback` | `1` | pasted client feedback → change requests | |
| `round` | `2` | Round 2 badge, What changed, compare card | |
| `budget` · `versions` · `compare` · `export` | `1` | board menu sub-popovers / compare overlay | |
| `delivered` | `1` | Deliver grid shown without shots approved | |

Reached only by interaction, with no URL: **avatar/account menu** (click "AP"), **card right-click** (single and ⇧-multi), **canvas right-click**, **tab right-click**, **@ mention popover** (click @ or type @), **"/" list on a board** (type "/" in the board bar), **Projects overflow "+N ▾"** (with `tabs=5+`), **row ⋯ menu** on the rail (hover), **card toolbar** (click a storyboard card), **rig impact popovers for add and remove** (drag or edge click).

---

## 2 · URL → screen → work items (master table)

| URL | Screen / state | Phase · WI |
|---|---|---|
| `?view=home` | Home signed in: header with 2 board tabs, Waiting for you, wall, Your boards, bar | P1 · S08 S09 S10 |
| `?view=home&tabs=5` · `&tabs=7` | tabs grow, then overflow "+3 ▾" | P1 · S02 |
| `?view=home&credits=low` | low-credit chip "Low on credits · Top up" | P1 · S07 |
| `?view=billing` | Settings › Credits & billing | P1 · S06 |
| `?view=home&pick=film` | wall tile picked: Brand/Length/Aspect sheet, "Start · up to 12 cr" | P1 · S09 |
| `?view=home&waiting=0` | Home without Waiting for you | P1 · S09 |
| `?view=home&q=%2F` | "/" skills list over the Home bar | P6 · C04 |
| `?view=home&drawer=Library` · `?view=home&lib=1&drag=1` | Library tray over Home (the bar shifts right) · drag ghost onto a board tile ("Add here") | P1 · S11 |
| `?view=board&drawer=Library` · `&src=Uploaded` · `&src=Generated` · `&kind=Products` | Library tray on a board | P1 · S11 |
| `?view=library` · `?view=library&sel=Maggi%20Atta%20pack` | Library page (brands, kit rows, inspector) | P1 · S12 (optional) |
| `?view=board&frame=3&plus=1` | + popover | P1 · S04 |
| `?view=board&activity=1` | Activity dropdown | P1 · S05 |
| `?view=board&frame=3&atomik=1` | Atomik panel (⌘J) + thread switcher | P1 · S03 |
| `?view=home&palette=1&q=approve` · `?view=board&palette=1&q=go%20to%20shot` · `?view=home&palette=1&q=what%27s%20left%20on%20the%20Canva%20board` · `…&q=how%20much%20did%20we%20spend%20this%20week` | ⌘K: actions · go to · answered question · spend answer | P1 · S03b |
| `?view=make` | Make: justified grid, docked composer | P1 · S13 |
| `?view=make&viewer=1` | Make viewer | P1 · S14 |
| `?view=make&mk=Auto` · `&mk=Video` · `&mk=Audio` · `&mk=Edit` | composer modes | P1 · S13 |
| (right-click a card on `?view=board&frame=3`; right-click empty canvas; right-click a board tab; Make results: **not implemented**) | right-click menus | P1 · S15 |
| `?view=board&first=1` | right toolbar with labels + "Got it" | P2 · B05 |
| `?view=board` (= Maggi Film, Storyboard, drawing 5 of 8) | board canvas, rail, stage header (no primary), bar | P2 · B01–B07 |
| `?view=board&stage=Cast` | the one filled primary "Review the cast" lives here | P2 · B04 |
| `?view=board&stage=Brief` · `Script` · `Cast` · `Elements` · `Storyboard` · `Shots` · `Cut` · `Deliver` | Film stages | P2 · B08 B09 |
| `?view=board&project=recipe&stage=Elements` · `&stage=Animatic` · `&stage=PPM%20deck` · `&stage=Shot%20list` | Pre-vis | P2 · B09 |
| `?view=board&stage=Storyboard` | 4 across, one 24 px gap | P2 · B06 |
| `?view=board&stage=Elements` | Elements: groups, true-aspect cards, ↑/✦, locks | P2 · B08 |
| `?view=board&new=1` · `&kind=Film` · `&kind=Pre-vis` · `&kind=Campaign` · `&kind=Social` | new-board flow | P2 · B03 |
| `?view=board&rail=edit` · `?view=board&rail=edit&add=1` | rail editing, + Stage presets | P2 · B02 |
| `?view=board&menu=1&mode=above` | board ⋯ menu with autonomy | P2 · B04b |
| `?view=board&stage=Shots&render=queued` | In queue (Shot 3) | P3 · R02 |
| `…&render=preparing` · `&render=rendering` · `&render=saving` | stages of a render | P3 · R02 |
| `…&render=slow` | taking longer than usual | P3 · R02 |
| `…&render=failed` | Didn't finish · nothing billed · Retry · 7 cr | P3 · R02 |
| `…&render=batch` | 3 of 8 ready · tab ring · approve finished takes | P3 · R03 |
| `…&render=batch&activity=1` | running list (README says `jobs=1`, which is broken) | P3 · R04 |
| `…&render=ready` | "Shot 3 is ready · View" toast + "(1 ready) Particl" | P3 · R04 |
| `?view=board&stage=Shots&demo=reveal` | reveal (particles gather, ≈0.6 s) | P3 · R02 |
| `…&render=rendering&notify=1` | "Tell me when it's done" | P3 · R05 |
| `?view=make&render=1` | Make tiles rendering + ring on the Make tab | P3 · R03 |
| `?view=board&v=rig&render=1` | Rig Shot 3 node rendering | P3 · R03 / P5 |
| `?guest=1` | visitor Home | P4 · V02 |
| `?guest=1&view=make` | visitor Make, "Sample" tiles | P4 · V02 |
| `?guest=1&view=board` · `&v=rig` | Sample board (read-only pill) | P4 · V02 |
| `?guest=1&join=start` · `make` · `upload` · `ask` · `download` · `plus` · `library` · `price` | join sheet by reason | P4 · V03 |
| `?guest=1&join=start&requested=1` | You're on the list | P4 · V03 |
| `?guest=1&invite=team` · `&invite=new` · `&invite=new&step=plan` · `&invite=expired` | invite flows | P4 · V04 |
| `?joined=1` | Home after joining, prompt kept | P4 · V06 |
| `?guest=1&view=board&project=other` | You don't have access | P4 · V07 |
| `?guest=1&device=phone` · `&join=start` · `&join=start&requested=1` · `&invite=team` | phone visitor | P4 · V05 |
| `?view=board&v=rig` · `&rig=input` · `&rig=impact` · `&rig=expand` · `&rig=recipes` | Rig | P5 · G01–G03 |
| `?view=board&project=launch&stage=Product` · `Look` · `Formats` · `Variants` · `Deliver` | Campaign | P6 · C01 |
| `?view=board&project=social&stage=Hook` · `Script` · `Scenes` · `Voice` · `Captions` · `Deliver` | Social narrated | P6 · C02 |
| `?view=board&project=canva&stage=Source` · `Moments` · `Clips` · `Captions` | Social clips | P6 · C02 |
| `?view=make&mk=Remix` · `&mk=Remix&op=Cut%20into%20clips` (etc.) · hover a wall tile → "Remix this" | Remix | P6 · C03 |
| `?view=board&v=list` · `&v=strip` · `&stage=Cut&v=strip&delivered=1` | List / Strip / Cut tracks | other · X01 |
| `?view=board&frame=3&send=1` · `&client=1` · `&feedback=1&atomik=1` · `&round=2&stage=Cut` · `&compare=1` · `&budget=1` · `&versions=1` · `&export=1` · `&frame=3&details=1` · `&stage=Storyboard&import=1` · `&frame=3&drag=tab` | other board features | other · X02 |

---

## 3 · Design tokens (for the shared token layer, first PR)

No CSS variables exist in the prototype. These are the de-facto values, with usage counts in brackets. They match graphite README § 2 almost exactly, and the repo already has `--gx-*` / `--graphite-*` variables in `app/graphite.css`, so extend that layer rather than inventing a new one.

**Surfaces**
- `bg/ground` `#000` (app, rails, panels, drawers, Make composer band)
- `surface/card` `#0B0B0D` [55] (cards, popovers, menus, dialogs, bar, toolbar, tray tiles)
- `surface/sunken` `#0D0D10` [30] (media placeholder, segment track, tab group, mini-map)
- `surface/input` `#0A0A0C` [24]
- `surface/selected` `#1C1C20` [37] (selected segment/tab, hover fill in menus, avatar)
- `surface/note` `#121216` (sticky note card)
- `canvas grid` `#000 radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px) 0 0/24px 24px` (board canvas and Rig)

**Lines**: hairline `rgba(255,255,255,0.09)` [15] (header and rail separators) · card border `0.10` [28] · input border `0.08` [58] · control border `0.14` [101] · strong border `0.16` [19] · row separator `0.06` [28] · dashed `0.18–0.24` · ring on selection `0 0 0 1px #0A84FF`.

**Text**: primary `#F5F5F7` [188] · secondary `rgba(235,235,245,0.62)` [52] / `0.6` [38] / `0.65` [37] / `0.7` [34]. Normalise to two steps: secondary 0.62 and muted 0.7. Strong secondary `0.75–0.85`. Quiet `0.5–0.55`. Disabled `0.35–0.45`. Eyebrow `rgba(255,255,255,0.55)` uppercase.

**Accent and status**: accent `#0A84FF` [70] (fills: only the one primary per screen, toggles, bars, rings) · accent text `#6EB4FF` [58] · link hover `#8FC4FF` · tint `rgba(10,132,255,0.14)` with border `0.5` (selected chips) · weak tints `0.06/0.08/0.10` · drop highlight `0.16`/`0.22`. Success `#30D158` (text `#4CD964`, tint `0.06–0.08`, border `0.35–0.4`) · warning `#FF9F0A` (text `#FFB340`, border `0.45–0.5`) · danger `#FF453A`. Timeline tracks: VO `rgba(191,90,242,.25/.6)`, Music `rgba(100,210,255,.22/.55)`, SFX `rgba(255,159,10,.22/.55)`.

**Overlays**: scrim `rgba(0,0,0,0.55)` (palette, send) / `0.6` (join) / `0.78` (Make viewer) · media badge `rgba(0,0,0,0.6–0.72)` · render overlay `rgba(0,0,0,0.42)` · particles `rgba(245,245,247,0.24–0.5)`.

**Image treatments**: storyboard mono `grayscale(1) contrast(1.35) brightness(1.05)` · rendering source `blur(10px) brightness(0.5)` · failed `blur(10px) brightness(0.4) grayscale(0.6)` · Make rendering `blur(8px) brightness(0.55)` · looks `sepia(0.7) saturate(1.5) contrast(1.05)`.

**Type**: family `Geist` (Google Fonts 400/500/600/700) **first**, then `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`. Graphite and the repo's `app/fonts.css` have SF first and Geist as fallback, and `assets/README.txt` says "no web font", so the font order needs a decision. Mono `ui-monospace, 'SF Mono', Menlo, monospace`, for prices, counts, codes, timestamps and shortcut keys only. Body 14/1.45, antialiased.
Scale (px, count): 32 new-board h1 · 26 page h1 (−0.03em) · 22 inspector h2 (−0.02em) · 20 no-access h2 · 18 join title / × glyph · 17 empty-state title, phone sheet title · 16 inputs on phone, composer textarea · 15 section titles, card titles, bar input [25] · 14 body [72] · 13 meta, controls, menu items [184] · 12.5 small controls [10] · 12 labels, eyebrows, mono keys [155] (floor; nothing smaller). Weights 400/500/600 (600 [140] titles, buttons; 500 [95] controls). Letter-spacing −0.03em h1 · −0.02em · −0.01em titles · +0.08em uppercase eyebrows (12/600, 0.55 white) · +0.06em rail kind label.

**Radii**: 999 pills/chips [31] · 50% dots, avatars · 16 phone sheet (top) · 14 bars, viewer, groups, join dialog · 12 cards, large popovers, right toolbar · 10 menus, wall/board tiles, drawers' tiles, primary bar buttons · 8 buttons, inputs, tiles [77] · 7 small buttons, menu items · 6 tabs, segments, small controls [55] · 5/4 tiny.

**Sizes**: header 56 · board stage header 44 · rail 88 · Atomik panel 340 · Library tray 360 (History 280) · bar inputs and buttons 40 · Library bottom button 34 · search field 32 (flex 0 1 300, min 200) · menu items 32 · card action buttons 32 · tabs 30 (max-width 200) · segments 26–30 · filter chips 26 · rail markers 22 · dots 6–7 · progress bar 3 · phone targets 44.

**Spacing**: 2 · 4 · 6 [70] · 8 [66] · 10 [45] · 12 [22] · 14 [15] · 16 · 20 · 24 (canvas grid gap, page side padding) · 40 (Home section gap). Canvas content origin 60/60, card width 260 (Storyboard and Shots), 280 (Elements), 290 (Formats and Scenes).

**Elevation**: menus and popovers `0 16px 40px rgba(0,0,0,.6)` [23] · dialogs `0 32px 80px rgba(0,0,0,.7)` · floating controls `0 8px 24px rgba(0,0,0,.5)` · toast `0 12px 32px rgba(0,0,0,.6)` · drag ghost `0 24px 60px rgba(0,0,0,.7)`.

**Motion** (keyframes at L19–L27): `om-in` (fade + translateY 6px) .12–.3 s · `om-pop` (scale .97) .15 s menus, .2 s dialogs, .3 s cards · `om-pulse` 1.4 s live dots · `om-drift`/`om-drift2` 6–11 s particles · `om-shimmer` 1.6 s linear (bar, background-size 400px) · `om-gather` .6 s ease .4 s forwards · `om-reveal` .6 s ease .5 s (blur 14 → 0) · colour/border transitions .15–.2 s · bar width .6 s ease. There is no easing token (graphite used `cubic-bezier(.2,.7,.2,1)`). **There is no `prefers-reduced-motion` handling anywhere**, so the build must add it (§ P3).

---

## 4 · Global behaviour

### 4.1 Esc order (keydown, L446–L458)
1. Make viewer open → close it.
2. Rig shot expanded or Recipes open → collapse.
3. Any menu, popover or sheet (palette, @ mention, projects overflow, Activity, board ⋯ menu, + Stage, + popover, card/tab/canvas context menus, account menu, rail row menu, G-sequence, Send sheet, budget, versions, export, compare, details, keep-as) → close all of them.
4. Armed tool, drag or marquee → back to Select.
5. Selection (single or multi) → clear.
6. Library/History drawer or Atomik panel → close.
- **Esc never cancels a render.** There is no handler (README rule).
- **Bugs to fix in the build:** the join sheet is **not** in the Esc chain, though README says "Esc or × closes it and keeps the typed text". The Rig impact popover (`rig.ask`) is not in it either. Build one overlay stack where the top-most layer closes first: viewer → join sheet → rig expand/impact → menus → tool → selection → drawers/panel.

### 4.2 Keyboard
⌘K palette (toggle) · ⌘J Atomik panel · ⌘Z undo (when a toast has Undo) · ⌘1 Home · ⌘2 Make · ⌘3… board tabs in order · `G` then `H` Home · `L` Library tray · on a board: `V` Select, `F` Frame, `N` Note, `T` Text, `I` Image (with a frame selected: `I` toggles Details), `U` Upload, `A` toggles the Atomik panel, `1–9` jump to stage N, `[` `]` previous/next stage, Space play/pause (Strip view) · Rig: ⌫/Delete on a selected edge opens "Remove X from Shot N" · Make viewer: ←/→ takes · bar: Enter sends/starts, `@` opens the mention popover, text starting with `/` opens the skills list.
Conflict: the card toolbar tooltip says "Approve · A" and the card menu lists Approve `A`, but `A` toggles Atomik (L457). Pick one. Menu shortcuts shown but not wired: D, R, U, L, G, ⌘C, ⌘D, ⌥D, ⌫, ⌘V, ⌘A, T, 0, ⌘W, ⌘L.

### 4.3 Tooltips (verbatim; every icon must have one: name · one line · shortcut · price)
- Logo: (none; add "Home"). Tabs: "Home · G H · ⌘1", "Make · single pieces · ⌘2", board "‹name› · ‹state› · ⌘N", × "Close tab", ring "Shot 3 rendering · about 2 min left" / "3 of 8 ready · about 4 min left" / "SH04 rendering · about 1 min left", "+N ▾" "More boards", + "New tab · boards and kinds".
- Search field: "Ask Atomik, search or go to · ⌘K — Ask a question, find a board, stage, card or library item, or run an action." Panel icon: "Atomik panel · ⌘J — Open the conversation: plans, questions and approvals." / "…Close the conversation panel."
- Activity: "Activity — What needs you and what’s running, across all boards."; rows "Open at the exact stage and card"; action buttons carry the $ value.
- Low chip: "Balance ‹N cr› · open Credits & billing". Avatar: "Account — Credits, settings, sign out."; Top up "$50 for 500 cr" [PRICE].
- Bar: + "Attach a file or a Library item — Upload a file, or pick from the Library." · @ "Mention something from the library" (Make: "…, or drag it in") · picked/attached chip × "Remove" · selection chip × "Clear the selection · Esc" · armed tool × "Cancel" · Start/Make/Ask buttons: the $ value.
- Right toolbar: "Select · V — Select, move and resize cards. Hold Space to pan." · "Frame · F — Draw a frame to group cards: a scene, a sequence, or options to compare." · "Note · N — A sticky note for ideas, feedback or to-dos." · "Text · T — A heading or label on the canvas." · "Image · I — Place an empty image card, then describe it in the bar." · "Video — Place an empty video card, then describe the shot in the bar." · "Audio — Place an empty audio card: a voice line, music or a sound effect." · "Upload · U — Add your own photos, video, audio, or a storyboard PDF to split into shots."
- Card corners: checkbox "Select — Add this card to a selection; ⇧-click adds more." · download "Download — The full-resolution original of this take. Free. ⌥-click: every take as a zip." · drag handle ⠿ "Drag to the Library to keep it, or to a board in Boards ▾ to copy it" · takes ‹ › "Previous take · ← — Show the earlier take of this frame." / "Next take · → — …later take…".
- Card toolbar: Lock "Lock · L — Keep this frame as it is; it won’t be redrawn." (locked: "Locked · L — Click to unlock. Locked frames aren’t redrawn.") · Redraw "Redraw — A new take of this frame, same prompt. Nano Banana 2 · 2 cr ($0.20)" [PRICE] · Finish "Finish panel — Clean lines and the final look for this frame · 2 cr ($0.20)" [PRICE] · Approve "Approve · A — Mark this frame as good; the next step can use it. Free." · ⓘ "Details · i — Elements in frame, continuity, model, cost so far, comments."
- View segment: "Canvas — Free cards you can move, group and annotate." · "List — The shot list: #, size, description, VO, duration, status." · "Strip — Timeline / animatic with durations · space plays." · "Rig — See what feeds what, and what a change will cost."
- Library button "Library · L". Tray: "Expand" "Open the full Library page", × "Close · L", brand "Brand — The library you are browsing.", tile "‹name› · ‹kind› — Drag onto the board, the bar or a board tile; click to @mention it.", source badge "Uploaded — a real file you added" / "Generated — made in Particl".
- Rail: kind label "Board kind · click to change"; row = its status summary; pencil "Rename"; ⋯ "Skip or remove"; "+ Stage" "Add a stage". Stage header ⋯ "Board menu".
- Render: Cancel "Cancel this take — nothing is billed for a cancelled take".
- Rig nodes: "‹name› · ‹kind› — Click to see every shot it feeds; drag onto a shot to add it as a reference." · "Shot N — Click to see what feeds it. Drop a Library input here to add it as a reference." · group chips "MAYA · GUIDE · click to collapse" · Recipes "Recipes — chain steps (still → upscale → video → lip-sync) and save as a skill. Also “/recipe” in the bar."
- Make: result hover "Select — Add this result to a selection.", download (as on cards), caption "Load this prompt and its settings into the composer"; viewer ‹ › "Previous take · ←"/"Next take · →", × "Close · Esc", "Reuse this seed in the composer"; settings chips "Engines from the rate card", "16:9 · 9:16 · 1:1", "5 s · 10 s", "1 · 2 · 4"; Remix ops carry their price line as the tooltip.
- Join sheet × "Close · Esc — your text stays in the bar". Company size select "Company size (optional)".
- Missing (add): logo, zoom −/+ have only "Zoom out/in", Tidy (none), mini-map (none), rail markers.

### 4.4 Toasts
A pill (padding 9×16, radius 999, `#0B0B0D`, border 0.12, 13/500, 6 px green dot). It lasts 2.6 s, or 5 s with Undo. The action link is "Undo", or "View" when the text matches "is ready". On a board it sits bottom-centre at 92 px (Make 196 px, new board 24 px). Off-board it sits **top-centre at 72 px**, which is inconsistent with the README's "bottom-centre"; pick one.

---

## 5 · P1 · Shell

### 5.1 Header (L43–L56) · replaces graphite header option B (Home · project · Make · Atomik segment, suite pill, Jobs pill, credits pill, avatar) and `Home and header options.dc.html`
- (a) every signed-in URL; `?view=home&tabs=5|7`.
- (b) 56 px, padding 0 16, gap 16, bottom hairline. Left to right:
  - logo button (30×14 dot-mark SVG + "particl" 15/600, −0.01em).
  - **tab group** `nav`: flex `0 1 auto` so it **hugs** its tabs. bg `#0D0D10`, radius 8, padding 3, gap 2, margin-left 8. Tabs: 30 h, max-width 200, padding 0 6 0 10, radius 6, 13/500, active `#1C1C20` + `#F5F5F7`, idle 0.7 white. Home has a house icon. Make has "✦" and is pinned. Board tabs show a 6 px state dot, the name ellipsised, and a × (18×18). An optional 12 px conic progress ring sits on the left. Max 4 board tabs, then "+N ▾" (opens "All boards" 280 px list with "+ New board"). Then **+** (30×30).
  - **merged Atomik field**: flex `0 1 300px`, min 200, 32 h, `#0A0A0C`, border 0.08, radius 8. Inside: a button "◆ Ask Atomik, search or go to · ⌘K" (13 px, 0.6 white, ◆ in `#6EB4FF`) and a 32×32 **panel icon** (rect with a divider) behind a left hairline. Open state: tint bg + `#6EB4FF`. A 7 px blue unread dot sits top-right.
  - **Activity pill** (signed in): 32 h, radius 999, border 0.14, 13/500, 7 px dot (orange when anything needs you, else blue pulsing). Label "‹N› need you · ‹M› running" or "‹M› running".
  - **low-credit chip** (only when low): border `rgba(255,159,10,.5)`, orange dot, "Low on credits · Top up". Opens Settings › Credits & billing.
  - **avatar** "AP" 32×32 circle, `#1C1C20`.
  - **No credits pill** (the balance lives in the avatar menu).
- (c) Tab click opens the board. Right-click a tab → tab menu (§ 5.11). Drag a card over a tab to copy it ("Copy to …" ghost label, `?view=board&frame=3&drag=tab`). Dropping on Make adds it as a Make reference. × closes (toast "‹name› closed · the board is kept" + Undo). Shortcuts ⌘1/⌘2/⌘3+.
- (d) None in the header itself. Ring time text comes from jobs [PRICE n/a].
- (e) Graphite § 1 header B · `Particl Suites.dc.html` header · repo `components/graphite/Header.tsx` (github.md).

### 5.2 Atomik panel ⌘J (L376–L386) and ⌘K palette (L390–L397)
- (a) `?view=board&frame=3&atomik=1` · `?view=home&atomik=1` · palette: `?view=home&palette=1&q=…`.
- (b) Panel: 340 px right column, left hairline. Top row: segment ["Atomik"] (single), thread `<select>` (max 150 px: "General · Home and Make" + one per open board; tooltip "Thread — One conversation per board, plus General for Home and Make."), × ("Close · ⌘J"), › "Collapse". Messages: who (12/600 uppercase +0.08em; Atomik `#6EB4FF`, You 0.55 white), time (12), text 14/1.55, action buttons 30 h. Default board thread copy: "Brief and script are done. I’m drawing the storyboard in Nano Banana 2 (2 cr a frame); 5 of 8 are in. Shot 8 waits for the cast." and "Two characters need your approval…" with [Approve cast · free] [Change GUIDE]. Idle (Home): "Nothing open. Pick something on the wall or describe it in the bar, and I’ll write the brief and the script first, for free, then ask before anything is drawn."
- Palette: scrim 0.55; dialog 600 w at top 88, radius 10. Input "Ask Atomik, search or go to" + "Esc" key-cap. Optional answer card ("Atomik · free", answer text, action buttons, "Continue in panel ›"). Hits: grid 74 px group label (12 uppercase) + label/sub. Groups: Go to, Stage, Card, Library, Action, Atomik ("Ask: “…”" · "Free · any action shows its price before it runs"). Empty query shows 4 Go-to + 3 Actions. Enter runs hit 1.
- (d) Action hits carry prices: "Retry Shot 3 · 43 cr", "Fix MAYA’s face · Shot 4 · 2 cr", "Approve 8 shots · 128 cr" [PRICE]. Spend answer "This week: 163 cr settled across three boards, 20 cr held…" [ledger].
- (e) Graphite § 3.4 (⌘K, panel, `atomik=how`); the control room (Approvals, Activity, Skills, Memory) has **no v12 equivalent**, so the owner should decide whether to keep it. Repo: `components/graphite/Palette.tsx`, `components/graphite/atomik/*`.

### 5.3 + popover (L72–L74)
- (a) `?view=board&frame=3&plus=1`.
- (b) At left 300, top 50, 560 w, radius 12, padding 12, gap 12. Contents: input "Find a board…" (36 h); "Recent boards" (3-col cards: 16:9 thumb, name 13/600, "dot ‹Kind› · ‹state›"); "Recently closed" (only if any: 40×24 thumb, name, [Reopen]); "New board" (4 cards: **Film** "An AI film or ad" · **Pre-vis** "Boards for a shoot" · **Campaign** "A product’s ads" · **Social** "Narrated or clips").
- (c) A kind card opens a new-board tab with that kind (the rail is dimmed until Start). Esc / outside click closes. Guests get the join sheet ("To open a new board you need a Particl account").
- (e) Graphite: new board was frame a (empty board) and templates on Home.

### 5.4 Activity pill + dropdown (L52, L75–L76)
- (a) `?view=board&activity=1` · `?view=board&stage=Shots&render=batch&activity=1`.
- (b) 400 w at right 230, top 50. Header: scope segment "All boards · This board" + the pill label. Groups (12 uppercase) "Needs you" then "Running". Row: 7 px dot (pulsing when running), name 13/600, meta mono 12 "‹board› · ‹stage›", action button 28 h (needs-you items outlined blue/600: "Approve · free", "Fix · 2 cr", "Approve · 128 cr", "Retry · 43 cr"; running items "Open").
- **Running list per README** ("every running job with time left and Open card") is computed in `jobs` (L764) but **not rendered**. Rows should read: "SH04 · Mirror film · take 2" / "Dune Studies · Seedance 2.5 · about 1 min left · 43 cr held" / [Open card]; "Shot 3 · take 1" / "Maggi Atta · Kling 3.0 Standard · about 2 min left · 7 cr held"; "Shot 6 · storyboard" / "… Nano Banana 2 · about 20 s left · 2 cr held"; "Approve the cast" / "Maggi Atta · waiting · free" [Review].
- (c) The row name deep-links to the exact stage and card; the action button runs it (priced actions go through approval).
- (d) Held amounts come from job records; action prices [PRICE].
- (e) Graphite Jobs pill / control room › Activity (`?suite=atomik&page=runs`).

### 5.5 Account menu (L54)
- (a) Click "AP" (no URL).
- (b) 240 w at the right. Balance row: mono 13/600 "1,240 cr" + [Top up] (26 h, tooltip "$50 for 500 cr"). Then "Credits & billing", "Settings" (no target), "Sign out" (0.7 white).
- (d) Balance = live ledger; Top up amount = plan config [PRICE]. Top up in the prototype adds 500 cr instantly (toast "Topped up · +500 cr · $50"); the real flow must go through payment (**owner**).

### 5.6 Settings › Credits & billing (L195–L202)
- (a) `?view=billing`.
- (b) Scrolling page, padding 40 24 120, centred column max 880, gap 24.
  - Eyebrow "SETTINGS" + h1 "Credits & billing" (26/600/−0.03em).
  - Section **Balance** (eyebrow) with "1 credit = $0.10" right-aligned. Rows (14 px, separators 0.06): "Credits" → mono `#6EB4FF` balance; "Low-balance chip" → "below 100 cr (placeholder)". Right-aligned filled button "Top up · 500 cr · $50".
  - Section **Per board · this month**: rows of name (500) + sub (13, 0.6), mono cr, [Open]. Rows: Maggi Atta · 30 s ad / Film · 8 shots / 186 cr; Dune Studies · Mirror film / Film · running / 94 cr; Maggi Atta · launch campaign / Campaign / 61 cr; Canva · launch clips / Social · clips / 12 cr.
  - Section **History**: grid 90 px / 1fr / auto. Rows: Today · Redraw 5 shots · MAYA wardrobe · Nano Banana 2 · −10 cr; Today · Make 8 shots · Maggi Atta · 30 s ad · −128 cr; Yesterday · Top up · Starter pack · +500 cr (`#4CD964`); Yesterday · Storyboard · 8 frames · Nano Banana 2 · −16 cr; 3 Oct · Identity · MAYA · −54 cr. Then [Export for billing · CSV].
- (d) Every number comes from the ledger (balance, per-board month spend, history) and plan config (top-up pack, threshold). The low-balance line should read "below 20% of your plan’s credits" (owner rule).
- (e) Graphite Settings › Plan & credits `?view=workspace&ws=credits` (§ 3.5). The graphite Team · Spending rules · Connections · Advanced sections have **no v12 screen** (owner decision). Repo: `app/(app)/settings`, `usage`, `app/api/topups`, `app/api/workspaces/topups`, `app/api/plans`, `lib/billingConfig.ts`, `lib/billingLedger.ts`.

### 5.7 Low-credit chip
- (a) `?view=home&credits=low` (balance 60).
- (b) See § 5.1. It sits in the header between Activity and the avatar.
- (d) Prototype rule: `credits < 100` (L807), a placeholder. **Build: show when balance < 20% of the workspace plan’s credits** (plan credits from config, never a literal). Clicking opens Credits & billing.
- (e) Graphite: credits pill in the header + "Short by N cr / Top up" on approvals (Gaps B `?view=board&gap=money&state=short`). The short-by state on a plan card is **not** in v12; keep it (owner).

### 5.8 The bar (shared; Home L134–L158, Make L176–L190, board L357–L366)
- Home: absolute bottom 20, centred (shifts right by half the tray width when the tray is open), 760 w; card `#0B0B0D`, border 0.16 (blue when dragging over), radius 14, shadow. Row: [+] 40×40 (Attach), [@] 40×40, picked-tile chip (24 px thumb + type + ×), attached chip "brief.pdf ×", input (15 px, placeholder "Describe a film, ad or idea, or pick one above" / "Anything to add (optional)" when a tile is picked), filled **Start** (40 h, radius 10): "Start · quoted" with nothing picked (violates graphite's no-bare-"quoted" rule; build "Start · up to N cr" from the quote) or "Start · up to 12 cr" for a picked tile. The picked-tile sheet above the row is a 64 px / 1fr grid: Brand (Maggi · Dune Studies · Canva), Length (15 s · 30 s · 60 s), Aspect (16:9 · 9:16 · 1:1), with 32 h pill chips.
- Board (L355–L366): centred over the canvas, width clamp 300–720 (`barWidth`, L845). Same + and @, then selection chip (blue tint "Shot 4 ×"), armed-tool chip ("Image · click the canvas ×"), input placeholder "Ask for a change, add a shot, or paste client feedback" / "Ask for a change to Shot 4". Button outlined blue: "Ask · free", or "Make · 2 cr / 7 cr / up to 1 cr" when a new empty Image/Video/Audio card is selected.
- Attach is "+" at the far left on Home, Make and boards (V10·10). The @ popover (380 w, above the bar) reads "From the library · Maggi" with rows (40 px thumb or dashed, name, kind): MAYA character, Desert camp location, Brass compass prop, Aqua bottle product. "/" at the start of the text opens Skills (§ P6). Drag a Library item onto the bar → "@Name " is inserted.
- (e) Graphite bar / "What are we making?" composer.

### 5.9 Home signed in (L114–L159)
- (a) `?view=home`.
- (b) Scroll area padding 16 24 160, gap 20.
  1. **Waiting for you** strip (44 h, `#0B0B0D`, border 0.10, radius 10): "Waiting for you" 13/600, count (mono), up to 2 items at ≥1400 px (else 1). Each item: dot + bold title + "· board · stage" + inline action chip ("Approve · free", "Fix · 2 cr"…). Then "+N more" (opens Activity) and × "Hide for now".
  2. **Wall**: grid 6 cols, auto rows 100 px (118 when the strip is hidden), gap 8. Six tiles with spans: Film · 30 s "Mirror at noon" (cols 1–2, rows 1–4); Ad · product "Aqua, carried far" (3–4, 1–2); Social · 9:16 "Walk the ridge" (5, 1–4); Look "Bleached gold" (6, 1–2); Storyboard · 8 panels "Desert camp, night" (3–4, 3–4, a 4×2 mono panel grid); Look "Blue hour" (6, 3–4). Label chip bottom-left (type 12/500 0.8 + title 14/600, `rgba(0,0,0,.66)`, radius 8). Hover overlay 0.38 with the pill "Make one like this" and the button "Remix this". Click = pick: "Picked" pill (blue), other tiles fade to 0.55, the bar sheet opens.
  3. **Your boards**: header "Your boards" + filter pills (All · Films · Pre-vis · Campaigns · Social) + right "+ New board" (blue text). Grid 6 cols, gap 12, top hairline. Card: 16:9 thumb radius 8, name 13/600, "dot state" 12. Drop target shows "Add here".
- (c) Drag from the tray onto a board tile → "Mirror at noon · hero added to …" (+Undo). Enter in the bar = Start. A picked tile sends the start to a new board with Brief first and the Atomik panel open.
- (d) Tile "up to" prices 12/12/8/3/16/3 cr [PRICE], waiting actions [PRICE], "Start · quoted" [PRICE].
- (e) Graphite Home `?view=home` ("What are we making?", templates, projects, Waiting for you, sample card). Repo `app/(app)/productions/page.tsx`, `components/workbench/Studio.tsx`.

### 5.10 Library tray (L77–L95)
- (a) `?view=board&drawer=Library` (also `&lib=1`, key `L`, the bottom-left "Library L" button) · `&src=Uploaded|Generated` · `&kind=Products` / `&libkind=…` · `?view=home&drawer=Library`.
- (b) `aside` at top 56, left 88 on a board (beside the rail) or 0, width 360, `#000`, right hairline + shadow `12px 0 32px rgba(0,0,0,.55)`. Header: "Library" 15/600 + [Expand] (24 h) + ×. Then:
  - search "Search the library" (32 h) + brand button "Maggi ▾" (a stub; build a real brand picker).
  - source segment **All · Uploaded · Generated** (28 h, track `#0D0D10`).
  - kind chips in one horizontal scrolling row (26 h): All · Characters · Locations · Props · Products · Mandatories · Everything made.
  - dashed line "2 products need packshots" + "Add" (→ Products chip).
  - **2-column masonry** (gap 8), tiles at true aspect (character/product 4/5, look 1/1, mandatory 3/2, 9:16 take, else 16/9). Each tile has a 22 px source badge top-left (↑ uploaded, 0.85 white; ✦ generated, `#6EB4FF`), name 13/500 and kind 12. Products without a packshot show a dashed "Add a packshot / Real photos only".
  - footer hint (12, 0.62): board "Drag onto the board to place it, onto the bar to @mention it. Drop a card here to keep it." / Home "Drag onto a board tile to add it, or onto the bar to @mention it."
  - Keep-as prompt when a card is dropped on the tray: "Keep “‹name›” as…" chips Character · Location · Prop · Product · Everything made.
- (c) Click a tile → @mention in the bar. A tile with no image → toast "Add a real packshot · products are never generated". Drag a tile → canvas (places a card), bar, or board tile. `L`/× closes. Esc (last in order) closes.
- (e) Graphite Library rail drawer (frame o), 280 px, closed by default. Repo `components/graphite/Library.tsx`, `components/make/GenAssetLibrary.tsx`. **DB check:** the uploaded/generated source and the kind on assets.

### 5.11 Right-click menus
Menu style: `#0B0B0D`, border 0.14, radius 10, padding 4, items 32 h 13 px, right-aligned mono 12 key hint at 0.5, price " · N cr" at 0.62, "▸" for submenus, separators 1 px 0.08, hover `rgba(255,255,255,.06)`, `om-pop .15s`. Each priced item carries its $ value as a tooltip.
- **Card, single** (260 w, at the cursor, L839): Open ↵ · Download original D · — · Copy ⌘C · Copy image · Duplicate ⌘D · — · Use as reference · Send to board ▸ · Keep in Library as ▸ · — · Redraw · 2 cr R · More like this · 8 cr · Upscale · 2 cr U · — · Approve A · Lock L · — · Details I · Delete ⌫ (red `#FF453A`). Toasts: "Duplicated · beside the original", "Locked · not redrawn", "Deleted" + Undo.
- **Card, multi** (right-click inside a ⇧/checkbox multi-selection): Download all · zip ⌥D · Copy ⌘C · Group into frame G · — · Approve all A · Redraw all · ‹2n› cr R · Send to board ▸ · — · Delete ⌫.
- **Canvas** (240 w, L840): Paste ⌘V ("Paste: an image becomes a card, text a note, a link asks Atomik what it is") · — · New ▸ · Upload… U · — · Ask Atomik here ("The result lands where you clicked") · — · Select all ⌘A · Tidy T · Zoom to fit 0.
- **Tab** (200 w, under the tab, L841): Rename · Duplicate board · Copy link ⌘L · — · Close ⌘W · Close others. Closed tabs go to "Recently closed" in the + popover.
- **Make result** (V10·13: "Right-click a result for the generation menu; right-click empty space for Paste · Upload… · Select all") is **not implemented** (`menuAt` never rendered). Build it from the card-single list minus Approve/Lock, plus "Load prompt", "Variations", "Use as reference", "Keep in Library".
- (d) Redraw 2 cr, More like this 8 cr, Upscale 2 cr, Redraw all 2n cr [PRICE].
- (e) New in v12 (graphite had none). The repo already has `components/ContextMenu.tsx`.

### 5.12 Make (L167–L194) and viewer (L173)
- (a) `?view=make` · `&mk=…` · `&viewer=1` · `&render=1`.
- (b) Results area padding 16 24 24: header "Results" 15/600 + "newest first" + mono "3 results". **Justified rows**: target row height 200, gap 8, min 120; tiles keep true aspect (flex `0 0 Wpx`), radius 10, border 0.10. Dividers "Today" / "Yesterday" (12 px + hairline). The prototype assigns dividers by row index (rows 0 and 2), which is wrong; group by date. Hover shows a checkbox top-left (22), download top-right (26), and a bottom gradient caption with the prompt (2 lines; click loads the prompt). Video tiles show a ▶ 40 px circle. Guest tiles show a "Sample" pill.
- Composer band (docked; top hairline, `#000`, padding 12 24 16): [Library] (40 h) + card (radius 14). Row 1: mode segment **Auto · Image · Video · Audio · Remix · Edit**. Auto line "Auto · a still, so Nano Banana 2 at 2K · 2 cr · sharp text, cheapest for one frame · override by picking a mode". Remix: "‹source› · what do we do with it?" + 4 op pills. Edit: Upscale · Reframe / outpaint · Remove background · Relight · Lip-sync · Motion transfer. Right-aligned setting chips "Model ‹engine · N cr› ▾", "Aspect 16:9 ▾", "Length 5 s ▾" (Video), "Count 4 ▾" (Image). Row 2: "References" chips (24 px thumb + name + ×). Row 3: [+] [@] input (placeholders: Auto "Describe anything · Atomik picks the model and settings"; Image "Describe a still · @ to pull from the library"; Video "Describe a clip · 5 s on Kling 3.0 Standard"; Audio "A line, a cue or a sound"; Edit "What to change in the last result (optional)"; Remix "Paste a video link, or drop a file here" / "Anything to add (optional)") + filled "Make · 8 cr" (Remix before choosing: grey "Pick what to do", disabled, tooltip "Pick one of the four first"). Seed is gone from the composer (V10·11).
- **Viewer**: scrim 0.78. Panel `min(1180, 100vw−80) × min(760, 100vh−80)`, grid `1fr 320px`, radius 14. Left: media (contain), ‹ › 40 px circles, counter pill "1 / 4". Right: "Image · 16:9" + ×; the prompt (click = load into the composer); meta "Nano Banana 2 · 2K · 16:9 · 4 · seed 8841 · 8 cr · 10:31"; mono cost "2 cr · $0.20 per take" (Video "7 cr · $0.70 per take", Audio "up to 1 cr per take"); time "Today · 10:42"; "Seed 8841" + [Reuse seed] ("Seed 8841 set · the next make repeats it"). Actions (34 h, label left, price right): Variations 8 cr (7 for video) · Upscale 2 cr · Hook review 1 cr (9:16 only) · Use as reference · Send to board · Keep in Library · Download free.
- (c) **Prompt reuse**: hover caption and viewer prompt → "Prompt and settings loaded into the composer". **Bug:** the code sets `mk.prompt`/`mk.mode` but the composer input is bound to `ask` (L751, L778), so the text never appears. Build: fill the input, mode, model, aspect, count/length and refs. Esc closes the viewer first; ←/→ step takes; Enter = Make; @ opens the mention popover; drop on the Make tab adds a reference.
- (d) Make button = quote(mode, engine, count, length) [PRICE]; result meta, viewer cost and action prices [PRICE].
- (e) Graphite Make panel `make=1|image|audio|change|fill|made|recent` (`Make frames.dc.html`): **Make becomes a pinned tab page** rather than a panel. Repo `components/make/GenWorkspace.tsx`, `Composer.tsx`, `app/api/generate/quote`.

### 5.13 Library page (optional for P1; L203–L252)
`?view=library` · `&sel=…`. Grid 220 / 1fr / 340. Left: "Brands" list (40 h rows, 24 px initial tile), "+ New brand", "Everything made" kinds with counts (Storyboards 24, Stills 18, Clips 9, Sound 4). Centre: h1 brand + "Kept across 4 boards"; kit rows Characters / Locations / Props / Products with 168 × 84 tiles (empty tiles dashed "+ New character / Describe or upload", "Add a reference / A photo or a sketch", "Add a packshot / Real photos only"). Right inspector: kind, name 22/600, state dot; refs Front / ¾ / Profile (4:5); description; "Never change" lock chips; "Used in N boards" links; note; actions (MAYA: Make turnaround · 4 cr, Approve; product: Photoshoot · 12 cr, Unboxing · 43 cr, Try-on · 43 cr; default: Make plate · 3 cr, Approve) [PRICE]. Replaces graphite Library page / `app/(app)/library`.

---

## 6 · P2 · Boards

### 6.1 Board kinds and stage rails (L407–L412)
| Kind | Rail | Opens on |
|---|---|---|
| **Film** | Brief · Script · Cast · **Elements** · Storyboard · Shots · Cut · Deliver | Storyboard |
| **Pre-vis** | Brief · Script · Cast · **Elements** · Storyboard · Animatic · PPM deck | PPM deck |
| **Campaign** | Product · Look · Formats · Variants · Deliver | Formats |
| **Social · narrated** | Hook · Script · Scenes · Voice · Captions · Deliver | Scenes |
| **Social · clips** | Source · Moments · Clips · Captions · Deliver | Clips |
Off-rail stage canvases also exist: `Locations` (folded into Pre-vis Elements), `Shot list`. "+ Stage" presets: Moodboard ("before the storyboard"), Recce ("locations to check"), Client review ("a share link, no sign-in"), Animatic ("the timed storyboard"), Custom… ("name it" → "New stage" in rename mode). Custom or unknown stages get the empty state "A stage you added. Drop cards here from the Library, or ask for it in the bar." [Ask Atomik · free].
Kind auto-detect from the brief text (L638): product page / .com / campaign / packshot → Campaign; topic / reel / short / youtube / clip / long video / faceless / narrat → Social (clips if a link or video and no "topic"); agency / script attached / shoot / live-action / ppm / pre-vis / boards → Pre-vis; else Film. Atomik replies "Looks like a ‹Kind› · change". Board name = first 4 words + " · ‹kind›".

### 6.2 Rail (L254–L266) · replaces the graphite outline rail (Studio: Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver; Ads/Social rails)
- 88 px column, padding 14 0 70. The **kind label** at the top (12/600, +0.06em, 0.6 white: FILM, PRE-VIS, CAMPAIGN, SOCIAL · NARRATED, SOCIAL · CLIPS) cycles the kind on click, with a toast "Board kind · ‹Kind› · the rail changed; your cards are kept" + Undo. A vertical 1 px line runs at x 43.
- Row: a 22 px circle marker (done ✓: white fill, black mark; needs-you: count in blue tint; working: blue border, pulsing; skipped "–" with the label struck through; empty: 0.35 border; current: blue border) + label 12/500 (max 76, ellipsis) + optional sub ("imported"). Current row bg 0.08, hover 0.04. Tooltip = summary (e.g. "2 characters to approve", "Drawing · 5 of 8").
- Hover shows pencil (Rename) and ⋯. The row menu (200 w) has the row label, Rename, Skip this stage / Put it back, Remove (red, + Undo toast), and "Drag the row to reorder · N jumps here". Drag rows to reorder (blue 2 px insert line). Rename inline (72 px input; Enter/Esc ends). "+ Stage" (dashed 22 px circle) opens the presets popover "Add a stage after ‹Stage›" (260 w).
- (d) none. **DB:** the board's kind, track, ordered stages, skip flags and names must persist.

### 6.3 New-board flow (L300–L312, logic L638)
- (a) `?view=board&new=1` · `&kind=Film|Pre-vis|Campaign|Social` · + popover kinds · "+ New board" on Home / "All boards".
- (b) Centred column 640 w (overlay on the canvas), gap 18:
  - h1 32/600/−0.03em: "What are we making?" | Film "Describe the film" | Pre-vis "Paste or attach the agency script" | Campaign "Paste the product page link" | Social "A topic, or a long video link".
  - 4 kind cards (grid 4, min-height 92, radius 12; selected: blue border + tint 0.10): **Film** "An AI film or ad, ending in masters." · **Pre-vis** "Boards and an animatic for a live-action shoot." · **Campaign** "A product’s ads and content." · **Social** "Narrated, faceless or clip-based videos."
  - Composer card (radius 14): textarea min 88 (16/1.5). Placeholder by kind: none → "A film, an ad, a product, or a topic. Pick a kind above, or just describe it."; Film "Describe the film. Who it’s for, what it must show, the feeling."; Pre-vis "Paste or attach the agency script."; Campaign "Paste the product page link."; Social "A topic, or a long video link.". Footer row: [+ Attach] (title: "Attach a script or boards" / Film "Attach a script or references" / Pre-vis "Attach the script, the boards PDF or references" / Campaign "Attach packshots" / Social "Attach a long video"), attached chip, chips row 1 (Film: Length 15/30/60 s; Campaign: Maggi · Canva · New brand; Social: Reels · Shorts · YouTube; Pre-vis: Length) and row 2 (Film: Aspect 16:9/9:16/1:1; Social: Length), and the filled **"Start · up to 4 cr"** (title "Atomik’s thinking · up to $0.40").
  - Footer line: "Start confirms the stages on the rail." + link "Edit stages" (toast "Edit the stages on the rail: rename, drag, ⋯ to skip or remove, + Stage at the end").
  - The rail shows the picked kind's stages at 0.45 opacity until Start. The stage header shows only the breadcrumb "New board" (no primary). The board bar is hidden (the composer replaces it).
- (c) Start with empty text → toast "Describe it, or attach something". Start → kind set, rail confirmed, Brief stage (first rail stage), Atomik panel opens with a kind-specific line ending "Thinking · up to 4 cr." Toast "Board started · ‹Kind›" ("(Atomik’s pick)" if auto-detected).
- (d) "Start · up to 4 cr" is the thinking ceiling [PRICE]. Graphite Gaps B corrected it to "up to 9 cr" (the planner ceiling in `lib/workbench/rig-agent.ts`), so take it from the quote.
- (e) Graphite frame a (empty board) + the Home templates + frame b (questions). **DB:** board creation with kind and stages.

### 6.4 Stage header (L270–L272) and the one-primary rule
- 44 h, padding 0 20, bottom hairline.
- Left: breadcrumbs **board name** (14/500, 0.7; click → first stage) › **stage** (15/600; click clears the selection) › **selection** ("Shot 4", "Shots 2–4", "3 shots"; 15/600). Then the stage sub pill ("✓ imported"), stage meta (0.65; only when the stage column is ≥ 1120 px), guest pill, Round badge.
- Right: **at most one filled primary**, shown **only on the stage where its action lives** (L836), plus ⋯ (30×30, "Board menu").
- Primary per stage:
  - **Film**: Cast "Review the cast" (cast not approved); Storyboard **and** Shots "Approve 8 shots · 128 cr" (cast approved, 8 drawn, shots not approved); Cut and Deliver "Make social cuts · 3 × 9:16 · ~9 cr" (after shots). Otherwise none: V10·7 says "What needs you elsewhere shows in the rail badge and the Activity pill".
  - **Campaign**: Product "Use this product"; Formats "Make ‹n› formats · ‹n×43› cr"; Variants "Make the first row · 21 cr"; Deliver "Adapt all · 36 cr".
  - **Social**: Hook "Use hook N · free"; Source "Find moments · 6 cr"; Moments "Make 3 clips · 3 cr"; Clips "Approve 3 clips · free"; Scenes "Approve 3 scenes · free"; Voice "Make the narration · up to 1 cr"; Captions "Approve captions · free"; Deliver "Adapt all · 36 cr".
  - **Pre-vis**: PPM deck "PPM deck PDF · free"; Elements "Shortlist locations for the PPM · free"; Animatic "Export animatic · free".
- Stage meta strings (L615): Brief "What we are making · approved" / "From Home · 30 s · 16:9"; Script "4 scenes · 8 shots · v2"; Cast "2 characters to approve" / "2 characters · 1 location · approved"; Storyboard "Drawing · 5 of 8 · Nano Banana 2" / "8 of 8 · Nano Banana 2" / "storyboard_v3.pdf · 8 shots · nothing redrawn"; Shots (see P3); Cut "2 takes · 0:10" / "Nothing yet"; Deliver "Spec check" / "Nothing yet"; Locations "3 options · 1 shortlisted"; PPM deck "Draft · 8 sections"; Hook "3 options · pick one"; Source "12:04 · uploaded"; Moments "3 picked"; Clips "3 · 9:16".
- **Board ⋯ menu** (360 w): Versions "v1 ›"; Export and share "PDF · CSV · MP4 ›"; Spend on this board "46 cr of 400 ›" [ledger/budget]; eyebrow "AUTONOMY · THIS BOARD" with radios "Ask at every stage" ("Every paid step waits for your tap."), "Ask only above [20] cr" ("Cheaper steps run and are listed in the Record."), "Run to the end within [200] cr" ("Stops at the ceiling or at a failed step. Only you can raise it."); then Rename a stage (hover ✎) · Import a storyboard PDF · Library drawer L · Rename board. **Autonomy and budget are spending rules (owner).**
- (e) Graphite: one primary per screen (ease rule 1), plan card frame e, group header frame f.

### 6.5 Canvas, right toolbar, first-visit labels (L316–L353)
- Canvas: flex 1, overflow auto, padding-right 72, padding-bottom 96, dot grid, and a layer of 2400 × 1600 scaled by zoom. **Fit** = 1.0–1.25 to the content on stage change. Cards are absolutely positioned and draggable (cursor grab). Click empty space = deselect; right-click = canvas menu. While a tool is armed the cursor is a crosshair and a click places a card (toast "‹Kind› placed · describe it in the bar to make it" + Undo).
- Bottom-left (hover-revealed, opacity 0 → 1): mini-map 150 × 92 + zoom "− 100% +" (32 h) + [Tidy] ("Tidied · cards back in production order").
- Bottom-left controls (always on, left = rail + 16, shifted by the tray): [Library L] (34 h) + view segment Canvas · List · Strip · Rig (26 h).
- **Right toolbar**: right 16, vertically centred, `#0B0B0D`, radius 12, padding 4, gap 2. Eight 40 × 40 icon buttons (18 px icons): Select, Frame, Note, Text, Image, Video, Audio, Upload. Active bg `#1C1C20`. Canvas view only. **First visit** (`?first=1`): each shows its short label ("Select · V", "Frame · F", …) beside the icon, plus [Got it] (32 h). Persist the dismissal per user.
- (e) Graphite canvas + tool pill + zoom/minimap (repo `components/workbench/production-graph.tsx`).

### 6.6 4-across grids (Storyboard, Shots, Elements, …)
- Prototype maths (L556): GAP 24, CW 260, step 284, `perRow = clamp(2..4, floor((canvasW − 132 + 24) / 284))`. 4 across needs a canvas ≥ 1244 px, i.e. Atomik closed at 1440. Storyboard rows step 250 + 24; Shots rows step **296 (332 while rendering)** + 24, which causes the FIX (§ 13).
- Elements (L593–L605): group headings "Locations · 2 · set once, carried into every shot" (Pre-vis: "Locations · 3 options · shortlist for the PPM"), "Props · 2", "Wardrobe · 1", "Products · real packshots only". Cards are 280 w at x step 300 (**20 px gap, max 3 across**, fixed y 100/510/920/1330). This contradicts README/CHANGES "Elements: 4 across". Formats and Scenes use 290 w with a 310 step (20 gap).
- **Build one grid component**: 4 columns at ≥ 1440 (3/2 below), a 24 px gap for rows and columns, rows sized to the tallest card in the row (CSS grid, `align-items:start`), and "Tidy" resets to it.
- Card anatomy (L320–L344): `#0B0B0D`, border 0.10 (selected: blue + ring), radius 12. Image area at true aspect (`object-fit:contain`), with a hover-revealed checkbox and download, a tag pill (24 h, "Look anchor", "v1", "Imported", "Locked", "Change requested", "R2", "Reference", "From the library", "LOCATION", …), takes ‹ 2/4 › on the selected frame, and a ▶ on video. Body padding 12 14 14, gap 8: ⠿ drag handle + title (15/600, or 14) + state (13, 7 px dot); body text; key/value lines (mono key, 14 px, separators 0.06); swatches; editable table; meta (13, 0.65); drift line ("MAYA’s face drifted" + [Fix · 2 cr]); client marks; actions (32 h, radius 7; "hot" = blue border/text/600). Selected storyboard card toolbar (30 h icons): Lock, Redraw, Finish, [Approve] (right), ⓘ.
- **Finished shot cards show only Approve · Reject** (CHANGES 1). Other actions live in the right-click and ⋯ menus. "Send" is removed from cards.
- **Elements**: no Approve where the state already says Approved; source line "↑ Uploaded" / "✦ Generated" + "· 🔒 lock text"; cards clear the bottom controls; "Added by you" removed from the breadcrumb.

### 6.7 Film stage contents (for B08/B09; copy verbatim in L568–L611)
Brief ("What we’re making" + Length/Aspect/Brand/Rule lines, [Edit with words] [Open the brand]; Reference cards; a Note) · Script (v2 lines 0:00–0:24, [Change with words] [Versions · 2]; v1 Replaced; Beats) · Cast (MAYA "From the library"/"Pulled from PDF", GUIDE "New character", Desert camp location, Aqua bottle "No packshot" [Add a packshot]; [Approve] / "Make turnaround · 4 cr") · Storyboard (8 frames mono; Shot 8 locked "Waits for the cast · you can go ahead" [Draw anyway · 2 cr]; drift on Shot 4; plan card "Make 8 shots" lines "1–2 Hero takes · Seedance 2.5 · 5 s · 1080p 86 cr", "3–8 Draft takes · Kling 3.0 Standard · 5 s 42 cr", "Fixes if needed · up to 2 per shot · at most 256 cr", "Total 128 cr", "Balance after · 1,112 cr", [Approve · 128 cr] [Change] [Hold]) · Shots (P3) · Cut ("Cut · 2 takes · 0:10" [Open the strip] [Compare R1 / R2] [Share R2 · MP4 + what changed]) · Deliver (Deliverables 16:9/9:16/1:1/4:5 × 30/15/6 s grid with Ready/Rendering/Queued cells and names `maggi-atta_16x9_30s_v1`; Naming/Format/Captions/Stems; [Adapt all · 36 cr] [Render the rest · free] [Spec check]; Languages "1 of 5 ready" (12 cr each, [Adapt all languages · 48 cr]); Mandatories check [Fix the bumper · free]; Export pack [Export pack · free]). Pre-vis: Animatic (Export MP4 · free, Re-time · free), PPM deck (8 sections + shot list; PDF/CSV/MP4 exports, free), Shot list (editable table). Empty states (L616) per stage, each with one action.

### 6.8 The bar with Attach (V10·10)
See § 5.8. On a board it never overlaps the right toolbar (`barLeft` maths keeps it ≥ 420 px from the left of the stage column). It hides on a fresh board.

---

## 7 · P3 · Render states and loader

Driven by `renderOpts(st, o)` (L468–L477), the card template overlay (L321), `rsFor`/`shotCards` (L575–L576), `stageMetaMap.Shots` (L615), tabs (L768) and `_title` (L438).

| State | URL | Card overlay (on the blurred, dimmed source) | Bar | Money line |
|---|---|---|---|---|
| queued | `…&render=queued` | grey dot "In queue · position N" · "Kling 3.0 Standard · usually 1–2 min · not started" · [Cancel] | 4% | "7 cr held · charged only when it’s ready" |
| preparing | `…&render=preparing` | blue dot "Preparing" · "‹engine› · usually ‹range› · 1:12 so far" | 12% | held |
| rendering | `…&render=rendering` | "Rendering" · same time line | 58% | held |
| saving | `…&render=saving` | "Saving" | 90% + shimmer | held |
| slow (past 2× typical) | `…&render=slow` | "Rendering" · "Taking longer than usual — the provider is slow right now. Still working; you won’t be charged twice." (no red) | 90% + shimmer | held |
| failed | `…&render=failed` | no particles, grey-red image; red dot "Didn’t finish" · "Nothing billed"; card action [Retry · 7 cr] | none | none |
| ready | — | tag "Ready" (green dot), ▶, [Approve] [Reject] | — | — |
| reveal | `…&demo=reveal` | particles `om-gather` .6 s, image `om-reveal` (blur 14 → 0) .6 s | — | — |
- **Bar rule** (README): fill to ~90% over the typical time, then hold with a soft shimmer; **never 99%**. Build: `pct = min(0.9, elapsed / typicalMax)`; past 2 × typicalMax → slow copy.
- **Particles**: six dots (3/5/7/9/11/14 px, opacity .5 → .24) drifting 6–11 s, echoing the logo's growing dots, over a `rgba(0,0,0,.42)` overlay. Make tiles use three dots. **Reduced motion: missing.** Build `@media (prefers-reduced-motion: reduce)`: static dots, no drift, gather or shimmer; the reveal becomes an instant cross-fade.
- **Cancel**: small 24 h button on the card (never Esc); tooltip "Cancel this take — nothing is billed for a cancelled take"; toast "Cancelled · nothing billed · the frame stays". Decision: "Cancel discards the take and bills nothing where the provider allows; otherwise the confirm line states what's billed". This needs a provider-aware confirm (**money**).
- **Batch** (`…&render=batch`): cards 1–3 ready (Approve · Reject), 4 saving, 5 rendering, 6 preparing, 7–8 queued. Stage meta "3 of 8 ready · about 4 min left". Finished takes can be approved while others render. Other Shots metas: rendering "2 of 8 ready · Shot 3 rendering · about 2 min left"; slow "2 of 8 ready · Shot 3 is taking longer than usual"; failed "2 of 8 ready · Shot 3 didn’t finish · nothing billed"; idle "2 of 8 ready to review".
- **Tab ring**: 12 px conic ring on the board tab (58%, batch 38%), tooltip with time left; none when failed. The Make tab has its own ring ("Still rendering · about 20 s left").
- **Running list**: the Activity dropdown (§ 5.4); build the `jobs` rows with time left + [Open card].
- **Ready toast** (`…&render=ready`): 600 ms after load, "Shot 3 is ready · View" (View → Shots, selects the card). The README wants it bottom-centre on every page; the prototype shows it top-centre off-board.
- **Browser tab title**: "(N ready) Particl" (ready → 1, batch → 3), else "Particl".
- **Notification opt-in** (`…&notify=1`): pill at bottom 140 centred, "This one takes a few minutes." [Tell me when it’s done] (outlined blue) [Not now] → toast "We’ll tell you when it’s done · browser notification". Offer it on the **first job over a minute**, once. The prototype only draws it; the repo has `app/api/push/subscribe` (web push → **VAPID env**).
- **Make tiles** (`?view=make&render=1`): first two tiles of the newest run blurred: "Rendering · 0:21 so far · 2 cr held" (58%) and "Preparing · Nano Banana 2 · usually 20–40 s" (12%), one line with ellipsis.
- **Rig node** (`?view=board&v=rig&render=1`): Shot 3 meta "Rendering · about 2 min left · 7 cr held" + 12 px ring.
- **Esc never cancels.**
- (d) Held amount = the job's quoted/held credits from the job record; Retry = a fresh quote of the same request; typical time ranges (Seedance 2.5 2–4 min, Kling 3.0 Standard 1–2 min, Nano Banana 2 20–40 s, ElevenLabs ~15 s) are placeholders from job history, so take them from config or a job-history query, not literals.
- (e) Graphite frame f (Shots rendering in place, "Rendering 1 of 3 · cost so far · Stop"), the failed / stopped states (§ 3.1), Phone `screen=states`, Gaps B `gap=money&state=failed`. Graphite's **80% budget pause** (f2) and "Short by N cr" have no v12 screen (owner).

---

## 8 · P4 · Visitors and invite-only join

### 8.1 Visitor shell (`?guest=1`)
- Header: logo · tabs **Home · ✦ Make · "Sample · Dune Studies"** · + (opens the join sheet) · search field · "Log in" (text button, 0.8 white, 600) · **"Request access"** (filled, 32 h). No Activity, no avatar, no credits, no low chip.
- `gate(why)` (L462) opens the join sheet and keeps the typed prompt. It is called by Start (Home bar and tile), Make, Ask (board bar, ⌘K Enter), Attach/Upload, Download (Make tile/viewer, card menu), + popover, every priced action (`spend`), and Remix this. **Gaps vs README:** Approve, Lock, Redraw-without-price and Send to board / Keep in Library are **not** gated in code. The README says Approve, Lock, Redraw, Fix, Make, Upload, Download, Attach, Send to board and Keep in Library all open the sheet. Build the README list.
- Privacy (README): the wall shows only Particl's public showcase; search, ⌘K and Atomik never return another workspace's boards, names or assets.

### 8.2 Visitor Home / Make / sample board
- Home `?guest=1`: heading "Made with Particl" + "Particl’s own showcase · tap a tile to make one like it"; the same 6-col wall; **"How it works"** + "Particl is invite-only": 4 cards (grid 4, gap 12; card `#0B0B0D` radius 12 padding 10; 16:9 image; mono number + title; sub): 1 "Describe it" — "A film, an ad or an idea, in a sentence or a brief." · 2 "Atomik plans the stages" — "Brief, script, cast, storyboard, shots, cut, deliver — each priced before it runs." · 3 "Approve as it’s made" — "Every take lands as a card: approve, reject or change it with words." · 4 "Deliver in every size and language" — "Masters, cutdowns and adaptations, straight from the board.". No Waiting for you, no Your boards. The bar as signed in.
- Make `?guest=1&view=make`: composer and tabs work; tiles carry a "Sample" pill; Download / Send to board / Keep in Library → sheet.
- Sample board `?guest=1&view=board` (also `&v=rig`): Dune Studies, every stage and view, tray, tooltips, menus; cards move; the header pill reads "Sample · changes on the sample aren’t saved". One fixed sample board for every visitor (decision).

### 8.3 Join sheet, desktop (L59–L69)
- (a) `?guest=1&join=start|make|upload|ask|download|plus|library|price` · `&requested=1`.
- (b) Scrim 0.6. Dialog **720 w** (max 100vw − 48), radius 14, padding 20 22 18, gap 16, border-box. Eyebrow "PARTICL IS INVITE-ONLY". Title (18/600) by reason: start "To start a board you need a Particl account" · make "To make this you need a Particl account · ‹detail›" (e.g. "4 stills · 8 cr") · upload "To upload or attach files you need a Particl account" · ask "To ask Atomik you need a Particl account" · download "To download originals you need a Particl account" · plus "To open a new board you need a Particl account" · library "To add to a Library you need a Particl account" · price "To run this you need a Particl account · ‹action · N cr›" · request "Request access to Particl". The prompt is shown quoted (13 px, `#0A0A0C` box). × "Close · Esc — your text stays in the bar".
- Two equal columns (`minmax(0,1fr)` × 2, gap 14, min-width 0):
  - **"I have an invite"**: mono "Invite code" input (40 h, 100%), [Continue with Google], [Continue with email] (both outlined, 40 h). Without a code → toast "Enter your invite code first". Email → "We sent a sign-in link to your email".
  - **"Request access"**: 2-col grid of Name · Work email · Company · Role `<select>` (Production house · Agency · Brand · Creator · Other) · Company size (optional) (1–10 · 11–50 · 51–200 · 200+) spanning both columns; textarea "What do you want to make? (optional)" **prefilled with the prompt**; filled [Request access].
- Footer: "Your work stays private to your workspace." + link "Already a member? Log in".
- Requested (`&requested=1`): green box (border `rgba(48,209,88,.4)`, tint .06): "● You’re on the list." / "We’ll email you when your invite is ready; your prompt is saved for when you’re in." / [Keep looking around].
- (c) × / scrim close and keep the text. **Esc must close it** (the prototype doesn't wire this).
- (d) "‹detail›" prices in titles [PRICE].
- (e) Graphite Guest sign-up 3a/3b (`signup=1&invite=1&brief=…`): "Sign in/Sign up" becomes "Log in/Request access". Repo `components/RequestAccess.tsx`, `app/api/access-request`, `app/api/auth/*`. **DB:** company, role, company size, want text on access requests.

### 8.4 Invite links (L61, L64–L65, L788–L801)
- `?guest=1&invite=team`: banner (40 h under the header, `#0B0B0D`, blue dot) "ZigZag Films invited you to Particl" [Accept invite]. Sheet title "Join ZigZag Films’ workspace", blue box "ZigZag Films invited you · Join ZigZag Films’ workspace · code ZZF-7K2Q filled in", [Continue with Google] (filled) [Continue with email].
- `?guest=1&invite=new`: banner "You’re invited to create a workspace on Particl". Title "Create your workspace", line "ZigZag Films invited you to create your own workspace · code ZZF-NEW-3M filled in", "WORKSPACE NAME" input (placeholder "ZigZag Films"), [Continue].
- `&step=plan`: line "Create your workspace · choose a plan or add credits". Three plan cards (grid 3): **Starter** "500 cr · $50" "about 11 hero takes" · **Studio** "2,000 cr · $180" "for a team" · **Team** "6,000 cr · $500" "shared pool" (selected: blue border + tint). Note "Prices are placeholders · confirm. Nothing runs without a price shown first." Filled "Continue · 500 cr · $50".
- `?guest=1&invite=expired`: banner "This invite has expired or been used" [Request access]; title "This invite has expired"; line "This invite has expired or been used." + [Request access] → request form.
- (d) Plan names and prices: **placeholders behind config** (owner); "about 11 hero takes" is derived (500 / 43), so compute it from the quote.
- (e) Graphite 3a (invite link sign-up with the "Invite plan line"). Repo `app/api/team/invites/[code]`, `app/api/admin/invites`, `app/api/auth/accept`. **Owner: sign-in + plans/payment.**

### 8.5 Phone (L34–L42; `?guest=1&device=phone`)
- 390 × 844 shell on black; status bar 54; optional invite banner (min 44 h, button 44 h); header 52: logo + "Log in" + filled "Request access" (44 h). Content: "Made with Particl" + "invite-only"; 2-col wall (rows 120, gap 6, 4 tiles); "How it works" list (24 px numbered circles, "Title · sub"). The bar floats at bottom 40 (input 44 h 16 px "Describe a film, ad or idea", [+] 44 × 44, filled Start). Home indicator.
- Join **bottom sheet** (`&join=start`): scrim 0.6; sheet max-height 88%, radius 16 16 0 0, padding 10 16 48; grabber 36 × 4; eyebrow; title 17/600; prompt. One column: "I have an invite" (Invite code + **only [Continue with Google]**) → **FIX: add [Continue with email]**. "Request access" (Name, Work email, [Request access]) is missing Company, Role, Company size (CHANGES 6 says it's on phone too) and the "What do you want to make?" textarea. "Already a member? Log in" is missing too. Then "Your work stays private to your workspace."
- Phone invite flow: one box with the invite line + a single [Accept invite] that completes immediately, so the new-workspace name and plan steps are skipped. Build the same steps as desktop.
- (e) Graphite guest phone P1–P3b (`?device=phone&guest=1&screen=…`). Graphite's **signed-in phone screens** (home, plan, review, fix, record, make, atomik, states) have **no v12 equivalent** (owner).

### 8.6 After joining (`?joined=1`)
Signed-in Home with the prompt "A 30 s ad for Maggi Atta · MAYA at a desert camp at night" in the bar. The README says "with the price shown", but the prototype's Start reads "Start · quoted", so build it with the quoted "up to N cr". The welcome toast "Welcome to Particl · your prompt is in the bar" only fires from the sheet button.

### 8.7 No access (`?guest=1&view=board&project=other`)
A full-screen black overlay (z 85, covering the header too), 420 w centred column: 40 px lock circle, h2 20/600 "You don’t have access", "This board belongs to another workspace. Boards, names and assets are never shown outside their workspace.", [Log in] (outlined) [Request access] (filled). **Never a preview.** It is a server-side authorisation check (owner, security).

---

## 9 · P5 · Rig (`?view=board&v=rig`, L283–L291, logic L643–L663)

- (b) Overlay over the canvas (z 16), dot grid, `overflow:auto`, padding 52 24 110. Fixed inner box **1180 × 820** (SVG 1180 × 800).
  - Column headings (13/600, 0.62, Geist sentence case): "Inputs · from the Library" (x 0), "The work · 8 shots" (x 420), "Outputs" (x 880).
  - Group chips above (24 h pills): "▾ Cast", "▾ Elements", "▾ Look" (click collapses the group's nodes) + "Recipes".
  - **Input nodes** x 0, w 300, y = 28 + i·92, 56 px thumbnail **cropped to the subject** (MAYA `50% 8%`, GUIDE `35% 12%`, products centred), label nowrap 13/600, meta "N shots". Inputs: MAYA (Character, shots 2 3 4 5 7, "Red scarf · never change"), GUIDE (Character, 2 6), Desert camp (Location, 1 2 3 6 7 8), Mirror sphere (Prop, 1 4 8, "Ø 4 m · never change"), Aqua bottle (Product, 5 8, "Packshot only"), Bleached gold (Look, all).
  - **Shot nodes** x 420, w 300, 48 px mono thumbnail, label "Shot N · ‹size›" **clamped to two lines**, with input avatars (18 px, overlapping) and time beside it.
  - **Output nodes** x 880, w 300, 120 px thumbnails: **Takes** "8 shots · 11 takes" (y 28), **The cut** "0:30 · R1" (y 304), **Masters** "16:9 · 9:16 · 1:1" (y 580). Click → toast "… · opens the Shots/Cut/Deliver stage" (build: navigate there).
  - Edges are drawn **only for the selection** (bezier 300 → 420; blue; a picked edge is orange; a lock badge on locked inputs' first edge). Unrelated nodes dim to 0.55.
- (c) Click an input → its shots light (`rig=input`). Click a shot → its inputs light. **Double-click a shot** expands steps: "Still · Nano Banana 2 · 2 cr", "Video · Kling 3.0 Standard · 5 s · 7 cr", "Upscale · Topaz · 2K · 2 cr", "Lip-sync · from the code · N cr", "Esc collapses" (`rig=expand`). Drag an input onto a shot → impact "Add X to Shot N" / "Shot N will redraw · Nano Banana 2 · 2 cr. Nothing else changes." [Cancel] [Approve · 2 cr]. Click an edge or press ⌫ → "Remove X from Shot N". `rig=impact` → "Change MAYA" / "5 shots will redraw · Nano Banana 2 · 10 cr. Locked frames stay." [Approve · 10 cr]. **Recipes** (`rig=recipes`): blue box (868, 84, 316 × 230) titled "Recipes · Still → Upscale → Video → Lip-sync", four step nodes (140 w, "2 cr / 2 cr / 7 cr / N cr") and "Recipe · total 11 cr + N" / "Save as skill" → toast "Saved as a skill · type “/” in the bar to run it · 11 cr + N cr per run". While Recipes is open the outputs collapse to one "Deliver" node ("Takes 11 · Cut 0:30 · Masters 3 ▸"). First-time hint pill "Click anything to see what it feeds." [Got it]. Rendering node variant: § 7.
- (d) 2 cr per redraw, 10 cr = 5 × 2, steps 2/7/2/N, recipe 11 + N [PRICE]: the impact price is a quote for "redraw these shots with this change", and Lip-sync has no rate-card row ("N cr").
- (e) Graphite folded the Rig into "the Board itself" (old `?suite=studio&page=rig`). v12 brings it back as a board **view** (V9·11–13, V10·14–18). Repo `components/workbench/production-graph.tsx`, `lib/workbench/node-graph.ts`, `lib/boardGraph.ts`, `lib/impact.ts`, `app/api/rig/quote`.

---

## 10 · P6 · Campaign / Social kinds, Remix, "/" skills

### 10.1 Campaign (`project=launch`)
- Product: card "PRODUCT · READ FROM THE PAGE" "Maggi Atta · 5 kg" "Review before use", swatches (#FFCB05 Maggi yellow, #E2231A Maggi red, #5B3A1E Pack brown, #F5EFE0 Flour; 22 px circles, mono hex), lines Claims/Colours/Logo/Packshots, [Use this] [Edit] (approved: [Open in Library]). Source card (Page/Read/Rule).
- Look: Moodboard "Warm kitchen light" (Approved) + "Brand mandatories · Maggi" (Logo, End packshot, Legal, Fonts, Colours, VO tagline) [Edit in Library].
- Formats: 8 "SKILL" cards (290 w): Product video ad 43 · Talking review 43 ("A person on camera · consent record") · Unboxing 43 · Try-on (greyed, "Doesn’t apply: Try-on fits apparel and accessories, not flour") · Tutorial 50 · Product voice-over 9 · Website walk-through 9 · Photoshoot 12. State "One run · N cr" / "Picked"; [Pick]/[Unpick]. Header primary "Make ‹n› formats · ‹n×43› cr". **Bug:** this ignores the picked formats' own prices, so sum their quotes instead.
- Variants: grid "Variants · hooks × formats", rows “Soft rotis, every time.” / “What’s in your atta?” / “Dinner in 20.” × columns Reels 9:16 · Feed 4:5 · YouTube 16:9; each cell "7 cr" or Ready; [Make the first row · 21 cr] [Add a hook].
- Deliver: as Film (§ 6.7). The Deliver cards show for non-Film kinds without shots.

### 10.2 Social
- Narrated (`project=social`): Hook (3 cards "Hook 1–3", the quote, "Review · 7 of 10", +/− reasons, [Pick] [Review · 1 cr]; note "A review, not a prediction of views — Each score comes with reasons and one suggested fix…") · Script · Scenes (4 cards "SCENE n · N s": The question / The claim / The proof / The ask; "Nano Banana 2 · 2 cr · from the script"; the 4th "Making · 40%") · Voice (Narrator "Picked · Aarav · Hindi", Voice/Language/Lines/Price "up to 1 cr · ElevenLabs", [Make the narration · 1 cr] [Change voice]; Music bed [Make a bed · 1 cr]) · Captions (9:16 card "Burned in · Hindi + English", Style/Languages/Thumbnails "3 options · 3 cr", [Approve] [Thumbnails · 3 cr]) · Deliver.
- Clips (`project=canva`): Source ("SOURCE · 12:04" "A walk through the dunes" "Upload · original kept", [Find moments · 6 cr] [Replace]; "What to look for" Sphere/Lines to camera/Under 20 s) · Moments (timeline 0:00–12:04 with 3 blue marks; picks 0:14 / 3:02 / 8:41 with reasons; [Make 3 clips · 3 cr] [Pick different moments]) · Clips (3 × 9:16 "CLIP · 9:16" "Hook review · N of 10", [Approve] [Review · 1 cr]) · Captions · Deliver.

### 10.3 Remix
- Home wall tile hover → [Remix this] (guest → sheet "Remix this") → Make with mode Remix and source "Source · ‹tile› · MAYA and the Atta pack suggested".
- Make Remix: "‹source› · what do we do with it?" + ops (tooltip = price line): **Cut into clips** "9:16 · captions burned in · 6 cr per minute of source" · **Transfer motion** "onto your character · 4–30 s source · 43 cr" · **Swap an object** "replace it with your product · 43 cr" · **Add an effect** "Particl’s saved looks · from 7 cr". Make stays "Pick what to do" (disabled) until an op is chosen. No source → toast "Paste a link or drop a video first". "Make one like this" = the tile pick flow (§ 5.9). README: the join sheet also opens on "Make one like this" / Remix for guests.
- (e) Graphite Make › Motion transfer / Object swap (`make=motion|swap`) and the Social Effects card.

### 10.4 "/" skills (every bar)
- Opens when the bar text starts with "/" (Home: `?view=home&q=%2F`). A panel above the bar, max-height 360, header "Skills · each shows its quote before it runs", 2-col grid of 40 h rows "/Name" + mono price: Unboxing 43 cr · Talking review 43 cr · consent · Try-on 43 cr · Tutorial 50 cr · Product voice-over 9 cr · Website walk-through 9 cr · Photoshoot 12 cr · Captions free · Thumbnails 3 cr · Narrated video up to 36 cr · Narrator up to 1 cr · Cast sheet 4 cr · Brand assets up to 3 cr · Ad versions 7 cr each · Edit 2 cr. Picking one sets "/Name " in the bar, with toast "/Name · price · quote shown before it runs". Saved recipes appear as "/recipe".
- **Bug:** on Home the list is rendered **twice** (two identical `sc-if slashOpen` blocks, L138). Prices [PRICE] come from the skills' quotes.
- (e) Graphite Control room › Skills ("Run again with new words"). Repo `lib/atomikSkills.ts`.

---

## 11 · Other prototype screens (not in P1–P6; listed so nothing is lost)
List view (`v=list`: grid 44 / 110 / 2fr / 1.4fr / 70 / 150; "#, Size, Description, VO / dialogue, Dur., Status"; footer "8 shots · 16:9 · 24 fps" "0:30 total") · Strip (`v=strip`: ▶ 36 px, "0:00 / 0:30", note, [Animatic MP4 · Export], frames flexed by duration, playhead; Cut adds VO/Music/SFX tracks with "Make a line · up to 1 cr" / "New sketch · up to 1 cr" / "Add a cue · up to 1 cr" + Upload) · Send sheet (`send=1`: "Send ‹target›", "No review page, no sign-in. The client replies where they are.", WhatsApp · Email · Copy link, "Watermarked link — Phone-friendly · opens without a sign-in · expires in 14 days" / "The file itself", To field, preview, "Free · the link is watermarked and expires in 14 days", [Send via WhatsApp]) · client marks (`client=1`) · pasted feedback (`feedback=1&atomik=1`, "Approve all · 6 cr") · Round 2 + What changed + Compare (`round=2&stage=Cut`) · Versions / Compare two takes (`versions=1`, `compare=1`) · Export (`export=1`) · Budget (`budget=1`, "Spent 46 of 400 cr", by stage, Export for billing · CSV, Change the ceiling) · Details pop-over (`frame=3&details=1`: In this frame, Continuity, "Nano Banana 2 · 2K · 2 cr" [Change], Cost so far "6 cr · 3 draws", Comments) · PDF import (`import=1`) · drag ghosts (`drag=1|tab`).

---

## 12 · Every price / credit number and where it must come from

Owner rules: **no credit number is hardcoded in the build; all prices come from the live quote engine; plans are placeholders behind config; low-credit warning when < 20% of plan credits remain.** Display "N cr" / "up to N cr" / "free" / "N cr held"; hover shows dollars (prototype: 1 cr = $0.10 hardcoded in `act()`/`actFor()`; the build should take the conversion from billing config / `lib/creditConversion.ts`). Never "quoted" bare.

| Where | Prototype figure | Build source |
|---|---|---|
| Account menu balance, Credits & billing "Credits" | 1,240 cr (low: 60) | ledger balance |
| Low-credit threshold | `< 100 cr` (placeholder) | config: 20% × plan credits |
| Top up button / tooltip / toast | 500 cr · $50 | plan/top-up config + payment (owner) |
| Credits & billing per-board spend | 186 / 94 / 61 / 12 cr | ledger (this month, by board) |
| Credits & billing history | −10, −128, +500, −16, −54 cr | ledger |
| Credit to $ | $0.10 | billing config |
| Invite plan step | Starter 500 cr · $50 · Studio 2,000 cr · $180 · Team 6,000 cr · $500 · "about 11 hero takes" | plans config (placeholders); hero-take count = plan ÷ quote(hero take) |
| Home Start (no tile) | "Start · quoted" | quote: Atomik thinking ceiling ("up to N cr") |
| Home Start from a tile | up to 12 / 12 / 8 / 3 / 16 / 3 cr | quote per tile recipe |
| New-board Start; Atomik lines "Thinking · up to 4 cr"; `credits − 4` | 4 cr (graphite corrected to 9 cr) | quote (planner ceiling) |
| Waiting for you / Activity actions | Fix · 2 cr · Approve · 128 cr · Retry · 43 cr · free | quote of each pending action |
| ⌘K actions and answers | Retry Shot 3 · 43 cr · Fix … · 2 cr · Approve 8 shots · 128 cr · "163 cr settled, 20 cr held, 92" | quote / ledger |
| Make button | Auto/Image 2 × count (8 cr for 4) · Video 7 · Audio up to 1 · Edit 2 · Remix 6/43/43/7 | `app/api/generate/quote` (mode, engine, count, length) |
| Make results meta, viewer cost, actions | 8 / 4 / 7 cr · "2 cr · $0.20 per take" · Variations 8 (video 7) · Upscale 2 · Hook review 1 · Download free | stored run cost + quotes |
| Make join title | "4 stills · 8 cr" | quote |
| Card toolbar / drift / locked frame | Redraw 2 · Finish panel 2 · Fix · 2 · Draw anyway · 2 · Redraw with the change · 2 | quote |
| Card menu | Redraw 2 · More like this 8 · Upscale 2 · Redraw all 2n | quote |
| Plan card "Make 8 shots" | 86 (2 × 43) · 42 (6 × 7) · "at most 256 cr" (2 × 128) · Total 128 · "Balance after · 1,112 cr" | plan quote (per line) + fix allowance + live balance |
| Stage primaries | Approve 8 shots · 128 · social cuts ~9 · Make n formats n×43 · first row 21 · Adapt all 36 · Find moments 6 · Make 3 clips 3 · narration up to 1 | quote |
| Shots cards | "Seedance 2.5 · 43 cr" / "Kling 3.0 Standard · 7 cr"; "N cr held"; Retry · 7 | engine quote; held from the job record; retry quote |
| Empty states | Make anyway · 128 · Find 3 options · 1 · Write 3 hooks · 1 · Gather a mood · 8 · Make the animatic · 7 | quote |
| Placed empty cards / board bar | Make here · 2 / 7 / up to 1 · "Make · 2 cr" | quote |
| Chat replies | "2 cr a frame", Go · 2 cr; feedback 2 cr each, Approve all · 6 | quote (Atomik's priced proposal) |
| Imported PDF | Redraw all · 16 cr; "any frame can be remade for 2 cr" | quote |
| Cast / Library | Make turnaround · 4 · Photoshoot 12 · Unboxing 43 · Try-on 43 · Make plate 3 · made-item metas 2/43/3/7 | quote / stored costs |
| Elements | Make one · 2 cr | quote |
| Details pop-over | "Nano Banana 2 · 2K · 2 cr" · Cost so far "6 cr · 3 draws" | quote / ledger per card |
| Board menu / budget | "46 cr of 400", autonomy 20 cr / 200 cr, budget rows by stage | ledger + board budget (spending rules, owner) |
| Deliver | Adapt all · 36 · Languages 12 each · 48 · free items | quote |
| Campaign / Social stage cards | Formats 43/43/43/50/9/9/12 · Variants 7 per cell · Review 1 · Voice 1 · Music 1 · Thumbnails 3 · Scenes 2 | quote |
| Strip tracks | up to 1 cr ($0.10) | quote (ElevenLabs estimate) |
| Rig | redraw 2 / Change MAYA 10 (5 × 2) / steps 2·7·2·N / recipe 11 + N | `app/api/rig/quote` / impact quote |
| Skills list | 43 · 43 · 43 · 50 · 9 · 9 · 12 · free · 3 · up to 36 · up to 1 · 4 · up to 3 · 7 each · 2 | skill quotes |
| Render money line | "43 cr held" / "7 cr held" / "2 cr held" | job record (held amount) |
| Join sheet "price" detail | "‹action› · N cr" | quote |
README "CONFIRM" items: Nano Banana 2 2 cr in the brief vs 1 cr on the rate card; Lip-sync has no rate-card row; typical render times; plan prices; the low-credit threshold. All of these disappear once everything is quoted live.

---

## 13 · FIX WHILE BUILDING: where the prototype has these bugs

1. **Rig must fit 1440 × 900 or scroll inside the canvas, and the hint pill must never cover a node.**
   - L283–L284: the Rig overlay has `overflow:auto` with padding 52/24/110 around a **fixed 1180 × 820 box** (SVG only 800 high). At 1440 × 900 the stage area is about 900 − 56 (header) − 44 (stage header) = 800 px high, but the content needs 820 + 162 = 982 px, so it scrolls vertically. Horizontally 88 + 24 + 1180 + 24 = 1316 fits at 1440, but **not with the Atomik panel open** (1440 − 88 − 340 = 1012) or at 1280 (README "Rig still scrolls at 1280").
   - Node rows are a fixed 92 px step (L646–L647). Shot nodes with two-line names are about 48 + 7 + 34 + 7 ≈ 96 px, so they can overlap the next node.
   - **Hint pill** (L71): `position:fixed; left:50%; bottom:92px` is viewport-centred. At 1440 its x range is about 520–920 and y is about 772–808, which lands on the **shot column** (screen x ≈ 532–832) over Shot 7's node (y ≈ 732–830) with no scroll. It covers a node.
   - **Fix:** compute the layout from the available box: row step = max(node h + 8, (H − headings) / 8) with 40 px thumbnails, or scale-to-fit (min 0.8) and otherwise scroll **inside** the Rig canvas only. Place the hint in reserved space (beside the column headings, or a top-right slot inside the Rig canvas), never over the node columns. Also fix the related misalignments: the impact popover Y for add/remove uses a **72 px** step (`rigImpactY`, L659) and the `outsOpen` edges use 72 (L652), while nodes use 92.
2. **Shots: no ~100 px row gap when finished and rendering cards share a row.**
   - L576: `shotRowH = RS ? 332 : 296` and `y = 60 + floor(i / perRow) * (shotRowH + 24)`, with absolute positioning and a fixed row height. A finished card is about 261 px (146 image + title + meta + 32 px actions + padding) and a rendering card about 219 px. With 332 px rows the visible gap under finished cards is about 95 px, and about 137 px under rendering cards.
   - **Fix:** use the shared CSS-grid layout (§ 6.6): 4 columns, 24 px gap, rows sized to the tallest card in the row, `align-items:start`. Give rendering and finished cards the **same outer height**: reserve the actions row (32 px) on rendering cards, or put the overlay text inside the image so both are image + title + meta + actions.
3. **Rendering card: the time line stays on one line and particles never overlap text.**
   - L321: the time span uses `-webkit-line-clamp:3`, so "Seedance 2.5 · usually 2–4 min · 1:12 so far" wraps to 2 lines on a 260 px card (about 232 px of text width at 12 px), and the slow copy runs to 3 lines. The overlay text block (stage row + 2–3 lines + bar + money) is about 80–95 px tall, anchored bottom 10 px inside a 146 px image, so it starts around 35–45% from the top. The particles sit at `top:44%`, `52%` and `62%` (L321, 3rd–6th dots), so they sit **under or over the text**.
   - **Fix:** time line `white-space:nowrap; text-overflow:ellipsis` with a shorter form ("Kling 3.0 Std · 1–2 min · 1:12"; full text in the tooltip). The slow message goes in the tooltip, or replaces the time line with "Taking longer than usual · still working" on one line and the full sentence in the tooltip. Confine the particle field to the top area of the image (e.g. `inset: 8% 8% <text-block-height> 8%`, or a mask above the text block), and give the text block a solid scrim.
4. **Phone join sheet adds "Continue with email".**
   - L41 (the phone sheet, `joinPaths` block): "I have an invite" has the code input + **only "Continue with Google"**. The desktop sheet (L65) has both.
   - **Fix:** add [Continue with email] (44 h). While there, bring the phone sheet to parity with CHANGES 6: Company, Role, Company size (optional), "What do you want to make?" prefilled, and "Already a member? Log in". Make the phone invite flow follow the desktop steps (name → plan) instead of a single "Accept invite".

---

## 14 · Other prototype bugs and discrepancies (decide or fix in the build)
- README URL `…&render=batch&jobs=1` is broken. The code reads `activity=1`.
- README "In queue · position 7": the code shows position 5 for Shot 3 (`pos = 7 − i`). Shot 8 gets 0, which is falsy, so it falls back to 3. Use the real queue position.
- Activity dropdown lacks time left and "Open card" (the `jobs` array is unrendered).
- Join sheet and rig impact are not in the Esc chain.
- Guest gating misses free actions (Approve, Lock, Send to board, Keep in Library).
- Make prompt reuse doesn't fill the composer input. The Make right-click menu is not rendered (`ctx=1` is dead).
- Make "Today / Yesterday" dividers are assigned by row index.
- Elements cards are 3 across with a 20 px gap, not "4 across"; Formats and Scenes also use 20 px gaps.
- The Home "/" skills list is rendered twice.
- "Start · quoted" violates the no-bare-"quoted" rule. `?joined=1` therefore shows no price.
- Toasts are bottom-centre on boards and top-centre elsewhere.
- Tooltips say "Approve · A" but `A` toggles Atomik.
- Formats primary price = count × 43 regardless of which formats are picked.
- Retry figures are inconsistent across placeholders: Dune "Retry Shot 3 · 43 cr" vs the Maggi board "Retry · 7 cr".
- No `prefers-reduced-motion`. Browser notifications are drawn, not requested. The invite code is not validated.
- Font order (Geist first) differs from graphite and the repo (SF first, Geist fallback).
- The Social "Script" stage reuses the Film script card (placeholder).
- The Settings item in the account menu has no target. The library brand picker is a stub.
- Graphite money rules not represented in v12: per-shot admin cap (code default 50 cr, `lib/approvalRule.ts`), 200 cr platform line, 80% budget pause, "Short by N cr / Top up" beside Approve, offline state, consent record. Keep them (owner decision).

---

## 15 · Graphite → v12 replacement map
| Graphite (design/particl-graphite) | v12 |
|---|---|
| Header option B: Home · project · Make · Atomik segment, suite pill, Jobs pill, credits pill, avatar (`Particl Suites.dc.html`, `Home and header options.dc.html`) | Tab group (Home · Make · board tabs · +), merged Atomik field (⌘K + panel ⌘J), Activity pill, low chip only, avatar menu holds the balance |
| Home `?view=home` (What are we making?, templates, projects, Waiting for you, sample) | Home: Waiting for you strip, showcase wall (pick / Remix), Your boards with kind filters, the bar |
| Make panel `make=1|image|audio|change|fill|made|recent|motion|swap` (`Make frames.dc.html`) | Make pinned tab: justified grid, viewer, docked composer, Remix ops |
| Studio board frames a–p (`Studio board frames.dc.html`); rail Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver | Board with the Film rail (Elements added, Looks dropped); Canvas/List/Strip/Rig; one primary per stage |
| Ads board `kind=ads&frame=1–3`, Social `kind=social&frame=1–2` (`Ads and Social frames.dc.html`) | Campaign and Social board kinds with their own rails |
| Frame a (empty board) | New-board composer with four kind cards |
| Frame e approval card / f rendering / g take review / f2 80% pause | Plan card on Storyboard; render states P3; finished cards Approve · Reject; no pause card |
| Library rail drawer 280 px (frame o) and History (frame p) | Library tray 360 px (search, brand, Uploaded/Generated, kinds, masonry); History hidden |
| ⌘K and Atomik panel; control room Approvals · Activity · Skills · Memory (`Atomik frames.dc.html`) | ⌘K + panel kept; Activity becomes the header pill; Skills become "/" in the bar; Approvals and Memory have no screen |
| Settings Team · Plan & credits · Spending rules · Connections · Advanced | Only Settings › Credits & billing; autonomy per board in the ⋯ menu |
| Guest Home (Sign in / Sign up, sample "A 15-second film", sign-up 3a/3b; `Guest Home frames.dc.html`) | Visitor Home (Made with Particl, How it works), Sample · Dune Studies board, join sheet (invite / request access), invite links, no-access page |
| Phone screens home/plan/review/fix/record/make/atomik/states (`Phone frames.dc.html`) | Phone visitor screens only (owner: keep the old phone spec?) |
| Rig → "the Board itself" | Rig returns as a board view |
| Keyboard: ⌥M Make, ⌘J Inspector, L list view | ⌘2 Make, ⌘J Atomik panel, L Library tray |

---

## 16 · Repo pointers (aimighty-workspace; read-only look)
Tokens: `app/graphite.css` already defines `--gx-*` / `--graphite-*`; fonts in `app/fonts.css` (Geist self-hosted as a fallback). Quotes: `app/api/generate/quote`, `app/api/rig/quote`, `lib/composerQuote.ts`, `lib/price.ts` (`useMoney`, `usePrice`, `fmtCredits`), `lib/credits.ts` (`quotedCredits`, `creditCheck`), `lib/held.ts`. Money: `lib/billingConfig.ts`, `lib/billingLedger.ts`, `lib/creditConversion.ts`, `app/api/plans`, `app/api/topups`, `app/api/workspaces/topups`, `lib/approvalRule.ts`, `lib/budgetPause.ts`. Jobs: `app/api/jobs`, `app/api/jobs/[id]`, `.../release`. Push: `app/api/push/subscribe|unsubscribe`. Access/invites: `components/RequestAccess.tsx`, `app/api/access-request`, `app/api/team/invites/[code]`, `app/api/admin/invites`, `app/api/auth/accept|signup`. Menus: `components/ContextMenu.tsx`. Rig: `lib/boardGraph.ts`, `lib/impact.ts`, `lib/workbench/node-graph.ts`. Skills: `lib/atomikSkills.ts`.

---

## 17 · Proposed PR-sized work items (dependency order)
Flags: **$** money (top-up/payment/billing/spend rules) · **AUTH** sign-in/accounts/access · **DB** schema change · **ENV** env vars/secrets. Any flagged item needs the owner.

**T · Foundations**
- T01 Token layer: CSS variables for § 3 (extend `--gx-*`), type scale, radii, elevation, motion keyframes + reduced-motion defaults. No visual change.
- T02 Primitives: Button (primary / outlined / hot), Pill/Chip, Segment, IconButton with a required tooltip (name · line · shortcut · price slot), Kbd.
- T03 Overlay stack: Popover/Menu/ContextMenu/Dialog/Sheet on one layer stack with the § 4.1 Esc order, outside-click, focus return.
- T04 Price display + quote hooks: `<Price>` (cr, "up to", free, held; $ on hover from billing config) + `useQuote(action)` over the existing quote routes. A lint/test bans literal "N cr" in components. (Read-only money display; no payment.)
- T05 Toast with Undo/View (one position rule), plus the tab-title helper.

**P1 · Shell**
- S01 Header frame + logo + layout slots (56 px), signed-in/visitor variants.
- S02 Tab group: hugging tabs, Home/Make pinned, board tabs (dot, ×, ring slot), overflow "+N ▾", ⌘1/⌘2/⌘3+, tab right-click menu.
- S03 Merged Atomik field (⌘K trigger + panel icon ⌘J + unread dot) and Atomik side panel shell (340 px, thread switcher).
- S03b ⌘K palette (go to, stages, cards, library, actions with quotes, Ask Atomik).
- S04 + popover (find, recent, recently closed, new board by kind).
- S05 Activity pill + dropdown (Needs you / Running with time left + Open card, scope) on the jobs API.
- S06 Settings › Credits & billing page (balance, per-board month, history, CSV, Top up entry). **$**
- S07 Low-credit chip (< 20% of plan credits; plan credits from config). **$** (config)
- S07b Account menu (balance, Top up, Credits & billing, Settings, Sign out). **$ AUTH**
- S08 Shared Bar component (+ Attach, @ mention popover, chips, selection/tool chips, quoted send button, "/" hook slot).
- S09 Home signed in (Waiting for you, showcase wall with pick sheet + hover actions, Your boards + filters).
- S10 Bottom-left controls (Library L button, view segment).
- S11 Library tray (360 px: search, brand picker, All/Uploaded/Generated, kind chips, masonry, source badges, missing-packshot line, drag to canvas/bar/tile, keep-as). **DB?** (asset source/kind if absent)
- S12 (optional) Library page refresh (brands, kit rows, inspector).
- S13 Make page: justified grid (date dividers), hover actions, docked composer (modes, settings chips, refs, quoted Make), prompt reuse into the composer.
- S14 Make viewer (‹ › ←/→, prompt/seed reuse, actions, Esc).
- S15 Right-click menus: card single/multi, canvas, Make result + empty space (tab menu in S02). Wire the shortcuts shown.
- S16 Keyboard map + tooltip audit (every icon; fix the `A` conflict).

**P2 · Boards**
- B01 Board kinds + rails config (Film, Pre-vis, Campaign, Social narrated/clips incl. Elements; first-open stage; persisted kind/track/stages). **DB**
- B02 Rail component (markers, summaries, hover rename/⋯, skip/remove/undo, drag reorder, + Stage presets, kind label).
- B03 New-board flow (composer, kind cards, auto-detect, dimmed rail, quoted Start, Edit stages).
- B04 Stage header (breadcrumbs, sub pill, meta, one primary only where its action lives).
- B04b Board ⋯ menu: Versions, Export and share, Spend on this board, Autonomy. **$** (spending rules)
- B05 Canvas shell: dot grid, zoom/fit, mini-map, Tidy, select/drag/marquee, right toolbar + first-visit labels (persist "Got it"). **DB?** (user pref)
- B06 Shared 4-across card grid + Card component (anatomy § 6.6; finished shots Approve · Reject only); fixes FIX 2.
- B07 Board bar wiring (selection chip, armed-tool chip, Ask · free / quoted Make, Attach).
- B08 Film stages I: Brief, Script, Cast, Elements (groups, ↑/✦, locks, no redundant Approve).
- B09 Film stages II: Storyboard (toolbar, takes, drift Fix, locked frame, plan card with quoted lines + fix allowance + balance after), Cut, Deliver, Pre-vis Animatic/PPM deck/Shot list.

**P3 · Render**
- R01 Render-state model/hook: job → queued/preparing/rendering/saving/slow/failed/ready, typical ranges from config/job history, elapsed, 90% cap, slow at 2×.
- R02 Rendering card overlay: blurred source, particle field confined above the text, one-line time, held money line, Cancel with tooltip/confirm, failed + quoted Retry, reveal, reduced motion. Fixes FIX 3. **$** (cancel billing semantics)
- R03 Batch: Shots header line, approve-while-rendering, tab ring, Make tile and Rig node variants.
- R04 Running list rows in Activity, ready toast "Shot N is ready · View", "(N ready) Particl" title.
- R05 Browser notification opt-in (first job over a minute; web push subscribe). **ENV** (VAPID keys)

**P4 · Visitors**
- V01 Visitor mode + `gate()` (README's full gated list; prompt kept; no avatar/Activity/credits). **AUTH**
- V02 Visitor Home (public showcase only, How it works), visitor Make ("Sample"), read-only Sample board pill. **DB?** (showcase source)
- V03 Join sheet desktop (two paths, Esc/× keep text, request-access form with Company/Role/Size/want → access-request API) + confirmation. **AUTH DB**
- V04 Invite links: banner, prefilled code + inviter, team join (Google/email), new workspace (name → plan/credits step from config), expired → request access. **AUTH $ DB**
- V05 Phone visitor shell: Home, bottom-sheet join with **Continue with email** and full parity, invite banner, confirmation. Fixes FIX 4. **AUTH**
- V06 After joining: land on Home with the prompt kept and its quote shown. **AUTH**
- V07 No-access page + workspace-scoped search/⌘K/Atomik (never a preview). **AUTH** (security)

**P5 · Rig**
- G01 Rig layout: three columns, subject crops, two-line names, group chips, fit 1440 × 900 or scroll inside the canvas, hint in reserved space. Fixes FIX 1.
- G02 Rig interactions: selection lighting, edges, drag-to-add, edge remove/⌫, impact popover with quote + approval, double-click expand, Esc.
- G03 Recipes panel + Save as skill → "/recipe". **DB?** (if saved skills need new fields)

**P6 · Kinds, Remix, skills**
- C01 Campaign stages: Product, Look, Formats (sum of picked quotes), Variants grid, Deliver.
- C02 Social stages: narrated Hook/Script/Scenes/Voice/Captions; clips Source/Moments/Clips/Captions.
- C03 Remix: wall "Remix this" → Make Remix (4 ops quoted, source required).
- C04 "/" skills menu in every bar (quoted list, single render).

Not scheduled (other prototype features, § 11): X01 List/Strip/Cut tracks · X02 Send sheet, client marks, feedback → Round 2, versions/compare, export, budget, details, PDF import.
