# Long synchronous requests: under 100 s (measure and design)

Lane `long-flows`, phase 1, 8 Oct 2026. Base `origin/release/1` c287f044. No product code changed.

**Goal.** Every request sends its first byte within 100 s and never goes quiet for 100 s, so Cloudflare's orange cloud (524 after ~100 s with no byte) can be switched on later. Grey cloud at cutover has no such limit.

**Read first.** On the self-hosted server (`next start`) **`maxDuration` does nothing**. Only the code's own timeouts limit a request (270 s for text, 280 s for transcription). Today Vercel stops these routes at 120–800 s. After the move nothing stops them early.

**`origin/main`.** It runs the same code for timing: the same timeouts, `maxDuration`, provider calls and upload assembly. `release/1` only adds guards (sample-workspace refusal, consent, people-only, origin check) and the MCP `prepare_shot` tool.

## 1. What each route does before it answers

| Route | Work before the first byte | External calls and their own timeouts | `maxDuration` | Streams? | Money | Client (file:line), waits?, retry |
|---|---|---|---|---|---|---|
| A `POST /api/uploads/finish` (chat, ≤ 2 GiB) | Claim lease (20 min). Read every 3.5 MB chunk in order, sha256 it, stream it into one object, check the byte count. Bounded length check for audio/video ≤ 200 MB (20 s). Write `prepared`, delete chunks, insert the upload row. | R2: GET per chunk and one 8 MiB `UploadPart` at a time (120 s per request, `lib/storage/r2.ts:202`). Blob: the same shape. Local: `readFile` + write stream. | 800 | no | No credits. Reserves workspace storage (`planUploadObjects` → `admit`); `abandonUpload` releases it on failure. | `lib/uploadClient.ts:260`. The UI waits ("finishing"). Not idempotent by key, but an identical retry is: 409 "still finishing" while the lease is held, then the saved reply. A 5xx/524 throws "Resume it from Uploads". `components/UploadRecovery.tsx:87,98` re-checks `/api/uploads/session`. |
| A′ same route, `reference` (≤ 200 MB) | `assembleChunks` holds the whole file in memory. Optional delivery copy (sharp). `storeUpload`. Video length check (20 s). | Same storage calls | 800 | no | Storage reservation, as above | Same client |
| B `POST /api/audio/transcribe` | Duration lookup (≤ 20 s inspect) → reserve the estimate → read the source (≤ 100 MB) → **Grok STT, waits for the whole transcript** → save the transcript → settle → reply | xAI `/stt` 280 s (`lib/xaiVoice.ts:145`), no retry | 300 | no | **Credits.** Reserved at the estimate, settled at ≤ 3× the estimate, under an Idempotency-Key. The transcript is saved before it is charged. | `lib/workbench/transcription-request.ts:255` through `components/graphite/board/transcribe/use-transcribe.ts`. The UI waits. A lost reply (≥ 500) becomes "unknown". A `pending` answer is re-checked automatically through `/api/generate/check` (2, 4, 8, 15, 30 s); otherwise the person presses Check. Never re-sent. |
| C1 `POST /api/atomik/[id]` (planning turn) | Context, memory, rules, library → `runPaidText` (4000 visible tokens + reasoning allowance up to the model's maximum) | AI Gateway / OpenAI 270 s (`lib/atomik.ts:970`), no retry | 300 | no | **Credits.** Reserve, settle at cost; claim under an Idempotency-Key | `components/atomik/AtomikProvider.tsx:437` → `components/atomik/threads/useThreadSends.ts:122`. The UI waits ("thinking"). A non-final 409 or 5xx keeps the saved request, and the person presses Recover, which replays the same key. |
| C2 `POST /api/atomik/memory/read` | `runPaidText`, 3000 tokens, no effort | 270 s | 300 | no | Credits, same way | `components/graphite/atomik/MemoryView.tsx:28` via `lib/usePaidAction.ts:159` (saved request, Recover) |
| C3 `POST /api/atomik/ideas/draft`, `shots/draft`, `treatment/scene` | `runPaidText`: 600 / 2400 / 900 tokens + reasoning allowance (`effort`) | 270 s | 300 | no | Credits, same way | **No UI caller on release/1** (old Atomik pages deleted). API only, render-scope token. |
| C4 `POST /api/prompt/enhance` | `runPaidText`, 400 tokens, no effort, answer checked before settling | 270 s (default), cut to 120 s on Vercel only by the route stopping | 120 | no | 1 cr, reserved and settled. The key is held for the exact press (account, workspace, words, settings, price) until its saved answer is read (`lib/shell/enhance-press.ts`): pressed again after a lost reply, it collects the saved answer, not a second charge. Changed words or settings, or an answer read, start a fresh key. | `lib/shell/use-enhancer.ts`. The UI waits (busy). |
| C5 `POST /api/mcp` `tools/call` | `wait_for_render` polls `/api/jobs/:id` every 5 s for **240 s by default, up to 270 s**, and sends nothing meanwhile. A poll is not always quick: the one that sees the take finish runs `syncGeneration`, which stores the video (download + upload, `lib/jobs.ts:510`) before it answers, and the internal fetch had no timeout. Other tools are quick: `render_shot` → `/api/generate`, which already defers the work with `after()`. | Internal fetches | 300 | no (plain JSON) | None in the wait itself | MCP clients; the reply text says "call again" |
| C6 `POST /api/identities/[id]/train` | Read ≤ 40 photos one by one, zip them (in memory), store the zip, fal submit → 202 | fal submit 60 s (`lib/fal.ts:81`) | 120 | no (202 after submit) | Credits (54 cr), reserved before submit | **No UI caller on release/1** (people-only; tokens are refused) |
| C7 `POST /api/soul/identities` | Consent, DB, presign ≤ 40 references (local signing), funding check, provider POST → 202 | Higgsfield API 60 s (`lib/higgsfield.ts:338`) | 120 | no (202) | Credits, reserved before submit | `components/graphite/production/CastIdentities.tsx:99` (`usePaidAction`) |

## 2. Measurements (this machine; mock server on :4665, local file backend, `next dev --webpack`)

Raw throughput on one Node thread (AMD EPYC, SHA extensions; `openssl speed sha256` ≈ 1.45 GB/s):

| Operation | MB/s |
|---|---|
| sha256, streamed in 3.5 MB updates | 1,210–1,330 |
| Copy into 8 MiB parts (the R2 compose loop) | 1,750–1,880 |
| `Buffer.concat` 200 MB (reference path) | ~1,000 |
| sha256 of one 200 MB buffer | ~640 |

End-to-end `POST /api/uploads/finish` (chat purpose, random bytes; 3 chunk uploads in parallel, as the client does; warm route):

| Size | Chunks | Chunk upload phase | **finish** | Bytes read / written by the server |
|---|---|---|---|---|
| 50 MB | 15 | 3.6–4.4 s | **0.6–0.9 s** | 50 / 51 MB |
| 500 MB | 150 | 37–38 s | **2.9–3.4 s** | 500 / 508–535 MB |
| 2 GiB | 614 (the maximum) | 173 s | **9.4 s** | 2,049 / 2,049 MB |

The returned sha256 matched `sha256sum` every time. The first 50 MB run took 3.6 s because of the route's cold compile.

How the time divides (the route's local loop rerun on its own over the same chunk files, 2 GiB / 500 MB):

| Step | 2 GiB | 500 MB |
|---|---|---|
| Read the chunks only | 4.3 s | 0.8 s |
| Read + sha256 | 5.1 s | 1.6 s |
| Read + write | 4.2 s | 1.5 s |
| Read + sha256 + write (what the route does) | 7.3 s | 1.8 s |

**Hashing costs ~1.6 s per 2 GiB of CPU. Everything else is IO.** The chunks were still in the page cache, so this is a lower bound for a cold disk. The server process's CPU counter (0.5 / 9 / 32 CPU-s) includes the dev server's file watcher and libuv threads, so it is an upper bound, not the hash.

**R2 or Blob in production cannot be measured here** (no calls allowed). It is modelled from the code. Chunks are fetched one at a time (614 GETs of 3.5 MB for 2 GiB). The parts go up one at a time (256 PUTs of 8 MiB). `Readable.from` lets reading overlap with uploading. At 30–100 ms per request and 30–100 MB/s per stream, that gives **2 GiB ≈ 50–120 s, 500 MB ≈ 12–30 s, 200 MB reference ≈ 5–20 s**.

**Worst case from the code, provider time (B, C).**

| Route | Upper bound before the first byte | What drives it |
|---|---|---|
| B transcribe | ≈ 300 s: 20 s inspect + read ≤ 100 MB + 280 s STT | Audio length (up to 4 h accepted) × xAI speed |
| C1 turn | ≈ 270 s | Reasoning allowance: high 16k, xhigh 24k, max = model maximum. At 50–150 tok/s, 16k tokens alone take 110–330 s. |
| C2 memory read | ≈ 270 s | 3000 tokens; a slow or reasoning-by-default model |
| C3 drafts | ≈ 270 s | Effort allowance as C1 |
| C4 enhance | 270 s on self-host (120 s on Vercel) | Only a stalled provider; 400 tokens is normally seconds |
| C5 wait_for_render | 240 s by default, 270 s maximum | By design |
| C6 train | ≈ 60 s + photo IO (40 × ≤ 30 MB photos ≈ 1.2 GB read + zip write ≈ 15–40 s on R2) | Large photos + a slow fal submit |
| C7 identities | ≈ 60 s + a few DB writes | Higgsfield submit timeout |

**What the owner should read in Vercel** (Observability → Vercel Functions, last 30 days, production; filter by route):
- `/api/uploads/finish`: p99 and max duration, and the count of 504 / FUNCTION_INVOCATION_TIMEOUT. This is today's R2/Blob time for real uploads.
- `/api/audio/transcribe`, `/api/atomik/[id]`, `/api/atomik/memory/read`, `/api/prompt/enhance`, `/api/mcp`: p99 and max. On the `/api/prompt/enhance` row, any duration near 120 s means the route was killed.
- Observability → External APIs: p99 for `ai-gateway.vercel.sh` / `api.openai.com`, `api.x.ai` (`/stt`), and the R2 host. These are the provider times without our code.
- The ledger has the same answer in our own data (an owner-run read on Turso, not done here): `paid_text_jobs` `updated_at - created_at` by `kind`, `model`, `effort`; `meter_events` for `id LIKE 'stt_%'`, the same difference.

## 3. Verdict: can the first byte take longer than 100 s?

| Route | Verdict |
|---|---|
| A finish, chat | **Only for large files on R2/Blob**: ~1 GB and up on a slow link, 2 GiB likely. Local disk: no (9.4 s for 2 GiB). |
| A′ finish, reference | No (≤ 200 MB, ~5–20 s) |
| B transcribe | **Only when the source is long**: tens of minutes of audio, up to the 100 MB / 4 h limits. xAI's real speed decides; check External APIs. |
| C1 Atomik turn | **Yes**, with effort high/xhigh/max or a slow model |
| C2 memory read | Only with a slow or reasoning-by-default model, or a stalled provider |
| C3 drafts | Only with effort ≥ medium; no UI caller today |
| C4 enhance | Only when the provider stalls (no timeout below 270 s on self-host) |
| C5 MCP wait_for_render | **Yes, always** when a render takes > 100 s (default wait 240 s) |
| C6 identity train | Only with very large photos plus a slow fal submit; no UI caller today |
| C7 identities | No (≈ 60 s at most) |

## 4. Proposed fixes (smaller safe option per route)

Neither option needs a new worker event. `/api/generate` already finishes its work after the response with `after(await reserveRecoveryContinuation(...))` (`app/api/generate/route.ts:50`). The same pattern fits here. On self-host `after()` has no time limit. On Vercel it keeps today's `maxDuration`. The recovery fence keeps an unfinished continuation visible to a deploy drain. Streaming (i) is the larger change for every route here. These clients read the status code and the `Idempotency-Status` header, so streaming would mean answering 200 before the outcome is known and moving errors into the body, a change on every client. The existing claims (upload session, Idempotency-Key, `/api/generate/check`) already provide (ii)'s status to poll.

| Route | Fix | Files | Money / idempotency | Estimate |
|---|---|---|---|---|
| A finish | **(ii) 202 + poll.** Claim synchronously, as now. Run assembly → `prepareUpload` → `completeUpload` in `after(reserveRecoveryContinuation("upload-finish", …))`. Answer `202 {state:"assembling", retryAfterMs}`. The client polls `/api/uploads/session` (1 s → 5 s backoff) until `committed` (it reads the receipt) or a gone state (blocked). An identical retry and an already prepared upload still answer 200 at once. Optional in the same PR: fetch 2–3 chunks ahead and keep 3 parts in flight (`lib/storage.ts:487`, `lib/storage/r2.ts:232`) to cut R2 time ~3×. | `app/api/uploads/finish/route.ts`, `lib/uploadClient.ts` (`resumeUpload`, `checkUpload`), tests `tests/unit/uploadClient.spec.ts`, `tests/upload-recovery.spec.ts` | No credits. The storage reservation is unchanged. It is admitted inside the work and released by `abandonUpload` on failure. If the process dies mid-work, the lease (20 min) expires and the next identical finish re-claims and rewrites the same immutable key. Keep `UPLOAD_LEASE_MS` above the worst assembly time, or renew it. | 0.5–1 day (+0.5 for prefetch) |
| B transcribe | **(ii) early answer.** In the opt-in below, the route answers the existing `409 {pending:true}` + `Retry-After` after ~25 s, and the transcription finishes in `after()`. `use-transcribe` already treats `pending` as "waiting" and asks `/api/generate/check`, which returns the saved transcript. **No client change** (prove it in `tests/transcribe-recovery-workbench.spec.ts`). | `lib/generationRequests.ts`, `app/api/audio/transcribe/route.ts`, `tests/unit/transcriptionRecovery.spec.ts` | One claim, one reservation. A replay or check never calls the provider. `TRANSCRIPTION_STALE_MS` (10 min) stays above the 300 s worst case. A process that dies mid-run is answered from the meter after 10 min, exactly as a killed function is today. | in PR 3 |
| C1–C3 | **(ii) early answer**: opt-in `answerAfterMs` (25 s) in `withGenerationRequestData`. Race `run(claim)` against the timer. If the timer wins, return the same `409 {pending:true}` the duplicate-key branch already sends (not marked complete). The existing code then saves `response_json` in `after()` when the run ends. Clients: `useThreadSends.run` and `usePaidAction.run` replay the same saved request (same key) on `pending`, honour `Retry-After`, and stop after ~6 min with today's "Recover the saved request". | `lib/generationRequests.ts`, the five routes (one option each), `components/atomik/threads/useThreadSends.ts`, `lib/usePaidAction.ts`; a test-only mock delay (e.g. `ENGINE_MOCK_TEXT_DELAY_MS`) in `lib/gateway.ts` mock; tests `tests/unit/atomikThreads.spec.ts`, `tests/unit/moneyRoutes.spec.ts`, `tests/r1-port-paid-sends-workbench.spec.ts` | **No double charge.** A replay hits the duplicate-key branch and never reaches `run`. The reservation and settlement stay inside the single run. Risk to test: nothing in `run` may call `next/headers` after the early answer (tenant context is AsyncLocalStorage, so it should hold). Self-host shutdown must drain `after()` work. | 1–1.5 days |
| C4 enhance | A 90 s budget from the route's entry: `runPaidText` takes a `deadline` and gives the provider what is left; with under 20 s left it refuses (503) before anything is reserved. The route prices from its own catalogue read, so paid text does not read the catalogue (up to 15 s + 15 s) a second time. (An early answer would also need a saved request in `use-enhancer`, which is larger.) | `app/api/prompt/enhance/route.ts`, `lib/paidText.ts`, `tests/unit/enhanceTimeout.spec.ts` | A stall past the budget settles the job `uncertain` and bills the 1 cr estimate. Vercel's 120 s kill is different: the function dies mid-call, so the job stays `running` with its reservation held. Either way the cron's pass (`reconcilePaidTextJobs`, `lib/paidText.ts`) refunds it once, 30 min after it was last touched. | 0.5 h |
| C5 MCP | `WAIT_MAX_SECONDS` 270 → 85, `WAIT_DEFAULT_SECONDS` 240 → 60. No poll starts in the last 15 s, and each poll is cut off at the deadline (a cut-off poll answers "still rendering, call again"; the jobs route finishes storing on its own lease). The reply already says "call wait_for_render again". | `lib/mcp.ts`, `tests/unit/mcpTools.spec.ts` | None | 0.5 h |
| C6 train | No change now (no UI caller). If needed later: build the zip and submit in `after()`. The run already has a `preparing` state and the identity is polled. | `lib/identities.ts` | The reservation already comes before the submit | later |
| C7 identities | No change | — | — | — |

**PRs (each small, one concern, into release/1 or the self-host branch; none to main).**
1. `MCP: wait_for_render returns within 85 s`: C5. No money.
2. `Enhance: 90 s provider timeout`: C4. Money-adjacent (timeout outcome), owner yes.
3. `Paid requests: answer pending after 25 s, finish in the background`: `withGenerationRequestData` opt-in + B + C1–C3 + the two client replay loops. **Money path: independent review + owner yes.**
4. `Uploads: finish answers 202 and the client polls`: A. Storage reservation, no credits. Optional 4b: R2 prefetch and parallel parts.

**Self-host runbook (applies to PRs 3–4).** `next start` runs `after()` fully. On SIGTERM it finishes in-flight requests and pending `after()` callbacks before exiting (`node_modules/next/dist/docs/01-app/02-guides/self-hosting.md` § after). Give the container a stop grace of ≥ 300 s. A shorter grace falls back to the recovery paths above: lease expiry, the transcription answered from the meter, and paid text left `running` with its reservation held until the cron's pass refunds it (30 min).

After 1–4 the longest silent wait on any of these routes is ~25 s (PR 3), 85 s (MCP) or 90 s (enhance stall). The chunk and status requests are short.

## Method and clean-up
- Scripts lived in the session scratchpad. Files were written to a scratch folder under `/tmp` and the server wrote to `~/wt/long-flows/.data`; both were deleted after the run. The mock server was stopped and the slot released. ENGINE_MOCK=1; no provider, R2, Blob, Turso, Vercel or particl.si call.
- Measured on `next dev`, so production `next start` should be equal or faster.
