# Test script, Slice 2: lip-sync, voices, identity, performance, Veo, face check, reframe, upscale (for the Aimighty team)

**Status: draft, 15 Oct 2026. Nothing here is live tonight.** This applies once the owner deploys the Slice 2 engines and tells you each is ready (each engine is its own release and is on for the house workspace only). You test on particl.si, in the house workspace, signed in through the owner's invite link. Basis: `docs/plans/provider-adapters.md` ("Where this stands" and sections 1 to 8) and the owner's 22:15 note in `docs/redesign-plan.md`.

## Read this first
- **Every step here spends real credits from the house workspace.** The normal per-step approval is the approval: read the price on the button (`N cr` or `up to N cr`), and press only what you mean to run. Nothing is approved for you. If a price looks wrong against what you were charged afterwards, report it.
- The house workspace has a monthly cap of $500 with a warning at 80% (once that change is live). If you see the warning, stop and tell the owner.
- **The face check blocks real faces for now.** Every real face must pass Rekognition against its consent record before lip-sync, Act-Two or cloning runs. The check refuses every face until the owner picks where the reference face comes from (a photo at consent time, the cast member's master, or a video frame). So **lip-sync and Act-Two cannot run on real faces yet**: on a real face the right result is a plain refusal, "This person's consent has no face reference yet", with **Nothing billed**. Check that, then use only invented characters or stock voices and faces for the rest. If an invented character is also refused, say so: how the gate treats a non-real face is not recorded.
- Use only people who have agreed. Never test on a stranger's face or voice. Voice cloning is not offered.
- Stop and report if a result is blocked, wrong or surprising. Do not retry paid steps to "see if it works now" without saying so.

## 1. sync.so lip-sync (lipsync-2, lipsync-2-pro, sync-3)
**Try:** Take a short clip (5 to 10 s) of an invented character speaking, and a voice track (a stock voice or a speech take). Run lip-sync on each of the three models in turn. Try once with a voice track longer than the clip.
**Good looks like:**
- The price reads before you press (about 4, 7 and 10 cr for 5 s in the plan's samples) and matches the charge.
- The mouth matches the words: consonants on the beat, no drifting, no frozen mouth. The face outside the mouth is untouched, with no flicker or colour jump.
- lipsync-2-pro keeps beard, teeth and skin detail; sync-3 handles a profile or over-the-shoulder angle and keeps the speaker's expression (say if it does not).
- Different lengths behave as the choice says (for example the clip bounces, loops or cuts off) and the result's length is what you expect.
- It finishes without you re-asking; a failed job says "Nothing billed" with Retry.
- Several faces in the frame: the result may be worse (the vendor warns of it); say how.

### Bake-off (c): one Hindi lip-sync clip
Make one Hindi clip on sync.so and judge it as a team. Steps: write or take a short Hindi line, speak it with a Sarvam Bulbul voice (see 2), lip-sync an invented character to it on lipsync-2-pro, then on sync-3 for the hero. **Good:** Hindi sounds natural to a native speaker, the mouth shapes fit the Hindi sounds (not English ones), and the pair is something you would show a client. Write down which model you would use for which job; the results decide the default.

## 2. Sarvam: voices, transcripts, translation, dubbing
**Try:** (a) Read a Hindi paragraph, a Tamil line and a mixed English-and-Hindi line with Bulbul stock voices. (b) Transcribe a 2-minute clip in an Indian language (Saaras), with speakers if offered. (c) Translate a short script from English into three Indian languages. (d) Dub a short cut into Hindi.
**Good looks like:** the price reads `up to N cr` before running and settles at what it used; speech is clear and correctly stressed with the right script and numbers; the transcript has timed words and the right speakers; translations keep meaning and tone (a native speaker reads them); the dub's timing fits the cut. Only stock voices are offered; if you see a cloning option, report it. Speech is split at long lengths without an audible join.

## 3. Black Forest Labs: FLUX 3 and FLUX.2 identity
**Try:** Make a still from words. Then edit from references: give a product photo, a setting and a look (up to 8 references) and ask for the product in that setting. Make an identity of an invented or consenting person and render them in two new scenes.
**Good looks like:** the price reads before running; the still follows the words; references are honoured (the product's label and shape are intact, the look matches); the identity looks like the same person in both scenes. The images come back every time (the vendor's links last only 10 minutes, so a missing image is a bug). Compare with the old identity route if you can, and say which keeps the face better.

## 4. Runway: Act-Two, Aleph 2, Gen-4.5
**Try:** (a) Aleph 2: change something in a 5 to 10 s shot with words (the weather, the time of day, an object). (b) Gen-4.5: make a clip from a still and words. (c) Act-Two: drive an invented character with a 5 to 15 s performance video of a team member who has agreed; this runs only on non-real faces for now (see above).
**Good looks like:** the price reads before running; the edit changes only what you asked; Gen-4.5 follows the still and the words, motion looks plausible; Act-Two copies the performance (head, eyes, expression, and body if chosen) onto the character; clips come back within a few minutes. Runway's terms ask for "Powered by Runway" in the app: say if you see it.

## 5. Veo 3.1
**Try:** Make a 5 to 8 s clip from words, and one from a still plus words. Use the model menu: Veo 3.1 is one of the Pro picks beside Seedance 2.5, Kling and Runway Gen-4.5.
**Good looks like:** the price reads before running; the clip follows the words, motion and light are coherent, faces and hands hold; sound, if it comes with the clip, matches the picture. Run the same brief on another Pro pick and say which you prefer.

## 6. AWS: the consent face check, and Smart Crop
**Consent face check. Try:** (a) On a cast member who is a real person with a consent record, run the check. (b) On a cast member with no consent record. (c) On a photo with two faces.
**Good looks like:** (a) today, a plain refusal because the reference source is not chosen yet, "Nothing billed", and no lip-sync or Act-Two starts; **once the owner has chosen**, a match above the threshold lets the next step run and a mismatch asks a person to look. (b) "Needs consent", no call made. (c) "Crop to the one face". The check never deletes anything and never blocks without saying why.
**Smart Crop. Try:** Reframe a 16:9 clip to 9:16, and a 9:16 clip to 16:9, with Smart Crop (this replaces the old Luma reframe).
**Good looks like:** the person or product stays in frame the whole clip, the crop moves smoothly without jitter, nothing important is cut off, the length and sound are unchanged, and the price reads before running. Compare with the old Luma reframe if you still have it, and say which is better.

## 7. Topaz upscale, direct
**Try:** Upscale a 5 s 1080p clip to 4K, and an image to a larger size. Use the same presets you used before.
**Good looks like:** more detail without a plastic look or flicker; faces are not changed; the length is the same; the price reads before running and is the charge afterwards. The price may differ from the old route (the plan's sample for direct is higher); say what it shows.

## Bake-offs
The team runs these live, one at a time. Results decide the defaults. **Nothing runs before the team starts testing with the owner.**
- **(a) Storyboard:** an 8-panel storyboard, two characters, three styles, on Recraft, GPT Image 2.5, Nano Banana Pro and 2.1. These engines arrive in Slice 3; run it when they do.
- **(b) Video engines:** 10 real briefs across the top 3 video engines of the Pro pick (Seedance 2.5, Veo 3.1, Kling, Runway Gen-4.5). Same brief, same length and shape. Score each: follows the brief, motion, faces and hands, price. Keep a one-line verdict per brief.
- **(c) One Hindi lip-sync clip on sync.so:** see section 1.

## How to report
Use **the feedback board: https://claude.ai/artifact/RwiYcD2sVpLiLw7kGyt4wC**. One card per problem. Put in: the engine and model, what you pressed, the price you saw and what you were charged, what you expected, what happened, the production name, the time, a screenshot or recording, and your device and browser. Never paste a password, a key or an invite link. Bugs are filed to the build team and fixes come back as PRs the same day where we can. When you finish, add one line to the board: "Slice 2: engines checked" and which you could not reach.
