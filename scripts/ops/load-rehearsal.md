# Local database load rehearsal

Run from the repository root:

```sh
node scripts/ops/load-rehearsal.mjs --concurrency 8 --processes 2 --duration-ms 2000 --workspaces 2 --active-limit 2 --output /tmp/particl-load-report.json
node --test tests/ops/load-rehearsal.test.mjs
```

The output file must be new. `--keep-fixtures` retains the disposable fixture directory shown in the report for investigation. Otherwise the harness removes it. The harness rejects production/Vercel execution, inherited remote database URLs, remote targets and database paths outside its fresh fixture. It runs child processes with a credential-free environment, validates every app-created libSQL client, and blocks socket, HTTP and fetch connections.

This exercises current TypeScript application modules with real SQLite platform and tenant databases: request idempotency (including keys shared across processes), atomic credit admission, permanent paid claims, dispatch records, terminal settlement replay, optimistic draft revisions and globally leased reconciliation. An independent seven-credit contention phase proves credit backpressure. Fake event delivery and fixed provider outcomes replace the paid boundary; no model is called. Fixture SQL triggers observe active and billed high-water marks inside the actual write transactions.

The clients are closed-loop: each lane starts more work when its previous work finishes, yielding one event-loop turn between work items so synchronous local SQLite does not starve the simulated event transport timer. Schema and module warm-up happens before the measured window. Total concurrency is divided across independent processes sharing the same fixture files. Operation latency includes transaction instrumentation. Reports include operation counts, nearest-rank p50/p95/p99, expected refusal/conflict counts, unexpected error rate and final invariants. Draft acknowledgments are captured in client memory immediately after `saveDraft` returns, so later audit-write failures cannot masquerade as a lost acknowledged save. Pending reservations are reported separately from duplicate charges.

Exit status is nonzero for an unexpected error, failed invariant or a source change during the rehearsal. Do not change thresholds to make a stressed run pass: retain its evidence and investigate. A single-process run can pass while multiple local SQLite writers encounter `SQLITE_BUSY`; both results are useful and must remain distinguishable.

The local client defaults to a 2,000 ms native SQLite busy timeout, applied to replacement connections and reconnects. Callers can explicitly choose `timeout: 0`. Waiting in the synchronous native driver blocks that process’s JavaScript event loop, so this is bounded contention handling rather than unlimited capacity; persistent locks still fail without replaying SQL. Remote database client configuration is unchanged.

These numbers describe this local host and driver configuration. They do **not** establish Vercel, Turso, Inngest, provider, browser, HTTP, upload or movie-export capacity. The report records the Git revision, source digest and Node/platform identity to make those limits explicit. Stripe is excluded.
