import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The marked sample production is read-only for every viewer, the workspace's owner and admins included (owner, 12 Oct): nothing is written into it (its canvas,
 * its saved board, a copy opened of it, its shots, takes or library); every viewer can still read it and make a board of their own. The answers are the ones a
 * shared board gives a teammate: 403 `view_only` for saves, shots, takes and filings, 404 for canvas writes. Real temporary databases; sign-in is a fake.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-sample-readonly-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: id === "u_owner", disabled: false, lastSeen: null, createdAt: 0 });
const VIEWERS = [["the workspace owner (who marked it)", "u_owner", "admin"], ["an admin", "u_admin", "admin"], ["a member", "u_mate", "member"]] as const;

function loadRoute<T>(file: string, who: () => ReturnType<typeof user>): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: who() }), requireRender: async () => ({ user: who() }), requireSession: async () => ({ user: who() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
  const sample = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady(); await teamCanvasReady();
    const db = database.db();
    await db.execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_g','Group',0)", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES(?,?,0,'prod_g')", args: [sample, "The sample"] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prod_open','Ordinary',0,'prod_g')", args: [] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: sample })] });
    await db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,1,'u_owner',1)", args: [sample, JSON.stringify({ nodes: { n1: { id: "n1", title: "Opening" } } })] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,created_at,updated_at) VALUES(?,?,'SH010','Sample shot',1,1)", args: [`shot_s_${run}`, sample] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,created_at,updated_at) VALUES(?,?,'SH010','Open shot',1,1)", args: [`shot_o_${run}`, "prod_open"] });
    await db.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,?,'succeeded',1,1,'image')", args: [`gen_s_${run}`, sample, "m", "p", "{}"] });
    await db.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,?,'succeeded',1,1,'image')", args: [`gen_o_${run}`, "prod_open", "m", "p", "{}"] });
    await db.execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_owner',1)", args: [JSON.stringify({ version: 1, projectId: sample, name: "The sample", draftOwner: "u_owner", draftId: "d1", markedBy: "u_owner", markedAt: 5 })] });
  }, { user: user("u_owner", "admin") });
  return { tenant, database, sample, newProject };
}

const json = (method: string, body: unknown) => new Request("https://particl.test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test("every viewer is refused every write into the sample production, and every viewer still reads it", async () => {
  const ws = workspace(`sro-a-${run}`);
  const { tenant, database, sample, newProject } = await fixture(ws);
  let who = user("u_mate");
  const canvas = loadRoute<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts", () => who);
  const studio = loadRoute<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts", () => who);
  const shots = loadRoute<typeof import("../../app/api/shots/route")>("app/api/shots/route.ts", () => who);
  const shot = loadRoute<typeof import("../../app/api/shots/[id]/route")>("app/api/shots/[id]/route.ts", () => who);
  const jobs = loadRoute<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", () => who);
  const demo = loadRoute<typeof import("../../app/api/demo/sample/route")>("app/api/demo/sample/route.ts", () => who);
  const { requireProduction } = await import("../../lib/workbench/team-canvas");
  const { linkProjectLibraryUpload, ProjectLibraryError } = await import("../../lib/workbench/project-library");
  const { readDraft } = await import("../../lib/workbench/records");
  const body = async (res: Response) => res.json();
  for (const [label, id, role] of VIEWERS) {
    who = user(id, role);
    await tenant.runInTenant(ws, async () => {
      const mine = `own-${id}-${run}`;
      /* Reads: the canvas, the production's board and the sample's own open all work, and say view-only. */
      await expect(requireProduction(sample, undefined, "read"), `${label}: read`).resolves.toBeUndefined();
      expect((await canvas.GET(new Request(`https://particl.test/api/workbench/team-canvas?productionId=${sample}`), undefined as never)).status, `${label}: canvas read`).toBe(200);
      const opened = await body(await demo.POST(json("POST", { action: "open" }), undefined as never));
      expect(opened.viewOnly?.owner, `${label}: the sample opens view-only`).toBeTruthy();
      const copyId = opened.project.id as string;
      expect(copyId.startsWith("sample-")).toBe(true);
      expect(await readDraft(id, copyId), `${label}: their own copy was made`).not.toBeNull();
      const seen = await body(await studio.GET(new Request(`https://particl.test/api/workbench/projects?id=${copyId}`), undefined as never));
      expect(seen.viewOnly?.owner, `${label}: the copy reads view-only`).toBeTruthy();
      expect(JSON.stringify(await body(await shots.GET(new Request(`https://particl.test/api/shots?projectId=${sample}`), undefined as never)))).toContain("Sample shot");
      /* Writes: the canvas (404), the copy's and the original's saves (403), shots, a take, a library filing. */
      await expect(requireProduction(sample, undefined, "write"), `${label}: canvas write`).rejects.toThrow(/not in this workspace/);
      expect((await canvas.PATCH(json("PATCH", { productionId: sample, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }), undefined as never)).status, `${label}: canvas PATCH`).toBe(404);
      for (const [what, project] of [["their copy", { ...opened.project }], ["the board it was marked from", { ...newProject("d1"), id: "d1", productionProjectId: sample }]] as const) {
        const save = await studio.PUT(json("PUT", { project, revision: id === "u_owner" && what !== "their copy" ? 1 : opened.revision }), undefined as never);
        expect(save.status, `${label}: save of ${what}`).toBe(403);
        expect((await save.json()).code).toBe("view_only");
      }
      const made = await shots.POST(json("POST", { projectId: sample, code: `SH9${VIEWERS.findIndex((v) => v[1] === id)}`, title: "Hijack" }), undefined as never);
      expect([made.status, (await made.json()).code], `${label}: a shot into the sample`).toEqual([403, "view_only"]);
      for (const [what, res] of [
        ["a shot's edit", await shot.PATCH(json("PATCH", { title: "Hijack" }), ctx(`shot_s_${run}`))],
        ["a shot's deletion", await shot.DELETE(new Request("https://particl.test/x", { method: "DELETE" }), ctx(`shot_s_${run}`))],
        ["a shot moved out", await shot.PATCH(json("PATCH", { projectId: "prod_open" }), ctx(`shot_s_${run}`))],
        ["a take's rename", await jobs.PATCH(json("PATCH", { title: "Hijack" }), ctx(`gen_s_${run}`))],
        ["a take filed into the sample", await jobs.PATCH(json("PATCH", { projectId: sample }), ctx(`gen_o_${run}`))],
      ] as const) expect([res.status, (await res.json()).code], `${label}: ${what}`).toEqual([403, "view_only"]);
      await expect(linkProjectLibraryUpload(id, copyId, "upl_x"), `${label}: a library filing`).rejects.toBeInstanceOf(ProjectLibraryError);
      /* Their own board is theirs: a draft not linked to the sample saves, and an ordinary production takes shots. */
      const own = await studio.PUT(json("PUT", { project: newProject(mine), revision: 0 }), undefined as never);
      expect(own.status, `${label}: a board of their own: ${JSON.stringify(await own.clone().json())}`).toBe(200);
      expect((await shots.POST(json("POST", { projectId: "prod_open", code: `SH8${VIEWERS.findIndex((v) => v[1] === id)}`, title: "Mine" }), undefined as never)).status, `${label}: an ordinary production`).toBe(200);
    }, { user: who });
  }
  /* Nothing was written into the sample. */
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    expect((await db.execute({ sql: "SELECT body FROM workbench_team_canvas WHERE production_id=?", args: [sample] })).rows[0].body).toBe(JSON.stringify({ nodes: { n1: { id: "n1", title: "Opening" } } }));
    expect((await db.execute({ sql: "SELECT COUNT(*) AS n FROM shots WHERE project_id=?", args: [sample] })).rows[0].n).toBe(1);
    expect((await db.execute({ sql: "SELECT title FROM shots WHERE id=?", args: [`shot_s_${run}`] })).rows[0].title).toBe("Sample shot");
    expect((await db.execute({ sql: "SELECT project_id FROM shots WHERE id=?", args: [`shot_s_${run}`] })).rows[0].project_id).toBe(sample);
  }, { user: user("u_owner", "admin") });
  /* Undoing the mark lifts it: the marker's own board saves and its canvas takes writes again. */
  await tenant.runInTenant(ws, async () => {
    await database.db().execute({ sql: "UPDATE settings SET value=json_set(value,'$.hiddenAt',9) WHERE key='sampleProduction'", args: [] });
    who = user("u_owner", "admin");
    await expect(requireProduction(sample, undefined, "write")).resolves.toBeUndefined();
  }, { user: user("u_owner", "admin") });
});
