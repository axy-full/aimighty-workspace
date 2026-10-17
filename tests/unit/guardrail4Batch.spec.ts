import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionReply } from "../../lib/admissionTypes";
import { jobApprovalLineCredits } from "../../lib/approvalRule";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/**
 * Pricing guardrail 4 for a multi-shot press (SOW §7A; owner, 16 Oct 2026, A.2): a press of several shots is ONE job, judged as one against the 200 cr line, with one
 * approval that shows the total, even when every shot in it is under the line. The server prices every member itself and judges the sum (lib/batchPress.ts, POST
 * /api/generate/batch); a total from the client is never read.
 *
 * Also: one press asked again starts nothing twice (the same key re-reads every member's claim: what started is that take, what was refused starts on the next ask, a
 * claim left by a press killed mid-way is settled once no request can still run it), and a cancelled press charges nothing for its shots that had not started (owner,
 * 16 Oct 2026 evening, 2e).
 *
 * The REAL price path: every shot is priced by lib/generationAdmission.ts's own prepareGeneration and started by its own admitGeneration and reservation, on real
 * temporary databases. Only the render's dispatch (lib/inngest.ts enqueueRender) and, in the cancel test, the engine's answer to a cancel are stand-ins: no engine is
 * called and no network is reached. No price is written in this file: each figure is read from the server's own quote of one shot. This file only adds to the guards:
 * the single-job rules are guardrail4.spec.ts's.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-guardrail-4-batch-"));
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
const LINE = jobApprovalLineCredits(0.1);
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
  expect(each).toBeLessThan(LINE);
  const under = Math.floor(LINE / each);
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

test("a batch over the line asks, though every shot in it is under the line: a member is told an admin has to start it, at the quote and at the press, and nothing starts", async () => {
  const ws = await workspace("over", 100_000);
  const { each, over } = await sizing(ws);
  /* Each shot alone is a job under the line: it quotes for a member. */
  for (const m of shots(over)) expect((await quote(ws, MEMBER, [m])).status).toBe(200);
  /* Together they are one job, over the line. */
  const total = each * over;
  expect(total).toBeGreaterThan(LINE);
  for (const quoteOnly of [true, false]) {
    const out = await as(ws, MEMBER, () => batchPress.admitBatch({ members: shots(over), quoteOnly, maxCredits: total, fingerprint: "0".repeat(64) }, MEMBER, { ...noDefer, pressKey: `press-over-${run}` }));
    expect(out.status, `quoteOnly ${quoteOnly}`).toBe(403);
    expect(out.body).toMatchObject({ needsAdmin: true });
    expect(String(out.body.error)).toContain(`This job is ${total} cr, over the ${LINE} cr that needs an admin. An admin has to start it.`);
  }
  expect(await as(ws, MEMBER, ledger)).toEqual({ takes: [], meters: [], held: 0 });
});

test("an admin's own tap clears it, once, for exactly the listed shots at their listed prices; the quote's total is the server's sum, and each shot starts at its own quote", async () => {
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
  expect(out.status).toBe(403);
  expect(String(out.body.error)).toContain(`This job is ${each * over} cr`);
  /* With the claims stripped, the forged shots are the plain shots: the same price and the same approval. */
  expect((await quote(ws, ADMIN, forged)).body.fingerprint).toBe((await quote(ws, ADMIN, shots(over))).body.fingerprint);
});

test("at the line: as many shots as fit under it start for a member; one more shot asks", async () => {
  const ws = await workspace("edge", 100_000);
  const { each, under } = await sizing(ws);
  expect(each * under).toBeLessThanOrEqual(LINE);
  const q = await quote(ws, MEMBER, shots(under));
  expect(q.status, JSON.stringify(q.body)).toBe(200);
  const pressed = await press(ws, MEMBER, shots(under), approvalOf(q), `press-edge-${run}`);
  expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
  expect((await as(ws, MEMBER, ledger)).takes).toHaveLength(under);
  expect((await quote(ws, MEMBER, shots(under + 1))).status).toBe(403);
});

test("a machine never presses it: a token (an admin's too), an agent identity and Atomik's Auto may ask the price under the line, are refused outright over it, and never approve", async () => {
  const ws = await workspace("machine", 100_000);
  const { under, over } = await sizing(ws);
  for (const actor of [TOKEN, AGENT]) {
    const q = await quote(ws, actor, shots(under));
    expect(q.status, `${actor.user.id} ${JSON.stringify(q.body)}`).toBe(200);
    expect(await press(ws, actor, shots(under), approvalOf(q), `press-machine-${run}`), actor.user.id).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
    for (const quoteOnly of [true, false]) {
      const out = await as(ws, actor, () => batchPress.admitBatch({ members: shots(over), quoteOnly, maxCredits: 100_000, fingerprint: "0".repeat(64) }, actor, { ...noDefer, pressKey: `press-machine-${run}` }));
      expect(out.status, `${actor.user.id} ${quoteOnly}`).toBe(403);
      expect(String(out.body.error)).toMatch(/needs an admin's own tap\. Atomik, an MCP client and API tokens can prepare it, never start it\./);
    }
  }
  const auto = { run: { auto: true } };
  const q = await quote(ws, ADMIN, shots(under));
  expect(await press(ws, ADMIN, shots(under), approvalOf(q), `press-auto-${run}`, auto)).toMatchObject({ status: 403 });
  expect((await as(ws, ADMIN, () => batchPress.admitBatch({ members: shots(over), quoteOnly: true }, ADMIN, { ...noDefer, ...auto } as never))).status).toBe(403);
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

test("the house is judged at cost against the same line, in words with no figure", async () => {
  const { keepingHouseJobsClean } = await import("../helpers/houseJobs");
  const house: TenantWorkspace = { id: "ws_legacy", slug: "house", name: "House", legacy: true, dbUrl: `file:${path.join(dir, `house_${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "u_admin", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 1000, rendersPerHour: 100_000, storageQuotaBytes: null, deletedAt: null };
  await keepingHouseJobsClean(async () => {
    await as(house, MEMBER, async () => {
      const { ready, db } = await import("../../lib/db");
      await ready();
      await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Film',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
    });
    const one = await quote(house, MEMBER, [shot(0)]);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body).toMatchObject({ unit: "usd" });
    /* At cost, counted in credits at no margin: the same line, more shots to reach it. Two past it, so rounding cannot land on it. */
    const atCost = one.body.estimatedCredits as number;
    const over = Math.floor(LINE / atCost) + 2;
    expect(over).toBeLessThanOrEqual(batchPress.BATCH_MAX_MEMBERS);
    const out = await quote(house, MEMBER, shots(over));
    expect(out.status, JSON.stringify(out.body)).toBe(403);
    expect(String(out.body.error)).not.toMatch(/\bcr\b|\d/);
    expect((await quote(house, MEMBER, shots(Math.max(1, Math.floor(LINE / atCost) - 1)))).status).toBe(200);
  });
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
