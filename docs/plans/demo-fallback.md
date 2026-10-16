# The fallback project for the 31 Oct demo: how to make it on 27 Oct

**Draft, 16 Oct 2026. Docs only.** `docs/plans/demo-31oct-plan.md` (section C): "Sun 27: the fallback sample project. Once the film is made, duplicate the board as 'Demo (fallback)' with every take, the Hindi cut, the MP4s and the PDFs already rendered and approved, so the demo can run without one live render. Plus offline copies of both MP4s and the PDF." (The re-dated plan now says Tue 27 Oct, the freeze day.) The owner's note: "Prepare a demo checklist and a fallback sample project with everything pre-rendered" (`docs/redesign-plan.md`, 16 Oct 12:15). The steps it protects are in `docs/plans/demo-checklist.md` section 6. **Anything not in the repo or the plan is marked UNKNOWN.**

## What the fallback must hold
Every card on the path, finished and approved (✓): Pitch, Brief, Script (English and Hindi), Cast (characters and sheet), Storyboard, Shots (every take for the final cut, in Agent and Director views), the Edit cut in English and in Hindi, the exported MP4s (English and Hindi), and the Treatment/Pitch deck PDF. Nothing in it may be Making…, empty, ✕ or waiting.

## 1. Before duplicating: the film is done
- The production board is final, the owner has accepted the cut, and 27 Oct is the feature freeze: only blockers change after this.
- **Every take is saved.** While signed in as the owner, `/api/health` shows no at-risk takes (`videosAtRisk` 0; after #758 the health page counts "at risk" and "lost (older than 3 days)" separately). A take is "at risk" while its stored copy is missing; do not duplicate until the count is 0.
- **The Producer's tally** (`test-scripts/demo-film.md`) and the workspace's usage agree; the cap has headroom (the $500 figure is a monthly engine-cost cap, with a warning at 80%).

## 2. Make the copy
1. Open the finished production board. In the board's tab menu use **Duplicate board** (the prototype's tab menu lists "Rename · Duplicate board · Copy link · Close" in `docs/redesign/inventory.md`). **UNKNOWN whether Duplicate board exists in the shipped v25 build, and UNKNOWN whether a copy shares the originals' takes and files or copies them.** Rehearse it on a throwaway board on 22 Oct and note the answers here.
2. Name the copy exactly **Demo (fallback)**.
3. Open the copy and confirm it opens in Agent and Director, with the same steps and cards.
4. **If Duplicate board is missing or does not carry the takes, cuts and files:** do not rebuild by hand under time pressure. Options, for the owner's choice: (a) keep the original board as the fallback and make the live demo project a new one, so the fallback is the original untouched; (b) ask the screen lane for the minimal "duplicate with media" before the freeze; (c) a second project made from the same approved takes (UNKNOWN whether the product can reuse takes across projects). Record the decision on the test board.
5. Nothing is ever erased: do not delete anything to tidy up; Remove goes to the board's Trash and is undoable.

## 3. Check every item in the copy (a checklist for the Reviewer)
Tick each, in order, in the copy, and note the time and who checked.

| Item | Check |
|---|---|
| Home and board list | "Demo (fallback)" appears in the list, opens in under a few seconds |
| Pitch | The deck card is Ready or ✓; its PDF opens |
| Brief, Script | ✓ Approved; the Hindi script card is there and correct (Hindi reviewer) |
| Cast | Every character card ✓; the sheet opens at full size |
| Storyboard | Every panel Ready or ✓ in the chosen style |
| Shots | Every shot has an approved take; each plays to the end in Preview; versions strip and Compare work |
| Edit | The English cut and the Hindi cut both play from the timeline, sound in sync, captions not cut off |
| Hindi version | Every lip-synced shot plays; the Hindi reviewer approves |
| Exports | The English and Hindi MP4 exports show Ready and download; they play in a local player |
| Deck PDF | Treatment/Pitch PDF opens; pages the same size; text selectable; no cut-off line; fonts correct |
| Review link | A client review link from the cut opens signed out and plays |
| Money | Credits and project spend show in the top bar and board; the pricing page opens |
| Status | No card reads Making…, empty or ✕ |

## 4. Approve what is not yet approved
Anything Ready but not ✓ is approved by a person (the Director), after the Reviewer has played it. Atomik and outside agents prepare, they never approve. Do not render anything new to fix a gap on 27 Oct unless it blocks the demo; if you must, it is a paid step: the Producer approves it and it goes on the tally.

## 5. Offline copies
1. On the demo machine, make a folder `demo-offline-2026-10-31` (a new dated folder; never reuse an old one).
2. Download: the English MP4, the Hindi MP4 (from the exports or Preview's Download), the Treatment/Pitch deck PDF, and, if the team made them, the key frames and the character sheet. File names follow the product's own naming; add a short README text naming which file is which.
3. Copy the folder to a second device and a USB stick.
4. **Verify every file locally:** it opens in a normal player or viewer with the network off; picture, sound and length are right; the PDF text is real text. Record each file's size and a SHA-256 in the README so a corrupted copy is detected (`sha256sum`).
5. Take the screenshots the checklist's money step needs (credits, project spend, pricing page, review link) on Fri 30 Oct and add them to the folder.
6. The folder is the last rung: if the app and the network fail, the demo plays the MP4s and PDF from here.

## 6. Keep it true until the demo
- After 27 Oct nothing in "Demo (fallback)" changes except by the Director with a note on the test board; no re-rendering.
- Wed 28 to Fri 30 Oct (rehearsal): open the fallback step by step on the demo machine and on the backup device; replay the offline folder.
- 31 Oct, one hour before: open "Demo (fallback)" once, play one take, then close it.

## UNKNOWN
- Whether the shipped build has Duplicate board, and what a duplicate shares with its original.
- The exact labels of the Download and Export buttons in the shipped screens (checked on 29 Oct).
- Whether provider-expiring result links could affect a take that was never fully copied (our adapters copy at once and the health page flags missing copies, so check `/api/health` before duplicating).
