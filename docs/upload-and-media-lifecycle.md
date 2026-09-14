# Upload and media lifecycle

Browser upload mutations carry the account/workspace scope captured when their page opened. A stale or missing browser scope returns 409 before a storage write. Explicit bearer-token callers retain their existing token authorization path. Private upload and generated-media responses use `private, no-store` so a browser cache cannot skip authorization after an account change.

## Storage admission and recovery

`upload_sessions` and `upload_chunks` live inside each tenant database. A write transaction reserves each immutable chunk's size before storage. Repeated identical chunks reuse their reservation; different bytes for the same chunk are rejected. Final master and delivery-copy objects are recorded before writing, and any additional delivery-copy bytes are admitted atomically. Concurrent sessions cannot each consume the same remaining quota.

A finish request has one immutable filename/purpose/chunk-count and one upload ID. The server persists prepared metadata before deleting staged chunks. Publishing the upload row and removing its reservation happen in one transaction. A retry can finish a prepared upload after a database failure without downloading the chunks again. `GET /api/uploads/session?session=UUID` exposes only the current owner's recovery facts, stored chunk indexes, immutable finish request, lease wait duration and committed upload response. A deleted upload is reported as `removed` and cannot be recreated by replaying its old finish request.

Chat uploads accept up to 2 GiB: the browser's 3,500,000-byte slices require at most 614 chunks. Reference uploads are bounded to 200 MiB before assembly. The streaming assembler rejects bytes beyond the reserved amount. New nonlegacy local staging uses `.data/chunks/ws/<workspace-id>/<owner>/<session>/<index>`; legacy local staging keeps its original path. Blob staging paths already use the same tenant prefix.

An unfinished session expires after 24 hours. Chunk writes hold a five-minute lease; assembly holds a twenty-minute lease, longer than the finish function's execution limit. Cancelling or failing does not release bytes whose storage acceptance is uncertain. `cleanupExpiredUploads(5)` removes all recorded staging and unpublished objects before releasing the reservation. Its `{attempted, cleaned, failed}` result distinguishes a storage failure from another cleanup worker owning the lease. Terminal session recovery records are retained for seven days beyond expiry.

## Deletion and quota

Deletion checks every private workbench draft and every published bible, including nested asset versions and lineage. It also checks catalog versions, identities, cast members, chat uploads, look presets, board outputs, render source/reference records and Atomik attachments. It returns a generic 409 without exposing another collaborator's private draft title. Workbench saves and publication validate source identities inside the same write transaction used by deletion: save-first blocks deletion; delete-first blocks a stale save.

Upload deletion transfers original master and delivery-copy locations into durable cleanup and removes the visible upload identity in one transaction. Failed object deletion retains its reserved bytes and retries through the upload cleanup worker.

Generated takes in queued, running or held state cannot be deleted because no provider cancellation has been confirmed. A terminal take is hidden while its original storage locations, bytes and billed cost remain recorded. Strict storage deletion clears only the matching snapshot of the tombstone; a concurrent newer completion cannot release its bytes. `cleanupDeletedGenerations(5)` retries with durable ownership and returns `{attempted, cleaned, failed}`. The DELETE route returns 202 with `cleanupPending: true` while bytes remain. Quota includes retained deleted bytes until successful removal; historical billed cost never disappears. Both cleanup workers order eligible work by the oldest cleanup attempt, then stable record order, so a permanently failing object cannot starve later deletions. Uploads add a backward-compatible `cleanup_attempted_at` column with a zero default for existing rows.

## Verified locally

Tests use temporary tenant/platform databases and replace only remote storage operations when injecting failures. They cover concurrent quota admission, duplicate chunk and finish requests, abort/expiry ownership, storage and database failures, durable recovery, tenant/database rotation, private and catalog bindings, failed deletion followed by retry, late completion during cleanup, and the 614th chunk boundary. The isolated real HTTP rehearsal exercises scope rejection, cookie-free bearer uploads, quota contention, exact assembled SHA-256, authenticated byte reads, deletion protection, recovery status and removed-upload detection. It also exercises cross-origin auth rejection and a real password-reset cookie transition through a local mail sink. No real AI-provider request or customer email is made.

## Attachment and deletion ordering

Outside the workbench, `lib/mediaMutation.ts` puts source validation and the final attachment write in the same tenant write transaction as guarded deletion. Sources must exist in that tenant; a generation marked deleted cannot be attached. The transaction covers:

- `app/api/chat/route.ts`: upload validation and message insertion.
- `app/api/cast/route.ts` and the cast update route: upload assignment when creating/updating a cast member.
- `lib/identities.ts`: `verifiedPhotos` followed by identity creation/update; casting an identity's cover into a cast record.
- `lib/elements.ts`: catalog `attribute_versions` insertion with upload/generation identities.
- `lib/boards.ts`: saving nodes/output references.
- `lib/atomik.ts`: persisting user-message attachments, proposed-step references and parameter edits. Parameter edits also compare the step status and update timestamp so an edit waiting on pricing cannot overwrite a step that started running.
- `app/api/generate/route.ts`: resolving source/reference media before persisting the new generation's reference list.
- `lib/shots.ts` and `app/api/shots/[id]/route.ts`: source identities in shot setup, including an atomic move of the shot and its takes when updating setup and project together.

A request that resolved a source before deletion must validate it again at the final write. Attachment-first blocks deletion; deletion-first rejects the stale attachment, without committing a dangling reference. Identity photo selections fail visibly if an image disappeared instead of silently discarding it. Provider requests, storage operations, pricing and notifications remain outside these transactions. Generation source refusals return a completed, replayable 409 for the same idempotency key before media submission.

Local regressions pause the first real transaction before commit and start the competing request while its write lock is held. They exercise both orders for fourteen catalog/chat/board/shot attachment writers, verify transaction rollback and tenant separation, and run the actual image/video route handlers with a source removed after initial resolution. Provider boundaries are replaced with rejecting counters; those source-refusal tests record zero paid calls.
