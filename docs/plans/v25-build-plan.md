# v25 first-version build plan

Written 15 Oct 2026, for the owner's review in the morning. It is a plan only. It changes no code and no screen. Nothing in it is built, and no v25 screen PR merges until the owner approves it (owner, 15 Oct 00:15).

**Updated 15 Oct 2026, late evening:** section 4 now says which engines the owner's final engine stack provides (22:15), and section 3 carries the owner's large-screen rules (22:30) as a rule for every screen PR. The rest is as written.

Read from `origin/release/1` at 6ee02198, the v25 prototype (`particl-prototype-25`: README, CHANGES, the app file and the board file with their sources), CLAUDE.md (rules 7, 11, 13, 14, 15) and the owner's decisions in `docs/redesign-plan.md` on `redesign/integration`. Code claims cite `file:line` on release/1. Prices in the prototype are placeholders; every price in this plan is a sample (CLAUDE.md § Pricing).

How to read sizes: **S** is up to a day for one lane, **M** two to three days, **L** four to six days.
How to read **NEEDS AKSHAY**: money (a button that spends, a new priced tool), sign-in, migration, env (Coolify settings), privacy (who can see what, faces, voices, uploads).

---

## 0. The short version

1. **Recommended first slice: the Shots slice, not "the whole Film board".** Build the card, the rail and the top bar (lane C is on these tonight), then Shots in both modes: Director's settings column and bar, Agent's plan card, and Preview with versions and Compare. Everything Shots needs already exists on the server: the quote, the plan approval with its two-fix allowance, takes, reject reasons, job states.
2. **Why not "Film end to end" first:** three of the ten Film steps have no engine behind them today. Treatment (the 12-page deck), Edit (the animatic and timeline) and Deliver (versions, cutdowns, zip). Agent mode on those steps would be a chat with nothing to run. The owner's proposal is right in what it wants first: Shots, Director, Agent and Preview. It is too big only in "end to end".
3. **Then:** the steps before Shots (Brief, Script, Cast, Locations, Elements, Storyboard), then Edit and Deliver on one shared assembly engine (Remotion, #700, off today), then Social narrated on the same engine, then Treatment, Campaign, Clips and Pre-vis.
4. **Social narrated next: yes.** It shares Brief, Script, Cast and Shots with Film. Its only new engines are Hook, Captions and the final assembly, and the assembly is the same one Film's Edit needs.
5. **No migration is needed for the first slice.** Settings, modes and marks fit in the board's draft JSON, as `boardStages` and `boardRounds` already do (`lib/workbench/studio.ts:48`).
6. **About 40 v25 elements have no server or provider behind them today.** They are listed in section 4. **Since the owner's final engine stack (15 Oct 22:15), many of them have an engine planned**: section 4 says which and in which slice. None of it is live. The biggest: the animatic and timeline, captions, smart reframe, clips and moments, Runway and Veo, lip-sync, voice cloning, the label check.
7. **The carry-ins** (Brief card tile shown twice; Home counts and tabs matching the board) have homes: the card PR and the frame PR (section 5).
8. **Lane C's three foundation PRs are PR 1 to PR 3** of this plan (section 6).
9. **Fourteen questions for the owner**, each with a recommendation, are in section 7.
10. **Deadline link:** eleven guard entries expire on 30 Nov 2026. Each is retired by the PR that rebuilds its screen (section 3, last column). If one is not, the owner's word is needed again.

---

## 1. A short map of v25

v25 is two files. The **app file** holds Home, Make, Library, Settings, Workspace settings, the Platform console, sign-in and plans. The **board file** holds every board. The board is "one new component rather than a seventh layer of patches" (README). The app screens are v20's with one change: the shared top bar (CHANGES v25 items 8 and 9).

### The board

**Five board kinds, and their steps** (`KINDS` in the board source):

| Kind | Steps |
|---|---|
| Film | Treatment, Brief, Script, Cast, Locations, Elements, Storyboard, Shots, Edit, Deliver (10) |
| Pre-vis | Treatment, Brief, Script, Cast, Locations, Elements, Storyboard, Animatic, PPM deck (9) |
| Campaign | Pitch deck, Brief, Elements, Look, Formats, Variants, Deliver (7) |
| Social, narrated | Brief, Hook, Script, Cast, Shots, Voice, Captions, Deliver (8) |
| Social, clips | Source, Moments, Clips, Captions, Deliver (5) |

**Two modes.** They are one board with two ways to work, with separate settings (README "Rules").
- **Agent:** no settings column, no bottom bar. Atomik asks two quick questions per step (chips), shows a plan card ("Render 8 shots · N cr · Approve"), shows progress with Cancel, then offers "Go to <next step>". Never names a model.
- **Director:** a left stepper rail, a scope pill ("Shot 4"), a right settings column, a bottom bar with one filled button ("Render 8 shots · N cr", then "Making… · Cancel", then "Next: Edit →"). Names a model only in "Pro pick" (Business and admins).

**Three lenses.** Board, List, Rig (`lens=`). Edit shows a Timeline instead (animatic first). "Map" and "Strip" as lens names are gone (owner, 14 Oct 19:15).

**One card system** (CHANGES v24 B). A card is a picture (or logo, or letter tile), a title and one status line. Five statuses: Not started, Making…, Ready (· vN), ✓ Approved, ✕ reason. On hover, a Ready card shows ✓ and ✕. ✕ opens reason chips for that step, always ending "Other", plus one optional line. Option steps (Hook, Moments) pick with ✓ and grey the rest. ⋯ and right-click give only Preview, Fix ›, Duplicate, Remove. Items the user owns (brand kit, reference ads, source, live-location photos) have no ✓ or ✕; they have Replace.

**Preview** adapts to the card (picture, video, sound with a waveform, pages, script with Script, Beats and Breakdown tabs). It has ✓ and ✕ for the version shown, a versions strip, Compare, Download and ← →.

**Per-step settings** in the right column and pop-ups: Shots has Type, Camera (15 moves), Look, Describe, References (roles and limits), Quality (Draft or Final), Length, Sound, Takes, Model. Each other step has its own list (`D.SET` in the board source). "Open full sheet" screens exist for References, Describe, Shot list, Character sheet, Deck pages and Timeline clip.

**The frame.** A shared top bar (dot logo and wordmark, Home and Make, project tabs with letter tiles, +, the ⌘K bar at a fixed width that widens on focus, the "N need you · N running" pill, avatar), and a second row (breadcrumb, Board · List · Rig, Agent · Director, Atomik ⌘J, collaborator avatars, ⋯). A 116 px stepper rail on the left, centred, one line per step with a status line under the current step. The grid is 3, 4 and 5 cards per row at 1280, 1440 and 1920.

**App screens that are also in v25** (from v15 to v20, not new in v25): Share with team, Changed since you opened it, Move this board to…, All boards (admins), Admin view bar, Trash, Workspace settings, Platform console, signed-out and phone visitor.

### What is new, against v15 and against the code today

| Thing | v15 (reference) | Code today (release/1) | v25 |
|---|---|---|---|
| Modes | none | Atomik's Ask or Auto is a spending setting (`lib/atomik.ts:65`), not a board mode | Agent and Director |
| Film steps | Brief, Script, Cast, Elements, Storyboard, Shots, Cut, Deliver (eight) | the same eight (`lib/v12/board/stages.ts:41-51`) | ten: adds Treatment and Locations, renames Cut to Edit |
| Card | per-kind faces, four rail states | `CardState` is empty, working, needs, done (`lib/board/types.ts:30`) | one card, five statuses, ✓ and ✕ |
| Rail | 88 px with markers | `components/v12/board/StageRail.tsx` (88 px) | 116 px stepper with a status line |
| Right side | toolbar of eight tools | `components/v12/board/BoardTools.tsx` | a settings column; the toolbar is gone |
| Atomik | a docked column | `components/graphite/board/agent/BoardAgentPanel.tsx` | Agent: the chat is the screen. Director: ⌘J overlay |
| Preview | one viewer | `components/PreviewLayer.tsx` (no versions, no Compare, no ✓ ✕) | versions strip, Compare, ✓ ✕, tabs |
| Edit | Cut | cut cards, a browser export (`lib/workbench/render-movie.ts`) | animatic on a Timeline |
| Model | named | named in menus | Auto never names its pick |

---

## 2. The first slice, recommended

### The owner's proposal

"The Film board end to end in Agent mode, plus Director on Shots, plus Preview everywhere; Social narrated next."

### What the code has for each Film step

| Step | What exists | What v25 needs that does not exist | Verdict |
|---|---|---|---|
| Treatment | A text document with versions: title, logline, setup, scenes, notes (`lib/atomikDocs.ts:23`; routes `app/api/atomik/treatment`) | A 12-page deck with pictures, Routes, a Mood film, a PDF or share output | text only |
| Brief | The brief, audience, deliverables, fps and aspect on the draft (`lib/workbench/studio.ts:48`); brand kit on the Ads board | The Spec in the card's status line; Story, Plan and Brand kit as settings | ready (screen) |
| Script | Beat sheet with scenes, beats, shots, characters, props (`lib/production/beats.ts:13`); versions; an approval (`lib/workbench/studio.ts:46`); import | The Script stage is empty on the board today (`lib/v12/board/stages.ts:43-44`); the Read-through (a timed voice read) | partial |
| Cast | Cast cards, identity training, consent records (people only, `lib/security/consent.ts:15`) | A character sheet of 8 angles, wardrobe looks, a voice card | partial |
| Locations | Environment elements (the "things" part of Elements, `lib/v12/board/stages.ts:46`); outpaint (`lib/stillTools.ts:10`) | A stage of its own, coverage angles, "Clean up photos" | partial |
| Elements | Element cards, product read from a page (`ProductStage.tsx`) | The label check; exact-pack lock | mostly ready |
| Storyboard | Draw-the-storyboard with a quote and a price | Styles (Sketch, Ink and wash, Comic…), panels per shot, a board sheet, Import | partial |
| **Shots** | Quote, plan approval with a two-fix allowance (`lib/workbench/plan-approval.ts:28`), takes (draft, picked, approved), Draft then Final, reject reasons (`take-model.ts:399`), job states, references | The per-shot settings column, Auto's hidden pick, Pro pick | **ready** |
| Edit | Cut cards, sound mix, loudness, grade, a browser export capped at 180 s (`lib/workbench/movie.ts:3`) | The animatic, the Timeline, titles, subtitles | missing |
| Deliver | A free browser export and an editorial package (XML, EDL) | The versions grid, 4K, fps, cutdowns, Download all | partial |

Three steps (Treatment, Edit, Deliver) are close to empty on the server side. "Agent mode on every step" would need an Agent that plans work Particl cannot do.

### What I recommend instead

**Slice 1 is Shots in both modes, with the card, the rail, the top bar and Preview.** It uses data and money paths that exist and are tested. It proves the new frame, the five-status card and the approval flow on the step where spend happens. The other nine steps show today's content inside the new frame, as the redesign plan already does for rebuilt screens ("One shell, two frames", `docs/redesign-plan.md`). That keeps the app whole at every PR.

**Why it is smaller and safer**
- No new provider, no new table, no migration.
- Every spend goes through the quote and approval that exist (rules 13 and 14). One Opus money review covers the whole slice.
- It keeps the owner's own centre: Director on Shots, Agent, Preview everywhere.
- The three steps without engines come later, each with its own server PR and review.

**Order after slice 1**
- **Slice 2:** the steps before Shots (Brief, Script, Cast, Locations, Elements, Storyboard), in both modes. Mostly screen work.
- **Slice 3:** Edit and Deliver for Film, on one assembly engine (Remotion #700). This needs the worker switched on in a test workspace first (NEEDS AKSHAY: env).
- **Slice 4:** Social narrated. It reuses slices 1 to 3.
- **Then:** Treatment, Campaign, Clips, Pre-vis, the sharing screens.

Treatment is first on the Film rail but built late. Until then the rail marks it skipped ("Skip this stage" already exists, `StageRail.tsx`), and the board opens on Brief.

---

## 3. The PR list, in order

Rules for every PR:
- **Large-screen rules for every v25 screen PR, from #748 on** (owner, 15 Oct 22:30 IST, replaces his earlier screen-size note; verbatim in `docs/redesign-plan.md`):
  1. **Sizes.** Test and screenshot at five viewports: 1280×800, 1440×900, 1728×1117 (16-inch MacBook Pro), 1920×1080 and 2560×1440 (27-inch monitors and scaled 4K). Attach all five to every screen PR.
  2. **Scaling.** Above 1440 px wide the board canvas scales up to fill the space (bigger cards, same layout, text and chips scaling with the cards, like Figma zoom-to-fit). The rail, top bar, bottom bar and buttons stay at normal size and stay centred. The bug to fix: at 2560×1440 the cards sit in the top half and the bottom third is empty. CSS in the screen PRs, no new design round.
  3. **Sharpness.** Text, icons, buttons and the logo are vector (SVG) at every size, never bitmaps. Every picture on the board (thumbnails, frames, stills, previews) is served at the size the screen needs, with 2× versions for Retina and large monitors (srcset and sizes), and never upscaled past its real pixels. A soft or pixelated image in the 1728 or 2560 screenshots is a must-fix. (The wordmark exists only as PNG in `public/brand/` today: an SVG from the owner's brand files is needed, and until then the PNG at 4× is flagged as a must-fix in each PR.)
  4. **Checks at 2560×1440.** No stranded cards, no text under 12 px, no dead space below the cards, the three bars centred, no horizontal scroll. Report anything that looks wrong; do not redesign to fix it.
- **One concern.** Screen PRs and server PRs are separate unless the screen cannot work without the server piece.
- **Behind the new-interface switch** (`lib/newInterface.ts:11`, house workspace only). No customer sees anything until the owner flips it.
- **Server PRs** put the feature in as a tool first, with a mocked test proving an agent can run it (rule 11). The registry the rule names does not exist as code yet; each PR logs its gap, as the "/" skills do (`lib/v12/skills.ts:1-10`).
- **Mocks only.** No paid generation, ever (rule 1).
- **Each screen PR deletes** the old files it replaces and removes the guard ratchet entry for them (owner, 14 Oct 21:55: "each entry is removed in the PR that rebuilds its screen").

### Phase 0: the foundation (lane C, tonight)

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 1 | **App frame:** shared top bar, board second row | screen | the board header in `components/v12/shell/Header.tsx` and the board's header row | M | no | none |
| 2 | **The card:** five statuses, ✓ ✕ on hover, title row, tile rule | screen | card faces and status chips (`components/graphite/board/BoardNode.tsx`, `components/v12/rounds/RoundBadge.tsx`) | M | no | none |
| 3 | **The rail:** 116 px stepper | screen | `components/v12/board/StageRail.tsx` | S | no | none |

### Phase 1: slice 1, Shots in both modes

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 4 | **Board data for v25:** Film's ten steps with a saved-rail upgrade; per-step setup and per-card overrides in the draft; the mode, kept per person per board | server (pure, no database) | the stage lists in `lib/v12/board/stages.ts` | M | no | none |
| 5 | **✓ and ✕ on takes:** the five statuses read from takes, ✓ is today's approve, ✕ is today's reject with the Shots reason list | screen + small server | `RejectPanel.tsx` chips on v25 boards | M | **privacy** (who approved, shown by name) | #723, #726, #740; PR 4 |
| 6 | **Preview everywhere:** versions strip, Compare, ✓ ✕, Download, tabs, waveform | screen + a read for a card's versions | the Inspector's preview buttons; extends `components/PreviewLayer.tsx` | L | no | PR 2, PR 5 |
| 7 | **Director on Shots:** settings column, pop-ups, chips, scope pill, bottom bar, Making…, Next | screen | `BoardBar.tsx` and `BoardTools.tsx` on v25 boards; the Inspector's take settings | L | **money** (the bar is a spend button) | PR 1 to 6 |
| 8 | **Agent on Shots:** chat as the screen, step chips, plan card, progress, hand-off, ✕ gives a priced reply | screen + server | `BoardAgentPanel.tsx` on v25 boards | L | **money** (plan approval, planning turn) | PR 4, 7 |
| 9 | **Auto never names its pick, Pro pick:** the model pop-up; "Why this?" in craft words | screen + server | the model menu on v25 boards | M | **money** (price shown, plan gating) | PR 7 |
| 10 | **Five-minute test for v25:** a new person from invite to an approved render, in either mode | tests | the v14 journey (guard rewrite) | S | **guard change** (owner's word) | PR 7, 8 |

### Phase 2: slice 2, the steps before Shots

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 11 | **Brief and Script cards** (text steps), Script's three-tab preview, Story, Plan, Brand kit settings | screen | the Brief and Script stage contents | M | no | PR 2, 4 |
| 12 | **✓ and ✕ on text cards:** Brief, Script, Treatment pages, in the draft | screen + small server | none today | S | no (draft JSON); an audit trail would be a migration, see question 4 | PR 11 |
| 13 | **Read-through:** a timed voice read of the script with the cast voice | server (tool) then screen | none | M | **money** (priced per character) | PR 11; **engine: ElevenLabs, Sarvam** |
| 14 | **Cast:** character cards, Look, Wardrobe, Sheet; the voice card; "Consent on file" | screen | `components/graphite/production/CastIdentities.tsx` (ratchet entry) | L | **privacy** (faces, voices), **money** (identity training) | PR 7 |
| 15 | **Character sheet tool:** 8 angles as one priced recipe | server (tool) | none | M | **money** | PR 14; **engine: BFL FLUX.2, Nano Banana; consent #771** |
| 16 | **Locations:** the new step, Live location photos, coverage | screen + small server | the environment half of Elements | M | no | PR 4, 7 |
| 17 | **Elements:** product, props, set and graphics; the exact-pack lock | screen | the Elements half of the Cast stage | M | no | PR 16 |
| 18 | **Storyboard:** styles, panels per shot, board sheet, import | screen + small server | the Storyboard stage and `DrawStoryboard.tsx` | L | **money** (draws are spend buttons) | PR 7; **engine: Recraft, GPT Image, Nano Banana, Chromium PDF** |
| 19 | **Agent mode on steps 2 to 7:** the step questions and plan cards | screen + server | none | M | **money** | PR 8, 11 to 18 |

### Phase 3: slice 3, Edit and Deliver (Film)

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 20 | **Timeline lens:** frames timed from the script, replaced by shots as they render; no engine needed to draw it | screen | the disabled "Strip" (`components/v12/board/BoardTools.tsx:72`) | M | no | PR 6, 13 |
| 21 | **Assembly engine:** one tool that cuts a timeline of frames, shots, voice, music and captions into an MP4, on the Remotion worker | server | the browser export as the only path (`lib/workbench/render-movie.ts`) | L | **env** (worker, switch), **money** (voice, music) | #700 (deploy #4, off); 4.x pin; **the Remotion worker is Slice 1: #697, #699, #700, #768 to #773** |
| 22 | **Edit step:** cut, voice, music, titles, subtitles, grade; the animatic first | screen + server | cut cards, `components/workbench/MovieExport.tsx` (ratchet entry) | L | **money** | PR 20, 21 |
| 23 | **Deliver step:** versions grid, cutdowns, 4K, fps, dubs, Download all (zip) | screen + server | `components/v12/board/DeliverStage.tsx` | L | **money**, **env** | PR 21; **engine: Remotion cutdowns, ProRes, conform, zip; MediaConvert Smart Crop** |

### Phase 4: slice 4, Social narrated

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 24 | **Hook:** options as cards, ✓ picks one | screen + server (priced text tool) | the Hook stage | M | **money** | PR 12 |
| 25 | **Voice step** (narrator, language, speed, music bed) on the new card | screen | `components/v12/board/social/VoiceStage.tsx`, `components/workbench/SoundGenerate.tsx` (ratchet entry) | M | no | PR 2 |
| 26 | **Captions:** word-by-word, line, karaoke, position, languages | server (tool on the assembly engine), then screen | none | L | **money**, **env** | PR 21; **engine: Remotion karaoke captions, #769** |
| 27 | **Social narrated Deliver** | screen | the Social Deliver stage | S | no | PR 23, 26 |

### Phase 5: the rest of v25

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 28 | **Treatment deck:** 12 pages, Routes, key frames, then the Mood film | server (tools) then screen | the empty Treatment step | L | **money** | PR 12, 21; **engine: Chromium PDF, #767** |
| 29 | **Campaign:** Pitch deck, Look, Formats, Variants | screen + server | `components/graphite/business/FormatTool.tsx` (ratchet entry), the Campaign stages in `components/v12/board/campaign/` | L | **money**, **privacy** (talent swaps) | PR 28 |
| 30 | **Social clips:** Source, Moments, Clips, languages | server (tools) then screen | the Clips stage | L | **privacy** (third-party media), **money**, **env** | PR 21, 26; **engine: Gemini 3.x moments, Remotion silence cuts** |
| 31 | **Pre-vis:** Animatic and the PPM deck | screen + server | `components/v12/board/PpmStage.tsx` | M | **money** | PR 21, 28; **engine: Remotion animatic, Chromium PDF** |

### Phase 6: the app screens around the board

| # | PR | Kind | Replaces | Size | NEEDS AKSHAY | Depends on |
|---|---|---|---|---|---|---|
| 32 | **Home on the shared bar:** the wall, Your boards, the waiting strip | screen | `components/v12/home/V12Home.tsx` parts | S | no | PR 1 |
| 33 | **Sharing screens:** the share submenu, the card state icon, who is editing, the changed-since bar, Move this board, All boards, the admin view bar | screen | the parked sharing UI | M | **privacy** | deploy #4 (#702, #704, #708, #715, #718) |
| 34 | **Trash and Remove with Undo** on the new card | screen | `#707` (parked) | M | no | #698 (deploy #4), PR 2 |
| 35 | **Phone: Agent on phone** (only if the owner wants it, question 8) | screen | none | L | no | PR 8 |
| 36 | **v25 for everyone, and delete the old design** | screen + tests | `components/v12` pieces, `lib/newInterface.ts`, the ratchet entries that remain | M | **guards, privacy, all five** | the owner's 7-day rule |

### Which ratchet entries each PR retires (owner, 14 Oct 21:55)

A best guess, to be confirmed in each PR. All 11 expire 30 Nov 2026.

| Entry | Retired by |
|---|---|
| `components/graphite/production/CastIdentities.tsx` | PR 14 |
| `components/workbench/MovieExport.tsx` | PR 22 |
| `components/workbench/SoundGenerate.tsx` | PR 25 |
| `components/graphite/business/FormatTool.tsx` | PR 29 |
| `components/workspace/GenerateComposer.tsx`, `components/workbench/GenerationDialog.tsx` | PR 36, or an earlier Make composer PR (risk 2) |
| `components/graphite/SuitesShell.tsx`, `components/studio/StudioNavigation.tsx` | PR 36 |
| `components/graphite/atomik/MemoryView.tsx`, `components/workbench/AtomikRunDialog.tsx` | PR 36 |
| `components/marketing/HeroPrompt.tsx` | a marketing-site PR, not in this plan |

PR 36 holds six entries, which is the risk in question 2.

### Tests and Playwright widths

**Standard for a screen PR:**
- Desktop specs at the **five viewports of the owner's 22:30 rule: 1280×800, 1440×900, 1728×1117, 1920×1080 and 2560×1440** (the earlier three-width standard is replaced). No horizontal overflow; the primary action reachable without panning; no whitespace stranded above 1600 px, and at 2560×1440 the canvas scales up with no dead space below the cards (rule 7).
- Phone specs at **360×640, 390×844 and 844×390** prove the phone app is unchanged with the switch on. The new frame is desktop only (`docs/redesign-plan.md`, "Out of scope: signed-in phone screens"); rule 7 asks for more, see question 8.
- Guards that must stay green: spend-buttons (every spend button carries `data-spend` and shows its price), UI names, one-design, tooltip audit (every icon has a tooltip), text at 12 px and above and at least 55% white (rule 15), focus rings, touch targets.
- One filled button per screen (rule 13; the README says the same).

**Standard for a server PR:** unit specs with mocked engines (`ENGINE_MOCK=1`), a tenant isolation case (a second workspace gets nothing), a "person only" case where approval is involved, and a quote-equals-charge case where money is involved.

**Specific tests worth naming**
- PR 4: a saved rail written before this change opens with Edit where Cut was, and gains the new steps (see risk 1).
- PR 5: ✓ is refused for a token, an MCP caller and an `agent:` id (rule 14, #723). ✕ writes a closed-list reason.
- PR 6: Compare shows two takes of one shot; ✓ in the preview equals ✓ on the card.
- PR 7: the bar's price equals the server's quote for the exact request; the button is the only filled one; Cancel appears only while the provider still holds the job in its queue (question 9).
- PR 8: the plan card total equals the sum of its steps; the third fix on a shot asks again (`lib/workbench/plan-approval.ts:28`); Atomik cannot press Approve.
- PR 10: the walk from an invite to an approved first render, with time recorded as timing only (rule 17).
- PR 21: the worker gets inputs by file, never a URL; the job is idempotent; the fair queue limits hold.

---

## 4. No API or provider behind it today

Each row is a v25 element I could not find a working server path or provider for on release/1. "Needs" is the smallest honest thing that would make it real.

### Update, 15 Oct 2026, 22:15: what the final engine stack now provides

The owner approved a FINAL ENGINE STACK and its order (`docs/redesign-plan.md`; `docs/plans/provider-adapters.md`, "Where this stands"). Each engine is its own PR, NEEDS AKSHAY, behind its own switch, on for the house workspace and listed workspaces only. **Nothing here is live and no paid run happens before the team tests with the owner.** The rows below keep their 15 Oct text; each now ends with a "Final stack" note where the stack gives it an engine.

| v25 need | Engine in the stack | Slice |
|---|---|---|
| Lip-sync | sync.so (lipsync-2-pro; sync-3), behind the Rekognition consent match (#771) | 2 |
| Voices, dubbing | ElevenLabs (live); Sarvam Bulbul, Saaras and dubbing | 2 |
| Captions, animatic, timeline, titles, subtitles, narrated assembly, cutdowns, silence cuts, fps conform, ProRes, stems, Download all | The Remotion + ffmpeg worker (#697, #699, #700, #768 to #773) | 1 |
| Decks: treatment, pitch, PPM | Chromium PDF on the same worker (#767) | 1 |
| Storyboards and brand assets | Recraft V4.1 and V3, GPT Image 2.5, Nano Banana Pro and 2.1 | 3 |
| Reframe | AWS MediaConvert Smart Crop (replaces Luma reframe) | 2 |
| Label check and text lock-up check | Google Cloud Vision with an exact text diff | 3 |
| Moments, cutdown planning, the vision judge | Gemini 3.x | 3 |
| Identity | Black Forest Labs FLUX 3 and FLUX.2 (replacing fal flux-lora); the consent match first | 2 |
| Pro pick | Seedance 2.5, Veo 3.1, Kling 4.0, Runway Gen-4.5 (names in config) | 2 and 3 |

Still with no provider: voice cloning (not now), speaker tracking for clips, an automatic cutter beyond the planned cutdowns, and any face swap (left out by decision). The consent match refuses every face until the owner picks the reference source (#771), so lip-sync and Act-Two cannot run on real faces yet.

### Board-wide

| v25 element | What exists | What is missing | Needs |
|---|---|---|---|
| Agent and Director modes | A spending setting called Ask and Auto (`lib/atomik.ts:65`) | A board mode, and separate settings per mode | PR 4: a draft field. The code word must not be `agentMode` (risk 3). |
| ✓ and ✕ on text cards (Brief, Script, Treatment pages) | ✓ and ✕ for takes (`take-model.ts:399`; Step 0's events table is keyed by take, #728) | A subject other than a take | Draft marks in v1 (PR 12); a migration only if an audit trail is wanted (question 4). |
| Reason lists per step (about 25 lists) | One list of five chips for takes (`take-model.ts:399`); Step 0 closes that list (#726) | The lists for every other card kind | Extend the closed list with a kind (server, small). |
| Auto never names its pick, "Why this?" | Recipe defaults: draft to cheap engines, hero to dear ones (CLAUDE.md § Pricing). Step 0 labels the take (#724, #729) | A router that picks by shot type | v1: Auto is the recipe default, quoted by the server, "Why this?" is a fixed craft sentence per recipe. A real router is later. |
| Pro pick: Runway Gen-4 and Veo 3 | Kling 3.0 and Seedance 2.0 and 2.5 are in `lib/models.ts` | Runway is not in the product at all (a standby for the house only, #714). Veo is only a retired alias (`lib/models.ts:647`) | Show only engines with a key and a rate-card row. Hide Runway and Veo. **Final stack, 15 Oct 22:15:** the Pro pick menu is Seedance 2.5, Veo 3.1, Kling 4.0 and Runway Gen-4.5, names in config and never in the design; an engine shows only when it has a key, a rate-card row and is on for the workspace (house and listed workspaces until launch). Hide any engine that is not yet wired. |
| "Powered by Runway" on a take | none | the provider | Drop it. **Final stack, 15 Oct 22:15:** Runway is now in the stack (Act-Two, Aleph 2, Gen-4.5). Its terms ask for the line (#714, section 7); the owner decides before Runway is shown to anyone but the house. |
| Pro pick visible only to Business and admins | Plan names are display config; checkout is closed | A plan check on the server | Gate by role (admin) in v1; Business gating waits for checkout (question 6). |
| "Help me write it", "Write it for me" | Enhance (`lib/enhance.ts`) and the shot drafter (`app/api/atomik/shots/draft`) | A priced call wired to each field | One priced text tool; the fields fill visibly before anything is pressed (rule 11). |
| Fix › for text and product elements | Fixes for shots, two per shot in a plan (`plan-approval.ts:28`) | Fix tools for other card kinds | One tool per kind, inside the plan's allowance. |

### Film

| v25 element | What exists | What is missing | Needs |
|---|---|---|---|
| Treatment deck: 12 pages with pictures | A text treatment with versions (`lib/atomikDocs.ts:23`) | Picture pages, **Routes** (two or three directions), **Mood film**, PDF or share output | PR 28. No PDF writer exists (`components/v12/board/PpmStage.tsx:17-18`); a share link can stand in. **Final stack, 15 Oct 22:15:** Chromium PDF on the export worker makes the treatment, pitch and PPM decks (#767, `PDF_EXPORTS`, free; Slice 1). Pictures come from the image engines (Recraft, GPT Image, Nano Banana). |
| Read-through (timed voice read) | Speech from ElevenLabs, priced per character (`lib/elevenlabs.ts:117`) | Per-line timing over the whole script | PR 13. **Final stack, 15 Oct 22:15:** voices: ElevenLabs, and Sarvam (Bulbul) for Indian languages (Slice 2). |
| Cast voice: **Clone (consent)** | Voice library | A cloning provider | Not now (owner, 14 Oct 19:29, #714). Leave the option out. |
| Cast **Character sheet** (8 angles), **Wardrobe** looks, expressions | Identity training with consent (people only) | A recipe that makes N angles | PR 15. **Final stack, 15 Oct 22:15:** Black Forest Labs FLUX.2 multi-reference identity (replacing fal flux-lora) and Nano Banana (Slice 2 and 3); every real face passes the Rekognition consent match first (#771). |
| **Lip-sync** "automatic on dialogue" | none | A provider. sync.so is bought but not built (#714). The old sign-in lip-sync is retired (rule 10). | A provider PR first; out of v1. **Final stack, 15 Oct 22:15:** sync.so direct (lipsync-2-pro; sync-3 for hero and 4K), Slice 2, behind the consent check (#771), which refuses every face until the owner picks the reference source. Still out of v1 for real faces. |
| Locations: **Clean up photos**, coverage angles | Outpaint (`lib/stillTools.ts:10`) | Clean-up; reverse and detail plates | Recipes on image engines. |
| Elements: **Label check** runs by itself | none | A reader that checks a label's text | Google Cloud Vision text detection is in the provider plan (#714; the key is set). Out of v1. **Final stack, 15 Oct 22:15:** Cloud Vision text detection with an exact text diff, never an AI model alone (Slice 3). |
| Storyboard **styles** (Sketch, Ink and wash, Comic, Previs 3D) | Image engines; 3D blocking on our own worker | A style table of prompts | A small table. Board sheet PDF waits for a PDF writer. **Final stack, 15 Oct 22:15:** Recraft V4.1 and V3 draw the sketch, ink and comic styles; GPT Image 2.5 and Nano Banana Pro and 2.1 for the rest (Slice 3; bake-off (a) decides defaults). The board sheet PDF is the Chromium PDF (#767). |
| **Animatic** and the **Timeline** | A browser export, 720p by default, 180 s at most (`lib/workbench/movie.ts:3`) | A server render; the Timeline lens (`BoardTools.tsx:72`, "Not built yet") | PRs 20 and 21. **Final stack, 15 Oct 22:15:** the Remotion worker (animatic, timeline; #697, #699, #700; Slice 1). |
| Edit: auto **Cut** (Tight, Natural, Slow), speed ramps, transitions | Grade (`lib/workbench/color.ts`), loudness | An automatic cutter | Out of v1. Keep a manual timeline. |
| Edit: **Titles**, **Subtitles** burned in | Word timing and SRT from transcripts (`lib/transcription.ts:96`) | Rendering them | Remotion (PR 21). **Final stack, 15 Oct 22:15:** Remotion: titles, karaoke captions, sidecar SRT and VTT (#769). |
| Deliver: **smart reframe** (keep faces and product) | Luma reframe paints the edges of a clip (`lib/models.ts:330`) | Face and product tracking | Out of v1. Offer Centre and Extend. **Final stack, 15 Oct 22:15:** AWS MediaConvert Smart Crop replaces Luma reframe (Slice 2; no PR yet). |
| Deliver: **cutdowns** (15 s, 6 s) | none | An automatic cutter | A person picks shots; the assembly engine cuts. **Final stack, 15 Oct 22:15:** Remotion cutdowns, silence-aware (#773), planned by Gemini 3.x (Slice 3). |
| Deliver: **25 and 30 fps** conversion, **ProRes**, **H.265**, **Stems** | none | A transcoder | On the Remotion worker's ffmpeg, if the owner wants them (question 12). **Final stack, 15 Oct 22:15:** #770 fps conform, #768 H.264 and ProRes 422 (and HQ); DNxHR is a follow-up; stems come from our timeline; H.265 stays off until the owner's lawyer answers. |
| Deliver: **on-screen text translation** | Dubbing (`lib/dubbing.ts:58`) | Translating burned-in text | Out of v1. **Final stack, 15 Oct 22:15:** Cloud Vision reads the text and Sarvam translates it (Slice 2 and 3). Still out of v1. |
| Deliver: **Download all** | A free editorial package (XML, EDL) | A zip of every master | PR 23. **Final stack, 15 Oct 22:15:** the Remotion worker's Download all zip (Slice 1). |
| Deliver: **Send for approval** | Client review links and rounds (`lib/v12/rounds.ts`) | none | Reuse. |

### Campaign

| v25 element | What exists | What is missing | Needs |
|---|---|---|---|
| Pitch deck (10 pages) | none | As the Treatment deck | PR 28. **Final stack, 15 Oct 22:15:** Chromium PDF (#767) with Recraft for brand assets (Slice 1 and 3). |
| Look: key visual, style frames, type lock-up | Look and brand kit (`LookStage.tsx`) | Type lock-up with exact text | A text-in-image recipe and a check. **Final stack, 15 Oct 22:15:** Recraft for the type lock-up, then the Cloud Vision exact text diff (Slice 3). |
| Formats with Fit (Extend or Crop), Banner sizes | Eight format briefs (`lib/v12/campaign.ts`) | Banner sizes; Crop and Extend as one choice | Recipes. |
| Variants: audiences × headlines × languages × count | none | The matrix tool (placeholder 24 cr) | One priced tool with a ceiling. |
| Variants: **Talent swaps (consent)** | Consent records (`lib/security/consent.ts`) | A swap tool | Out of v1; privacy review first. **Final stack, 15 Oct 22:15:** any face swap built on InsightFace is left out by the owner's decision; a swap would also need the consent match (#771). |

### Social, narrated

| v25 element | What exists | What is missing | Needs |
|---|---|---|---|
| Narrated video from a script | "Not in Particl yet" (`components/graphite/board/social/index.ts:13`) | The assembly | PR 21. **Final stack, 15 Oct 22:15:** Remotion narrated assembly (voice lines and ducked music, #772; Slice 1). |
| Hook options (question, bold claim, visual surprise) | Atomik text | A priced hook tool | PR 24. |
| Voice: language, speed, music bed | Speech and music (`lib/elevenlabs.ts:80`) | none beyond the card | PR 25. **Final stack, 15 Oct 22:15:** ElevenLabs and Sarvam (Slice 2). |
| Captions: word-by-word, karaoke, emoji, languages | Word timing (`lib/transcription.ts:96`) | Style and burn-in | PR 26. **Final stack, 15 Oct 22:15:** Remotion karaoke captions (Slice 1). |
| Thumbnails | none | A still recipe | Small. **Final stack, 15 Oct 22:15:** Recraft or Nano Banana stills (Slice 3). |

### Social, clips

| v25 element | What exists | What is missing | Needs |
|---|---|---|---|
| Source from a **link** | Upload; transcription (`app/api/audio/transcribe`) | A fetch of third-party media from a URL | Needs a legal and safety look first (question 11). |
| **Moments** (rank by hook, emotion, topic) | Transcripts | A tool that reads the transcript | One priced Atomik text tool. **Final stack, 15 Oct 22:15:** Gemini 3.x reads the transcript for moments (Slice 3). |
| **Clips**: keep the speaker in frame, cut silences, b-roll, intro and outro | none | Speaker tracking and a cutter | A provider or the Remotion worker; the speaker tracking has no provider today. **Final stack, 15 Oct 22:15:** silence cuts on the Remotion worker (#773); speaker tracking still has no provider. |
| **Make in other languages** | Dubbing | The step wiring | Reuse. **Final stack, 15 Oct 22:15:** Sarvam dubbing (Indian languages) and ElevenLabs dubbing (Slice 2). |

### Pre-vis

| v25 element | What exists | What is missing | Needs |
|---|---|---|---|
| Animatic MP4, PPM deck PDF | The deck and shot list on screen, CSV (`lib/v12/ppm.ts`) | The MP4 and the PDF (`PpmStage.tsx:17-18`) | PR 21 for the MP4; a PDF writer for the deck. **Final stack, 15 Oct 22:15:** the MP4 from the Remotion worker (Slice 1) and the PDF from the Chromium PDF (#767). |

---

## 5. The two carry-ins

### 1. The Brief card shows the brand tile twice

**What happens in the prototype.** A text card for Brief or Script draws the brand tile in its title row (16 px) and a second tile in the bottom-right corner (22 px). The first is always there. The second is added by `smallTile`, which the board code sets for text cards on the Brief and Script steps. Other text-only cards get one large tile instead, never two.

**Rule for the build.** A card shows its brand tile **once**: in the title row of a text card, and as the large centre tile only when the card has no picture and no text. Drop the corner tile.

**Where it goes.**
- **PR 2 (the card)** owns the rule, so it is true on every step. Test: a Brief card and a Script card, with a logo and without, render one tile each.
- **PR 11 (Brief and Script cards)** repeats the test on the real cards.

### 2. Home's sample counts and tabs must match the board's

**What happens in the prototype.** Home lists four sample boards, each with a kind and a count typed in by hand. The board file's tab strip lists only two boards. So the two screens do not show the same boards, and the counts are not read from anything.

**Rule for the build.** In the product the numbers cannot differ, because Home, the tab strip and the rail read the same data: the board list (`components/v12/home/YourBoards.tsx`), the open tabs (`components/v12/shell/use-board-tabs.ts:7-11`, kept per scope) and the rail's status (`lib/v12/board/stages.ts`). The carry-in is a **test and a fixture**, so the design and the build stay honest.

**Where it goes.**
- **PR 1 (the frame)** makes the tab strip and the second row read one source. Test: for one seeded board, the tab, the Home card and the breadcrumb show the same name and the same kind.
- **PR 32 (Home)** adds the count: the Home card's line ("8 shots · 3 ready") equals the number the board's own rail and Shots step show for that board.
- The prototype's own Home sample lines are fixed in the next design round (a note for the owner's design file, not a build task).

---

## 6. Lane C's foundation PRs

Lane C is building tonight, behind the switch, with screenshots at 1440, 1280 and 1920 and an Opus review. They are **PR 1 to PR 3**, and nothing else in this plan starts before them. None needs the server.

| Lane C's PR | In this plan | What it must also do so slice 1 fits |
|---|---|---|
| The top bar and app frame | **PR 1** | Read the open tabs and the board list from the existing sources (carry-in 2). Keep today's behaviour of Activity (`components/v12/shell/Activity.tsx`), ⌘K, ⌘J and the account menu. Draw the Agent and Director switch and the lens switch, but leave the switch inert and hidden until PR 4 gives it state. |
| The card with five statuses and ✓ ✕ | **PR 2** | Take its status as data (not hard-coded per kind), so PR 5 can feed it. Show one tile (carry-in 1). Show ✕ with the reason text from today's reject note until #740 merges. User-owned cards show no ✓ ✕. Making… is today's render state (`components/v12/render`). |
| The stepper rail | **PR 3** | Read its steps and labels from `lib/v12/board/stages.ts`, never from a list of its own, so PR 4 can add Treatment and Locations and rename Cut to Edit without touching the rail. 116 px, one line per step, the status line wrapping to two. Keep drag to reorder, rename, skip and "+ Stage". |

After they land, PR 4 to PR 10 are the slice. They can be built in parallel by two lanes in this order: lane 1 does PR 4, 5, 6, 10; lane 2 does PR 7, 8, 9 once PR 4 and PR 5 are in.

---

## 7. Risks and owner questions

Numbered. Each has a recommendation.

1. **Saved rails will lose stages when stage ids change.** `stagesOf` drops any saved id the code no longer knows (`lib/v12/board/stages.ts:123`). Renaming Cut to Edit would make a board that saved its rail lose its Cut stage. A saved rail also never gains a new built-in stage such as Treatment or Locations.
   *Recommendation:* PR 4 adds an alias (`cut` reads as `edit`) and appends missing built-in stages at their usual place unless the person skipped them. A test covers it. No data is rewritten.

2. **Guard dates.** Eleven screen entries expire on 30 Nov 2026 (owner, 14 Oct 21:55). Six of them ride on PR 36, the last PR.
   *Recommendation:* make PR 36 smaller by moving the Make composer rebuild (`GenerateComposer.tsx`, `GenerationDialog.tsx`) into a PR of its own, not yet in the table, and schedule it before 15 Nov. If any entry is still there on 25 Nov, I will say so on the status page so you can decide before it fails CI.

3. **Name collision: Agent mode against Atomik's Ask and Auto.** Today `AgentMode = "ask" | "auto"` is a spending setting (`lib/atomik.ts:65`; rule 14). v25's Agent and Director is a different thing: how a board is worked.
   *Recommendation:* name the code `boardMode: "agent" | "director"`; leave Ask and Auto in Spending rules. The UI words stay Agent and Director. A test in the UI-names set keeps the two apart.

4. **Where ✓ and ✕ live on cards that are not takes (Brief, Script, Treatment pages).** Step 0's events table is keyed by take (#728, a migration in deploy #4).
   *Recommendation:* in v1 keep these marks in the board's draft JSON (no migration, no audit trail). If you want a full trail for text approvals, add a second small migration after deploy #4 settles.

5. **Agent mode and the cost of Atomik's thinking.** The prototype shows Atomik's replies as free. The code bills a planning turn (rule 14; `BoardBar.tsx` says "up to N cr", and the prototype's "Ask · free" is not what the code charges).
   *Recommendation:* the two quick questions per step are fixed chips drawn from the step's settings, so they cost nothing and call no model. The plan card's price is the server's quote. Only a free-text reply calls the model, as a planning turn with "up to N cr" and the limit approved when asking, as today.

6. **Pro pick and plan gating.** The prototype shows Pro pick to "Business and admins". Plans are display config only; checkout is closed (owner, 11 Oct). Runway Gen-4 and Veo 3 are not products.
   *Recommendation:* v1 shows Pro pick to workspace admins only, lists only engines with a key and a rate-card row (Kling 3.0, Seedance 2.0 and 2.5), and hides Runway and Veo. Business gating comes with checkout.

7. **"Next →" and "Looks good, next" approve every Ready card that is not ✕.** That is one tap approving many takes. Approving a take is people-only (#723).
   *Recommendation:* yes, but the button says how many ("Approve 6 · Next: Edit →"), it skips any card that is ✕, failed or still Making, and Atomik, tokens and MCP cannot press it. Approving is not spending, so it needs no price, but the approval is written with the person's name.

8. **Phone.** Rule 7 asks for five widths and says mobile is where work is judged. The v25 board is a desktop design, and the redesign plan keeps today's phone app (owner, 10 Oct: "signed-in phone screens out of scope").
   *Recommendation:* keep PhoneApp for now. Agent mode is the natural phone mode (a chat, a plan card, Approve, Compare), so plan PR 35 after slice 1 and ask for your word then. Every screen PR runs the phone widths only to prove the phone is unchanged.

9. **Cancel while Making.** The prototype shows "Making… · Cancel" for the whole render. The owner's rule is that Cancel appears only while the provider still holds the job in its queue (10 Oct decision 4; #639 option A).
   *Recommendation:* keep your rule. The button reads "Making…" with a small "Cancel" only in the queued state, and never says "nothing billed" before the provider confirms.

10. **Prices.** The prototype's numbers are placeholders: 2 cr a storyboard panel (the rate card says 1 cr for a standard still), Final 43 cr, Draft 7 cr, Pro pick 7, 43, 40 and 60 cr.
    *Recommendation:* no number appears in a screen. Every price comes from the quote; where a tool has no quote path it reads "quoted" (the 10 Oct exception, listed in `docs/redesign-progress.md`). Every PR marked money in section 3 gets an Opus money review.

11. **Source from a link (clips).** Fetching someone else's video from a URL has copyright and safety questions, and an SSRF risk on our server.
    *Recommendation:* ship Upload only first. Add Link after counsel and a design for the fetch (an allow-list, a size and time limit, and no redirects to private addresses).

12. **Remotion carries a lot.** The animatic, titles, subtitles, captions, cutdowns, versions and the final MP4 all need the worker (#700, off today). The licence is the Free License at three people; at four the Company License must be bought, and it is pinned to 4.x (owner, 13 Oct). It runs on the same droplet as production.
    *Recommendation:* make the worker switch-on in a test workspace the gate for slices 3 and 4, and measure one real 30 s 1080p export before we promise "Download all". Keep ProRes, H.265, stems and fps conversion out of v1 unless you want them.

13. **Everything that needs a migration waits for deploy #4's backup.** #702, #698, #718, #700, #728 and #731 are migrations. The screens PR 5, 33 and 34 and the Edit and Deliver steps depend on them.
    *Recommendation:* build the screens now (house workspace only, switch on), and let them go live only after deploy #4 is checked, which is already the plan.

14. **Parked board PRs.** #709 and #711 (four lenses), #707 (remove on the board) and the sharing screens were parked by the design freeze.
    *Recommendation:* close #709 and #711 as superseded by v25's rule that every lens shows the same content (built into PRs 2, 6 and 20). Fold #707's Trash-first removal into PR 34, and the sharing screens into PR 33. Say the word and the lead closes them.

### One more thing to know

The v25 design must replace v15 in `design/` and the one-design guard (#746). That is a design-files PR, not part of this plan, and it merges on green and an Opus review (owner, 15 Oct 00:15).

---

*Sources.* v25: `~/lead-notes/v25-unzip/particl-prototype-25` (README, CHANGES, board and app sources). Decisions: `docs/redesign-plan.md` on `redesign/integration`. Step 0 data: #712 and the open PRs #723 to #732 and #740. Providers: #714. Vercel out: #719. Remotion: `docs/plans/remotion.md` on `redesign/integration` and #700. Sharing: `docs/plans/board-sharing.md` on `redesign/integration`.
