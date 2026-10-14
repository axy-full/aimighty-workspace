import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Who picked, approved or sent a take back, read from the review history (lib/takeReviewReads.ts; owner, 14 Oct 2026; docs/plans/step-0-data.md item 3): by name and never by account id,
 * through the workspace's own `users` row and the stored-actor mask; a mark with no event reads "not recorded"; the reasons are codes only. It reaches the jobs API (and so the MCP
 * tools, which read it) and the CSV export's reject_reasons column. Real route and databases in a temp directory; nothing renders and nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-take-approval-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const WS: TenantWorkspace = {
  id: "ws_approval", name: "ws_approval", slug: "ws_approval", legacy: false, dbUrl: `file:${path.join(dir, "ws_approval.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
  ownerId: "u_admin", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
};
type Who = { id: string; token?: { id: string; name: string; scope: string } };
const WHO: Record<string, Who> = {
  person: { id: "u_admin" },
  renderToken: { id: "u_admin", token: { id: "tok1", name: "t", scope: "render" } },
  mcpToken: { id: "u_admin", token: { id: "tok2", name: "Claude over MCP", scope: "prepare" } },
  agent: { id: "agent:run-1" },
};

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

async function setup() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const records = await import("../../lib/workbench/records");
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  const state = { who: WHO.person };
  const auth = {
    withTenant: (handler: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => tenant.runInTenant(WS, () => handler(...a)),
    requireUser: async () => ({ user: { id: state.who.id, name: state.who.id, role: "admin", owner: false }, ...(state.who.token ? { token: state.who.token } : {}) }),
  };
  const jobs = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": auth, "@/lib/db": database, "@/lib/tenant": tenant, "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" }, "@/lib/workAccess": await import("../../lib/workAccess"),
    "@/lib/draftProject": { mayReachProject: async () => true, productionReachable: async () => true, mayReadTake: async () => true, NO_SUCH_PROJECT: "\u0000unknown" },
    "@/lib/workbench/records": records, "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
    "@/lib/mediaBindings": await import("../../lib/mediaBindings"), "@/lib/mediaDeletion": await import("../../lib/mediaDeletion"),
    "@/lib/jobs": await import("../../lib/jobs"), "@/lib/shots": await import("../../lib/shots"), "@/lib/held": await import("../../lib/held"),
    "next/server": { NextResponse, after: () => {} }, "@/lib/recovery": { reserveRecoveryContinuation: async (_n: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async () => {} }, "@/lib/usageLedger": {},
  });
  const patch = async (id: string, body: unknown) => {
    const res = await jobs.PATCH(new Request("https://studio.test/api/jobs/x", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${WS.id}-${state.who.id}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
  };
  const row = async (id: string) => (await tenant.runInTenant(WS, async () => (await database.db().execute({ sql: "SELECT title, review_state, review_by, picked_by, approved_by, approved_at FROM generations WHERE id=?", args: [id] })).rows[0]));
  return { as: (name: string) => { state.who = WHO[name]; }, patch, row, tenant, database };
}

async function seed(api: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  await api.tenant.runInTenant(WS, async () => {
    await api.database.ready();
    await api.database.db().batch([
      { sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('u_admin','a@example.invalid','Admin','!','admin',0,0)", args: [] },
      ...ids.map((id) => ({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,stored_url) VALUES(?,'m','p','{}','succeeded',1,1,'image','Original',0,'u_admin',?)`, args: [id, `/api/media/${id}`] })),
    ], "write");
  });
}



const ID_PATTERN = /u_admin|agent:run-1|usr_|support_[0-9a-f]{24}/;

test("a take's review is read by name from its history: a person, a token (the person it acts as) and an agent (no name), with the channel; no account id anywhere", async () => {
  const api = await setup();
  await seed(api, ["r1"]);
  api.as("person");
  await api.patch("r1", { reviewState: "picked" });
  api.as("agent");
  await api.patch("r1", { reviewState: "picked" });
  api.as("mcpToken");
  await api.patch("r1", { reviewState: "changes", reasons: ["drift", "framing"], drift: "wardrobe", reasonText: "The coat changed" });
  api.as("person");
  await api.patch("r1", { reviewState: "approved" });
  const { getGeneration, listGenerations } = await import("../../lib/jobs");
  const generation = await api.tenant.runInTenant(WS, () => getGeneration("r1"));
  expect(generation?.review).toEqual({
    picked: { by: null, via: "agent", at: expect.any(Number) },
    approved: { by: "Admin", via: "person", at: expect.any(Number) },
    changes: { by: "Admin", via: "token", at: expect.any(Number), reasons: ["framing", "drift"], drift: "wardrobe" },
  });
  const listed = await api.tenant.runInTenant(WS, () => listGenerations({ viewer: null, limit: 10 }));
  expect(listed.find((g) => g.id === "r1")?.review).toEqual(generation?.review);
  /* Names and codes, never an id, and never the person's words (they stay in the notes). */
  expect(JSON.stringify(generation?.review)).not.toMatch(ID_PATTERN);
  expect(JSON.stringify(generation?.review)).not.toContain("coat");
});

test("a mark with no event reads not recorded, whatever the old name columns say; a take never reviewed reads the same", async () => {
  const api = await setup();
  await seed(api, ["old", "never"]);
  await api.tenant.runInTenant(WS, () => api.database.db().execute("UPDATE generations SET review_state='picked', picked_by='Old Name', approved_by='Older Name' WHERE id='old'"));
  const { getGeneration } = await import("../../lib/jobs");
  for (const id of ["old", "never"]) expect((await api.tenant.runInTenant(WS, () => getGeneration(id)))?.review, id).toEqual({ picked: null, approved: null, changes: null });
});

test("the platform owner reads as Particl support in a client workspace and by name in the house, from the same history", async () => {
  process.env.SUPER_ADMIN_EMAIL = "owner-reads@example.test";
  const platform = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  const { resetPlatformOwnerIdentity } = await import("../../lib/platformOwnerPrivacy");
  const { reviewReadsFor } = await import("../../lib/takeReviewReads");
  await platform.platformReady();
  const owner = await platform.createAccount("owner-reads@example.test", "Rhea Rootname", hashPassword("Unique-studio-password-43"));
  resetPlatformOwnerIdentity();
  const api = await setup();
  const house = { ...WS, id: "ws_legacy", slug: "house", legacy: true, dbUrl: `file:${path.join(dir, "house-reads.db")}` } as TenantWorkspace;
  for (const [ws, expected] of [[WS, "Particl support"], [house, "Rhea Rootname"]] as const) {
    await api.tenant.runInTenant(ws, async () => {
      await api.database.ready();
      await api.database.db().batch([
        { sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES(?,?,?,'!','admin',0,0)", args: [owner.id, `${owner.id}@example.invalid`, "Rhea Rootname"] },
        { sql: "INSERT OR IGNORE INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by) VALUES('own','m','p','{}','succeeded',1,1,'image',0,'u1')", args: [] },
        { sql: "INSERT INTO take_review_events(id,gen_id,action,actor_id,via,created_at) VALUES(?,'own','approved',?,'person',5)", args: [`tre_${ws.id}`, owner.id] },
      ], "write");
      const read = (await reviewReadsFor(["own"])).get("own");
      expect(read?.approved?.by, ws.id).toBe(expected);
      expect(JSON.stringify(read)).not.toContain(owner.id);
    });
  }
  delete process.env.SUPER_ADMIN_EMAIL;
  resetPlatformOwnerIdentity();
});

test("the CSV export names the reject reasons of each take's latest send-back as codes joined by ';', and nothing for a take with none", async () => {
  const api = await setup();
  await seed(api, ["x1", "x2", "x3"]);
  api.as("person");
  await api.patch("x1", { reviewState: "changes", reasons: ["artifacts", "framing"], reasonText: "words that stay in the notes" });
  await api.patch("x1", { reviewState: "changes", reasons: ["motion", "audio"] });
  await api.patch("x2", { reviewState: "picked" });
  const { exportRows, takesCsv } = await import("../../lib/exportRows");
  const { rows, unit } = await api.tenant.runInTenant(WS, () => exportRows());
  const by = Object.fromEntries(rows.map((r) => [r.id, r.rejectReasons]));
  expect([by.x1, by.x2, by.x3]).toEqual(["motion;audio", "", ""]);
  const csv = takesCsv(rows, unit);
  expect(csv.split("\r\n")[0]).toMatch(/,url,reject_reasons$/);
  expect(csv).toContain("motion;audio");
  expect(csv).not.toContain("words that stay");
  expect(csv).not.toMatch(ID_PATTERN);
});

test("the MCP review line says the state, the reason codes and who by name; never an id, and 'not recorded' marks say nothing", async () => {
  const { reviewLine } = await import("../../lib/mcp");
  const marks = { picked: { by: "Mia", via: "person" }, approved: { by: "Particl support", via: "person" }, changes: { by: "Mia", via: "token", reasons: ["framing", "drift"] } };
  expect(reviewLine({ id: "t", status: "succeeded", prompt: "p", reviewState: "changes", review: marks })).toBe("  review: sent back: framing, drift · picked by Mia (person) · approved by Particl support (person)");
  expect(reviewLine({ id: "t", status: "succeeded", prompt: "p", reviewState: "approved", review: { picked: null, approved: { by: null, via: "agent" }, changes: null } })).toBe("  review: approved · approved by someone (agent)");
  expect(reviewLine({ id: "t", status: "succeeded", prompt: "p", reviewState: "", review: { picked: null, approved: null, changes: null } })).toBe("  review: not reviewed");
  expect(reviewLine({ id: "t", status: "succeeded", prompt: "p" })).toBe("  review: not reviewed");
});
