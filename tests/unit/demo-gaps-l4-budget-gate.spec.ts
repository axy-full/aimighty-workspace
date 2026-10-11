import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/*
 * The workspace's budget per production through the real reservation gate (lib/generationRequests.ts
 * reserveGenerationSpend): a production with no cap of its own is held to it, refused past it in the same words
 * the screens show; an admin's unlock lets it through; a new budget re-locks it. A production with its own cap
 * keeps it. Admission's pre-check (checkCap) reads the same figure.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-l4-budget-gate-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const ws: TenantWorkspace = {
  id: "ws_lfourgate", slug: "lfourgate", name: "Budget gate", legacy: false,
  dbUrl: `file:${path.join(dir, "gate.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};
const SEEDANCE = "dreamina-seedance-2-5-260628";

test("the workspace budget is enforced at the reservation gate, unlockable by an admin, re-locked by a new budget; an own cap wins", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { setSetting } = await import("../../lib/settings");
  const { projectCap, checkCap, resetCapLocks } = await import("../../lib/caps");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { billCredits } = await import("../../lib/creditTerms");
  await platformReady();
  await alignLedgerUnit();
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('grant_lfour',?,5000,'manual',0)`, args: [ws.id] });
  await runInTenant(ws, async () => {
    await ready();
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_credits) VALUES('follows','Follows the budget',0,NULL),('own','Own cap',0,1000)`);
    const usd = 0.5;
    const credits = billCredits(usd, SEEDANCE);
    expect(credits).toBeGreaterThan(1);
    const job = (id: string, projectId: string) => reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: usd, projectId, createdBy: "owner" })
      .then(() => null, (error: unknown) => error);

    /* No budget: nothing caps the production. */
    expect(await job("g_free", "follows")).toBeNull();
    /* A budget of one job, already used by the first: the gate refuses the next, in the words the pre-check and screens use. */
    await setSetting("productionBudgetCredits", String(credits), "owner");
    expect(await projectCap("follows")).toMatchObject({ cap: credits, from: "workspace" });
    const pre = await checkCap("follows", usd, SEEDANCE);
    expect(pre.allow).toBe(false);
    const refused = await job("g_over", "follows");
    expect(refused).toBeInstanceOf(SpendReservationError);
    expect((refused as Error).message).toBe(pre.error);
    expect((refused as Error).message).toContain(`cap of ${credits} cr`);
    /* A production with its own cap is not held to the budget. */
    expect(await job("g_own", "own")).toBeNull();

    /* An admin unlocks it: through. */
    await db().execute("UPDATE projects SET cap_unlocked=1 WHERE id='follows'");
    expect(await job("g_unlocked", "follows")).toBeNull();
    /* A new budget re-locks every production that follows it (the settings route does this on a change): refused again. */
    await resetCapLocks({ budget: true });
    expect((await db().execute("SELECT id,cap_unlocked FROM projects ORDER BY id")).rows.map((r) => [r.id, Number(r.cap_unlocked)])).toEqual([["follows", 0], ["own", 0]]);
    expect(await job("g_relocked", "follows")).toBeInstanceOf(SpendReservationError);
    /* Cleared: no budget, nothing caps it. */
    await setSetting("productionBudgetCredits", "", "owner");
    expect(await job("g_cleared", "follows")).toBeNull();
  });
});

/* ── An Unlock is tied to the cap it was shown for (review of #556, round 2) ─────────────────────────── */

/** A fresh funded workspace with room for many jobs at once (the gate's slot limit is not what these tests are about). */
async function fresh(id: string): Promise<TenantWorkspace> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await alignLedgerUnit();
  const w: TenantWorkspace = { ...ws, id, slug: id, name: id, dbUrl: `file:${path.join(dir, `${id}.db`)}`, concurrency: 50, rendersPerHour: 500 };
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,5000,'manual',0)`, args: [`grant_${id}`, id] });
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(w, async () => { await (await import("../../lib/db")).ready(); });
  return w;
}

/** PATCH /api/projects/[id] and PATCH /api/settings as an admin's signed-in session (the people-only checks: demo-gaps-l4-people-only). */
async function adminRoutes() {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const ts = (await import("typescript")).default;
  const load = <T,>(file: string): T => {
    const filename = path.resolve(file), req = createRequire(filename);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} };
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name === "@/lib/auth") return {
        withTenant: (h: unknown) => h,
        requireUser: async () => ({ user: { id: "owner", role: "admin" } }),
        requireAdmin: async () => ({ user: { id: "owner", role: "admin" } }),
      };
      return name.startsWith("@/") ? req(path.resolve(name.slice(2))) : req(name);
    }, mod, mod.exports);
    return mod.exports as T;
  };
  const project = load<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts");
  const settings = load<typeof import("../../app/api/settings/route")>("app/api/settings/route.ts");
  const body = (b: unknown) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return {
    patch: (id: string, b: unknown) => project.PATCH(new Request(`http://localhost/api/projects/${id}`, body(b)), { params: Promise.resolve({ id }) } as never),
    budget: (v: string) => settings.PATCH(new Request("http://localhost/api/settings", body({ productionBudgetCredits: v })), undefined as never),
  };
}

test("one screen, two tabs, two admins: an Unlock lands only on the cap it was shown and only at it; a stale one is refused with the new figure and never lets spend past the new cap", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { billCredits } = await import("../../lib/creditTerms");
  const { capChanged, NOT_AT_CAP } = await import("../../lib/caps");
  const api = await adminRoutes();
  const w = await fresh("ws_lfourstale");
  await runInTenant(w, async () => {
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_credits) VALUES('stale','Stale unlock',0,NULL)`);
    const usd = 0.5, c = billCredits(usd, SEEDANCE);
    const job = (id: string) => reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: usd, projectId: "stale", createdBy: "owner" }).then(() => null, (e: unknown) => e);
    const unlocked = async () => Number((await db().execute("SELECT cap_unlocked FROM projects WHERE id='stale'")).rows[0].cap_unlocked);

    /* The budget is one job, and the production has used it: at its cap, refused. Every screen shows c cr and Unlock. */
    expect((await api.budget(String(c))).status).toBe(200);
    expect(await job("s_1")).toBeNull();
    expect(await job("s_2")).toBeInstanceOf(SpendReservationError);
    const shown = c;

    /* Not at its cap: nothing to unlock. (A second production, the same budget, nothing used.) */
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_credits) VALUES('room','Room left',0,NULL)`);
    const early = await api.patch("room", { capUnlocked: true, forCap: shown });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toBe(NOT_AT_CAP);

    /* An Unlock that names no cap is refused: it cannot be tied to anything. */
    expect((await api.patch("stale", { capUnlocked: true })).status).toBe(409);
    expect(await unlocked()).toBe(0);

    /* Two admins (or two tabs, or one screen whose list was not read again): the other raises the budget to two jobs.
       The route writes it and re-locks in one transaction; the next job fits the new cap, then the new cap stops it. */
    expect((await api.budget(String(2 * c))).status).toBe(200);
    expect(await job("s_2b")).toBeNull();
    expect(await job("s_3")).toBeInstanceOf(SpendReservationError);
    /* The first admin's Unlock, for the cap they were shown: refused with the new figure, and nothing is written. */
    const stale = await api.patch("stale", { capUnlocked: true, forCap: shown });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe(capChanged(2 * c, "cr"));
    expect(await unlocked()).toBe(0);
    /* So spend never goes past the new cap on the old unlock. */
    expect(await job("s_3b")).toBeInstanceOf(SpendReservationError);

    /* Looked at again, the Unlock names the cap it is at now: it lands, and the gate lets the production past it. */
    expect((await api.patch("stale", { capUnlocked: true, forCap: 2 * c })).status).toBe(200);
    expect(await unlocked()).toBe(1);
    expect(await job("s_4")).toBeNull();
    /* Its own cap written later re-locks it in the same statement as the cap. */
    expect((await api.patch("stale", { capCredits: 5 * c })).status).toBe(200);
    expect(await unlocked()).toBe(0);
    /* Lock again needs no figure. */
    await db().execute("UPDATE projects SET cap_unlocked=1 WHERE id='stale'");
    expect((await api.patch("stale", { capUnlocked: false })).status).toBe(200);
    expect(await unlocked()).toBe(0);
    expect((await api.budget("")).status).toBe(200);
  });
});

test("Settings and the Record count what a production used as the gate does: a job the meter holds with no take (Atomik's planning) counts on every screen", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { billCredits } = await import("../../lib/creditTerms");
  const { projectCapSpent } = await import("../../lib/caps");
  const { listProductions } = await import("../../lib/productions");
  const { invalidate, PROJECTS_KEY } = await import("../../lib/cache");
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const ts = (await import("typescript")).default;
  const filename = path.resolve("app/api/projects/route.ts"), req = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as { GET: (r: Request) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (name === "@/lib/auth") return { withTenant: (h: unknown) => h, requireUser: async () => ({ user: { id: "owner", role: "admin" } }) };
    return name.startsWith("@/") ? req(path.resolve(name.slice(2))) : req(name);
  }, mod, mod.exports);
  const w = await fresh("ws_lfourmeter");
  await runInTenant(w, async () => {
    await db().execute(`INSERT INTO productions(id,name,client,status,created_at) VALUES('c_meter','Container','','active',0)`);
    await db().execute(`INSERT INTO projects(id,name,created_at,production_id) VALUES('meter_only','Meter only',0,'c_meter')`);
    const c = billCredits(0.5, SEEDANCE);
    /* A paid job reserved on the production with no take row: what an Atomik planning job is. */
    await reserveGenerationSpend({ id: "meter_job_1", kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: 0.5, projectId: "meter_only", createdBy: "owner" });
    expect((await db().execute("SELECT COUNT(*) AS n FROM generations WHERE project_id='meter_only'")).rows[0].n).toBe(0);
    const gate = (await projectCapSpent("meter_only"))!.spent;
    expect(gate).toBe(c);
    invalidate(PROJECTS_KEY);
    const list = await (await mod.exports.GET(new Request("http://localhost/api/projects"))).json() as { projects: { id: string; credits: number }[] };
    expect(list.projects.find((p) => p.id === "meter_only")!.credits).toBe(gate);
    const record = (await listProductions()).flatMap((p) => p.projects).find((p) => p.id === "meter_only")!;
    expect(record.spentCredits).toBe(gate);
  });
});
