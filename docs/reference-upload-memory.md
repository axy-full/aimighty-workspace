# Reference uploads: bound the memory (plan, next item after streaming storage)

Status: **plan only**, written 9 Oct 2026. Not built.

## The problem

A chat upload (up to 2 GiB) already streams: `streamAssembleUpload` reads the chunks back from R2, sends them on as an R2 multipart upload in 8 MiB parts, and keeps only the first chunk for sniffing (`app/api/uploads/finish/route.ts`, the `purpose !== "reference"` branch).

A **reference** upload (up to 200 MiB, `MAX_REFERENCE_BYTES`) does not:
- `assembleChunks` (`lib/storage.ts`) concatenates every chunk into one `Buffer`;
- `storeReferenceUpload` (`lib/uploadIntake.ts`) then checks the length, sniffs the type (`identifyImage`, `.blend` or GLB magic), validates (`validateVideo`, `validateAstraGlb`, `assess`), may make a provider derivative with sharp (`deriveForProvider`), and stores the master with `storeUpload(…, buf)`.

So one finishing reference holds up to 200 MiB, plus a sharp decode and a derivative for images. Finishes run in `after()` in whichever process claimed them, and nothing limits how many run at once. With 3 processes, several 200 MiB references finishing together can hold well over 1 GiB.

## What each kind actually needs

| Kind | Size today | Needs the whole file in memory? |
|---|---|---|
| Video (mp4/mov) | up to 200 MiB | **No.** `identifyImage` reads the header; `validateVideo(meta, bytes)` needs only the header and the length; the duration comes from `inspectStoredUploadSeconds`, which already reads the stored object with bounded reads. |
| Image | up to 200 MiB (in practice under 50 MiB) | Yes for sharp (`assess`, `deriveForProvider`), but sharp can read from a file or stream. |
| `.blend` | at most 50 MiB (checked) | No. Only the 12-byte magic is checked. |
| GLB | at most 32 MiB (`ASTRA_GLB_BYTES`) | Yes (`validateAstraGlb` parses the JSON chunk), but it is small and bounded. |

## Plan, in two small PRs

**PR 1: cap concurrent whole-file work per process.** This is the quick fix, and it alone stops the multi-buffer case.
- Add a per-process semaphore around the buffered part of a reference finish (`assembleChunks` through `storeUpload`): `REFERENCE_INTAKE_CONCURRENCY`, default **1**.
- The finish route already answers 202 after 10 s and the browser polls `/api/uploads/session`, so a queued finish waits behind the one in front without a timeout. The claim's 20-minute lease covers the wait. Log the wait time.
- Worst case per process: one 200 MiB buffer plus sharp's working set, about 0.5 GiB. Across 3 processes, about 1.5 GiB, down from unbounded.

**PR 2: stream videos and `.blend`, the big files.**
- Video and `.blend` references take the chat path: `streamAssembleUpload` (8 MiB parts, running sha256, byte cap), with the type and checks taken from the head chunk (`identifyImage(headChunk)`, `validateVideo(meta, bytes)`, the `.blend` magic), and the duration from `inspectStoredUploadSeconds` as now.
- If a check fails after the object is stored, delete the stored object, as the current failure path does for a rejected upload.
- Images and GLB stay buffered under PR 1's semaphore; they are smaller, and sharp needs pixels anyway.
- Optional later step: lower the image reference cap to 50 MiB, which would make buffered images bounded by design. This is an owner product decision, because it changes what people can upload.

## Tests to write with it

- A 200 MiB video reference through the finish path: peak `arrayBuffers` growth under 64 MiB, the same `STREAM_MEMORY` line as `tests/unit/storage-stream-memory.spec.ts`.
- Two image references finishing at once in one process run one after the other (the semaphore), and both complete.
- A wrong-type file renamed `.mp4` is still refused, and nothing is left stored.
- The sha256, length and record match today's buffered path for the same file.
