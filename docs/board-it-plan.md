# Board it: consistent storyboards (plan)

Owner priority, 8 Oct 2026. **Nothing here is built until the owner says OK.** Each slice ships as a small PR into `release/1`; nothing reaches `main` or production without the owner's "go". Tests use mocks. One tight paid pass runs only on the owner's "run", using the owner's "dunes" film assets.

**Goal.** Characters, locations, props and brand products stay the same in every frame. An "8-panel" mode draws 8 frames in one call.

**Constraints.** No GPU of our own: hosted image models only, and CPU helpers on our server. No Higgsfield sign-in features. No secrets in the repo.

## 0. What exists today, and what this builds on

| Piece | Where | State |
|---|---|---|
| Storyboard group and frame cards | `components/graphite/board/cards/plan/derive.ts:69-87`, `set-plan.ts:39`, registry `cards/index.ts:25` | One `frame:<shotId>` card per shot, derived from the draft on every render |
| Shots and scenes | draft JSON `production.beats.scenes[].shots[]` (`lib/production/beats.ts:9-11`) | Scenes already list `characters[]`, `locations[]` and `props[]` by name. Shots have no element tags |
| Frames | `production.boards.frames[shotId]` (`lib/production/boards.ts:43`), save schema `.strict()` (`lib/workbench/studio-schema.ts:242-261`) | prompt, sketch, style, takes (up to 20), `selected`, pending. No lock |
| FrameInspector | `cards/storyboard/FrameInspector.tsx` | Read-only: name, line, "Drawn from" |
| Looks | `lib/production/looks.ts`; applied in `frameRequest` (`boards.ts:97`) as one reference image plus a sentence | Works |
| Frame drawing | `use-frames.ts` → `/api/generate/quote` → `/api/generate` → `executeGenerationAdmission` → reserve → `engines/google.ts` → settle | The same ledger and quote-before-run as every other generation. NB2 is the default (`boards.ts:65`) |
| Cast | `production.cast.entries` (`lib/production/cast.ts:24`), `cast_members` table, `@cast` expansion (`lib/cast.ts:104`) | One reference per entry. No description, no views, no locks |
| Brand kit | `project.moleculr` (`lib/workbench/moleculr.ts:97`) | Products and brand colours for ads |
| Reference limits | `lib/models.ts:440,463` (14 for both Nano Banana models), enforced in `lib/generationAdmission.ts:200` and `lib/refLimits.ts:33` | Counted after the cast is attached |
| Verify card | `lib/workbench/verify.ts` | A model-judged identity, wardrobe, environment and props score against masters. The new CPU drift check sits beside it |
| Masked edits | none | No mask or inpaint path anywhere, so §5 builds one |
| Seedream image, fal edit models | not registered | New adapters needed (§10, slice 11) |
| Agent tool registry (A1) | not started | Features are written as tool-shaped server functions, ready to register when A1 lands |

## 1. Data model

Everything lives in the project draft (`workbench_projects.body`), like the storyboard itself. That gives one save path, autosave and undo history, and no new tables. Each workspace already has its own database, and every file is an upload under that workspace's R2 prefix. All new fields are optional, so old drafts load unchanged. The strict save schema is extended in the same PR.

```ts
// production.kit: the Cast & Kit card
type KitElement = {
  id: string;                      // stable, e.g. "el_maya"
  kind: "character" | "location" | "prop" | "product";
  name: string;                    // MAYA, "Desert camp", "Brass compass", "Aqua bottle"
  description: string;             // short and fixed: age, build, hair, wardrobe / place, time, palette / object
  refs: { uploadId: string; view?: "front" | "threeQuarter" | "profile" | "establishing" | "angle" | "packshot" }[];
  locked: string[];                // "must never change", e.g. ["red scarf", "scar over left eye"]
  approved: { by: string; at: number } | null;
  source: "upload" | "turnaround"; // turnaround = generated once and approved by a person
  // characters
  aliases?: string[];              // names in shot text that mean this character
  // locations
  timeOfDay?: string; palette?: string[];
  // products: real packshots only
  labelText?: string;              // exact text on the label, checked by OCR
  brandColours?: string[];         // hex
};
type Kit = { elements: KitElement[] };

// production.beats.scenes[].shots[]: new optional fields
type ShotTags = { elements?: string[]; tagSource?: "agent" | "person" };    // element ids, most important first
type ShotContinuity = {                                                    // changes that start at this shot and carry forward
  timeOfDay?: string;
  wardrobe?: Record<string, string>;   // element id -> "jacket off"
  props?: Record<string, string>;      // element id -> "glass half full"
};

// production.boards.frames[shotId]: new optional fields
type FrameExtras = {
  locked?: { by: string; at: number };                                   // never touched by a redraw or Draw 8
  sheet?: { id: string; panel: number };                                 // drawn as panel n of a sheet
  drift?: { at: number; ok: boolean; reason?: string; scores: Record<string, number>; region?: [number, number, number, number] };
};
// production.boards.models: the per-step model setting (§3)
type BoardModels = { frame?: string; sheet?: string; finish?: string; fix?: string; turnaround?: string };
```

- **Existing cast.** `production.cast.entries` is read as `character` elements, so existing cast keeps working. New writes go to `production.kit`. No data migration.
- **Products.** A product element must hold **at least one uploaded packshot** before it can be approved, tagged or drawn. Nothing ever generates a product reference, logo or label. The kit can import products from the brand kit (`project.moleculr`).
- **Scene continuity.** The state for a shot is the scene's start state (from the kit) with every earlier shot's `ShotContinuity` applied in order. One pure function computes it, and both the prompt and the drift check use it.

## 2. UI on the Graphite board

- **Cast & Kit card** (new card kind `kit`, derived from `production.kit`, placed next to the Storyboard group):
  - **Layout:** four short rows (Characters, Locations, Props, Products). Each element is a tile: its main reference, name, an "approved" mark and a count of locked items.
  - **Inspector:** edits the description, aliases and locked list. It also adds or replaces references: front, three-quarter and profile for characters; establishing plus 1–2 angles for locations; a packshot for products.
  - **Actions:**
    - **Make turnaround** shows its price first (e.g. "Nano Banana Pro · 4K · 4 cr · Change"), then **Approve**.
    - **Products have no generate button.** Their tile says "Add a packshot".
  - **Phones:** approving and looking through elements works on a phone (rule 7). Uploading and editing are desktop-first.
- **FrameInspector becomes editable:**
  - **In this frame:** element chips. Chips the agent suggested show a small "suggested" mark until a person touches them. Add or remove with one tap.
  - **Continuity:** one line ("Night · MAYA: jacket off · Glass: half full"), editable, starting from this shot.
  - **Lock:** a toggle. A locked frame shows a lock on its card.
  - **Drift:** one line ("MAYA's face drifted (0.31 < 0.42)") with **Fix · 2 cr**.
  - **Model:** one line ("Nano Banana 2 · 2K · 2 cr · Change"). Advanced options stay folded (rule 13).
  - **Finish panel · 2 cr** appears on frames that came from a sheet.
- **Storyboard group:**
  - **Draw 8 · 3 cr** is the primary action when at least one unlocked shot has no frame. It shows the price for the whole run ("3 sheets · 9 cr" for 24 shots) before anything is spent.
  - A sheet shows as a thin strip while it renders, then its 8 panels drop into their frames.
- **Viewports:** every UI PR has Playwright checks at 360×640, 390×844, 844×390, 1440×900 and 1920×1080, plus the five-minute test.

## 3. Models per step and prices

**Pricing.** Prices come from the code's own path: `vendorRates.ts` → `estimateImageCostUsd` → `billCredits`. The margin is 1.5 and each job rounds up to a whole credit, so credits = ceil(USD × 15). Reference images cost $0.0003 each on NB2 and $0.0011 each on Pro, which changes no figure below.

**Per-step setting.** Each step is a setting (`production.boards.models`, defaulting from the platform layer), never hard-coded. The quote always reflects the model that will actually run.

| Step | Default | Engine cost | **Credits** | Alternates |
|---|---|---|---|---|
| Single frame | NB2 `gemini-3.1-flash-image` **2K** | $0.101 | **2 cr** | NB2 1K costs the same 2 cr ($0.067 × 15 = 1.005, which rounds up), so 2K is the default at no extra cost. NB Pro 2K: 3 cr |
| **Draw 8** (one 2×4 sheet) | NB2 **4K**, 1 call | $0.151 | **3 cr per sheet = 0.375 cr per frame** | NB Pro 4K: 4 cr per sheet. Eight single NB2 frames: 16 cr |
| Finish panel (one panel redrawn at full size) | NB2 2K | $0.101 | **2 cr** | NB Pro 2K: 3 cr |
| Targeted fix (region edit, §5) | NB2 2K on the cropped region | $0.101 | **2 cr** | fal edit model (slice 11) |
| Character turnaround (front, ¾, profile on one sheet) | NB Pro 4K | $0.24 | **4 cr** | NB2 4K: 3 cr |
| Location angles (establishing plus 2 angles, one sheet) | NB2 4K | $0.151 | **3 cr** | |
| Drift check (§6) | CPU on our server | $0 | **free** | |
| Optional vision pass (wardrobe and props) | `gemini-2.5-flash-lite` with image input | about $0.01–0.04 | **free to the user.** The platform absorbs it; off by default | |
| Agent "tag shots" (optional, beyond the free name matching) | the workspace's text model | at the snapshot price | **quoted, usually 1 cr per scene** | |
| Seedream (ARK) frames and sheets | slice 11 | not in the code yet | **priced when the adapter lands** | Up to 14 references (4.x / 5.0 lite) |

**Example: a 24-shot board.** 3 sheets (9 cr), 4 finished panels (8 cr) and 3 fixes (6 cr) come to **23 cr ($2.30)**. Drawing 24 frames one at a time would cost 48 cr.

**Sheet layout.**
- **Shape:** for 16:9 frames, the sheet is 2 columns × 4 rows on a 1:1 4K canvas (4096²). Each panel is about 2048×1024, cropped to 16:9 (about 1820×1024). Vertical 9:16 uses 4 columns × 2 rows.
- **Panel quality:** that is roughly 1K per panel, which is why Finish panel exists.
- **Fitting:** the panel arrangement follows the production's aspect ratio. Nano Banana 2 accepts 1:1, 4:1, 1:4, 21:9 and others.

**Reference limits.**
- **NB2:** up to 14 images in total, of which up to 4 characters and 10 objects at high fidelity.
- **NB Pro:** 14 in total, 5 characters and 6 objects.

A sheet shares one reference budget across its 8 shots, so §4's ordering applies to the combined list.

## 4. Drawing a frame (single or sheet)

A pure function `frameReferences(shot(s), kit, continuity, look, previousFrame, model)` returns an ordered list of references and the text that names them.

1. **Products first.** Every product tagged in the shot gets its packshot, plus the line `Image n = product "Aqua bottle": exact label text "AQUA · 500 ml". Reproduce the label exactly; add no other logos or text.`
2. **Characters.** For each tagged character: the front view, plus the three-quarter or profile view when there's room. The model's character limit applies (NB2 4, Pro 5). The line reads: `Image n = MAYA (character): 30s, lean, short black hair, red scarf. Never change: red scarf; scar over left eye.`
3. **Location.** The establishing shot, plus one angle when there's room.
4. **Props**, each with its current state from continuity ("glass half full").
5. **The picked Look's still**, using the existing sentence.
6. **The previous frame of the same scene**, for continuity: the last drawn or locked frame before this shot.

- **When references don't fit:** the tag order decides priority (most important first), and lower-priority references are dropped. **What's dropped is listed in the quote**, so nothing is silently lost.
- **Sheets:** the references are the union across the sheet's shots, limited the same way. If one sheet needs more than the character limit, it is split into two smaller sheets, and the quote says so (e.g. "2 sheets · 6 cr").
- **Over 8 shots:** sheets chain, and each one adds the previous sheet's last panel as a reference.
- **Locked frames are skipped:** a sheet takes the next 8 unlocked shots without frames. Locked frames still serve as continuity references. The server refuses to overwrite a locked frame even if the client asks.
- **Slicing:** a CPU step using `sharp`. The prompt asks for numbered panels with plain gutters. The slicer looks for the gutters first and falls back to fixed geometry. Panel n maps to shot n of the run. If 8 panels can't be found, the sheet is shown whole and nothing is mapped. **Owner decision D2** covers whether that sheet is charged.

## 5. Targeted fix (never a full re-roll by default)

1. The drift check (§6) returns the region (face box, product box, or the vision pass's box).
2. Crop that region with a margin, at full resolution.
3. Edit only the crop: one image call with the crop, the matching element references and the instruction "Make this match Image 2's face; change nothing else."
4. Composite the result back into the frame on CPU with a feathered mask, and match the colour to the area around it.

Pixels outside the region are guaranteed unchanged, because the model never touches them. It costs one call (2 cr) and needs no model-side mask support. A full redraw is still available, priced, and never the default.

## 6. Drift check after every frame (CPU, free to the user)

It runs in a separate internal-only checker container on this server: no public port, no secrets beyond its own key, and the same network option the owner picks for the render workers. Option (c)'s relay can serve both. A frame is checked as soon as it lands.

| Check | Models | Licence (code / weights) | RAM | Time per frame on 2 vCPU |
|---|---|---|---|---|
| Face detection | **YuNet** (OpenCV Zoo) | MIT / MIT | about 20 MB | 10–30 ms |
| Face identity | **AuraFace v1** (glintr100.onnx only), ArcFace-class, 512-d | Apache 2.0 / Apache 2.0, "trained on commercially and publicly available data" | about 500 MB | 200–400 ms per face |
| Face identity (lean fallback) | **SFace** (OpenCV Zoo) | Apache 2.0 / Apache 2.0 | about 100 MB | 5–15 ms per face |
| Product and object similarity | **DINOv2 ViT-S/14** (ViT-B/14 if needed) | Apache 2.0 / Apache 2.0 | about 250 MB (B: about 700 MB) | 50–100 ms per crop |
| Label text | **PP-OCRv5 mobile** detection and recognition (PaddleOCR, ONNX) | Apache 2.0 / Apache 2.0 | about 50 MB | about 60 ms plus about 20 ms per line |
| Brand colours | colour distance on the product crop | our code | small | under 10 ms |
| Runtime | onnxruntime-node (no Python) | MIT | about 100 MB | |
| **Total** | | **all commercially usable** | **about 1–1.5 GB** (limit the container to 3 GB, 2 vCPU) | **about 1–3 s** |

**Not used, and why:**
- **InsightFace weights** (buffalo_l, antelopev2) are for non-commercial research only.
- **The other files in AuraFace's repo** (scrfd and the landmark models) are InsightFace's own, so only glintr100.onnx is used.
- **dlib's 68-point landmarks** are not for commercial products.
- **facenet-pytorch and VGG-Face weights** are of unclear licence.
- **CLIP/OpenCLIP** are cards that say deployed use is out of scope; DINOv2 is also better at telling one product from another.

**What it checks:**
- **Faces:** each tagged character's face in the frame against that character's approved references.
  - It compares against the same art style when a turnaround exists. Photo-trained models are not reliable on line art.
  - **No face found means "not checked", never "failed".** That's common on sketch-style frames. It then falls back to DINOv2 on the character crop, plus the optional vision pass.
- **Products:** DINOv2 against the packshot crop. OCR text against `labelText` (fuzzy match, with the reason given). Brand colour distance.
- **Optional vision pass:** wardrobe and prop state against the continuity line and the locked list. Off by default, paid by the platform, and capped per day.

**Results.**
- **Reason:** a one-line message, such as "MAYA's face drifted", "label reads 'AQUA 50 ml', expected 'AQUA · 500 ml'" or "red scarf missing".
- **Region:** the box that §5 edits.
- **Thresholds:** start at published defaults and are calibrated per art style on the dunes assets during the paid pass.

## 7. Locks

`frames[shotId].locked` is enforced on the server in every write path: single redraw, Draw 8, Finish panel and Fix. Draw 8 skips locked shots. Unlocking takes an explicit person action and is recorded. Atomik and outside agents can propose a lock or unlock, but only a person sets it.

## 8. Billing

- **One ledger:** every paid step goes through the existing `/api/generate` path, so it shares the same quote, reserve and settle, the same credit ledger and statements, and the same approval rules (`lib/approvalRule.ts`).
- **Draw 8 and multi-sheet runs:** the quote covers the whole run, and the person approves it once (rule 14). Each sheet is still its own job, so a failed sheet refunds alone.
- **Free steps:** the drift check and the free name-matching tags cost nothing. The optional vision pass and the checker's CPU time are platform costs.
- **Paid steps:** a fix and a finish are ordinary priced generations, shown before they run.
- **Fixes inside a plan:** a run's approval includes the rule-14 fix allowance, at most two fixes per shot. A third fix asks again.

## 9. Agent (rule 11)

Each feature is written as a tool-shaped server function with typed input, a quote and an approval gate. Buttons call these, and Atomik will call them once the registry (A1) lands. Each tool has a mocked test showing an agent can run it.

| Tool | What it does | Paid? |
|---|---|---|
| `kit.addElement` / `kit.updateElement` | Create or edit Cast & Kit elements | free |
| `kit.makeTurnaround` | Generate a character turnaround or location angles | quoted |
| `kit.approve` | Approve an element | **person only** |
| `shots.tagElements` | Free name and alias matching against the kit, plus each scene's own `characters`, `locations` and `props` lists. An optional agent pass is quoted. The fields visibly fill as "suggested" | free, or quoted |
| `board.drawFrame`, `board.draw8`, `board.finishPanel`, `board.fixFrame` | Draw frames and fix them | quoted |
| `board.checkFrame` | Run the drift check | free |
| `board.lockFrame` | Lock a frame | **person only** |

## 10. PR slices (each small, into `release/1`, in this order)

| # | Slice | Review | Estimate |
|---|---|---|---|
| 1 | Data model: `production.kit`, shot tags and continuity, frame lock/sheet/drift fields, strict schema, reading the old cast, the continuity function | Opus (data shape and tenancy) | 4–5 h |
| 2 | Cast & Kit card: upload, views, locked list, approve, the packshot-only product rule (5 viewports) | Sonnet + UI checks | 8–10 h |
| 3 | Editable FrameInspector: tags, lock (server-enforced), continuity line, free name-matching pre-fill | Opus (lock enforcement) | 5–6 h |
| 4 | `frameReferences` and naming, the per-step model setting, single frames through `/api/generate` with the new references | **Opus (money)** | 6–8 h |
| 5 | Draw 8: sheet request, slicer, shot mapping, chaining, locked shots skipped, Finish panel, whole-run quote | **Opus (money)** | 10–12 h |
| 6 | Turnarounds for characters and location angles, with approval | **Opus (money)** | 5–6 h |
| 7 | Checker container: onnxruntime-node, models fetched at build with sha256, internal-only protocol | **Opus (security)** | 8–10 h |
| 8 | Drift check wired in after every frame and panel, one-line reasons, flags in the UI | Sonnet | 5–6 h |
| 9 | Targeted fix: crop, edit, composite | **Opus (money)** | 6–8 h |
| 10 | Agent tools and mocked agent tests, optional quoted "tag shots" | Opus | 5–6 h |
| 11 | Alternates: Seedream image adapter via ARK (after #602 merges, since it touches provider files), a fal edit model adapter | **Opus (money)** | 8–10 h |
| 12 | Optional vision pass (platform-paid, off by default, daily cap) | Sonnet | 3 h |

**Total: about 75–90 agent-hours, with reviews on top.** Slices 1–5 alone deliver the core: kit, tags, consistent single frames and Draw 8. They can run as 2–3 parallel lanes after slice 1. Slices 2 and 3 are both UI, and slice 7 can start at any time.

**Paid test pass (only on "run").** On the dunes assets in the internal workspace:
- 2 character turnarounds: 8 cr
- 1 location sheet: 3 cr
- 2 Draw 8 sheets: 6 cr
- 2 finished panels: 4 cr
- 2 fixes: 4 cr
- 4 single frames: 8 cr

That's about **33 cr ($3.30)**, with a hard cap of **40 cr**, plus a few platform-paid vision passes if D3 is on.

## 11. Owner decisions

- **D1. Sheet layout.** About 1K effective resolution per panel (2×4 on a 4K canvas), with Finish panel for heroes. OK?
- **D2. A sheet that can't be sliced.** The provider has charged us. Charge the customer, or absorb it and offer one free redraw? My recommendation: absorb it, with one free automatic redraw per sheet.
- **D3. Vision pass.** On or off by default, and the daily cap. My recommendation: off by default, on per production, capped at $2 per day across the platform.
- **D4. Turnaround model.** NB Pro 4K (4 cr, better likeness) or NB2 4K (3 cr)? My recommendation: Pro.
- **D5. The checker runs as its own internal container** (one more app in the platform), on the same network option as the render workers.
- **D6. Seedream pricing.** It needs BytePlus's per-image price before slice 11. The owner confirms the price, or we take it from their console.
- **D8. Rounding.** CLAUDE.md § Pricing says "batches multiply before rounding", but the code rounds each job separately (`lib/creditTerms.ts:79-86`; each variation is its own job). This plan prices sheets as one job, so it doesn't depend on the answer. The rate card text and the code still disagree, and that is the owner's call to settle.
- **D7. Model setting scope.** Per production with platform defaults (this plan), or also per workspace?
