# R2 copy worker (design, not built)

Status: proposal, 9 October 2026. Nothing here is deployed; the app streams provider files through its own server today (`storeVideo` in `lib/storage.ts`). This is the next step: provider files go **straight from the provider into R2**, and never touch our server at all.

## Why

Since the streaming change, a 500 MiB save holds a live peak of about 45–55 MiB (measured: 32 MiB of buffers and 44 MiB RSS growth on the merged code, against about 1 GiB of buffers and 1.5 GiB RSS before), and the server allows 4 transfers at a time (`STORAGE_TRANSFER_CONCURRENCY`). Every byte still crosses our server twice, though (in from the provider, out to R2), and it uses the CPU and bandwidth that production shares. A Cloudflare Worker next to R2 can do the copy instead, and our server only records the result.

## Shape

```
app (storeVideo)                 Cloudflare                          provider
 ── POST /copy (HMAC) ─────────▶ Worker (producer) ─ enqueue ─▶ Queue
                                                     Queue consumer ─ GET sourceUrl ─▶ provider
                                                     │  multipart into R2 binding (≥5 MiB parts)
                                                     │  sha256 updated in the same loop
 ◀──── POST /api/storage/copied (HMAC) {bytes, sha256, etag} ─┘
```

1. **Request.** The app sends `{ sourceUrl, key, maxBytes, receiptId, contentType, overwrite }` to the Worker's `/copy` endpoint, signed with HMAC-SHA256 over the raw body plus a timestamp header (`X-Copy-Timestamp`, refused if more than 5 minutes off). The secret (`COPY_WORKER_SECRET`) is stored in both places and nowhere else. The Worker answers `202 {jobId}` once the message is queued.
2. **SSRF guard.** `sourceUrl` must be `https:` and its host must be on an allowlist kept as a Worker env var (the providers' CDN hosts, for example fal's media hosts, BytePlus/Ark's TOS hosts and xAI's). No IP literals, no redirects (`redirect: "manual"`, with a redirect treated as failure), and no credentials in the URL. The `key` must match `^(ws/[A-Za-z0-9_-]+/)?generations/[A-Za-z0-9_-]+\.mp4$`, so the Worker can only write render masters.
3. **Queue consumer.** The copy runs in a Cloudflare Queues consumer, not in the request's `waitUntil`, so it is not cut off at 30 s. Each message is one copy, with `max_batch_size = 1` and `max_retries = 3`, and failures go to a dead-letter queue.
4. **Streaming multipart.** `fetch(sourceUrl)` → `body.pipeThrough(counter)` → a part assembler that fills a fixed 8 MiB buffer (R2 requires every part except the last to be at least 5 MiB and all non-final parts to be equal) → `env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } })` / `upload.uploadPart(n, buffer)` / `upload.complete(parts)`. The hash is updated in the same loop that copies each chunk into the part buffer: that loop also writes the chunk to a `new crypto.DigestStream("SHA-256")` writer and awaits the write. Do not `tee()` the body into it, because a tee buffers whatever the slower branch has not read and that breaks the memory bound. Once the count passes `maxBytes`, or the body ends short of its declared `Content-Length`, the consumer calls `upload.abort()` and the copy fails. Nothing is left behind.
5. **Result callback.** On success the Worker POSTs `{ receiptId, key, bytes, sha256, etag }` (HMAC-signed the same way) to the app's `/api/storage/copied`. The app records it as the save's receipt: `stored_url`, `bytes` and the hash go in the same write `syncGeneration` does today. The app also checks with `head(key)` that the size matches before it believes the callback.
6. **Idempotency.** `receiptId` is the generation id, and the key is deterministic. If a copy finds the key already present (`env.BUCKET.head(key)`), it does not copy again. Instead it re-hashes the stored object with a streamed read (`env.BUCKET.get(key)` → the same counting, hashing loop, bounded by `maxBytes`), answers the callback with that `{bytes, sha256}`, and finishes. The hash cannot come from custom metadata: R2 takes `customMetadata` when the upload is created, before the hash is known, and the in-server path (`storeVideo`) does not write one either. The re-hash costs one Class B read. A repeated callback for an already-recorded receipt with the same `{bytes, sha256}` is a no-op. A different hash is logged as a conflict and is never overwritten silently.
7. **Failure, retry, abort.** A provider 4xx, an over-cap file or a host that is not allowed fails without retry, and the callback carries `{ receiptId, error }` so the app records the failure and its next poll uses the fallback below. A 5xx, timeout or R2 error retries through the queue with backoff, and after `max_retries` the message lands in the DLQ with a failure callback. Every failure path calls `upload.abort()` in `finally`. R2's own lifecycle rule ("abort incomplete multipart uploads after 1 day") is the backstop.

## Fallback in the app

`storeVideo` keeps its in-server stream. When `R2_COPY_WORKER_URL` is set and the backend is `r2`, `syncGeneration` sends a copy request and records `params.copyRequestedAt`, and the store lease stays held. If no callback has arrived by the time the lease runs out (180 s), or the Worker refuses or errors, the next poll does the in-server `storeVideo` as today. With the deterministic key and `overwrite: true` on the in-server path, a late Worker copy and an in-server copy write the same bytes. The receipt is written once, by whichever records first, guarded by `stored_url IS NULL`.

## Limits

- Worker memory is 128 MB per isolate. One copy holds one 8 MiB part buffer plus stream buffers. `max_concurrency` is the number of consumer invocations Cloudflare runs at once, and concurrent invocations can share an isolate. So keep `max_concurrency` at about 4 with `max_batch_size = 1`, which keeps even four copies in one isolate inside 128 MB.
- R2 multipart allows up to 10,000 parts, parts of 5 MiB to 5 GiB, and equal-size non-final parts. 8 MiB parts give an object up to about 78 GiB, far above `maxBytes`.
- Worker CPU time: hashing 1 GiB with SHA-256 takes a few seconds of CPU. On Workers Paid, a Queue consumer's CPU limit is configurable (`limits.cpu_ms`, up to 5 min), so set it to cover the largest `maxBytes`.
- Wall time for a Queue consumer invocation is up to 15 minutes.
- Subrequests per invocation: a 1 GiB copy is about 130 part uploads, plus the provider fetch and the callback. **Verify:** whether R2 binding calls (`uploadPart`, `complete`) count against the per-invocation subrequest limit (1,000 by default on the paid plan). If they do, 130 is still inside it; check before raising `maxBytes` or lowering the part size.

## Cost (prices to verify at order time)

| Item | Unit price (verify at order time) | Per 500 MB video |
|---|---|---|
| Workers Paid base | about $5 / month, includes 10M requests and 30M CPU-ms | — |
| Queue operations | about $0.40 per million ops (write + read + delete ≈ 3 ops per message), first 1M/month included | 3 ops |
| R2 Class A (CreateMultipartUpload, UploadPart, Complete) | about $4.50 per million | ~65 ops at 8 MiB parts |
| R2 storage | about $0.015 / GB-month | unchanged from today |
| Egress from R2 | free | — |

At 1,000 videos a month the marginal cost is well under $1 beyond the base fee. Larger parts (for example 16 MiB) halve the Class A operations.

## Rollout

1. Build the Worker in its own repo folder (`workers/r2-copy/`) with tests against Miniflare (R2 and Queues bindings), and reuse `tests/helpers/fake-s3-server.mjs` for the app side.
2. Deploy it to a staging bucket. The owner sets `COPY_WORKER_SECRET`, the host allowlist and the bucket binding.
3. Ship the app half behind `R2_COPY_WORKER_URL` (unset means off, and today's in-server stream runs). Turn it on for the internal workspace first, through a per-workspace flag or an allowlist env var.
4. Watch for a week: copy latency, callback failures, fallbacks taken, and a sha256 mismatch count (it should be zero).
5. Turn it on for everyone. Keep the in-server path as the permanent fallback. Rollback is unsetting `R2_COPY_WORKER_URL`.

Open questions for the owner: the provider host allowlist (one list or one per provider), whether the callback should go through the same rate limits as other server routes, and whether to verify the provider's own checksum when one is published.
