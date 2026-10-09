# Handoff: Particl · "the board, made easy" — master design for `axy-full/aimighty-workspace`

Written 4 October 2026 against repo `main`. The master design is `Particl Suites.dc.html` (open it with `support.js` and `assets/` beside it; every screen has a URL below). The seven `… frames.dc.html` files show each step's screens side by side (`Guest Home frames.dc.html` is the signed-out Home, § 3.7). `PROMPT.md` holds the brief this design answers; `github.md` maps each screen to the repo source it replaces or extends.

The `.dc.html` files are **design references built in HTML** — click-through prototypes of the intended look and behaviour, not production code. Recreate them in the Next.js app with its existing primitives, routes and data. Do not ship the HTML. `CLAUDE.md § Pricing` is the only source of prices; `lib/shell/ia.ts` is replaced by § 1 below.

## 0 · What Particl is, and the ten ease rules

Particl is a production studio for ad films and social content. A person brings a brief; Atomik (the agent) asks what it needs, writes the plan, prices every step, waits for approval, makes the work and checks it. Every paid action shows its price; nothing is spent without a person's approval.

Apply on every screen:

1. One primary button per screen, and it is the next step.
2. Auto by default. Engine, model, agent, effort, lens, light and look are chosen for the person and shown as one line ("Seedance 2.5 · 1080p · 5 s · 43 cr · Change"). Advanced settings sit folded in the Inspector.
3. Set once, carried everywhere: aspect, frame rate, look and cast come from the brief.
4. Everything saves itself. No save buttons, no "save first" errors. Undo (⌘Z, and a toast with Undo) instead of "Are you sure?".
5. Plain words; cut any sentence the screen can show instead. Icons always have a label; no two-letter tiles.
6. Every result is a card with the same actions: Approve, Reject, Change with words, Use as reference, Versions.
7. Money without anxiety (§ 5).
8. Readable dark: text people read is ≥ 12 px and ≥ 55 % white; fainter only for disabled things. Visible focus rings. Touch targets ≥ 44 px on phones.
9. Every wait shows live progress on its card, a time estimate, and "Notify me when done".
10. Empty states teach by doing: one action and a template, never a paragraph.

## 1 · Information architecture — header option B (templates)

**Header (56 px, every screen):** particl mark + suite pill · segment **Home · \<current project\> · Make · Atomik** · Search (⌘K) · Jobs pill · credits · avatar. There are no suite destinations: Studio, Ads and Social are **templates** picked on Home (Film and Start from a script open a Studio board; Ad campaign an Ads board; Social clips a Social board), and a project's board looks the same whichever template started it. **Make** opens as a panel over any screen. **Atomik** opens its panel over any screen (its top links to the four control-room places). **Crew** is a review panel inside boards ("Ask the crew"). **Settings** sit behind the avatar.

### 1.1 Pages and URL params (the master file)

| Area | Page | URL |
|---|---|---|
| Home | Home: "What are we making?", templates, projects, Waiting for you, a sample production | `?view=home` |
| Home | + Make open over Home | `?view=home&make=1` |
| Home | + Atomik panel · Ask Atomik how | `?view=home&atomik=1` · `?view=home&atomik=how` |
| Home | + ⌘K (empty · with a query) | `?view=home&palette=1` · `&q=…` |
| Home | + Settings menu behind the avatar | `?view=home&settings=1` |
| Studio board | Frames a–p and f2 (§ 3.1) | `?view=board&frame=a…p` · `&frame=f2` |
| Studio board | + Make states | `?view=board&frame=g&make=1 \| image \| audio \| change \| fill \| made \| recent` |
| Studio board | + Social quick tools in Make | `?view=board&frame=g&make=motion \| swap` |
| Ads board | From a product page · hooks/formats/ads · the poster Designer | `?view=board&kind=ads&frame=1 \| 2 \| 3` |
| Social board | Source and clips · hooks/effects/posts | `?view=board&kind=social&frame=1 \| 2` |
| Atomik control room | Approvals · Activity · Skills · Memory | `?suite=atomik&page=approvals \| runs \| saved-skills \| memory` |
| Settings | Team · Plan & credits · Spending rules · Connections · Advanced (+ Models open) | `?view=workspace&ws=team \| credits \| rules \| connections \| advanced` · `&open=models` |
| Phone | Screens a–h (§ 3.6) | `?device=phone&screen=home \| plan \| review \| fix \| record \| make \| atomik \| states` (+ `&from=notification`, `&credits=short`, `&paused=1`) |
| Guest (signed out) | Home · the sample production · Sign up with and without an invitation link (§ 3.7) | `?guest=1&view=home` · `?guest=1&view=board&frame=s` · `?guest=1&view=home&signup=1&invite=1&brief=…` · `?guest=1&view=home&signup=1&brief=…` |
| Guest phone | The same four at 390 × 844 (§ 3.7) | `?device=phone&guest=1&screen=home \| sample` · `?device=phone&guest=1&screen=signup&invite=1&brief=…` · `?device=phone&guest=1&screen=signup&brief=…` |

Board rail sections — Studio: Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver. Ads: Brand · Product · Hooks · Formats · Ads · Adapt · Deliver. Social: Source · Clips · Hooks · Effects · Posts. Each rail entry has an icon, a 12 px label and a status (empty · working · needs you with a count · done); the section in view is highlighted; hovering shows a one-line summary; clicking glides the board there. Library and History sit at the bottom of the rail as 280 px drawers, closed by default.

### 1.2 Old → new: every old page and deep link

| Old URL / page | Now |
|---|---|
| `?suite=studio&page=stages` (Studio overview) | Home `?view=home` (projects as cards) |
| `?suite=studio&page=brief` (01 Brief & Script) | Studio board › Brief region `?view=board&frame=d` (brief document card); the questions step is `frame=b` |
| `?suite=studio&page=beats` (02 Beats & Shots) | Studio board › Storyboard region; the shot-list table is the board's List view (`frame=d`, Board/List toggle) |
| `?suite=studio&page=boards` (03 Storyboards) | Studio board › Storyboard `frame=d`; Looks `frame=c` |
| `?suite=studio&page=env` (04 Environment) | Studio board › Cast region (Cast, Environment and Elements cards) `frame=h` |
| `?suite=studio&page=cast` (05 Cast & Elements) | Studio board › Cast `frame=h` (identity status, consent record) |
| `?suite=studio&page=astra` (06 Astra 3D) | **3D blocking**, a tool on a shot card (Inspector › Advanced); no page of its own |
| `?suite=studio&page=rig` (07 Rig · canvas / `&rig=list`) | **The Board itself** `?view=board` (canvas) and its List view |
| `?suite=studio&page=takes` (08 Takes) | Shots region `frame=f`/`g`, Review mode `frame=l`, Make › Recent (`make=recent`) |
| `?suite=studio&page=edit` (09 Edit & Sound) | Cut region `frame=i` ("Open Edit & Sound" opens the editor) |
| `?suite=studio&page=deliver` (10 Deliver) | Deliver card `frame=i` |
| `?view=gen&mode=video\|images\|audio` (Gen), `&task=edit\|upscale`, `&sheet=1` | **Make** panel `…&make=1 \| image \| audio`; Seedance Edit and the upscales are "Change with words" / card actions; the model sheet is "Change" on the engine line (`make=change`) |
| `?suite=business&page=dtc` (Image ads) | Ads board `kind=ads&frame=2` (image ad group) |
| `?suite=business&page=setup` | Ads board `frame=1` (Brand kit, Product facts, Reference ad cards) |
| `?suite=business&page=brand \| product \| reference` | Ads board `frame=1` cards |
| `?suite=business&page=format \| hooks` | Ads board `frame=2` (Hooks card, Format briefs card) |
| `?suite=business&page=design` (poster Designer) | Ads board `frame=3` (full editor from a card) |
| `?suite=viral&page=motion \| swap` (Genjutsu) | Make › **Motion transfer** / **Object swap** (`make=motion \| swap`); Social board Effects card `kind=social&frame=2` |
| `?suite=viral&page=history` | Make › Recent (`make=recent`) and the board's History drawer |
| `?view=crew&crew=room \| members \| sessions` | **Crew review** inside a board `frame=m`; sessions are in the Project record `frame=n` |
| `?suite=atomik&page=agent` | Atomik's panel (`&atomik=1` on any screen); the plan card on the board `frame=e` |
| `?suite=atomik&page=runs` | Control room › **Activity** `?suite=atomik&page=runs` |
| `?suite=atomik&page=approvals` | Control room › Approvals (same URL) |
| `?suite=atomik&page=budget` | Settings › Spending rules `?view=workspace&ws=rules`; per-project spend in Activity and the Project record |
| `?suite=atomik&page=models` | Settings › Advanced › Models `?view=workspace&ws=advanced&open=models` |
| `?suite=atomik&page=skills` (Tools & connections) | Settings › Connections `ws=connections` (MCP, publishing) and Advanced › Tools |
| `?suite=atomik&page=memory`, `page=saved-skills` | Control room › Memory, Skills (same URLs) |
| `?view=workspace&ws=general \| people \| credits \| usage \| dashboard \| engines \| security` | Settings in five sections: Team (`people`, `security`), Plan & credits (`credits`, `usage`), Spending rules, Connections, Advanced (`engines`, `general`); `dashboard` → Activity |
| `&lib=0 \| assets`, `&insp=0` | The Library is a rail drawer (closed by default); the Inspector opens only on selection — both params are no-ops |
| `&palette=1`, `&beats=graph` | `&palette=1` still opens ⌘K; `beats=graph` → the Board itself |

## 2 · Design tokens (Graphite, dark only)

**Surfaces** — canvas and all panels `#000000`; separation by hairlines only, `rgba(255,255,255,0.09)`; object cards (media tiles, takes, cast/place/brand cards, dialogs, popovers) `#0B0B0D` with `1px rgba(255,255,255,0.10)`; inputs, textareas, selects `#0A0A0C` with `1px rgba(255,255,255,0.08)` (focus: the accent border); segment tracks `#0D0D10`, selected segment `#1C1C20`; secondary buttons outlined on black, `1px rgba(255,255,255,0.14)`; row separators `rgba(255,255,255,0.06)`; dashed drop zones `rgba(255,255,255,0.16)`; media badges `rgba(0,0,0,0.6)`; scrims `rgba(0,0,0,0.55–0.6)`; board dot grid `radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px) 0 0 / 24px 24px` on `#000`.

**Text** — primary `#F5F5F7`; secondary `rgba(235,235,245,0.6)`; quiet `0.55`; eyebrows `rgba(255,255,255,0.55)`; disabled `0.45`.

**The one accent** — `#0A84FF` (hover `#2D95FF`); accent text `#6EB4FF`; tint `rgba(10,132,255,0.14)`; tint border `rgba(10,132,255,0.35–0.5)`. Status: success `#30D158` (text `#4CD964`), warning `#FF9F0A` (text `#FFB340`), danger `#FF453A`. Suite dots: Studio blue, Ads `#FF9F0A`, Social `#FF453A`, Atomik `#30D158`, Crew `#BF5AF2`. No gradients except project swatches and avatars.

**Type** — `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Geist, system-ui, sans-serif`; mono `ui-monospace, "SF Mono", Menlo, monospace` for prices and numbers only. Desktop: h1 26/600/−0.03em; card titles 15/600/−0.01em; body 14; documents 15/1.5; meta 13 (0.6); eyebrows 12/600/+0.08em uppercase (0.55); controls 12.5–13. Phone: titles 17/600, card titles 15/600, body 14–15, meta 13, eyebrows 12. **Minimums**: nothing read is below 12 px or below 55 % white on desktop or phone; phone touch targets ≥ 44 px.

**Radii** — buttons/inputs 6 (phone 10), cards 10–12, groups 14, dialogs 10, sheets 16 top, pills 999. **Motion** — easing `cubic-bezier(.2,.7,.2,1)`; `om-in` .4 s page enter / .2 s scrims / .25 s toasts; `om-pop` .2 s dialogs / .15 s menus; `om-pulse` 1.4 s on live dots; board glides .35 s; colour transitions .2 s.

## 3 · Screens and states (steps 3–7), each with its URL

### 3.1 Studio board (`?view=board&frame=…`)

| Frame | What it shows | State |
|---|---|---|
| a | Empty board: "What are we making?" centred, Attach, aspect/length chips, **Start · up to 4 cr** with the thinking line, templates as a quiet row | empty |
| b | Atomik's panel asks ≤ 3 questions as chips + free field, "Use your judgement" | loading (thinking) |
| c | Looks group: four look frames (3 cr each) after **Show me looks · 12 cr**; tick to pick | needs review |
| d | Brief document card + storyboard strip (**Draw the storyboard · 9 cr**); Outline rail: Brief, Looks done, Storyboard needs you | needs review |
| e | Approval card on the storyboard: **Make 3 shots · 93 cr**, "Fixes if needed: up to 2 per shot, at most 186 cr", balance after, steps folded, Approve · Change · Hold | waiting for approval |
| f | Shots rendering in place, Shot 1 "Look anchor", header "Rendering 1 of 3 · cost so far · Stop" | rendering |
| f2 | Pause card at 80 % of the budget: Continue or Stop | paused at 80 % |
| g | Take card in review: v1/v2, Approve, Reject, Atomik's note "Feet slide; reflection wrong" | needs review |
| h | Cast, Environment, Elements cards; identity status, **Build identity · 54 cr**; consent record; sphere: **Lock as master · free**, **Render a still · 3 cr** | approved / draft |
| i | Cut (approved takes, mini timeline, Open Edit & Sound) and Deliver (spec check, **Render master · free**) | approved |
| j | "Where to next?" small cards | — |
| k | Inspector on a take: preview, prompt + copy, engine line, price paid, versions, history; Approve · Reject · Change with words · Select & edit a region · Use as reference · Download; Advanced folded | — |
| l | Review mode: J/K, A, R, space, C; side-by-side and slider compare | — |
| m | Crew review: Director, DOP, Costume, Continuity seats; converged notes as cards to accept/dismiss, priced like any run | needs review |
| n | Project record tab: brief, every approval quoted → settled, open decisions, spend against the budget | — |
| o | Library drawer open, a look frame dragged onto a shot | — |
| p | History drawer open | — |

Other states on the board: **rejected** — the take card dims, its version is kept, "Rejected · nothing more spent"; **failed** — "Nothing billed" with Retry when nothing was charged, else the cost and Retry; **stopped** — the group header shows "Stopped · N cr spent", slots keep what finished; **insufficient credits** — the approval card shows "Short by N cr" with **Top up** beside Approve (Approve waits); **unavailable** — an engine with no price or key shows "Unavailable · no key for Kling 3.0" on the engine line and the step is skipped in the plan with the reason; **offline** — the board is read-only, judging queues, a top-right message "Offline · changes queue".

### 3.2 Make (`…&make=…`)

`make=1` panel over the board · `image` / `audio` type switch · `change` the engine sheet · `fill` Atomik filling the fields after "make shot 2 at golden hour" · `made` the result landing on the board (card centred left of the panel, lit briefly) and in the Library · `recent` Make's history · `motion` / `swap` the Social quick tools (one source video, 1–8 references, live price). States: empty prompt (Make disabled with the reason), rendering (progress on the new card), failed ("Nothing billed · Retry"), insufficient credits ("Top up" on the Make button's place).

### 3.3 Ads and Social boards

Ads `kind=ads&frame=1` (Brand kit with swatches/wordmark/type, Product facts, Reference ad — waiting for review), `frame=2` (Hooks · 12 lines, Format briefs · 18 in 6 formats, image ads 3 cr, video ads 43 cr, UGC with consent, **Adapt · 54 cr**), `frame=3` (poster Designer: layers, headline, **New background · 3 cr**, **Export PNG · free**). Social `kind=social&frame=1` (source video, three clips with hook, captions, 9:16), `frame=2` (Hook review scored with reasons, never a view prediction; Effects priced; Narrated video; a Post card per platform — every post approved by a person).

### 3.4 Atomik everywhere

⌘K `?view=home&palette=1` (+ `&q=go to cast`, `make shot 2 warmer`, `approve everything under 10 cr`, `…under 50 cr` with the "Needs an admin" group). Panel `&atomik=1`, how-to `&atomik=how`. Control room: Approvals (one queue, per-item Approve outlined with price, the one filled **Confirm** for approve-in-one-go, Ask/Auto switch, the rules shown with "Edit in Settings › Spending rules"), Activity (settled per project and per run), Skills (saved runs, **Run again with new words**, priced once), Memory (brand, audience, references, cast).

### 3.5 Settings (`?view=workspace&ws=…`)

Team · Plan & credits (balance in cr and $, held and settled, **Top up · 500 cr · $50**) · Spending rules · Connections (MCP tokens: read-only or "Can prepare jobs · a person approves each"; publishing accounts) · Advanced (Models, Tools, folded; `&open=models`).

### 3.6 Phone (`?device=phone&screen=…`, 390 × 844)

`home` (Needs you: approvals with the price as the button — a multi-step plan opens the approval screen, a single item approves from Home; renders with live progress; takes to review; then projects) · `plan` (+ `&from=notification`; `&credits=short` shows Top up beside a waiting Approve) · `review` (swipe right approve, left reject, Undo toast; swiping never spends) · `fix` (Change with words · 43 cr · fix 1 of 2) · `record` (+ `&paused=1`: 160 of 200 cr settled, Shot 3 waiting) · `make` · `atomik` (sheet; Ask · free / up to 4 cr) · `states` (rendering; failed · Nothing billed · Retry · 7 cr; insufficient credits · Top up with the header at 40 cr; offline: judging queues, spending reads "Needs a connection").

### 3.7 Guest Home (signed out; `Guest Home frames.dc.html` shows all eight)

| Frame | URL | What it shows |
|---|---|---|
| 1 | `?guest=1&view=home` | Home signed out: **Sign in** (outlined) and **Sign up** (the one filled button) in the header; "What are we making?" with Attach a brief, Add references, the aspect and length chips and an outlined **Start** with no price and no thinking line; the templates; the sample production card "A 15-second film". No projects, no Waiting for you, no balance. Make, Atomik, Search, Add references, Start and the templates open the sign-up sheet. |
| 2 | `?guest=1&view=board&frame=s` | The sample production, read-only: the slim line "A sample production. Sign up to make your own."; brief, looks, storyboard, the plan card **Make 3 shots · 93 cr** (Shot 1 · hero take · Seedance 2.5 · 5 s · 1080p · 43 cr; Shot 2 · hero take · 43 cr; Shot 3 · draft take · Kling 3.0 Standard · 5 s · 7 cr; "Fixes if needed: up to 2 per shot, at most 186 cr"); Shot 3 in review (v1 · Kling 3.0 Standard · 5 s · needs review, Atomik: "the sphere drifts off axis late"); the cast card "Lead · ivory suit, short dark bob" with no consent record; Cut and deliver "2 approved takes · 0:10", every shot 5 s, Shot 3 waiting, delivery checks pending. Every action (Approve, Reject, Hold, Change, priced buttons) reads "Sign up to make this" and opens the sheet; Lock as master, Measure loudness, Render master, Open Edit & Sound, Library and History are hidden. |
| 3a | `?guest=1&view=home&signup=1&invite=1&brief=…` | Sign up with an invitation link, centred: the brief kept (3 lines), email, **Create account**, the Invite plan line. |
| 3b | `?guest=1&view=home&signup=1&brief=…` | Sign up without a link, centred: "Particl is invite-only for now." Name, email, what you make, **Request access**, the brief kept, "Already have an account? Sign in". |
| P1 · P2 · P3a · P3b | `?device=phone&guest=1&screen=home \| sample \| signup` (+ `&invite=1`, `&brief=…`) | The same four on a phone: 44 px controls; the sample's plan shows exactly the three shot lines and the 93 cr total; the sheet's brief clamps to 3 lines. |

The sample's title is the real production's name once it exists, and "A 15-second film" until then. No person's name, project name or consent record appears signed out.

## 4 · Actions (paid or state-changing)

Price basis: **card** = rate-card row in `CLAUDE.md § Pricing`; **estimate** = live estimate shown as "up to N cr", quoted before the run; **free**. Who: **anyone** on the workspace · **person** (never Atomik, never an MCP agent) · **admin** (owner, or whoever the rule names).

| Control | What it does | Price basis | Who | Atomik prepares it as |
|---|---|---|---|---|
| Start · up to 4 cr (Home, empty board) | Atomik reads the brief and asks questions | estimate (thinking) | anyone | "Atomik's thinking may cost up to 4 cr" |
| Show me looks · 12 cr | 4 look frames | card: Nano Banana Pro 3 cr × 4 | anyone (person approves) | "Four looks, 3 cr each, 12 cr" |
| Draw the storyboard · 9 cr | one frame per shot | card: Nano Banana Pro 3 cr × 3 | person | "Three frames in the chosen look, 9 cr" |
| Make 3 shots · 93 cr (plan Approve) | the production plan runs | card: Seedance 2.5 43 + 43 + Kling Std 7 | person; a step over 40 cr needs an admin | lists every step, the fix allowance, the total and the balance after |
| Approve · 66 cr (/hero-takes plan) | keyframes 9 + hero take 43 + draft takes 14 | card | person; Hero take 43 cr needs an admin | "Thinking · 4 cr · billed when Atomik planned it" |
| Change / Hold (plan) | re-price · keep the plan, spend nothing | free | anyone | re-prices before approval |
| Approve / Reject (take) | judges the take; keeps versions | free | person | one-line review note |
| Change with words · 43 cr | a fix on a take; counts against 2 per shot | card: the take's engine | person | "fix 1 of 2 · 43 cr" |
| Use as reference · Versions · Download | reference tray · version switch · original bytes | free | anyone | — |
| Build identity · 54 cr | trains a cast identity | card: identity training 54 cr | person; needs a consent record first | "Identity for Mira · 54 cr · consent on file until …" |
| Lock as master · free / Render a still · 3 cr | element continuity · a still of it | free / card NB Pro | anyone / person | — |
| Open Edit & Sound · Render master · free · Export PNG · free | local encode and export | free | anyone | — |
| Make · 43 cr / 3 cr / up to 1 cr | video / image / speech | card Seedance 2.5 · NB Pro / estimate ElevenLabs | person | "Seedance 2.5 · 1080p · 5 s · 43 cr · Change" |
| Motion transfer · Object swap | one source video, 1–8 refs, one element replaced | estimate (no card row) | person | "up to N cr" live |
| Ads: Read the site · up to 3 cr · Make the image ads · 54 cr · Adapt · 54 cr · New background · 3 cr | brand kit / 18 stills / 18 adaptations / poster background | estimate · card NB Pro × 18 · card × 18 · card | person | lists the count and the per-item price |
| Social: Find clips · up to 4 cr · Review all three · up to 4 cr · Apply effect · 43 cr · Make narrated · up to 134 cr | clips · hook review · effect · narrated video | estimate · estimate · card Seedance 2.5 · card 129 + estimate 5 | person | a scored review with reasons, never a view prediction |
| Approve post | publishes to a platform | free | **person only** | prepares the post; never publishes |
| Ask the crew | Director, DOP, Costume, Continuity converge | estimate (a run) | person approves the run | notes land as cards to accept or dismiss |
| Confirm · approve N items · up to N cr (⌘K / Approvals) | approves every listed held item | sum of their bases | **person only**; items over 40 cr need an admin and are left out | lists project · step · price and the total |
| Ask / Auto (spend without asking) | steps under the limit run without a gate | — | **person only** (admin) | marks Auto steps "spent without asking" in Activity |
| Top up · 500 cr · $50 | buys credits | $ | **person only** | never |
| Spending rules (40 cr, budget, 200 cr) | limits | — | **admin only** | never |
| Record consent | who, for what use, until when | free | **person only** | blocks any run using the face or voice until recorded |
| Stop · Continue (80 %) | stops a group / continues past the pause | free / holds the next step | person | "160 of 200 cr settled; continuing holds 43 cr more" |
| Retry (failed) | the same request once more | same as the step; "Nothing billed" if nothing was charged | person | states what was charged |
| Run again with new words (Skills) | re-runs a saved run | priced once at the saved plan's basis | person | the saved plan with the new words |
| MCP tokens (Connections) | outside agents prepare jobs | — | person creates/revokes; agents **prepare, never approve** | each prepared job appears in Approvals |

## 5 · Money rules

- **Per-shot admin rule**: over **40 cr** on a shot needs an admin (Mara may approve up to 40 cr a shot). Marked on the step; left out of one-tap batch approvals.
- **Platform line**: any job over **200 cr** needs a person's approval, even under Auto.
- **Production budget** (200 cr sample) with a **pause at 80 %** (160 cr): Continue or Stop.
- **Ask / Auto**: Ask = every step waits at the gate; Auto = steps under the limit (10 cr sample) run and are marked "spent without asking". A person sets it in Settings › Spending rules.
- **Fix allowance**: up to 2 fixes per shot, shown on the plan as "at most N cr" = 2 × the sum of the shots' engine prices (2 × (43 + 7 + 7) = 114 cr).
- **Thinking**: billed when Atomik plans (4 cr on the sample plan); shown as "up to 4 cr" before a request. **How-to answers are free.**
- **Display**: "N cr", "up to N cr" or "free"; never a bare "quoted". Hover shows dollars (1 cr = $0.10). "held" for approved-not-settled; "settled" after the provider confirmed.
- **Only a person approves spending.** Atomik prepares and explains; MCP agents prepare; neither approves.

## 6 · Keyboard map

⌘K search + Atomik · ⌥M Make (doesn't clash with the browser) · ⌘J Inspector · Esc closes · Review mode: J/K previous/next, A approve, R reject, space play, C compare · Board: V select, F frame, N note, T text, I image, ⇧V video, ⇧A audio, U upload, ⌘Z undo, ⌫ delete, 0 fit, L list view, ⌘C/⌘X/⌘V/⌘D copy/cut/paste/duplicate.

## 7 · Names, old → new

Rig → **Board** · Astra → **3D blocking** · Genjutsu → **Motion transfer / Object swap** · Moleculr Business Suite → **Ads** · Subatomik Viral Studio → **Social** · Gen → **Make** · Soul / Soul ID → **Identity** · Supercomputer → **Atomik** (the agent's name stays) · Crew → **Crew review** · Takes wall → **Make › Recent** · Jobs "frozen" → **held**.

## 8 · Placeholders

**Names**: ZigZag Films (workspace) · Akshay Panchal, Mara Sethi, Iver Lund (people) · Dune Studies, Northline, Night market · sample (projects) · Maison Aurel · Silk scarf (Ads project and brand) · Dune walk · clips (Social project) · Mira (cast) · @maisonaurel, maisonaurel.com, particl.si (accounts and addresses). **Media**: the three stills in `assets/` (hero, environment, character) stand in for every take, plate, cast image, ad and clip. **Prices**: every figure is a sample from `CLAUDE.md § Pricing` — Seedance 2.5 1080p 5 s 43 cr (8.6 cr/s); Kling 3.0 Standard 5 s 7 cr (1.4 cr/s); Nano Banana Pro 3 cr; Nano Banana 2 1 cr; Topaz Astra 23/38 cr per 5 s; identity training 54 cr; prompt enhance 1 cr; ElevenLabs "up to 1 cr" (per character); thinking "up to 4 cr"; the Starter pack 500 cr · $50. Plan totals (66, 93, 114, 160) are sums of those rows.

## 9 · Open decisions (listed, not decided)

1. Cinema Studio price display (no rate-card row today; "up to N cr" until one exists).
2. Final product names (Board, 3D blocking, Make, Ads, Social are this design's proposals).
3. The default for spend without asking (Ask in this design).
4. Sample production content (the desert film is a stand-in).
5. Atomik's thinking cost beyond how-to answers (4 cr per plan in the samples; per-request vs per-plan billing is open).

## Files

`Particl Suites.dc.html` (master) · `Studio board frames.dc.html` · `Make frames.dc.html` · `Ads and Social frames.dc.html` · `Atomik frames.dc.html` · `Phone frames.dc.html` · `Home and header options.dc.html` · `Guest Home frames.dc.html` · `support.js` · `assets/` (stills, local React/Babel) · `PROMPT.md` · `github.md` · `CHANGES.txt`.
