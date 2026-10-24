import { test, expect } from "@playwright/test";
import { z } from "zod";
import { keyFor, redisKey, EXPIRY, MAX_LEASE_MS, SHORT_TTL_S, SLIDING_TTL_S } from "../../lib/redis/keys";
import { getRedis, redisConfigured, redisStore, type RedisCommands } from "../../lib/redis/client";

/**
 * The Redis client behind REDIS_URL (lib/redis). Unset, nothing changes: no module loads, reads answer null, writes are skipped. Set, every
 * key is the workspace's own and Zod-checked, and every kind carries its expiry: a working set and a preview slide for 30 days (renewed on
 * each read), a hot read lives a minute, a lock what the caller asks up to ten minutes, a counter none. A stand-in server records each command.
 */

type Call = { cmd: string; args: unknown[] };
function fakeServer(opts: { fail?: boolean } = {}) {
  const data = new Map<string, string>();
  const calls: Call[] = [];
  const log = (cmd: string, args: unknown[]) => { calls.push({ cmd, args }); if (opts.fail) throw new Error("down"); };
  const server = {
    get: async (k: string) => { log("get", [k]); return data.get(k) ?? null; },
    getex: async (k: string, ...rest: unknown[]) => { log("getex", [k, ...rest]); return data.get(k) ?? null; },
    set: async (k: string, v: string, ...rest: unknown[]) => {
      log("set", [k, v, ...rest]);
      if (rest.includes("NX") && data.has(k)) return null;
      data.set(k, v);
      return "OK";
    },
    incrby: async (k: string, by: number) => { log("incrby", [k, by]); const n = Number(data.get(k) ?? 0) + by; data.set(k, String(n)); return n; },
    del: async (k: string) => { log("del", [k]); return data.delete(k) ? 1 : 0; },
    eval: async (_script: string, _n: number, k: string, token: string) => {
      log("eval", [k, token]);
      if (data.get(k) === token) { data.delete(k); return 1; }
      return 0;
    },
  } as unknown as RedisCommands;
  return { server, data, calls };
}

const WS = "ws_test";
const Shape = z.object({ rows: z.array(z.string()), at: z.number() });

test("unset REDIS_URL: nothing loads, reads answer null, writes are skipped", async () => {
  const before = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    expect(redisConfigured()).toBe(false);
    expect(await getRedis()).toBeNull();
    const store = redisStore();
    const k = keyFor(WS, { kind: "working-set", productionId: "p1", step: "shots", branchId: "trunk" });
    expect(await store.read(k, Shape)).toBeNull();
    expect(await store.write(k, Shape, { rows: ["r1"], at: 1 })).toBe(false);
    expect(await store.add(keyFor(WS, { kind: "counter", name: "takes_in_flight" }), 1)).toBeNull();
    expect(await store.take(keyFor(WS, { kind: "lock", name: "shot_4" }), 1000)).toBeNull();
    process.env.REDIS_URL = "   ";
    expect(redisConfigured()).toBe(false);
  } finally {
    if (before === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = before;
  }
});

test("a key is the workspace's own, ids only, each part checked by Zod", () => {
  expect(keyFor(WS, { kind: "working-set", productionId: "p1", step: "shots", branchId: "trunk" }).key).toBe("ws:ws_test:working-set:p1:shots:trunk");
  expect(keyFor(WS, { kind: "preview", itemId: "it_9" }).key).toBe("ws:ws_test:preview:it_9");
  expect(keyFor(WS, { kind: "hot", surface: "library", id: "p1" }).key).toBe("ws:ws_test:hot:library:p1");
  expect(keyFor(WS, { kind: "counter", name: "house_spend_day" }).key).toBe("ws:ws_test:counter:house_spend_day");
  /* Words, separators, paths, an unknown step or surface, an extra field, another workspace's prefix smuggled in: all refused. */
  for (const bad of [
    () => keyFor(WS, { kind: "preview", itemId: "the bottle" }),
    () => keyFor(WS, { kind: "preview", itemId: "a:b" }),
    () => keyFor(WS, { kind: "preview", itemId: "../x" }),
    () => keyFor(WS, { kind: "preview", itemId: "" }),
    () => keyFor(WS, { kind: "preview", itemId: "x".repeat(65) }),
    () => keyFor(WS, { kind: "working-set", productionId: "p1", step: "rig" as "shots", branchId: "trunk" }),
    () => keyFor(WS, { kind: "hot", surface: "settings" as "board", id: "p1" }),
    () => keyFor(WS, { kind: "preview", itemId: "i1", workspaceId: "ws_other" } as never),
    () => keyFor("ws:other", { kind: "preview", itemId: "i1" }),
  ]) expect(bad).toThrow();
});

test("a key needs the request's own workspace: with no tenant there is no key", () => {
  expect(() => redisKey({ kind: "preview", itemId: "i1" })).toThrow();
});

test("every kind has its expiry class: working sets and previews slide, hot reads are short, locks lease, counters are kept", () => {
  expect(EXPIRY).toEqual({ "working-set": "sliding", preview: "sliding", hot: "short", lock: "lease", counter: "kept" });
  expect(SLIDING_TTL_S).toBe(30 * 24 * 60 * 60);
});

test("a sliding key is written for 30 days and renewed by every read", async () => {
  const { server, calls } = fakeServer();
  const store = redisStore(async () => server);
  const k = keyFor(WS, { kind: "working-set", productionId: "p1", step: "edit", branchId: "trunk" });
  expect(await store.write(k, Shape, { rows: ["r1", "r2"], at: 5 })).toBe(true);
  expect(calls.at(-1)).toEqual({ cmd: "set", args: [k.key, JSON.stringify({ rows: ["r1", "r2"], at: 5 }), "EX", SLIDING_TTL_S] });
  expect(await store.read(k, Shape)).toEqual({ rows: ["r1", "r2"], at: 5 });
  expect(calls.at(-1)).toEqual({ cmd: "getex", args: [k.key, "EX", SLIDING_TTL_S] });
});

test("a hot read lives a minute and is read without renewing", async () => {
  const { server, calls } = fakeServer();
  const store = redisStore(async () => server);
  const k = keyFor(WS, { kind: "hot", surface: "board", id: "p1" });
  await store.write(k, Shape, { rows: [], at: 1 });
  expect(calls.at(-1)?.args.slice(2)).toEqual(["EX", SHORT_TTL_S]);
  await store.read(k, Shape);
  expect(calls.at(-1)?.cmd).toBe("get");
});

test("Zod on the way in and out: a wrong shape is refused before it is sent, and a stored one that no longer fits reads as null", async () => {
  const { server, data, calls } = fakeServer();
  const store = redisStore(async () => server);
  const k = keyFor(WS, { kind: "preview", itemId: "i1" });
  await expect(store.write(k, Shape, { rows: "r1", at: 1 } as never)).rejects.toThrow();
  expect(calls).toHaveLength(0);
  data.set(k.key, JSON.stringify({ rows: [1], at: "x" }));
  expect(await store.read(k, Shape)).toBeNull();
  data.set(k.key, "not json");
  expect(await store.read(k, Shape)).toBeNull();
});

test("a counter has no expiry and moves by whole numbers; a lock leases at most ten minutes and is released only by its holder", async () => {
  const { server, calls } = fakeServer();
  const store = redisStore(async () => server);
  const c = keyFor(WS, { kind: "counter", name: "takes_in_flight" });
  expect(await store.add(c, 2)).toBe(2);
  expect(await store.add(c, -1)).toBe(1);
  await expect(store.add(c, 0.5)).rejects.toThrow();
  await expect(store.write(c, z.number(), 3)).rejects.toThrow();
  expect(calls.some((x) => x.cmd === "set" && x.args[0] === c.key)).toBe(false);

  const l = keyFor(WS, { kind: "lock", name: "shot_4" });
  const token = await store.take(l, 60 * 60 * 1000);
  expect(token).toBeTruthy();
  expect(calls.at(-1)?.args.slice(2)).toEqual(["PX", MAX_LEASE_MS, "NX"]);
  expect(await store.take(l, 1000)).toBeNull();
  expect(await store.release(l, "not-the-token")).toBe(false);
  expect(await store.release(l, token!)).toBe(true);
  await expect(store.add(l, 1)).rejects.toThrow();
  await expect(store.take(c, 1000)).rejects.toThrow();
});

test("Redis down: every operation answers as if it were absent, and nothing throws to the caller", async () => {
  const { server } = fakeServer({ fail: true });
  const store = redisStore(async () => server);
  const k = keyFor(WS, { kind: "working-set", productionId: "p1", step: "brief", branchId: "trunk" });
  expect(await store.read(k, Shape)).toBeNull();
  expect(await store.write(k, Shape, { rows: [], at: 1 })).toBe(false);
  expect(await store.add(keyFor(WS, { kind: "counter", name: "n" }), 1)).toBeNull();
  expect(await store.take(keyFor(WS, { kind: "lock", name: "n" }), 10)).toBeNull();
  expect(await store.forget(k)).toBe(false);
});
