import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionReply } from "../../lib/admissionTypes";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/**
 * A multi-shot press is ONE job with one approval that shows the total (owner, 16 Oct 2026, A.2). The server prices every member itself (lib/batchPress.ts, POST
 * /api/generate/batch); a total from the client is never read. The 200 cr per-job line is not judged on the sum (owner, 19 Oct 2026: the guardrail-4 check is
 * dropped from #815): a person presses a total far above it with one approval. What the sum is judged against is the workspace's monthly spending cap (its own,
 * or the house cap in the house workspace): a press whose total would pass it is refused whole, at the quote and at the press, though each shot alone fits.
 * Each shot's own checks still run as before.
 *
 * Also: one press asked again starts nothing twice (the same key re-reads every member's claim: what started is that take, what was refused starts on the next ask, a
 * claim left by a press killed mid-way is settled once no request can still run it), and a cancelled press charges nothing for its shots that had not started (owner,
 * 16 Oct 2026 evening, 2e).
 *
 * The REAL price path: every shot is priced by lib/generationAdmission.ts's own prepareGeneration and started by its own admitGeneration and reservation, on real
 * temporary databases. Only the render's dispatch (lib/inngest.ts enqueueRender) and, in the cancel test, the engine's answer to a cancel are stand-ins: no engine is
 * called and no network is reached. No price is written in this file: each figure is read from the server's own quote of one shot (OLD_LINE below is a size for the test, not a price).
 * This file only adds to the guards: the single-job rules (no per-job line since 20 Oct 2026) are noPerJobLine.spec.ts's. A cap here is set from one shot's own engine dollars at its hold, as the server's own preparation reports them
 * (prepareGeneration's server-only `cost`), never a figure written here.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-batch-press-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
process.env.BLOB_READ_WRITE_TOKEN = "";
const originalFetch = globalThis.fetch;
test.beforeAll(async () => { await alignLedgerUnit(); });
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("External network forbidden in the batch guard"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

const SEEDANCE = "dreamina-seedance-2-5-260628";
/* The platform's per-job line (200 cr at US$0.10) is retired (owner, 20 Oct 2026; tests/unit/noPerJobLine.spec.ts). The figure only sizes this test's presses:
   a shot under it, and a press whose total passes it. Nothing in the product judges it. */
const OLD_LINE = 200;
const run = Math.random().toString(36).slice(2, 8);
const person = (id: string, role: "admin" | "member"): TenantUser => ({ id, email: `${id}@example.test`, name: id, role, owner: role === "admin", disabled: false, lastSeen: null, createdAt: 0 });
const MEMBER: AdmissionActor = { user: person("u_member", "member") };
const ADMIN: AdmissionActor = { user: person("u_admin", "admin") };
const TOKEN: AdmissionActor = { user: person("u_admin", "admin"), token: { id: "tok_batch", name: "agent", scope: "render" as const, capUsd: null } };
const AGENT: AdmissionActor = { user: person("agent:run_batch", "admin") };

/* ── The real admission, with only its dispatch replaced ── */
const nodeRequire = createRequire(path.resolve("package.json"));
function resolveSource(from: string, name: string): string {
  const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
  return base;
}
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => (name in overrides ? overrides[name] : name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolveSource(file, name)) : nodeRequire(name)),
    target, target.exports,
  );
  return target.exports as T;
}
const dispatched: string[] = [];
const admission = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
  "@/lib/inngest": { enqueueRender: async (id: string) => { dispatched.push(id); return true; } },
});
const batchPress = load<typeof import("../../lib/batchPress")>("lib/batchPress.ts", { "./generationAdmission": admission });
const noDefer = { defer: async () => { throw new Error("Nothing may run after the reply in this test"); } };

/* ── Workspaces on the platform's keys, each its own database ── */
type Limits = { concurrency?: number; rendersPerHour?: number };
async function workspace(name: string, credits: number, limits: Limits = {}): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  const id = `bt_${name}_${run}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'u_admin',0,0,?,?)",
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`, limits.concurrency ?? 1000, limits.rendersPerHour ?? 100_000],
  });
  for (const [who, role] of [["u_member", "member"], ["u_admin", "admin"]] as const)
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [id, who, role] });
  if (credits > 0) await grantCredits(id, credits, "Batch guard", "u_admin", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await as(ws, ADMIN, async () => {
    const { ready, db } = await import("../../lib/db");
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Film',0)");
    await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
  });
  return ws;
}
/** The same workspace, with limits the platform's desk changed since. */
async function withLimits(ws: TenantWorkspace, limits: Limits): Promise<TenantWorkspace> {
  const { platformDb, rowToWorkspace } = await import("../../lib/platform");
  await platformDb().execute({ sql: "UPDATE workspaces SET concurrency=COALESCE(?,concurrency), renders_per_hour=COALESCE(?,renders_per_hour) WHERE id=?", args: [limits.concurrency ?? null, limits.rendersPerHour ?? null, ws.id] });
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws.id] })).rows[0]);
}
async function as<T>(ws: TenantWorkspace, actor: AdmissionActor, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  let out!: T;
  await runInTenant(ws, async () => { out = await fn(); }, { user: actor.user, ...(actor.token ? { token: actor.token } : {}) } as never);
  return out;
}

const shot = (i: number, extra: Record<string, unknown> = {}) => ({ prompt: `raw: Shot ${i + 1}, a harbour at dawn`, model: SEEDANCE, ratio: "16:9", resolution: "1080p", duration: 5, projectId: "project", refine: false, ...extra });
const shots = (n: number) => Array.from({ length: n }, (_, i) => shot(i));
const quote = (ws: TenantWorkspace, actor: AdmissionActor, members: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  as(ws, actor, () => batchPress.admitBatch({ members, quoteOnly: true, ...extra }, actor, noDefer));
const press = (ws: TenantWorkspace, actor: AdmissionActor, members: Record<string, unknown>[], approval: { fingerprint?: unknown; maxCredits?: unknown }, key: string | undefined, execution: Record<string, unknown> = {}) =>
  as(ws, actor, () => batchPress.admitBatch({ members, ...approval }, actor, { ...noDefer, ...(key ? { pressKey: key } : {}), ...execution }));
/** A quote's own approval: its fingerprint, and its total as the most that may be charged. */
const approvalOf = (q: AdmissionReply) => ({ fingerprint: q.body.fingerprint, maxCredits: (q.body.ceilingCredits as number | undefined) ?? (q.body.estimatedCredits as number) });

/** One shot's price as the server quotes it, and how many such shots sit under the line and pass it. */
async function sizing(ws: TenantWorkspace) {
  const one = await quote(ws, ADMIN, [shot(0)]);
  expect(one.status, JSON.stringify(one.body)).toBe(200);
  const each = one.body.estimatedCredits as number;
  expect(each).toBeGreaterThan(0);
  expect(each).toBeLessThan(OLD_LINE);
  const under = Math.floor(OLD_LINE / each);
  const over = under + 1;
  expect(over).toBeLessThanOrEqual(batchPress.BATCH_MAX_MEMBERS);
  return { each, under, over };
}

/** What the press left in the ledger and the workspace: its takes, their meter rows and what they hold. */
async function ledger() {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  const takes = (await db().execute("SELECT id,status FROM generations ORDER BY created_at, id")).rows.map((r) => ({ id: String(r.id), status: String(r.status) }));
  const meters = (await platformDb().execute({ sql: "SELECT id,status,billed_credits FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows.map((r) => ({ id: String(r.id), status: String(r.status), credits: Number(r.billed_credits ?? 0) }));
  return { takes, meters, held: meters.filter((m) => m.status === "running").reduce((n, m) => n + m.credits, 0) };
}
const members = (reply: AdmissionReply) => reply.body.members as { index: number; id?: string; status?: string; error?: string; code?: number; charged?: number }[];

/** One shot's engine dollars at its hold, as the server's own preparation reports them (server-only; read here only to set a cap around it). */
async function holdUsdOf(ws: TenantWorkspace, actor: AdmissionActor, member = shot(0)): Promise<number> {
  return as(ws, actor, async () => {
    const cost: { holdUsd?: number } = {};
    const p = await admission.prepareGeneration(member, actor, cost);
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(cost.holdUsd).toBeGreaterThan(0);
    return cost.holdUsd!;
  });
}
/** The workspace with its monthly cap on the platform's engines set on the platform's desk (`allowance_usd`), as the next request reads it. */
async function withCap(ws: TenantWorkspace, usd: number | null): Promise<TenantWorkspace> {
  const { platformDb, rowToWorkspace } = await import("../../lib/platform");
  await platformDb().execute({ sql: "UPDATE workspaces SET allowance_usd=? WHERE id=?", args: [usd, ws.id] });
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws.id] })).rows[0]);
}
/** The press's own claims (its shots' claims and its record of them): none when it was refused before anything was written. */
async function pressClaimsOf(key: string): Promise<number> {
  const { db } = await import("../../lib/db");
  const { generationRequestsReady } = await import("../../lib/generationRequests");
  await generationRequestsReady();
  const prefix = batchPress.pressPrefix(key);
  return Number((await db().execute({ sql: "SELECT COUNT(*) AS n FROM generation_requests WHERE request_key>=? AND request_key<?", args: [prefix, `${prefix}~`] })).rows[0].n);
}

test("a batch far above the 200 cr line, with no cap, is quoted and pressed by a member with one approval: no admin rule fires for the sum, and every shot starts", async () => {
  const ws = await workspace("far", 100_000);
  const { each, over } = await sizing(ws);
  /* Twice as many shots as it takes to pass the line: the sum is at least twice the line. */
  const far = Math.min(2 * over, batchPress.BATCH_MAX_MEMBERS);
  const total = each * far;
  expect(total).toBeGreaterThan(OLD_LINE);
  const q = await quote(ws, MEMBER, shots(far));
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  expect(q.body).toMatchObject({ estimatedCredits: total, price: total, unit: "cr", members: far });
  expect(q.body).not.toHaveProperty("needsAdmin");
  const pressed = await press(ws, MEMBER, shots(far), approvalOf(q), `press-far-${run}`);
  expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
  expect(pressed.body).toMatchObject({ status: "started", estimatedCredits: total });
  const after = await as(ws, MEMBER, ledger);
  expect(after.takes).toHaveLength(far);
  expect(after.meters.map((m) => m.credits)).toEqual(Array(far).fill(each));
  expect(after.held).toBe(total);
});

test("one approval, once, for exactly the listed shots at their listed prices; the quote's total is the server's sum, and each shot starts at its own quote", async () => {
  const ws = await workspace("admin", 100_000);
  const { each, over } = await sizing(ws);
  const q = await quote(ws, ADMIN, shots(over));
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  expect(q.body).toMatchObject({ estimatedCredits: each * over, price: each * over, unit: "cr", members: over });
  const fingerprint = String(q.body.fingerprint);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  /* The same shots quote the same fingerprint: it is the approval of these shots at these prices. */
  expect((await quote(ws, ADMIN, shots(over))).body.fingerprint).toBe(fingerprint);
  const key = `press-admin-${run}`;
  /* No approval, one under the total, or one for other shots: nothing starts. */
  expect((await press(ws, ADMIN, shots(over), {}, key)).status).toBe(409);
  expect((await press(ws, ADMIN, shots(over), { fingerprint }, key)).status).toBe(409);
  expect((await press(ws, ADMIN, shots(over), { fingerprint, maxCredits: each * over - 1 }, key)).status).toBe(409);
  expect(await press(ws, ADMIN, [...shots(over - 1), shot(99)], { fingerprint, maxCredits: each * over }, key)).toMatchObject({ status: 409, body: { quoteChanged: true } });
  expect(await press(ws, ADMIN, shots(over - 1), { fingerprint, maxCredits: each * over }, key)).toMatchObject({ status: 409, body: { quoteChanged: true } });
  /* Without a key naming the press, nothing starts: it could not be asked again safely. */
  expect(await press(ws, ADMIN, shots(over), approvalOf(q), undefined)).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Idempotency-Key/) } });
  expect(await as(ws, ADMIN, ledger)).toEqual({ takes: [], meters: [], held: 0 });
  const pressed = await press(ws, ADMIN, shots(over), approvalOf(q), key);
  expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
  expect(pressed.body).toMatchObject({ status: "started", estimatedCredits: each * over });
  const after = await as(ws, ADMIN, ledger);
  expect(after.takes).toHaveLength(over);
  /* Each shot was reserved at its own quote, by the real reservation: the holds add up to the approved total. */
  expect(after.meters.map((m) => m.credits)).toEqual(Array(over).fill(each));
  expect(after.held).toBe(each * over);
  expect(new Set(members(pressed).map((m) => m.id)).size).toBe(over);
});

test("the total is the server's: a total, a size or a ceiling sent by the client is never read", async () => {
  const ws = await workspace("forged", 100_000);
  const { each, over } = await sizing(ws);
  const forged = shots(over).map((m) => ({ ...m, maxCredits: 1, quoteFingerprint: "a".repeat(64), batchId: "b_forged1", batchSize: 1 }));
  const out = await quote(ws, MEMBER, forged, { estimatedCredits: 1, total: 1, size: 1 });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  expect(out.body).toMatchObject({ estimatedCredits: each * over, members: over });
  /* With the claims stripped, the forged shots are the plain shots: the same price and the same approval. */
  expect((await quote(ws, ADMIN, forged)).body.fingerprint).toBe((await quote(ws, ADMIN, shots(over))).body.fingerprint);
  /* A forged total is never an approval: pressed with the quote's fingerprint and a ceiling of 1, nothing starts. */
  expect(await press(ws, MEMBER, forged, { fingerprint: out.body.fingerprint, maxCredits: 1 }, `press-forged-${run}`)).toMatchObject({ status: 409 });
  expect(await as(ws, MEMBER, ledger)).toEqual({ takes: [], meters: [], held: 0 });
});

test("a batch whose total would pass the workspace's monthly cap is refused whole, at the quote and at the press, though each shot alone fits: nothing is written, no take, no reservation, no claim", async () => {
  const { ALLOWANCE_REACHED } = await import("../../lib/allowance");
  let ws = await workspace("cap", 100_000);
  const usd = await holdUsdOf(ws, MEMBER);
  /* Approved with no cap, four shots. Then the platform's desk sets a cap with room for three and a half. */
  const q4 = await quote(ws, MEMBER, shots(4));
  expect(q4.status, JSON.stringify(q4.body)).toBe(200);
  const stale = ws;
  ws = await withCap(ws, usd * 3.5);
  /* Each shot alone fits. */
  for (const m of shots(4)) expect((await quote(ws, MEMBER, [m])).status).toBe(200);
  /* Together they would pass it: refused at the quote, in the cap's own words with no figure, and with nothing to approve. */
  expect(await quote(ws, MEMBER, shots(4))).toEqual({ status: 429, body: { error: ALLOWANCE_REACHED } });
  /* Pressed with the approval from before the cap: refused before any shot is admitted. The cap is read as the reservation reads it, afresh: a
     request that began before the cap was set (its workspace still says none) is refused the same. */
  const key = `press-cap-${run}`;
  for (const at of [ws, stale]) expect(await press(at, MEMBER, shots(4), approvalOf(q4), key)).toEqual({ status: 429, body: { error: ALLOWANCE_REACHED } });
  expect(await as(ws, MEMBER, ledger)).toEqual({ takes: [], meters: [], held: 0 });
  expect(await as(ws, MEMBER, () => pressClaimsOf(key))).toBe(0);
  /* Two fit: quoted and pressed, both start. */
  const q2 = await quote(ws, MEMBER, shots(2));
  expect(q2.status, JSON.stringify(q2.body)).toBe(200);
  expect(q2.body).not.toHaveProperty("notice");
  const pressed = await press(ws, MEMBER, shots(2), approvalOf(q2), `press-cap-fits-${run}`);
  expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
  expect(pressed.body).toMatchObject({ status: "started" });
  const two = await as(ws, MEMBER, ledger);
  expect(two.takes).toHaveLength(2);
  /* The two running at their hold count against the month: a press of one more fits, a press of two more would pass the cap. */
  expect((await quote(ws, MEMBER, [shot(5)])).status).toBe(200);
  expect(await quote(ws, MEMBER, [shot(5), shot(6)])).toEqual({ status: 429, body: { error: ALLOWANCE_REACHED } });
  /* With the cap lifted, nothing is judged on the sum. */
  ws = await withCap(ws, null);
  expect((await quote(ws, MEMBER, shots(12))).status).toBe(200);
  expect(await as(ws, MEMBER, ledger)).toEqual(two);
});

test("asked again, the cap is judged on what is still to start: shots that already started count once, in this month's spend", async () => {
  let ws = await workspace("cap_again", 100_000, { rendersPerHour: 2 });
  const usd = await holdUsdOf(ws, ADMIN);
  ws = await withCap(ws, usd * 3.5);
  const q = await quote(ws, ADMIN, shots(3));
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  const key = `press-cap-again-${run}`;
  const first = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(first.body).toMatchObject({ status: "partial" });
  expect(members(first)[2]).toMatchObject({ index: 2, code: 429, charged: 0 });
  /* Room in the hour again: the third shot starts. The two already running are not counted a second time. */
  ws = await withLimits(ws, { rendersPerHour: 100_000 });
  const again = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body).toMatchObject({ status: "started" });
  expect((await as(ws, ADMIN, ledger)).takes).toHaveLength(3);
});

test("each shot's own checks still run as before: a shot past the shot cap is refused, named beside the refusal, and nothing starts", async () => {
  const ws = await workspace("shot_cap", 100_000);
  await as(ws, ADMIN, async () => {
    const { db } = await import("../../lib/db");
    await db().execute({ sql: "INSERT INTO shots(id,project_id,code,title,created_at,updated_at) VALUES(?,?,?,?,0,0)", args: ["shot_capped", "project", "SH010", "Capped"] });
    for (const [key, value] of [["approvalRule", "cap"], ["shotCapCredits", "1"]])
      await db().execute({ sql: "INSERT INTO settings(key,value,updated_at) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [key, value] });
  });
  /* The shot on the capped shot is over its cap alone: the batch is refused at that shot, as the shot alone is. */
  const alone = await quote(ws, MEMBER, [shot(0, { shotId: "shot_capped" })]);
  expect(alone).toMatchObject({ status: 403, body: { needsAdmin: true } });
  for (const quoteOnly of [true, false]) {
    const out = await as(ws, MEMBER, () => batchPress.admitBatch({ members: [shot(1), shot(0, { shotId: "shot_capped" })], quoteOnly, maxCredits: 100_000, fingerprint: "0".repeat(64) }, MEMBER, { ...noDefer, pressKey: `press-shot-cap-${run}` }));
    expect(out, `quoteOnly ${quoteOnly}`).toMatchObject({ status: 403, body: { needsAdmin: true, shot: 2, error: alone.body.error } });
  }
  expect(await as(ws, MEMBER, ledger)).toEqual({ takes: [], meters: [], held: 0 });
  /* The shots that are not on it quote as before. */
  expect((await quote(ws, MEMBER, shots(2))).status).toBe(200);
});

test("a machine never presses it: a token (an admin's too), an agent identity and Atomik's Auto may ask the price, of any total, and never approve", async () => {
  const ws = await workspace("machine", 100_000);
  const { under, over } = await sizing(ws);
  for (const actor of [TOKEN, AGENT]) {
    for (const n of [under, over]) {
      const q = await quote(ws, actor, shots(n));
      expect(q.status, `${actor.user.id} ${JSON.stringify(q.body)}`).toBe(200);
      expect(await press(ws, actor, shots(n), approvalOf(q), `press-machine-${actor.user.id.replace(/[^a-z_]/g, "-")}-${n}-${run}`), actor.user.id).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
    }
  }
  const auto = { run: { auto: true } };
  for (const n of [under, over]) {
    const q = await quote(ws, ADMIN, shots(n));
    expect(await press(ws, ADMIN, shots(n), approvalOf(q), `press-auto-${n}-${run}`, auto)).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
  }
  expect(await as(ws, ADMIN, ledger)).toEqual({ takes: [], meters: [], held: 0 });
});

test("the balance is checked against the whole total before the first shot starts: short by N cr, top up, then approve", async () => {
  const sized = await workspace("short_size", 100_000);
  const { each, under } = await sizing(sized);
  expect(under).toBeGreaterThanOrEqual(2);
  /* Enough for every shot but the last. */
  const ws = await workspace("short", each * (under - 1));
  const q = await quote(ws, MEMBER, shots(under));
  const out = await press(ws, MEMBER, shots(under), approvalOf(q), `press-short-${run}`);
  expect(out.status, JSON.stringify(out.body)).toBe(402);
  expect(String(out.body.error)).toMatch(/^Short by \d+(\.\d)? cr\. Top up, then approve\. Nothing is spent until you do\.$/);
  expect(await as(ws, MEMBER, ledger)).toEqual({ takes: [], meters: [], held: 0 });
});

test("in the house workspace the sum is judged against the house cap: a batch that would pass it is refused whole at the quote and at the press, one that fits runs, and its quote carries the cap's own 80% notice", async () => {
  const { keepingHouseJobsClean } = await import("../helpers/houseJobs");
  const { HOUSE_CAP_REACHED, houseMonthStart, houseSpendSince } = await import("../../lib/houseCap");
  const { houseCapState, houseCapWarning } = await import("../../lib/houseCapText");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const house = (allowanceUsd: number | null): TenantWorkspace => ({ id: "ws_legacy", slug: "house", name: "House", legacy: true, dbUrl: `file:${path.join(dir, `house_${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd, gatewayKeyId: null, ownerId: "u_admin", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 1000, rendersPerHour: 100_000, storageQuotaBytes: null, deletedAt: null });
  /* The house's cap is the `allowance_usd` the platform owner sets on its row (lib/houseCap.ts), and the request's workspace carries the same. */
  await platformReady();
  /* Other specs in this worker share the platform database and insert the house themselves: the row is removed if this test made it, else its cap is put back. */
  const before = (await platformDb().execute({ sql: "SELECT allowance_usd FROM workspaces WHERE id='ws_legacy'", args: [] })).rows[0];
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES('ws_legacy','house-batch','House','(primary)',1,0,'u_admin',0,0)", args: [] });
  const setHouseCap = async (usd: number) => { await platformDb().execute({ sql: "UPDATE workspaces SET allowance_usd=? WHERE id='ws_legacy'", args: [usd] }); return house(usd); };
  try { await keepingHouseJobsClean(async () => {
    await as(house(null), MEMBER, async () => {
      const { ready, db } = await import("../../lib/db");
      await ready();
      await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Film',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
    });
    const usd = await holdUsdOf(house(null), MEMBER);
    const spent = await as(house(null), MEMBER, () => houseSpendSince(houseMonthStart()));
    /* Approved under a cap with room for ten shots; then the owner lowers it to room for two and a half. */
    let ws = await setHouseCap(spent + usd * 10);
    const q3 = await quote(ws, MEMBER, shots(3));
    expect(q3.status, JSON.stringify(q3.body)).toBe(200);
    expect(q3.body).toMatchObject({ unit: "usd", members: 3 });
    ws = await setHouseCap(spent + usd * 2.5);
    for (const m of shots(3)) expect((await quote(ws, MEMBER, [m])).status).toBe(200);
    expect(await quote(ws, MEMBER, shots(3))).toEqual({ status: 429, body: { error: HOUSE_CAP_REACHED } });
    const key = `press-house-cap-${run}`;
    expect(await press(ws, MEMBER, shots(3), approvalOf(q3), key)).toEqual({ status: 429, body: { error: HOUSE_CAP_REACHED } });
    expect(await as(ws, MEMBER, ledger)).toEqual({ takes: [], meters: [], held: 0 });
    expect(await as(ws, MEMBER, () => pressClaimsOf(key))).toBe(0);
    /* Two fit, at 80% of the cap: the quote carries the house cap's own warning, in its own words (a quote writes nothing). */
    const q2 = await quote(ws, MEMBER, shots(2));
    expect(q2.status, JSON.stringify(q2.body)).toBe(200);
    expect(q2.body.notice).toBe(houseCapWarning(houseCapState(spent + usd * 2.5, spent + usd * 2)));
    /* A batch that fits runs. It is pressed under room for ten, below 80%, so it writes no month's warning into the platform history this worker's other specs share
       (that history is append-only; the warning itself is houseCap.spec's). */
    ws = await setHouseCap(spent + usd * 10);
    const fits = await quote(ws, MEMBER, shots(2));
    expect(fits.status, JSON.stringify(fits.body)).toBe(200);
    expect(fits.body.notice).toBeUndefined();
    const pressed = await press(ws, MEMBER, shots(2), approvalOf(fits), `press-house-fits-${run}`);
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(pressed.body).toMatchObject({ status: "started" });
    expect((await as(ws, MEMBER, ledger)).takes).toHaveLength(2);
  }); } finally {
    if (before) await platformDb().execute({ sql: "UPDATE workspaces SET allowance_usd=? WHERE id='ws_legacy'", args: [before.allowance_usd ?? null] });
    else await platformDb().execute({ sql: "DELETE FROM workspaces WHERE id='ws_legacy'", args: [] });
  }
});

test("asked again under the same key, a press starts nothing twice: what started is that take, what was refused starts on the next ask, and other shots under the key are refused", async () => {
  /* Room for two renders this hour: the third shot is refused (nothing made, nothing charged). */
  let ws = await workspace("again", 100_000, { rendersPerHour: 2 });
  const q = await quote(ws, ADMIN, shots(3));
  const key = `press-again-${run}`;
  const first = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({ status: "partial" });
  expect(members(first)[2]).toMatchObject({ index: 2, code: 429, charged: 0 });
  expect(String(first.body.retry)).toContain("same Idempotency-Key");
  expect(String(first.body.retry)).toContain("Nothing billed for the shots that did not start.");
  const started = members(first).slice(0, 2).map((m) => m.id);
  expect(started.every(Boolean)).toBe(true);
  const once = await as(ws, ADMIN, ledger);
  expect(once.takes).toHaveLength(2);
  expect(once.meters).toHaveLength(2);
  /* Asked again before anything changed: the hour is full, so the shots cannot even be priced, and nothing is made. */
  const again = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(again.status, JSON.stringify(again.body)).toBe(429);
  expect(await as(ws, ADMIN, ledger)).toEqual(once);
  /* The limit is raised: asked again, only the third starts. Asked once more, nothing does. */
  ws = await withLimits(ws, { rendersPerHour: 100_000 });
  const third = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(third.body).toMatchObject({ status: "started" });
  expect(members(third).slice(0, 2).map((m) => m.id)).toEqual(started);
  expect(members(third)[2].id).toBeTruthy();
  for (let i = 0; i < 2; i++) {
    const replay = await press(ws, ADMIN, shots(3), approvalOf(q), key);
    expect(members(replay).map((m) => m.id)).toEqual(members(third).map((m) => m.id));
  }
  const done = await as(ws, ADMIN, ledger);
  expect(done.takes).toHaveLength(3);
  expect(done.meters).toHaveLength(3);
  /* The same key with other shots names another press: refused, nothing starts. */
  const other = [shot(0), shot(1), shot(7)];
  expect(await press(ws, ADMIN, other, approvalOf(await quote(ws, ADMIN, other)), key)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already names a press of other shots/) } });
  expect(await as(ws, ADMIN, ledger)).toEqual(done);
});

test("two presses under one key at once start each shot once", async () => {
  const ws = await workspace("race", 100_000);
  const q = await quote(ws, ADMIN, shots(3));
  const key = `press-race-${run}`;
  const both = await Promise.all([press(ws, ADMIN, shots(3), approvalOf(q), key), press(ws, ADMIN, shots(3), approvalOf(q), key)]);
  for (const out of both) expect(out.status, JSON.stringify(out.body)).toBe(200);
  expect((await as(ws, ADMIN, ledger)).takes).toHaveLength(3);
  const settled = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(members(settled).every((m) => m.id)).toBe(true);
  expect((await as(ws, ADMIN, ledger)).takes).toHaveLength(3);
});

test("a press killed mid-way: its shot still being accepted is reported as starting and never started twice; once no request can still run it, it is settled at no charge and the shot starts on the next ask", async () => {
  const ws = await workspace("killed", 100_000);
  const { STALE_CLAIM_MS } = await import("../../lib/generationRequests");
  const q = await quote(ws, ADMIN, shots(3));
  const key = `press-killed-${run}`;
  /* The press that died had claimed shot 2 (index 1) and was killed before its take was written: a claim naming no job. */
  const claim = batchPress.memberKey(key, batchPress.pressShots(shots(3)), 1, 0);
  await as(ws, ADMIN, async () => {
    const { db } = await import("../../lib/db");
    const { generationRequestsReady } = await import("../../lib/generationRequests");
    await generationRequestsReady();
    await db().execute({ sql: "INSERT INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?)", args: [ADMIN.user.id, claim, "f".repeat(64), Date.now(), Date.now()] });
  });
  const first = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(members(first).map((m) => m.status)).toEqual(["queued", "starting", "queued"]);
  expect((await as(ws, ADMIN, ledger)).takes).toHaveLength(2);
  /* Still inside the time a request may run: asking again starts nothing for it. */
  const again = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(members(again)[1]).toEqual({ index: 1, status: "starting" });
  expect((await as(ws, ADMIN, ledger)).takes).toHaveLength(2);
  /* Past it: the claim is completed as interrupted (nothing charged), and the shot starts under its next attempt. */
  await as(ws, ADMIN, async () => {
    const { db } = await import("../../lib/db");
    await db().execute({ sql: "UPDATE generation_requests SET created_at=? WHERE user_id=? AND request_key=?", args: [Date.now() - STALE_CLAIM_MS - 1, ADMIN.user.id, claim] });
  });
  const later = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(later.body).toMatchObject({ status: "started" });
  expect(members(later).slice(0, 1).concat(members(later).slice(2)).map((m) => m.id)).toEqual([members(first)[0].id, members(first)[2].id]);
  const done = await as(ws, ADMIN, ledger);
  expect(done.takes).toHaveLength(3);
  expect(done.meters).toHaveLength(3);
  const settled = await as(ws, ADMIN, async () => {
    const { db } = await import("../../lib/db");
    return (await db().execute({ sql: "SELECT response_json,response_status,generation_id FROM generation_requests WHERE user_id=? AND request_key=?", args: [ADMIN.user.id, claim] })).rows[0];
  });
  expect(settled.generation_id).toBeNull();
  expect(Number(settled.response_status)).toBe(409);
  expect(String(settled.response_json)).toContain("Nothing was charged");
});

test("a cancelled press charges nothing for its shots that had not started: held shots are discarded, a refused one never starts, queued ones are cancelled at their engine, and asking again starts nothing", async () => {
  /* The engine's answer to a cancel of a take in its queue (lib/queuedCancel.ts is the real path and has its own tests): cancelled while queued. */
  const asked: string[] = [];
  const engine = { cancelQueued: async (id: string) => { asked.push(id); return { status: "cancelled" as const }; } };

  /* One render at a time: shot 1 is queued, shots 2 and 3 wait held for a slot (never reserved). */
  let ws = await workspace("cancel_held", 100_000, { concurrency: 1 });
  const q = await quote(ws, ADMIN, shots(3));
  const key = `press-cancel-held-${run}`;
  const pressed = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(members(pressed).map((m) => m.status)).toEqual(["queued", "held", "held"]);
  expect((await as(ws, ADMIN, ledger)).meters).toHaveLength(1);
  const cancelled = await as(ws, ADMIN, () => batchPress.cancelBatch(key, ADMIN, engine));
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  expect(members(cancelled)).toEqual([0, 1, 2].map((index) => ({ index, id: members(pressed)[index].id, status: "cancelled", charged: 0 })));
  expect(asked).toEqual([members(pressed)[0].id]);
  const after = await as(ws, ADMIN, ledger);
  /* The held shots were never reserved: cancelled, no meter row, nothing held for them. */
  for (const index of [1, 2]) expect(after.takes.find((t) => t.id === members(pressed)[index].id)?.status).toBe("cancelled");
  expect(after.meters.map((m) => m.id)).toEqual([members(pressed)[0].id]);
  /* Asked again, even with room for everything: nothing more starts under a cancelled press. */
  ws = await withLimits(ws, { concurrency: 1000 });
  const again = await press(ws, ADMIN, shots(3), approvalOf(q), key);
  expect(again).toMatchObject({ status: 409, body: { cancelled: true, error: "This press was cancelled. Nothing more starts under it." } });
  expect((await as(ws, ADMIN, ledger)).takes).toEqual(after.takes);

  /* One render this hour: shot 1 is queued, shots 2 and 3 are refused (nothing made). Cancelled, they never start, whatever the limit becomes. */
  ws = await workspace("cancel_refused", 100_000, { rendersPerHour: 1 });
  const q3 = await quote(ws, ADMIN, shots(3));
  const key3 = `press-cancel-refused-${run}`;
  const partly = await press(ws, ADMIN, shots(3), approvalOf(q3), key3);
  expect(members(partly).map((m) => m.status ?? m.code)).toEqual(["queued", 429, 429]);
  const stopped = await as(ws, ADMIN, () => batchPress.cancelBatch(key3, ADMIN, engine));
  expect(members(stopped)).toEqual([
    { index: 0, id: members(partly)[0].id, status: "cancelled", charged: 0 },
    { index: 1, status: "cancelled", charged: 0 },
    { index: 2, status: "cancelled", charged: 0 },
  ]);
  ws = await withLimits(ws, { rendersPerHour: 100_000 });
  const retried = await press(ws, ADMIN, shots(3), approvalOf(q3), key3);
  expect(retried).toMatchObject({ status: 409, body: { cancelled: true } });
  expect(members(retried).slice(1)).toEqual([{ index: 1, status: "cancelled", charged: 0 }, { index: 2, status: "cancelled", charged: 0 }]);
  const kept = await as(ws, ADMIN, ledger);
  expect(kept.takes.map((t) => t.id)).toEqual([members(partly)[0].id]);
  expect(kept.meters).toHaveLength(1);
  /* A take the engine already started is not cancelled here: it is reported as it stands and billed as today. */
  const other = `press-cancel-running-${run}`;
  const q2 = await quote(ws, ADMIN, shots(1));
  const one = await press(ws, ADMIN, shots(1), approvalOf(q2), other);
  const running = await as(ws, ADMIN, () => batchPress.cancelBatch(other, ADMIN, { cancelQueued: async () => ({ status: "running" }) }));
  expect(members(running)).toEqual([{ index: 0, id: members(one)[0].id, status: "running" }]);
  /* A cancel names its press: without a key nothing is cancelled. */
  expect((await as(ws, ADMIN, () => batchPress.cancelBatch(undefined, ADMIN))).status).toBe(400);
});

test("a cancel that lands between a shot's cancelled check and its claim is still seen: that shot never starts, nothing is reserved, metered or billed for it, and the cancel lists it", async () => {
  /* The press's own admission, with the cancel made at the one moment the race needs: after the press checked for a cancel before shot 2 (index 1), and before
     shot 2's claim is written inside admitGeneration. Everything else is the real path. */
  const asked: string[] = [];
  const engine = { cancelQueued: async (id: string) => { asked.push(id); return { status: "cancelled" as const }; } };
  let cancelAt: number | null = null;
  let cancelReply: AdmissionReply | null = null;
  const entered: number[] = [];
  const raced = load<typeof import("../../lib/batchPress")>("lib/batchPress.ts", {
    "./generationAdmission": {
      ...admission,
      admitGeneration: async (...args: Parameters<typeof admission.admitGeneration>) => {
        const index = Number(args[2].requestKey.split(":")[3]);
        entered.push(index);
        if (index === cancelAt) { cancelAt = null; cancelReply = await raced.cancelBatch(key, ADMIN, engine); }
        return admission.admitGeneration(...args);
      },
    },
  });
  const ws = await workspace("cancel_race", 100_000);
  const q = await quote(ws, ADMIN, shots(3));
  const key = `press-cancel-race-${run}`;
  const before = dispatched.length;
  cancelAt = 1;
  const pressed = await as(ws, ADMIN, () => raced.admitBatch({ members: shots(3), ...approvalOf(q) }, ADMIN, { ...noDefer, pressKey: key }));
  expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
  expect(entered).toEqual([0, 1]);
  const first = members(pressed)[0].id!;
  expect(first).toBeTruthy();
  expect(pressed.body).toMatchObject({ status: "cancelled" });
  expect(members(pressed)).toEqual([
    { index: 0, id: first, status: "queued" },
    { index: 1, status: "cancelled", charged: 0 },
    { index: 2, status: "cancelled", charged: 0 },
  ]);
  /* The cancel was told about every shot of the press, the one in the race among them, before that shot's claim existed. */
  expect(cancelReply).not.toBeNull();
  expect(members(cancelReply!)).toEqual([
    { index: 0, id: first, status: "cancelled", charged: 0 },
    { index: 1, status: "cancelled", charged: 0 },
    { index: 2, status: "cancelled", charged: 0 },
  ]);
  expect(asked).toEqual([first]);
  /* Only the shot that started before the cancel has a take, a meter row or a dispatch: nothing was reserved, metered, sent or billed for the others. */
  const after = await as(ws, ADMIN, ledger);
  expect(after.takes.map((t) => t.id)).toEqual([first]);
  expect(after.meters.map((m) => m.id)).toEqual([first]);
  expect(dispatched.slice(before)).toEqual([first]);
  /* The racing shot's claim was written set aside, naming no take. */
  const claim = await as(ws, ADMIN, async () => {
    const { db } = await import("../../lib/db");
    return (await db().execute({ sql: "SELECT generation_id,response_json FROM generation_requests WHERE user_id=? AND request_key=?", args: [ADMIN.user.id, raced.memberKey(key, raced.pressShots(shots(3)), 1, 0)] })).rows[0];
  });
  expect(claim?.generation_id ?? null).toBeNull();
  expect(JSON.parse(String(claim?.response_json))).toMatchObject({ code: "set_aside" });
  /* Asked again: nothing more starts. */
  expect(await press(ws, ADMIN, shots(3), approvalOf(q), key)).toMatchObject({ status: 409, body: { cancelled: true } });
  expect(await as(ws, ADMIN, ledger)).toEqual(after);
});

test("a failed take is retried free only when it is known to have cost nothing: a vendor cost never reported (a workspace's own key) is not known to be free, and asks again", async () => {
  const ws = await workspace("failed_unknown", 100_000);
  const q = await quote(ws, ADMIN, shots(1));
  /* The take failed, billed no credits, and its vendor never reported what it cost: what a workspace's own key leaves when its vendor's answer is lost. */
  const fail = (id: string, engineCost: number | null) => as(ws, ADMIN, async () => {
    const { db } = await import("../../lib/db");
    const { platformDb } = await import("../../lib/platform");
    await db().execute({ sql: "UPDATE generations SET status='failed' WHERE id=?", args: [id] });
    await platformDb().execute({ sql: "UPDATE meter_events SET status='failed', billed_credits=0, engine_cost_usd=? WHERE id=?", args: [engineCost, id] });
  });
  const unknown = `press-failed-unknown-${run}`;
  const one = members(await press(ws, ADMIN, shots(1), approvalOf(q), unknown))[0].id!;
  await fail(one, null);
  const again = await press(ws, ADMIN, shots(1), approvalOf(q), unknown);
  expect(members(again)).toEqual([{ index: 0, id: one, status: "failed" }]);
  expect((await as(ws, ADMIN, ledger)).takes.map((t) => t.id)).toEqual([one]);
  /* Known to have cost nothing (its cost reported as zero): retried under the same approval, as a new take. */
  const known = `press-failed-free-${run}`;
  const two = members(await press(ws, ADMIN, shots(1), approvalOf(q), known))[0].id!;
  await fail(two, 0);
  const retried = await press(ws, ADMIN, shots(1), approvalOf(q), known);
  expect(members(retried)[0].id).toBeTruthy();
  expect(members(retried)[0].id).not.toBe(two);
  expect((await as(ws, ADMIN, ledger)).takes).toHaveLength(3);
});
