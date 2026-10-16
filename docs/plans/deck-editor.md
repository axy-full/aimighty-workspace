# The treatment builder: our own deck editor (spec, build after 31 Oct)

**Draft, 16 Oct 2026. Docs only. Build starts Mon 2 Nov, after the investor demo.** Owner, 16 Oct 2026, 15:05 IST, item 3: "DECKS: 2SLIDES PARKED, WE BUILD OUR OWN TREATMENT BUILDER (after 31 Oct; spec in docs/plans/deck-editor.md). Do NOT wire the 2Slides API; drop it from the env plan." (`docs/redesign-plan.md`, last section.) **2Slides is parked and not wired. Google Stitch is not a deck engine; do not build on it.** For the 31 Oct demo the deck is the Chromium PDF (#767, Treatment cover and Pitch cover), not this builder.

**No pricing, margins, multipliers or vendor costs appear in this document** (the repo is public). Where a price matters, the product shows it from the server's price path, and any figure is "with the lead (private)".

## Part 1. The owner's words

### 1.1 Section 3, a to i, and the section library (verbatim)

The owner's 15:05 note carries the treatment builder's flow (items a to i) and the section library. The repo's record (`docs/redesign-plan.md`, section 3) says only: "The full flow, section library and spikes are as the owner wrote them; docs/plans/deck-editor.md carries them verbatim." The lead pasted the verbatim text below (it holds no pricing policy).

> **3) DECKS: 2SLIDES PARKED, WE BUILD OUR OWN TREATMENT BUILDER (after 31 Oct; spec now in docs/plans/deck-editor.md)**
> I tested 2Slides hands-on: its premium mode is Nano Banana Pro rendering each page as an image with text baked in; "editing" means rewriting two prompt boxes and regenerating the whole page (~100 credits); it invented credits on our cover; Fast PPT has no editor. So: do NOT wire the 2Slides API; drop it from the env plan. Keep its good ideas: "What it says" + "How it looks" per page, style reference image per deck and per page, page rail with status, slideshow, per-page narration exported as video.
> Flow:
>  a. Opening questions: tone, genre, idea/script/treatment thought (optional), director, client and agency names + logos (missing logos: offer to fetch via a reputable logo service such as Brandfetch, prefer SVG, the user confirms).
>  b. How it looks first: the design engine turns tone, genre, brand colours and script into a design brief; the cover art engine makes the cover (Recraft vector/SVG where possible). Text stays live on top (DOM, brand fonts), never baked into images. The cover sets the deck's theme: fonts, sizes, spacing, header style, colours, ornaments.
>  c. Contents: ask what the treatment should include; map the user's words to the section library (below) with synonyms; propose an order; confirm. Then an Index page.
>  d. What it says: the text engine writes each page from the idea and project data; never invents names, credits or facts (unknowns become marked blanks).
>  e. Page types: heading, sub-heading, content; each inherits the cover's theme.
>  f. Mood board: a template page to paste and arrange own images, or "arrange it for me". NEVER crop, squeeze, stretch or change aspect ratio automatically; frames adapt to each image; crop/scale are manual tools. Originals byte-identical, full resolution, uncompressed in exports.
>  g. Motion pages (GIF page, video viewer, animatic): play in Present mode and on the review link; PDF shows a poster frame + link/QR.
>  h. Two-layer pages (visual layer from our engines or a board frame; live text/layout layer on top); live links to the board (a re-render or approval updates the page); v25 card statuses per page; present mode with video playing; per-page narration (ElevenLabs/Sarvam) exported as a treatment film; PDF + editable PPTX; crisp at 5K/6K; Liveblocks collaboration.
>  i. Agent mode: engines chosen by us. Director mode: every step (design, cover art, text, images) offers the full engine list.
>
> Section library (with synonyms users type): Cover/home page/title · Index/contents/structure · Logline · Synopsis/story/narrative · Concept/big idea · Director's note/intent/vision/approach · Insight/why this film · Beats/structure/timeline · Characters/casting/talent · Performance · Wardrobe/styling · Hair & make-up · Locations/setting/production design/art direction · Props/product · Mood board/references · Tone/look & feel/mood · Palette/colour/grade · Lighting · Camera/lensing/framing/composition · Camera movement · Texture/format · Edit/pacing/rhythm · Transitions · Typography/supers/titles · VFX/CG/animation · GIF page/motion study · Video viewer/animatic/reference film · Sound design · Music/score · Voice-over · Product/hero shots · Brand integration · End frame/pack shot/CTA · Cutdowns/versions/deliverables · Formats/aspect ratios · Production plan/schedule · Crew/credits · About the director/showreel/previous work · Thank you. Teach the models with this library, instructions and 3 example treatments; no fine-tuning.
> Spike first (1 day each, mocks only): (a) our own editor from the v25 card components + Tiptap + an MIT drag/resize library: 3 pages, text sharpness at 3008×1692 @2×, undo/redo, PDF + PPTX export; (b) Polotno SDK on its trial, same 3 pages, plus a licence quote. Recommend one with evidence.

Part 2 is reconciled with this text (16 Oct, after the lead pasted it).

### 1.2 Section 4, EDITING IS THE CORNERSTONE (verbatim, from `docs/redesign-plan.md`)

> **4) EDITING IS THE CORNERSTONE** (deck first, then every output in the app)
> - Click any element to edit it (text, image, colour, position, size); a text change never costs a render.
> - Regenerate one thing only (one image, one paragraph, one page visual), never the whole deck.
> - "Change this…" on any selection in plain words, using the mode's engine choice.
> - Version history per page and per element: compare side by side, restore any.
> - Unlimited undo/redo, lock elements, comments, duplicate a page to try an alternative.
>
> Apply the same standard to board cards, shots and stills: every output is editable at the smallest unit.

The app-wide version of this is `docs/plans/editing-standard.md`.

### 1.3 The public part of the owner's Agent and Director note (from the same section 2, as recorded)

- **Agent mode:** Particl picks engines, plans, writes, designs and checks. No engine names are shown. Each Agent quote is one all-in credit price, shown before approval and charged exactly, with no breakdown.
- **Director mode:** every feature offers as many engines as we can (text, image, cover/design, video, voice, lip-sync, upscale, music), each with name, strengths, limits and price per unit, on all plans.

## Part 2. The buildable spec

**Reconciled with the owner's section 3 (1.1) on 16 Oct.** Where a point below is the owner's own, it cites the item (3a to 3i, library). Points not in his text are marked **(added)**; they are proposals for him to accept or strike. 

Rules that bind every part: tenant isolation (every table carries `workspace_id`, every query filters on it, every file path is prefixed by it); rule 11 (a feature is a tool in the registry before it gets a button); rule 14 (only a person approves spend; the price is on the button); rule 13 (everything saves itself; undo instead of confirmations); rule 15 (readable dark) and the 5K sharpness checklist (`docs/plans/sharpness-5k.md`).

**What we keep from 2Slides (3, the owner):** "What it says" and "How it looks" per page; a style reference image per deck and per page; a page rail with status; a slideshow; per-page narration exported as video. **What we do differently:** pages are never one image with the text baked in; editing is never "rewrite two prompt boxes and regenerate the whole page"; credits and names are never invented.

### 2.1 Data model

| Object | Fields (summary) | Notes |
|---|---|---|
| **Deck** | id, `workspace_id`, board/project id, kind (`treatment`, `pitch`, `ppm`) (added), cover style (`treatment` or `pitch`), theme id, style reference (asset), page order, status, created by, version counter | One deck per board output; a board can hold several |
| **Theme** | fonts, sizes, spacing, header style, colours, ornaments, logo (asset ref), mood-image refs | **Set by the cover** (3b): "fonts, sizes, spacing, header style, colours, ornaments"; every later page inherits it (3e). Changing the theme re-flows live text without re-rendering pictures |
| **Page** | id, deck id, order, **page type** (heading, sub-heading, content: 3e), library section id (or custom), title, **visual layer**, **text/layout layer**, style reference override (asset), status (the v25 card status: Not started, Making…, Ready, ✓ Approved, ✕ reason: 3h), narration text, motion settings | A page rail shows each page's status |
| **Visual layer** | one image or frame from **our engines or a board frame** (3h); a mood-board page's visual layer is the arrangement of the person's pictures | A picture, never text. Linked to a board card when it comes from one |
| **Text/layout layer** | live elements on top of the visual layer: text (DOM, brand fonts), shapes, logo, colour, placeholders, data | **Live text: never baked into the image** (3b) |
| **Element** | id, page id, layer (`visual` or `text/layout`), kind (`text`, `image`, `shape`, `logo`, `colour`, `placeholder`, `video`, `gif`), box (x, y, w, h in page units), z-order, locked, content or asset ref, style, link to a board card, motion | The smallest editable unit. Text is rich text (Tiptap document) |
| **Asset** | id, `workspace_id`, storage path, **content hash**, original name, kind, dimensions | **Originals byte-identical, full resolution, uncompressed in exports** (3f); every crop, scale or compression is a derived rendition pointing at the original and its hash |
| **PageVersion** / **ElementVersion** | id, subject, number, author, time, snapshot, reason (edit, regenerate, restore, theme change, card update) | Append-only; restoring writes a new version; nothing is erased |
| **Comment** | id, subject (page or element), author, text, resolved | Per page and per element |
| **CardLink** | page or element id, board id, card id, card version | **Live links to the board (3h): a re-render or an approval on the card updates the page.** The update writes a new page version, so it is undoable and comparable; a person can pin a link to a version to stop updates. **(added: the pin)** |

A deck saves itself on every change (rule 13). Atomik and outside agents read and write it only through the tools in 2.10.

### 2.2 The flow

Each screen has one primary action, the next step (rule 13). Agent mode runs the same steps with Atomik asking and filling; Director mode shows the settings and the engine lists (2.12).

1. **Opening questions (3a).** Tone, genre; the idea, script or treatment thought (optional); director; client and agency names and logos. What the brief already says is not asked again. **Missing logos:** offer to fetch them through a reputable logo service such as Brandfetch, prefer SVG, **the user confirms** (2.9).
2. **How it looks, first (3b).** The **design engine** turns tone, genre, brand colours and script into a design brief; the **cover-art engine** makes the cover (**Recraft vector/SVG where possible**). Text stays **live on top** (DOM, brand fonts), never baked into the image. **The cover sets the deck's theme**: fonts, sizes, spacing, header style, colours, ornaments. A style reference image can be set per deck and per page.
3. **Contents (3c).** Ask what the treatment should include; **map the person's words to the section library with synonyms** (the library and its synonyms are in 1.1; unmapped words become custom pages, not dropped); propose an order; the person confirms. Then an **Index page**.
4. **What it says (3d).** The **text engine** writes each page from the idea and the project data. **It never invents names, credits or facts: unknowns become marked blanks** (2.8). Each page has "What it says" and "How it looks" (kept from 2Slides).
5. **Page types (3e).** Heading, sub-heading, content; **each inherits the cover's theme**. A section from the library fills a page type with the section's content. Changing a page's type keeps its content where it fits.
6. **Mood board (3f).** A template page where the person **pastes and arranges their own images**, or says **"arrange it for me"**. Rules in 2.4.
7. **Motion pages (3g).** GIF page, video viewer, animatic: see 2.5.
8. **Review and share.** Page rail with status, slideshow (Present mode), comments, review link, exports (2.6), narration film (2.7).

### 2.3 The section library and page types

The **page types** are the owner's three: heading, sub-heading, content (3e). The **sections** a person can choose are the owner's library in 1.1 (Cover/home page/title; Index/contents/structure; Logline; Synopsis; Concept; Director's note; Insight; Beats; Characters; Performance; Wardrobe; Hair & make-up; Locations; Props/product; Mood board; Tone; Palette; Lighting; Camera; Camera movement; Texture/format; Edit/pacing; Transitions; Typography/supers; VFX/CG/animation; GIF page; Video viewer/animatic; Sound design; Music/score; Voice-over; Product/hero shots; Brand integration; End frame/pack shot/CTA; Cutdowns/versions/deliverables; Formats/aspect ratios; Production plan/schedule; Crew/credits; About the director/showreel/previous work; Thank you). A page type fixes layout slots; the section decides what goes in them; neither fixes the content. **Teaching the models:** the library, the instructions and **three example treatments** are given to the models in the prompt; **no fine-tuning** (3 library note).

### 2.4 Mood-board rules (3f, hard rules)

- **Never crop, squeeze, stretch or change the aspect ratio automatically.** **Frames adapt to each image.** **Crop and scale are manual tools**: a crop is a non-destructive window over the original, set by the person.
- **Originals are byte-identical**, full resolution, and **uncompressed in exports**; renditions are derived and re-makeable.
- "Arrange it for me" moves frames and sizes them to fit the images, and may reorder; it never alters a picture.
- A test uploads pictures of mixed aspect ratios, places them in every page type and arranges them automatically, and asserts each stored original's hash is unchanged, no rendition changes an aspect ratio unless the person set a crop, and the PDF and PPTX carry the original resolution.

### 2.5 Motion pages (3g)

- **GIF page, video viewer, animatic** play in **Present mode** and on the **review link**.
- The **PDF shows a poster frame plus a link and QR code** to the live page (the QR is generated at export; the link is the review link).
- Present mode is full-screen, page by page, with video playing (3h), arrow keys and touch; motion is data on the element, not baked pixels; reduced motion is respected. The review link is the same presentation at a link scoped to the workspace's review rules (view-only, comments if enabled), never exposing the editor.

### 2.6 Exports (3h)

| Output | How | Standard |
|---|---|---|
| **PDF** | Chromium PDF on the export worker (the #767 path), from the same page data | Real text, embedded fonts, vector shapes, pictures at original resolution (3f) |
| **Editable PPTX** | Native text boxes, images and shapes at their positions (Part 3 decides the writer) | Opens in PowerPoint and LibreOffice with editable text; fonts embedded or named |
| **Page images** | Per page PNG | **Crisp at 5K/6K: 3008×1692 @2×** (a 6016×3384 render); text stays live until a raster export |

Every export is a tool (2.10) with its price from the server (the PDF and Remotion export are free today). A failed export says "Nothing billed" and offers Retry.

### 2.7 Narration to a treatment film (3h)

Each page may carry **narration (ElevenLabs, or Sarvam for Indian languages)**, **exported as a treatment film**: each page for its narration's length, motion applied, music optional, subtitles from the narration, assembled on the Remotion worker. One plan card with one all-in price in Agent mode; the steps listed in Director mode. The result is a board card the person can review, approve and export like any cut.

### 2.8 It never invents names, credits or facts (3d)

Unknowns become **marked blanks**: a visible placeholder chip such as "[Client name]" or "[Director]" on the page, in a colour that cannot be mistaken for content, listed in a "Blanks" panel and in the review link's footer. Atomik writes the blank where a name, credit, date, number, quote or rights line is not in the brief, the board or what the person typed (the owner's complaint about 2Slides: "it invented credits on our cover"). Export lists the blanks and asks whether to export anyway; the default keeps them marked. A test feeds a brief with no names and asserts no name, credit or figure appears that is not in the input.

### 2.9 Logo fetch (3a)

For client and agency names without a logo, the product **offers to fetch** it through a reputable logo service such as **Brandfetch** (a proposal until the owner approves the service's terms and key; nothing is called before), **prefers SVG**, shows the candidates, and **the user confirms** before a logo enters the deck. The chosen file is stored as an asset with its source noted; trademark use is the person's responsibility (a lawyer item, like likeness in `docs/legal/`). A failed fetch leaves a marked blank. Fetching is a tool (2.10).

### 2.10 Every element is a tool (rule 11)

The registry (A1) gets these before any button: `deck.create`, `deck.ask_opening_questions`, `deck.design_brief`, `deck.make_cover`, `deck.set_theme`, `deck.map_contents`, `deck.write_page`, `deck.add_page`, `deck.reorder_pages`, `page.set_type`, `page.duplicate`, `page.set_style_reference`, `element.add`, `element.update` (text, colour, position, size), `element.lock`, `element.regenerate` (one image, one paragraph, one page visual), `deck.change_this` (a selection plus plain words), `mood.arrange`, `link.pin`, `version.compare`, `version.restore`, `comment.add`, `deck.present`, `deck.export_pdf`, `deck.export_pptx`, `deck.make_film`, `deck.share_review_link`, `brand.fetch_logo`. The button, Make, a board card, Atomik, a saved skill and an outside agent over MCP call the same tool at the same price through the same approval gate; an edit that costs nothing (text, position, colour) has no gate and never costs a render. Each tool has a mocked test proving an agent can run it. Approving spend stays a person's alone.

### 2.11 Collaboration (Liveblocks, 3h)

Liveblocks is already in the product for live team editing on a shared board. A deck reuses it: presence and cursors per page; text co-edited through Yjs (the Tiptap binding); element locks and selection in Liveblocks storage; comments and versions saved to our database, not left in the room. Joining needs the workspace's membership (the board-sharing reach rules). If Liveblocks is down the deck stays editable single-user and saves.

### 2.12 Agent and Director engine choice per step (3i)

| Step | Agent mode ("engines chosen by us") | Director mode ("every step offers the full engine list") |
|---|---|---|
| Design brief ("How it looks") | Atomik; no model named; one price | Choose the **design** engine from the list (name, strengths, limits, price per unit) |
| Cover art | Atomik picks; no name | Choose the **cover-art** engine (for example Recraft) |
| What it says | Atomik writes; no name | Choose the **text** engine |
| Page images | Atomik picks; no name | Choose the **image** engine |
| Regenerate one picture or paragraph | One all-in price on the button | Engine menu on the same button |
| Narration voice | Atomik picks the voice engine | Voice engine and voice by name |
| Treatment film | One plan card, one price | The steps listed |

The Agent price and the Agent/Director difference are server config (the owner sets the numbers); this document holds none.

### 2.13 Editing standard

The deck is where `docs/plans/editing-standard.md` is built first: click-to-edit at the smallest unit, regenerate-one-thing, "Change this…", per-page and per-element versions with side-by-side compare, unlimited undo and redo, locks, comments, duplicate page.

## Part 3. Spikes (mocks only, one day each, no paid call)

**The question:** build our own editor, or license Polotno? Both spikes build the **same three pages** (a cover, a page with a mood board of four pictures at different aspect ratios, and a text-heavy page with a Hindi paragraph) from mock data, then run the same criteria.

### Spike (a): our own editor, Wed 28 Oct
Built from the v25 card components, Tiptap (MIT core, already adopted for doc cards), and an MIT drag/resize library (candidates: react-rnd or Moveable; confirm the licence before use).

**Pass criteria (all must hold):**
1. **Three pages** editable: select, move, resize, edit text in place, change colour; a text change costs no render.
2. **Sharpness:** text renders as live text, not bitmap; at 3008×1692 with device scale factor 2 the screenshot shows no soft text, blurry border or upscaled picture (sharpness checklist items 1 to 7).
3. **Mood-board rules:** the four pictures keep their aspect ratios; the stored originals' hashes are unchanged.
4. **Undo and redo:** at least 50 steps each way, deterministic, surviving a reload.
5. **Exports:** PDF with real text and embedded fonts; PPTX that opens in PowerPoint and LibreOffice with editable text boxes within 1% of position; both from the same page data.
6. **Hindi:** the Hindi paragraph renders with correct shaping in the editor, the PDF and the PPTX (fonts named or embedded).
7. **Time:** the person-day is the limit; list what did not fit.
**Fail (or "partial") if** any of 2, 3 or 5 needs more than the day's work to reach, or PPTX is not editable.

### Spike (b): Polotno SDK on its trial, Thu 29 Oct
**Needs the owner to start Polotno's trial and send the key's name (the name, never the value).** The same three pages and criteria 1 to 7, plus:
8. **Licence:** a written quote for the terms we would need (hosted or self-hosted, number of seats or sites, commercial use, white-label). The figure is held "with the lead (private)", not written here.
9. **Fit:** how a Polotno design maps to our data model (2.1), whether originals stay byte-identical, whether comments, versions and Liveblocks fit, and how much of the editor we would still have to build.
**Fail if** criteria 2, 3 or 5 fail inside Polotno, or the licence terms cannot cover a hosted multi-tenant product.

### Decision, Fri 30 Oct
A one-page recommendation with evidence: both spikes' criteria side by side, screenshots at 3008×1692 @2×, the PPTX opened in two apps, the time each took, the licence terms, and the recommended path. **Build from Mon 2 Nov.** The owner decides.

## Part 4. Open points and UNKNOWN
- Whether Brandfetch's terms permit our use, and its key name (2.9).
- Which MIT drag/resize library (spike a).
- The Polotno trial key name and licence terms (spike b).
- The deck's Director-mode prices and the Agent all-in price: server config, held privately.
- **(added)** points not in the owner's text, for him to accept or strike: the `kind` field (treatment, pitch, ppm); pinning a card link to a version; the "Blanks" panel and export prompt; the tool list names.
- How "arrange it for me" decides an order (the owner says arrange; the algorithm is open).
