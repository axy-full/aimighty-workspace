# Database startup

The production private-source rehearsal on 14 September observed initial requests taking roughly 5–21 seconds, followed by much faster warm requests. Inspection found repeated schema work at function startup: every CREATE statement was sent separately, followed by ALTER attempts for columns already present.

Tenant and platform initialization now submit their ordered CREATE statements in one write batch. One catalog query records existing columns for that bootstrap; only missing columns need an ALTER. Catalog state is scoped to that initialization and is discarded on a retry. Concurrent initializers accept a duplicate-column result only after verifying that the column exists. Other failures continue to propagate and clear the existing readiness memo.

The credit-grant kind column and its one-time classification now commit in one batch. A failed backfill rolls back the column too, allowing the next attempt to perform the full migration. Already classified databases avoid repeated grant scans.

The regression harness executes real SQLite migrations with instrumented client calls. For an already-current, non-legacy tenant schema, initialization falls from 184 client calls to 9; platform initialization falls from 52 to 3. Repeated ALTER attempts fall from 83/17 to zero. These are application client-call counts, excluding recovery-controller bookkeeping and protocol negotiation. They are not latency percentiles or a production capacity benchmark. Production timing must be measured on the released deployment.

The existing recovery-aware database clients still admit each write batch, and tenant selection, migration failure handling, legacy account repair and historical data corrections remain in force. No cached schema flag skips future migrations. New column migrations should use the bootstrap's installer, and dependent one-time backfills should be supplied in the same transaction.

References: [Turso batch transaction semantics](https://docs.turso.tech/sdk/ts/reference), [SQLite catalog PRAGMA functions](https://sqlite.org/pragma.html).
