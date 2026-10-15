# Test script, Slice 1: exports and PDFs (for the Aimighty team)

**Status: draft, 15 Oct 2026. Nothing here is live tonight.** This applies once the owner deploys Slice 1 (the Remotion export worker switched on, and Chromium PDF) and tells you it is ready. You test on particl.si, in the house workspace, signed in through the owner's invite link. No test here needs a paid engine step. If anything asks you to approve credits, read the price on the button: an export from Remotion is **Free**; if you did not mean a voice-over or a regenerated shot, do not approve, and report it. (Basis: `docs/plans/remotion.md`; the Chromium PDF feature has no plan page yet, so its checks below are the owner's brief, "treatment, pitch, PPM decks".)

Where a button is not on the screen yet, ask Atomik for the same thing ("export this cut as 9:16 with captions"). Every feature is also a tool Atomik can run. If neither the button nor Atomik can do it, that is a finding: report it.

## Before you start (once)
- A production with a finished cut of about 30 s in 1080p, with spoken lines (your own clip is fine). One line in Hindi if you can: it checks other scripts.
- Open the cut in the production. Note the time you press each button; you will compare it with "Ready".

## 1. A 30 s cut with captions and an end card
**Try:** Export the cut as MP4 with karaoke captions and an end card (a title and a line of text).
**Good looks like:**
- Ready in about **3 minutes or less** when nobody is ahead of you (our server's own measurement on 13 Oct was about 170 CPU-seconds for a 30 s 1080p cut; the limits may move after the real measurement). A queue shows "Export queued, 2 ahead of you", then Rendering, Saving, Ready. **Over 5 minutes, or stuck on one state: report it.**
- Price on the button reads Free, and nothing is billed. A failed export says "Nothing billed" and offers Retry.
- **Captions in sync:** each word appears with its sound, no more than about 0.2 s early or 0.3 s late; the highlight moves word by word; nothing is missing or doubled. Check the first line, the middle and the last line.
- **No cut-off text:** every caption line sits fully inside the frame with a clear margin on all four sides, at most two lines, no letter clipped at an edge. The end card's title and line are whole, centred as designed, readable for the whole hold.
- Hindi or other scripts show real letters, not empty boxes.
- The picture, length and sound match the cut; the file plays in your usual player. If the starter production's demo clip is used, its Big Buck Bunny credit (Blender Foundation, CC BY 3.0) is shown or listed.

## 2. The 9:16 version
**Try:** Make the 9:16 version of the same cut (the 16:9 to 9:16 reframe), with captions.
**Good looks like:** the subject stays in frame the whole way; captions sit clear of the very top and bottom (where phone apps draw their own buttons) and are not cut at the sides; the end card is re-laid for tall, not squeezed; same length and sync as the 16:9 export.

## 3. A cutdown
**Try:** Ask for a 6 s, a 15 s and a 30 s cutdown of the cut.
**Good looks like:** each has the length you asked for within a frame or two; none starts or ends mid-word; the captions and end card still fit; the planning picks moments worth keeping (say if it does not). Silence cuts, if offered, do not clip the start of a word.

## 4. A ProRes / DNxHR mezzanine
**Try:** Export the cut as a ProRes file, then as DNxHR.
**Good looks like:** the file is large and downloads fully; it opens in your editor (Premiere, Resolve) without a conform dialog; frame size and frame rate are the project's; the length matches the MP4 within a frame; audio is present and in sync. A cut in another frame rate is conformed to the project's rate without changing its length.

## 5. Download all
**Try:** On the production, choose Download all.
**Good looks like:** one zip; it holds every export you made in this test; each file opens; no empty files; file names read clearly and follow the product's own file naming (production, shot, take, version). The zip arrives within a minute for a handful of files.

## 6. PDFs: treatment, pitch, PPM deck
**Try:** Make a treatment, a pitch and a PPM deck from one production.
**Good looks like:**
- Ready within about **30 seconds** each (a proposed figure; say what you saw).
- **Pages:** every page the same size and orientation; the page count matches the sections you expect; no blank page; no heading alone at the bottom of a page; no line, table or image cut in half at a page edge.
- **Fonts:** one typeface family used as designed (the brand typeface for headings), no fallback boxes or odd letters, Hindi and other scripts correct. Select a sentence and copy it: the text is real text, not a picture.
- **Content:** shots and images are sharp, in the right order, with their captions; names, dates and numbers match the production; page numbers are right.
- Prices, if shown, read as the product shows them (`N cr`, `up to N cr` or `free`), never a bare dollar vendor cost.

## How to report
Use **the feedback board: https://claude.ai/artifact/RwiYcD2sVpLiLw7kGyt4wC**. One card per problem. Put in: what you pressed, what you expected, what happened, the production name, the time you pressed it, a screenshot or screen recording, and your device and browser. Never paste a password, a key or an invite link. Bugs are filed to the build team and fixes come back as PRs, the same day where we can.

When you finish, add one line to the board: "Slice 1: all six checked" or which ones you could not reach.
