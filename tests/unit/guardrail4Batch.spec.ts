import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import { jobApprovalLineCredits } from "../../lib/approvalRule";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/**
 * Pricing guardrail 4 for a multi-shot press (SOW §7A; owner, 16 Oct 2026, A.2): a press of several shots is ONE job, judged as one against the 200 cr line, with one approval that
 * shows the total, even when every shot in it is under the line. The server prices every member itself and judges the sum (lib/batchPress.ts, POST /api/generate/batch); a total
 * from the client is never read. This file only adds to the guards: the single-job rules are guardrail4.spec.ts's. Mocked: members are priced and admitted by stand-ins, so no
 * engine is called and no credit is spent; real temporary databases for the balance.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-guardrail-4-batch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });

const run = Math.random().toString(36).slice(2, 8);
const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null,
  flagNote: null, concurrency: 1000, rendersPerHour: 100_000, storageQuotaBytes: null, deletedAt: null });
const person = (id: string, role: "admin" | "member"): TenantUser => ({ id, email: `${id}@example.test`, name: id, role, owner: role === "admin", disabled: false, lastSeen: null, createdAt: 0 });
const LINE = jobApprovalLineCredits(0.1);
const noop: AdmissionExecution = { defer: async () => {} };

/** A stand-in for the generation admission's price and start: each member costs what its prompt says ("80 cr"), and every start is recorded with the credits it was asked at. */
function stand(unit: "cr" | "usd" = "cr") {
  const prepared: Record<string, unknown>[] = [];
  const admitted: { key: string; credits: number }[] = [];
  const price = (body: Record<string, unknown>) => Number(String(body.prompt).match(/(\d+(?:\.\d+)?) cr/)?.[1] ?? 0);
  return {
    prepared, admitted,
    seams: {
      prepare: async (body: Record<string, unknown>, actor: AdmissionActor) => {
        prepared.push(body);
        const credits = price(body);
        const quote = unit === "cr" ? { estimatedCredits: credits, price: credits, unit: "cr" as const } : { estimatedCredits: credits, price: credits * 0.1, unit: "usd" as const };
        return { ok: true as const, value: { version: 1 as const, kind: "video" as const, workspaceId: "w", actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled: { model: { provider: "byteplus" }, prompt: body.prompt }, quote: { ...quote, fingerprint: `fp:${String(body.prompt)}` } } satisfies PreparedAdmission };
      },
      admit: async (p: PreparedAdmission, _a: AdmissionActor, o: { requestKey: string; defer: AdmissionExecution["defer"] }): Promise<AdmissionReply> => {
        admitted.push({ key: o.requestKey, credits: p.quote.estimatedCredits });
        return { status: 202, body: { id: `gen_${admitted.length}`, status: "queued" } };
      },
    },
  };
}
const shots = (...credits: number[]) => credits.map((c, i) => ({ prompt: `Shot ${i + 1}, ${c} cr`, model: "dreamina-seedance-2-5-260628", ratio: "16:9", resolution: "1080p", duration: 5, projectId: "project", references: [] }));

async function inWorkspace(name: string, fn: (ws: TenantWorkspace) => Promise<void>, balance = 10_000) {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace(`${name}_${run}`);
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_${name}_${run}`, ws.id, balance, "Test", Date.now()] });
  for (const [who, role] of [["u_member", "member"], ["u_admin", "admin"], ["agent:run_batch", "admin"]] as const)
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, who, role] });
  await runInTenant(ws, async () => { await fn(ws); }, { user: person("u_member", "member") } as never);
}
async function as<T>(ws: TenantWorkspace, actor: AdmissionActor, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  let out!: T;
  await runInTenant(ws, async () => { out = await fn(); }, { user: actor.user, ...(actor.token ? { token: actor.token } : {}) } as never);
  return out;
}
const MEMBER: AdmissionActor = { user: person("u_member", "member") };
const ADMIN: AdmissionActor = { user: person("u_admin", "admin") };
const TOKEN: AdmissionActor = { user: person("u_admin", "admin"), token: { id: "tok_batch", name: "agent", scope: "render" as const, capUsd: null } };
const AGENT: AdmissionActor = { user: person("agent:run_batch", "admin") };
async function batch(actor: AdmissionActor, body: Record<string, unknown>, seams: ReturnType<typeof stand>["seams"], execution: AdmissionExecution = noop) {
  const { admitBatch } = await import("../../lib/batchPress");
  return admitBatch(body, actor, execution, seams);
}

test("a batch over the line asks, though every shot in it is under the line: a member is told an admin has to start it, at the quote and at the press, and nothing starts", async () => {
  await inWorkspace("over", async (ws) => {
    const s = stand();
    const members = shots(80, 80, 80);
    expect(80).toBeLessThan(LINE);
    expect(80 * 3).toBeGreaterThan(LINE);
    /* Each shot alone is a job under the line: it quotes and starts for a member. */
    for (const m of members) {
      const one = await as(ws, MEMBER, () => batch(MEMBER, { members: [m], quoteOnly: true }, s.seams));
      expect(one.status, JSON.stringify(one.body)).toBe(200);
    }
    /* Together they are one job of 240 cr. */
    for (const quoteOnly of [true, false]) {
      const out = await as(ws, MEMBER, () => batch(MEMBER, { members, quoteOnly, maxCredits: 240, fingerprint: "0".repeat(64) }, s.seams));
      expect(out.status, `quoteOnly ${quoteOnly}`).toBe(403);
      expect(out.body).toMatchObject({ needsAdmin: true });
      expect(String(out.body.error)).toMatch(/This job is 240 cr, over the 200 cr that needs an admin\. An admin has to start it\./);
    }
    expect(s.admitted).toEqual([]);
  });
});

test("an admin's own tap clears it, once, for exactly the listed shots at their listed prices; the quote shows the total, and the press starts each shot at its own quote", async () => {
  await inWorkspace("admin", async (ws) => {
    const s = stand();
    const members = shots(80, 90, 70);
    const quote = await as(ws, ADMIN, () => batch(ADMIN, { members, quoteOnly: true }, s.seams));
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body).toMatchObject({ estimatedCredits: 240, price: 240, unit: "cr", members: 3 });
    const fingerprint = String(quote.body.fingerprint);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    /* No approval, one under the total, or one for other shots or prices: nothing starts. */
    expect((await as(ws, ADMIN, () => batch(ADMIN, { members }, s.seams))).status).toBe(409);
    expect((await as(ws, ADMIN, () => batch(ADMIN, { members, fingerprint }, s.seams))).status).toBe(409);
    expect((await as(ws, ADMIN, () => batch(ADMIN, { members, fingerprint, maxCredits: 239 }, s.seams))).status).toBe(409);
    expect(await as(ws, ADMIN, () => batch(ADMIN, { members: shots(80, 90, 71), fingerprint, maxCredits: 241 }, s.seams))).toMatchObject({ status: 409, body: { quoteChanged: true } });
    expect(await as(ws, ADMIN, () => batch(ADMIN, { members: shots(80, 90), fingerprint, maxCredits: 240 }, s.seams))).toMatchObject({ status: 409, body: { quoteChanged: true } });
    expect(s.admitted).toEqual([]);
    const pressed = await as(ws, ADMIN, () => batch(ADMIN, { members, fingerprint, maxCredits: 240 }, s.seams));
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(pressed.body).toMatchObject({ status: "started", estimatedCredits: 240 });
    expect(s.admitted.map((a) => a.credits)).toEqual([80, 90, 70]);
    expect(new Set(s.admitted.map((a) => a.key)).size).toBe(3);
  });
});

test("the total is the server's: a total, a size or a ceiling sent by the client is never read", async () => {
  await inWorkspace("forged", async (ws) => {
    const s = stand();
    const forged = shots(80, 80, 80).map((m) => ({ ...m, maxCredits: 1, quoteFingerprint: "a".repeat(64), batchId: "bt_forged", batchSize: 1 }));
    const out = await as(ws, MEMBER, () => batch(MEMBER, { members: forged, quoteOnly: true, estimatedCredits: 1, total: 1, size: 1 }, s.seams));
    expect(out.status).toBe(403);
    expect(String(out.body.error)).toMatch(/240 cr/);
    /* Each member was priced as a plain request: none of those claims reached the price path. */
    for (const body of s.prepared) for (const key of ["maxCredits", "quoteFingerprint", "batchId", "batchSize"]) expect(body, key).not.toHaveProperty(key);
  });
});

test("exactly at the line is not over it: a member may press two shots of 100 cr; one tenth over asks", async () => {
  await inWorkspace("exact", async (ws) => {
    const s = stand();
    const quote = await as(ws, MEMBER, () => batch(MEMBER, { members: shots(100, 100), quoteOnly: true }, s.seams));
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const pressed = await as(ws, MEMBER, () => batch(MEMBER, { members: shots(100, 100), fingerprint: String(quote.body.fingerprint), maxCredits: 200 }, s.seams));
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(s.admitted).toHaveLength(2);
    expect((await as(ws, MEMBER, () => batch(MEMBER, { members: shots(100, 100.1), quoteOnly: true }, s.seams))).status).toBe(403);
  });
});

test("a machine never presses it: a token (an admin's too), an agent identity and Atomik's Auto may ask the price under the line, are refused outright over it, and never approve", async () => {
  await inWorkspace("machine", async (ws) => {
    const s = stand();
    const under = shots(60, 60);
    const over = shots(80, 80, 80);
    for (const actor of [TOKEN, AGENT]) {
      const quote = await as(ws, actor, () => batch(actor, { members: under, quoteOnly: true }, s.seams));
      expect(quote.status, actor.user.id).toBe(200);
      const press = await as(ws, actor, () => batch(actor, { members: under, fingerprint: String(quote.body.fingerprint), maxCredits: 120 }, s.seams));
      expect(press, actor.user.id).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
      for (const quoteOnly of [true, false]) {
        const out = await as(ws, actor, () => batch(actor, { members: over, quoteOnly, maxCredits: 240, fingerprint: "0".repeat(64) }, s.seams));
        expect(out.status, `${actor.user.id} ${quoteOnly}`).toBe(403);
        expect(String(out.body.error)).toMatch(/needs an admin's own tap\. Atomik, an MCP client and API tokens can prepare it, never start it\./);
      }
    }
    const auto: AdmissionExecution = { ...noop, run: { auto: true } as never };
    const quote = await as(ws, ADMIN, () => batch(ADMIN, { members: under, quoteOnly: true }, s.seams));
    expect(await as(ws, ADMIN, () => batch(ADMIN, { members: under, fingerprint: String(quote.body.fingerprint), maxCredits: 120 }, s.seams, auto))).toMatchObject({ status: 403 });
    expect((await as(ws, ADMIN, () => batch(ADMIN, { members: over, quoteOnly: true }, s.seams, auto))).status).toBe(403);
    expect(s.admitted).toEqual([]);
  });
});

test("the balance is checked against the whole total before the first shot starts: short by N cr, top up, then approve", async () => {
  await inWorkspace("short", async (ws) => {
    const s = stand();
    const members = shots(30, 30, 30);
    const quote = await as(ws, MEMBER, () => batch(MEMBER, { members, quoteOnly: true }, s.seams));
    const out = await as(ws, MEMBER, () => batch(MEMBER, { members, fingerprint: String(quote.body.fingerprint), maxCredits: 90 }, s.seams));
    expect(out.status, JSON.stringify(out.body)).toBe(402);
    expect(String(out.body.error)).toMatch(/^Short by \d+(\.\d)? cr\. Top up, then approve\. Nothing is spent until you do\.$/);
    expect(s.admitted).toEqual([]);
  }, 50);
});

test("the house is judged at cost against the same line, in words with no figure; a refused member is named and the rest still start", async () => {
  const { keepingHouseJobsClean } = await import("../helpers/houseJobs");
  const { runInTenant } = await import("../../lib/tenant");
  const house = { ...workspace(`house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 };
  await keepingHouseJobsClean(async () => {
    const s = stand("usd");
    await runInTenant(house, async () => {
      const out = await batch(MEMBER, { members: shots(80, 80, 80), quoteOnly: true }, s.seams);
      expect(out.status, JSON.stringify(out.body)).toBe(403);
      expect(String(out.body.error)).not.toMatch(/\bcr\b|\d/);
      const ok = await batch(MEMBER, { members: shots(80, 80), quoteOnly: true }, s.seams);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ unit: "usd" });
    }, { user: MEMBER.user } as never);
    /* A refused member is named; the others start. */
    const mixed = stand();
    let n = 0;
    const seams = { ...mixed.seams, admit: async (p: PreparedAdmission, a: AdmissionActor, o: { requestKey: string; defer: AdmissionExecution["defer"] }): Promise<AdmissionReply> => (++n === 2 ? { status: 429, body: { error: "Too many renders at once." } } : mixed.seams.admit(p, a, o)) };
    await inWorkspace("partial", async (ws) => {
      const quote = await as(ws, ADMIN, () => batch(ADMIN, { members: shots(60, 60, 60), quoteOnly: true }, seams));
      const out = await as(ws, ADMIN, () => batch(ADMIN, { members: shots(60, 60, 60), fingerprint: String(quote.body.fingerprint), maxCredits: 180 }, seams));
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ status: "partial", members: [{ index: 0, status: "queued" }, { index: 1, error: "Too many renders at once.", code: 429 }, { index: 2, status: "queued" }] });
      expect(String(out.body.retry)).toContain("not started twice");
    });
  });
});
