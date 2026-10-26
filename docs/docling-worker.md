# The Docling worker: the contract the app's client speaks

The app reads briefs through `read_document` (`lib/reading/read.ts`). Under `ENGINE_MOCK=1` the reader is the mock. Elsewhere it is the Docling worker, when the two variables below are set (`lib/reading/doclingClient.ts`). Without them, the lane answers "Reading isn't available now. Nothing billed."

The worker runs on our own machine, so a reading costs compute, not a vendor's price. The worker itself (`ops/docling-worker/`) is its own PR. This page is what it must answer.

## Variables (names only; values in Coolify)

| Name | What |
|---|---|
| `DOCLING_WORKER_URL` | The worker's origin, `http(s)://host[:port]`. It must have no credentials, path, query or fragment. Anything else means no worker. |
| `DOCLING_WORKER_SECRET` | 32 to 512 printable characters. The worker checks it as a bearer on every call. |
| `DOCLING_ENABLED` | The lane's switch (`lib/engineGate.ts`). It is on only when exactly `1`, and only for the house or a listed workspace. |

## Calls

Both calls are `POST`, JSON both ways, with `Authorization: Bearer <secret>`. Redirects are refused.

### `POST /v1/open`

**Request:** `{ fileUrl, sha256, mime, bytes }`.

- `fileUrl` is a short-lived signed URL of the workspace's own object, under its storage prefix. The worker fetches it once, at open, and never keeps the URL.
- The app sends no file bytes, and the worker is given no path it could widen.

**Answer (200):** `{ session, pages, geometry, readerVersion }`.

- `session` matches `[A-Za-z0-9_-]{8,128}`. It names this file's reading on the worker.
- `pages` is at least 1. (The per-file page limit waits for the owner's word; until then a file is read to its last page.)
- `geometry` is `page`, or `none` for a file without pages, which is page 1 (decision 3 in `docs/reading-tables-schema.md`).
- `readerVersion` is at most 80 characters.

### `POST /v1/page`

**Request:** `{ session, page }`.

**Answer (200):** `{ page, blocks }`. `page` must be the page asked for. Each block is:

- `kind`: one of `lib/reading/shapes.ts` BLOCK_KINDS;
- `x0, y0, x1, y1`: fractions of the page, with the origin at the top left (decision 1);
- `text`;
- `confidence`: 0 to 1, or null.

The app splits long text itself (decision 2). Every answer is Zod-checked (`workerOpened`, `workerPage`): an open answer or a page that is not the shape fails the reading as `bad_block`. An answer over 16 MiB is not read.

## Failures

The app shows a code, never the worker's words.

| Worker answers | App's code | Shown |
|---|---|---|
| Unreachable; any 5xx; 401, 403, 404, 408 or 429; the app could not sign the file's URL | `worker_unavailable` | "Reading isn't available now. Nothing billed." |
| 422 `{ "error": "encrypted" }` | `encrypted` | "This file is locked." |
| 422 `{ "error": "unreadable" }`; any other 4xx; an open answer with no session; an answer over 16 MiB | `unreadable` | "This file couldn't be read." |
| An open answer or a page that is not the shape | `bad_block` | "This file couldn't be read." |
| No answer within the page's time (`PAGE_MS`) | `timeout` | "This file couldn't be read." |

No error, log line or answer carries the secret, the signed URL or the file's text.
