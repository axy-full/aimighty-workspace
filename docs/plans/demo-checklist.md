# Investor demo, 31 Oct 2026: the checklist

**Draft, 16 Oct 2026. Docs only.** For the owner's 12:15 note (investor demo, 31 Oct) and `docs/plans/demo-31oct-plan.md`. Facts come from the repo, that plan, the v25 build plan (`docs/plans/v25-build-plan.md`), `docs/plans/remotion.md`, `docs/plans/provider-adapters.md` and the test scripts. **Anything not in those sources is marked UNKNOWN** and listed at the end. Screens are described as designed in v25 and the plan; the shipped screens are the screen PRs, so each "expected screen" is checked against the build on 29 Oct.

**The demo story:** one 30 s ad, brief to final film, in English and Hindi, in the new design on the house workspace: Home → new project → the board in Agent and Director (Pitch, Brief, Script, Cast, Storyboard, Shots) → the lip-synced Hindi version → export the MP4 and the Treatment/Pitch deck PDF. Also on the path: pricing page, credits, project spend and client review links in the new design; Stripe test-mode checkout only if the owner's Stripe account allows it.

**Dates** (as re-dated in `docs/plans/demo-31oct-plan.md` after the owner's 12:20 answers): Fri 23 Oct the full path is live on the house workspace; Sat 24 to Mon 26 Oct the team makes the film (the Hindi test clip first on Sat 24 morning); **Tue 27 Oct feature freeze, fixes only after it, and the fallback project is made**; Wed 28 to Fri 30 Oct rehearsal and fixes; Sat 31 Oct the demo.

## 1. The machine and the browser (owner fills in)

| Item | What | Status |
|---|---|---|
| Machine | The owner's own laptop, charged, sleep and screen lock off, notifications off, a second device signed in as backup | UNKNOWN which machine |
| Display | Tested sizes are 1280×800, 1440×900, 1728×1117, 1920×1080 and 2560×1440 (owner's 22:30 rule; the D-6 demo test runs at 1440 and 1920). Pick one and rehearse on it. Above 1440 the board canvas scales up; the bars stay normal size | UNKNOWN which display or projector and its resolution |
| Browser | A current desktop browser, one profile, extensions off, zoom 100%, signed in a day early. The renders happen on our servers, not in the browser | UNKNOWN which browser (the repo's tests run Chromium) |
| Files | A local folder with the offline MP4s and PDF (`demo-fallback.md` section 5) and a player that opens them without the network | to be made on 27 Oct |
| Screen | Mirror or extend decided at the venue; a test run on the actual screen on Fri 30 Oct | UNKNOWN venue |

## 2. Account and workspace

- **Workspace:** the house workspace (`ws_legacy`, `lib/houseWorkspace.ts`). The new interface is on for it automatically (`lib/newInterface.ts`); no customer workspace sees it.
- **Account:** the owner's. One admin and the rest members for the team (invites: `docs/plans/test-scripts/aimighty-invites.md`). The role "Admin" matters for the money rules below: only an admin changes the spending setting or the budget ceiling.
- **Signed in the day before** on the demo machine; if the workspace requires an authenticator, have it ready (UNKNOWN whether it does).
- **Sample production:** the project for the demo is created on stage ("New project") but the fallback project, "Demo (fallback)", is already in the board list (`demo-fallback.md`).

## 3. Switches that must be on (all are the owner's; none is on today)

An engine is on only for the house workspace and any workspace listed in the site setting `enginesOnWorkspaces`, and only when its own switch is exactly `1`. Names are from `docs/plans/provider-adapters.md` section 9 and the demo plan. The owner deploys and sets each; nothing else is needed from the team.

| Needed for | Switch (Coolify) | Plan | State |
|---|---|---|---|
| Seedance 2.5, Nano Banana Pro, ElevenLabs English voice, Kling 3.0 Pro (stands in for 4.0) | none; live today | | live |
| Nano Banana 2.1 | `NANOBANANA21_ENABLED` | deploy #6 | off until deployed |
| Veo 3.1 | `VEO_ENABLED` | deploy #6 | off |
| Recraft (storyboard styles) | `RECRAFT_ENABLED` | deploy #6 | off |
| BFL FLUX.2 and identity (Cast) | `BFL_ENABLED`, `BFL_IDENTITY_ENABLED` | deploy #6 | off |
| Sarvam (Hindi translation and voice) | `SARVAM_ENABLED` (and `SARVAM_USD_PER_INR` set) | deploy #6 | off |
| sync.so (Hindi lip-sync) | `SYNC_ENABLED` | deploy #6 | off; house only |
| Remotion export (MP4) | `REMOTION_EXPORTS`, plus `REMOTION_WORKER_URLS` and `REMOTION_WORKER_SECRETS` and the worker stack behind its relay | deploy #6 and the worker by Mon 19 | off |
| Chromium PDF (decks) | `PDF_EXPORTS` | with the worker | off |
| Pro pick (Seedance 2.5, Veo 3.1, Kling 4.0 → 3.0 Pro) | config (`lib/proPick.ts`), no env | deploy #6/#7 | |
| House $500 monthly cap, 80% warning | none (#765) | deploy #6 | needs the stored `allowance_usd` read first |
| The new-design screens | none (house workspace) | deploys #7 and #8 | |
| Kling 4.0 | `KLING4_ENABLED` (inert; not on fal) | when fal lists it | the demo uses Kling 3.0 Pro |

**Not on the demo path (do not rely on them):** Runway, MediaConvert, Topaz direct, the Cloud Vision label check, Gemini 3.x, DNxHR, the "Approve at N cr" screen, cutdowns and the zip.

Switch check on Wed 28 Oct (the first rehearsal day) and Fri 30 Oct: open each step below once on the real workspace and see its engine answer (a price on the button, no "not set up" message).

## 4. Network

- **Wired connection or a phone hotspot as the second path.** Test both on 30 Oct.
- The app needs outbound access to the engines (all called from our server, not the browser): BytePlus Seedance, Google (Gemini, Veo), BFL (EU endpoint), Recraft, Sarvam, sync.so, ElevenLabs, fal. The browser needs only particl.si. UNKNOWN whether the venue filters anything.
- **Never wait on the network on stage:** any step that depends on a render uses its pre-rendered result (section 6).
- Provider result links expire (for example BFL 10 minutes, Runway 24 to 48 hours); our adapters copy the output at once, so a saved take stays playable. The pre-rendered project depends on this; `demo-fallback.md` checks it.

## 5. Money and safety before the day

- **Credit balance** covers the live steps with room (UNKNOWN the amount; check on 30 Oct). Top-ups, spend limits and the budget ceiling are a person's alone and an admin's.
- **House cap:** $500 a month engine cost, warning at 80% (#765, once deployed). Check October's usage on 30 Oct and that the cap has headroom for rehearsal and the demo.
- **No surprises on stage:** do every paid step live only if its price is read out and its result is already known (rehearsed); otherwise show the pre-rendered take.
- Health: signed in as the owner, `/api/health` shows no at-risk takes (`videosAtRisk` 0, and nothing "lost" in the project).

## 6. The steps: expected screen, time, fallback

Time budgets are **proposals**: the demo's length is not recorded in the plan (UNKNOWN). The proposed total is about 14 minutes of talking with every heavy step shown from a finished result. The one measurement we have is a 30 s 1080p export on our server: 163 to 270 s wall at concurrency 3 to 1 under load (15 Oct), so an export is never waited for on stage.

| # | Step | Expected screen | Budget | Live or finished | Fallback if it fails |
|---|---|---|---|---|---|
| 1 | **Home** | Home on the shared top bar: your boards, the "N need you · N running" pill, credits | 0:45 | live | Open "Demo (fallback)" from the board list and begin at step 2 |
| 2 | **New project** | "New project" opens a board with the demo steps (Pitch, Brief, Script, Cast, Storyboard, Shots, Edit, Deliver) in Agent mode | 0:45 | live | Same: the fallback board already has every step |
| 3 | **Pitch** | The Pitch step (a deck made from the board, Treatment-style cover or Pitch cover); the PDF is made from the board later | 1:00 | finished PDF shown; the button explained | Open the offline PDF from the local folder |
| 4 | **Brief** (Agent) | Atomik asks two quick questions per step as chips; the brief card shows Ready, then ✓ | 1:00 | live (text step, cheap) | The fallback board's approved Brief card |
| 5 | **Script** (+ Hindi) | Script card with Script, Beats and Breakdown tabs; the Hindi script from Sarvam translate shown beside it | 1:30 | English live; Hindi shown finished | The fallback board's Script and Hindi script |
| 6 | **Cast** | Character cards (Look, Wardrobe, Sheet); AI-made characters, no consent step (owner question 3 in the plan: UNKNOWN if a real person is cast) | 1:30 | finished characters shown; one live look change only if rehearsed | Fallback Cast cards |
| 7 | **Storyboard** | Panels in a chosen style (Recraft sketch, ink or comic; Nano Banana; GPT Image) | 1:30 | finished panels | Fallback Storyboard cards |
| 8 | **Shots in Agent** | A plan card ("Render N shots · N cr · Approve"), progress with Cancel, then "Go to Edit" | 1:30 | plan card live and priced; the render shown finished | Fallback Shots, all ✓ |
| 9 | **Shots in Director** | A left stepper rail, a scope pill ("Shot 4"), a right settings column, a bottom bar with one filled button ("Render 8 shots · N cr", then "Making… · Cancel"); the model pop-up with the Pro pick | 1:30 | settings live; render shown finished | Fallback Shots in Director |
| 10 | **Preview, versions, Compare, ✓ ✕** | Preview with a versions strip, Compare, ✓ and ✕ | 1:00 | live on finished takes | Fallback takes |
| 11 | **Hindi lip-synced version** | One tool: translate → Hindi voice lines → lip-sync each shot → a Hindi cut; one price, one approval | 1:30 | finished cut played | The offline Hindi MP4 |
| 12 | **Export MP4** (English and Hindi) | Edit then "Export MP4": Queue line, Rendering, Saving, Ready; Free | 1:00 | finished MP4 played | The offline MP4s |
| 13 | **Deck PDF** | The Treatment/Pitch deck PDF opens | 0:30 | finished PDF | The offline PDF |
| 14 | **Money** | Credits and project spend in the top bar and board; the pricing page; a client review link from a take or cut (Stripe test-mode checkout only if allowed) | 1:00 | live (no spend) | Screenshot of each, in the local folder (to be taken on 30 Oct) |

If a live step misbehaves: say what it is, open "Demo (fallback)" at the same step, continue. Do not retry a paid step on stage.

## 7. Day-of order

1. **T-1 day (30 Oct):** full run on the demo machine and the venue network or hotspot; switch check (section 3); balance and cap check (section 5); offline folder verified; backup device signed in; fallback project opened step by step.
2. **T-1 hour:** charge, sign in, close everything else, open the board list, play both MP4s and open the PDF locally once.
3. **During:** follow section 6; keep a running note of anything that went wrong for the daily report.
4. **After:** nothing is deleted; file problems on the test board.

## 8. UNKNOWN, to be filled in

- The machine, display, browser, venue network, demo length and audience size.
- The brief for the 30 s ad, the shots and the Hindi lines (the team's script, `test-scripts/demo-film.md`).
- Whether the cast is AI-made or a real person (plan owner question 3).
- Whether the Stripe account allows test mode (plan owner question 1).
- Whether "Duplicate board" exists in the shipped v25 build (`demo-fallback.md`).
- The exact shipped screens and labels (checked on 29 Oct).
