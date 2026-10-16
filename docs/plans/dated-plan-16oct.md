# Dated plan from 16 Oct 2026 (owner's 12:05 standing yes)

Written by the lead, 16 Oct 2026 ~12:20 IST. Merges into release/1 follow the 12:05 standing yes (CI 24/24 on the final head, a fresh Opus approval, no guard or security check loosened). Main and every deploy stay the owner's: one deploy PR per day when release/1 has changes, with migrations and new env names at the top.

**The limit is CI, not people.** At most 2 PRs in CI at once, about 30 minutes a run, so about 16 to 20 merges a day at best. Three build lanes (B engines, C screens, D server and worker) and one docs lane work in parallel; Opus reviews every PR.

## Fri 16 Oct
- **Deploy #5 ready today:** #762 CI green, then merge #756, #762, #758 (all Opus-approved, green). Cut `deploy/5` from release/1 at that commit and open the deploy PR (no migrations, no new env names). Tell the owner "ready".
- **Merge backlog into release/1, for deploy #6** (each: retarget to release/1, CI, merge):
  1. Already green and approved: #697, #699, #763, #764.
  2. #765 house cap (after its CI).
  3. Engines, in stack order: #771 (engine switch), then #776, #777, #778, then #785, #780, #782, #779, #783, #781, #786, #784; #787 stays a draft.
  4. Slice 1: #700 (export_jobs table), then #766, #768 to #773, #774, #775, #767.
  5. #749 and #750 after a full Opus review (their reviews so far were large-screen only).
  6. #788 Pro pick after its base lands.
- **Lane B:** agent upload checks in BFL, Runway, lip-sync; cleanup; the consent-record PR (one additive uploads column + a settings map for voice ids); Sarvam 3% buffer.
- **Lane C:** the render_shot PR (every changed test listed for the owner); the "Approve at N cr" screen; the 1920 px test fixture.
- **Lane D:** DNxHR HQ/HQX: the pinned FFmpeg stage in the export worker, real-render tests, delivery copy back.

## Sat 17 Oct
- Finish the merge backlog. **Deploy #6 PR ready**, with at the top:
  - migrations: `export_jobs` (#700), the consent-record column (if merged);
  - new env names: the Remotion worker names (#699, #700), `PDF_EXPORTS`, and every engine switch (all left unset until the owner says go).
- Lane B: the Gemini dated price step (own PR), then the Gemini 3.x build.
- Lanes C and D start v25 Phase 1: PR 4 board data (D), PR 5 ✓ and ✕ on takes (C).

## Mon 19 to Wed 21 Oct: v25 Phase 1, slice 1 (Shots in both modes)
- PR 6 Preview everywhere, PR 7 Director on Shots, PR 8 Agent on Shots, PR 9 Auto and the Pro pick in the model pop-up (uses #788).
- PR 10 the five-minute test for v25: a guard rewrite, so it needs the owner's word (batched for the 10:30 report).
- Lane B in parallel: Gemini 3.x (moments, cutdown planning, vision judge).

## Thu 22 to Tue 27 Oct: v25 Phase 2, slice 2 (the steps before Shots)
- PR 11 to 19: Brief and Script, ✓ ✕ on text cards, read-through (ElevenLabs/Sarvam), Cast (with the consent record), the character sheet (FLUX.2/Nano Banana), Locations, Elements, Storyboard (Recraft, GPT Image, Nano Banana, Chromium PDF), Agent mode on steps 2 to 7.

## Wed 28 Oct to Mon 2 Nov: v25 Phase 3, slice 3 (Edit and Deliver)
- PR 20 timeline lens; PR 21 the assembly engine on the Remotion worker (lane D); PR 22 Edit; PR 23 Deliver (cutdowns, ProRes, DNxHR, conform, zip, MediaConvert reframe).

## Tue 3 to Thu 5 Nov: v25 Phase 4, Social narrated
- PR 24 Hook, PR 25 Voice step, PR 26 captions (karaoke on the worker), PR 27 Social Deliver.

## Fri 6 to Thu 12 Nov: v25 Phase 5
- PR 28 Treatment deck (Chromium PDF), PR 29 Campaign, PR 30 Social clips (Gemini 3.x moments, silence cuts), PR 31 Pre-vis.

## Fri 13 to Wed 18 Nov: v25 Phase 6, the app screens
- PR 32 Home on the shared bar, PR 33 sharing screens, PR 34 Trash and Undo, PR 35 Agent on phone (only if the owner wants it).
- PR 36 v25 for everyone and delete the old design: after the owner's 7-day rule, **before the 30 Nov guard-entry deadline** (eleven entries expire then).

## Engine slices alongside
- **Slices 1 to 3:** in release/1 by Sat 17 Oct; each goes live when the owner deploys and sets its switch (house only until launch).
- **Kling 4.0 (#787):** stays inert until fal lists it with a price; checked each morning in the 10:30 report.
- **Slice 4 (the "later" list):** only on a client need or a bake-off win.
- **Slice 5 (trends):** not started; needs the owner's go and its env names.

## What can move these dates
- CI failures and flakes (each costs a 30-minute slot).
- The v25 plan's open owner questions (section 7 of `docs/plans/v25-build-plan.md`), above all question 8 (Agent on phone) and the guard rewrites (PR 10, PR 36).
- Engines a team test finds wrong (fixes go back as PRs the same day).
