# Redis

Fast shared state beside Turso, never a source of truth (SOW v2 §6, §8, §12). What is in Redis is rebuilt from the record, Atomik never reads from it, and the app runs exactly as before when `REDIS_URL` is unset.

## The owner's steps (Coolify)

1. Add a Redis resource on the production project.
2. Persistence on (AOF).
3. A password.
4. `maxmemory-policy allkeys-lru`.
5. Expose `REDIS_URL` to the app as a runtime variable (`redis://default:<password>@<host>:6379`; the value stays in Coolify).
6. Redeploy.

Nothing reads Redis until a later PR wires a caller; this PR only adds the client.

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

`allkeys-lru` may evict any key under memory pressure, counters and locks included; only keys with an expiry are spared under `volatile-lru`. SOW v2 §8 asks that counters, locks and limits are never evicted. Two ways to meet it:
- Keep `allkeys-lru`. An evicted counter would restart at zero on the next add, so whichever PR first wires a counter must seed it from the ledger when the key is missing.
- Use `volatile-lru`. Every cache key here already carries an expiry; counters carry none, so they are never evicted.
