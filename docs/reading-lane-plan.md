# The reading lane: how the code gets there (plan, docs only)

The behaviour is specified privately in SOW v2 §9 (Brief), §10 and Part II.1, cited here by section number only. This plan does not restate it: it lists the code each step changes, the tables, the variables and the tests. The owner's questions are in the lead's report, not here.

- One PR per step.
- Step 3 is money: Opus money review, then the owner's head-pinned yes.
- Step 2's tables are schema: the owner's yes on the migration, after his backup.

## Starting point (release/1 5dca1254)

| Today | Where |
|---|---|
| The browser reads a brief: .pdf, .txt, .md, .markdown, .fountain; text files up to 2 MB | `components/graphite/home/brief-file.ts:8,10,31` |
| PDF text by pdfjs, 20 MB, 400 pages, 120 s; no OCR | `lib/workbench/screenplay-pdf.ts:23,63,89-124`; `lib/workbench/screenplay.ts:2-4` |
| Text kept to 30,000 characters, and the screen says so | `brief-file.ts:37`; `components/graphite/home/BriefBox.tsx:59-67`; `components/graphite/guest/GuestBox.tsx:35-40` |
| Chunked upload: 3.5 MB chunks, three at a time, up to 2 GiB | `lib/uploadRecovery.ts:6,212-218`; `lib/uploadClient.ts:325-326`; `lib/uploadReservations.ts:14-16` |
| A document lands as an `uploads` row, `kind = 'file'`, with a `sha256` | `app/api/uploads/finish/route.ts:50-58`; `lib/uploadReservations.ts` (`completeUpload`); `lib/db.ts` (`uploads`) |
| `project.brief` capped at 30,000 | `lib/workbench/studio-schema.ts:320` |
| Further cuts of the brief | `lib/shell/create-project.ts:18`; `components/graphite/home/home-model.ts:52,75,86,106`; `components/graphite/board/cards/doc/model.ts:16,223`; `components/graphite/board/cards/doc/BriefDocCard.tsx:62,94` |
| Model inputs that take a prefix of the brief | `lib/workbench/atomik-server.ts:196,307`; `lib/workbench/rig-agent-plan.ts:102`; `lib/production/looks.ts:34`; `app/api/atomik/ideas/draft/route.ts:72`; `lib/guest/board.ts:38` |

Already open or built: #911; branch `feat/brief-upload-first-20261024` (22316637).

## Step 1: Attach a brief through the chunked upload (built)
Open and merge 22316637.

## Step 2: `read_document` (registry tool, off by default)

| Piece | Files |
|---|---|
| Declaration and Zod input/output | `lib/reading/tool.ts` (new), in the shape of `lib/workbench/plan-step-tool.ts:18-31` |
| MCP and the Connections page | `lib/mcp.ts` (`TOOLS`, `runTool`); `lib/shell/tools-connections.ts:62` |
| Job | `lib/reading/job.ts` (new), an Inngest function in the pattern of `lib/workbench/development-worker.ts`; registered in `lib/workers.ts:208` and `app/api/inngest/route.ts`; events in `lib/dispatch.ts` |
| Worker | `ops/docling-worker/` (new: Dockerfile, compose.yaml, README, egress check), copied from `ops/render-worker/`; the app's client `lib/reading/worker.ts` (new), in the pattern of `lib/astra-blender/backend.ts:31-67`; files fetched by `lib/storage.ts:682` (`presignedReadUrl`) |
| Stored result | under the workspace's own storage prefix (`lib/storage.ts:45`), looked up by (workspace, `uploads.sha256`), never across workspaces |
| Tables [schema, the owner's yes] | `document_readings` and `document_blocks` in the workspace database (`lib/db.ts`); their migration plan first, as its own docs PR |
| Routes | `app/api/reading/route.ts`, `app/api/reading/[id]/route.ts` (new) |
| Tests | `tests/unit/readDocument.spec.ts` (new), mocked worker, `ENGINE_MOCK=1`, in the shape of `tests/unit/planStepTool.spec.ts` and `tests/unit/directEngineMcp.spec.ts`; synthetic fixtures in `tests/fixtures/reading/`; includes a second-workspace case that must read nothing of the first |

## Step 3: the price of a reading [money]

| Piece | Files |
|---|---|
| Pricing (rate from the private policy; no figure in the repo) | `lib/reading/price.ts` (new); `lib/quote.ts`; `lib/credits.ts` |
| Reserve and settle | `lib/generationRequests.ts:498`; `lib/meter.ts:158`. Unlike `lib/transcription.ts:18-27`, settlement is capped at the figure shown, and a test proves a settlement above it is refused |
| Guards (entries added, nothing loosened) | `tests/helpers/paidRoutes.ts:12`; `tests/unit/spend-buttons.spec.ts`; `tests/unit/paidEntryPoints.spec.ts` |
| Words | `lib/copy.ts` |

## Step 4: the browser limits retired
`components/graphite/home/brief-file.ts`, `BriefBox.tsx`, `components/graphite/guest/GuestBox.tsx`, `home-model.ts`, `lib/shell/create-project.ts`, `lib/workbench/studio-schema.ts:320`, `components/graphite/board/cards/doc/model.ts`, `BriefDocCard.tsx`, `lib/workbench/atomik-server.ts`, `lib/workbench/rig-agent-plan.ts`, `lib/production/looks.ts`, `app/api/atomik/ideas/draft/route.ts`, `lib/guest/board.ts`, `lib/copy.ts`.

## Later steps
Each is its own PR, mostly after M2, in the order the SOW sets.

## Variables (names only)

| Name | Use | When unset |
|---|---|---|
| `DOCLING_ENABLED` | the switch, through `engineEnabled` (`lib/engineGate.ts:19,36`): on only for `"1"` | off |
| `DOCLING_WORKER_URLS` | 1-3 worker origins | the tool says reading isn't available; nothing billed |
| `DOCLING_WORKER_SECRETS` | the bearer to the worker (≥ 32 characters) | as above |
| `DISPATCH_MODE`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | existing dispatch | as today |

## Estimate (working days)

| Step | Days |
|---|---|
| 1 | 0.5 |
| schema plan | 0.5 |
| 2 | 4–5 |
| 3 | 2 |
| 4 | 1.5 |
| later steps | 8–10, after M2 |
