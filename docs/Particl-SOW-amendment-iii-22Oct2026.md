# Amendment, 22 October 2026 (iii) — the design lock, the stepset, the record, the floor

For docs/particl-sow-v1.md (after "Amendment, 21 October 2026 (ii)"), docs/redesign-plan.md "Owner decisions", and CLAUDE.md "Owner decisions since 10 Oct 2026". The owner's decisions of 22 October 2026, taken while reviewing Prototype v31.6 through v31.16 (Claude Design) and in the evening's conversation with the advisor; in his words where quoted. This PR is docs only. Code PRs follow as marked: **[money]** under a money review; **[schema]** flagged to the owner before any migration. Pixel sizes, URLs and screen-by-screen detail stay in the prompts (Particl-v31.7 … v31.16-prompt.md) and in the design zip that is THE design (section F); this records what the product is, not how a screen is drawn.

Sections: A how Atomik asks · B Director mode · C surfaces · D engines and vendors · E Atomik's thinking, three settings · F the design lock · G the stepset · H the floor and above the floor · I the film record · J the Director never starts from a blank prompt · K the dataset additions · L the PR plan · M what is open.

## A · How Atomik asks (amends SOW S1, S2, C2 and rule 13)

**A1 One question at a time.** "The agent will think and ask each question separately. Not present 3 questions at once to the user. That way I want the agent to ask as many questions as it wants for its clarity. And the atomik bar will spin when the agent is thinking." Strike "at most three bare questions" (S1) and "asks at most three questions" (C2): the cap goes; the count is Atomik's. What stands: nothing is asked twice; nothing the brief, the Look, the Elements or the Director's own work already answers is asked (S2, rule 13). "Dont show too many options in agentic mode": at most four answer pills per question, plus a field.

**A2 Study, then suggest — never a random question.** "I dont wanna see random questions. Take your time to study the output once created and then suggest questions basis what you see. It will use up context tokens, but thats fine, make it part of the hidden cost per generation." Before a thing is made, Atomik asks what it needs; after, it studies the result and suggests from what it sees. **[money] Reconcile with B4 (21 Oct) and the 18 Oct rule "Atomik's own check of its work is free and is never a line".** Both say the check is never a line and its cost is absorbed (B4: "absorbed in the Agent factor"), which matches "hidden cost per generation". What widens: B4 bounds the check to one judge call per take on sampled frames with the shot's rows, cheapest capable model; A2 asks for a study that yields suggestions on every kind of asset (face, product, environment, world, frame, take, mix). ~~**NEEDS AKSHAY:** does B4's bound widen to every asset kind and to suggestions, with the cost still absorbed in the factor (no line, no change to the quoted price), or is the study a priced part of the job's single quote? The design shows one price.~~

*Answered 23 October 2026 (the owner): B4 of 21 Oct widens to every asset kind and to the one suggestion line. The cost stays absorbed in the agent factor, never a line, and the quoted price does not change.*

**A3 Per-kind question sets.** "For every asset, the question set will vary in agentic mode (the agent is allowed to add that thinking time to the render time and then present the asset) or it can take a seperate processing time too." A job shows Thinking · Making · Reviewing; one quote, approved before it starts (rule 14, 18 Oct).

**A4 Nothing on the bar.** Selection, questions, suggestions and notes never crowd the one-line bar; they sit on a line above it. (Storyboard: "dont clutter the one line prompt bar on the bottom if somebody selects something. Add another line on top with your questions or suggestions or standard preconfigured doubts.")

**A5 Storyboard carries everything.** "Agentic mode will automatically carry the attributes of the storyboard and the grouped nodes to storyboard. Where they just need to click on generate." Rule 13's "carries into every shot and is not asked again" now names Look and Elements explicitly.

## B · Director mode

**B1 Remembered settings, one Generate.** "Once the director has selected his settings across various right column bar settings, they all need to be remembered and in general we need a generate button for once the settings are tweaked and prompt ready." Settings persist per node and per step; one Generate · N cr with a live price; a settings change alone never runs anything (rule 14: every job approved on its quote).

**B2 A take first.** On Shots, clicking a node shows the take's information first (what it ran with, the prompt as sent, what it cost, Kept or not); a change makes a new take beside it, never over it (rule 4: shot/take; nothing erased).

**B3 Kind first on Elements.** "Every time somebody double clicks in elements (directors mode) first ask them which element they wanna make before you can offer any other settings." Kinds: Cast · Prop · Environment · Vehicle · Wardrobe · Product · Words · World.

**B4** ~~Double-click opens the Inspector too. A new node opens with its panel on the tab that matters.~~

*Corrected 23 October 2026: the design wins. The owner's decision of 22 Oct, 21:15 (v31.14) reversed B4: a double-click makes a node and never opens the Inspector; a new Director node shows "What is it?" on the card; in Agent mode the panel opens itself only for a question or a suggestion.*

**B5 Sound shows sound.** Shot settings (picture, camera and light) never appear on Sound's inspector; they live on Shots. Edit's Director rail has Sound · Versions · Export and no Settings tile. The playhead drags in both modes.

**B6 Treatment.** Director's right column is Design · Text · Image · Page · Versions · Export; Narration folds into Export ("Narrated film"); Present stays top-right; speaker notes are gone; the bar gains a voice (dictation) button in both modes, on Treatment and Make.

## C · Surfaces

**C1 "How Particl works" (the logo page).** Features as full-bleed live screens with selling copy, not cards; headed "12 features you didn't know you needed"; a band for Atomik ("a proprietary agent that knows what to ask and does what its asked"); the philosophy line; "Built by filmmakers for likeminded filmmakers"; no "Show me on my film" on this page (it stays as a teaching device in the product, R13 correction, 21 Oct; confirmed 23 Oct); no "built for small teams"; no Shortcuts section; the engine list carries each vendor's mark; under every plan and pack, "What it buys" at Director prices with a footnote, the figures regenerated from the rate card before publishing (§ Pricing: every price in a design is a sample). Vendor marks on a "works with" list are nominative use; counsel confirms before launch, as with R16's manifests.

*Answered 23 October 2026 (the owner): "Show me on my film" stays inside the product, on the ? cards only, and is gone from "How Particl works". Vendor marks are not blocking; counsel confirms before launch. The How page's figures (the plan row Explore · Create · Master · Business · Enterprise, the engine cards' sample prices and every "What it buys" line) are samples (rule 14): CLAUDE.md § Pricing is the only source, and the "What it buys" lines are regenerated from the rate card before publishing.*

**C2 Home.** One bar; no Settings tile on Home (Settings from the avatar and the + menu).

**C3 Make.** The wall is headed "Library" (no "Made here", no "Kept"); it fills the width; drag from the Library (wall or panel) into the composer makes a reference tile and an @-mention; the composer carries a folded Settings row whose values are remembered.

**C4 Elements.** Double-click a group header to rename it; a group moves only by its tab; moving an element inside a group makes space and grows the group. World is a first-class kind: "+ World" in the group menu and the New node menu; from an environment, from dropped photos, a panorama or a clip, or from a line.

**C5 Copy.** "Copy like 'Just make it. The same quote. No questions' is amateur copy. Revise the copy across the platform and make it more polished, technical, single worded (wherever possible) and crisp." Buttons are one word; labels are nouns; no line over eight words survives unrewritten; cut what the screen shows (rule 9). Retired lines: "Just make it", "No questions", "the editor is the director's", "Storyboard · N kept from Look" on the canvas.

**C6 The pill.** The mark and the wordmark on every page, every size; the wordmark on a transparent background (v31.9). "Rig" stays a UI word (18 Oct).

## D · Engines and vendors (22 Oct, with the advisor; each adapter lands as a tool in the registry first, rule 11)

**D1 Ideogram 4.5** joins the catalogue for words that read and precise edits (Fix the label, Colorways, Swap the material, Look test, Lettering, Title/End card, the Words row on Deliver, "Fix the text" everywhere). Named only in Director's Engine tab and on the engine list. Keys `IDEOGRAM_API_KEY`, `IDEOGRAM_ENABLED`. **[money]** new rate-card rows.

**D2 World Labs Marble** joins as the World kind: a world from an environment, photos, a panorama, a clip or a line; Light it as the Look; Angle (a still that lands as a frame or a start frame); Move (a camera-move clip that lands as a Reference clip on a take, or as the shot in the Pre-vis type, Moves only); a World page in the Treatment; "Export the world · mesh · splat · free"; Worlds in the Library's types; angles and moves rendered on our own Blender worker. Keys `WORLDLABS_API_KEY`, `WORLDLABS_ENABLED`. **[money]** new rate-card rows (world, angle, move, relight). **[schema]** Library kind World.

**D3 Docling replaces LibreOffice + Tesseract** for reading documents (briefs, decks, scans). Polotno stays under the Treatment.

**D4 SAM (on fal)** for selections and masks; the still-edit engines (FLUX.2, GPT Image, Nano Banana, Seedream, Ideogram) and the clip-edit engines (Seedance edit, Higgsfield replace on the API key, Kling, Luma Modify, Wan VACE, Runway Aleph 2) are chosen by bake-off under $20 each, on the owner's yes, in the house workspace (rule 1). Runway's and Luma's attribution clauses go to counsel before either ships.

**D5 Remotion Editor Starter** (a one-time licence; its price is in the private notes, not this public file) is bought only after its fixed 30 fps and missing transitions are confirmed acceptable against Edit's eleven transitions (13 Oct Remotion decision stands).

**D6 Gemini stays on AI Studio** (`generativelanguage.googleapis.com`); Agent Platform is adapter work, not a key swap.

## E · Atomik's thinking: three settings (22 Oct, evening) [money]

The owner, verbatim, with the model names and efforts taken out: "lets have 3 settings. High (…) Medium (…) Low (…) (never disclose to the user the models and effort settings".

*23 October 2026 (the owner): the model names and efforts are removed from this file. The repo says only this: Thinking has three slots, High · Medium · Low, each env-set and each a Claude model; the mapping lives in Coolify and in the owner's private policy, never in the repo. The Treatment writer is an OpenAI model, env-set.*

- Atomik's thinking has three settings, shown to the person only as **High · Medium · Low** under the word "Thinking". The model behind each and its reasoning effort are never shown: not in the UI, History, receipts, exports, the API, error messages or "How Particl works". The three slots are env-set (`ATOMIK_THINKING`, read by `lib/atomikModelPolicy.ts`), Claude models only; the repo holds no model id or effort for them. A test proves no model id or effort string reaches any rendered string or API response (it extends the no-engine-name test to thinking models).
- *The mapping that stood here is removed (23 October 2026): it lives in Coolify and the owner's private policy.* The three slots replace the 28 Sept policy's default for Atomik's thinking; the OpenAI family stays for the Treatment's text only (below); the xAI family leaves the allowlist in the same PR (confirmed 23 Oct, M).
- Where it is set: per production, at the Brief, default Medium; a workspace admin may set the workspace default; the Preflight shows "Thinking · Medium · Change" with its band price. The judge (Reviewing), digests and routine turns run at Low whatever the setting unless the setting is High; the interview, the plan and every Writing · Design turn run at the setting.
- **[money]** Each setting has its own band rates in the private policy, priced through the price path; a higher setting is a higher "up to N cr". Nothing is charged for the setting itself. Open: whether a High turn is priced as a ceiling (recommended: yes, as every band is, B2).
- **Treatment text (22 Oct, 22:47, corrected 22:51).** The owner: the Treatment writer, an OpenAI model, env-set, writes all the prose in the Treatment deck (idea, logline, story, director's note, characters, world, tone, every section's words) and nothing else; Claude, at the production's Thinking setting, composes everything else: the outline's structure, the pages' design, the system, and every other step. The OpenAI family stays on the allowlist for this one job only, env-set as `TREATMENT_WRITER_MODEL`, never shown. *(23 October 2026: the owner sets `TREATMENT_WRITER_MODEL` in Coolify; until he does, the Treatment's prose step refuses with "Nothing billed".)* [money] its band rate sits with the others.
- **Rates for the band maths.** The per-token rates the owner pasted at 22 Oct 23:01 are kept in the private policy, not in this public file (standing rule: no vendor prices in a public file; removed by the lead on 23 Oct). A long record read is mostly cached input, which is why the digest-plus-index memory design keeps a High turn affordable. The Treatment writer's rate is still to be read off the OpenAI console.
- ~~**NEEDS AKSHAY:** confirm the xAI family leaves the Atomik allowlist, and the High setting's API rate for the band maths.~~ *Answered 23 October 2026: xAI leaves Atomik's thinking, confirmed. The band rates are the owner's and private.*


## F · The design lock (22 Oct, 23:53)

The owner: "lets put this into lead." Prototype **v31.16** (`Particl_Prototype_v31.16.zip`) is THE design, per the 18 October decision ("No interface work starts until that zip is in the repo as THE design"). It lands in the repo as `design/particl-v31.16/` *(23 October 2026: moved from `docs/design/v31.16/` to where the one-design guard expects the design; it replaces design/particl-prototype-15/, removed in the same PR, git history keeps it; design/particl-prototype-12/ stays the one reference)* with its README.txt as the screen map (every `?view=…&step=…&mode=…` state is a screen the product must have) and its CHANGES.txt as the change record; the prompts v31.7 → v31.16 land beside it as `docs/design/prompts/`. The p311-*.js files are a throwaway rendering of the design, never a source: the lead builds from the README, the prompts and the screens, with the components the repo already has.

*Prices in the design (23 October 2026): every price in a design is a sample (rule 14). CLAUDE.md § Pricing is the only source, through the server's price path. That covers every figure the screens draw (quotes, chips, the Preflight, receipts, Top up), the How page's plan row (Explore · Create · Master · Business · Enterprise) and its engine cards, and the sample figures quoted in this amendment (G, J). The How page's "What it buys" lines are regenerated from the rate card before publishing.*

Known defects in v31.16 that the lead does not reproduce and Claude Design fixes in v31.17: a new node can still land over another card; the console reports `<path d="{{ p.d }}">` on load; the Thinking row in the Brief's read-back is below the fold at 1440.

Three things the owner settled on 22 October about what may change after the lock, the advisor's conditions accepted: all copy lives in one strings table from the first PR (never inline in components), so copy changes are data PRs guarded by the forbidden-words test; "How Particl works" is a static page built last, from the real screens; the lead builds from the design's intent, not the prototype's code. Locked: the step order; the pill · rail · canvas · bar · panel structure; Keep and Sent; the money surfaces (quote, Preflight, receipt, Top up); the Atomik tab (questions in the panel, never on the bar); the record. Adjustable in flight: words, the How page, pill sizes, which quick starts show.

## G · The stepset: one block per step

The SOW has the rules (R1–R18) and the dataset (D1–D8) but no per-step specification. Each step gets one block in this shape; the block is the contract the lead builds and tests against:

```
STEP <name> · rail <film type> · position <n of 10>
READS      which record rows and digests it loads before it thinks
DOES       the proposal it makes first (R3: judge, don't specify)
ASKS       the checklist rows that may be open here, one at a time (A1, 22 Oct),
           the shape of each (pick one / A-B / yes-no / tap the frame / upload),
           and what answers them without asking (brief field, earlier step, genre, house default)
CALLS      the tools in the registry it may run, and the engines behind them (Director names them; Agent never does)
THINKS ON  the production's Thinking setting (E: default Medium; the judge on the cheapest capable model)
WRITES     the rows it adds to the record: values with source, "said" lines, takes with reasons, approvals
CARRIES    what the next step inherits without being asked again (rule 13)
REVIEWS    what the Reviewing tick checks on the result and the one suggestion it may make (A2, 22 Oct)
PRICES     the bands and engine rows in its quote; what is free (no model ran)
NEVER      what this step must not do or show
TESTS      the mocked briefs that prove ASKS is deterministic (R2) and WRITES is complete (R7)
```

*Struck 23 October 2026 (the owner): THINKS ON's default named a model (the 28 Sept policy's old default). E wins: Thinking Medium is the default.*

The ten blocks, as the product stands on 22 October (Agent sequence S2 as amended: Brief → Script → Treatment → Elements → Look → Storyboard → Shots → Sound → Edit → Deliver). The blocks below are the owner's working draft of 22 October; ASKS lists the floor rows (section H) and the above-floor examples; the owner edits the rows, the lead builds and tests the blocks.

**1 · Brief**
- READS: nothing but the workspace's house defaults (D8), its cast and looks, and any imported document (Reading band, quoted as a ceiling, B2).
- DOES: the interview. Opens with "What are we making?"; a kind is chosen (the ten film types) or inferred from the first sentence; genre set once (R4).
- ASKS, one at a time, only the open rows: product or subject · the one thing it must say · who it is for · length and where it plays (sets aspect, frame rate, safe areas) · language(s) · tone inside the genre · real people, if any (consent) · what you already have (upload) · budget ceiling in credits, if the person wants one. A brief document answers most of these before the first question (R2: "Hindi VO" is never asked).
- CALLS: `read_document` (Docling), `transcribe` (minutes, ceiling), the Library search.
- WRITES: every brief row with its source (said / document / default / assumed); the interview as spoken; the kind, genre, aspect, fps, languages, deliverables.
- CARRIES: aspect, fps, look words, cast list, language, deliverables — into every step, never asked again.
- REVIEWS: the read-back page "How I'll make it" (R6): the plan, the steps, one price. One tap approves.
- PRICES: Reading band for documents; Writing band for the read-back; the plan's steps at their all-in prices.
- NEVER: a prompt asked of the person; an engine named; more than one question on a card.

**2 · Script**
- READS: the brief digest; the genre's pacing and beat count (D2).
- DOES: writes the script in Page view first (dialogue, action, VO), then the List; Cards come only from "Approve the script" (v31.10).
- ASKS: beat count, if the length allows more than one shape · VO or dialogue, if the brief is silent · the ending (on product / on line / on face) when the genre has no default.
- WRITES: the script as "said" lines by scene; the approved version as a commit; each card with its scene row.
- CARRIES: scenes, cast per scene, lines to be spoken (Sound), words to be seen on screen (Words).
- REVIEWS: length against the deliverable (a 30-second film with 90 seconds of dialogue is flagged with one fix: "Cut to 30 s · Writing · N cr").
- PRICES: Writing band; revisions are Writing turns, quoted.

**3 · Treatment**
- READS: brief, script, the genre's deck style (D2).
- DOES: writes the outline (Cover · Index · Idea · Logline · Story · Director's note · Characters · Wardrobe · World · Look and feel · Mood · Tone · Sound · Format · Credits), quotes it as one line; the pages come only after the outline is approved; the cover sets the system (palette, type, grid, image treatment) that flows to every page.
- ASKS: the deck's audience (client / internal / festival) · one reference deck, if any · which sections to drop.
- CALLS: `write_outline`, `design_pages` (Polotno under it), `lettering` (Ideogram for a title drawn as a picture), `narrate` (ElevenLabs), the client link.
- WRITES: the outline rows; the system; every page with its version; the client's comments as "said" lines with source = client.
- CARRIES: the system (palette, type) to Look as a starting proposal; the World page to Elements if a world exists.
- REVIEWS: overflowing text, a page without an image where the section needs one, a palette that fights the brief's look words.
- PRICES: Writing · Design bands per page; hand edits, moving, retyping and the client link are free.

**4 · Elements** (before Look, per the 21 Oct order)
- READS: the script's cast, props, places and products; the Library (a face already trained, a product already shot); consent rows.
- DOES: proposes the element list from the script ("4 cast · 3 props · 2 places · 1 product"); for each, a card made from references (uploaded) or from the line (generated); a world offered when more than two shots share a place.
- ASKS, per element kind (A3): Cast — a real person or made (consent if real) · age band · one reference or none · voice. Product — the packshot or photos · label kept legible (default yes) · finishes (Colorways). Environment — time of day · interior/exterior · make it a world. World — from the environment card, photos, a panorama, a clip or a line · light it as the Look (after Look exists). Words — the exact text · the surface it sits on.
- CALLS: `make_element` (stills engines by kind: a face on the identity engine; a product on the words-and-edits engine; an environment on the keyframe engine), `train_identity`, `make_world`, `fix_label`, `colorways`, `swap_material`, `segment` (SAM) for selections.
- WRITES: each element with its kind, source (uploaded / generated), references, consent, the takes kept and rejected with reasons, the group it sits in and its name.
- CARRIES: the cast sheet, the product's kept still, the world and its angles — into Storyboard and Shots as references; the voice to Sound.
- REVIEWS (the study, A2): is the face consistent across the sheet; is the label legible at the frame's size; does the environment match the time of day in the script; is a world worth making. At most one suggestion line.
- PRICES: per still or sheet; identity training per step; the world, its angles and moves as their own rows **[money]**.
- NEVER: a random question; a stock element (R13 correction); the vendor's name in Agent mode.

**5 · Look**
- READS: brief look words, the treatment's system, the elements' kept stills, the genre's palettes (D2).
- DOES: proposes three looks inside the genre, differing on the axis the genre cares about (R4); accepts a LUT or lighting references (v31.10); "Look test · 3 references" (Words engine) for a style from pictures.
- ASKS: warm/cool or the genre's axis · grain or clean · one reference frame to match, if any.
- WRITES: the kept look (palette, light, grain, lens feel as rows; the LUT file), the test cards.
- CARRIES: the look into every frame and take as rows the engines read; "Light it as" onto worlds.
- REVIEWS: a look whose light contradicts the script's time of day.

**6 · Storyboard**
- READS: script scenes, cast sheet, places and worlds, the look, the coverage patterns (D3), the genre's coverage bias (D2).
- DOES: plans coverage (R5: side of the line, time of day, light as scene rows set once), then draws frame by frame from the kept cast and look; "Frame from the world" when a place has one; "Play as a cut" (animatic, free). In Agent mode nothing is asked that the brief, Look or Elements answer: the person presses Generate (A5).
- ASKS: only coverage rows no pattern answers (a two-person dialogue's side of the line when the script gives no geography).
- CALLS: `plan_coverage` (model only), `make_frame`, `world_angle`, `fix_text`.
- WRITES: scene rows (line, time, light), each frame with shot size, angle, move, the elements in it, its source (drawn / from the world), kept/rejected with reason.
- CARRIES: each frame as the first frame of its shot; "Continue from here" seeds the next.
- REVIEWS: crossed line, missing reaction, wrong eyeline, with one-tap fixes ("Flip" · "Add reaction frame · 3 cr"); words in frame that don't read ("Fix the text").
- PRICES: per frame; the animatic free; Options priced.

**7 · Shots**
- READS: the frame, its scene rows, the look, the cast references, the world's move if one was drawn, the genre's duration and move defaults (D2), the rule library that turns rows into prompt lines (R10).
- DOES: shot by shot (R6): preflight, one quote for the plan; a draft first where the plan says so; the person's Keep on shot N releases N+1; "Shoot all" offered, never default. Director: the Take tab first on click (B2).
- ASKS: length, if the script's beat doesn't fix it · a move, if the frame doesn't imply one · dialogue on camera or VO, per shot, if the script is silent.
- CALLS: `make_take` (the video engines by stage: draft / hero; the world's reference clip as a camera-move input), `upscale`, `lip_sync`, `edit_clip` (replace / remove, bake-off pending).
- WRITES: every take with its engine and settings as agent-private rows (C1: Agent mode never shows them), the prompt as sent, cost, Kept or not, the reason on a reject, the fix count against the plan's allowance.
- CARRIES: kept takes to Sound and Edit; the running total against the plan.
- REVIEWS: the judge call on the take (B4: sampled frames with the shot's rows): did the face hold, did the label read, is the move the one asked for; one suggestion.
- PRICES: the engine row per take; fixes inside the allowance (two per shot) under the same approval; a third asks.
- NEVER: a take over an existing one; an engine named in Agent mode; a step started without its approval.

**8 · Sound**
- READS: the script's lines, each cast member's voice, the genre's moods and voice sets (D2), the kept takes' lengths.
- DOES: proposes VO or dialogue reads, music mood, ambience per scene, the mix; the Director's inspector shows sound rows only (B5).
- ASKS: the voice, if the cast has none bound · music licensed or made · the language order for VO.
- CALLS: `voice` (ElevenLabs / Sarvam for Indian languages), `music`, `ambience`, `lip_sync`, `mix`.
- WRITES: each line's read with its voice id (agent-private), the music cue, the mix levels, the sound settlement.
- CARRIES: the mix to Edit; per-language VO to Deliver.
- REVIEWS: a read longer than its shot; a level that masks dialogue.
- PRICES: per character for voice (the audio terms), per cue, the settlement cap (#877).

**9 · Edit**
- READS: kept takes, the mix, the script's order, the genre's rhythm and end-on default (D2).
- DOES: Agent: a first cut from the order and rhythm, re-cut from a sentence; Director: the suite (tracks, eleven transitions, mixer, versions). Remotion renders it on our worker.
- ASKS: end on product or on face, if the genre has no default · titles yes/no · captions language.
- CALLS: `cut` (model plans; Remotion renders), `title_card` / `end_card` (Words engine), `caption` (Whisper), `transition`.
- WRITES: the edit decision list per version, the titles, the render as a version row.
- CARRIES: the cut to Deliver as the master.
- REVIEWS: a cut over length; a title that doesn't read; a jump that the coverage didn't earn.
- PRICES: Atomik's re-cut as a Writing turn; renders free when nothing new is made; title cards priced.

**10 · Deliver**
- READS: the brief's deliverables and languages, the master, the per-language VO, the Words rows.
- DOES: the table (formats across, languages down, a price in every cell, previewed before Approve); the Words row per language; "Export the world".
- ASKS: nothing new: every row came from the brief. Only a size or language the brief didn't list.
- CALLS: `render` (Remotion, free when already made), `upscale` (4K only if the takes were made at 4K), `words_in_language`, `export_world`.
- WRITES: every master with its Particl file name (R16), the Sent commit (Keep and Sent, 19 Oct), the receipt.
- REVIEWS: a cell whose VO is missing; safe areas per format.
- PRICES: per cell; renders of what was made are free.

**Make** (no production) gets the same block, shorter: READS the Library; DOES one thing from one line with the composer's tiles; ASKS the kind and the ratio (Agent) and nothing else; CALLS the per-kind tools; WRITES to the Library with "made in Make" as source; REVIEWS the one result with one suggestion.

**The two cross-step blocks:**
- **The judge (Reviewing).** One prompt per asset kind listing what to look at, in your words (Part 3, item 6). Cheapest capable model; one pass per result, one more on a remake; never a line on the receipt; absorbed as B4 says (scope answered 23 October 2026, A2: every asset kind and the one suggestion line, still absorbed, no change to the quoted price).
- **Questions.** The question engine reads the step's checklist (D1), marks each row known / assumed / open from the record, orders the open rows by what changes the result or the price most, and asks the first; after each answer it re-marks (an answer often closes two rows) and asks the next. Deterministic and tested on mocked briefs (R2). "Decide for me" closes every open row with the agent's pick and shows them as "I assumed … · Change".

---


## H · The floor, and above the floor (amends R2 and D1)

The owner, 22 October: the checklist is the floor, not the ceiling. The rows that must be known before money moves are fixed, deterministic and tested — never asked when the brief answers them, always asked when it doesn't. Above the floor, Atomik (at the production's Thinking setting) asks whatever this film makes genuinely open, one question at a time, as many as it needs, from no list, and stops. R2's "at most three per step" is struck; R2's test ("a brief that says Hindi VO is never asked the language question") now applies to the floor rows and is extended: a brief that answers a floor row never produces its question; a brief that doesn't always does; no above-floor question repeats a row the record holds.

The floor, as drafted 22 October for the owner's strike-through (ids and sources are the lead's; questions, pills and defaults are the owner's):

*Answered 23 October 2026 (the owner): he is editing the floor rows' file. The engine builds the Ad film rows as drafted below until his edit lands.*

How a floor row behaves, every time:
- It is asked only if nothing already answers it: the brief document, the + menu's choice, an earlier step, a kept thing, or a house default (a row the workspace answered the same way three times). An answered row shows "from the brief · Change", never a question.
- It is asked exactly as written below: one line, at most four pills, a field for anything else, and Atomik's pick already lit as the default.
- "Decide for me" takes the lit pick for this row and every floor row still open at this step, and shows them as "I assumed … · Change".
- Its answer is written to the record with its source (said · brief · default · assumed) and carries into every later step; it is never asked again in any step.
- Tested on mocked briefs: a brief that answers a row never produces its question; a brief that doesn't always does.

The columns: **id** · the question as asked · the pills (the default lit, marked ★) · what answers it without asking · what it sets · why it is on the floor.

### Brief (the interview)

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| kind | What are we making? | Ad · Short film · Social · Music video · Other (the ten kinds behind Other) | the + menu's choice; the brief document | the rail, the genre set, every default below | everything is priced by kind |
| length | How long? | by kind — Ad: 15 s · 30 s ★ · 60 s · Other; Short film: 1 min · 3 min ★ · 5 min · Other; Social: 6 s · 15 s ★ · 30 s · Other | the brief; the deliverable list | shot count, script beats, the plan's price | the quote scales with it |
| plays | Where does it play? | TV and cinema 16:9 ★ · Phone 9:16 · Square 1:1 · Several | the brief; the client's spec | aspect, frame rate, safe areas, Deliver's rows | every frame and take is made at it; a change later remakes everything |
| language | Which language? | Hindi ★ · English · Both · Other | the brief; the script's lines; the house default | VO, titles, captions, Deliver's rows | voice is priced per language |
| real | Is anyone real in it? | No one ★ · Yes, and I have their consent · Yes, not yet · A real product only | the brief; the Library (a trained face with consent) | ~~the consent gate on Elements and Sound~~ the consent tick on Elements and Sound (who ticked, when, a file if one was attached); "uploaded" vs "generated" | ~~a real face or voice is never made without consent on file~~ a real face or voice carries its consent tick and "uploaded" origin; nothing refuses to make, train, clone or lip-sync for want of it (owner, 23 Oct 2026: consent is a tick, not a gate) |
| material | What do you already have? | Nothing yet ★ · A script or deck (drop it) · Photos or clips (drop them) · Both | the drop itself | the Reading price on the Preflight; Elements' sources | reading is priced; uploading is not |
| ceiling | A spend limit for this film? | No limit ★ · 200 cr · 500 cr · Other | the workspace's monthly limit; the house default | the production cap the plan is checked against | the only automatic stop besides the monthly limit |

Seven rows. A written brief of one paragraph usually answers four of them; the interview then asks three.

### Script

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| speech | Who speaks? | No one ★ · Voice over · On camera · Both | the brief; the script's lines | Sound's lip-sync rows (priced per shot) vs VO; the cast's voices | lip-sync is a priced step per shot |

### Treatment

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| narrated | Narrated? | No ★ · Yes, in the film's language · Yes, in another | the brief; the house default | the narration rows on the Export (priced per page read) | narration is priced |

(The client link, PDF and PPTX are free, so "who sees it" is above the floor.)

### Elements

Asked per element, only when it is first made; most rows are answered by Brief › real and material.

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| source | @name: from your references or made? | From photos (drop them) · Made from the line ★ | Brief › material; a drop | training (priced per step) vs a generated sheet | the two are priced differently |
| consent | @name is a real person. Consent on file? | Yes, attach it · Not yet · They're not real | Brief › real; the Library's consent row | ~~the consent gate: no face sheet, no voice, no lip-sync until Yes~~ the consent tick (who ticked, when, a file if one was attached); nothing waits for it (owner, 23 Oct 2026) | ~~nothing real is made without it~~ a person ticks it; Atomik never does (rule 11) |
| label | Keep the product's name legible? | Yes ★ · No, it's hidden | the brief; the product's photo | the words-that-read engine on product stills (priced differently) | it picks the engine and the price |

(Make a world, Colorways, Swap the material, Look test: offered with their price, never asked as questions.)

### Look

No floor rows. Three directions are proposed inside the genre; Keep is the answer. A dropped LUT or reference answers the look without a question.

### Storyboard

No floor rows. Coverage comes from the patterns (D3), side of the line and time of day from the script's scene rows; the person presses Generate. (If the script gives no geography for a two-person scene, the one coverage question is above the floor and asked only then.)

### Shots

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| stage | Draft first, or straight to final? | Draft first ★ · Final | the house default; the plan's approval | the draft row (480p) vs the hero row per take | it halves or doubles the per-shot price |
| takes | Takes a shot? | 1 · 2 ★ · 3 · 4 | the house default | the plan's count and total | the total is count × price |

### Sound

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| voice | Whose voice for @name? | A made voice ★ · Clone from an upload (consent) · One from the Library | Elements › consent; a voice already bound in the Library | the voice row, cloning (priced) vs a made voice | cloning a real voice is consent-gated and priced |
| music | Music: made, or your own file? | Made ★ · My file (drop it) · None | a drop; the brief | the music row (priced) vs a free import | one is priced, one isn't |

(Lip-sync inherits Script › speech; ambience and effects are proposed and Kept.)

### Edit

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| captions | Captions? | None ★ · In the film's language · Translated | Brief › language; Brief › plays (phone defaults to captions) | the caption row (priced by minutes) | priced |

(Title and end cards are offered with a price, not asked. Transitions, rhythm and end-on are proposed from the genre and Kept.)

### Deliver

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| masters | Masters at 1080p, or 4K? | 1080p ★ · 4K (only if the takes were made at 4K; else "4K · upscaled · N cr") | Brief › plays; the takes' resolution | the table's resolution row | 4K is priced; a refused 4K says why |
| extras | Any other size or language? | No ★ · Another size · Another language · Both | Brief › plays and language | extra columns and rows, priced per cell | each cell is priced |

### Make (no production)

| id | Question | Pills | Answered by | Sets | Why floor |
|---|---|---|---|---|---|
| kind | — (the chip) | Still ★ · Clip · Product shot · Face · Look test · Change a picture | the chip or the quick start | the engine stage and price | priced by kind |
| ratio | — (the chip) | 16:9 ★ · 9:16 · 1:1 · 4:5 | the last thing made (remembered) | the frame | made at it |
| length | — (the chip, clips only) | 5 s ★ · 10 s · 15 s | remembered | the clip's price | priced per second |
| count | — (the chip) | 1 ★ · 2 · 3 · 4 | remembered | the total | count × price |

On Make these are chips on the composer, never questions; a missing one is asked once, in the Atomik tab, before the quote.

### Totals

Twenty-two rows across the whole production, seven of them at the Brief. For an Ad film with a one-page brief and a kept cast, a stranger is typically asked: three at the Brief, one at Script, two at Shots, one at Sound, one at Deliver — eight taps from brief to masters. Everything else Atomik either knows, proposes for a Keep, or asks above the floor because this particular film made it necessary.


## I · The film record: how context is held [schema]

*Answered 23 October 2026 (the owner): the record schema is docs/film-record-schema.md, its own docs PR (#885). The owner reads it before any migration.*

The owner (22 Oct): "Memory of each step is the most important thing and context needs to be held infinitely / or needs to be ascertained by a thorough memory log (never shown to the user)." A model's window is not infinite (the largest Atomik can use today is on the order of a million tokens, and cost rises with every token read). So the product never relies on the window. It relies on the **film record** (R7), and the window is only ever a view into it. Four layers, all tenant rows in Turso, all behind `workspace_id` (rule 2), none shown to the person as a log:

1. **The workspace memory** — what is true across productions: house defaults (D8: a row answered the same way three times becomes the default and stops being asked), the trained faces with consent, kept looks and LUTs, the brand's words and colours, the workspace's own vocabulary ("our packshot"), engine preferences a Director set. Read at the start of every production. Never crosses a workspace.
2. **The production record** — one per film, the LangGraph state, checkpointed after every turn: every checklist row with value and source (said / document / earlier step / default / assumed); every "said" line with step and source (the interview, prompts, notes, comments, titles, bar commands, the client's comments); every element, frame, take, cue and version with its state (draft → picked → Kept; Sent on output steps), its cost and its reason when rejected; every approval (who, when, the quote it approved, the allowance left); the Director's engine and settings per shot as agent-private rows; the ripple list (which downstream rows a changed row touches).
3. **The step digest** — a short, regenerated summary per step (what was decided, what was made, what is open), written by the model at the end of each turn and stored as a row. Every turn loads **all** digests (so Deliver knows what was said at Brief) and the **full** rows of the step it is on. Full rows of other steps are fetched on demand through the index when a question needs them ("what did they say at Brief about the label"). That is how context is "infinite": nothing is ever dropped; only the detail is folded until asked for.
4. **The turn context** — what one model call actually sees: the system rules for the step, the step's checklist, all digests, the current step's rows, the Library search results it asked for, and the person's latest words. Built fresh every turn from layers 1–3, never carried as a chat history. A chat history grows and forgets; a record is complete.

What the memory must guarantee, and the test for each (these go in the SOW as acceptance):
- **Completeness:** at Deliver, for every mocked film, Atomik answers "what did they say at Brief about X" from the record alone (R7's test).
- **Nothing asked twice:** a row with a value is never an open question again, in any step (R2 test on mocked briefs).
- **Ripple:** change the aspect at Brief after Shots exist → the record lists every frame and take it touches and offers "Carry the change" at a price; nothing is remade silently.
- **Both modes write:** a Director-first project's first Agent turn opens with a read-back assembled from Director rows (C2), never "What are we making?".
- **Mode separation:** Agent mode never surfaces an agent-private row (engine, settings, vendor), not in the read-back, History, receipts or errors (17–18 Oct).
- **Never shown:** no screen, export or API lists the record as a log; the person sees it only as the read-back, "I assumed … · Change", the Versions chain and the receipt.
- **Tracing:** Langfuse records which row ids each turn read and how long it took, ids and timings only, never words (rule 17, R7). The interview as spoken lives in Turso and nowhere else.
- **Privacy and consent:** a real person's face or voice carries its consent row; a record never leaves its workspace; nothing in it trains anything.
- **Durability:** a turn that fails mid-way leaves the record as it was (checkpoint before, commit after); a session that ends resumes from the record, not from a chat.
- **Size:** digests are bounded (a few hundred words each); full rows are indexed; a production with 200 takes loads no slower than one with 10.

The memory log the person never sees is exactly layer 2 plus the digests. There is no second, hidden "notes" file: if Atomik knows it, it is a row with a source, and that is what makes it auditable, exportable and deletable with the production.

---


## J · The Director never starts from a blank prompt (22 Oct, 23:22–23:53; amends R8, R10 and rule 13)

The owner asked whether the node system is useful and whether Director mode means less prompting; the decision:

- **The canvas is a board, not a node graph.** Wires are drawn to show where a take's face, place, look and start frame came from (on hover and selection) and are never required; the Inputs rows are the wiring; no screen asks a person to draw a wire; no copy calls it a node system.
- **Every Director node is born filled from the record:** a shot carries its script line, its cast and place as Inputs, the Look's light and the Storyboard frame as its start frame; an element its line and its kind's settings; a frame its scene row and cast. Nothing decided earlier is typed again (rule 13, now for Director mode too).
- **The Prompt row.** The Inspector's Settings tab opens with "Prompt · as it will be sent": the prompt assembled from the node's line, its Inputs and the pickers' lines through the rule library (R10), editable in place; a picker change rewrites its line and leaves the Director's words alone. Assembly is deterministic — no model runs — so it is free (B3) and carries no price.
- **Two priced chips under it, prices live from what each reads, never fixed:** **✦ Enhance · N cr** (polishes the line as written, reading the line and the Setup; samples 1 cr for a short line, 2 cr for a long line in a heavy script — the 19 Oct rule unchanged) and **Compose · up to N cr** (Atomik writes the prompt in full from the record; reads the digests and the step's rows, so the figure rises with the record's size and the production's Thinking; samples up to 3 cr at Medium, up to 5 cr at High; a band, settles at what it used, B2). Either result replaces the row's text with Undo. **[money]** two rows through the price path; the figures are the owner's.
- **The bar is for the change**, not the description: "Change something · tighter, from below, warmer"; what is typed is applied to the Prompt row as an edit. "Describe the node · the whole prompt" is retired.
- **Again with…** on every take: a duplicate with every setting and the Prompt row, the Inspector opened on it; free until Generate.
- **The Take tab** shows the prompt as sent, read-only, for every take.
- **No agent factor:** the Director chose the engine, so a pre-filled or Composed Director job is Director-priced (rule 11 as amended 21 Oct); Compose's own price is the only Atomik charge.
- **Monetisation (the owner: "makes sense"):** the fill is free; Compose is priced; the feature earns through the plan (the record is why a Director stays), engine margin (more takes, fewer wasted) and lower house cost. Measured under rule 17: first-take keep rate and takes per session in Director mode, ids only.

## K · The dataset additions (D1–D8, extended)

- **D1 Checklists** become two tables: the floor rows (section H, fixed, tested) and the above-floor examples per step (an example bank for the model, never a list it is limited to).
- **D2 Genre table:** unchanged; the owner writes the rows; the advisor supplies the empty table with one filled example row per step.
- **D9 The judge's eye [new]:** per asset kind (face, product, environment, world, frame, take, read, cut), the owner's list of what he looks at and what he rejects, in his words; it is the Reviewing prompt for that kind (A2) and the source of the one suggestion line.
- **D10 Golden productions [new]:** Mirror and Sand as complete mocked records, every row filled as a real production would fill it, the owner's decisions as the right answers; every question-engine, ripple and read-back test runs against them.
- **D11 Brief fixtures [new]:** three of the owner's own past briefs, client and product names stripped (rule 3), in the shapes people send (a PDF deck, a WhatsApp paragraph, a voice note), for Reading, transcription and the floor tests.
- **D12 The copy table [new]:** every string the product shows, in one table (`lib/copy.ts` or equivalent) with the forbidden-words test over it; rule C5's voice (short, technical, one-word buttons, "Decide for me" the one multi-word button, R3).
- **D13 Thinking [new]:** the three settings and their band rates (E), three env-set slots, Claude models only (the mapping in Coolify and the owner's private policy, never in the repo; 23 Oct 2026), with the no-model-name test.

## L · The PR plan (phase order, small PRs, rule 8)

Docs first, then code; every money row under its own review; every schema change flagged before migration; nothing on main from the lead; the design zip and this amendment arrive from the owner.

1. **Docs PR:** this amendment into docs/particl-sow-v1.md, docs/redesign-plan.md "Owner decisions" and CLAUDE.md "Owner decisions since 10 Oct 2026"; `design/particl-v31.16/` with the zip's contents (23 Oct 2026: moved from `docs/design/v31.16/`, replacing design/particl-prototype-15/; F) and `docs/design/prompts/` with v31.7–v31.16; the glossary draft untouched.
2. **The copy table and the strings test** (D12): every rendered string moved into one table; `tests/helpers/uiStrings.ts` extended with today's retired lines ("Just make it", "No questions", "the editor is the director's", "Show me on my film" outside the ? cards, "built for small teams", "How many", "Describe the node") and the no-model-name rule (E, D13).
3. **The model policy PR:** `ATOMIK_THINKING` (High · Medium · Low, three env-set slots, Claude models only; the mapping in Coolify and the owner's private policy), `TREATMENT_WRITER_MODEL` (an OpenAI model, env-set; 23 Oct 2026), xAI leaves the Atomik allowlist, the test that no model id or effort string reaches a rendered string or an API response. Band rates stay in the private policy; this PR carries no figure.
4. **The record [schema]:** the four layers of section I as tables with their columns, the digest rule, the index, the checkpoint rule, the tracing rule (ids only), the ten acceptance tests; the Mirror and Sand golden records (D10) as fixtures; the owner's yes before the migration.
5. **The question engine on the Brief:** the floor rows (H) for the Ad film, known / assumed / open from the record, one question at a time, "Decide for me", the Atomik tab in the panel; above-floor questions on; mocked-brief tests and the D11 fixtures.
6. **One step a PR in S2 order** (Script → Treatment → Elements → Look → Storyboard → Shots → Sound → Edit → Deliver), each with its block from G, its floor rows, its digests, and its mocked tests; the Director's Take tab, remembered settings, one Generate · N cr, and the Prompt row (J) alongside each step that has nodes. [money] rows (Enhance live, Compose) under their reviews.
7. **Adapters as registry tools, on a second lane:** Docling replacing LibreOffice + Tesseract (#819/#837 context); SAM on fal for selections; Ideogram 4.5 (`IDEOGRAM_API_KEY`, `IDEOGRAM_ENABLED`); World Labs Marble (`WORLDLABS_API_KEY`, `WORLDLABS_ENABLED`; Library kind World [schema]; the Blender angle and move renders on our worker); each with a mocked test proving an agent can run it; bake-offs only on the owner's yes under $20 each in the house workspace (rule 1).
8. **The judge** (A2, D9) last on each step, once that step's outputs exist, scope per the owner's answer to A2 (23 Oct 2026: every asset kind and the one suggestion line).
9. **"How Particl works"** last, static, from the real screens, with the engine marks and the "What it buys" lines regenerated from the rate card.
10. **Measurement (rule 17):** time to first render, approvals per session, where people stop, first-take keep rate in Director mode; ids and timings only.

## M · What is not in this amendment, and what is open
Money behaviour (the 18–21 Oct decisions) is unchanged except where A2 asks the owner a question. Nothing here changes a price, a cap or an approval; the new rate-card rows in D1–D2 come with their own money PRs.

~~Open for the owner, 22 October: the judge's scope (A2); "Show me on my film" inside the product (C1); vendor marks to counsel (C1); the High setting's band rates (E); the Treatment writer's API id and rate (E); the floor rows' strike-through (H); the record schema's yes (I, before migration).~~ All answered 23 October 2026, below.

**The owner's answers, 23 October 2026 (10:30 IST).** Each open item above is answered:
- **The judge's scope (A2): answered.** B4 of 21 Oct widens to every asset kind and to the one suggestion line. The cost stays absorbed in the agent factor, never a line, and the quoted price does not change.
- **"Show me on my film" (C1): answered.** It stays inside the product, on the ? cards only. It is gone from "How Particl works".
- **Vendor marks (C1): answered.** Not blocking. Counsel confirms before launch.
- **xAI leaves Atomik's thinking (E): answered.** Confirmed. The band rates are the owner's and private.
- **The Treatment writer's model id (E): answered.** The owner sets `TREATMENT_WRITER_MODEL` in Coolify. Until then, the refusal with "Nothing billed" stands.
- **The floor rows (H): answered.** The owner is editing the file. The engine builds the Ad film rows as drafted until his edit lands.
- **The record schema (I): answered.** docs/film-record-schema.md is its own docs PR (#885). The owner reads it before any migration.

**Corrections, 23 October 2026.** B4 is corrected: the design wins (B). G's THINKS ON default is struck: E wins, Thinking Medium is the default (G). The Thinking mapping and the Treatment writer's model are out of this file (E). Every price in the design is a sample; § Pricing is the only source (F). The design lives at `design/particl-v31.16/` (F).
