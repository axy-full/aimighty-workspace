# Handoff: particl studio — signed-in app redesign (55 screens, agent-first)

**Goal:** replace the current signed-in UI of `axy-full/aimighty-workspace` with this design. Backend, data models, API routes, pricing math and copy sources stay as they are; only the presentation layer changes. Layout language is a Higgsfield-style creation shell in the repo's own Graphite tokens with a `#0A84FF` accent.

## What is in this folder
- `App.dc.html` — the whole app as one interactive HTML reference. Open it in a browser (keep `support.js` beside it). Switch screens with the left rail, the stage strips, or a URL hash: `App.dc.html#rig`, `#biz-brand`, `#phone-gen` … Full list below.
- `App Sheet.dc.html` — every screen laid out at 1440×900 (phones 390×844) on one canvas.
- `design/app/*.png` — captures of each screen, same names as the hashes (55). Thirteen captures — cast, boards, astra, gen-images, gen-audio, gen-3d, palette and the six biz-* screens — predate the Atomik dock and jobs pill; the HTML is the reference where they differ.
- `public/fonts/` — Outfit, Kode Mono, Geist, Geist Mono (woff2). `public/campaign/` — the three sample stills used everywhere as placeholder media.
- `support.js` — runtime for the reference files only. Do not ship it.

Reading the HTML: everything is inline-styled markup inside `<x-dc>`. `{{ name }}` is a runtime value, `<sc-if value="{{ flag }}">` a conditional block, `<sc-for list="{{ items }}" as="x">` a loop. The `class Component` at the bottom holds sample data and the screen switch; each screen's inspector content is in `INSP`, each list's rows are constants next to it. Copy values from the markup exactly (colours, sizes, radii, shadows, text).

---

## Shell (every desktop screen)
Grid `76px | 1fr | 300px` under a 52px top bar. Root `background:#000; min-width:1280px` (horizontal scroll below that). Canvas `#0D0D10`; rail, top bar and inspector `#000`; hairlines `rgba(255,255,255,.07–.09)`.

**Top bar (52px)** — 7-dot particl mark (30×13) · project switcher chip (32px, `#1B1B1F`, 14px blue square, "Dune Studies ▾") · breadcrumb (`/ Suite / Page`, last crumb `#F5F5F7`, others 60%) · spacer · search field 340×34 (`#0D0D10`, border .10, placeholder "Search, run or ask Atomik", `⌘K` key cap) · credits chip (34px, blue tint `rgba(10,132,255,.14)` + border `.35`, bolt icon, Kode Mono "1,957 cr") · **Top up** primary 34px · avatar 32px circle (`#45454C→#2E2E34`, initials).

**Rail (76px)** — six buttons 62×58, radius 12, stroke icon 21px + 10px label: Gen · Studio · Business · Viral · Atomik · Workspace. Active: `background:rgba(10,132,255,.14); color:#6EB4FF` + 3×24px blue bar at the rail's left edge. Inactive `rgba(235,235,245,.62)`.

**Inspector (300px)** — 46px header `INSPECTOR` / `⌘J`; title (Outfit 600 17px) + sub (12px 60%); rows `96px | 1fr`, 12.5px, hairline `.06`; optional note (`#17171B`, border .10, radius 8, 12.5px/1.5); actions pinned to the bottom: primary 38px gradient, secondaries 38px `#1B1B1F`. Content per screen is in `INSP` in the HTML.

**Stage strips** — Studio (01 Brief … 08 Deliver) and Business (01 Product … 07 Publish): 46px, `#000`, 12.5px labels with Kode Mono 10px numbers; active label `#F5F5F7`, number `#6EB4FF`, 2px blue underline. Right side: Kode Mono 10.5px production stats.

**Composer panel** (Gen, Business Variants/Product/Design) — 352–392px, `#000`, right hairline; sections labelled with Kode Mono 10.5px `.12em` 50% eyebrows; primary action pinned to the bottom with a 12px summary line + Kode Mono quote above it.

## Components
- **Card**: `linear-gradient(180deg,#1B1B20,#141417)`, border `rgba(255,255,255,.10)`, radius 10 (12 for larger), `inset 0 1px 0 rgba(255,255,255,.05)`. Selected: border `rgba(10,132,255,.45)` + `0 0 0 3px rgba(10,132,255,.10)`.
- **Field**: `#141417`, border `.08`, radius 8, padding 9×11, 12.5–13px; select fields show `value ▾` in 600.
- **Chip** 26–28px: `#1B1B1F`, border `.08`, 12–12.5px 78%. On: blue tint bg, border `.35`, text `#6EB4FF`. Mono tag: Kode Mono 9.5–10px `.1em`, padding 2×6, radius 4, `rgba(0,0,0,.65)` over images.
- **Segmented**: track `rgba(255,255,255,.06)` + border `.10` + `inset 0 1px 2px rgba(0,0,0,.6)`, radius 8–9, padding 3; selected thumb `linear-gradient(180deg,#45454C,#2E2E34)` with `0 2px 8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.12)`.
- **Buttons**: primary `linear-gradient(160deg,#4C9DFF,#0A84FF 55%,#0064D6)`, `0 6px 18px rgba(10,132,255,.32), inset 0 1px 0 rgba(255,255,255,.28)`, white 600; secondary `#1B1B1F` + border `.08`, 500. Heights 28 (toolbar), 32–34 (inline), 38–40 (panel), 44–50 (phone).
- **Progress ring**: SVG r=18 stroke 3, track `rgba(255,255,255,.1)`, fill `#0A84FF` (`#FF9F0A` for training), `stroke-dasharray = pct×1.13 113`, rotated −90°.
- **Status colours**: draft `rgba(235,235,245,.78)` on `rgba(20,20,23,.85)`; picked/rendered `#6EB4FF` on `rgba(10,132,255,.32)`; approved/ready `#5BE07C` on `rgba(48,209,88,.28)`; waiting/training `#FFB340` on `rgba(255,159,10,.28)`; failed `#FF453A`. Run dots: running `#0A84FF` + `0 0 8px` glow.
- **Port colours (Rig)**: Image `#0A84FF`, Direction `#FF9F0A`, Camera/Astra `#BF5AF2`, Take `#30D158`, Audio `#64D2FF`.
- **Lane colours (Edit)**: Picture `#0A84FF`, Dialogue `#64D2FF`, Effects `#FF9F0A`, Ambience `#30D158`, Music `#BF5AF2`; clips at 16–24% alpha of the lane colour, active clip bordered in the full colour.
- **Media tile**: radius 10, `#141417`, border `.10`; bottom gradient `transparent → rgba(0,0,0,.72)` with Kode Mono 10px label left and cost right in `#6EB4FF`.
- **Phone tab bar**: 82px incl. safe area, `rgba(0,0,0,.92)` + blur, 5 tabs 56px tall, 22px stroke icon + 10.5px label, active `#6EB4FF`.

## Type and tokens
Display **Outfit** 600–700 (page titles 16–22px −.02em; ad canvas 34px −.03em). Body **Geist** 12–14px / 1.4–1.5. Mono **Kode Mono** for eyebrows (10–10.5px, `.12em`, uppercase), tags, prices, timecodes. Screenplay text **Geist Mono** 13.5px / 1.65.
Text: primary `#F5F5F7`, body 72–78%, secondary 55–62%, muted 40–50%. Accent `#0A84FF`, accent text `#6EB4FF`, tints `.14 / .35`. Surfaces `#000 · #0D0D10 · #141417 · #17171B · #1B1B1F · #26262B`.

---

## Screen inventory (55) → suggested routes
| Hash | Screen | Route | Notes |
|---|---|---|---|
| `auth-signin` | Sign-in · returning | `/signin` | Email → code by email → authenticator. No passwords. Links: open an invite, use a recovery code. |
| `auth-invite` | Sign-in · invite link | `/invite/[token]` | Inviter avatar + "X invited you to Y", one-time · expires note, email match check, Accept and set up sign-in. |
| `auth-totp` | Sign-in · authenticator set-up | `/signin/totp` | QR + secret, 6 code boxes (active box blue), recovery-codes warning, Verify. |
| `auth-first` | First run | `/welcome` | 250 cr granted, name, role chips, Start from (open production · sample · ask Atomik), Enter the studio. |
| `switcher` | Production switcher | `overlay (project chip)` | 560px card: productions with thumb, meta, state; + New production; "switching drains pending saves first". |
| `gen · gen-images · gen-audio · gen-3d` | Gen · four modes | `/gen, /gen/images, /gen/audio, /gen/3d` | Composer 352px (mode segmented, model card, wells, prompt, 4 settings, Generate with quote) + results (16:9 grid · squares · waveform rows · mesh tiles). |
| `palette` | ⌘K palette | `overlay` | Ask Atomik line first; groups ASK ATOMIK · ACTIONS · PAGES · ASSETS · MODELS. |
| `brief … deliver` | Studio · 8 stages | `/studio/[production]/{brief,boards,cast,astra,rig,takes,edit,deliver}` | Stage strip 46px; each stage as designed (see earlier rows in App.dc.html INSP + AGENT). |
| `biz-product … biz-publish` | Business · 7 steps | `/business/{product,brand,cast,format,variants,design,publish}` | Step strip; composer/list layouts; Variants is the hub. |
| `viral` | Viral · Motion Transfer | `/viral/motion-transfer` | Segmented (Transfer · Swap · Shorts) + links Sources · Compare · History; source with trim, ordered refs, direction, resolution, live quote. |
| `vir-swap` | Viral · Object Swap | `/viral/object-swap` | Tracked region (dashed blue box + dimmed frame), "what to replace" / "what it becomes" ordered refs, direction, quote. |
| `vir-shorts` | Viral · Shorts | `/viral/shorts` | Source card, Cut by (Beats · Even · Hooks), count/length/aspect/captions, hooks toggle, one quote; set preview 3-col 9:13. |
| `vir-sources` | Viral · Sources | `/viral/sources` | Upload dropzone, 4-col source cards with OWNED / TOO SHORT states, 4–30 s rule note. |
| `vir-compare` | Viral · Compare | `/viral/compare` | A/B split with white divider and ⇔ handle, locked scrub bar, metrics MOTION MATCH · IDENTITY HOLD · FLICKER, Pick B → Takes. |
| `vir-history` | Viral · History | `/viral/history` | Type chips with counts, 4-col cards with TRANSFER / SWAP / SHORTS badges, + Use as reference. |
| `atomik` | Atomik · Agent + Runs | `/atomik` | Sub-nav strip (Agent · Runs · Generate · Recipes · Builds · Skills · Models · Approvals · Budget); chat + plan card + Runs column. |
| `atk-generate` | Atomik · Generate | `/atomik/generate` | Outcome text, Target/Thinking/Takes/Cap, toggles, Plan · 0 cr; proposed plan card with READS/BUDGET/ENGINES/OUTPUT facts; Approve · N cr. |
| `atk-recipes` | Atomik · Recipes | `/atomik/recipes` | 2-col recipe cards: chain chips, Clone · exact, Run with new inputs, last run. |
| `atk-builds` | Atomik · Builds | `/atomik/builds` | NOT YET RUNNABLE badge; build cards with context version chip and stage rows (DONE / READY / WAITING), Publish context vN. |
| `atk-skills` | Atomik · Skills | `/atomik/skills` | REGISTRY PENDING badge; 3-col pack cards INSTALLED / AVAILABLE. |
| `atk-models` | Atomik · Models | `/atomik/models` | Crew table: Genie + 7 departments (colour dot, model chip, Low/Med/High, per-run budget); defaults panel; engines a plan may use. |
| `atk-approvals` | Atomik · Approvals | `/atomik/approvals` | Waiting cards (amber border): frozen inputs chips, RULE line, Approve · N cr / Edit steps / Decline; rules toggles; decided list. |
| `atk-budget` | Atomik · Budget | `/atomik/budget` | Spent / reserved (striped) / remaining bar with ask-again line; BY ENGINE and BY DEPARTMENT bars. |
| `ws-general` | Workspace · General | `/workspace/general` | Name, slug, default production, time zone; PROMPT ENHANCER segmented; ENGINE SUGGESTIONS toggles; export/delete (red border). |
| `ws-people` | Workspace · People | `/workspace/people` | Invite row (one-time link · 7 days), members table with role chips (OWNER blue · ADMIN purple · MEMBER grey · REVIEWER amber), pending invites. |
| `workspace` | Workspace · Plans & credits | `/workspace/plans` | Stat cards, usage bars, packs, ledger. |
| `ws-usage` | Workspace · Usage | `/workspace/usage` | Month/Week/Day, 4 stat cards, 30-day bar chart, BY PERSON and BY SUITE tables. |
| `ws-engines` | Workspace · Engines | `/workspace/engines` | Connected-account card; engine table (toggle, kind, multiplier, 7-day margin coloured, floor-guard state). |
| `ws-security` | Workspace · Security | `/workspace/security` | TOTP toggle, recovery codes, invites note; NOT CLAIMED YET (SSO, SCIM, passkeys); sessions and API tokens tables. |
| `phone-home · phone-workflow · phone-gen · phone-takes · phone-edit · phone-atomik · phone-business · phone-viral · phone-workspace` | Phone · 9 screens | `same routes at ≤ 480px` | Header (mark, project chip 44px, credits, avatar) + suite chips row (44px) + content + tab bar (Home · Workflow · Canvas · Takes · Edit, 56px). Docked primary buttons 50px sit above the tab bar. |

Every hash opens directly: `App.dc.html#vir-compare`, `App.dc.html#phone-atomik` …

## Agentic layer (every screen)
The product is agent-first: every step can be asked for, planned and priced by Atomik, and nothing renders before an approval. Implement these four pieces once in the shell and feed them per route:
- **Atomik dock** — 52px bar pinned to the bottom of the canvas on every desktop screen except the Atomik agent itself and overlays. Left: 16px Atomik ring, `ATOMIK · <DEPARTMENT>` (Kode Mono 10px .12em #6EB4FF), one-line suggestion (12.5px, 80%). Right: 1–2 priced action chips (30px, blue tint, label + Kode Mono cost) that open Atomik · Generate with the plan prefilled, and an "Ask Atomik about this page" field (250×30, ⌘K). Content per screen is the `AGENT` map in App.dc.html (crew, tip, actions, prov).
- **Provenance** — a blue-tinted block in every inspector: `PROVENANCE · <DEPARTMENT>` + one sentence naming the run, the department, who approved, what was frozen and what it cost. Hand-made items say so.
- **Jobs pill** — top bar, next to credits: pulsing blue dot + "3 rendering · 1 held"; opens Runs. Counts every take the signed-in person has in flight or held.
- **Crew** — Genie routes; Director, DOP, Editor, Production designer, Costume stylist, Producer, Continuity run one task at a time (docs/production-workbench.md). Colours: Director #0A84FF · DOP #BF5AF2 · Editor #FF9F0A · Production designer #30D158 · Costume stylist #64D2FF · Producer #FF453A · Continuity #F5F5F7 · Genie #6EB4FF.
Rules that show in the UI: a stage card either opens a tool or is performed by an Atomik plan; the palette's last group is always Ask Atomik; approving freezes inputs, wallet and price; any single step over 200 cr asks again; failed renders are never billed; Builds and the Skills registry stay marked not yet runnable.

## Behaviour to keep
- Rail and stage strips switch route; active state follows the route. ⌘K opens the palette anywhere; Esc closes.
- Every render button carries its quote ("· 43 cr", "· live quote"); failed renders are never billed; approving an Atomik plan freezes inputs, wallet and price; any step over 200 cr asks again.
- Running items show a ring with percent; done items show engine · cost; statuses use the colour table above.
- Phone: bottom tab bar (Home · Workflow · Canvas · Takes · Edit), 44px+ targets, 16px inputs.

## Implementation order
1. Shell: layout with rail, top bar, inspector slot, stage-strip slot; tokens from `app/graphite.css` / `app/flair.css` (already define these values — reuse, don't redeclare); fonts from `app/fonts.css`.
2. Gen (4 modes) + palette. 3. Studio 8 stages. 4. Business 7 steps. 5. Viral, Atomik, Workspace as designed; leave the rest on the old pages behind the new shell. 6. Phone layouts.
Verify at 1440×900 and 1920×1080 against `design/app/*.png`; phone at 390×844. Lint, type-check and build must pass after each step.
