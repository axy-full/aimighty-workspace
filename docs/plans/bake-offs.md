# Bake-offs: four head-to-heads that decide the defaults

**Draft, 16 Oct 2026. Docs only.** The owner's 15 Oct 22:15 stack listed three bake-offs (storyboard, 10-brief video, Hindi lip-sync) and his 16 Oct 15:05 note added an upscale bake-off (`docs/redesign-plan.md`). The team runs them live; **the results decide the defaults**; the owner picks. Dates fit the demo plan (`docs/plans/demo-31oct-plan.md`, re-dated 16 Oct): full path live Fri 23 Oct, team film Sat 24 to Mon 26, feature freeze Tue 27, rehearsal 28 to 30, demo Sat 31 Oct.

**Rules for all four:**
- **No spend before the owner's yes**, given per bake-off in writing on the test board after he has seen the estimate. Until then this page is a plan.
- Every paid step runs in the **house workspace only**, through the normal per-step approval in the UI, against the house $500 monthly cap (warning at 80%); a person approves each step.
- **Costs are not written in this repo** (it is public). Each bake-off's estimate is: **"estimate: with the lead (private)"**; the lead gives the owner the figures in chat before he says yes.
- Inputs are AI-made or house-owned; no real person's face or voice (the demo casts AI-made characters only).
- Each ends with the same **side-by-side page** (a static page on the test board: https://claude.ai/artifact/RwiYcD2sVpLiLw7kGyt4wC): one column per engine, one row per input, the same crop zoomed, time and price per output, a one-line verdict per row, and the owner's pick at the bottom. The lane that builds the page is `[lane TO ASSIGN by the lead]`.
- Provider terms apply as published; training is the provider's policy (`docs/legal/where-your-data-goes.md`).

## Summary

| # | Bake-off | Date | Engines | Decides | Owner / lane |
|---|---|---|---|---|---|
| 1 | **Upscale** | Thu 22 Oct | Topaz Astra 2 vs BFL FLUX Upscale (Precise; Creative by explicit choice), at 2× and 4K | The upscale default | Owner picks; lead runs with the team |
| 2 | **Storyboard** | proposed Tue 20 Oct (after deploy #6) | Recraft, GPT Image 2.5, Nano Banana Pro, Nano Banana 2.1 | The storyboard style and engine for the demo | Owner picks; team runs |
| 3 | **10-brief video** | proposed Wed 21 Oct | Seedance 2.5, Veo 3.1, Kling (3.0 Pro until 4.0 is on fal) | The Pro pick defaults | Owner picks; team runs |
| 4 | **Hindi lip-sync test clip** | Sat 24 Oct, morning | sync.so lipsync-2-pro, then sync-3 | Every shot or hero shots only | Owner decides with the team |

Dates 2 and 3 are **proposals**: they need the engines live (deploy #6, planned Sat 17 to Sun 18 Oct, the owner's) and must finish before the full path goes live on Fri 23 Oct so the demo uses the winning defaults. The owner may move them.

## 1. Upscale, Thu 22 Oct

- **Inputs:** three **house clips**, 5 s each: (a) a **face close-up**, (b) a **product**, (c) a **wide** shot. AI-made or house-owned. Same source files for both engines.
- **Engines:** **Topaz Astra 2** (direct, #781) and **BFL FLUX Upscale** (same `BFL_API_KEY`). FLUX Upscale **Precise is the default**; **Creative only by explicit choice**, with the note "faces and products may change". FLUX Upscale is to be live on the house workspace by **Wed 21 Oct** (a prerequisite; UNKNOWN whether its PR has landed).
- **Runs:** each engine at **2× and 4K** on each clip: 3 clips × 2 engines × 2 sizes = 12 outputs (plus Creative if the owner asks).
- **What is compared:** detail recovered without a plastic look; faces unchanged (a face that changes is a fail for that engine on that clip); product text and edges intact; flicker and temporal stability across the 5 s; artefacts on the wide shot; time to finish; price per output (shown on the button, recorded).
- **The side-by-side page:** per clip and size, the original beside each engine's result, with **zoomed crops** (face, product label, a wide-shot edge) at 100% and 200%, the cost and the time under each; a one-line verdict.
- **Owner's yes:** exact estimate first, then **run only on the owner's yes**.
- **Estimate:** **estimate: with the lead (private).**
- **Owner / lane:** the owner picks the default; the team runs it with the lead on the day. The page: `[lane TO ASSIGN]`.

## 2. Storyboard, proposed Tue 20 Oct

- **Inputs:** **8 panels**, **two characters**, **three styles** (the storyboard styles the stack offers: sketch, ink and comic; the exact three are the owner's pick: `[TO DECIDE]`). One script and one pair of AI-made characters, the same for every engine. (If a demo script already exists, use its first eight beats.)
- **Engines:** **Recraft** (V4.1 and V3, raster), **GPT Image 2.5**, **Nano Banana Pro** and **Nano Banana 2.1**. Each engine renders the 8 panels in each of the 3 styles: 4 × 3 × 8 = 96 stills (fewer if the owner trims the styles).
- **What is compared:** the **characters stay the same** across panels; the **style** is right and consistent; composition follows the beat; text in the panel is correct; hands and faces hold; time and price per panel (shown on the button, recorded).
- **The side-by-side page:** rows are panels 1 to 8, columns are the four engines, with a tab per style; each cell is the panel; a strip at the top shows the two characters' reference. A verdict per style and an overall pick.
- **Owner's yes:** before any spend; Recraft's engine switch and Nano Banana 2.1's must be on (deploy #6).
- **Estimate:** **estimate: with the lead (private).**
- **Owner / lane:** the owner picks the demo's storyboard engine and style; the team runs it; the page `[lane TO ASSIGN]`.

## 3. 10-brief video, proposed Wed 21 Oct

- **Inputs:** **10 real briefs** `[TO DECIDE: who writes them and which; the owner or the Director]`, each a short brief with a first frame or reference where the brief needs one. Same brief, same length (5 s unless the brief needs more), same shape for every engine.
- **Engines:** the **top three video engines of the Pro pick**: **Seedance 2.5**, **Veo 3.1** and **Kling** (**3.0 Pro** until 4.0 is on fal; Runway Gen-4.5 is not on the demo path). 10 briefs × 3 engines = 30 clips.
- **What is compared:** follows the brief; motion; faces and hands; consistency with the first frame; audio where the engine makes it; time to finish; price per clip (shown on the button, recorded). Score each 1 to 5 on those, plus a one-line verdict per brief.
- **The side-by-side page:** rows are briefs, columns are engines, each cell a playable clip with its score, time and price; a summary of wins per engine and per kind of brief.
- **Owner's yes:** before any spend; draft quality first where an engine offers a cheaper draft, hero on the winners only.
- **Estimate:** **estimate: with the lead (private).**
- **Owner / lane:** the owner picks the Pro pick defaults (the model pop-up's Auto-by-shot-type and the named list in Director mode); the team runs it; the page `[lane TO ASSIGN]`.

## 4. Hindi lip-sync test clip, Sat 24 Oct, morning

- **Inputs:** **one short Hindi line** written or checked by a **native speaker**; one 5 s clip of an **invented character** speaking; a **Sarvam Bulbul stock voice** (no cloning; stock voices need no voice consent).
- **Engines:** **sync.so**: **lipsync-2-pro**, then **sync-3** for the hero. (sync.so is house-only until counsel answers.) Sarvam must be priced (the rupee rate set) before the voice step; if there is no price, stop and report.
- **What is compared:** does Hindi sound natural to a native speaker; do the mouth shapes fit Hindi sounds (not English ones); skin, beard and teeth detail (pro) against profile and expression handling (sync-3); price and time per 5 s.
- **The side-by-side page:** the two outputs next to each other, with the original, plus the native speaker's note and a recommendation.
- **Decision it makes (with the owner, per the 12:20 note):** **Hindi lip-sync on hero shots only, final call after this clip**: whether the Hindi version is **every shot** or the **hero shots only** with a Hindi voice-over on the rest. It is the first step of the team's film (`docs/plans/test-scripts/demo-film.md`).
- **Owner's yes:** before any spend, on the test board, given before the film starts on 24 Oct.
- **Estimate:** **estimate: with the lead (private).**
- **Owner / lane:** the owner decides; the Hindi reviewer and the Director run it; the page `[lane TO ASSIGN]` (a note on the test board is enough if the page is not ready).

## What is not here
- Runway, MediaConvert, the Vision label check, Gemini 3.x and DNxHR are off the demo path, so they have no bake-off before 31 Oct.
- Evolink versus BytePlus is a report, not a bake-off (the owner: we stay direct with BytePlus for Seedance 2.5).
- Any other bake-off is the owner's to add.
