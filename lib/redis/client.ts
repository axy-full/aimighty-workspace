import type { ZodType } from "zod";
import type { Redis } from "ioredis";
import { EXPIRY, MAX_LEASE_MS, SHORT_TTL_S, SLIDING_TTL_S, type RedisKey } from "./keys";

/**
 * The Redis client, behind `REDIS_URL`.
 *
 * With `REDIS_URL` unset nothing changes: the client is never imported, nothing connects, every read answers null, every write and counter
 * does nothing, and callers fall back to Turso as they do today. With it set, Redis is still never the truth (SOW v2 §6, §8): a value that
 * fails its schema reads as null, a connection that drops answers null rather than waiting, and whatever is lost is rebuilt from the record.
 *
 * Every key is built by lib/redis/keys.ts (workspace first, ids only, Zod-checked) and carries its kind, so its expiry is applied here and
 * nowhere else: a sliding key is renewed on every read (GETEX) and set for 30 days on every write, a hot read lives a minute, a lock lives
 * what the caller asks up to ten minutes, and a counter has no expiry. Redis itself runs with persistence on and the eviction policy the owner
 * chooses (docs/redis.md).
 */

/** The commands Particl uses, so a test can stand in for the server. */
export type RedisCommands = Pick<Redis, "get" | "getex" | "set" | "incrby" | "del" | "eval">;

/** True when this process has a Redis to use. */
export const redisConfigured = (): boolean => Boolean(process.env.REDIS_URL?.trim());

const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 1_000;

let shared: Promise<RedisCommands | null> | null = null;
let warned = false;

/** Says once, with no key or value, that Redis is unreachable; reads answer null meanwhile. */
function warnOnce(what: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[redis] ${what}; reads answer null and writes are skipped until it is back`);
}

/** This process's client, or null when `REDIS_URL` is unset (the module is not even loaded then). */
export function getRedis(): Promise<RedisCommands | null> {
  if (!redisConfigured()) return Promise.resolve(null);
  shared ??= import("ioredis").then(async ({ Redis: Client }) => {
    const client = new Client(process.env.REDIS_URL!.trim(), {
      lazyConnect: false,
      /* Fail fast: a read never waits on a reconnect or a stalled server, it answers null. */
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
    });
    client.on("error", () => warnOnce("unreachable"));
    client.on("ready", () => { warned = false; });
    /* With no offline queue a command sent before the first connect fails, so the client is handed out once it is ready (or its connect
       time is up: then commands answer null until it is, as when it drops later). */
    if (client.status !== "ready") {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, CONNECT_TIMEOUT_MS);
        client.once("ready", () => { clearTimeout(timer); done(); });
      });
    }
    return client as RedisCommands;
  }).catch(() => { warnOnce("client failed to load"); shared = null; return null; });
  return shared;
}

/** What taking a lock came to. */
export type Lease = { state: "taken"; token: string } | { state: "held" } | { state: "unavailable" };
const UNAVAILABLE: Lease = Object.freeze({ state: "unavailable" });

/** Compare-and-delete: a lock is released only by the holder of its token. */
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** The store's operations over one client (null: no Redis, every operation is a no-op). */
export function redisStore(client: () => Promise<RedisCommands | null> = getRedis) {
  async function run<T>(fn: (r: RedisCommands) => Promise<T>, none: T): Promise<T> {
    const r = await client();
    if (!r) return none;
    try { return await fn(r); } catch { warnOnce("a command failed"); return none; }
  }

  return {
    /** The value at `k` checked against `schema`, or null (missing, unreadable, wrong shape, or no Redis). A sliding key is renewed by the read. */
    async read<T>(k: RedisKey, schema: ZodType<T>): Promise<T | null> {
      const raw = await run((r) => (EXPIRY[k.kind] === "sliding" ? r.getex(k.key, "EX", SLIDING_TTL_S) : r.get(k.key)), null);
      if (raw == null) return null;
      try {
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch { return null; }
    },

    /** Writes `value` at `k` with its kind's expiry; the value must pass `schema` (a wrong shape throws: it is a bug, not a miss). */
    async write<T>(k: RedisKey, schema: ZodType<T>, value: T): Promise<boolean> {
      if (EXPIRY[k.kind] === "lease" || EXPIRY[k.kind] === "kept") throw new Error(`a ${k.kind} key is written through its own operation`);
      const body = JSON.stringify(schema.parse(value));
      const ttl = EXPIRY[k.kind] === "sliding" ? SLIDING_TTL_S : SHORT_TTL_S;
      return run(async (r) => (await r.set(k.key, body, "EX", ttl)) === "OK", false);
    },

    /** Adds `by` to a counter and returns the new figure, or null with no Redis (the caller counts from Turso then). */
    async add(k: RedisKey, by: number): Promise<number | null> {
      if (k.kind !== "counter") throw new Error("only a counter key is added to");
      if (!Number.isSafeInteger(by)) throw new Error("a counter moves by whole numbers");
      return run((r) => r.incrby(k.key, by), null);
    },

    /**
     * Takes the lock at `k` for `ms` (at most ten minutes): "taken" with its token, "held" when another has it, or "unavailable" when there
     * is no Redis or it did not answer (the caller decides whether to go on without a lock, never Redis).
     */
    async take(k: RedisKey, ms: number): Promise<Lease> {
      if (k.kind !== "lock") throw new Error("only a lock key is taken");
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("a lease is a positive number of milliseconds");
      const life = Math.max(1, Math.min(Math.floor(ms), MAX_LEASE_MS));
      const token = crypto.randomUUID();
      return run<Lease>(async (r) => ((await r.set(k.key, token, "PX", life, "NX")) === "OK" ? { state: "taken", token } : { state: "held" }), UNAVAILABLE);
    },

    /** Releases the lock at `k` if `token` still holds it. */
    async release(k: RedisKey, token: string): Promise<boolean> {
      if (k.kind !== "lock") throw new Error("only a lock key is released");
      return run(async (r) => Number(await r.eval(RELEASE, 1, k.key, token)) === 1, false);
    },

    /** Drops `k` (a cache entry the record has moved past). A lock is released by its token and a counter is never dropped here. */
    async forget(k: RedisKey): Promise<boolean> {
      if (k.kind === "lock" || k.kind === "counter") throw new Error(`a ${k.kind} key is not forgotten`);
      return run(async (r) => (await r.del(k.key)) > 0, false);
    },
  };
}

/** The store over this process's client. */
export const redis = redisStore();
