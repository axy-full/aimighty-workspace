# Reading a brief: the plan (docs only)

The lane that makes any brief land whole and be read by page. It follows SOW v2 §9 (Brief), §10 (the Library) and Part II.1, and is cited by section number only. This plan writes no code. Each step below is its own PR under the usual rules. Step 3 is money (Opus money review, the owner's head-pinned yes). Step 2's tables are schema (they need the owner's yes on the migration, after his backup).

Where the SOW and this plan differ, the SOW wins; the differences are numbered questions at the end.

## What exists today (release/1 5dca1254)

- **Browser reader.**
  - `components/graphite/home/brief-file.ts` takes .pdf, .txt, .md and .fountain only (:8), with a 2 MB text cap (:10, :31).
  - PDFs go to `extractScreenplayPdf` (`lib/workbench/screenplay-pdf.ts:89-124`), which uses pdfjs text only and has a 120 s timeout. Limits: 20 MB (:23) and 400 pages (:63; `lib/workbench/screenplay.ts:2-4`).
  - The result is cut to 30,000 characters (`brief-file.ts:37`), with "Kept the first 30,000 characters" shown in `BriefBox.tsx:59-67` and `GuestBox.tsx:35-40`.
  - There is no OCR: a scanned page reads as nothing.
- **Chunked upload** (the Library's path):
  - 3.5 MB chunks (`lib/uploadRecovery.ts:6`), three in parallel (`lib/uploadClient.ts:325`).
  - Size check in the browser before the first chunk (`uploadRecovery.ts:212-218`): chat files up to 2 GiB, references up to 200 MB.
  - Server caps in `lib/uploadReservations.ts:14-16`.
  - Assembly streams into storage (`lib/storage.ts:708` `streamAssembleUpload`).
  - A document lands as an `uploads` row with `kind = 'file'` (`app/api/uploads/finish/route.ts:50-58`; `lib/uploadReservations.ts` `completeUpload`).
- **Where a brief's text lands.** `project.brief`, held to 30,000 characters by `lib/workbench/studio-schema.ts:320`. It is cut again at these places, and every one of them goes:
  - `lib/shell/create-project.ts:18`
  - `components/graphite/home/home-model.ts:52,75,86,106`
  - `components/graphite/board/cards/doc/model.ts:16,223`
  - `components/graphite/board/cards/doc/BriefDocCard.tsx:62,94`

  Model calls read only a prefix of it:
  - `lib/workbench/atomik-server.ts:196,307`
  - `lib/workbench/rig-agent-plan.ts:102`
  - `lib/production/looks.ts:34`
  - `app/api/atomik/ideas/draft/route.ts:72`
  - `lib/guest/board.ts:38`
- **Already decided and built:**
  - Step d, the limits in words until reading ships: #911.
  - Step a, Attach a brief through the chunked upload, with the size check first and the file in the Library before anything reads it: branch `feat/brief-upload-first-20261024` at 22316637, Opus-approved, opens after #911.

## The steps

### 1. Land (step a, built)
Attach a brief uploads through the chunked path first. Every file becomes a Library row, and a bundle of files is one brief. A file over 2 GiB is refused in words before any chunk. Nothing new here beyond 22316637, apart from the bundle and its file limit (SOW v2 Part II.1, Price and limits), which go in with step 2.

### 2. `read_document`, the registry tool (off until its mocked tests pass)

**The tool.**
- A declaration in the shape the registry uses today (`lib/workbench/plan-step-tool.ts:18-31` is the pattern): `{ id: "read_document", kind: "app", provider: "particl", needs: ["DOCLING_ENABLED", "DOCLING_WORKER_URLS", "DOCLING_WORKER_SECRETS"], route, inputs, price, who }`.
- A Zod input (upload ids, a brief id, an optional page range) and a Zod output (the reading's id, its pages, its state).
- Listed for MCP in `lib/mcp.ts` (`TOOLS`, `runTool`) and on the Connections page (`lib/shell/tools-connections.ts:62`).
- Atomik, the Attach button and an outside agent all call this one tool.

**The job.**
- It never runs inside a request. The route enqueues an Inngest event (`lib/dispatch.ts` `EVENTS`; a new function beside `lib/workers.ts:208`), following `lib/workbench/development-worker.ts`: ids only in the event, one `step.run` per batch of pages, and a fresh event to continue past the step limit.
- Temporal takes it over when the Temporal lane lands. The tool's contract does not change.

**The worker.**
- A Docling service as its own container, in the shape of `ops/render-worker/` and `ops/remotion-worker/`: no internet, a relay, a bearer secret, and a fail-closed egress check before it listens.
- The app reaches it the way `lib/astra-blender/backend.ts:31-67` reaches the Blender worker: `DOCLING_WORKER_URLS` (1-3 origins) and `DOCLING_WORKER_SECRETS` (a bearer of at least 32 characters).
- The worker reads the file through a presigned URL (`lib/storage.ts:682` `presignedReadUrl`), never through the app's memory.

**What it reads:**
- **Formats:** PDF, Word, PPTX, Excel and images.
- **Reading order:** layout-aware, with headings, paragraphs and slide notes kept.
- **Tables:** kept as tables. A sheet becomes rows with its sheet and row cited.
- **Images:** figures with their captions; images extracted as files, each a Library row with the page or slide it came from.
- **Scans:** read by Docling's own OCR, with a confidence on each block.
- **Pages:** streamed page by page, never truncated.

**What it writes:**
- The full document model goes to storage, keyed by the content hash of the bytes (the `uploads.sha256` column), so re-reading the same bytes is free.
- Rows go to new workspace tables. **Schema, on the owner's yes, after his backup.** The migration plan comes first as a docs PR, in the shape of #912:
  - `document_readings`: id, upload id, content hash, state (queued, reading, read, failed, refused), pages read, pages total, OCR pages, started, finished, failure in words.
  - `document_blocks`: reading id, page or slide, kind (heading, paragraph, table, figure, note), text, bounding box, OCR confidence.
- Text is indexed for search with FTS5 when the record's search lands. Embeddings are later; they are not this step.
- Progress is a row per page batch that the Brief reads (per file and per page; scans said as scans), as `workbench_development_steps` does for development jobs.

**Limits:**
- Per file and per brief: the limits in SOW v2 Part II.1 (Price and limits); the file itself up to 2 GiB. Past a limit, the file is refused in words before anything is quoted, and the refusal names the limit.
- Time: a limit sized to the file's pages, not a fixed 120 s. A stage that times out fails in words, keeps what it read, and offers to continue.

**Tests (mocked; `ENGINE_MOCK=1`, no worker):**
- In the shape of `tests/unit/planStepTool.spec.ts` and `tests/unit/directEngineMcp.spec.ts`:
  - the tool is declared once;
  - it is listed for MCP;
  - it is off unless `DOCLING_ENABLED=1`;
  - a mocked worker's pages land as blocks;
  - a scanned page lands with OCR confidence;
  - a table stays a table;
  - the same bytes read again bill and run nothing.
- Synthetic fixtures only: three synthetic decks, plus the owner's three stripped briefs when he sends them.

### 3. The Reading quote [money]

**The price.**
- Reading is quoted as a ceiling before it runs ("up to N cr", the page count beside it), by page for documents and decks, by sheet for spreadsheets (audio and video by minute arrive with step 5). The words come from the copy table, never written here.
- It is settled at what was read, never above the quote. A reading that finds nothing is free.
- Upload, Docling's own run and OCR are inside the quote, never extra lines.

**The path.**
- The pattern is transcription's: priced per unit, reserved at the estimate, settled at the measured count (`lib/transcription.ts:18-27`; `app/api/audio/transcribe/route.ts:33,37`).
- Plumbing: `lib/quote.ts`, `lib/credits.ts`, the reservation (`lib/generationRequests.ts:498`) and the meter (`lib/meter.ts:158`).
- The route joins `PAID_ROUTES` (`tests/helpers/paidRoutes.ts:12`), and the button carries its spend markers (`tests/unit/spend-buttons.spec.ts`). It reserves before the worker runs and settles at zero on refusal (`tests/unit/paidEntryPoints.spec.ts`).

**Where figures live.** The per-page rate lives in the private policy and Coolify, never in the repo. The repo holds the shape and tests with synthetic values.

### 4. Retire the browser reader's limits
Once steps 2 and 3 are on in the house:
- the 30,000-character cuts listed above go, and a model call reads a working set over the document model, not a prefix of it;
- the 20 MB, 400-page and 2 MB caps and #911's sentence leave the screen;
- `brief-file.ts` hands every file to `read_document`;
- `extractScreenplayPdf` stays only for screenplays, if the owner wants it.

### 5. Later in the lane (each its own PR)
- Audio and video: transcripts with speakers and timestamps; keyframes with descriptions.
- The brief schema (Zod) and the extraction turn, with citations to file, page and quote; conflicts are kept, not resolved.
- Mapping the extracted values to record rows, which needs M2.
- The brief-as-read page.
- Links with consent.
- Fountain and Final Draft.
- The nightly reading proof.

## Every file the lane will touch

- **Step 2, new files:**
  - `lib/reading/tool.ts` (declaration and Zod)
  - `lib/reading/job.ts` (Inngest function)
  - `lib/reading/worker.ts` (worker client)
  - `lib/reading/store.ts` (rows)
  - `app/api/reading/route.ts`
  - `app/api/reading/[id]/route.ts` (state and progress)
  - `ops/docling-worker/` (Dockerfile, compose.yaml, README, egress check)
  - `tests/unit/readDocument.spec.ts`
  - `tests/fixtures/reading/*` (synthetic)
  - `docs/reading-schema.md` (the migration plan)
- **Step 2, changed files:**
  - `lib/mcp.ts`
  - `lib/shell/tools-connections.ts`
  - `lib/dispatch.ts`
  - `lib/workers.ts` (registers the function)
  - `app/api/inngest/route.ts`
  - `lib/db.ts` (the tables, on the owner's yes)
- **Step 3, changed files:**
  - `lib/quote.ts`
  - `lib/credits.ts`
  - `lib/reading/price.ts` (new)
  - `tests/helpers/paidRoutes.ts`
  - `tests/unit/paidEntryPoints.spec.ts`
  - `tests/unit/spend-buttons.spec.ts` (the route and button join the guard lists; nothing is loosened)
  - `components/graphite/home/BriefBox.tsx`
  - `lib/copy.ts`
- **Step 4, changed files:**
  - `components/graphite/home/brief-file.ts`
  - `BriefBox.tsx`
  - `GuestBox.tsx`
  - `home-model.ts`
  - `lib/shell/create-project.ts`
  - `lib/workbench/studio-schema.ts:320`
  - `board/cards/doc/model.ts`
  - `BriefDocCard.tsx`
  - `lib/workbench/atomik-server.ts`
  - `rig-agent-plan.ts`
  - `lib/production/looks.ts`
  - `app/api/atomik/ideas/draft/route.ts`
  - `lib/guest/board.ts`
  - `lib/copy.ts` (#911's sentence goes)

## Every variable it will need (names only; the owner sets values in Coolify)

| Name | What | Default |
|---|---|---|
| `DOCLING_ENABLED` | the tool's switch, read through `engineEnabled` (`lib/engineGate.ts:19,36`): on only for `"1"`, and only in the house until the site setting opens it | off |
| `DOCLING_WORKER_URLS` | 1-3 origins of the Docling worker | unset = the tool says reading isn't available, nothing billed |
| `DOCLING_WORKER_SECRETS` | the bearer the app sends the worker (≥ 32 characters) | unset = as above |
| `DISPATCH_MODE`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | existing; reading runs as an Inngest job, or through `/api/worker` in native mode | as today |

No vendor key: Docling and its OCR run on our own worker. A fallback OCR for low-confidence Indian-script pages would bring its own key, named in its own adapter PR.

## Estimate (lead's, in working days)

| Step | Days |
|---|---|
| 1 (step a): open, CI and merge | 0.5 |
| Schema plan doc (docs) | 0.5 |
| 2: tool, job, worker container, mocked tests | 4–5 |
| 3: the Reading quote [money] | 2 |
| 4: retiring the limits | 1.5 |
| 5: audio/video, schema and extraction, mapping, page, links, scripts | 8–10, after M2 |

## Questions for the owner

1. **Host.** Does the Docling worker run on this droplet now (inside the lead's 5-core cap, as the Blender worker does), or wait for the second server? Recommended: the droplet now, one container, one reading at a time.
2. **OCR engine.** Docling's default OCR, or another engine Docling ships with for Devanagari and other Indian scripts? Either way, a low-confidence page is marked, never trusted silently. Recommended: the default first, with the Indian-script engine chosen after a test on the stripped briefs.
3. **Low-confidence fallback.** SOW v2 Part II.1 names a cloud OCR as the fallback for low-confidence pages. That is a vendor and a key. Now, or after the first reading proof?
4. **Schema.** Do you agree to the two tables above (`document_readings`, `document_blocks`) in the workspace database, with the migration plan as its own docs PR first?
5. **Screenplays.** Keep the browser PDF reader for screenplays only, or retire it with the rest in step 4?
6. **Inngest first.** Reading runs on Inngest (and native `/api/worker` dispatch) until Temporal lands. Is that right for the first release?
