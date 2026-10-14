import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * One rule for "the draft this person owns now" (lib/draftProject.ts › ownKeyOf, ownedDraftsSql, lib/workbench/records.ts › readOwnDraft), used wherever a person's own draft
 * is read or written by their user id. After a board is handed over (board sharing, PR 4) the draft stays under the first owner's key: the new owner is admitted at every
 * surface, the old owner is refused, and nothing is spent or sent (the paid and network steps are stubbed and counted). Real temporary databases; sign-in is a fake.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-board-surfaces-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const who = (id: string, role: "admin" | "member" = "member"): Who => ({ id, role, name: id, email: `${id}@example.test` });
const asUser = (w: Who) => ({ user: { ...w, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
const OLD = who("u_old"), NEW = who("u_new"), ADMIN = who("u_admin", "admin");

async function fixture(name: string) {
  const ws = { id: `bts-${name}-${run}`, name, slug: name, legacy: false, dbUrl: `file:${path.join(dir, `bts-${name}-${run}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true } as TenantWorkspace;
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), records = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const platform = await import("../../lib/platform");
  const { transferBoards } = await import("../../lib/workbench/board-transfer");
  await platform.platformReady();
  for (const [id, role] of [["u_old", "member"], ["u_new", "member"], ["u_admin", "admin"]] as const) {
    await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x"] });
    await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, id, role] });
  }
  const as = <T,>(p: Who, fn: () => Promise<T>) => tenant.runInTenant(ws, fn, asUser(p));
  const first = await as(OLD, async () => { await records.workbenchReady(); return records.saveDraft("u_old", { ...newProject("Board"), id: "d1", nodes: [], assets: [] } as never, 0); });
  const production = first.productionProjectId as string;
  const handOver = async () => {
    const moved = await as(ADMIN, () => transferBoards(ws, { ...ADMIN, owner: true } as never, [production], "u_new"));
    expect(moved.moved).toHaveLength(1);
  };
  return { ws, as, production, handOver, database, records };
}
const settle = async <T,>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: Error & { status?: number }) => ({ ok: false as const, message: error.message, status: error.status }));

test("the resolver and the SQL rule: the new owner owns the draft under the first owner's key, the old owner owns nothing of it, nobody else gains anything", async () => {
  const f = await fixture("rule");
  const { ownKeyOf, ownedDraftsSql, ownedDrafts } = await import("../../lib/draftProject");
  const listed = (p: Who) => f.as(p, async () => (await f.database.db().execute({ sql: `SELECT project_id FROM workbench_projects WHERE ${ownedDraftsSql(p.id).sql}`, args: ownedDraftsSql(p.id).args })).rows.map((r) => String(r.project_id)));
  const keys = async () => ({ old: await f.as(OLD, () => ownKeyOf("u_old", "d1")), now: await f.as(NEW, () => ownKeyOf("u_new", "d1")), admin: await f.as(ADMIN, () => ownKeyOf("u_admin", "d1")) });
  expect(await keys()).toEqual({ old: "u_old", now: "u_new", admin: "u_admin" });
  expect(await listed(OLD)).toEqual(["d1"]);
  await f.handOver();
  expect(await keys()).toEqual({ old: null, now: "u_old", admin: "u_admin" });
  expect(await listed(OLD)).toEqual([]);
  expect(await listed(NEW)).toEqual(["d1"]);
  expect(await listed(ADMIN)).toEqual([]);
  expect((await f.as(NEW, () => ownedDrafts("u_new"))).map((d) => [d.key, d.draftId])).toEqual([["u_old", "d1"]]);
});

test("Atomik and the 3D render jobs read the project through the one rule", async () => {
  const f = await fixture("atomik");
  const { getAtomikProject } = await import("../../lib/workbench/atomik-server");
  const { listAstraRenderJobs } = await import("../../lib/astra-blender/render-jobs");
  const read = (p: Who) => f.as(p, () => settle(getAtomikProject(p.id, "d1")));
  const jobs = (p: Who) => f.as(p, () => settle(listAstraRenderJobs(p.id, "d1")));
  expect((await read(OLD)).ok).toBe(true);
  await f.handOver();
  const old = await read(OLD), now = await read(NEW);
  expect(old).toMatchObject({ ok: false, status: 404 });
  expect(now.ok).toBe(true);
  expect(await jobs(OLD)).toMatchObject({ ok: false, status: 404 });
  expect(await jobs(NEW)).toEqual({ ok: true, value: [] });
});

test("a 3D render's outputs are filed into the draft its job's owner owns now, and into none they handed away", async () => {
  const f = await fixture("astra");
  const { astraRenderReady } = await import("../../lib/astra-blender/render-jobs");
  const { registerAstraArtifacts } = await import("../../lib/astra-blender/render-storage");
  await f.handOver();
  const artifacts = (n: string) => [
    { kind: "blend", assetId: `a_blend_${n}`, uploadId: `up_blend_${n}`, filename: "scene.blend", mime: "application/octet-stream", ext: "blend", bytes: 1, sha256: "x", storedUrl: "", url: "/u/blend" },
    { kind: "preview", assetId: `a_prev_${n}`, uploadId: `up_prev_${n}`, filename: "preview.png", mime: "image/png", ext: "png", bytes: 1, sha256: "y", storedUrl: "", url: "/u/prev" },
  ] as never;
  const assets = (key: string) => f.as(ADMIN, async () => JSON.parse(String((await f.database.db().execute({ sql: "SELECT body FROM workbench_projects WHERE owner=? AND project_id='d1'", args: [key] })).rows[0].body)).assets.map((a: { id: string }) => a.id) as string[]);
  await f.as(NEW, async () => { await astraRenderReady(); await registerAstraArtifacts("job_new", "u_new", "d1", artifacts("new")); });
  expect(await assets("u_old"), "the new owner's outputs are in the board").toEqual(["a_blend_new", "a_prev_new"]);
  await f.as(OLD, async () => { await astraRenderReady(); await registerAstraArtifacts("job_old", "u_old", "d1", artifacts("old")); });
  expect(await assets("u_old"), "the old owner's are not").toEqual(["a_blend_new", "a_prev_new"]);
});

test("Crew, the project library, edit versions, consent's project keys and the Studio project of a production use the one rule", async () => {
  const f = await fixture("crew");
  const { crewProject } = await import("../../lib/crew/http");
  const { resolveProjectLibrary } = await import("../../lib/workbench/project-library");
  const { saveEditVersion } = await import("../../lib/workbench/edit-versions");
  const { projectKeysFor } = await import("../../lib/security/consent");
  const { studioProjectFor } = await import("../../lib/atomikLibrary");
  await f.handOver();
  const crew = (p: Who) => f.as(p, () => settle(crewProject(p.id, "d1")));
  expect((await crew(OLD))).toMatchObject({ ok: false, status: 404 });
  expect((await crew(NEW)).ok).toBe(true);
  const library = (p: Who) => f.as(p, () => settle(resolveProjectLibrary(p.id, "d1")));
  expect(await library(OLD)).toMatchObject({ ok: false, status: 404 });
  const lib = await library(NEW);
  expect(lib.ok, JSON.stringify(lib)).toBe(true);
  const version = (p: Who) => f.as(p, () => settle(saveEditVersion(p.id, "d1", `ver-${p.id.replace(/_/g, "")}-0123456789abcdef`, "Cut", 1)));
  expect(await version(OLD)).toMatchObject({ ok: false, message: "Save your project before saving an edit version." });
  const cut = await version(NEW);
  expect(cut.ok || (cut as { message: string }).message !== "Save your project before saving an edit version.", "the new owner gets past the draft lookup").toBe(true);
  const keys = (p: Who) => f.as(p, () => projectKeysFor("d1", p.id));
  expect(await keys(OLD)).toEqual(["d1"]);
  expect(await keys(NEW)).toEqual(["d1", f.production]);
  const studio = (p: Who) => f.as(p, () => studioProjectFor(p.id, f.production));
  expect([await studio(OLD), await studio(NEW), await studio(ADMIN)]).toEqual([null, "d1", null]);
});

test("the three Moleculr routes: the old owner is refused before anything is fetched, the new owner is let through to the (stubbed) fetch, once", async () => {
  const f = await fixture("moleculr");
  await f.handOver();
  const calls: string[] = [];
  const root = process.cwd();
  const load = (file: string, viewer: () => Who) => {
    const real = createRequire(path.resolve(file));
    const fakes: Record<string, unknown> = {
      "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: async () => ({ user: asUser(viewer()).user }) },
      "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
      "@/lib/workbench/product-extraction": { extractProduct: async (url: string) => { calls.push(`product ${url}`); return { ok: true }; } },
      "@/lib/workbench/brand-extraction": { extractBrand: async (url: string) => { calls.push(`brand ${url}`); return { ok: true }; } },
      "@/lib/workbench/product-image": { downloadProductImage: async (url: string) => { calls.push(`image ${url}`); return { bytes: new Uint8Array([1]), mime: "image/png", filename: "a.png" }; } },
    };
    const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as { POST: (r: Request) => Promise<Response> } };
    new Function("require", "module", "exports", compiled)((n: string) => (Object.hasOwn(fakes, n) ? fakes[n] : n.startsWith("@/") ? real(path.join(root, n.slice(2))) : real(n)), mod, mod.exports);
    return mod.exports;
  };
  let current = OLD;
  for (const route of ["extract-brand", "extract-product", "import-image"]) {
    const mod = load(`app/api/workbench/moleculr/${route}/route.ts`, () => current);
    const ask = (p: Who) => { current = p; return f.as(p, async () => (await mod.POST(new Request(`https://particl.test/api/workbench/moleculr/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://shop.example/item", projectId: "d1" }) }))).status); };
    const before = calls.length;
    expect(await ask(OLD), `${route}: the old owner`).toBe(404);
    expect(calls.length, `${route}: nothing fetched for the old owner`).toBe(before);
    const admitted = await ask(NEW);
    expect(admitted, `${route}: the new owner is past the project check`).not.toBe(404);
    expect(calls.length, `${route}: one stubbed fetch for the new owner`).toBe(before + 1);
  }
});

test("Atomik's board building prices an ask for the new owner's draft and none for the old owner's, and spends nothing either way", async () => {
  const f = await fixture("rig");
  const saved = process.env.RIG_AGENT_ENABLED; process.env.RIG_AGENT_ENABLED = "1";
  try {
    const { rigAgentState } = await import("../../lib/workbench/rig-agent");
    const platform = await import("../../lib/platform");
    const meter = async () => Number((await platform.platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [f.ws.id] })).rows[0].n);
    const before = await meter();
    await f.handOver();
    const terms = (p: Who) => f.as(p, async () => (await settle(rigAgentState(f.production, p.id, "d1"))));
    const old = await terms(OLD), now = await terms(NEW);
    /* The old owner no longer reaches the board at all; the new owner does, and is quoted the planning price. */
    expect(old.ok).toBe(false);
    expect(now.ok, JSON.stringify(now)).toBe(true);
    if (now.ok) expect(now.value.ask, "the new owner's ask is priced from their draft").not.toBeNull();
    expect(await meter(), "nothing was spent").toBe(before);
  } finally { if (saved === undefined) delete process.env.RIG_AGENT_ENABLED; else process.env.RIG_AGENT_ENABLED = saved; }
});
