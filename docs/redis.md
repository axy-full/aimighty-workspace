# Redis

`lib/redis` is a cache and counter store beside Turso (SOW v2 §6, §8, §12). Turso keeps the data. Anything in Redis can be lost and made again, and with `REDIS_URL` unset the app runs exactly as it does today.

## What the client needs from Coolify

| Setting | Value |
|---|---|
| Server | Redis 6.2 or later (sliding keys are renewed with `GETEX`; older servers answer such reads with null) |
| Durability | append-only file on |
| Auth | a password |
| `maxmemory-policy` | `volatile-lru` |
| `maxmemory` | well above the cached sets (see Eviction) |
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

## Eviction

The server runs `volatile-lru` (the owner's answer, 25 Oct 2026; SOW v2 §6, §8). Under that policy, memory pressure can evict only keys that carry an expiry:

- **Working sets, previews and hot reads** carry an expiry. If one is evicted, it is made again from Turso on the next read.
- **Locks** carry their lease, so they can be evicted too. Losing a lock means at most that two holders overlap. So a lock is never the only guard on a spend. The spend's own guard in Turso (the ledger's reserve and settle, behind a person's approval) must refuse a second charge whether or not a lock was held. Any PR that puts a lock near a spend names that guard and tests the case where the lock is lost. A caller that gets `"unavailable"` from `take` goes on under the same guard, or stops.
- **Counters** carry no expiry and are never evicted. If memory ever fills with counters alone, writes fail and the client answers null, exactly as when Redis is down.

`maxmemory` is sized well above the cached sets, so in normal running nothing is evicted and the policy only ever applies under pressure.
