# Handoff diff: Graphite (3 October) → "the board, made easy" (4 October)

What changed in the design handoff between the previous bundle (`design/particl-graphite/`, written 3 October 2026) and the new one (written 4 October 2026). "README §n" means the new README unless it says otherwise; "previous README" is the 3 October one. "The master" is the new `Particl Suites.dc.html` unless it says otherwise. Claims were checked against both masters with text searches; where a claim could not be confirmed, it says so.

The new handoff describes a design, not a build. Its old → new link table (README §1.2) states intent: the master still renders most old links the old way (see §2, "What the master does with old links").

## 1. Summary

- **Six destinations become four, and suites become templates.** The header goes from Studio · Gen · Business · Viral · Atomik · Crew to Home · \<current project\> · Make · Atomik (README §1, header option B). Studio, Ads and Social are templates picked on Home; every project is one board, and every board looks the same.
- **About forty pages fold into one board per project.** Studio's ten stages, Business's eight pages and Viral's three become sections in a board's outline rail. The 46 px page strip is gone. The Library and Inspector stop being fixed columns: the Library becomes a rail drawer, closed by default, and the Inspector opens only on a selection.
- **`lib/shell/ia.ts` stops being the source of truth.** The previous handoff told us to copy the IA from it. The new one says `ia.ts` "is replaced by § 1 below" (README preamble, github.md screen map).
- **The money model is new.** There is one approval per plan, with a fix allowance, a 40 cr per-shot admin rule, an 80 % budget pause, Ask/Auto ("spend without asking"), a billed thinking cost, Top up beside a short Approve, and "Nothing billed" on failures. Prices read "N cr", "up to N cr" or "free"; the bare word "quoted" is gone, and hovering a price shows its dollar value (README §4, §5).
- **Tokens are darker, bigger and brighter.** Panels go to `#000`, cards to `#0B0B0D` and inputs to `#0A0A0C`. Body text goes from 13 to 14, meta from 11–11.5 to 13 and eyebrows from 10 to 12. There is a hard floor of ≥ 12 px and ≥ 55 % white on desktop as well as phone, and card radii go from 8 to 10–12 (README §2).
- **Product names are replaced.** Rig → Board, Astra → 3D blocking, Genjutsu → Motion transfer / Object swap, Moleculr Business Suite → Ads, Subatomik Viral Studio → Social, Gen → Make, Soul → Identity, and "frozen" → held (README §7).
- **Every pending suite is now designed.** Atomik becomes a panel plus a four-place control room; Settings gets five sections; Ads and Social have boards; the phone has eight screens (home, plan, review, fix, record, make, atomik, states). Previously all of these were spec only, behind a "next in the rebuild" card.
- **The bundle is restructured.** `notes/` and `reference/` are gone. Six "… frames.dc.html" files and `CHANGES.txt` are added. The bundle runs offline: React, ReactDOM and Babel are in `assets/vendor`, the stills are in `assets/`, and no web font is loaded (Geist is no longer fetched from Google Fonts).

## 2. Information architecture

### Header and navigation

| | Previous handoff | New handoff (README §1) |
|---|---|---|
| Header | 56 px; mark + suite pill (STUDIO · GEN · BUSINESS · VIRAL · AGENT · CREW · WORKSPACE); six-tab segment Studio · Gen · Business · Viral · Atomik · Crew; search; Jobs pill; credits; avatar | 56 px; mark + suite pill (the master reads HOME · BOARD · ADS · SOCIAL · MAKE · ATOMIK · SETTINGS); segment **Home · \<current project\> · Make · Atomik**; Search (⌘K); Jobs pill; credits; avatar |
| Suite choice | A header destination per suite | A template on Home: Film and Start from a script open a Studio board, Ad campaign opens an Ads board, Social clips opens a Social board |
| Page navigation | 46 px page strip per suite (numbered tabs, group gaps) | No page strip. A board **outline rail** with an icon, a 12 px label and a status per section (empty · working · needs you with a count · done); hovering gives a one-line summary; clicking glides the board there |
| Rail sections | — | Studio: Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver. Ads: Brand · Product · Hooks · Formats · Ads · Adapt · Deliver. Social: Source · Clips · Hooks · Effects · Posts |
| Body | Grid: Library 280 · stage · Inspector 320, hairline gaps | Full-bleed board on a dot grid; Library and History are 280 px rail drawers (closed by default); the Inspector opens on selection (340 px in the master); Atomik's panel is docked right |
| Make / Gen | A destination (`view=gen`) | A panel over any screen (440 px in the master) |
| Atomik | A suite with eight pages | A panel over any screen, plus a control room in four places |
| Crew | A destination with three pages | "Ask the crew", a review panel inside boards |
| Workspace / Settings | Seven tabs, reached from credits and the account menu | Five sections behind the avatar |

The master also keeps **header option A** (Home · Studio · Ads · Social · Make · Atomik), reachable with `header=a` or `header=destinations`. README §1 records only option B as chosen; option A appears only in `Home and header options.dc.html`.

### Old → new links

Condensed from README §1.2. The first column is the previous handoff's page and parameters.

| Previous handoff's page / param | New handoff |
|---|---|
| Studio overview `?suite=studio&page=stages` | Home `?view=home` (projects as cards) |
| 01 Brief & Script `page=brief` | Studio board › Brief `?view=board&frame=d`; the questions step is `frame=b` |
| 02 Beats & Shots `page=beats` (`&beats=graph`) | Studio board › Storyboard; the shot list is the board's List view (`frame=d`); `beats=graph` → the board itself |
| 03 Storyboards `page=boards` | Storyboard `frame=d`; Looks `frame=c` |
| 04 Environment `page=environment` (README writes `env`) | Cast region (Cast, Environment and Elements cards) `frame=h` |
| 05 Cast & Elements `page=cast` | Cast `frame=h` (identity status, consent record) |
| 06 Astra 3D `page=astra` | **3D blocking**, a tool on a shot card (Inspector › Advanced); no page |
| 07 Rig `page=rig` (`&rig=list`) | **The board** `?view=board` and its List view |
| 08 Takes `page=takes` | Shots `frame=f`/`g`, Review mode `frame=l`, Make › Recent `make=recent` |
| 09 Edit & Sound `page=edit` | Cut `frame=i` ("Open Edit & Sound" opens the editor) |
| 10 Deliver `page=deliver` | Deliver card `frame=i` |
| Gen `?view=gen&mode=video\|images\|audio` | Make panel `&make=1\|image\|audio` |
| Gen tools `&task=edit\|upscale` | "Change with words" and card actions |
| Gen model sheet `&sheet=1` | "Change" on the engine line, `make=change` |
| Business › Image ads `?suite=business&page=dtc` | Ads board `kind=ads&frame=2` |
| Business › Setup, Brand, Product, Reference | Ads board `frame=1` cards |
| Business › Format, Hooks | Ads board `frame=2` (Hooks card, Format briefs card) |
| Business › Design (poster designer) | Ads board `frame=3` |
| Viral › Motion Transfer, Object Swap `?suite=viral&page=motion\|swap` | Make › Motion transfer / Object swap `make=motion\|swap`; Social board Effects `kind=social&frame=2` |
| Viral › History `page=history` | Make › Recent and the board's History drawer |
| Crew `?view=crew&crew=room\|members\|sessions` (`&room=done`) | Crew review `frame=m`; sessions in the Project record `frame=n` |
| Atomik › Agent `?suite=atomik&page=agent` | Atomik's panel `&atomik=1`; the plan card `frame=e` |
| Atomik › Runs `page=runs` | Control room › **Activity** (same URL) |
| Atomik › Approvals `page=approvals` | Control room › Approvals (same URL) |
| Atomik › Budget `page=budget` | Settings › Spending rules `?view=workspace&ws=rules`; per-project spend in Activity and the Project record |
| Atomik › Models `page=models` | Settings › Advanced › Models `ws=advanced&open=models` |
| Atomik › Tools & connections `page=skills` | Settings › Connections `ws=connections`, and Advanced › Tools |
| Atomik › Memory, Skills `page=memory\|saved-skills` | Control room › Memory, Skills (same URLs) |
| Workspace `ws=general\|people\|credits\|usage\|dashboard\|engines\|security` | Team (`people`, `security`) · Plan & credits (`credits`, `usage`) · Spending rules · Connections · Advanced (`engines`, `general`); `dashboard` → Activity |
| `&lib=0\|assets`, `&insp=0` | No-ops |
| `&palette=1` | Still opens ⌘K |

### Parameters that are now no-ops (README §1.2)

`lib=0|assets` and `insp=0`. In practice `beats`, `rig`, `mode`, `task`, `sheet`, `crew` and `room` are no-ops on the new screens too, though the README does not say so: the master still parses all of them, but only the legacy views read them.

### New parameters

| Param | Values | Notes |
|---|---|---|
| `view` | `home` · `board` · `workspace` | With no params the master opens Home. `?view=board` with no `frame` opens frame `i` (Studio) or `1` (Ads, Social) |
| `frame` | `a`–`p`, `f2` (Studio); `1`–`3` (Ads); `1`–`2` (Social) | The master maps `f2` to an internal `q` |
| `kind` | `ads` · `social` | Omitted means a Studio board |
| `make` | `1` · `image` · `audio` · `change` · `fill` · `made` · `recent` · `motion` · `swap` | Usable over any view |
| `atomik` | `1` · `how` | The panel; the free how-to answer |
| `device` + `screen` | `device=phone&screen=home\|plan\|review\|fix\|record\|make\|atomik\|states` | Plus `from=notification` (plan), `credits=short` (plan), `paused=1` (record) |
| `ws` | `team` · `credits` · `rules` · `connections` · `advanced` | The master defaults to `team`; it has no aliases for the old ids (see below) |
| `open` | `models` | Unfolds Advanced › Models |
| `settings` | `1` | The menu behind the avatar |
| `q` | free text | With `palette=1`, prefills ⌘K (e.g. `go to cast`, `approve everything under 10 cr`); also prefills the phone Atomik sheet |

Not in the README, but parsed by the master: `header=a|b|destinations`; `suite=ads|social` and `view=make`, aliased to `business`, `viral` and `gen`; `tools=connect`; `skill=hero-takes|coverage-check|plates|continuity`; `lib=1`; `insp=1`.

### What the master does with old links

Confirmed by reading the master's state set-up and render conditions:

- `?suite=studio&page=<stage>` still renders the old stage page, with the page strip and the renamed labels ("3D blocking", "Board"). `Home and header options.dc.html` itself uses `?suite=studio&page=rig` for its "Board" frames.
- `?suite=business|ads…`, `?suite=viral|social…` and `?view=crew` render the dashed "This page is next in the rebuild" card under the new names.
- `?view=gen` (or `view=make`) renders the old Gen composer page, retitled "Make" with the hint "One box for every engine".
- `?suite=atomik&page=agent|budget|models|skills` lands on Approvals, because the Atomik suite now lists only four pages. It does not go to Settings, as README §1.2 says.
- The old `ws=` ids (`general`, `people`, …) are not aliased. Their landing is unconfirmed; a blank or default section is likely.

## 3. Names

| Previous | New | Source |
|---|---|---|
| Rig | **Board** | README §7 |
| Astra (Astra 3D) | **3D blocking** | README §7 |
| Genjutsu | **Motion transfer / Object swap** (sentence case; previously "Motion Transfer", "Object Swap") | README §7, master |
| Moleculr Business Suite (mark BUSINESS) | **Ads** (mark ADS) | README §7, master |
| Subatomik Viral Studio · Genjutsu (mark VIRAL) | **Social** (mark SOCIAL) | README §7, master |
| Gen / Generate (title "Generate", hint "One composer for every engine") | **Make** (hint "One box for every engine") | README §7, master |
| Soul / Soul ID | **Identity** | README §7 (the previous handoff had already removed "Soul" wording) |
| Supercomputer → Agent; suite "Atomik Agent", mark AGENT | **Atomik** (mark ATOMIK); "Atomik Agent" is gone | README §7 says Supercomputer → Atomik; the previous handoff had renamed it Agent |
| Crew (destination; Room titled "Crew") | **Crew review** | README §7, master |
| Takes & assets wall | **Make › Recent** | README §7 |
| "frozen" | **held** (approved, not yet settled) | README §5, §7; see the conflict in §6 |
| "quoted" (price word) | **up to N cr** | README §5 |
| Particl Production Studio | **Studio** | master |
| Workspace (mark WORKSPACE) | **Settings** (mark SETTINGS) | master |
| Plans & credits | **Plan & credits** | README §3.5 |
| General · People · Usage · Dashboard · Engines · Security | **Team · Spending rules · Connections · Advanced** (with Plan & credits) | README §1.2 |
| Atomik › Runs ("Durable, recoverable, accounted") | **Activity** ("Runs and spend · settled cost per run and project") | master |
| Atomik › Budget | **Spending rules** (in Settings) | README §1.2 |
| Atomik › Tools & connections | **Connections** (in Settings) | README §1.2 |
| Approvals hint "Nothing paid without a gate" | "One queue across projects" | master |
| Memory hint "Brand, audience and references Atomik keeps in mind" | "Brand, audience, references and cast" | master |
| History hint "Every result, retained as original bytes" | "Every result, kept as the original file" | master |
| Format hint "… made in Gen" | "… made in Make" | master |
| Generate button (`Generate · 43 cr`) | **Make · 43 cr** | README §4 |
| Page strip | **Outline rail** | README §1.1 |
| Library (Tools \| Assets column) | **Library drawer** | README §1.1 |
| Phone "Home as the suite picker", dock | Phone tabs **Home · Record · Make · Atomik** | master |

## 4. Tokens

Values are quoted from the previous README › Design tokens and README §2. "—" means not stated.

### Surfaces

| Token / role | Previous | New | Changed? |
|---|---|---|---|
| Canvas | `#000000` | `#000000` | No |
| Panel | `#0D0D10` | `#000000` ("canvas and all panels") | **Yes** |
| Card | `#17171B`, border `rgba(255,255,255,0.10)` | `#0B0B0D`, `1px rgba(255,255,255,0.10)` (media tiles, takes, cast/place/brand cards, dialogs, popovers) | **Yes** |
| Input / tile | `#1B1B1F` (hover `#26262B`, pressed `#3A3A40`), border `rgba(255,255,255,0.08)` | `#0A0A0C`, `1px rgba(255,255,255,0.08)`; focus is the accent border; hover and pressed not stated | **Yes** |
| Segment track | `#1C1C20` | `#0D0D10` | **Yes** |
| Selected segment | `#3A3A40` | `#1C1C20` | **Yes** |
| Secondary button | `#1B1B1F` fill, border `.10` | Outlined on black, `1px rgba(255,255,255,0.14)` | **Yes** |
| Viewport (3D) | `#07070A` | — (absent from the master) | Removed |
| Hairline, panel separation | `rgba(255,255,255,0.09)` | `rgba(255,255,255,0.09)` | No |
| Hairline, inputs and dividers | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.08)` (inputs) | No |
| Row separators | `rgba(255,255,255,0.06)` | `rgba(255,255,255,0.06)` | No |
| Popover / dialog / hover borders | `.12` / `.14` / `.24` | — (the master still uses `.12` and `.14`) | Not stated |
| Dashed drop zones | `rgba(255,255,255,0.16)` | `rgba(255,255,255,0.16)` | No |
| Media badges | `rgba(0,0,0,0.6)` | `rgba(0,0,0,0.6)` | No |
| Scrims | `rgba(0,0,0,0.55)` | `rgba(0,0,0,0.55–0.6)` (phone sheets use `0.6`) | Widened |
| Phone sheets | Earlier notes: `#0F1116`, top radius 18, scrim `rgba(5,6,8,.55)`, grabber 36×4 | Master: `#000`, top border `.14`, radius 16 top, scrim `rgba(0,0,0,0.6)`, grabber 36×4 at `rgba(255,255,255,0.2)` | **Yes** |
| Board dot grid | Beats Graph and Rig: `radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px) 0 0/22px 22px` on `#000` | `radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px) 0 0 / 24px 24px` on `#000` | **Yes** (alpha .07 → .06, pitch 22 → 24); see "Gradients" |

### Text

| Role | Previous | New | Changed? |
|---|---|---|---|
| Primary | `#F5F5F7` | `#F5F5F7` | No |
| Secondary | `rgba(235,235,245,0.6)` | `rgba(235,235,245,0.6)` | No |
| Tertiary | `.5` / `.45` | — (folded into quiet) | Removed |
| Quiet | `.4` / `.35` | `0.55` | **Raised** |
| Eyebrow | 10/600/+0.12em uppercase at `.45` (`.5` on Library groups); the repo token is `.4` | `rgba(255,255,255,0.55)`, 12/600/+0.08em uppercase | **Yes** |
| Disabled | `opacity .45` | `0.45` ("fainter only for disabled things") | Same value, now named |
| Placeholder | `.35` | — in the README; the master uses `rgba(255,255,255,0.55)` | **Yes** (master only) |

### Accent and tints

| Role | Previous | New | Changed? |
|---|---|---|---|
| Accent | `#0A84FF`, hover `#2D95FF` | `#0A84FF`, hover `#2D95FF` | No |
| Accent text | `#6EB4FF` (link hover `#8FC4FF`) | `#6EB4FF` (link hover not stated; still `#8FC4FF` in the master's base CSS) | No |
| Tint | `rgba(10,132,255,0.14)`; backgrounds `.10` / `.12` / `.08` | `rgba(10,132,255,0.14)` | Simplified |
| Tint border | `rgba(10,132,255,0.35)` / `.45` / `.5` | `rgba(10,132,255,0.35–0.5)` | No |
| Selection ring / focus | `0 0 0 2px #0A84FF, 0 0 0 5px rgba(10,132,255,0.22)` (selection) | "Visible focus rings"; the master uses `outline: 2px solid #0A84FF; outline-offset: 2px` | **New focus rule** |

### Status and suite colours

| Role | Previous | New | Changed? |
|---|---|---|---|
| Success / text | `#30D158` / `#4CD964` (tint `rgba(48,209,88,0.14)`) | `#30D158` / `#4CD964` | No |
| Warning / text | `#FF9F0A` / `#FFB340` | `#FF9F0A` / `#FFB340` | No |
| Danger | `#FF453A` (no text variant) | `#FF453A` (no text variant; the master uses it as text on "Failed" badges) | No. The repo has added `--gx-failed-text #FF6961` because `#FF453A` text fails the label floor |
| Purple / cyan | `#BF5AF2` (Crew, Audio port) / `#64D2FF` (Music lane) | Purple as the Crew dot only; cyan not listed (still used twice in the master) | Partly |
| Suite dots | Studio `#0A84FF` · Business `#FF9F0A` · Viral `#FF453A` · Atomik `#30D158` · Crew `#BF5AF2` | Studio blue · **Ads** `#FF9F0A` · **Social** `#FF453A` · Atomik `#30D158` · Crew `#BF5AF2` | Values unchanged; Business → Ads, Viral → Social, and they now mark templates and boards |

### Type

Families are unchanged: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Geist, system-ui, sans-serif`, with mono `ui-monospace, "SF Mono", Menlo, monospace`. There are two differences. Geist was loaded from Google Fonts before; now no web font is loaded (`assets/README.txt`). Mono is now "for prices and numbers only".

| Desktop role | Previous | New | Changed? |
|---|---|---|---|
| h1 | 26/600/−0.03em/1.1 | 26/600/−0.03em (Home's "What are we making?" is 30 in the master) | No |
| h2 | 16–17/600/−0.01em | — | Not stated |
| Panel title | 15/600 | — | Not stated |
| Card title | 13–14/600 | 15/600/−0.01em | **Yes** |
| Body | 13/1.45 (root) | 14 | **Yes** |
| Documents | — | 15/1.5 | New |
| Meta | 11–11.5 | 13 (at 0.6) | **Yes** |
| Eyebrow | 10/600/+0.12em uppercase | 12/600/+0.08em uppercase (0.55) | **Yes** |
| Controls | 12–12.5/500, primary 600 | 12.5–13 | **Yes** |
| Mono numerals | 9–12 (badges 9–9.5, strip numbers 11, prices 11.5–12/600) | — (12–14 in the master) | Raised |

| Phone role | Previous | New |
|---|---|---|
| Titles | — (phone not designed; rule "nothing smaller than 12px text") | 17/600 |
| Card titles | — | 15/600 |
| Body | — | 14–15 |
| Meta | — | 13 |
| Eyebrows | — | 12 |

**Minimums.** Previously only the phone had a floor (≥ 12 px text, ≥ 44 px targets); desktop used 9–11.5 px text and the fainter tiers `.5` / `.45` / `.4` / `.35`. Now "nothing read is below 12 px or below 55 % white on desktop or phone". Only disabled things may be fainter, focus rings must be visible, and phone targets are ≥ 44 px (README §0 rule 8, §2). A scan of the masters bears this out. The previous master had 184 font-size declarations under 12 px. The new one has two at 11 px: the phone tab-bar count badge (text, below the floor) and a play glyph; its text alphas are `.55` and up, except two `.45` (one is a disabled control) and `.35` on the phone record's unsettled "—" values.

### Radii, shadows, motion, spacing

| Role | Previous | New | Changed? |
|---|---|---|---|
| Buttons, inputs | 6 | 6 (phone 10) | Phone added |
| Small inputs, tile buttons | 5 | — | Not stated |
| Segment buttons, badges, kbd | 4 | — (the master still uses 4 px in 49 places) | Not stated |
| Cards, popovers, tiles | 8 | Cards 10–12 (the master still uses 8 px in 50 places, including asset tiles and menu rows) | **Yes** |
| Groups | — | 14 | New |
| Dialogs | 10 | 10 | No |
| Sheets | Earlier notes: top 18 (iPhone cards 12) | 16 top | **Yes** |
| Pills | 999 | 999 | No |
| Shadows | Popovers `0 16px 40px rgba(0,0,0,0.6)` · dialogs `0 32px 80px rgba(0,0,0,0.7)` · toast `0 12px 32px rgba(0,0,0,0.6)` · search `inset 0 1px 2px rgba(0,0,0,0.6)` · node `0 1px 0 rgba(0,0,0,0.4)` · selection ring · port glow `0 0 0 4px rgba(10,132,255,0.35)` · live dot `0 0 8px rgba(10,132,255,0.8)` | **Not listed in README §2.** The master keeps the first four and adds `0 24px 60px rgba(0,0,0,0.7)` and `-24px 0 60px rgba(0,0,0,0.6)` (panels and drawers) | Unspecified |
| Easing | `cubic-bezier(.2,.7,.2,1)` | same | No |
| `om-in` | .4 s page · .2 s scrims · .25 s toast | same | No |
| `om-pop` | .2 s popovers and dialogs · .15 s menus · .3 s wall tiles | .2 s dialogs · .15 s menus (the master also uses .25 s and .3 s) | Wall tiles dropped |
| `om-pulse` | 1.4 s live dots | 1.4 s | No |
| Colour transitions | .2 s; progress bars `width .4s linear` | .2 s; progress not stated (still `.4s linear` in the master) | No |
| Board glide | — | **.35 s** | New. Not found in the master, which uses `scrollTo({ behavior: 'smooth' })` |
| Spacing | Full scale (page 20, card 14–18, gaps 14/10–12/8/6/4, control heights 24–34, header 56, strip 46, Library 280, Inspector 320) | Header 56, drawers 280, phone targets 44; no other spacing stated. The master's Inspector is 340 and Make is 440 | Mostly unspecified |

### Gradients (flagged, not resolved)

README §2 says "No gradients except project swatches and avatars", and PROMPT.md says the same. README §2 then defines the board dot grid as a `radial-gradient`. The previous README carried the same contradiction (ground rule 1 against the Beats Graph and Rig dot grid), and `app/graphite.css` adds that "a value the README does not list is not a token and is not added". The repo's `CLAUDE.md` has no rule on gradients that I could find. The new master also uses gradients outside the stated exceptions:

- media placeholders: `linear-gradient(180deg,#26262B,#0B0B0D)`, `linear-gradient(135deg,#26262B,#141416)`, and for audio `linear-gradient(135deg,#2A1E3A,#121016)`;
- the multicolour "All" filter dot: `linear-gradient(135deg,#0A84FF,#30D158,#BF5AF2)`;
- the chrome-sphere highlight: `radial-gradient(circle at 35% 30%, …)`;
- audio stripes: `repeating-linear-gradient`;
- the flair aurora, which is still off by default.

## 5. Screens

### Added

- **Home** `?view=home`: "What are we making?", templates (Film · Ad campaign · Social clips · Start from a script), image-led project cards, Waiting for you (with prices), and a sample production that spends nothing.
- **Home overlays**: Make `&make=1`; Atomik `&atomik=1` and how-to `&atomik=how`; ⌘K `&palette=1` and `&q=…`; the Settings menu `&settings=1`.
- **Studio board, frame a** `?view=board&frame=a`: an empty board with Attach, aspect and length chips, **Start · up to 4 cr** and a quiet templates row.
- **Frame b**: Atomik asks up to three questions (chips, a free field, "Use your judgement").
- **Frame c**: Looks, four frames after **Show me looks · 12 cr**.
- **Frame d**: the brief document card, the storyboard strip (**Draw the storyboard · 9 cr**) and the outline rail statuses; also the Board/List toggle.
- **Frame e**: the plan approval card, **Make 3 shots · 93 cr**, with the fix allowance, the balance after, and Approve · Change · Hold.
- **Frame f**: shots rendering in place, with "Rendering 1 of 3 · cost so far · Stop".
- **Frame f2** `frame=f2`: the pause at 80 % of the budget, with Continue or Stop.
- **Frame g**: a take card in review, v1/v2, Approve, Reject and Atomik's note.
- **Frame h**: Cast, Environment and Elements; identity status, **Build identity · 54 cr**, the consent record, **Lock as master · free** and **Render a still · 3 cr**.
- **Frame i**: Cut (approved takes, mini timeline, Open Edit & Sound) and Deliver (spec check, **Render master · free**).
- **Frame j**: "Where to next?" cards.
- **Frame k**: the Inspector on a take (preview, prompt, engine line, price paid, versions, history, the six actions, Advanced folded).
- **Frame l**: Review mode (J/K, A, R, space, C; side-by-side and slider compare).
- **Frame m**: Crew review (Director, DOP, Costume and Continuity seats; notes as cards).
- **Frame n**: the Project record tab (brief, approvals → settled, open decisions, spend against the budget).
- **Frames o and p**: the Library drawer (a look frame dragged onto a shot) and the History drawer.
- **Make panel states** `…&make=1|image|audio|change|fill|made|recent|motion|swap`: the panel; the type switch; the engine sheet; Atomik filling the fields; a result landing on the board and in the Library; Recent; the Motion transfer and Object swap quick tools.
- **Ads board**: `kind=ads&frame=1` (Brand kit, Product facts, Reference ad), `frame=2` (Hooks · 12, Format briefs · 18 in 6 formats, image, video and UGC ads, **Adapt · 54 cr**) and `frame=3` (the poster Designer).
- **Social board**: `kind=social&frame=1` (source video, three clips with hook, captions and 9:16) and `frame=2` (scored hook review with reasons, priced effects, narrated video, a post card per platform).
- **Atomik control room**, four places at `?suite=atomik&page=approvals|runs|saved-skills|memory`: Approvals (one queue, approve-in-one-go **Confirm**, the Ask/Auto switch), Activity, Skills and Memory.
- **Settings**, five sections at `?view=workspace&ws=team|credits|rules|connections|advanced` (`&open=models`).
- **Phone** `?device=phone&screen=…`, at 390 × 844: `home`, `plan` (`&from=notification`, `&credits=short`), `review`, `fix`, `record` (`&paused=1`), `make`, `atomik` and `states`.

### Removed

- **Studio's ten stage pages and the overview**, `?suite=studio&page=brief…deliver|stages`. They fold into the board regions above, and the overview into Home.
- **The page strip** on every suite and on Crew.
- **Gen as a page**, `?view=gen…`. It becomes the Make panel.
- **Business's eight pages**, `?suite=business&page=dtc|setup|brand|product|format|hooks|reference|design`. They become Ads board frames 1–3.
- **Viral's three pages**, `?suite=viral&page=motion|swap|history`. They become Make quick tools, the Social Effects card, and Make › Recent plus the History drawer.
- **Crew as a destination**, `?view=crew&crew=room|members|sessions`. It becomes Crew review (`frame=m`) and sessions in the Project record (`frame=n`). The Members page has no stated new home.
- **Atomik's eight pages.** Agent → the panel and the plan card (`frame=e`); Runs → Activity; Approvals stays; Budget → Settings › Spending rules; Models → Settings › Advanced › Models; Tools & connections → Settings › Connections and Advanced › Tools; Memory and Skills stay.
- **Workspace's seven tabs** → five Settings sections (see §2).
- **The Library and Inspector as fixed columns** (280 and 320, with the `lib` and `insp` params).
- **The 3D blocking page** (Astra), which becomes a shot-card tool. So do Seedance Edit and the Astra and Topaz upscale task views (`task=edit|upscale`), which become card actions and "Change with words".
- **The Gen composer's Shot control rows, Setup and Cast cards, and Direction card.** These are replaced by "Auto by default" and the one-line engine summary with Change (README §0 rule 2). That the old blocks are gone from the Make panel is inferred from the frames, not checked line by line.

### Changed

- **Library**: a rail drawer, closed by default, 280 px, with no Tools tab (`frame=o`).
- **Inspector**: opens only on a selection; 340 px in the master; Advanced folded (`frame=k`).
- **⌘K**: search plus Atomik commands ("go to …", "make …", "approve everything under N cr" with a one-tap Confirm, and items needing an admin left out) (`?view=home&palette=1&q=…`).
- **Jobs tray**: still in the header. Its "held" meaning is in flux (§6). README §3 does not respecify it.
- **Phone**: it used to be "Home as the suite picker" with a dock. Now it judges rather than makes, with tabs Home · Record · Make · Atomik; Home shows "Needs you" first.
- **Header pill**: shows HOME, BOARD, ADS, SOCIAL, MAKE, ATOMIK or SETTINGS rather than a suite mark.

## 6. New states

| State | New handoff | Previous handoff | In the new master? |
|---|---|---|---|
| Rejected | The take card dims and keeps its version; "Rejected · nothing more spent" (README §3.1) | None; there was only Delete with an undo toast | Partly: Review mode's R key and the toast "Rejected · nothing billed" (different words) |
| Failed | "Nothing billed" with Retry when nothing was charged, else the cost and Retry | Jobs tray failed dot `#FF453A` with **Recreate** | Phone `screen=states` only ("Nothing billed · Retry · 7 cr"); no desktop board version found |
| Stopped | The group header shows "Stopped · N cr spent"; slots keep what finished | Queued jobs could be released: "… released · nothing billed" | Toast "Stopped · what finished is billed; nothing more"; header line not found |
| Insufficient credits | "Short by N cr" with **Top up** beside Approve, which waits | None | Phone only: `plan&credits=short` ("Short by 26 cr") and `states` ("Short by 3 cr", balance 40 cr). No desktop approval-card version found |
| Unavailable | "Unavailable · no key for Kling 3.0" on the engine line; the step is skipped in the plan with the reason | Nearest: engine refusals such as "… takes no references. Switch the engine first." | **Not found** |
| Offline | The board is read-only, judging queues, top-right "Offline · changes queue"; on the phone, spending reads "Needs a connection" | None | Phone only ("Needs a connection"; approve and reject queue). The desktop message was not found |
| Paused at 80 % | `frame=f2`; phone `record&paused=1` | None | Yes. Desktop reads 161 of 200 cr, phone 160 (see below) |
| Rendering | Live progress on its card, a time estimate, "Notify me when done" (README §0 rule 9) | Tile overlay "Rendering · 35%" with a 2 px bar; pulsing Jobs pill; no estimate or notify | Yes ("about N min left", "Notify me when done") |
| Thinking | "Start · up to 4 cr" with the thinking line; `frame=b` is the loading state | "Drafting, critiquing and refining…" (1.6 s); "Enhancing · 1 cr" pulse; "Getting a fresh quote…" | Yes ("Planning · … · up to 4 cr") |
| Empty | One action and a template, never a paragraph (`frame=a`; Make with an empty prompt is disabled with the reason) | Prose empty states ("Nothing here yet. Takes land on the wall unfiled; …") | Yes for `frame=a` and Home |
| Waiting for approval | The plan card with Approve · Change · Hold (`frame=e`) | Held jobs with the price as the approve button; Generate "freezes" the quoted price | Yes |
| Held | "held" = approved but not settled (README §5) | "held" = waiting at a gate; "frozen" = approved | **Mixed.** The master's jobs use `status: 'held'` for items waiting at a gate (approve queue, admin items), while Activity's "Held" stat reads "approved, not yet settled" |
| Interrupted submission | — | **Recover edit / Recover upscale** (no second charge) | Still in the master's legacy Make tools |

**Phone states** (`screen=states`): rendering (42 %, "about 2 min left", Notify me, Stop); failed (Nothing billed, Retry · 7 cr); insufficient credits (Top up · 500 cr · $50, header at 40 cr); offline (reviews queue; Change with words reads "Needs a connection").

## 7. Actions

From README §4. Basis: **card** = a rate-card row in `CLAUDE.md § Pricing`; **estimate** = "up to N cr", quoted before the run; **free**. Who: **anyone** on the workspace · **person** (never Atomik, never an MCP agent) · **admin**.

| Control | Price basis | Who |
|---|---|---|
| Start · up to 4 cr | estimate (thinking) | anyone |
| Show me looks · 12 cr | card: Nano Banana Pro 3 × 4 | anyone (a person approves) |
| Draw the storyboard · 9 cr | card: Nano Banana Pro 3 × 3 | person |
| Make 3 shots · 93 cr (plan Approve) | card: Seedance 2.5 43 + 43 + Kling Std 7 | person; a step over 40 cr needs an admin |
| Approve · 66 cr (/hero-takes plan) | card: keyframes 9 + hero 43 + drafts 14 | person; the 43 cr hero take needs an admin |
| Change / Hold (plan) | free | anyone |
| Approve / Reject (take) | free | person |
| Change with words · 43 cr | card: the take's engine; counts against 2 per shot | person |
| Use as reference · Versions · Download | free | anyone |
| Build identity · 54 cr | card: identity training | person; needs a consent record first |
| Lock as master · free / Render a still · 3 cr | free / card NB Pro | anyone / person |
| Open Edit & Sound · Render master · free · Export PNG · free | free | anyone |
| Make · 43 cr / 3 cr / up to 1 cr | card Seedance 2.5 · NB Pro / estimate ElevenLabs | person |
| Motion transfer · Object swap | estimate (no card row) | person |
| Ads: Read the site · up to 3 · image ads 54 · Adapt 54 · New background 3 | estimate · card × 18 · card × 18 · card | person |
| Social: Find clips · up to 4 · Review all three · up to 4 · Apply effect 43 · Make narrated · up to 134 | estimate · estimate · card · card 129 + estimate 5 | person |
| Approve post | free | **person only** |
| Ask the crew | estimate (a run) | a person approves the run |
| Confirm · approve N items (⌘K, Approvals) | the sum of their bases | **person only**; items over 40 cr are left out |
| Ask / Auto | — | **person only** (admin) |
| Top up · 500 cr · $50 | $ | **person only** |
| Spending rules (40 cr, budget, 200 cr) | — | **admin only** |
| Record consent | free | **person only** |
| Stop · Continue (80 %) | free / holds the next step | person |
| Retry (failed) | same as the step; "Nothing billed" if nothing was charged | person |
| Run again with new words (Skills) | priced once at the saved plan's basis | person |
| MCP tokens (Connections) | — | a person creates and revokes; agents prepare, never approve |

**Changed from the previous handoff**

- Prices read "N cr", "up to N cr" or "free". The previous `quoted` label covered ElevenLabs, Seedance Edit, Topaz image upscale, Flux · Identity, Genjutsu and Atomik plans and runs. Each of these now shows an "up to N cr" ceiling in the master, though none has a card row: Seedance Edit and "Select & edit a region" at up to 43 cr, Flux · Identity at up to 3 cr, Topaz image upscale at up to 23 cr (the video upscale row's figure), and ElevenLabs music and effects at up to 1 cr. README §4 and §8 list only the ElevenLabs and thinking estimates.
- There is a **Who** column. Approve post, Record consent, Ask/Auto, Confirm and Top up are person-only; Spending rules are admin-only. The previous handoff had no roles on actions.
- Atomik "prepares" every action, through the same approval and at the same price (PROMPT.md "Every feature is agentic"). MCP agents prepare and never approve.
- The **fix allowance** (2 per shot), **thinking cost** (up to 4 cr, billed per plan), **Top up** beside Approve, the **80 % Continue/Stop** and **Retry with "Nothing billed"** are new.
- Gone: the review gate (`Review edit cost` / `Review upscale cost` before the run button enabled), **Generate** (now **Make**), **Enhance · 1 cr** and **Auto · enhance first** as visible controls (not found in the Make panel frames; not confirmed), **File to shot**, **Again** and **Release**.

## 8. Money rules

From README §5, with what is new.

**Prices.** The handoff's sample prices are at US$0.10 a credit, the price `CLAUDE.md` § Pricing and the code use, and they stand (owner, 5 October 2026): Seedance 2.5 1080p 5 s 43 cr, Kling 3.0 Standard 5 s 7 cr, Nano Banana Pro 3 cr, Nano Banana 2 1 cr, identity training 54 cr, the 66 cr and 93 cr plans with fix allowances of 114 cr and 186 cr, the 200 cr line, Top up 500 cr · $50, hover 1 cr = $0.10.

| Rule | New handoff | Previous handoff |
|---|---|---|
| Per-shot admin rule | Over **40 cr** on a shot needs an admin; marked on the step; left out of one-tap batch approvals | **New.** Not in `CLAUDE.md § Pricing`; README §5 attributes it to "this round" |
| Platform line | Any job over **200 cr** needs a person, even under Auto | Present as the Workspace "threshold 200"; matches `CLAUDE.md` Guardrail 4 |
| Production budget | 200 cr sample, **pause at 80 %** (160 cr): Continue or Stop | **New** |
| Ask / Auto | Ask = every step waits; Auto = steps under the limit (10 cr sample) run and are marked "spent without asking". Set by a person in Settings › Spending rules; the default is Ask (open decision 3) | **New** |
| Fix allowance | Up to 2 fixes per shot, shown as "at most N cr" = 2 × the sum of the shots' engine prices | **New** |
| Thinking | Billed when Atomik plans (4 cr on the sample plan); shown as "up to 4 cr" before a request; how-to answers are free | Previously **quoted**; the script draft at 4 cr and the redraft at 3 cr were "sample quotes" |
| Display | "N cr", "up to N cr" or "free"; never a bare "quoted"; hovering shows dollars (1 cr = $0.10) | "N cr", `quoted` or `free`; no dollars |
| Held / settled | "held" = approved, not settled; "settled" once the provider confirms | "frozen" at submission; "settled" on completion; "held" = at a gate |
| Who approves | Only a person approves spending; Atomik and MCP agents prepare and explain | "Nothing is spent without a gate"; Atomik runs stop at an approval gate |
| Gate mechanics | One approval per plan, listing every paid step, the fix allowance, the total and the balance after | Every paid action shows its price on its button; tools needed `Review … cost`; Generate froze the price |

## 9. Keyboard map

| Key | Previous | New (README §6) | In the new master? |
|---|---|---|---|
| ⌘K | Palette (pages, models, assets, "Ask Atomik") | Search + Atomik | Yes |
| ⌘J | Inspector | Inspector | Yes |
| Make | — | **⌥M** ("doesn't clash with the browser") | **No.** The master binds **⌘/**, its Make close button reads "Close · ⌘/", and `Make frames.dc.html` says "⌘/" |
| Esc | Closes palette, menus, trays, wiring, lasso | Closes | Yes (also Make, review, selection) |
| Review J/K | — | Previous/next | Yes, but it switches versions v1/v2 |
| Review A, R, space, C | — | Approve, reject, play, compare | Yes |
| Board V, F, N, T, I, ⇧V, ⇧A, U | — | Select, frame, note, text, image, video, audio, upload | Not wired. The tool pill exists with these eight tools but has no key handler |
| 0, L | — | Fit, List view | Not wired |
| ⌘Z, ⌫ | Undo, delete (outside fields) | Undo, delete | Yes |
| ⌘C / ⌘X / ⌘V / ⌘D | Copy, cut, paste, duplicate | Same | Yes |
| ⌘R | Retry | — (not listed) | Still bound |
| Rig wiring | Click output → input; ⇧ adds to lasso | — | Legacy Rig view only |

## 10. Placeholders

The names below are sample data. CLAUDE.md ground rule 3 says they must never be copied into code, seed data or copy.

From README §8:

- **Workspace:** ZigZag Films.
- **People:** Akshay Panchal, Mara Sethi, Iver Lund.
- **Projects:** Dune Studies, Northline, Night market · sample.
- **Ads project and brand:** Maison Aurel · Silk scarf.
- **Social project:** Dune walk · clips.
- **Cast:** Mira.
- **Accounts and addresses:** @maisonaurel, maisonaurel.com, particl.si.
- **Media:** `assets/hero.webp`, `environment.webp` and `character.webp`, which stand in for every take, plate, cast image, ad and clip.
- **Prices:** every figure is a sample from `CLAUDE.md § Pricing`. Plan totals (66, 93, 114, 160) are sums of rate-card rows.

Sample email addresses in the master (Settings › Team): the export had three real-looking addresses; this repo is public, so they were changed to `akshay@example.com`, `mara@example.com` and `iver@example.com` before the handoff was committed.

Also in the master but not in README §8: the voice "Avery"; the MCP token prefix `pk_zigzag_`; the prop "Chrome sphere"; the sample memory line "consent on file until 30 Sep 2027". README §5 also puts a person's name inside a money rule ("… may approve up to 40 cr a shot"). The rule must ship without the name.

## 11. Open decisions

From README §9, with the owner's answers of 5 October 2026 where given:

1. Cinema Studio price display: **decided** — "about N cr, at most 3N cr" in Make.
2. Final product names (Board, 3D blocking, Make, Ads and Social are the design's proposals). Open.
3. The default for spend without asking: **decided** — Ask (see a).
4. Sample production content (the desert film is a stand-in). Open.
5. Atomik's thinking: **decided** — "Start · up to N cr" may be pressed by any member (a person); the price on the button is the approval. Agents and MCP never press it (see e).

### The owner's answers, 5 October 2026

| # | Question | Answer |
|---|---|---|
| 1 | Auto per-job line | Stays `RIG_AGENT_JOB_CEILING_CREDITS` for now; a workspace setting comes in U1 only if asked for. |
| 2 | "Start · up to N cr" | Any member (a person) may press it; the price on the button is the approval. Agents and MCP never. |
| 3 | Fix allowance | 2 × the plan's shot prices. 114 on board frame e is a design error. Build the formula, with the handoff's $0.10 figures: 186 cr for the 93 cr plan, 114 cr for the 66 cr plan. |
| 4 | 80 % budget pause with Continue / Stop | Build it in U1. Money: waits for the owner's review before merge. |
| 5 | Board dot grid | SVG pattern, as the repo draws it, same look. |
| 6 | Make shortcut | ⌥M. |
| 7 | Phone sheets | Keep the slide-up. |
| 8 | Object swap | One element replaced per run, as drawn; reference images for that element are fine if the engine takes them. |
| 9 | Jobs tray | Dots, as built. |
| 10 | Toast dot | Green only for success with Undo / Open, as built. |
| 11 | Settings menu interim targets until D1 | OK: Spending rules → Atomik › Budget, Connections → Tools & connections, Advanced → Engines. |
| 12 | "STUDIO" under the wordmark | Leave the logo as drawn; logos are exempt from the text floor. |
| 13 | Credit price | **1 credit = US$0.10** (final; it replaces the $0.80 and $0.05 answers given earlier the same morning). `CLAUDE.md` § Pricing, the code default and this handoff are already at $0.10 and stay; only particl.si (`CREDIT_USD` 0.80) comes back, by the PR "pricing: back to US$0.10 on particl.si" and `docs/credit-switchover.md`. |
| 14 | Cinema Studio 4.0 in Make | "about N cr, at most 3N cr". |
| 15 | Missing frames | A Claude Design round 2 before U1 (`docs/design-round-2.md`). |
| 16 | `account=` on old Viral links | Keep it on the final URL. |

## Where the repo wins

The code and `CLAUDE.md` override the handoff where they disagree. These are the owner's corrections of 4 October 2026, checked against the code. Point d (packs) was dropped on 5 October: "Starter" is in `CLAUDE.md` § Packs. Each one that needs a decision is marked **Owner decision**, and work that depends on it waits for the answer.

**a. Spend without asking.** `lib/workbench/rig-agent-limits.ts` is the rule, not the design's sample. Ask is the default (`RigAgentCard.tsx:55`; the run's `mode` defaults to `'ask'` in `rig-agent-store.ts:39`), so README §9 decision 3 is already decided. In Auto, a render runs without a tap only when it is a draft priced at or under the per-job line (`rig-agent-runs.ts:354-361`, "at or under", not "under"); a full-quality render always asks, and nothing passes the run's approved limit. The per-job line is `RIG_AGENT_JOB_CEILING_CREDITS`, a code constant that is `null` today, so it falls back to guardrail 4 (`JOB_APPROVAL_LINE_USD`, US$20 in `lib/approvalRule.ts`). The design's "steps under 10 cr" is a sample. Today Ask or Auto is chosen per run on the Rig card by whoever starts it; making it a Settings › Spending rules switch that only an admin changes (rule 14) is new work.
**Decided 5 October:** it stays `RIG_AGENT_JOB_CEILING_CREDITS` for now; a workspace setting comes in U1 only if the owner asks for it.

**b. The 40 cr per-shot rule.** This is the existing `cap` option of the cost approval rule in `lib/approvalRule.ts`, and 40 is a sample value. It is a workspace setting, not a constant: `approvalRule` and `shotCapCredits` in the settings table (`lib/settings.ts:24-26`; the default rule is `anyone` and the default cap 50 cr). Only an admin changes it (`PATCH /api/settings`, `requireAdmin`). It counts what the shot has already spent plus the new take (`lib/shotCap.ts`). A member who would pass it is refused, and an admin presses it instead. Limits are by role, not by person, so README §5's named approver reads "members up to the cap, an admin above it".

**c. Topaz upscale.** The video upscale is named "Topaz upscale", as in the `CLAUDE.md` § Pricing rows ("Topaz upscale, 5s 1080p" 23 cr; "5s 4K" 38 cr). "Astra" is a retired name in the UI, both for 3D (now "3D blocking") and for the upscale. The code still labels the model "Topaz Astra 2" (`lib/models.ts`, short "ASTRA") and says "Astra" in `NextActionPanel.tsx`, so the build renames those labels. This overrides the 4 October SOW §8 line that keeps "Topaz Astra" as Topaz's model name.

**e. "Show me looks · 12 cr" is taken by a person.** README §4's Who column says "anyone (person approves)"; it reads "person". Approving spend belongs to people alone, and Atomik or an MCP caller can only prepare it (`CLAUDE.md` rules 11 and 14).
**Decided 5 October:** "Start · up to N cr" (Atomik's thinking) may be pressed by any member, as a person; the price on the button is the approval. Atomik and MCP callers never press it.

**f. Phone record.** On `?device=phone&screen=record&paused=1`, the reference's "Make 3 shots" row overlaps. Its right-hand figure, "50 cr settled · Shot 3 waiting · 43 cr not yet spent", is `white-space:nowrap` in a flex row that does not wrap (master line 95), so it is about 437 px wide in a 358 px column and crushes the title. Build it wrapped: the settled figure stays on the right, and the waiting part moves to its own line under the title. No text in a row may be nowrap and wider than its column at 360 px.

**g. Header option B.** `Home and header options.dc.html` is history: the step 2 comparison of header A (destinations) and B (templates). Option B is the decision (README §1, PROMPT.md step 2). Build only B. The master's `&header=a` is a leftover, not a spec, and the 4 October SOW §10 decision 1 is closed.

### Other places the handoff conflicts with the code

Found while checking a–g. Answered by the owner on 5 October where marked.

1. **Fix allowance arithmetic.** README §5 and `CHANGES.txt` give "at most 114 cr" as 2 × (43 + 7 + 7), but the plan on the same card is 43 + 43 + 7 = 93, which gives 186 by the README's own formula. The Studio board frames file says 186. **Decided:** the formula is 2 × the plan's shot prices; 114 on frame e is a design error. The handoff's $0.10 figures stand: 186 cr for the 93 cr plan, 114 cr for the 66 cr plan.
2. **The 80 % pause.** Desktop frame f2 reads 161 of 200 cr; README §5 and the phone say 160. In code, the 80 % mark is a one-time notice to admins (`lib/caps.ts`, `capWarnPct`), and the stop comes at the cap (`atCap`). A pause with Continue and Stop is new behaviour on caps, which ground rule 4 lists as "don't redesign". **Decided:** build the pause in U1; money, so the owner reviews before merge.
3. **The 200 cr line.** README §5 treats the Auto limit (10 cr sample) and the platform line (200 cr) as two numbers; in code they are the same constant (see a). README §4 lists "200 cr" under Spending rules as an admin setting; it is a platform constant, not a workspace setting.
4. **Top up.** README §4 implies a purchase by any person. In code a top-up is a request restricted to the owner or an admin, which the platform approves (`lib/topups.ts`).
5. **Per-second figures.** README §8's "8.6 cr/s" and "1.4 cr/s" are the 5 s card rows divided by five, not rates. Kling 3.0 Standard costs $0.084/s and is rounded per job (10 s is 13 cr, not 14); Seedance is priced by tokens.
6. **Upscale prices.** The master's "Video upscale · Topaz · 23 cr at 5 s 1080p" cannot be quoted today: the model offers only 4K (`lib/models.ts`, `resolutions: ["4k"]`), so 5 s quotes 38 cr. The image upscale costs 2 or 3 cr and has no card row, but the master shows it "up to 23 cr".
7. **Gradients.** README §2 allows gradients only on project swatches and avatars, but defines the board dot grid as a `radial-gradient`, and the master also uses them on media placeholders, the "All" filter dot, the sphere highlight and the audio stripes. The repo draws dot grids as an SVG image instead. **Decided:** the dot grid stays an SVG pattern, same look.
8. **Below the readability floor.** The phone tab-bar count badge is 11 px; unsettled values on the phone record are at .35; "Failed" badges use danger red as text, which the repo replaces with `--gx-failed-text` (#FF6961) because #FF453A fails the label floor.
9. **Make shortcut.** README §6 says ⌥M; the master and the Make frames bind ⌘/. **Decided:** ⌥M.
10. **Names in copy.** README §5 names a person in a money rule, and the master uses a voice name and a token prefix that README §8 does not list as placeholders. None may reach code, seed data or copy (ground rule 3).
