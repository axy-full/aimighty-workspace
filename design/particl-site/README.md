# Handoff: particl studio — marketing site (desktop + mobile)

## Overview
A public website for **particl studio**, the generative-video production platform in `axy-full/aimighty-workspace`. It presents the five suites (Gen · Studio · Business · Viral · Atomik) plus Workspace and Pricing in the platform's own Graphite theme — near-black surfaces, `#0A84FF` blue accent — with a Higgsfield-style prompt-bar hero, engine chips and plan cards. All copy is drawn from the repo (`README.md`, `CLAUDE.md` §7A, `lib/workspace/spec-cards.ts`, `lib/workspace/pages.ts`, `lib/suites.ts`, `docs/*`); provider names do not appear in suite copy, per `docs/four-suites-v2-plan.md`. Engine names (Seedance, Kling, Nano Banana, Topaz Astra) do.

## About the design files
The `.dc.html` files in this bundle are **design references built in HTML** — click-through prototypes that show the intended look, copy and behaviour. They are not production code. The task is to **recreate them inside the Next.js app-router codebase** using its existing tokens (`app/graphite.css`, `app/flair.css`), fonts (`app/fonts.css`), brand mark (`components/ParticlMark.tsx`) and request-access flow (`components/RequestAccess.tsx`), as a marketing route group (suggested: `app/(marketing)/`).

Open `Home.dc.html` or `Pricing.dc.html` in a browser; `support.js` must sit beside them. Reading the source: everything is inline-styled markup between `<x-dc>…</x-dc>`. `{{ name }}` are runtime values, `<sc-if value="{{ flag }}">` is a conditional block, `<sc-for list="{{ items }}" as="t">` a loop; `style-hover`/`style-focus` are hover/focus styles. The small logic class at the bottom of each file (`class Component extends DCLogic`) holds state and handlers.

## Fidelity
**High-fidelity** for layout, colour, type, spacing, copy and interaction structure at every breakpoint. **Data is sample data**: project *Dune Studies*, 2,000 credits, one simulated render. Prices are the repo's reference rate card (`CLAUDE.md` §7A); anything marked "live quote" has no fixed figure. Three items are shown with an amber "not yet runnable" badge because the repo marks them so (Builds, the Skills registry, Analyse video); SSO/SCIM/passkeys are stated as open work.

---

## Information architecture and routing
`Home.dc.html` is one page with a suite switcher; `Pricing.dc.html` is a second page.

| Prototype | Suggested route | Default |
|---|---|---|
| `Home.dc.html#gen` | `/` | yes — Gen opens by default |
| `Home.dc.html#studio` | `/studio` | |
| `Home.dc.html#business` | `/business` | |
| `Home.dc.html#viral` | `/viral` | |
| `Home.dc.html#atomik` | `/atomik` | |
| `Home.dc.html#workspace` | `/workspace` | |
| `Pricing.dc.html` | `/pricing` | |
| `#access` | `/#access` (anchor) | request-access form |

In the prototype the tab is state synced to `location.hash` (`history.replaceState`, `hashchange` listener, scroll to top on switch). In Next.js make each suite a route; the shared header, suites strip, shell, pricing teaser, access and footer are a layout.

Page order on Home, per suite:
- **Gen**: Hero (prompt bar) → Gen · composer → Gen · engines → *shared bottom*
- **Studio / Business / Viral / Atomik / Workspace**: Suite header → suite sections → *shared bottom*
- **Shared bottom**: Suites strip → Shell → Pricing teaser → Request access → Footer

---

## Global elements

### Header (sticky)
- `position:sticky; top:0; z-index:50`, `border-bottom:1px solid rgba(255,255,255,.09)`, `background:rgba(0,0,0,.72)`, `backdrop-filter:blur(14px)`.
- Inner: `max-width:1200px; margin:0 auto; padding:0 clamp(16px,4vw,40px); min-height:60px; display:flex; align-items:center; gap:12px; flex-wrap:nowrap`.
- **Brand** (link to `/`): 7-dot trail mark (inline SVG, `viewBox="34 72 132 56"`, 34×14 px, `fill:currentColor`; circles: (38.7,120.8,r1.8) (50.9,100.5,r2.8) (69.8,86.3,r4) (92.7,80.1,r5.5) (116.2,83,r7.2) (136.9,94.5,r9.2) (151.7,112.9,r12)) + wordmark **partıcl** (Outfit 600 21px, letter-spacing −.03em; the ı is dotless with a ring: `.17em` circle, `.04em` border, positioned `top:.09em`) + **STUDIO** (Kode Mono 10px, letter-spacing .36em, uppercase, `rgba(235,235,245,.6)`).
- **Nav tabs** (Gen · Studio · Business · Viral · Atomik · Workspace | Pricing): `padding:7px 10px; border-radius:6px; font-size:13.5px; color:rgba(235,235,245,.72); white-space:nowrap`. Hover `color:#F5F5F7; background:#1B1B1F`. Active: `background:rgba(10,132,255,.14); color:#6EB4FF; font-weight:600`. Divider before Pricing: `1×18px rgba(255,255,255,.12)`. Nav is `flex:1 1 auto; min-width:0; overflow-x:auto` (scrollbar hidden).
- **Sign in** (secondary, 36px): `padding:0 14px; border-radius:8px; font:500 13.5px; color:#F5F5F7; background:#1B1B1F; border:1px solid rgba(255,255,255,.08)`; hover `#26262B`.
- **Request access** (primary, 36px): `padding:0 16px; border-radius:8px; font:600 13.5px; color:#fff; background:linear-gradient(160deg,#4C9DFF,#0A84FF 55%,#0064D6); box-shadow:0 6px 18px rgba(10,132,255,.32), inset 0 1px 0 rgba(255,255,255,.28)`; hover `filter:brightness(1.08)`.

### Responsive behaviour (three widths)
| Width | Header | Content |
|---|---|---|
| > 1040px | One row: brand · tabs · Sign in · Request access | Grids at full column count; Studio's right column is `position:sticky; top:84px` |
| 720–1040px | Two rows: brand + buttons (buttons right-aligned, brand `flex:1`); tabs on their own full-width row below (`order:3`, `padding:2px 0 8px`) | `auto-fit` grids collapse to 1–2 columns |
| ≤ 720px | As above, **Sign in hidden**, tab hit area `padding:11px 10px`, primary/secondary CTAs 44px tall | Hero padding-top 104px, no min-height; sticky column becomes static; take-card prompt line wraps; the "1 take · enhanced first · 1 cr" meta is hidden |
All grids use `repeat(auto-fit, minmax(min(100%, Npx), 1fr))`, so nothing has a fixed width; hit targets ≥ 44px on phones; textarea/inputs are 16px so iOS does not zoom. The repo tests 360×640, 390×844, 844×390, 1440×900, 1920×1080 — the same set applies here.

### Section rhythm
- Container: `max-width:1200px; margin:0 auto; padding:clamp(64px,9vw,110px) clamp(16px,4vw,40px)`.
- Backgrounds alternate `#000` and `#0D0D10`; sections separate with `border-top:1px solid rgba(255,255,255,.09)`.
- Section head: eyebrow (Kode Mono 11px, .16em, uppercase, `#6EB4FF`, 500) · H2 (Outfit 600, `clamp(30px,4vw,46px)`, −.03em, line-height 1.05) · lead (16px/1.55, `rgba(235,235,245,.62)`, max-width 58ch, `text-wrap:pretty`).

### Reusable components
- **Card** (tiles, groups, plan cards): `background:linear-gradient(180deg,#1B1B20,#141417); border:1px solid rgba(255,255,255,.10); border-radius:10px; box-shadow:inset 0 1px 0 rgba(255,255,255,.05), 0 8px 20px rgba(0,0,0,.3); padding:18px; gap:10px`. Hover on card-links: `border-color:rgba(10,132,255,.45)`.
- **Tile**: tag (Kode Mono 10.5px, .14em, `#6EB4FF`) · name (Outfit 600 20px, −.02em, lh 1.15) · body (13.5px/1.5, `rgba(235,235,245,.72)`) · optional price row (`border-top:1px solid rgba(255,255,255,.08); padding-top:12px`; price Kode Mono 600 16–18px; note 12px 60%).
- **Group card** (Business, Workspace): header `padding:14px 18px 12px` with tag + right-aligned 12px note; rows `grid: minmax(0,1fr) auto; gap:4px 12px; padding:12px 18px; border-top:1px solid rgba(255,255,255,.07)`; row = name (14px 600) · mono chip · description (13px/1.5, 62%) spanning both columns.
- **Note**: `background:#17171B; border:1px solid rgba(255,255,255,.10); border-radius:8px; padding:14px 16px; font-size:13.5px; line-height:1.5; color:rgba(235,235,245,.72)`; lead-in words in `#F5F5F7` 600.
- **Fact**: Note styling; eyebrow (Kode Mono 10.5px .12em `#6EB4FF`) over value (14px 600 `#F5F5F7`).
- **Mono chip**: `height:24px; padding:0 8px; border-radius:6px; border:1px solid rgba(255,255,255,.08); font:10.5px Kode Mono; letter-spacing:.04em; color:rgba(235,235,245,.72); white-space:nowrap`. Tinted variant: `border:rgba(10,132,255,.35); background:rgba(10,132,255,.14); color:#6EB4FF`.
- **Amber badge** (gated features): `height:20px; padding:0 7px; border-radius:4px; background:rgba(255,159,10,.14); border:1px solid rgba(255,159,10,.35); color:#FFB340; font:10px Kode Mono .08em`.
- **Product window**: `border-radius:12px; border:1px solid rgba(255,255,255,.12); background:#0D0D10; box-shadow:0 40px 100px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06)`; title bar 38px `#111114` with three 10px `#3A3A40` dots and a Kode Mono 11px path (`studio.particl.app / …`); screenshot image below, `width:100%`.
- **Status dots** (7px): done `#30D158`; running `#0A84FF` with `box-shadow:0 0 8px #0A84FF`; idle `1.5px solid rgba(235,235,245,.35)`.
- **Segmented control** (Pricing toggle): track `padding:3px; border-radius:8px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.10); box-shadow:inset 0 1px 2px rgba(0,0,0,.6)`; option 32px, 13px 500; selected thumb `linear-gradient(180deg,#45454C,#2E2E34); box-shadow:0 2px 8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.12); border-radius:6px`.
- **Primary button (page)**: 40px, `padding:0 18px; border-radius:8px; font:600 14px` + primary gradient above. **Secondary**: 40px, `#1B1B1F`, border .08. In composers the primary is 40px with `border-radius:10px`.

---

## Screens

### 1. Gen (Home default) — `data-screen-label="Hero · still"`, `Gen · composer`, `Gen · engines`
**Hero (still variant, default).** Full-bleed `public/campaign/hero.webp` (`object-fit:cover; object-position:center 30%`), `min-height:min(92vh,900px)`, overlay `linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,.08) 30%, rgba(0,0,0,.42) 62%, #000 100%)`. Content bottom-left, `padding:clamp(120px,18vh,180px) … 48px`, `gap:22px`:
- Eyebrow: **Gen · Video · Images · Audio · 3D**
- H1 (Outfit 600, `clamp(40px,6.4vw,84px)`, −.035em, lh .98, max-width 14ch): **The studio's own room for making shots.**
- Lead (`clamp(16px,1.4vw,19px)`, `rgba(235,235,245,.78)`, 58ch): *Five suites in one shell: Gen, the Production Studio, the Business Suite, the Viral Studio and the Atomik agent. Seedance, Kling and Nano Banana behind them, with the cost on every button.*
- **Prompt bar** (`max-width:920px; background:rgba(13,13,16,.86); border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:12px; box-shadow:0 30px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06); backdrop-filter:blur(18px)`): textarea (16px/1.5, min-height 64, transparent, placeholder `rgba(235,235,245,.38)`: *Describe the shot. Cite references as @Image1; start with raw: to skip the enhancer.*); footer row (`border-top:1px solid rgba(255,255,255,.07); padding-top:10px; gap:8px; flex-wrap`): model chip (32px, `#1B1B1F`, border .08, 13px 600, inner tag **SD 2.5** on blue tint) **Seedance 2.5** · chips **16:9 · 5 s · 1080p** (32px, border .08, 12.5px, 72%) · tinted chip **Audio on** · spacer · meta **1 take · enhanced first · 1 cr** (Kode Mono 11px 60%) · **Generate · 43 cr** (40px, radius 10).
- **States**: Enter or click → running pill for 2.2 s (36px, radius 999, blue tint bg/border, `#6EB4FF` 13px, `box-shadow:0 0 16px rgba(10,132,255,.25)`, 7px dot pulsing 1.4s): *Rendering on Seedance 2.5 · 43 cr quoted* → **take card** (rise animation .4s `cubic-bezier(.2,.7,.2,1)`; card gradient, radius 12, `padding:10px; gap:14px; max-width:680px`): 128px 16:9 thumb (`environment.webp`) with **NEW** badge (`#0A84FF`, white, Kode Mono 10px, radius 4) · eyebrow **TAKE 01 · SEEDANCE 2.5 · 16:9 · 5 S · 1080P** (Kode Mono 10.5px .12em `#6EB4FF`) · prompt (14px 600, ellipsis on desktop, wraps on phones) · *Saved to Takes · 43 cr settled · 1,957 cr left* (12.5px 62%) · **Another take** (32px secondary) resets. Credits start at 2,000 and drop 43 per render; the take number increments.
- Two alternative heroes exist behind the `hero` tweak: **mosaic** (centred copy, prompt bar 840px, five offset columns of 3:4 / 16:9 / 1:1 tiles `clamp(150px,17vw,240px)` wide with `CAST · IDENTITY`, `VIDEO · 5 S`, `TAKE 03 · NEW` labels, 240px bottom fade) and **window** (two-column: copy + prompt bar left, Rig screenshot in a browser window right with a blurred blue glow). `Hero Options.dc.html` shows all three side by side. Still is the recommended default.

**Gen · composer** (`#000`): head **Gen · one composer / The cost is on the button.** · two-column grid (`minmax(min(100%,420px),1fr)`, gap `clamp(24px,4vw,48px)`): Gen window (`gen-composer-blank.jpg`) left; four stat tiles right (`minmax(220px,1fr)`), each with a Kode Mono 22px `#6EB4FF` figure: **4–30 s** Length by the second · **SHA-256** References stay byte-identical · **1 cr** Prompt enhancer · **0 cr** Failed renders. Below: enhancer window (`gen-composer-prompt-enhancer.jpg`) beside nine tiles (`minmax(200px,1fr)`): 01 DIRECTION, 02 MODEL, 03 REFERENCES, 04 SETTINGS, 05 RESULTS, EDIT (edit a finished clip), FINISH (Astra 2 / Topaz upscale), RECOVER, MODES. Copy verbatim in the file.

**Gen · engines** (`border-top`): head **Engines / Pick the engine per shot.** · 8 engine cards (`minmax(250px,1fr)`, gap 12): tag chip + kind (`VIDEO`/`IMAGE`/`AUDIO`/`POST` in `#6EB4FF`), name Outfit 20px, role line 12.5px 60% ("Video engine", "Still engine", "Audio engine", "Finishing"), body, price row — Seedance 2.5 **18 cr** 5 s · 720p; Seedance 2.0 **29 cr**; Kling 3.0 Pro **13 cr**; Nano Banana Pro **3 cr**; Nano Banana 2 **1 cr**; GPT Image 2.5 **Live quote**; Eleven v3 **Per character**; Topaz Astra 2 **23 cr**.

### 2. Studio — `Studio · header`, `Studio · stages`
**Suite header** (used by every non-Gen suite): `background:radial-gradient(70% 60% at 50% 0%, rgba(10,132,255,.16), transparent 60%); border-bottom hairline; padding:clamp(56px,8vw,96px) … clamp(40px,5vw,56px); gap:22px`. Eyebrow **02 · Particl Production Studio** · H1 (Outfit 600 `clamp(36px,5.2vw,64px)`, −.035em, lh 1, max 20ch) **Eight stages from brief to delivery.** · lead 17px/1.55 66% 62ch · page chips (Kode Mono 11px, 28px tall, number in `#6EB4FF`): 01 Brief & Script · 02 Boards · 03 Cast & Elements · 04 Astra 3D · 05 Rig · 06 Takes · 07 Edit & Sound · 08 Deliver · CTA row: **Request access** (primary 40px) + **Open Gen** (secondary).

**Stages** (`#0D0D10`, two columns `minmax(min(100%,420px),1fr)`, gap `clamp(32px,5vw,72px)`):
- Left: eyebrow **Stages** · H2 **One project. One ledger.** · lead · eight rows (`grid: 40px minmax(0,1fr); padding:16px 0; border-top hairline .08`): Kode Mono 12px number in blue · title 16px 600 · description 13.5px 62% · mono chips. Stage 03 adds two sub-cards (Note style) **CAST** and **ELEMENTS · ENVIRONMENT** with their own chips (Identity/Wardrobe/Casting; Environment/Object/Prop/Material/Look).
- Right (sticky on desktop): Rig window (`studio-rig-canvas.jpg`, path `studio.particl.app / dune-studies / rig`) · two asset cards (`minmax(220px,1fr)`; 4:3 image; badges `ENVIRONMENT · V2` + green `SELECTED`, `CAST · V1` + blue `IDENTITY READY`; name 14px 600; meta 12.5px; 26px action chips **+ To Rig / Block in Astra**, **Render with identity / New wardrobe version**) · three notes **PORTS / DROP / VERSIONS** (`minmax(150px,1fr)`).
Stage copy (verbatim in file) is the repo's: Brief & Script, Boards, Cast & Elements, Astra 3D (Astra blender renders to PNG/.blend/GLB), Rig, Takes (bins up to 50), Edit & Sound (64 clips, .cube LUT, 50 edit versions, WAV 48 kHz, change voice, dub), Deliver (MP4/WebM ≤3 min · 200 MB, 24/25/30 fps, CMX3600 EDL).

### 3. Business — `Business · header`, `Business · Marketing Studio`
Header: **03 · Moleculr Business Suite / Build and grow your brand from one marketing studio.** Pages: Product · Brand · Cast · Format · Variants · Design · Publish.
Section (`#0D0D10`, column gap 28): facts row (`minmax(180px,1fr)`: PRODUCT IMAGES Up to 5 originals · CAST IMAGES Up to 6, or an identity · FORMATS 9 · HOOKS 12 per campaign · VARIANTS Up to 100 bindings) · two windows (`business-ads-marketing-studio.jpg`, `business-dtc-image-ads.jpg`) · four group cards (`minmax(270px,1fr)`, `align-items:start`): **PRODUCT** (details, images 5 max, URL as saved reference, cut-out) · **BRAND & CAST** (brand import from URL, presenters 6 max, custom presenter) · **MESSAGE & FORMAT** (hooks 12, formats 9, presets, templates from the connected catalogue, aspect & quality 1k–4k) · **VARIANTS & OUTPUT** (variants 100 max, create with template, reference ad, design, video ads, review & deliver) · note: *Product URLs are saved references, not a claim that a storefront was scraped…*

### 4. Viral — `Viral · header`, `Viral · studio`
Header: **04 · Subatomik Viral Studio / Recast motion and swap elements in footage you own.** Pages: Motion Transfer · Object Swap · Shorts · Sources · Compare · History.
Section: two columns. Left: six tiles (`minmax(200px,1fr)`): 01 MOTION TRANSFER (Live quote · 480p/720p/1080p; directions Style, Wardrobe, Setting, Product, Recast) · 02 OBJECT SWAP · 03 SHORTS (One quote · per set) · 04 SOURCES · 05 COMPARE · 06 HISTORY. Right: two windows (`viral-motion-transfer.jpg`, `viral-history.jpg`) · four facts (`minmax(140px,1fr)`: SOURCE 4–30 s · REFERENCES Up to 30, ordered · RESOLUTION 480p · 720p · 1080p · BILLING Connected credits) · note *Live quote required…*

### 5. Atomik — `Atomik · header`, `Atomik · agent`, `Atomik · pages`, `Atomik · recipes`
Header: **05 · Atomik Super Agent / The production agent. Plans, prices and runs the work.** Pages: Agent · Runs · Generate · Recipes · Builds · Skills · Models · Approvals · Budget.
- **Agent** (`radial-gradient(60% 50% at 80% 30%, rgba(10,132,255,.12), transparent 60%), #0D0D10`; two columns `minmax(400px,1fr)`, `align-items:center`): copy left (eyebrow **01 · Agent**, H2 **Describe the outcome. Approve the plan.**, lead, chips quoted · editable · 4 suites · step · run · /name commands · batches · one approval). Right: user bubble (`align-self:flex-end; max-width:88%; padding:12px 16px; border-radius:12px 12px 4px 12px; background:#1B1B1F`) *Draft the opening of Dune Studies: script from the brief, six boards, four identity renders and one hero take.* → **plan card** (card gradient, radius 12, padding 16): header 8-dot Atomik ring (16px, `viewBox 20 20 160 160`, radii 16→2 clockwise) + **PLAN · 4 STEPS · 62 CR**; four step rows (`grid: 14px 1fr auto; padding:9px 0; border-top .08`): done dot *Draft script from the brief · 3 scenes* 1 cr · running dot *Six board frames · Nano Banana 2* 6 cr · idle *Four identity renders · Cast* 12 cr · idle *Hero take · Seedance 2.5 · 5 s · 1080p* 43 cr; buttons **Approve · 62 cr** (primary 36px) · **Edit steps** (secondary).
- **Pages** (`border-top`): three windows (`atomik-runs.jpg`, `atomik-approvals.jpg`, `atomik-skills.jpg`; `minmax(280px,1fr)`) · ten tiles (`minmax(250px,1fr)`): 01 AGENT, CREW · 7 DEPARTMENTS, 02 RUNS, 03 GENERATE, 04 RECIPES, 05 BUILDS (amber **NOT YET RUNNABLE**), 06 SKILLS (amber **REGISTRY PENDING**), 07 MODELS, 08 APPROVALS, 09 BUDGET.
- **Recipes** (`#0D0D10`): head **04 · Recipes / Saved plans that rerun exactly.** · four recipe cards (`minmax(280px,1fr)`): RECIPE 01 Campaign from one photo · 02 Ad batch from a product · 03 Recast a clip for a new product · 04 Dub the hero film; each: tag + right-aligned mono cost label, name Outfit 21px, body, chain chips above a hairline, footer *Clone · free · exact*.

### 6. Workspace — `Workspace · header`, `Workspace · management`
Header: **06 · Workspace / One workspace. One balance. Every action attributed.** Pages: General · People · Plans & credits · Usage · Engines · Security.
Section (`#0D0D10`): facts (TENANCY One database per workspace · MEMBERS Unlimited on paid plans · INVITES One-time links · 7 days · SIGN-IN TOTP + recovery codes · EXPORT JSON + media manifest) · three windows (`workspace-general-enhancer.jpg`, `workspace-plans-credits.jpg`, `workspace-engines.jpg`; `minmax(300px,1fr)`) · six group cards (`minmax(270px,1fr)`): GENERAL · PEOPLE · PLANS & CREDITS · USAGE · ENGINES · SECURITY (incl. API tokens) · note *Not claimed yet: SSO, SCIM, passkeys…*

### 7. Shared bottom — `Suites`, `Shell`, `Pricing teaser`, `Request access`, footer
- **Suites strip** (`#0D0D10`): head **Five suites · one workspace · one shell / One room. One balance. One composer.** with a right-aligned 15px paragraph; six card-links (`minmax(208px,1fr)`, `min-height:196px`): tag + glowing 6px blue dot, name Outfit 22px, description, Kode Mono footer of page names. Clicking switches suite (→ route).
- **Shell** (`#000`): head **The shell / The same room on every page.** · palette window (`palette-cmd-k.jpg`) beside seven tiles (`minmax(200px,1fr)`: PROJECTS, ⌘K, LIBRARY, ⌘J, RIGHT-CLICK, ENHANCER, ONE BALANCE) · **phone panel**: two columns (`minmax(300px,1fr)`, centred) — copy (eyebrow **On a phone**, H3 Outfit `clamp(24px,2.6vw,32px)` **The same room, one hand.**, lead, chips Home · Workflow · Canvas · Takes · Edit · ≥ 44 px targets) and a phone frame (`width:min(100%,300px); border-radius:34px; padding:10px; background:#0D0D10; border:1px solid rgba(255,255,255,.14); box-shadow:0 40px 100px rgba(0,0,0,.7)`; inner radius 26) holding `ios27-home.jpg`.
- **Pricing teaser** (`#0D0D10`): head **Pricing / Credits, not seats.** + link **Plans, packs and the rate card →** (secondary 38px) · four plan cards (`minmax(230px,1fr)`; price Outfit 600 34px; AGENCY highlighted: `border:1px solid rgba(10,132,255,.45); box-shadow:… 0 0 0 4px rgba(10,132,255,.10)`, tag in blue). INVITE $0 · STUDIO $49/mo · AGENCY $199/mo · PRODUCTION $999/mo.
- **Request access** (`radial-gradient(60% 70% at 50% 100%, rgba(10,132,255,.16), transparent 65%)`; `max-width:760px`, centred): mark 58×24 in `#6EB4FF` · H2 `clamp(32px,4.6vw,54px)` **Invite-only, built for small teams.** · lead · form: email input (44px, `#1B1B1F`, border .10, radius 8, 15px, `box-shadow:inset 0 1px 0 rgba(0,0,0,.35)`, focus `border-color:#0A84FF`, placeholder *you@studio.com*) + **Request access** (primary 44px). Submit → success pill (44px, blue tint, green dot): *Noted. An invite link comes from a person, not a mailer.* Below: *Already invited? Sign in*.
- **Footer** (`#000`): brand + 13px blurb; columns **SUITES** (Studio · Gen · Business · Viral · Atomik), **SITE** (Pricing · Request access · Sign in), **WORKSPACE** (two lines); bottom row `border-top .08`: *© 2026 particl* · Kode Mono **FAILED RENDERS ARE NEVER BILLED · EVERY TAKE HAS AN OWNER**.

### 8. Pricing page — `Pricing.dc.html`
- **Plans** (radial blue glow at top): centred head **Pricing · 1 credit = US$0.10 / Credits, not seats.** · segmented **Monthly | Yearly −20%** (yearly multiplies prices by 0.8: $39.20 / $159.20 / $799.20; note switches *billed monthly* ↔ *billed yearly · 20% off*) · four plan cards (`minmax(240px,1fr)`, radius 12, padding 22): tag, price Outfit 600 40px + `/mo` 15px 500 60%, one-line audience, feature list (13.5px, `border-top`, `flex:1`), CTA (**Request access** secondary; AGENCY primary, badge **MOST TEAMS**; PRODUCTION **Talk to us**). Four note cards below: included credits expire · no seat fees · 60-day lapse · 200 cr approval rule.
- **Packs** (`#0D0D10`): head **Credit packs / Top up when a production runs long.** · four cards: STARTER $50 · 500 cr · $0.100 · TEAM $200 · 2,000 cr + 200 · $0.091 · STUDIO $500 · 5,000 + 750 · $0.087 · AGENCY $2,000 · 20,000 + 4,000 · $0.083 (bonus in `#6EB4FF`).
- **Rate card**: copy left; table card right (header row Kode Mono 10.5px **ACTION / SELLS AT**; 12 rows `grid: minmax(0,1fr) auto; padding:11px 18px; border-bottom .06`; price Kode Mono 14px 600): Standard still 1 cr · Keyframe still 3 · Kling 3.0 Standard 7 / 10 (audio) · Kling 3.0 Pro 13 · Seedance 2.5 720p 18 · Seedance 2.0 29 · Seedance 2.5 1080p 43 · Topaz 1080p 23 · Topaz 4K 38 · Identity training 54 · Prompt enhancement 1; footnote on per-character voice and live quotes.

---

## Interactions and behaviour
- **Suite switching**: nav tabs, suites-strip cards, footer links and `Open Gen` all switch the suite; the page scrolls to top; the URL hash updates (`#studio`). On load the hash selects the suite. In Next.js: routes + `<Link>`; keep the active-tab styling.
- **Hero prompt bar**: Enter (without Shift) or the button submits; empty prompt falls back to the sample prompt; `running` for 2.2 s then `done`; **Another take** resets to idle and clears the textarea. No real generation — the marketing site should keep it a simulation (or link into the app).
- **Request access**: native email validation; submit replaces the form with the success pill. Wire to the repo's existing request-access endpoint (`components/RequestAccess.tsx`).
- **Pricing toggle**: monthly/yearly state; prices ×0.8 when yearly.
- **Hover**: tabs (`#1B1B1F`), secondary buttons (`#26262B`), primary buttons (`brightness(1.08)`), card-links (blue border).
- **Motion**: `@keyframes pulse` (opacity .45→1→.45, 1.4s ease-in-out infinite) on the running dot; `@keyframes rise` (opacity 0, translateY 8px → 1, 0; .4s `cubic-bezier(.2,.7,.2,1)`) on take card and success pill; segmented thumb/tab switches are instant.
- **Sticky**: header always; Studio right column `top:84px` on desktop only.

## State
`suite` ('gen' default; from route) · `prompt` (string) · `job` ('idle' | 'running' | 'done') · `lastPrompt` · `credits` (2000 − 43 per render) · `takes` (count) · `email` · `requested` (bool) · Pricing: `annual` (bool). Tweaks in the prototype: `suite`, `hero` ('still' | 'mosaic' | 'window'), `showPricing`. No data fetching.

## Design tokens (Graphite + blue)
- **Surfaces**: root `#000000` · panel `#0D0D10` · card gradient `#1B1B20 → #141417` · card flat / note `#17171B` · input / chip `#1B1B1F` · hover `#26262B` · window bar `#111114` · dots `#3A3A40` · segment thumb `#45454C → #2E2E34`.
- **Hairlines**: strong `rgba(255,255,255,.09)` · card `.10` · window `.12` · input `.08` · row `.07` / `.06`.
- **Text**: primary `#F5F5F7` · body `rgba(235,235,245,.72)` · secondary `.62` / `.66` · muted `.6` · placeholder `.38` · idle dot `.35`.
- **Accent**: `#0A84FF` (fills, dots) · text on dark `#6EB4FF` · lighter link hover `#8FC5FF` · tint `rgba(10,132,255,.14)` · tint border `rgba(10,132,255,.35)` · glow ring `0 0 0 4px rgba(10,132,255,.10)` · primary gradient `linear-gradient(160deg,#4C9DFF,#0A84FF 55%,#0064D6)`.
- **Status**: done `#30D158` (badge text `#5BE07C`) · waiting/gated `#FF9F0A` (text `#FFB340`) · failed `#FF453A` (unused here).
- **Type**: display **Outfit** 600 (H1 `clamp(36–40px, 5.2–6.4vw, 64–84px)` −.035em; H2 `clamp(30px,4vw,46px)` −.03em; card names 20–22px −.02em) · body **Geist** (fallback `-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`) 13–17px, line-height 1.45–1.55 · mono **Kode Mono** for eyebrows (10–11px, .12–.16em, uppercase), chips (10.5px), prices (14–18px 600), numbers.
- **Radii**: chips/buttons 6–8 · cards 10 · windows/plan/take cards 12 · prompt bar 14 · pills 999 · phone frame 34/26.
- **Shadows**: card `inset 0 1px 0 rgba(255,255,255,.05), 0 8px 20px rgba(0,0,0,.3)` · window `0 40px 100px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06)` · prompt bar `0 30px 80px rgba(0,0,0,.6)` · primary `0 6px 18px rgba(10,132,255,.32), inset 0 1px 0 rgba(255,255,255,.28)` · running pill `0 0 16px rgba(10,132,255,.25)`.
- **Spacing**: page gutter `clamp(16px,4vw,40px)` · section padding `clamp(64px,9vw,110px)` · header 60 · grid gaps 10 / 12 / 20 · card padding 18 (plan 22, window bar 0 14) · chip gap 6 · row gap 8–14.

## Assets (all in this bundle, same relative paths as the HTML)
- Fonts (from repo `public/fonts/`): `outfit-latin-wght-normal.woff2` (100–900), `kode-mono-latin-wght-normal.woff2` (400–700), `geist-latin.woff2`, `geist-mono-latin.woff2`.
- Brand (repo `public/brand/`): `particl-mark-on-dark.svg`, `particl-lockup-horizontal-on-dark@4x.png`, `particl-wordmark-on-dark@4x.png`, `particl-app-icon-dark.svg`. The header mark and wordmark are inline SVG/HTML (recipe in `components/ParticlMark.tsx`); the Atomik ring is inline SVG (`components/AtomikMark.tsx`).
- Campaign stills (repo `public/campaign/`): `hero.webp` (1672×941), `character.webp`, `environment.webp` — the Dune Studies sample.
- Product screenshots (repo `design/particl-suites/screenshots/`, 924px captures of the prototype): studio-rig-canvas, studio-takes, gen-composer-blank, gen-composer-prompt-enhancer, business-ads-marketing-studio, business-dtc-image-ads, viral-motion-transfer, viral-history, atomik-agent, atomik-runs, atomik-approvals, atomik-skills, palette-cmd-k, ios27-home, workspace-general-enhancer, workspace-plans-credits, workspace-engines, studio-cast, macos27-desktop. Replace with real app captures when available.
- No Higgsfield assets are used; "similar to Higgsfield" refers to the marketing patterns (prompt-bar hero, model chips, dark theme, plan cards), not its brand.

## Files
- `Home.dc.html` — the tabbed home (Gen default) with all suite sections, shared bottom and the three hero variants.
- `Pricing.dc.html` — plans, packs, rate card.
- `Hero Options.dc.html` — the three hero variants side by side (canvas).
- `support.js` — runtime that renders the `.dc.html` files; not for production.
- `public/`, `design/particl-suites/screenshots/` — assets, paths preserved.

## Mapping to the repo
- Tokens: `app/graphite.css` (Graphite base) and `app/flair.css` (gradient buttons, card gradients, segment thumbs, aurora header) already define these values; reuse them rather than re-declaring.
- Fonts: `app/fonts.css` loads Outfit, Kode Mono and Geist.
- Copy sources to keep in sync: suite blurbs `lib/workspace/pages.ts` (`SUITE_EXTRA`), page intros `lib/workspace/spec-cards.ts`, page lists `lib/suites.ts`, pricing `CLAUDE.md` §7A (mirror of `docs/particl-sow.md`), Edit & Sound `docs/sound-mix.md`, Deliver limits `docs/production-workbench.md`, Viral `docs/subatomik-genjutsu.md` + `components/suites/subatomik-directions.ts`, Atomik `docs/atomik-models.md`, Workspace security `docs/account-security.md`, `docs/workspace-security-policy.md`, `docs/subscribed-workspaces.md`.
- Rules from `CLAUDE.md`: one vocabulary (Takes / Productions / Generate), no client or person names in copy, five viewports, no horizontal overflow, ≥44px targets, prose is a cost.
- Not to claim: Builds and the Skills registry are not runnable; Analyse video is gated until priced; SSO/SCIM/passkeys are open; the movie renderer is ≤3 min / 200 MB; a manifest is not a finished master.
