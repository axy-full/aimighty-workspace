# particl — change request 1 (post-v2 feedback)

Twelve items from a first pass on the live v2. Each is a spec with acceptance. Add to `docs/` and work in the order of §13 at the end. Where an item touches the design spec of record, the README wins on pixels; this document wins on behaviour.

---

## 1. Character / element maker

Extend the New asset sheet (SOW v2 §7.10) with a **Make from description** path beside the reference-upload path.

- **Describe → generate.** Name, kind, a line of description, optional style refs. For a character: Nano Banana Pro generates a canonical set — front, three-quarter, profile, full-length — as one priced batch (`Make Iver · 4 stills · 12 CR`). For a prop: hero, detail, turntable. For a location: a plate per selected hour. For a look: a look card and grain sample.
- **Variants as ports.** From the canonical set, generate hair and wardrobe variants on request (`+ Wardrobe variant · 3 CR`); each becomes a version under its port.
- **Review before keep.** The set renders into the sheet; the user keeps, re-rolls one, or regenerates. Nothing is saved until Create.
- **Train switch** unchanged (Soul ID / Flux on fal, priced). Consent stored.
- Opens from Library (per label), the composer's unknown `@name` card, Canvas, Atomik (propose only).

**Accept.** A character made from a description has four canonical versions and appears in Library, `@Name` autocomplete and Canvas by reference; a re-roll replaces one still only; 0 cr if the user cancels.

---

## 2. Prompt enhancer picker

- A **Prompt writer** chip in the composer's `More` row and on Canvas prompt nodes: `Off · Atomik (workspace default) · <LLM> · Engine-native`. LLM options come from the Vercel adapter registry with their per-call rate. Engine-native uses the engine's own enhancer where the adapter exposes one.
- **Preview before render.** Enhancement runs on demand (`Write · 1 CR`) and shows the compiled prompt in a diff view (original → enhanced); the user edits or accepts. Render always uses the shown prompt.
- Workspace default in Settings → Atomik; per-render override remembered per user.

**Accept.** Switching the writer changes the enhanced prompt and its cost line; Off renders the raw compiled prompt; the diff view is what the engine receives.

---

## 3. Models to add — sourced from fal (plus direct)

Add every entry to the adapter registry with `does`, rate from the adapter, and `atomikMayPropose`. Endpoint ids as on fal.

**Video — generate**
| Model | Endpoint | For |
|---|---|---|
| Seedance 2.5 T2V | `bytedance/seedance-2.5/text-to-video` | 30s native, 720p on fal (1080p via ModelArk direct) |
| Seedance 2.5 I2V | `bytedance/seedance-2.5/image-to-video` | first frame + optional end frame |
| **Seedance 2.5 Reference-to-video ("Seedance edit")** | `bytedance/seedance-2.5/reference-to-video` | **edit, extend, up to 50 refs addressed as [Image1] [Video1] [Audio1]** |
| Kling 3.0 Pro / Standard | `fal-ai/kling-video/v3/pro`, `…/standard` | native audio, elements, multi-shot |
| Kling 2.5 Turbo Pro | `fal-ai/kling-video/v2.5-turbo/pro` | fast I2V |
| Veo 3.1 / Veo 3.1 Fast | `fal-ai/veo3.1`, `…/fast` | audio-native, up to 4K |
| MiniMax H3 / H3 Max | `fal-ai/minimax/h3`, `…/h3-max` | 2K, 5–15s |
| Hailuo 2.3 Pro | `fal-ai/minimax/hailuo-02/pro` | 1080p alt |
| Happy Horse 1.0 | `alibaba/happy-horse-1.0` | 1080p with lip-sync in 7 languages |
| Wan 2.6 / 2.7 | `fal-ai/wan/v2.6`, `…/v2.7` | cheapest 1080p drafts; 2.7 edit-video |
| Gemini Omni Flash 1.1 | `google/gemini-omni-flash-1.1` | multimodal refs, identity + voice held |
| Sora 2 T2V / I2V | `openai/sora-2/*` | alt hero engine |
| LTX-2 | `fal-ai/ltx-2` | fast drafts |
| Pixverse v6 | `fal-ai/pixverse/v6` | trend formats |

**Video — edit and control**
| Model | Endpoint | For |
|---|---|---|
| Kling 3.0 Motion | `fal-ai/kling-video/v3/motion-control` | reference-clip motion onto a character |
| Wan Motion | `fal-ai/wan/motion` | pose-retargeted motion transfer |
| Wan VACE 14B | `fal-ai/wan-vace-14b` | masked video edit |
| Pixverse Swap | `fal-ai/pixverse/swap` | object / person / background swap |
| Wan 2.7 edit-video | `fal-ai/wan/v2.7/edit-video` | instruction edits, keep or regenerate audio |

**Stills — generate and edit**
| Model | Endpoint | For |
|---|---|---|
| Nano Banana Pro / 2 | Google direct | keyframes (Pro), panels (2 / fast) |
| Nano Banana 2 Edit | `fal-ai/nano-banana-2/edit` | precise edits |
| Flux Kontext | `fal-ai/flux-pro/kontext` | reference-based edit |
| FLUX 2 Max | `fal-ai/flux-2/max` | alt hero stills |
| GPT Image 2 | `openai/gpt-image-2` | typography-heavy frames, packaging |
| Recraft V4 | `fal-ai/recraft/v4` | design / vector looks |
| Meta Muse Image | `meta/muse-image` | multi-turn precise edits |

**Talking and lip-sync**
| Model | Endpoint | For |
|---|---|---|
| sync-3 / Sync Lipsync 2.0 | `fal-ai/sync-lipsync/v3`, `…/v2` | lip-sync a finished take to audio (~$0.70/min class) |
| Kling LipSync | `fal-ai/kling-video/lipsync` | audio → lips on Kling output |
| OmniHuman v1.5 | `fal-ai/omnihuman/v1.5` | still + audio → talking performance |
| MultiTalk | `fal-ai/multitalk` | still + text → talking avatar |

**Audio**
| Model | Endpoint | For |
|---|---|---|
| ElevenLabs | direct | VO, clones |
| MiniMax Speech / Chatterbox | `fal-ai/minimax/speech`, `fal-ai/chatterbox` | cheap TTS for scratch |
| Licensed music (Beatoven-class) | `fal-ai/beatoven` | commercial-safe beds |
| SFX | fal audio catalogue | effects |

**Post and utility**
| Model | Endpoint | For |
|---|---|---|
| Topaz Astra 2 | `fal-ai/topaz/upscale/video` | video upscale |
| Topaz image / RealESRGAN | `fal-ai/topaz/upscale/image`, `fal-ai/esrgan` | still upscale |
| Bria RMBG 2.0 | `fal-ai/bria/background/remove` | still background removal, licensed data |
| Video background removal / chroma key | `fal-ai/video-background-removal` | plates |
| NSFW classifier | `fal-ai/imageutils/nsfw` | pre-call moderation input |
| Meshy v6 / Trellis 2 | `fal-ai/meshy/v6`, `fal-ai/trellis-2` | props to 3D for turntables |

**Add first (ten):** Seedance 2.5 reference-to-video, Kling 3.0 Standard, Kling 3.0 Motion, Wan 2.6, Veo 3.1 Fast, Nano Banana 2 Edit, Flux Kontext, sync-3, Topaz Astra 2, Bria RMBG. Verify each endpoint id and rate against fal before wiring; the ids above are as listed on fal at the time of writing.

**Accept.** Every added engine appears in the composer's model list with its one-liner and rate, in Settings → Engines with a status dot, and in Atomik's plans only if `atomikMayPropose`.

---

## 4. Generations carousel under each project

- On **Productions**, each project tile gains a **media strip**: the latest 8 takes and stills as a horizontal snap carousel (desktop: hover-scroll and arrows; mobile: swipe), newest first, each with kind chip and state dot; the last card is `All N →` into Project › Media.
- On **Project › Media**, the `BY SHOT` groups keep the grid, and a **`BY DATE`** toggle shows one carousel per day.
- Rendering wells show the ring; a take arriving slides in at the front.

**Accept.** A new take appears on its project's strip within one poll; strip order is newest first; swipe works at 390.

---

## 5 + 9. Library — restructured, and first in the nav

**Nav order becomes Make · Library · Productions · Rig.** Library is the asset home; Productions consume it.

Replace the three-lens segmented control with **labelled sections**, each a titled grid with its own `+ New` and count:
`Characters · Locations · Props · Looks · Voices · References · Unfiled`.
A sticky left index (desktop) / horizontal index pills (mobile) anchors to each label.

- Every card: canonical still, name, version count, lock, **where-used** (`6 shots · 2 productions`), and three actions on hover / long-press: `Use in Make`, `Add to Canvas`, `Open`.
- The character / element maker (item 1) is the `+ New` under each label.
- **Seed it.** A new workspace's Library opens with the demo production's assets, so it is never empty on first open. Empty labels show one line and `+ New`, nothing else.
- Filters: production, locked, trained. Search by name and `@Name`.
- Library indexes; it never stores a second copy (unchanged).

**Accept.** Nav order updated on desktop and dock; an asset appears under its label immediately after creation; where-used equals bindings; first open of a new workspace shows seeded assets.

---

## 6. Zoom and pan on the Rig canvas

- `wheel` with `ctrlKey` / `metaKey` (trackpad pinch and ⌘-scroll) → **canvas zoom around the cursor**, `preventDefault` so the browser never zooms. Plain `wheel` → pan. Touch: pinch to zoom, one-finger drag on empty board to pan.
- Range 25%–200%; `⌘0` fit, `⌘=` / `⌘-` step; a `+ / − / fit` cluster bottom-right with the current percentage.
- Zoom and pan persisted per board per user.
- Node text stays crisp (transform on the board group, not scaled bitmaps); wire endpoints remain exact at every zoom.

**Accept.** Pinch on a trackpad never changes browser zoom; a zoom level survives reload; port dots align at 25% and 200%.

---

## 7. "Run" under Rig — what it is, and how to make it obvious

**Run** is a Recipe executing: the stage track with Atomik's checkpoints (SOW v2 §7.7). It exists so a run has a home the rail can deep-link to. It confuses because it appears before anyone has run anything.

- Rename the tab **Runs** and make it a **list** (newest first; each row: recipe, project, `3 OF 8 STEPS`, spent of estimate, state) opening the run view.
- **Hide Runs until the workspace has a run**; until then, Canvas shows `Run this board · N CR` and Recipes shows `Run recipe`.
- The Atomik header button always links to the current run; the rail's checkpoint card has `Open run →`.

**Accept.** A fresh workspace shows only Canvas · Recipes; the first run creates the Runs tab; the rail deep-links correctly.

---

## 8. Atomik model picker

- A **model chip** in the Atomik rail header (desktop) and sheet header (mobile): the LLM list from the Vercel adapter registry — Claude (Sonnet, Opus), GPT (5, 5 mini), others as added — each with its per-call rate.
- Workspace default in Settings → Atomik → Planning model; per-thread override; the chosen model is named on every Plan and Checkpoint message with its planning credits.
- Separate defaults for **planning** (stronger) and **enhancement** (cheaper), both pickable.

**Accept.** Changing the chip changes the model named on the next message and its cost; the default persists per workspace.

---

## 10. Right-click and keyboard — everywhere

One context-menu component, same items in the same order, on **shots, takes / media, assets, canvas nodes and references**; long-press opens it as a sheet on mobile.

`Cut ⌘X · Copy ⌘C · Paste ⌘V · Duplicate ⌘D · Rename · Move to ▸ · Share ▸ (copy link · add to review link) · Download · Open in Rig · Delete ⌫`

- Cut/Paste moves (takes go too, cost goes too); Copy/Paste on a shot copies planning only (new ID, 0 cr) — as designed; on media, copies the reference into the composer well; on assets, duplicates as a new asset with no versions trained.
- Delete always offers Undo for 30s; media is never deleted by a shot delete.
- Share on a take or shot adds it to the project's review link or copies a signed link; on an asset, copies a workspace-internal link.
- Every action narrated in a toast.

**Accept.** All nine items work on all five object types on both viewports; keyboard equivalents fire when a card is selected.

---

## 11. Drag and drop — the full list

Implement with pointer events (works for mouse and touch after long-press), visible insertion edges, and toast narration. Targets:

| Drag | Drop on | Result |
|---|---|---|
| Shot card | another position | reorder |
| Shot card | production chip | move (takes and cost go too) |
| Take / media | a shot card | file to that shot (next version) |
| Take / media | composer reference well | use as reference / first frame |
| Take / media | review link | add |
| Asset card | Canvas | asset node |
| Asset card | a shot's slot / composer Cast | bind / `@Name` |
| File from desktop (image, video, audio) | composer reference well, New-asset references, Library label, Canvas | upload and place (per-file progress, resumable) |
| Reference (Library) | Canvas / composer | node / reference |
| Canvas node | board | move; on a slot dot: connect |

**Accept.** Every row works at 1440 with a mouse and at 390 with long-press; a dropped desktop file shows progress and lands in the right place; no drop leaves the browser navigating to the file.

---

## 12. Seedance edit — inputs from the device and from the app

For `reference-to-video` (and any endpoint accepting references):

- A **References panel** in the composer and on the Canvas node: add from **device** (file picker, drag-drop, paste) and from **the app** (Library assets, takes, unfiled, panels). Up to 50. Each reference gets a positional token — `[Image1]`, `[Video1]`, `[Audio1]` — shown on the card and insertable into the prompt with one tap.
- **Edit and extend modes** on the same panel: `Edit this video` (video ref + what to change) and `Extend` (what happens next). Video references bill their input duration alongside the output; show that in the quote line.
- Cap and notes read from the adapter: 720p on fal; 1080p only when routed through ModelArk direct.
- Uploads go to the workspace's Blob prefix with per-file progress; a reference can be promoted to an asset from the panel.

**Accept.** A device upload and a Library take both appear as tokens; the prompt inserts them; the quote reflects the video-reference rule; a 51st reference is refused with a reason.

---

## 13. Order

1. **6** zoom (small, unblocks Rig use)
2. **10** context menu + **11** drag and drop (one component pass)
3. **5 + 9** Library restructure and nav order
4. **3** models — the ten first, then the rest
5. **12** references panel (Seedance edit)
6. **1** character / element maker
7. **2** prompt writer picker · **8** Atomik model picker (same registry work)
8. **4** carousels
9. **7** Runs rename and gating

Every item ships for desktop and mobile together.
