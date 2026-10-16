import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * House style (lib/housestyle.ts) uses only the work the person rendering may read (owner, 15 Oct 2026: "House style: YES, fix it so only boards the person can read (same
 * workspace) are used"). The examples go into that person's refiner prompt, so another member's private board is never one, by the rule the takes list uses (lib/draftProject.ts).
 * Real temporary databases; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-housestyle-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, role: "member" as const, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
const A = user("u_a"), B = user("u_b");

/* An approved prompt long enough to count (40+ characters), tagged so a leak is a string match. */
const prompt = (tag: string, n: number) => `${tag}-${n} a slow dolly across the harbour at dusk, soft key light, restrained grade`;
async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const board = (owner: string, id: string) => draft.mappedId("prj_wb_", ws.id, owner, id);
  const projects = { aPrivate: board("u_a", "d1"), bOwn: board("u_b", "d2"), shared: board("u_a", "d3") };
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const [id, name] of [[projects.aPrivate, "A private"], [projects.bOwn, "B own"], [projects.shared, "A shared"], ["prod_open", "Ordinary production"]])
      await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, name] });
    const draftRow = (owner: string, id: string, extra: Record<string, unknown>) => db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${owner}:${id}`, owner, id, id, JSON.stringify(extra)] });
    await draftRow("u_a", "d1", { productionProjectId: projects.aPrivate });
    await draftRow("u_b", "d2", { productionProjectId: projects.bOwn });
    await draftRow("u_a", "d3", { productionProjectId: projects.shared, teamShared: true });
    const take = (id: string, text: string, projectId: string | null, at: number) => db.execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,review_state,reviewed_at) VALUES(?,?,?,?,?,?,?,'image',?,0,'u_a',?,'approved',?)`,
      args: [id, "m", text, "{}", "succeeded", at, at, text.slice(0, 20), projectId, at] });
    /* A's private board is the NEWEST work, so a fallback that read every board would be dominated by it. */
    for (const n of [1, 2, 3]) await take(`g_a${n}_${run}`, prompt("A-PRIVATE", n), projects.aPrivate, 100 + n);
    for (const n of [1, 2]) await take(`g_b${n}_${run}`, prompt("B-OWN", n), projects.bOwn, 50 + n);
    await take(`g_s_${run}`, prompt("SHARED", 1), projects.shared, 40);
    await take(`g_o_${run}`, prompt("OPEN", 1), "prod_open", 30);
    await take(`g_f_${run}`, prompt("FREE", 1), null, 20);
  }, { user: A });
  return { tenant, projects };
}
const styleFor = async (tenant: typeof import("../../lib/tenant"), ws: TenantWorkspace, who: ReturnType<typeof user>, projectId: string | null) => {
  const { houseStyle } = await import("../../lib/housestyle");
  return tenant.runInTenant(ws, async () => (await houseStyle({ id: who.id, role: who.role }, projectId)).map((e) => e.prompt).join("\n"), { user: who });
};

test("the fallback (no project) never carries another member's private board, and does carry a shared board, an ordinary production, unfiled work and the person's own", async () => {
  const ws = workspace(`hs-a-${run}`);
  const { tenant } = await fixture(ws);
  const seen = await styleFor(tenant, ws, B, null);
  expect(seen).not.toContain("A-PRIVATE");
  for (const tag of ["B-OWN", "SHARED", "OPEN", "FREE"]) expect(seen, tag).toContain(tag);
});

test("the scoped pick for another member's private board reads nothing of it, and what it falls back to is the readable work", async () => {
  const ws = workspace(`hs-b-${run}`);
  const { tenant, projects } = await fixture(ws);
  const seen = await styleFor(tenant, ws, B, projects.aPrivate);
  expect(seen).not.toContain("A-PRIVATE");
  expect(seen).toContain("B-OWN");
});

test("the board's owner reads their own work, scoped and in the fallback; a teammate's own board scopes to it", async () => {
  const ws = workspace(`hs-c-${run}`);
  const { tenant, projects } = await fixture(ws);
  const scoped = await styleFor(tenant, ws, A, projects.aPrivate);
  expect(scoped).toContain("A-PRIVATE-1");
  expect(scoped).toContain("A-PRIVATE-3");
  expect(scoped, "scoped to a board with enough of its own work").not.toContain("B-OWN");
  expect(await styleFor(tenant, ws, A, null), "A's fallback").toContain("A-PRIVATE");
  const bScoped = await styleFor(tenant, ws, B, projects.bOwn);
  expect(bScoped).toContain("B-OWN-1");
  expect(bScoped).toContain("B-OWN-2");
});

test("the memo does not carry one person's examples to another within its lifetime", async () => {
  const ws = workspace(`hs-d-${run}`);
  const { tenant, projects } = await fixture(ws);
  for (const projectId of [null, projects.aPrivate]) {
    const first = await styleFor(tenant, ws, A, projectId);
    expect(first, "A").toContain("A-PRIVATE");
    const second = await styleFor(tenant, ws, B, projectId);
    expect(second, "B, right after A").not.toContain("A-PRIVATE");
    expect(await styleFor(tenant, ws, A, projectId), "A again, from the memo").toBe(first);
  }
});

test("another workspace reads nothing of this one", async () => {
  const ws = workspace(`hs-e-${run}`), other = workspace(`hs-e2-${run}`);
  const { tenant, projects } = await fixture(ws);
  expect(await styleFor(tenant, ws, A, null)).toContain("A-PRIVATE");
  const database = await import("../../lib/db");
  await tenant.runInTenant(other, async () => { await database.ready(); }, { user: B });
  for (const projectId of [null, projects.aPrivate, projects.shared]) expect(await styleFor(tenant, other, B, projectId), String(projectId)).toBe("");
});
