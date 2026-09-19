# Cloudflare R2 storage plan

Written 19 September 2026 from a read-only inventory of every Vercel Blob touch point. Decision of record: move private media from Vercel Blob to Cloudflare R2 behind the existing `lib/storage.ts` surface, after the first verified backup capture and before long-form mastering, so masters are never migrated twice. Measured motivation for the current period: Blob data transfer 51 GB ($3.43) and fast origin transfer 17 GB ($4.24, bytes streamed through functions), against 404 MB stored. R2 has no egress charge; the saving only materialises if private downloads stop flowing through functions.

## What exists today (inventory)

- All Blob calls are lazy `await import("@vercel/blob")` inside `lib/storage.ts`, `lib/purge.ts`, `lib/storageCost.ts`, `app/api/health/route.ts`, `scripts/ops/backup-lib.mjs` and `scripts/ops/staging-rehearsal.mjs`. `@vercel/blob/client`, `handleUpload` and upload webhooks are **not** used; browser uploads go through the chunk routes (`/api/uploads/session|chunk|finish`, 3.5 MB slices, 4 MiB gate) and the reservation state machine in `lib/uploadReservations.ts`. The README sentence "uploads go browser → Blob directly" is stale.
- Keys: `ws/<workspaceId>/…` for tenant workspaces, bare keys for the legacy workspace, `platform/…` and `health/…` unprefixed. Isolation is the key prefix plus one store-wide token.
- Database rows hold route URLs (`/api/media/<id>`, `/api/uploads/<id>`), except `identities` and `platform_assets` (bare pathnames) and older `uploads.stored_url`/`workbench_media.stored_url` rows that may hold absolute Blob URLs. Two substring checks on `.public.blob.vercel-storage.com/` (`lib/storage.ts:351, 547`) decide public-vs-private reads.
- Private reads: `presignedReadUrl(pathname, hours)` is the single signer (1 h health, 6 h playback, 24 h exports/providers). `/api/media/[id]` 302-redirects to a presigned URL by default, proxies for `?stream=1` (same-origin canvas capture) and streams for `?download=1`; `/api/uploads/[id]` always streams through the function with Range support and an attachment disposition. Presigned URLs are also handed to Ark, fal, Higgsfield and the identity trainer.
- Writes: `put` with `addRandomSuffix:false`; `storeVideoBytes` relies on `allowOverwrite:false` throwing to trigger hash verification (immutability); `streamAssembleUpload` is the one `multipart:true` writer; every put/del is wrapped in `withRecoveryActivity(..., { uncertainOnError: true })`.
- Enumeration: purge lists by workspace prefix and relies on deletion shrinking the prefix; backup lists the whole store and cross-checks against DB rows; restore refuses to overwrite and verifies sha256/size on read-back.
- Health: the deep probe writes 10 bytes, presigns 1 h, and asserts `206` with `bytes 0-1/10`.
- Cost model: `lib/storageCost.ts` hard-codes Blob per-GB storage and egress rates and feeds the Usage page.

## Decisions

1. **Backend selector.** `STORAGE_BACKEND=blob|r2|local` (default: `blob` when `BLOB_READ_WRITE_TOKEN` is set, else `local`). R2 config: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; endpoint derived as `https://<account>.r2.cloudflarestorage.com`. Production and Preview use separate buckets. `lib/deploymentReadiness.ts` accepts either backend's variables.
2. **One bucket per environment, keys unchanged.** Tenant isolation stays the key prefix; bucket-per-tenant would break backup enumeration and the legacy bare-key contract for no security gain at one store-wide credential. Presigned GETs stay single-key, absolute-expiry.
3. **Rows keep route URLs.** No stored value changes. The adapter resolves a stored value as: route URL → pathname; absolute `*.vercel-storage.com` URL → Blob backend (read-only during migration); anything else → key on the active backend. The two substring checks move into the adapter's `resolve()`.
4. **Downloads redirect instead of stream.** `/api/uploads/[id]?download=1` and `/api/media/[id]?download=1` return 302 to a presigned GET carrying `response-content-disposition` (filename preserved) and `response-content-type`; `?stream=1` keeps proxying for same-origin canvas work; Range playback keeps the redirect. The streaming path remains as the fallback when presigning fails. This is what removes the fast-origin-transfer line.
5. **Immutability via conditional PUT.** `storeVideoBytes` and restore use `If-None-Match: *` on PutObject (R2 supports conditional writes); a precondition failure maps to the existing "verify existing hash" branch. Ambiguous writes stay `uncertainOnError`.
6. **Multipart.** Explicit S3 multipart for `streamAssembleUpload` and restore: 8 MiB parts assembled from the 3.5 MB chunks, abort-on-failure, ≤10,000 parts (the 2 GiB ceiling needs 256). `put` for everything else.
7. **Enumeration.** `ListObjectsV2` with continuation tokens for purge and backup. The backup manifest keeps sha256 and size as the invariant and records the ETag only as metadata (multipart ETags are not content hashes).
8. **Size lookup.** `HeadObject` per key, same 4-wide fan-out.
9. **Health.** Same deep-probe contract against an R2 presigned URL (R2 honours Range on presigned GETs); status strings become `storage: "r2-configured" | "r2-BROKEN"` alongside the Blob ones so monitors can tell them apart.
10. **No direct-to-R2 browser uploads in phase 1.** The chunk route and reservation machine stay; presigned PUTs would need a completion path the reservation state machine does not have.
11. **Cost model.** `lib/storageCost.ts` takes per-backend rates from env (`R2_USD_PER_GB_MONTH`, class A/B operation prices, zero egress) and the Usage page labels the backend.
12. **Third-party fetches.** Ark, fal, Higgsfield and the trainer receive R2 presigned URLs; each provider's URL-fetch is re-qualified with one read-only or already-approved paid call before cutover.
13. **Migration and cutover.** (a) first verified backup capture on Blob; (b) `scripts/ops/r2-migrate.mjs` streams every object listed on Blob to R2 and verifies sha256/size against the uploads/generations rows; (c) `STORAGE_BACKEND=r2` with dual-read (R2 first, Blob fallback for absolute Blob URLs and misses) for at least one backup cycle; (d) second migration pass for objects written during the window; (e) Blob token removed, staging rehearsal's token-format check replaced.

## Work packages

| # | Package | Touches | Estimate |
| --- | --- | --- | --- |
| 1 | Adapter: `lib/storage/backend.ts` (interface), `blob.ts`, `r2.ts` (AWS SigV4 presign + S3 REST via `fetch`, no SDK bundle), `local.ts`; `lib/storage.ts` delegates; `resolve()` replaces the substring checks | lib/storage*, lib/deploymentReadiness.ts | 2 days |
| 2 | Redirect downloads + presign options (`response-content-*`), keep proxy/stream fallbacks | app/api/uploads/[id], app/api/media/[id], tests/unit/privateUploadStream, mediaRange | 1 day |
| 3 | Conditional PUT immutability, explicit multipart, HeadObject, ListObjectsV2 for purge | lib/storage.ts, lib/purge.ts, lib/storageCost.ts | 1 day |
| 4 | Backup/restore/staging-rehearsal on the adapter; health deep probe; cost model; docs | scripts/ops/*, app/api/health, lib/storageCost.ts, docs | 1 day |
| 5 | Migration script, staging rehearsal against a real R2 bucket, provider URL re-qualification, cutover runbook | scripts/ops/r2-migrate.mjs, docs/r2-storage-plan.md | 2 days + owner credentials |

Unit tests reuse the existing seams (transpile-and-inject `require`, `vm` mocks, injected `blobSdk`); the R2 backend is tested against an in-memory S3 fake that enforces conditional writes, Range and multipart part rules.

## Owner actions

Create the Cloudflare account and two R2 buckets (production, preview), an API token scoped to those buckets (object read/write/list), and store `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in Vercel per environment. Confirm the first backup capture has run before cutover. Nothing in this plan requires a custom domain or public bucket.

## Backend selector

Package 1 landed the seam: `lib/storage/backend.ts` (interface, selector, `resolveStored`), `lib/storage/blob.ts` (Vercel Blob, unchanged semantics) and `lib/storage/r2.ts` (S3 REST over `fetch` with SigV4 from `node:crypto`, no SDK). `lib/storage.ts` no longer names `@vercel/blob`; local disk stays inline there because its layout is not key-shaped.

- `STORAGE_BACKEND=blob|r2|local`. Unset: `blob` when `BLOB_READ_WRITE_TOKEN` is set, otherwise `local`. Any other value throws at first use.
- R2 reads `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; the endpoint is `https://<account>.r2.cloudflarestorage.com` (override with `R2_ENDPOINT` for a rehearsal), region `auto`, path-style `/<bucket>/<key>`.
- `usingBlob()` keeps meaning "a cloud backend is active" for its existing callers (true under `blob` and `r2`); `usingCloud()` and `backendKind()` are the new names and `lib/storage.ts` uses them internally.
- An absolute `*.vercel-storage.com` URL in an old row always resolves to the Blob backend, whichever backend is selected, so those rows stay readable during the migration.
- Recovery activities: the Blob backend keeps `blob-put`/`blob-delete`; R2 records `r2-put`/`r2-delete`. A conditional-write precondition failure (the key already exists) is a certain outcome and is not marked uncertain.

**R2 is not yet used in production.** `lib/purge.ts`, `lib/storageCost.ts`, `app/api/health/route.ts`, `lib/deploymentReadiness.ts` and `scripts/ops/*` still call the Blob SDK directly (packages 3 and 4), downloads still stream through the routes (package 2), and no bucket, token or migration has run (package 5).
