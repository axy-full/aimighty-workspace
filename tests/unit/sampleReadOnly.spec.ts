import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The marked sample production is read-only for every viewer but its owner (the person it was marked from) and the platform owner (owner, 13 Oct); the workspace's owner and admins who are neither stay refused: nothing is written into it (its canvas,
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
const VIEWERS = [["the workspace owner (who did not mark it)", "u_owner", "admin"], ["an admin", "u_admin", "admin"], ["a member", "u_mate", "member"]] as const;

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
  const sample = draft.mappedId("prj_wb_", ws.id, "u_marker", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady(); await teamCanvasReady();
    const db = database.db();
    await db.execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_g','Group',0)", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES(?,?,0,'prod_g')", args: [sample, "The sample"] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prod_open','Ordinary',0,'prod_g')", args: [] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_marker:d1", "u_marker", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: sample })] });
    await db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,1,'u_owner',1)", args: [sample, JSON.stringify({ nodes: { n1: { id: "n1", title: "Opening" } } })] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,created_at,updated_at) VALUES(?,?,'SH010','Sample shot',1,1)", args: [`shot_s_${run}`, sample] });
    await db.execute({ sql: "INSERT INTO shots(id,project_id,code,title,created_at,updated_at) VALUES(?,?,'SH010','Open shot',1,1)", args: [`shot_o_${run}`, "prod_open"] });
    await db.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,?,'succeeded',1,1,'image')", args: [`gen_s_${run}`, sample, "m", "p", "{}"] });
    await db.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,?,'succeeded',1,1,'image')", args: [`gen_o_${run}`, "prod_open", "m", "p", "{}"] });
    await db.execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_owner',1)", args: [JSON.stringify({ version: 1, projectId: sample, name: "The sample", draftOwner: "u_marker", draftId: "d1", markedBy: "u_marker", markedAt: 5 })] });
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
        const save = await studio.PUT(json("PUT", { project, revision: opened.revision }), undefined as never);
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
    who = user("u_marker");
    await expect(requireProduction(sample, undefined, "write")).resolves.toBeUndefined();
  }, { user: user("u_marker") });
});

test("every other way in is shut too: cast, treatment, cards, assets, wires, boards, notes, the production's own name, sharing, publishing, mapping, filings, for the owner, an admin and a member alike", async () => {
  const ws = workspace(`sro-b-${run}`);
  const agentRun = `rar_${"a".repeat(24)}`;
  const { tenant, database, sample, newProject } = await fixture(ws);
  let who = user("u_mate");
  const R = <T,>(file: string) => loadRoute<T>(file, () => who);
  const cast = R<typeof import("../../app/api/cast/route")>("app/api/cast/route.ts");
  const castId = R<typeof import("../../app/api/cast/[id]/route")>("app/api/cast/[id]/route.ts");
  const treatment = R<typeof import("../../app/api/atomik/treatment/route")>("app/api/atomik/treatment/route.ts");
  const cards = R<typeof import("../../app/api/canvas/route")>("app/api/canvas/route.ts");
  const card = R<typeof import("../../app/api/canvas/[id]/route")>("app/api/canvas/[id]/route.ts");
  const elements = R<typeof import("../../app/api/rig/elements/route")>("app/api/rig/elements/route.ts");
  const element = R<typeof import("../../app/api/rig/elements/[id]/route")>("app/api/rig/elements/[id]/route.ts");
  const bindings = R<typeof import("../../app/api/rig/bindings/[id]/route")>("app/api/rig/bindings/[id]/route.ts");
  const current = R<typeof import("../../app/api/rig/attributes/[id]/current/route")>("app/api/rig/attributes/[id]/current/route.ts");
  const boards = R<typeof import("../../app/api/rig/boards/route")>("app/api/rig/boards/route.ts");
  const board = R<typeof import("../../app/api/rig/boards/[id]/route")>("app/api/rig/boards/[id]/route.ts");
  const notes = R<typeof import("../../app/api/notes/route")>("app/api/notes/route.ts");
  const productions = R<typeof import("../../app/api/productions/[id]/route")>("app/api/productions/[id]/route.ts");
  const reorder = R<typeof import("../../app/api/shots/reorder/route")>("app/api/shots/reorder/route.ts");
  const sync = R<typeof import("../../app/api/shots/sync/route")>("app/api/shots/sync/route.ts");
  const studio = R<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts");
  const jobs = R<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts");
  const shot = R<typeof import("../../app/api/shots/[id]/route")>("app/api/shots/[id]/route.ts");
  const demo = R<typeof import("../../app/api/demo/sample/route")>("app/api/demo/sample/route.ts");
  const recipe = R<typeof import("../../app/api/rig/recipe/[id]/route")>("app/api/rig/recipe/[id]/route.ts");
  const runsRoute = R<typeof import("../../app/api/rig/runs/route")>("app/api/rig/runs/route.ts");
  const runState = R<typeof import("../../app/api/rig/runs/[id]/state/route")>("app/api/rig/runs/[id]/state/route.ts");
  const runFix = R<typeof import("../../app/api/rig/runs/[id]/fix/route")>("app/api/rig/runs/[id]/fix/route.ts");
  const teamCanvas = R<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts");
  const { unlinkProjectLibraryUpload, ProjectLibraryError } = await import("../../lib/workbench/project-library");
  const { sampleDraftRefusal } = await import("../../lib/demo/readonly.server");
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    await db.execute({ sql: "INSERT INTO cast_members(id,project_id,name,created_at) VALUES(?,?,?,1)", args: [`cast_s_${run}`, sample, "SampleCast"] });
    await db.execute({ sql: "INSERT INTO canvas_items(id,project_id,kind,text,created_at,updated_at) VALUES(?,?,'note','hi',1,1)", args: [`cv_s_${run}`, sample] });
    await db.execute({ sql: "INSERT INTO boards(id,project_id,name,created_at,updated_at) VALUES(?,?,'Board',1,1)", args: [`bd_s_${run}`, sample] });
    await db.execute({ sql: "INSERT INTO elements(id,project_id,kind,name,created_at,updated_at) VALUES(?,?,'character','Lead',1,1)", args: [`el_s_${run}`, sample] });
    await db.execute({ sql: "INSERT INTO element_attributes(id,element_id,kind,created_at,updated_at) VALUES(?,?,'face',1,1)", args: [`at_s_${run}`, `el_s_${run}`] });
    await db.execute({ sql: "INSERT INTO runs(id,recipe_id,project_id,started_at,updated_at) VALUES(?,?,?,1,1)", args: [`run_s_${run}`, "rcp", sample] });
    /* The lifter's run on the sample: asked by the owner. */
    const { rigAgentReady, insertRun } = await import("../../lib/workbench/rig-agent-store");
    await rigAgentReady();
    await insertRun(db as never, { id: agentRun, productionId: sample, draftId: "d1", owner: "u_owner", requestId: "req1", goal: "The dunes", model: "auto", at: 1, limit: { credits: 50, mode: "ask", jobCeiling: 200 } });
  }, { user: user("u_owner", "admin") });
  const code = async (res: Response) => [res.status, (await res.clone().json().catch(() => ({}))).code] as const;
  const VIEW = [403, "view_only"] as const;
  for (const [label, id, role] of VIEWERS) {
    who = user(id, role);
    await tenant.runInTenant(ws, async () => {
      const opened = await (await demo.POST(json("POST", { action: "open" }), undefined as never)).json();
      const copy = opened.project as { id: string; productionProjectId?: string };
      const original = { ...newProject("d1"), id: "d1", productionProjectId: sample };
      /* Legacy and Rig rows that sit in the sample. */
      expect(await code(await castId.PATCH(json("PATCH", { description: "x" }), ctx(`cast_s_${run}`))), `${label}: cast PATCH`).toEqual(VIEW);
      expect(await code(await castId.DELETE(new Request("https://particl.test/x", { method: "DELETE" }), ctx(`cast_s_${run}`))), `${label}: cast DELETE`).toEqual(VIEW);
      expect((await cast.POST(json("POST", { projectId: sample, name: `New${id}` }), undefined as never)).status, `${label}: cast POST`).toBe(404);
      expect((await treatment.PUT(json("PUT", { projectId: sample, title: "Hijack", scenes: [], notes: [] }), undefined as never)).status, `${label}: treatment PUT`).toBe(404);
      expect(await code(await cards.POST(json("POST", { projectId: sample, kind: "note", text: "x" }), undefined as never)), `${label}: card POST`).toEqual(VIEW);
      expect(await code(await card.PATCH(json("PATCH", { x: 5 }), ctx(`cv_s_${run}`))), `${label}: card PATCH`).toEqual(VIEW);
      expect(await code(await card.DELETE(new Request("https://particl.test/x", { method: "DELETE" }), ctx(`cv_s_${run}`))), `${label}: card DELETE`).toEqual(VIEW);
      expect(await code(await elements.POST(json("POST", { projectId: sample, name: `El${id}` }), undefined as never)), `${label}: asset POST`).toEqual(VIEW);
      expect(await code(await element.PUT(json("PUT", { locked: true }), ctx(`el_s_${run}`))), `${label}: asset lock`).toEqual(VIEW);
      expect(await code(await bindings.PUT(json("PUT", { changes: [] }), ctx(`shot_s_${run}`))), `${label}: wires`).toEqual(VIEW);
      expect(await code(await current.POST(json("POST", { versionId: "v" }), ctx(`at_s_${run}`))), `${label}: current version`).toEqual(VIEW);
      expect(await code(await boards.POST(json("POST", { projectId: sample, name: "B" }), undefined as never)), `${label}: board POST`).toEqual(VIEW);
      expect(await code(await board.PUT(json("PUT", { name: "Hijack", nodes: [], wires: [] }), ctx(`bd_s_${run}`))), `${label}: board PUT`).toEqual(VIEW);
      expect(await code(await notes.POST(json("POST", { genId: `gen_s_${run}`, text: "a note" }), undefined as never)), `${label}: note on a take`).toEqual(VIEW);
      expect(await code(await productions.PATCH(json("PATCH", { name: "Hijack" }), ctx("prod_g"))), `${label}: the production's name`).toEqual(VIEW);
      expect(await code(await reorder.POST(json("POST", { projectId: sample, ids: [`shot_s_${run}`] }), undefined as never)), `${label}: reorder`).toEqual(VIEW);
      expect(await code(await sync.POST(json("POST", { projectId: sample }), undefined as never)), `${label}: sync`).toEqual(VIEW);
      expect(await code(await jobs.DELETE(new Request("https://particl.test/x", { method: "DELETE" }), ctx(`gen_s_${run}`))), `${label}: a take's deletion`).toEqual(VIEW);
      /* Recipes, pipeline runs and the board agent's run: the sample takes none, and only a run's own person presses it (for a lift run, the lifter). */
      expect(await code(await recipe.POST(json("POST", { name: "R" }), ctx(sample))), `${label}: a recipe`).toEqual(VIEW);
      expect(await code(await runsRoute.POST(json("POST", { projectId: sample }), undefined as never)), `${label}: a pipeline run`).toEqual(VIEW);
      expect(await code(await runState.POST(json("POST", { state: "paused" }), ctx(`run_s_${run}`))), `${label}: a run's state`).toEqual(VIEW);
      expect(await code(await runFix.POST(json("POST", { stageId: "s", fixId: "f" }), ctx(`run_s_${run}`))), `${label}: a run's fix`).toEqual(VIEW);
      /* Undo is refused for everyone, the run's own person included, before anything is stopped; the run's own person may stop their run, anyone else may not. */
      const agentState = async () => String((await database.db().execute({ sql: "SELECT state FROM rig_agent_runs WHERE id=?", args: [agentRun] })).rows[0].state);
      const canvasBody = async () => String((await database.db().execute({ sql: "SELECT body FROM workbench_team_canvas WHERE production_id=?", args: [sample] })).rows[0].body);
      const beforeState = await agentState(), beforeCanvas = await canvasBody();
      expect(await code(await teamCanvas.POST(json("POST", { action: "agent.undo", productionId: sample, runId: agentRun }), undefined as never)), `${label}: undo`).toEqual(VIEW);
      expect(await agentState(), `${label}: an undo attempt did not stop the run`).toBe(beforeState);
      expect(await canvasBody(), `${label}: nor touch the canvas`).toBe(beforeCanvas);
      const stopped = await teamCanvas.POST(json("POST", { action: "agent.stop", productionId: sample, runId: agentRun }), undefined as never);
      if (id === "u_owner") {
        expect(await code(stopped), `${label}: their own run's stop`).not.toEqual(VIEW);
        expect(stopped.status, `${label}: their own stop works`).toBe(200);
      } else {
        expect(await code(stopped), `${label}: another's run stop`).toEqual(VIEW);
      }
      /* Sharing, publishing and mapping from the sample's copy and from the board it was marked from. */
      expect(await sampleDraftRefusal(id, copy), `${label}: a copy`).not.toBeNull();
      expect(await sampleDraftRefusal(id, original), `${label}: the original`).not.toBeNull();
      expect(await sampleDraftRefusal(id, newProject(`own-${id}`)), `${label}: their own board is not asked`).toBeNull();
      for (const action of [{ action: "team-share", shared: true }, { action: "map-shot", nodeId: "n" }, { action: "publish", expectedBibleVersion: 0 }])
        expect(await code(await studio.POST(json("POST", { projectId: copy.id, ...action }), undefined as never)), `${label}: ${action.action} on their copy`).toEqual(VIEW);
      await expect(unlinkProjectLibraryUpload(id, copy.id, "upl_x"), `${label}: a library unlink`).rejects.toBeInstanceOf(ProjectLibraryError);
      /* The order: a shot id that is not there is answered as unknown; a sample shot says view only before anything else. */
      expect((await shot.PATCH(json("PATCH", { title: "x" }), ctx("shot_nope"))).status).toBe(404);
      expect(await code(await shot.DELETE(new Request("https://particl.test/x", { method: "DELETE" }), ctx(`shot_s_${run}`))), `${label}: a sample shot is never a silent ok`).toEqual(VIEW);
    }, { user: who });
  }
  /* Nothing was written into the sample. */
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    const n = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args: args as never })).rows[0].n);
    expect(await n("SELECT COUNT(*) AS n FROM cast_members WHERE project_id=?", [sample])).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM canvas_items WHERE project_id=?", [sample])).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM boards WHERE project_id=?", [sample])).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM elements WHERE project_id=?", [sample])).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM notes")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM recipes WHERE project_id=?", [sample])).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM runs WHERE project_id=?", [sample])).toBe(1);
    expect((await db.execute({ sql: "SELECT state FROM runs WHERE id=?", args: [`run_s_${run}`] })).rows[0].state).toBe("running");
    expect(await n("SELECT COUNT(*) AS n FROM treatments WHERE project_id=?", [sample])).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM shots WHERE project_id=?", [sample])).toBe(1);
    expect((await db.execute({ sql: "SELECT name FROM productions WHERE id='prod_g'", args: [] })).rows[0].name).toBe("Group");
    expect((await db.execute({ sql: "SELECT locked FROM elements WHERE id=?", args: [`el_s_${run}`] })).rows[0].locked).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM generations WHERE id=? AND deleted=0", [`gen_s_${run}`])).toBe(1);
  }, { user: user("u_owner", "admin") });
});

test("a lift lets the RUN write the sample (it writes as an agent), not the person who lifted it: their own presses and edits still answer view-only", async () => {
  const ws = workspace(`sro-c-${run}`);
  const { tenant, sample } = await fixture(ws);
  const { requireProduction } = await import("../../lib/workbench/team-canvas");
  const { liftSampleMark } = await import("../../lib/demo/mark.server");
  const { sampleWriteRefusal } = await import("../../lib/demo/readonly.server");
  await tenant.runInTenant(ws, async () => {
    await liftSampleMark({ ...user("u_owner", "admin"), owner: true } as never);
    /* The run: an agent, or no person at all. */
    await expect(requireProduction(sample, "agent:rar_run1", "write")).resolves.toBeUndefined();
    await expect(requireProduction(sample, null, "write")).resolves.toBeUndefined();
    expect(await sampleWriteRefusal(sample, null)).toBeNull();
    /* The lifter's own hands: a canvas edit, a saved shot, a filing, and the board agent's presses (they ask to READ it). */
    await expect(requireProduction(sample, "u_owner", "write")).rejects.toThrow(/not in this workspace/);
    expect((await sampleWriteRefusal(sample, { id: "u_owner" }))?.status).toBe(403);
    await expect(requireProduction(sample, "u_owner", "read")).resolves.toBeUndefined();
  }, { user: user("u_owner", "admin") });
});

test("the sample's owner (the person it was marked from) and the platform owner write it as their own board; a member, an admin and the workspace owner stay refused", async () => {
  const ws = workspace(`sro-d-${run}`);
  const { tenant, database, sample, newProject } = await fixture(ws);
  /* The platform owner is named by the deployment (isPlatformOwner, lib/auth.ts): the configured address. */
  const previous = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = "u_platform@example.test";
  try {
  let who = user("u_mate");
  const R = <T,>(file: string) => loadRoute<T>(file, () => who);
  const canvas = R<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts");
  const studio = R<typeof import("../../app/api/workbench/projects/route")>("app/api/workbench/projects/route.ts");
  const shots = R<typeof import("../../app/api/shots/route")>("app/api/shots/route.ts");
  const shot = R<typeof import("../../app/api/shots/[id]/route")>("app/api/shots/[id]/route.ts");
  const jobs = R<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts");
  const cast = R<typeof import("../../app/api/cast/route")>("app/api/cast/route.ts");
  const cards = R<typeof import("../../app/api/canvas/route")>("app/api/canvas/route.ts");
  const productions = R<typeof import("../../app/api/productions/[id]/route")>("app/api/productions/[id]/route.ts");
  const reorder = R<typeof import("../../app/api/shots/reorder/route")>("app/api/shots/reorder/route.ts");
  const demo = R<typeof import("../../app/api/demo/sample/route")>("app/api/demo/sample/route.ts");
  const { requireProduction } = await import("../../lib/workbench/team-canvas");
  const { linkProjectLibraryUpload, unlinkProjectLibraryUpload } = await import("../../lib/workbench/project-library");
  const { sampleDraftRefusal, sampleRunRefusal } = await import("../../lib/demo/readonly.server");
  const status = (res: Response) => res.status;
  await tenant.runInTenant(ws, async () => {
    const db = database.db();
    await db.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind) VALUES('upl_e','a.png','image/png','png',1,'x','',1,'image')", args: [] });
  }, { user: user("u_owner", "admin") });
  const EDITORS = [["the sample's owner (the marker)", "u_marker"], ["the platform owner", "u_platform"]] as const;
  for (const [label, id] of EDITORS) {
    who = user(id, id === "u_platform" ? "admin" : "member");
    await tenant.runInTenant(ws, async () => {
      const opened = await (await demo.POST(json("POST", { action: "open" }), undefined as never)).json();
      expect(opened.viewOnly, `${label}: the sample opens editable`).toBeUndefined();
      await expect(requireProduction(sample, undefined, "write"), `${label}: canvas write`).resolves.toBeUndefined();
      expect(await sampleDraftRefusal(id, { id: opened.project.id, productionProjectId: sample }), `${label}: their copy`).toBeNull();
      expect(await sampleDraftRefusal(id, { ...newProject("d1"), id: "d1", productionProjectId: sample }), `${label}: the original`).toBeNull();
      const save = await studio.PUT(json("PUT", { project: { ...opened.project, name: `Edited ${id}` }, revision: opened.revision }), undefined as never);
      expect(save.status, `${label}: a save of their copy: ${JSON.stringify(await save.clone().json())}`).toBe(200);
      const made = await shots.POST(json("POST", { projectId: sample, code: `SH${id === "u_marker" ? 71 : 72}`, title: "Added" }), undefined as never);
      expect(made.status, `${label}: a shot into the sample`).toBe(200);
      const newShot = (await made.json()).shot.id as string;
      expect(status(await shot.PATCH(json("PATCH", { title: "Renamed" }), ctx(newShot))), `${label}: a shot's edit`).toBe(200);
      expect(status(await jobs.PATCH(json("PATCH", { title: "Renamed take" }), ctx(`gen_s_${run}`))), `${label}: a take's rename`).toBe(200);
      expect(status(await cast.POST(json("POST", { projectId: sample, name: `Cast${id}` }), undefined as never)), `${label}: cast`).toBe(200);
      expect(status(await cards.POST(json("POST", { projectId: sample, kind: "note", text: "x" }), undefined as never)), `${label}: a card`).toBe(200);
      expect(status(await productions.PATCH(json("PATCH", { name: `Group ${id}` }), ctx("prod_g"))), `${label}: the production's name`).toBe(200);
      expect(status(await reorder.POST(json("POST", { projectId: sample, ids: [`shot_s_${run}`, newShot] }), undefined as never)), `${label}: reorder`).toBe(200);
      await expect(linkProjectLibraryUpload(id, opened.project.id, "upl_e"), `${label}: a library filing`).resolves.toBeUndefined();
      await expect(unlinkProjectLibraryUpload(id, opened.project.id, "upl_e"), `${label}: a library removal`).resolves.toBeUndefined();
      /* A run on the sample is theirs to stop or undo, whoever asked for it. */
      expect(await sampleRunRefusal(sample, `rar_${"b".repeat(24)}`, { id }), `${label}: a run`).toBeNull();
      const undo = await canvas.POST(json("POST", { action: "agent.undo", productionId: sample, runId: `rar_${"b".repeat(24)}` }), undefined as never);
      expect((await undo.clone().json().catch(() => ({}))).code, `${label}: undo is not refused as view-only`).not.toBe("view_only");
      const patch = await canvas.PATCH(json("PATCH", { productionId: sample, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }), undefined as never);
      expect(patch.status, `${label}: canvas PATCH`).toBe(200);
    }, { user: user(id, id === "u_platform" ? "admin" : "member") });
  }
  /* A member, an admin and the workspace's owner are still refused (the first test holds the whole list). */
  for (const [label, id, role] of VIEWERS) {
    who = user(id, role);
    await tenant.runInTenant(ws, async () => {
      await expect(requireProduction(sample, undefined, "write"), `${label}: canvas write`).rejects.toThrow(/not in this workspace/);
      const made = await shots.POST(json("POST", { projectId: sample, code: "SH99", title: "Hijack" }), undefined as never);
      expect(made.status, `${label}: a shot`).toBe(403);
    }, { user: user(id, role) });
  }
  } finally {
    /* The next spec in this worker must not inherit a platform owner. */
    if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = previous;
  }
});
