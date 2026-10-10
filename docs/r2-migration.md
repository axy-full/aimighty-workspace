# Private media on R2

`STORAGE_BACKEND=r2` selects the AWS SDK adapter. Configure `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` on the server only.
Keep `BLOB_READ_WRITE_TOKEN` during migration. Leaving the selector unset retains
the existing Blob/local behavior; installing the adapter does not switch stores.

New uploads and renders persist workspace-prefixed object keys in the existing
storage columns. API responses retain their authenticated media routes. Legacy
route values and Blob URLs remain readable, including random filename suffixes.
An R2 miss falls back to Blob; authorization and transport failures do not.
Writes and cleanup use the selected backend, never the read fallback.

R2 writes retain private immutable cache metadata. Authenticated read routes mint
signatures valid for at most 15 minutes with private, non-cacheable responses.
Uploads still on Blob stream through the authenticated route so their safe content
type and download filename are preserved. `?stream=1` keeps a same-origin stream
for canvas consumers. Files larger than 100 MiB and streamed bodies use bounded
multipart uploads; failed multipart uploads are aborted.

## Copy and verify

Keep the environment file and reports outside this public checkout. The operator
requires Node 24 and installed development dependencies. It defaults to an inventory:

```sh
node --env-file=/private/path/migration.env scripts/ops/migrate-media-r2.mjs \
  --report /private/path/inventory.json
```

Use a new report path for each run. After inspecting the source and destination:

```sh
node --env-file=/private/path/migration.env scripts/ops/migrate-media-r2.mjs \
  --apply --transfers 4 --report /private/path/copy.json
```

The operator preserves exact keys, copies only absent objects with conditional
writes, and compares source/destination SHA-256 and size. It checks the source
version again after verification. Reruns verify existing files without overwriting
them. Conflicting or failed files produce a nonzero exit status. Reports contain
object identities and must remain private; console output contains aggregate counts.
Neither source objects nor destination-only objects are deleted.

## Cutover

1. Pass application checks and deploy the adapter while Blob remains selected.
2. Complete a verified copy, then repeat it to catch uploads written during copying.
3. Configure bucket CORS for the app's exact production/preview origins: GET and
   HEAD, request headers `Range` and `If-Range`, and exposed response headers
   `Content-Length`, `Content-Range`, `Accept-Ranges`, `Content-Type` and `ETag`.
   Do not make the bucket public. This is required for browser fetches following
   authenticated redirects; backend reads do not require CORS.
4. Set the production selector to `r2` and redeploy. Retain the Blob token and all
   Blob files. Check authenticated upload/download, video ranges, references and
   workspace isolation; use the platform-admin storage diagnostic for the selected
   backend's signed range probe.
5. Repeat copy verification after switching to collect the final Blob writes.

After R2 accepts new writes, switching back to Blob alone would hide those new
objects. Prefer fixing forward with the dual-read adapter; reverting the selector
requires verifying that all new R2 objects are available to the old deployment.

## Final copy before Vercel closes

`scripts/ops/blob-to-r2.mjs` is the tool for the last copy before the Vercel account (and its Blob store) closes. It adds what this operator lacks: it copies to the absolute-URL key as well when that differs from the pathname, resumes from a progress file, retries transient faults, gives a dry run with byte counts and a time estimate, and checks with `--verify` that every database media row resolves on R2 with no Blob fallback (`--verify --live` reads the database list from the platform database instead of a `--config` file). Run order, owner steps and the other Vercel services that stop: "Before Vercel is cancelled" in `docs/selfhost-test.md`. Tests: `node --test tests/ops/blob-to-r2.test.mjs`.
