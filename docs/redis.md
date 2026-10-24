# Redis

`lib/redis` is a cache and counter store beside Turso (SOW v2 §6, §8, §12). Turso keeps the data. Anything in Redis can be lost and made again, and with `REDIS_URL` unset the app runs exactly as it does today.

## What the client needs from Coolify

| Setting | Value |
|---|---|
| Server | Redis 6.2 or later (sliding keys are renewed with `GETEX`; older servers answer such reads with null) |
| Durability | append-only file on |
| Auth | a password |
| `maxmemory-policy` | see the question below |
| App variable | `REDIS_URL` at runtime (`redis://default:<password>@<host>:6379`; the value stays in Coolify), then a redeploy |

No code reads Redis yet; a later PR wires the first caller.

## The client (`lib/redis`)

- `lib/redis/client.ts`: `redis.read / write / add / take / release / forget`. With `REDIS_URL` unset the client module is never loaded, reads answer null and writes are skipped. With it set, a dropped connection answers null at once (no offline queue, one retry), and a value that fails its schema reads as null.
- `lib/redis/keys.ts`: every key, by kind, checked by Zod. A key starts with the request's own workspace (`requireTenant()`), never one passed in; every part is an id (letters, digits, `_`, `-`, at most 64), never a person's words.

| Kind | Key | Expiry |
|---|---|---|
| working-set | `ws:<workspace>:working-set:<production>:<step>:<branch>` | sliding: 30 days past the last read (GETEX renews it) |
| preview | `ws:<workspace>:preview:<item>` | sliding: 30 days |
| hot | `ws:<workspace>:hot:<board\|library\|activity>:<id>` | 60 s |
| lock | `ws:<workspace>:lock:<name>` | the caller's lease, at most 10 min; released only by its token |
| counter | `ws:<workspace>:counter:<name>` | none |

## One question for the owner

Your brief for this PR names `allkeys-lru`, and counters that are never evicted. A Redis server has one eviction policy for all its keys, so the two pull against each other:

- **`allkeys-lru`:** under memory pressure any key can be evicted.
  - A cached working set or preview is simply made again.
  - A counter would restart at zero on its next add, so the first PR that wires a counter must seed it from the ledger when the key is missing.
  - A lock could vanish while its holder works, so a lock may only guard work that is safe to repeat.
- **`volatile-lru`:** only keys with an expiry can be evicted.
  - That covers working sets, previews and hot reads, and also locks (they carry their lease).
  - Counters have no expiry, so they stay. If memory fills with counters alone, writes fail and the client answers null, as when Redis is down.

Neither policy protects a lock. I recommend `volatile-lru` with memory sized well above the cached sets. Which do you want?
