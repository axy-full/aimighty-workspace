import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, PreparedAdmission } from "../../lib/admissionTypes";
import type { PoolConfig, PoolState, PoolWaiter } from "../../lib/providerPool";

/**
 * The platform's shared provider key (lib/providerPool.ts): one pool of
 * requests in flight for every workspace on the platform's Higgsfield key, a
 * share of it per workspace, served fairly. A take past it is never refused:
 * it waits as Queued with nothing reserved or sent, starts once when a slot
 * frees, and pays exactly what it would have paid without the pool. Local
 * databases and the mock engine only; nothing is sent anywhere.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-shared-pool-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const MARKETING = "higgsfield/marketing-studio-image";
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const pool = (size: string | null, share: string | null = null) => {
  if (size == null) delete process.env.HF_POOL_SIZE; else process.env.HF_POOL_SIZE = size;
  if (share == null) delete process.env.HF_POOL_WORKSPACE_SHARE; else process.env.HF_POOL_WORKSPACE_SHARE = share;
};

test.beforeEach(async () => {
  pool(null);
  process.env.ENGINE_MOCK = "1";
  const { providerPoolReady } = await import("../../lib/providerPool");
  const { platformDb } = await import("../../lib/platform");
  await providerPoolReady();
  // Each test starts with an empty line and no slot taken (a fixture database, not anyone's data).
  await platformDb().execute("DELETE FROM provider_pool");
});
test.afterAll(() => pool(null));

async function register(name: string, options: { concurrency?: number; credits?: number } = {}): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  const id = `ws_${name}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,?,500)",
    args: [id, name, `Studio ${name}`, `file:${path.join(dir, `${name}.db`)}`, options.concurrency ?? 8],
  });
  await grantCredits(id, options.credits ?? 10_000, "Test", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}
const inside = async <T>(ws: TenantWorkspace, fn: () => Promise<T>) => (await import("../../lib/tenant")).runInTenant(ws, fn);
const still = (id: string, cost = 0.31) =>
  ({ id, kind: "image" as const, engine: "higgsfield", model: MARKETING, status: "running" as const, engineCostUsd: cost });
async function reserve(ws: TenantWorkspace, id: string, cost = 0.31) {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  return inside(ws, () => reserveGenerationSpend(still(id, cost)));
}
async function settle(ws: TenantWorkspace, id: string, status: "succeeded" | "failed", cost: number | null = 0.31) {
  const { meter } = await import("../../lib/meter");
  await inside(ws, () => meter({ ...still(id), status, engineCostUsd: cost }));
}
async function metered(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
}
async function line(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT workspace_id,queued_at,admitted_at,left_at FROM provider_pool WHERE id=?", args: [id] })).rows[0];
}
/** A take Generate parked behind the pool: held for a slot, marked as the pool's, standing in its line from `at`. */
async function heldInLine(ws: TenantWorkspace, id: string, at: number) {
  const { db, ready } = await import("../../lib/db");
  const { heldInfo, poolHold } = await import("../../lib/held");
  const { queueForPool, SHARED_POOL } = await import("../../lib/providerPool");
  await inside(ws, async () => {
    await ready();
    const held = { ...poolHold(heldInfo(0.31, "image", MARKETING, "slots")), at };
    await db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
            VALUES(?,'image','higgsfield',?,'A bottle on a plinth',?,'held','owner',?,?,'higgsfield','generate')`,
      args: [id, MARKETING, JSON.stringify({ ratio: "3:4", resolution: "2k", held }), at, at],
    });
    await queueForPool(SHARED_POOL, { id, workspaceId: ws.id, queuedAt: at });
  });
}
async function status(ws: TenantWorkspace, id: string) {
  const { db } = await import("../../lib/db");
  return inside(ws, async () => (await db().execute({ sql: "SELECT status,error,params FROM generations WHERE id=?", args: [id] })).rows[0]);
}

/* ── The arithmetic ─────────────────────────────────────────────────── */

test("config: conservative defaults on a real key, off under the mock engine unless set, and never unlimited", async () => {
  const { poolConfig, POOL_DEFAULTS } = await import("../../lib/providerPool");
  expect(POOL_DEFAULTS).toEqual({ size: 4, share: 2 });
  expect(poolConfig({})).toEqual({ size: 4, share: 2 });
  // Fixture takes left in flight by one test never queue another's: the mock engine has no account to protect.
  expect(poolConfig({ ENGINE_MOCK: "1" })).toBeNull();
  expect(poolConfig({ ENGINE_MOCK: "1", HF_POOL_SIZE: "6" })).toEqual({ size: 6, share: 2 });
  for (const off of ["off", "OFF", " off ", "0"]) expect(poolConfig({ HF_POOL_SIZE: off })).toBeNull();
  // A value that does not read is the default, never "no limit".
  for (const bad of ["abc", "-3", "2.5", "1001", "Infinity", "NaN"]) expect(poolConfig({ HF_POOL_SIZE: bad })).toEqual({ size: 4, share: 2 });
  expect(poolConfig({ HF_POOL_SIZE: "10", HF_POOL_WORKSPACE_SHARE: "3" })).toEqual({ size: 10, share: 3 });
  // A share is never bigger than the pool, and never zero.
  expect(poolConfig({ HF_POOL_SIZE: "3", HF_POOL_WORKSPACE_SHARE: "9" })).toEqual({ size: 3, share: 3 });
  for (const bad of ["0", "-1", "x", "1.5"]) expect(poolConfig({ HF_POOL_WORKSPACE_SHARE: bad })).toEqual({ size: 4, share: 2 });
  expect(poolConfig({ HF_POOL_SIZE: "1" })).toEqual({ size: 1, share: 1 });
});

test("pool and share arithmetic: free slots admit, a full pool or a full share waits, and a line ahead is served first", async () => {
  const { poolVerdict } = await import("../../lib/providerPool");
  const config: PoolConfig = { size: 4, share: 2 };
  const state = (running: Record<string, number>, waiters: PoolWaiter[] = []): PoolState => ({ running, waiters });
  const w = (id: string, workspaceId: string, queuedAt: number): PoolWaiter => ({ id, workspaceId, queuedAt });
  expect(poolVerdict(config, state({}), { workspaceId: "a", queuedAt: 1 })).toEqual({ admit: true, free: 4 });
  expect(poolVerdict(config, state({ a: 1, b: 1 }), { workspaceId: "c", queuedAt: 1 })).toEqual({ admit: true, free: 2 });
  // Four in flight is the whole pool, whoever holds them.
  expect(poolVerdict(config, state({ a: 2, b: 2 }), { workspaceId: "c", queuedAt: 1 })).toMatchObject({ admit: false, why: "pool", free: 0 });
  // Two in flight is a workspace's whole share, however free the pool is.
  expect(poolVerdict(config, state({ a: 2 }), { workspaceId: "a", queuedAt: 1 })).toMatchObject({ admit: false, why: "share", free: 2 });
  // Its own takes waiting ahead of it count toward its share too.
  expect(poolVerdict(config, state({ a: 1 }, [w("a1", "a", 1)]), { workspaceId: "a", queuedAt: 2 })).toMatchObject({ admit: false, why: "share" });
  // Slots free, but as many takes are ahead of it in the line: it waits its turn.
  expect(poolVerdict(config, state({ a: 2 }, [w("b1", "b", 1), w("c1", "c", 2)]), { workspaceId: "d", queuedAt: 3 })).toMatchObject({ admit: false, why: "line", free: 2, ahead: 2 });
  // With a slot more than the takes ahead, it goes too.
  expect(poolVerdict(config, state({ a: 1 }, [w("b1", "b", 1), w("c1", "c", 2)]), { workspaceId: "d", queuedAt: 3 })).toEqual({ admit: true, free: 3 });
  // A take that waits keeps its own place: asked again, it is not counted as ahead of itself.
  expect(poolVerdict(config, state({ a: 2 }, [w("b1", "b", 1), w("c1", "c", 2)]), { id: "b1", workspaceId: "b", queuedAt: 1 })).toEqual({ admit: true, free: 2 });
  // Takes that cannot be served yet (their workspace is at its share) are not ahead of anyone.
  expect(poolVerdict(config, state({ a: 2 }, [w("a3", "a", 1)]), { workspaceId: "b", queuedAt: 5 })).toEqual({ admit: true, free: 2 });
  // Unreadable counts are nothing in flight, never a negative that frees slots.
  expect(poolVerdict(config, state({ a: -3, b: Number.NaN }), { workspaceId: "c", queuedAt: 1 })).toEqual({ admit: true, free: 4 });
});

test("fairness: fewest in flight first, then the longest wait; nobody passes its share, the pool never overfills, and every take starts", async () => {
  const { poolVerdict, servingOrder, servingWorkspaces } = await import("../../lib/providerPool");
  const config: PoolConfig = { size: 2, share: 2 };
  // A busy studio queued six takes before two others queued one each: the others are not stuck behind all six.
  const waiters: PoolWaiter[] = [
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `busy${n}`, workspaceId: "busy", queuedAt: n })),
    { id: "small1", workspaceId: "small", queuedAt: 10 }, { id: "solo1", workspaceId: "solo", queuedAt: 11 },
  ];
  const order = servingOrder({ running: {}, waiters }).map((p) => p.id);
  expect(order.slice(0, 4)).toEqual(["busy1", "small1", "solo1", "busy2"]);
  expect(servingWorkspaces(config, { running: {}, waiters })).toEqual(["busy", "small", "solo"]);
  // At its share, a workspace's next take is not offered while it holds both slots.
  expect(servingWorkspaces(config, { running: { busy: 2 }, waiters })).toEqual(["small", "solo"]);

  /* A day of traffic, settled in any order: whatever happens, the pool holds at most its size, a workspace
     at most its share, the next slot goes to the take the line says, and every take is served once. */
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const big: PoolConfig = { size: 4, share: 2 };
  const names = ["a", "b", "c", "d", "e"];
  let line: PoolWaiter[] = [];
  const flight: { id: string; workspaceId: string }[] = [];
  const served: string[] = [];
  let clock = 0;
  for (let n = 0; n < 60; n++) line.push({ id: `t${n}`, workspaceId: names[Math.floor(random() * (n < 30 ? 2 : names.length))], queuedAt: ++clock });
  const running = () => Object.fromEntries(names.map((name) => [name, flight.filter((f) => f.workspaceId === name).length]));
  for (let step = 0; step < 1000 && (line.length || flight.length); step++) {
    // Offer the free slots the way a release pass does: to the line, in its serving order.
    for (const next of servingOrder({ running: running(), waiters: line })) {
      const verdict = poolVerdict(big, { running: running(), waiters: line }, { id: next.id, workspaceId: next.workspaceId, queuedAt: next.queuedAt });
      if (!verdict.admit) continue;
      // Only the first take the line serves is ever admitted ahead of the takes before it.
      const ahead = servingOrder({ running: running(), waiters: line }).filter((p) => p.place < big.share);
      expect(ahead[0]?.id).toBe(next.id);
      line = line.filter((w) => w.id !== next.id);
      flight.push({ id: next.id, workspaceId: next.workspaceId });
      served.push(next.id);
      expect(flight.length).toBeLessThanOrEqual(big.size);
      expect(Math.max(...Object.values(running()))).toBeLessThanOrEqual(big.share);
    }
    if (flight.length && random() < 0.6) flight.splice(Math.floor(random() * flight.length), 1);
  }
  expect(line).toEqual([]);
  expect(new Set(served).size).toBe(60);
});

test("what a person sees of a take waiting for the shared pool: Queued — starts when a slot frees, wherever the take is shown", async () => {
  const { POOL_LABEL, POOL_QUEUED, POOL_REASON, KEY_CHANGED_LINE } = await import("../../lib/sharedKeyTerms");
  const { engineTrayJob } = await import("../../lib/jobsTray");
  const { heldReason, takeStage } = await import("../../lib/workspace/takes");
  const { generationPhase } = await import("../../lib/workspace/rig");
  const { takeView } = await import("../../lib/workspace/take-batch");
  const pooled = { held: { why: "slots", pool: "shared", needs: 13 } };
  expect(POOL_QUEUED).toBe("Queued — starts when a slot frees.");
  expect(POOL_LABEL).toBe("Queued — starts when a slot frees");
  // The jobs tray: in the line (Queued), with nothing to press and its price.
  const row = { id: "q", status: "held", kind: "image" as const, model: MARKETING, prompt: "A bottle", title: null, params: pooled, storedUrl: null, error: null,
    createdAt: 1, settledAt: null, projectName: null };
  expect(engineTrayJob(row, { unit: "cr", reserved: null, charged: null, needs: 13 })).toMatchObject({ stage: "queued", label: "Queued", reason: POOL_REASON, action: null, price: { amount: 13, unit: "cr" } });
  // A workspace's own slots still say so.
  expect(engineTrayJob({ ...row, params: { held: { why: "slots" } } }, { unit: "cr", reserved: null, charged: null, needs: 13 }).reason).toBe("Waiting for a free slot");
  // Takes, the Rig's strip and a batch's take.
  expect(takeStage({ status: "held", params: pooled })).toBe("queued");
  expect(heldReason(pooled)).toEqual({ reason: POOL_REASON });
  expect(generationPhase({ status: "held", params: pooled as never })).toMatchObject({ label: POOL_LABEL, done: false });
  expect(takeView({ variation: 2, state: "held", jobId: "q", credits: 13 }, "workspace", { media: { id: "q", status: "held", kind: "image", prompt: "", model: MARKETING, params: pooled as never } }))
    .toMatchObject({ status: POOL_LABEL, tone: "amber", done: false });
  // A take waiting on a provider key that changed is checking, never failed.
  expect(generationPhase({ status: "running", params: { providerKeyChanged: 1 } })).toMatchObject({ label: KEY_CHANGED_LINE, done: false });
});

/* ── The durable pool: reservations ─────────────────────────────────── */

test("a reservation takes a slot in its own write: a full share or pool reserves nothing; settle and fail give it back; other engines never queue", async () => {
  pool("3", "2");
  const { ProviderPoolBusyError, reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { poolDesk } = await import("../../lib/providerPool");
  const { creditState } = await import("../../lib/credits");
  const a = await register("reserve_a"), b = await register("reserve_b");
  await reserve(a, "res_a1");
  await reserve(a, "res_a2");
  const before = await inside(a, async () => (await creditState())!.balance);
  // A's third take: the share is full. Nothing is reserved, metered or debited for it.
  const share = await reserve(a, "res_a3").catch((e) => e);
  expect(share).toBeInstanceOf(ProviderPoolBusyError);
  expect(share).toMatchObject({ why: "share", status: 409 });
  expect(await metered("res_a3")).toBeUndefined();
  expect(await inside(a, async () => (await creditState())!.balance)).toBe(before);
  await reserve(b, "res_b1");
  // Three in flight: the pool is full for everyone, including a workspace with no take running.
  const full = await reserve(b, "res_b2").catch((e) => e);
  expect(full).toMatchObject({ name: "ProviderPoolBusyError", why: "pool" });
  expect(await poolDesk()).toMatchObject({ config: { size: 3, share: 2 }, inFlight: 3, waiting: 0 });
  // Another engine is not on the shared key: it never waits for the pool.
  await inside(b, () => reserveGenerationSpend({ id: "res_b_google", kind: "image", engine: "google", model: "gemini-3-pro-image", status: "running", engineCostUsd: 0.2 }));
  // A repeated reservation of a take already in flight is the same slot, not a second one.
  await reserve(a, "res_a1");
  expect((await poolDesk()).inFlight).toBe(3);
  // Settled, or failed: the slot is free again the moment its reservation stops running.
  await settle(a, "res_a1", "succeeded");
  await reserve(b, "res_b2");
  await settle(b, "res_b1", "failed", 0);
  await reserve(a, "res_a3");
  expect(await metered("res_a3")).toMatchObject({ status: "running" });
  expect((await poolDesk()).workspaces.map((w) => [w.workspaceId, w.inFlight])).toEqual([["ws_reserve_a", 2], ["ws_reserve_b", 1]]);
  for (const id of ["res_a2", "res_a3"]) await settle(a, id, "succeeded");
  await settle(b, "res_b2", "succeeded");
  await inside(b, async () => (await import("../../lib/meter")).meter({ id: "res_b_google", kind: "image", engine: "google", model: "gemini-3-pro-image", status: "succeeded", engineCostUsd: 0.2 }));
});

test("a slot nobody closed stops counting after its time; the governor switched off admits everything; an own key never enters the pool", async () => {
  pool("1");
  const { platformDb } = await import("../../lib/platform");
  const { SLOT_STALE_MS, poolDesk, sharedPoolOf } = await import("../../lib/providerPool");
  const ws = await register("stale");
  await reserve(ws, "stale_1");
  await expect(reserve(ws, "stale_2")).rejects.toMatchObject({ name: "ProviderPoolBusyError", why: "share" });
  // The provider no longer runs a request that old, whatever became of it.
  await platformDb().execute({ sql: "UPDATE provider_pool SET admitted_at=? WHERE id='stale_1'", args: [Date.now() - SLOT_STALE_MS - 1000] });
  expect((await poolDesk()).inFlight).toBe(0);
  await reserve(ws, "stale_2");
  pool("off");
  expect(await inside(ws, async () => sharedPoolOf({ engine: "higgsfield", kind: "image" }))).toBeNull();
  await reserve(ws, "stale_3");
  for (const id of ["stale_1", "stale_2", "stale_3"]) await settle(ws, id, "succeeded");

  // A workspace on its own provider key runs on its own account: it never takes a platform slot.
  pool("1");
  process.env.ENGINE_MOCK = "0";
  const before = process.env.HF_CREDENTIALS;
  process.env.HF_CREDENTIALS = "platform-id:platform-secret";
  try {
    expect(await inside(ws, async () => sharedPoolOf({ engine: "higgsfield", kind: "video" }))).toBe("higgsfield");
    expect(await inside({ ...ws, keys: { higgsfield: "own-id:own-secret" } }, async () => sharedPoolOf({ engine: "higgsfield", kind: "image" }))).toBeNull();
    // Training and other kinds are not renders on the pool.
    expect(await inside(ws, async () => sharedPoolOf({ engine: "higgsfield", kind: "training" }))).toBeNull();
    expect(await inside(ws, async () => sharedPoolOf({ engine: "byteplus", kind: "video" }))).toBeNull();
  } finally {
    process.env.ENGINE_MOCK = "1";
    if (before == null) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = before;
  }
});

/* ── Queue → admit → release ─────────────────────────────────────────── */

test("queue → admit → release: a freed slot starts the waiting take the line names, in its own workspace, once", async () => {
  pool("1", "1");
  const { releasePoolWaiters } = await import("../../lib/providerPool");
  const { releaseHeldJobs } = await import("../../lib/held");
  const busy = await register("line_busy"), later = await register("line_later"), first = await register("line_first");
  await reserve(busy, "line_running");
  const t = Date.now() - 60_000;
  await heldInLine(first, "line_first_take", t);
  await heldInLine(later, "line_later_take", t + 1000);
  const sent: string[] = [];
  const release = (ws: TenantWorkspace) => async () => {
    const out = await releaseHeldJobs({ defer: async () => { sent.push(ws.id); } });
    return out;
  };
  const byId = new Map([busy, later, first].map((w) => [w.id, w]));
  const pass = () => releasePoolWaiters({ workspace: async (id) => byId.get(id) ?? null, release: async () => {
    const { requireTenant } = await import("../../lib/tenant");
    await release(requireTenant())();
  } });
  // Nothing is free: the pass starts nothing, and both still wait in line, unreserved.
  await pass();
  expect(sent).toEqual([]);
  expect(await metered("line_first_take")).toBeUndefined();
  expect(await line("line_first_take")).toMatchObject({ admitted_at: null, left_at: null });
  // The slot frees: the take that waited longest starts, in its own workspace, and only it.
  await settle(busy, "line_running", "succeeded");
  const visited = await pass();
  expect(sent).toEqual(["ws_line_first"]);
  expect(visited.visited[0]).toBe("ws_line_first");
  expect(await status(first, "line_first_take")).toMatchObject({ status: "running", error: null });
  expect(await metered("line_first_take")).toMatchObject({ status: "running" });
  expect(await line("line_first_take")).toMatchObject({ left_at: null, admitted_at: expect.any(Number) });
  // The other still waits for the next slot, its place kept; it starts when that one ends.
  expect(await status(later, "line_later_take")).toMatchObject({ status: "held" });
  await pass();
  expect(sent).toHaveLength(1);
  await settle(first, "line_first_take", "succeeded");
  await pass();
  expect(sent).toEqual(["ws_line_first", "ws_line_later"]);
  await settle(later, "line_later_take", "succeeded");
});

test("a settlement anywhere starts the next workspace's take through the ordinary release, not the next cron", async () => {
  pool("1", "1");
  const { releaseAfterSettlement } = await import("../../lib/held");
  const { engineFor } = await import("../../lib/engines");
  const a = await register("chain_a"), b = await register("chain_b");
  await reserve(a, "chain_running");
  await heldInLine(b, "chain_waiting", Date.now() - 1000);
  // The waiting take is dispatched by the release itself (runInline under the mock engine): count what reaches the engine.
  const engine = engineFor("higgsfield"), render = engine.render;
  let submits = 0;
  engine.render = async () => { submits++; throw new Error("stop after counting: nothing is sent in this test"); };
  try {
    await settle(a, "chain_running", "succeeded");
    await inside(a, () => releaseAfterSettlement());
    expect((await status(b, "chain_waiting"))?.status).not.toBe("held");
    expect(await line("chain_waiting")).toMatchObject({ admitted_at: expect.any(Number) });
    expect(submits).toBe(1);
  } finally { engine.render = render; }
});

test("no double send: two releases racing for one waiting take start it once and reserve it once", async () => {
  pool("2", "2");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { creditState } = await import("../../lib/credits");
  const ws = await register("race");
  await heldInLine(ws, "race_take", Date.now() - 5000);
  const before = await inside(ws, async () => (await creditState())!.balance);
  const sent: string[] = [];
  const results = await inside(ws, () => Promise.all([
    releaseHeldJobs({ defer: async () => { sent.push("first"); } }),
    releaseHeldJobs({ defer: async () => { sent.push("second"); } }),
  ]));
  expect(sent).toHaveLength(1);
  expect(results.flatMap((r) => r.released)).toEqual(["race_take"]);
  const row = await metered("race_take");
  expect(row).toMatchObject({ status: "running" });
  // One reservation: the balance moved by that take's credits, once.
  expect(before - (await inside(ws, async () => (await creditState())!.balance))).toBe(Number(row.billed_credits));
  // A take already sent is never parked again behind the pool.
  const { holdForPool, heldInfo } = await import("../../lib/held");
  const { db } = await import("../../lib/db");
  await inside(ws, () => db().execute("UPDATE generations SET params=json_set(params,'$.paidClaim',1) WHERE id='race_take'"));
  expect(await inside(ws, () => holdForPool("race_take", heldInfo(0.31, "image", MARKETING, "slots")))).toBe(false);
  await settle(ws, "race_take", "succeeded");
});

test("a workspace that cannot be reached steps out of the line; it keeps its place for when it can; a discarded take leaves it", async () => {
  pool("1", "1");
  const { releasePoolWaiters, poolPrecheck, SHARED_POOL } = await import("../../lib/providerPool");
  const { releaseHeldJobs, discardHeldJob } = await import("../../lib/held");
  const down = await register("down"), up = await register("up");
  const t = Date.now() - 10_000;
  await heldInLine(down, "down_take", t);
  // Its tenant database cannot be read: the pass goes on, and its take no longer holds the free slot from anyone.
  await releasePoolWaiters({ workspace: async (id) => (id === down.id ? down : up), release: async () => { throw new Error("tenant database unavailable"); } });
  expect(await line("down_take")).toMatchObject({ admitted_at: null, left_at: expect.any(Number) });
  expect(await inside(up, () => poolPrecheck(SHARED_POOL, { workspaceId: up.id, at: Date.now() }))).toEqual({ admit: true, free: 1 });
  // Reachable again, its own release finds it at the place it was first given.
  const sent: string[] = [];
  await inside(down, () => releaseHeldJobs({ defer: async () => { sent.push("down_take"); } }));
  expect(sent).toEqual(["down_take"]);
  expect(await line("down_take")).toMatchObject({ queued_at: t, admitted_at: expect.any(Number), left_at: null });
  await settle(down, "down_take", "succeeded");
  // Discarded while waiting: out of the line, nothing reserved, nothing charged.
  await heldInLine(up, "up_discard", Date.now() - 1000);
  expect(await inside(up, () => discardHeldJob("up_discard"))).toBe(true);
  expect(await line("up_discard")).toMatchObject({ admitted_at: null, left_at: expect.any(Number) });
  expect(await metered("up_discard")).toBeUndefined();
  expect(await status(up, "up_discard")).toMatchObject({ status: "cancelled" });
});

test("a take its own limits stop steps out of the shared line rather than hold a slot from the next workspace", async () => {
  pool("2", "2");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { poolPrecheck, SHARED_POOL } = await import("../../lib/providerPool");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { meter } = await import("../../lib/meter");
  const full = await register("own_limit", { concurrency: 1 }), other = await register("own_limit_other");
  // Its one workspace slot is busy with another engine's job.
  await inside(full, () => reserveGenerationSpend({ id: "own_byteplus", kind: "video", engine: "byteplus", model: "dreamina-seedance-2-0-260128", status: "running", engineCostUsd: 1 }));
  const { db } = await import("../../lib/db");
  await inside(full, () => db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES('own_byteplus','video','byteplus','dreamina-seedance-2-0-260128','x','{}','running',?,?)", args: [Date.now(), Date.now()] }));
  await heldInLine(full, "own_waiting", Date.now() - 20_000);
  await heldInLine(other, "other_waiting", Date.now() - 10_000);
  await inside(full, () => releaseHeldJobs({ defer: async () => {} }));
  expect(await line("own_waiting")).toMatchObject({ admitted_at: null, left_at: expect.any(Number) });
  expect(await inside(other, () => poolPrecheck(SHARED_POOL, { id: "other_waiting", workspaceId: other.id, at: Date.now() }))).toMatchObject({ admit: true });
  await inside(full, () => meter({ id: "own_byteplus", kind: "video", engine: "byteplus", model: "dreamina-seedance-2-0-260128", status: "succeeded", engineCostUsd: 1 }));
});

/* ── Generate ───────────────────────────────────────────────────────── */

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    return name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
      : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts")) : nodeRequire(name);
  }, target, target.exports);
  return target.exports as T;
}

test("Generate on a full pool: Queued — starts when a slot frees; never refused, nothing reserved or sent, and the same price once it starts", async () => {
  pool("1", "1");
  const dispatched: string[] = [];
  const realPool = await import("../../lib/providerPool");
  let staleRead = false;
  const gen = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (genId: string) => { dispatched.push(genId); return true; } },
    /* A read taken a moment before another Generate took the last slot: the reservation's own answer decides. */
    "@/lib/providerPool": { ...realPool, poolAdmission: async (...args: Parameters<typeof realPool.poolAdmission>) => (staleRead ? { admit: true, free: 1 } : realPool.poolAdmission(...args)) },
  });
  const { platformDb } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  const { POOL_QUEUED } = await import("../../lib/sharedKeyTerms");
  const other = await register("gen_other"), ws = await register("gen_queue");
  await reserve(other, "gen_other_running");
  const body = { model: MARKETING, prompt: "A bottle on a marble plinth", projectId: "project", ratio: "3:4", resolution: "2k" };
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden: nothing is sent"); };
  try {
    await inside(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
    });
    const admit = async (staleness: boolean) => (await import("../../lib/tenant")).runInTenant(ws, async () => {
      staleRead = staleness;
      const prepared = await gen.prepareGeneration(body, actor);
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      const quote = (prepared as { value: PreparedAdmission }).value.quote;
      return { quote, reply: await gen.executeGenerationAdmission({ ...body, maxCredits: quote.estimatedCredits }, actor, {
        checkpoint: (value) => (value.quote.fingerprint === quote.fingerprint ? undefined : { status: 409, body: { error: "changed" } }),
        defer: async () => {},
      }) };
    }, actor);
    for (const staleness of [false, true]) {
      const { reply } = await admit(staleness);
      // Accepted and parked: 202, held for a slot, with the words the person sees. Never a refusal.
      expect(reply.status).toBe(202);
      expect(reply.body).toMatchObject({ status: "held", held: true, why: "slots", notices: [POOL_QUEUED] });
      const id = String(reply.body.id);
      const row = await status(ws, id);
      expect(row?.status).toBe("held");
      expect(JSON.parse(String(row?.params)).held).toMatchObject({ why: "slots", pool: "shared" });
      expect(await metered(id)).toBeUndefined();
      expect(await line(id)).toMatchObject({ workspace_id: ws.id, admitted_at: null, left_at: null });
    }
    expect(dispatched).toEqual([]);
    expect(POOL_QUEUED).toBe("Queued — starts when a slot frees.");
    // Without the pool, the same take reserves this many credits: the queue never changes that.
    const waiting = (await platformDb().execute({ sql: "SELECT id FROM provider_pool WHERE workspace_id=? ORDER BY queued_at", args: [ws.id] })).rows.map((r) => String(r.id));
    expect(waiting).toHaveLength(2);
    await settle(other, "gen_other_running", "succeeded");
    const { releaseHeldJobs } = await import("../../lib/held");
    const sent: string[] = [];
    await inside(ws, () => releaseHeldJobs({ defer: async () => { sent.push("sent"); } }));
    expect(sent).toHaveLength(1);
    const started = await metered(waiting[0]);
    expect(started).toMatchObject({ status: "running" });
    pool("off");
    const { quote, reply } = await admit(false);
    expect(reply.status).toBe(200);
    expect(Number((await metered(String(reply.body.id)))?.billed_credits)).toBe(Number(started.billed_credits));
    expect(Number(started.billed_credits)).toBe(quote.estimatedCredits);
  } finally { globalThis.fetch = fetchBefore; staleRead = false; }
});
