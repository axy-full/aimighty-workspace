# Investor demo, 31 Oct 2026: the path and its dated PR list

Written by the lead, 16 Oct 2026, for the owner's 12:15 note (verbatim in `docs/redesign-plan.md`). This replaces `docs/plans/dated-plan-16oct.md` until 31 Oct. **Anything not on this list waits until after 31 Oct.**

**The demo:** one 30 s ad, brief to final film, in English and Hindi, in the new design on the house workspace.
1. Home → new project.
2. The board in Agent and Director: Pitch, Brief, Script, Cast, Storyboard, Shots.
3. A lip-synced Hindi version.
4. Export the MP4 and the Treatment/Pitch deck PDF.

Also on the path: pricing page, credits, project spend and client review links in the new design; Stripe checkout in test mode only if Stripe's invite allows it.

**Key dates**
- **24 Oct:** every engine below is live on the house workspace and the path works end to end. The team makes the film 24–27 Oct.
- **28 Oct:** feature freeze, fixes only after it.
- **29–30 Oct:** rehearsal and fixes.
- **31 Oct:** the demo.

**Rules unchanged:** each PR is merged into release/1 under the 12:05 standing yes (CI 24/24, fresh Opus approval, no guard loosened). Every deploy is the owner's (backup first). Mocks only in development; the team's real use from 24 Oct is the first paid use, approved step by step in the UI, against the house $500 cap.

## A. Engines on the path (live on the house workspace by 24 Oct)

| Engine | Where it is | What is left | Merge into release/1 | Live (owner deploys, sets switch) |
|---|---|---|---|---|
| Seedance 2.5 | live today | nothing | — | live |
| Nano Banana Pro | live today | nothing | — | live |
| ElevenLabs (English voice) | live today | nothing | — | live |
| Nano Banana 2.1 | #784, approved | CI on release/1 | Fri 16 | deploy #6, `NANOBANANA21_ENABLED` |
| Veo 3.1 | #779, approved | CI | Sat 17 | deploy #6, `VEO_ENABLED` |
| Recraft (storyboard styles) | #786, approved | CI | Sat 17 | deploy #6, `RECRAFT_ENABLED` |
| BFL FLUX.2 + identity (Cast) | #778, #785, approved | lane B's agent-upload check, CI | Sat 17 | deploy #6, `BFL_ENABLED`, `BFL_IDENTITY_ENABLED` |
| Sarvam (Hindi translation and voice) | #777, approved | 3% buffer, CI | Sat 17 | deploy #6, `SARVAM_ENABLED` |
| sync.so (Hindi lip-sync) | #776, approved, house-only | agent-upload check, CI | Sat 17 | deploy #6, `SYNC_ENABLED` |
| Engine switch (shared) | #771, approved | CI | Fri 16 | deploy #6 |
| Remotion export (MP4) | #697, #699, #700, #766, #768–#775, approved | CI each | Fri 16–Sat 17 | deploy #6 + the worker stack and relay on Coolify (owner, by Mon 19), `REMOTION_EXPORTS` |
| Chromium PDF (decks) | #767, approved | CI | Sat 17 | with the worker, `PDF_EXPORTS` |
| Kling 4.0 | #787, inert | **not on fal yet** | when fal lists it | Kling 3.0 Pro stands in (already live through fal) |
| Pro pick (Seedance 2.5, Veo 3.1, Kling 4.0 → 3.0 Pro) | #788, approved | CI after its base | Sun 18 | deploy #6/#7 |
| House $500 cap | #765, approved | CI | Fri 16 | deploy #6 (needs the `allowance_usd` value) |

**Deploys:**
- **#5:** the four PRs, ready today.
- **#6:** Sat 17 to Sun 18. All engines above plus Slice 1. Migration: `export_jobs`.
- **#7:** Thu 22. The new-design screens, part 1.
- **#8:** Sat 24 morning. Path complete.
- After 24 Oct: fix deploys only.

## B. New-design screens on the path (house workspace, behind the new-interface switch)

Numbers are the v25 plan's (`docs/plans/v25-build-plan.md`); "D-n" items are new for the demo. Lane C and a new screen lane F build screens; lane D builds the server pieces; lane B the engine tools.

| # | PR | Lane | Build | Merge by |
|---|---|---|---|---|
| 1 | App frame (top bar) | C | done (#748 merged) | — |
| 2 | The card (#749) | C | full Opus review running | Sat 17 |
| 3 | The rail (#750) | C | full Opus review running | Sat 17 |
| 4 | Board data: Film's steps incl. **Pitch**, Agent/Director mode in the draft | D | Fri 16–Sat 17 | Sat 17 |
| 32 + D-1 | Home on the shared bar + **New project** → a board with the demo steps | F | Sat 17–Sun 18 | Mon 19 |
| 5 | ✓ and ✕ on takes | C | Sat 17–Sun 18 | Mon 19 |
| 6 | Preview with versions and Compare | C | Mon 19–Tue 20 | Tue 20 |
| 11 | Brief and Script cards (+ **Hindi script** via Sarvam translate) | F | Sun 18–Mon 19 | Tue 20 |
| 7 | Director on Shots (settings, bar, Making…) | C | Tue 20–Wed 21 | Wed 21 |
| 14 + 15 | Cast + character sheet (BFL identity, FLUX.2, Nano Banana) | F + B | Tue 20–Wed 21 | Thu 22 |
| 8 + 19 | Agent mode on Shots and on Brief/Script/Cast/Storyboard (plan cards, priced) | B (server) + C | Mon 19–Thu 22 | Thu 22 |
| 18 | Storyboard (Recraft, Nano Banana, GPT Image) | F | Wed 21–Thu 22 | Thu 22 |
| 9 | The model pop-up with the Pro pick | C | Thu 22 | Thu 22 |
| D-2 | **Hindi version tool:** script translate (Sarvam) → Hindi voice lines (Sarvam Bulbul) → lip-sync each shot (sync.so) → a Hindi cut. One tool, priced, one approval; button + Atomik + MCP (rule 11) | B | Sat 17–Tue 20 | Wed 21 |
| 21 | Assembly engine on the Remotion worker (cut, voice, music, titles, subtitles → MP4) | D | Sat 17–Tue 20 | Wed 21 |
| 22/23-lite | **Edit + Export:** the cut and "Export MP4" for English and Hindi (no cutdowns, no zip) | D + C | Wed 21–Thu 22 | Thu 22 |
| 28-lite + D-3 | **Pitch and Treatment deck PDF** from the board (Chromium PDF) | D | Wed 21–Fri 23 | Fri 23 |
| D-4 | **Money in the new design:** credits and project spend in the top bar and the board, the pricing page link, client review links from a take/cut | C | Fri 23 | Fri 23 |
| D-5 | **Stripe test-mode checkout:** only if the owner's Stripe account allows test mode; otherwise the pricing page only | C | Fri 23 (if yes) | Fri 23 |
| D-6 | **Demo test:** a Playwright run of the whole path on mocks (Home → film → Hindi → MP4 + PDF), at 1440 and 1920 | D | Thu 22–Fri 23 | Fri 23 |

**Waits until after 31 Oct:**
- v25 PRs 10, 12, 13, 16, 17, 20, 24–27, 29–31 and 33–36.
- Engines and tools: Runway #780, MediaConvert #782, Topaz #781, Vision label check #783, Gemini 3.x, DNxHR, the "Approve at N cr" screen, the render_shot PR (it goes up for the owner's answers, then waits), the 1920 px fixture.
- The consent-record column (unless the demo casts a real person; owner question 3).

## C. Demo readiness (docs lane E and the lead)
- **Thu 22:** demo checklist (machine, account, workspace, switches, network, each step with its expected screen and time, the fallback at each step).
- **Thu 22:** the team's demo script: the brief, the 30 s ad's shots, the Hindi lines, who does what from 24 to 27 Oct.
- **Tue 27:** the fallback sample project. Once the film is made, duplicate the board as "Demo (fallback)" with every take, the Hindi cut, the MP4s and the PDFs already rendered and approved, so the demo can run without one live render. Plus offline copies of both MP4s and the PDF.
- **Daily 10:30:** progress against this list, risks to 31 Oct, the owner's questions in one batch.

## D. Risks to 31 Oct
1. **The Remotion worker must be running on Coolify (its own stack plus the relay) by Mon 19.** Its Free licence covers three people. If more than three people use it, the Company licence must be bought (v25 plan, question 12).
2. **Kling 4.0 is not on fal.** The demo uses Kling 3.0 Pro unless fal lists 4.0 by 22 Oct.
3. **CI throughput:** two PRs at a time, about 30 minutes each, so about 35 PRs fit by 24 Oct only with few re-runs.
4. **The team's first real renders start 24 Oct.** Provider surprises (field names marked TO CONFIRM) are found then and fixed in 24–27 Oct.
5. **Lip-sync quality in Hindi:** one test clip on sync.so (owner's bake-off c) on 24 Oct morning decides whether the Hindi version is every shot or the hero shots only.

## E. Owner questions (one batch)
1. **Stripe:** does the account's invite allow test mode, and are test keys set? If not, the pricing page only.
2. **The worker stack:** will you create the Remotion worker and relay stack on Coolify by Mon 19 (steps in #699's README)? And buy Remotion's Company licence if more than three people will export?
3. **Cast:** AI-made characters (no consent needed) or a real person (the consent tick, then the column PR comes back on the path)?
4. **"Pitch":** the Pitch deck PDF made from the board (Treatment-style, Chromium), shown as the first step? Recommended: yes, one deck, with "Treatment" and "Pitch" as two cover styles.
5. **Hindi:** lip-sync every shot, or the hero shots plus a Hindi voice-over on the rest? Recommended: decide after the 24 Oct test clip.
6. **The team:** who gets invites (one admin, the rest members), and on which day?
