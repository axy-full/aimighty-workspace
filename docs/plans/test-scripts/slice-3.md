# Test script, Slice 3: Nano Banana 2.1, Gemini 3.x, label check, Recraft, Kling 4.0 (for the Aimighty team)

**Status: draft, 16 Oct 2026. Nothing here is live and none of it is run.** This applies once the owner deploys each Slice 3 engine and tells you it is ready. Each engine is its own release, on for the house workspace only. As of 16 Oct none of these engines has a build PR yet (Slice 2's sync.so, Sarvam and BFL are #776, #777 and #778); the order and the sample prices are in `docs/plans/provider-adapters.md` ("Where this stands", sections 4 and 5, and section 10), and the owner's stack is in `docs/redesign-plan.md` ("FINAL ENGINE STACK", 15 Oct 22:15). You test on particl.si, in the house workspace, signed in through the owner's invite link.

## Read this first
- **Every step marked [SPENDS] uses real credits from the house workspace: it needs the owner's yes; house workspace only.** **None is run until the team starts testing with the owner.** The normal per-step approval is the approval: read the price on the button (`N cr`, `up to N cr` or `free`) and press only what you mean to run. All prices in this page are samples from the plan, not the card.
- Steps not marked [SPENDS] read or compare what already exists and cost nothing.
- Asking Atomik or an outside agent (MCP) to run a step **prepares it and shows the price; it does not spend** while the workspace is in Ask mode. Only you approve.
- Stop and report if anything is blocked, wrong or surprising. Do not retry a paid step without saying so. At the 80% warning of the house cap ($500 a month, once that change is live), stop and tell the owner.
- Use only people who have agreed. Never test on a stranger's face or voice.

## 1. Nano Banana 2.1, beside Nano Banana Pro
**Try:** [SPENDS] Make the same still from one prompt on Pro and on 2.1 (one prompt with a character, one product shot, one with a line of text on a sign). Use the model menu: both are listed, and Auto shows its one-line pick with Change.
**Good looks like:** the price reads before you press, differs from Pro as the card says, and matches the charge; 2.1 follows the prompt at least as well as Pro; hands, faces and text hold; references are honoured; the result opens at its real size. Say which you would use for which job. Bake-off (a) (below) uses both.

## 2. Gemini 3.x: moments, cutdown planning, the vision judge
**Try:** (a) Moments: give it a 3 to 10 minute talk or interview with a transcript and ask for the best moments. (b) Cutdown planning: with a 30 s cut, ask for a 15 s and a 6 s plan. (c) Vision judge: run Verify on a take. [SPENDS] each is a priced text or vision step; read the price first.
**Good looks like:** (a) each moment has a start and end that do not cut a sentence, a reason in plain words, and ranks by hook, emotion and topic as you would; no invented quotes (check against the transcript). (b) the plan keeps the story, lists which shots and lines stay, and totals the length asked for; the Remotion cutdown then follows it. (c) the judge's notes name real problems you can see in the frames (extra fingers, drift, wrong product), not generic praise; it marks a take for a person and never blocks one by itself.

## 3. Cloud Vision label check, with an exact text diff
**Try:** [SPENDS] On a take with a product label, packshot or title card, run the label check against the text it must carry. Run it three ways: the text correct; one letter wrong (for example a misspelt brand); the text missing. Also run it on a plain take with no text.
**Good looks like:**
- The check reads the words in the picture, then compares them **exactly** with the required text, character by character. A correct label passes. A one-letter error is caught and shown as the difference (what was read against what was required). Missing text is reported as missing. **An AI model alone never decides pass or fail.**
- A mismatch marks the take for a person and does not delete or block it; the words and where they sit are shown.
- A take with no required text reports what it found without failing; stray lettering is flagged only where the rule says no lettering.
- The price reads inside Verify's quote or as `1 cr` on its own (sample); a refused or failed read says "Nothing billed".

## 4. Recraft V4.1 and V3
**Try:** [SPENDS] (a) A raster image from words in a design style. (b) A vector image (SVG) of a simple logo mark. (c) Vectorize a PNG logo into an SVG. (d) Remove the background from a product still. (e) Storyboard styles: one panel each in sketch, ink and comic. (f) A deck or brand asset (a title slide, a colour-and-type sheet).
**Good looks like:** the price reads before running (samples: raster 1 cr, vector 2 cr, vectorize 1 cr, remove background 1 cr); the vector opens and scales cleanly with no jagged edges and no stray points; the SVG is offered as a download and never runs script in the page; vectorize keeps the logo's shape and colours; the cut-out edge is clean (compare with the Bria cut-out and say which is better); each storyboard style is clearly its style and characters stay recognisable across panels; deck text is real and correctly spelt (run it through the label check in section 3). Recraft's data page says API images are not used for training and not stored: report anything that looks otherwise.

## 5. Kling 4.0 (and 3.0 Pro until it is live)
**Try:** [SPENDS] Make a 5 s clip from a still and words on Kling. Until Kling 4.0 is live the menu shows Kling 3.0 Pro: test that, and run the same brief again on 4.0 the day it is listed. Kling is also one of the Pro picks.
**Good looks like:** the price reads before running (Kling 3.0 Pro is about 13 cr for 5 s at 1080p with audio on the card); motion, faces and hands hold; the clip follows the words and the first frame; audio, if offered, fits the picture; the model name in the menu is the one the owner set in config. Compare with Seedance 2.5, Veo 3.1 and Runway Gen-4.5 on the same brief and say which you prefer; this is part of bake-off (b).

## Bake-offs
The team runs these live, one at a time, after the owner says testing has started. Results decide the defaults.
- **(a) Storyboard:** an 8-panel storyboard, two characters, three styles, on Recraft, GPT Image 2.5, Nano Banana Pro and 2.1. Same script and characters for all four. Score each: characters stay the same across panels, the style is right, text is correct, price per panel. One-line verdict per style.
- **(b) Video engines:** 10 real briefs on the top 3 video engines of the Pro pick (Seedance 2.5, Veo 3.1, Kling, Runway Gen-4.5). Same brief, length and shape. Score: follows the brief, motion, faces and hands, price.
- **(c) One Hindi lip-sync clip on sync.so:** a Slice 2 test; see `slice-2.md`.

## How to report
Use **the feedback board: https://claude.ai/artifact/RwiYcD2sVpLiLw7kGyt4wC**. One card per problem. Put in: the engine and model, what you pressed, the price you saw and what you were charged, what you expected, what happened, the production name, the time, a screenshot or recording, and your device and browser. Never paste a password, a key or an invite link. Bugs are filed to the build team and fixes come back as PRs the same day where we can. When you finish, add one line to the board: "Slice 3: engines checked" and which you could not reach.
