# Reference uploads: bound the memory (plan, next item after streaming storage)

Status: **plan only**, written 9 Oct 2026. Not built.

## The problem

A chat upload (up to 2 GiB) already streams: `streamAssembleUpload` reads the chunks back from R2, sends them on as an R2 multipart upload in 8 MiB parts, and keeps only the first chunk for sniffing (`app/api/uploads/finish/route.ts`, the `purpose !== "reference"` branch).

A **reference** upload (up to 200 MiB, `MAX_REFERENCE_BYTES`) does not:
- `assembleChunks` (`lib/storage.ts`) concatenates every chunk into one `Buffer`;
- `storeReferenceUpload` (`lib/uploadIntake.ts`) then checks the length, sniffs the type (`identifyImage`, `.blend` or GLB magic), validates (`validateVideo`, `validateAstraGlb`, `assess`), may make a provider derivative with sharp (`deriveForProvider`), and stores the master with `storeUpload(…, buf)`.

So one finishing reference holds up to about 400 MiB at its peak: `assembleChunks` keeps the parts and the joined buffer at once. Images add a sharp decode and a derivative on top. Finishes run in `after()` in whichever process claimed them, and nothing limits how many run at once. With 3 processes, several 200 MiB references finishing together can hold well over 1 GiB.

## What each kind actually needs

| Kind | Size today | Needs the whole file in memory? |
|---|---|---|
| Video (mp4/mov) | up to 200 MiB | **No**, with one catch. `identifyImage` reads the header and `validateVideo(meta, bytes)` needs only that and the length. But the 2-second minimum uses the duration that `mp4Duration` finds by walking the whole buffer to the `moov` box, and in many files `moov` comes last. From the first chunk alone that check would be skipped, so the streamed path must re-check the minimum on `inspectStoredUploadSeconds` (bounded reads of the stored object) and delete the object if it fails. |
| Image | up to 200 MiB (in practice under 50 MiB) | `assess` needs only the metadata and the length; only `deriveForProvider` decodes pixels with sharp, and sharp can read from a file or a stream. |
| `.blend` | at most 50 MiB (checked) | No. Only the 12-byte magic is checked. |
| GLB | at most 32 MiB (`ASTRA_GLB_BYTES`) | Yes (`validateAstraGlb` parses the JSON chunk), but it is small and bounded. |

## Plan, in two small PRs

**PR 1: cap concurrent whole-file work per process.** This is the quick fix, and it alone stops the multi-buffer case.
- Add a per-process semaphore around the buffered part of a reference finish (`assembleChunks` through `storeUpload`): `REFERENCE_INTAKE_CONCURRENCY`, default **1**.
- The finish route already answers 202 after 10 s and the browser polls `/api/uploads/session`, so a queued finish waits behind the one in front without a request timing out. Log the wait time.
- Worst case per process: about 400 MiB while assembling (parts plus the joined buffer), plus sharp's working set for an image, so about 0.6–0.8 GiB. Across 3 processes about 2–2.4 GiB, down from unbounded. PR 1 should also free the parts array as soon as the buffer is joined, which brings this down to about 0.25 GiB per process.
- A long queue must not outlive the claim: a finish waiting behind the semaphore longer than the 20-minute finish lease could be claimed again by a retry on another process. Either renew the lease while waiting, or bound the wait (for example 10 minutes, then release the claim so the browser's poll retries). Add a spec for whichever is chosen.

**PR 2: stream videos and `.blend`, the big files.**
- Video and `.blend` references take the chat path: `streamAssembleUpload` (8 MiB parts, running sha256, byte cap), with the type and checks taken from the head chunk (`identifyImage(headChunk)`, `validateVideo(meta, bytes)`, the `.blend` magic). The duration comes from `inspectStoredUploadSeconds`, and the 2-second minimum is checked again on it (see the table).
- If a check fails after the object is stored, delete the stored object, as the current failure path does for a rejected upload.
- Images and GLB stay buffered under PR 1's semaphore; they are smaller, and sharp needs pixels anyway.
- Optional later step: lower the image reference cap to 50 MiB, which would make buffered images bounded by design. This is an owner product decision, because it changes what people can upload.

## Tests to write with it

- A 200 MiB video reference through the finish path: peak `arrayBuffers` growth under 64 MiB, the same `STREAM_MEMORY` line as `tests/unit/storage-stream-memory.spec.ts`.
- Two image references finishing at once in one process run one after the other (the semaphore), and both complete.
- A wrong-type file renamed `.mp4` is still refused, and nothing is left stored.
- A 1-second mp4 with `moov` at the end is still refused, and nothing is left stored.
- The sha256, length and record match today's buffered path for the same file.
