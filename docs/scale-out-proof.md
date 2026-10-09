# Scale-out proof: 1 process vs 3, and memory per transfer

Measured 9 Oct 2026 on the droplet particl-app, which also serves production. These are local runs of the **production standalone build** of `release/1` + #606 (cluster) + #607 (streaming), merged locally at `68109beb` and not pushed. The harness is `scripts/ops/scale-proof.mjs`.

## How it was run

- **Build:** `NEXT_OUTPUT=standalone npm run build`, laid out the way `ops/selfhost/Dockerfile` does it.
  - **1 process:** `node server.js`, today's production.
  - **3 processes:** `node cluster.mjs` with `WEB_CONCURRENCY=3` (`WORKER_HEAP_MB` default 896).
- **Mocked dependencies:** `NODE_ENV=production`, `PARTICL_DEPLOYMENT=staging`, `ENGINE_MOCK=1`, and `STORAGE_BACKEND=r2` against `tests/helpers/fake-s3-server.mjs`. Inngest runs as a pinned dev server (`inngest-cli` 1.45.1, `DISPATCH_MODE=inngest`).
- **Databases:** local SQLite files on tmpfs (see the first caveat). A billed workspace is seeded with credits, and requests use a render-scoped API token.
- **Load:** autocannon 8.0.0 (pinned, installed outside the repo), 20 connections, 30 s per burst, after a 5 s warm-up that is not measured. Multi-step flows use 10 closed-loop users.
- **Limits on this box:** everything ran through `~/ops/heavy.sh`, at nice 19 with idle I/O, inside the agent user's 5-core / 20 GB cap. Each run checked the load average first (it was at most 3.4).
- **Production guard:** each burst polled `https://particl.si/api/health` every 2 s and would abort if the p95 passed 1 s. **No burst aborted.** Production's p95 during the bursts was 150–340 ms.

## Results

| Scenario | 1 process: req/s · p95 | 3 processes: req/s · p95 | Change |
|---|---|---|---|
| Page render (`/review/<token>`, about 11 KB server render) | 224 · 105 ms | **591 · 48 ms** | **2.6× throughput** |
| `/api/health` (database check) | 564 · 51 ms | 709 · 62 ms | +26 % |
| Quote (`POST /api/generate/quote`) | 99.5 · 267 ms | 117 · 363 ms | +17 % |
| Quote → generate → settle (stills, 10 users), flows/s | 8.1 (settle p95 1.42 s) | 9.8 (settle p95 1.17 s) | +22 % |
| Upload 1 MiB (chunk + finish), flows/s | 14.9 (finish p95 628 ms) | **24.5 (finish p95 414 ms)** | +64 % |
| Inngest callbacks (`worker/probe`, batches of 10) | 18.9/s · p95 441 ms | 18.7/s · p95 422 ms | flat (limited by the dev server and the batch loop) |

- **CPU.** In the page burst, the single process used 34 CPU-seconds in 30 s, about one core and saturated. Each of the 3 workers used about 35 CPU-seconds, so all three were saturated.
- **Where the gain shows.** It is largest where the work is CPU in our process. The database-bound paths (health, quote) gain less here, because all processes share one local SQLite file, and SQLite takes a file lock per write. In production the databases are Turso, so that lock does not exist.
- **Memory.**

| | 1 process | 3 processes |
|---|---|---|
| Idle after boot (whole process tree) | 174 MiB | 491 MiB (primary 53 + workers 140–158) |
| Peak under the page burst | 609 MiB | 1,216 MiB (max 395 per process) |
| Peak across all scenarios | 944 MiB | 1,588 MiB (max 445 per process) |

  This sizing is what the #606 PR uses: at least 3 CPUs and 6 GB for 3 workers, or `WEB_CONCURRENCY=2`.

## Memory per 500 MiB provider transfer (`tests/unit/storage-stream-memory.spec.ts`)

The spec saves a generated 500 MiB render through `storeVideo` into the fake R2 and samples memory every 50 ms with a forced GC.

| | Peak RSS growth | Peak buffer (`arrayBuffers`) growth |
|---|---|---|
| Before: `release/1`, buffered (`res.arrayBuffer()`) | **1,486 MiB** | **997 MiB** |
| After: #607, streamed multipart | **44 MiB** | **32 MiB** |

Without the forced GC (`STREAM_MEMORY_NOGC`), the figures are before 1,056 / 1,531 MiB and after 95 / 92 MiB; the after figures are mostly HTTP-client chunks that are dead but not yet collected. Before #607, the cron sync could hold up to 30 of these at once. After it, at most 4 run per process (the transfer limiter), and each one is bounded.

## Tests across processes

- **500 MiB chunked upload across 3 processes** (`--big-upload-mib 500`, a fresh connection per chunk):
  - 150 chunks of 3.5 MB, uploaded in 9.3 s, finished (assembled into R2) in 9.9 s.
  - The SHA-256 is identical for the bytes sent, the stored record and a full read-back through the app (`f3ab9f76…`, 524,288,000 bytes).
  - All three workers did work (8.2 / 21.4 / 7.9 CPU-seconds).
  - Peak memory was 955 MiB for the whole tree and 343 MiB per process.
- **Inngest probe:** a `worker/probe` event round-trips through the dev server to `/api/inngest`, and the receipt says `succeeded`. `/api/admin/readiness`, served by whichever worker answers, reads the same receipt back. This works in both modes, because the receipt's deployment value is the same in every process.
- **Health shows the real commit:** anonymous `/api/health` answered `"commit":"68109be"`, which matches the build's commit (`GIT_COMMIT_SHA` from the Dockerfile's `SOURCE_COMMIT`). In Coolify this needs "Include Source Commit in Build" turned on.
- **Clean stop:** after each run, SIGTERM to the cluster primary exited 0 within 0.1 s, with no requests in flight. The single process exits 143, as Next does. SIGTERM with a request in flight is covered by `tests/ops/cluster-start.test.mjs`: the request finishes, then the workers exit.

## Caveats

- **Disk.** On disk-backed SQLite at idle I/O priority, the first try was I/O-bound. One process used 0.3 of a core, and 3 processes were *slower*: health 80 → 73 req/s, p95 0.3 → 1.0 s. The cause is that SQLite file locks across processes queue behind production's disk use. That is not production's setup (Turso), so the table uses tmpfs. **Do not run several processes against `file:` databases**; staging on `file:` should stay at `WEB_CONCURRENCY=1`.
- **Absolute numbers.** Every number was taken at nice 19 on a 5-core cap, with production running on the same box. Absolute figures will be higher on production's own CPUs. The 1 vs 3 ratio is the result that matters.
- **Mocked generation.** Generation settles through mocked engines, and the Inngest render concurrency (4, with 2 per workspace) limits settle throughput, not the app. Inngest callback throughput was limited by the local dev server.
- **Harness glitch.** One of about 55 Inngest batches per run failed in the harness's own read of the last batch (a race in the test script, not the app).
