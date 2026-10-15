# Font and asset licence register: DRAFT for the owner's lawyer

Draft 0.1, 15 Oct 2026. Built from `release/1` (55a9ef49) and, where marked, the open branches `remotion/3-app` (PR #700: Remotion exports, switch off) and `redesign/integration`. Owner request: "every font and asset rendered into outputs, with its licence" (docs/redesign-plan.md › "Owner, 15 Oct 2026, 20:45 IST").

How to read it. **Allowed** says whether the licence lets us put the item into a customer's output for commercial use. **UNKNOWN: must clear before launch** means no licence is recorded in the repo or the record; it is not a finding that the licence is bad. Licence names are from the files named in the "Source" column; licence URLs are the licensor's, not fetched for this draft. ⚖ marks what the lawyer checks.

## A. Rendered into customer outputs

### A1. Fonts

| Item | Where it enters an output | Source and file | Licence | Allowed | Status |
|---|---|---|---|---|---|
| **Outfit** (variable, Latin and Latin-ext) | Remotion exports: title and end cards, captions (`remotion/src/fonts.ts`, bundled as `ParticlExport`, never fetched). Not yet live: PR #700, switch off | `remotion/public/fonts/outfit-*.woff2` on `remotion/3-app`; same files in `public/fonts/` on `release/1`; © 2021 The Outfit Project Authors, github.com/Outfitio/Outfit-Fonts | SIL Open Font License 1.1; text in `public/fonts/OFL-Outfit.txt` | Yes: OFL allows use in any output, including commercial, and bundling. It must not be sold on its own, and the licence text travels with the font file when the font is redistributed | Cleared, pending lawyer. ⚖ L-L1: check that OFL's reserved-name and "no sale alone" terms are met, and that the font file is never handed to a customer without the licence text |
| **Noto fonts** (`fonts-noto-core`, `fonts-noto-color-emoji`), installed in the Remotion worker image for text outside Outfit's Latin range | Captions and cards in other scripts and emoji | Debian packages in `ops/remotion-worker/Dockerfile` (`remotion/3-app`) | Believed SIL OFL 1.1 (Noto) per each Debian package's copyright file; not recorded in the repo | Expected yes | **UNKNOWN: must clear before launch.** Read the package copyright files in the built image and add them here |
| **Blender's built-in default font** | Astra 3D text objects. The scene document has a `text` object type; the Blender export creates a text curve with no font file set (`lib/astra-blender/blender-export.ts`), so Blender's built-in font is used | Blender 5.2.2 archive (see A4) | Not recorded | Unknown | **UNKNOWN: must clear before launch.** Confirm which font Blender 5.2.2 uses for 3D text and its licence, or bundle a font we hold a licence for |
| **System fonts in posters**: `Georgia` (editorial), `Arial` (geometric), and the system UI stack `-apple-system, BlinkMacSystemFont, Arial` | Poster export (PNG) drawn on the viewer's own browser canvas (`lib/workbench/moleculr-poster.ts`). The letter shapes come from whatever the viewer's device has | None in the repo: not our files | The font owner's licence on the viewer's device (for example Microsoft's for Georgia and Arial; Apple's for the system UI font) | Unknown for text in a picture sold or published by the customer | **UNKNOWN: must clear before launch.** ⚖ L-L2: whether outputs that embed OS-licensed glyphs as pixels are within those licences (Apple's system font licence in particular). [OWNER DECISION OD-L1: bundle an OFL font (Outfit is already bundled) for posters, or keep system fonts and state the limit] |

No font is rendered into the movie export on `release/1`: it encodes the customer's own clips and audio (`lib/workbench/render-movie.ts`, Mediabunny); no title or caption drawing is in that path.

### A2. Images, video and sound that ship with the product

| Item | Where it can reach an output | Source and file | Licence | Allowed | Status |
|---|---|---|---|---|---|
| **`public/fixtures/clip.mp4`**, and `clip-6s.mp4` cut from it: 10 s of Big Buck Bunny, 360p | Shipped as the demo production's clip (`lib/demoProduction.ts`: `DEMO_FIXTURE_CLIP_URL`, "a static file in `public/`, shipped with the app") that each new workspace gets as a starter project; it also stands in for engine output when `ENGINE_MOCK=1`. A customer who exports the demo production exports this clip | © 2008 Blender Foundation, via test-videos.co.uk (`public/fixtures/README.md`) | Creative Commons Attribution 3.0 (creativecommons.org/licenses/by/3.0/) | Yes, **with attribution**: credit, a link to the licence, a note of changes | **Action needed.** Nothing in the code adds the credit to an export. ⚖ L-L3. [OWNER DECISION OD-L2: replace the demo clip with one we own; or add the attribution to the starter project and to its exports] |
| **`public/fixtures/tone.mp3`**: a three-second tone | Stands in for engine audio when `ENGINE_MOCK=1`; served as a static file | samplelib.com, "free to use" (`public/fixtures/README.md`) | Not recorded beyond "free to use" | Unknown | **UNKNOWN: must clear before launch** (or replace with a tone we generate) |
| `public/fixtures/still.png`, `astra-clip.mp4`, `swap-5s-854x480.mp4` | Mock stand-ins | Generated locally (gradient; solid-colour frames) | Ours | Yes | Cleared |
| **`public/campaign/hero.webp`, `environment.webp`, `character.webp`** | Marketing site and design prototypes ("stand-in stills", `design/*/assets/README.txt`). Not product outputs | Not recorded: how they were made | Not recorded | Unknown for any reuse in outputs | **UNKNOWN: must clear before launch** if used on the public site: who made them and under what terms (AI-generated stills carry the engine's terms) |
| `public/marketing/screens/*.jpg` | Marketing site screenshots | Our own product screens | Ours | Yes | Cleared |

### A3. Brand and watermark files

| Item | Rendered into an output? | Source | Licence | Status |
|---|---|---|---|---|
| Particl marks, lockups, wordmarks (`public/brand/`, `brand/particl/`); Atomik marks (`brand/atomik/`) | Not added to customer outputs. Client review links carry the workspace's name and logo and never Particl's branding (docs/particl-sow-v1.md §8) | The owner's own marks | Owner's; any wordmark drawn with Outfit falls under A1 | Cleared, pending: ⚖ L-L4 trademark registration and ownership of the marks. [OWNER DECISION OD-L3: whether Particl will ever mark outputs; "no AI tag" says no, see Terms section 7] |
| Draft watermark on Seedance 2.5 drafts (480p) | Yes, by the engine: BytePlus adds it; "the final never does" (`lib/draftFinal.ts`) | BytePlus | Engine terms | Not ours to clear; named for completeness |
| SynthID mark in Google image outputs | Yes, by the engine: "always embedded" (`lib/models.ts`) | Google | Engine terms | Not ours to clear; see Terms OD-T8 |

### A4. Software that writes into outputs

| Item | What it writes | Licence and file | Status |
|---|---|---|---|
| **Blender 5.2.2** (render worker, Vercel Sandbox snapshot) | 3D render images, `.blend`, `.glb` | GNU GPL (Blender's licence page: blender.org/about/license). Blender states that its output belongs to its author; not fetched for this draft | ⚖ L-L5: confirm that GPL does not reach the render output, and the obligation when we run it as a service. Astra scenes are built from primitives and the customer's own assets: no HDRI, texture, material or sound pack is bundled. The smoke render uses Blender's own default cube (`ops/render-worker/README.md`, smoke render) |
| **Mediabunny 1.56.2** | The browser movie encode (MP4 and WebM) | MPL-2.0; `public/licenses/mediabunny.txt` | Cleared, pending lawyer |
| **FFmpeg 8.0.1 AAC encoder and libavutil** inside `@mediabunny/aac-encoder` (Particl source rebuild) | AAC audio in MP4 | LGPL-2.1-or-later; `public/licenses/LGPL-2.1.txt`, source `public/open-source/aac-1.56.2-particl.1-source.tar.gz`, README beside it | ⚖ L-L6: LGPL obligations (source offer, relinking) and the **AAC patent licence** question for shipping an AAC encoder: **UNKNOWN: must clear before launch** |
| **Remotion 4.0.530** and Chrome Headless Shell (Remotion export worker; PR #700) | Export MP4 | Remotion Free License, confirmed in writing 13 Oct 2026 (the owner holds the email); no licence key sent [D16]. At 4 people the Company License must be bought first. Chrome: Chromium's licences | ⚖ L-L7: that the written confirmation covers a server-side product used by customers, and the headcount trigger. Chrome Headless Shell's third-party licence set to be attached |
| **sharp 0.35.5** (Apache-2.0) with **libvips 1.3.4** (`@img/sharp-libvips`, LGPL-3.0-or-later) | Image resizing, derived images, product image and reference handling | `package-lock.json` | ⚖ L-L8: LGPL-3.0 obligations for the libvips build that ships in the server image |
| **fflate** (MIT), **three** (MIT) | Zip packages; the 3D preview and GLB handling | `package-lock.json` | Cleared |
| **pdfjs-dist 6.3.289** (Apache-2.0), **tesseract.js 7.0.0** | Read screenplay PDFs and images for import. Nothing from them is written into an output | `scripts/copy-pdf-worker.mjs`, `scripts/copy-ocr-worker.mjs` | Not an output item; listed so the NOTICE file can include them |

### A5. Things we do not bundle (so there is nothing to clear)

LUTs: only the customer's own `.cube` files are imported (docs/particl-sow-v1.md, sequence colour); none is bundled. Music and sound beds: none is bundled; sound comes from engines (ElevenLabs, xAI) or the customer. HDRIs, textures, 3D models, stock footage: none bundled. Remotion music and clips are files the customer or an engine produced.

### A6. What the engines generate

Output generated by an engine is the engine's licence's business, not a bundled asset, and a commercial-use limit there would limit our customers. The record holds no summary of these terms.

| Engine (as used) | Recorded licence or output terms | Status |
|---|---|---|
| OpenAI, Anthropic, Google (Gemini), xAI, BytePlus (Seedance), ElevenLabs, Higgsfield, Luma, Kling (via fal), Bria (via fal), Topaz | Not recorded | **UNKNOWN: must clear before launch.** Confirm each engine's terms on commercial use of output, and any plan-tier condition (for example a paid plan is needed for commercial use) |
| `fal-ai/flux-lora` (identity training and renders) and FLUX.2 (BFL) | Not recorded | **UNKNOWN: must clear before launch.** FLUX model weights are issued under different licences by variant; confirm which variant fal serves and that commercial use of its output is granted |
| sync.so, Sarvam | Training and retention terms recorded (D5); output terms not | **UNKNOWN: must clear before launch** |

⚖ L-L9: whether our Terms can promise "what you make is yours" while the engines' terms limit it (Terms section 5, L-T8).

## B. Interface fonts (not rendered into outputs)

| Font | Where | Licence | Status |
|---|---|---|---|
| Outfit (wordmark and display) | `app/fonts.css`, `public/fonts/` | SIL OFL 1.1; `public/fonts/OFL-Outfit.txt` | Cleared |
| Kode Mono (labels and numbers) | `app/fonts.css`, `public/fonts/` | SIL OFL 1.1; `public/fonts/OFL-KodeMono.txt`; © 2023 The Kode Mono Project Authors | Cleared |
| Geist and Geist Mono (interface fallback) | `public/fonts/geist-latin.woff2`, `geist-mono-latin.woff2` | **No licence file in the repo.** Geist is published by Vercel; believed SIL OFL 1.1 but not recorded here | **UNKNOWN: must clear before launch.** Add its licence text beside the files, as for Outfit and Kode Mono |
| System UI stack (SF Pro, Helvetica Neue, system-ui) | Prototype designs and fallbacks, loaded from the viewer's device (`design/particl-prototype-15/assets/README.txt`) | The viewer's device | Not bundled; nothing to clear |

React, ReactDOM and Babel standalone in `design/*/assets/vendor/` are prototype tooling (MIT), not shipped to customers.
