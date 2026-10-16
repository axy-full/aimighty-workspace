# The treatment builder: our own deck editor (spec, build after 31 Oct)

**Draft, 16 Oct 2026. Docs only. Build starts Mon 2 Nov, after the investor demo.** Owner, 16 Oct 2026, 15:05 IST, item 3: "DECKS: 2SLIDES PARKED, WE BUILD OUR OWN TREATMENT BUILDER (after 31 Oct; spec in docs/plans/deck-editor.md). Do NOT wire the 2Slides API; drop it from the env plan." (`docs/redesign-plan.md`, last section.) **2Slides is parked and not wired. Google Stitch is not a deck engine; do not build on it.** For the 31 Oct demo the deck is the Chromium PDF (#767, Treatment cover and Pitch cover), not this builder.

**No pricing, margins, multipliers or vendor costs appear in this document** (the repo is public). Where a price matters, the product shows it from the server's price path, and any figure is "with the lead (private)".

## Part 1. The owner's words

### 1.1 Section 3, a to i, and the section library: NOT IN THE REPO

The owner's 15:05 note carries the treatment builder's flow (items a to i) and the section library. The repo's record (`docs/redesign-plan.md`, section 3) says only: "The full flow, section library and spikes are as the owner wrote them; docs/plans/deck-editor.md carries them verbatim." **The verbatim text of a to i and of the library is held privately by the lead and was not given to this lane.** I did not copy it from a private file or reconstruct it from memory.

> **`[PASTE HERE, verbatim: the owner's section 3 a to i]`**
>
> **`[PASTE HERE, verbatim: the owner's section library]`**

Until they are pasted, Part 2 is written from the flow the lead listed (opening questions, How it looks, Contents mapping with synonyms, Index, What it says, page types, mood-board rules) and **every point in it must be reconciled with the owner's text**; where the two could differ the spec says so ("to reconcile").

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

Rules that bind every part: tenant isolation (every table carries `workspace_id`, every query filters on it, every file path is prefixed by it); rule 11 (a feature is a tool in the registry before it gets a button); rule 14 (only a person approves spend; the price is on the button); rule 13 (everything saves itself; undo instead of confirmations); rule 15 (readable dark) and the 5K sharpness checklist (`docs/plans/sharpness-5k.md`).

### 2.1 Data model

| Object | Fields (summary) | Notes |
|---|---|---|
| **Deck** | id, `workspace_id`, board/project id, kind (`treatment`, `pitch`, `ppm`), cover style (`treatment` or `pitch`), theme id, page order, status, created by, version counter | One deck per board output; a board can hold several |
| **Theme** | palette, type pair, logo (asset ref), corner radius, spacing scale, mood-image refs | **Derived from the cover** ("How it looks"): the cover's choices become the theme, and every later page inherits it; changing the theme re-flows pages without re-rendering pictures |
| **Page** | id, deck id, order, page type, title, **two layers**, notes, narration text, motion settings | Page types in 2.3 |
| **Layer** | `background` and `content` (**to reconcile: the owner's "two layers" are assumed to be a background layer and a content layer**) | Background: picture, colour, mood image; content: text, images, shapes, logo, data |
| **Element** | id, page id, layer, kind (`text`, `image`, `shape`, `logo`, `chart`, `video`, `colour`, `placeholder`), box (x, y, w, h in page units), z-order, locked, content or asset ref, style, link to a board card, motion | The smallest editable unit. Text is rich text (Tiptap document), not a picture |
| **Asset** | id, `workspace_id`, storage path, **content hash**, original name, kind, dimensions | **Originals are stored byte-identical**; every crop, scale or compression is a derived rendition that points to the original and its hash |
| **PageVersion** / **ElementVersion** | id, subject id, number, author, time, snapshot, reason (edit, regenerate, restore, theme change) | Append-only. Restoring writes a new version; nothing is erased |
| **Comment** | id, subject (page or element), author, text, resolved | Per page and per element |
| **CardLink** | element id, board id, card id, card version, mode (`follow` or `pinned`) | Pulls an approved still, shot frame or text from a board card; `follow` offers an update when the card changes, never auto-replaces |

IDs, versions and links are plain data in the workspace's own database. A deck saves itself on every change (rule 13). Atomik and outside agents read and write it only through the tools in 2.10.

### 2.2 The flow

Each screen is one primary action, the next step (rule 13). Agent mode runs the same steps with Atomik asking and filling; Director mode shows the settings. **The screens below follow the flow the lead listed; reconcile each against the owner's items a to i.**

1. **Opening questions.** A few chips, not a form: what the deck is for (treatment or pitch), who it is for, the cover style, length, language. What the brief already says is not asked again.
2. **How it looks.** Pick or generate the cover; the cover sets the theme (palette, type, logo, mood). A live preview of three sample pages. Logo: 2.9.
3. **Contents mapping, with synonyms.** The section library (1.1, to be pasted) is matched to the person's own headings: if they call a section "Tone" and the library says "Mood", the synonym table maps one to the other, and unmapped headings become custom pages rather than being dropped. The person sees the mapping and can change any line.
4. **Index.** The page order as a list the person can reorder, add to, or remove from; this is also the deck's table of contents page.
5. **What it says.** Per page, the copy: Atomik drafts only from what the brief and the board hold; the person edits in place. **The deck never invents names, credits or facts (2.8).**
6. **Page types.** Each page uses a type (2.3). Changing a page's type keeps its content where the fields match and flags what no longer fits.
7. **Review and share.** Preview, comments, a review link, exports (2.6).

### 2.3 Page types (starting set; replace with the owner's library)

Cover, Contents, Logline, Synopsis, Tone and mood board, Characters, Locations, Visual references, Story beats or scenes, Storyboard frames, Look and palette, Sound and music, Schedule, Credits and team, Closing. **To reconcile with the section library.** A page type fixes its layout slots and its default layers; it never fixes the content.

### 2.4 Mood-board rules (hard rules)

- **Never auto-crop, squeeze or stretch** an image. A picture is placed at its true aspect ratio; fitting is by choice: letterbox, fill-with-crop chosen by the person (the crop is a non-destructive window over the original), or a layout that changes shape around the picture.
- **Originals are byte-identical** to what was uploaded or generated (stored with a hash); renditions are derived and may be re-made.
- Pictures are served and exported at least 2× their displayed size, never upscaled past their real pixels (`sharpness-5k.md`).
- A test uploads a picture, places it in every page type, and asserts the stored original's hash is unchanged and no rendition changes the aspect ratio unless the person set a crop.

### 2.5 Motion pages

- **Present mode:** full-screen, page by page, arrow keys and touch, with per-element motion (fade, slide, a looped clip) and page transitions, reduced when the viewer asks for reduced motion.
- **Review link:** the same presentation at a link scoped to the workspace's review rules (signed out, view-only, comments if enabled), never exposing the editor.
- **PDF:** a motion page prints as a **poster frame** plus a **link and QR code** to the live page (the QR is generated at export; the link is the review link).
- Motion is data on the element, not baked pixels, so it stays editable.

### 2.6 Exports

| Output | How | Standard |
|---|---|---|
| **PDF** | Chromium PDF on the export worker (the #767 path), from the same page data | Real text, embedded fonts, vector shapes, pictures at ≥2× |
| **Editable PPTX** | Native text boxes, images and shapes at their positions (Part 3 decides the writer) | Opens in PowerPoint and LibreOffice with editable text; fonts embedded or named |
| **Images / film frames** | Per page PNG | Crisp at **3008×1692 @2×** (a 6016×3384 render); text stays vector in the PDF and is rasterised only here |

Every export is a tool (2.10) with its price from the server (PDF and the Remotion export are free today). A failed export says "Nothing billed" and offers Retry.

### 2.7 Narration to a treatment film

Each page may carry narration text. A "Make the treatment film" tool turns pages into a film on the Remotion worker: each page for its narration's length, motion applied, voice from the chosen engine (ElevenLabs, or Sarvam for Indian languages), music optional, subtitles from the narration. One plan card with one all-in price in Agent mode; the steps listed in Director mode. The result is a board card the person can review, approve and export like any cut.

### 2.8 It never invents names, credits or facts

Unknowns become **marked blanks**: a visible placeholder chip such as "[Client name]" or "[Director]" on the page, in a colour that cannot be mistaken for content, listed in a "Blanks" panel and in the review link's footer. Atomik drafts only from the brief, the board and what the person typed; where a name, credit, date, number, quote or rights line is not in those, it writes the blank, not a guess. Export lists the blanks and asks whether to export anyway (the person decides; the default is to keep them marked). A test feeds a brief with no names and asserts no name, credit or figure appears that is not in the input.

### 2.9 Logo fetch

A person can ask for a company's logo by its web address. The server looks it up through a reputable logo service such as **Brandfetch** (a proposal; the service's terms and key are the owner's to approve and nothing is called until then), prefers an **SVG**, shows the candidates, and **the person confirms** before any logo enters the deck. The chosen file is stored as an asset with its source noted; trademark use is the person's responsibility (a lawyer item, like likeness in `docs/legal/`). Fetching is a tool (2.10) and its failure leaves the placeholder blank. A new key name would be proposed to the owner before it is read.

### 2.10 Every element is a tool (rule 11)

The registry (A1) gets these before any button: `deck.create`, `deck.set_theme`, `deck.add_page`, `deck.reorder_pages`, `page.set_type`, `page.duplicate`, `element.add`, `element.update` (text, colour, position, size), `element.lock`, `element.regenerate` (one image, one paragraph, one page visual), `deck.change_this` (a selection plus plain words), `version.compare`, `version.restore`, `comment.add`, `deck.export_pdf`, `deck.export_pptx`, `deck.make_film`, `deck.share_review_link`, `brand.fetch_logo`. The button, Make, a board card, Atomik, a saved skill and an outside agent over MCP call the same tool at the same price through the same approval gate; an edit that costs nothing (text, position, colour) has no gate and never costs a render. Each tool has a mocked test proving an agent can run it. Approving spend stays a person's alone.

### 2.11 Collaboration (Liveblocks)

Liveblocks is already in the product for live team editing on a shared board. A deck reuses it: presence and cursors per page; text co-edited through Yjs (the Tiptap binding); element locks and selection in Liveblocks storage so two people do not drag the same box; comments and versions saved to our database, not left in the room. Joining needs the workspace's membership (same reach rules as board sharing). If Liveblocks is down the deck stays editable single-user and saves.

### 2.12 Agent and Director engine choice per step

| Step | Agent mode | Director mode |
|---|---|---|
| Copy ("What it says") | Atomik writes; no model named; one price | Choose the text engine from the offered list, each with name, strengths, limits and price per unit |
| Cover and page visuals | Atomik picks the engine and style; no name | Choose the image or cover/design engine (for example the stack's image and design engines) |
| Regenerate one picture | One all-in price on the button | Engine menu on the same button |
| Narration voice | Atomik picks the voice engine; no name | Voice engine and voice chosen by name |
| Film | One plan card, one price | The steps listed |

The Agent price and the Agent/Director difference are config on the server (the owner sets the numbers); this document holds none.

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
- The owner's section 3 a to i and the section library (1.1): pending from the lead.
- The "two layers" meaning (2.1).
- Whether the Brandfetch terms permit our use, and the key name (2.9).
- Which MIT drag/resize library (spike a).
- The Polotno trial key name and licence terms.
- The deck's price in Director mode and the Agent all-in price: server config, held privately.
