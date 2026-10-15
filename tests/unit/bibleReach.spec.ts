import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A private board's published bible and the presets tied to it are read only by people who can read that board (owner, 15 Oct 2026: "NARROW them ... readable only by people who can
 * read that board (same rule as private takes and #745). Workspace-level presets not tied to a board stay readable by all members"). Readers: the upload rule (lib/uploadAccess.ts),
 * GET and POST /api/pipelines, the published asset a bible shares (lib/workbench/media-records.ts). The rule is `mayReachProject(..., "read")` / `projectLister`: no admin elevation
 * (the audited admin read is #715's, not on this branch), so an admin reads nothing of a member's private board here. Real temporary databases; nothing is sent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-bible-reach-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
const A = user("u_a"), B = user("u_b"), ADMIN = user("u_admin", "admin");

function loadRoute<T>(file: string, who: () => ReturnType<typeof user>): T {
  const root = process.cwd(), real = createRequire(path.resolve(file));
  const session = async () => ({ user: who() });
  const fakes: Record<string, unknown> = { "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: session, requireSession: session, requireRender: session }, "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null } };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((n: string) => (Object.hasOwn(fakes, n) ? fakes[n] : n.startsWith("@/") ? real(path.join(root, n.slice(2))) : real(n)), mod, mod.exports);
  return mod.exports as T;
}

const UPLOADS = ["up_bible_priv", "up_bible_shared", "up_preset_priv_cover", "up_preset_priv_refs", "up_preset_shared_cover", "up_preset_shared_refs", "up_preset_ws_cover", "up_preset_ws_refs", "up_chat"];
async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const board = (id: string) => draft.mappedId("prj_wb_", ws.id, "u_a", id);
  const boards = { priv: board("d1"), shared: board("d2") };
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const u of ["u_a", "u_b", "u_admin"]) await db.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,0)", args: [u, `${u}@example.test`, u, u === "u_admin" ? "admin" : "member"] });
    for (const [id, name] of [[boards.priv, "A private board"], [boards.shared, "A shared board"], ["prod_open", "Open production"]]) await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, name] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_a:d1','u_a','d1','d1',?,1,0)", args: [JSON.stringify({ productionProjectId: boards.priv })] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_a:d2','u_a','d2','d2',?,1,0)", args: [JSON.stringify({ productionProjectId: boards.shared, teamShared: true })] });
    for (const id of UPLOADS) await db.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,uploader_id) VALUES(?,?,'image/png','png',1,'x','/x',0,'u_a')", args: [id, `${id}.png`] });
    const bible = (project: string, brief: string, upload: string) => db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,1,'u_a',?,0)", args: [project, JSON.stringify({ brief, assets: [{ id: "a1", name: "asset", kind: "image", uploadId: upload }] })] });
    await bible(boards.priv, `PRIVATE-BRIEF-${run}`, "up_bible_priv"); await bible(boards.shared, `SHARED-BRIEF-${run}`, "up_bible_shared"); await bible("prod_open", `OPEN-BRIEF-${run}`, "up_chat");
    const preset = (id: string, project: string | null, cover: string, ref: string) => db.execute({ sql: "INSERT INTO shot_presets(id,project_id,name,created_at,cover_upload_id,refs) VALUES(?,?,?,0,?,?)", args: [id, project, id, cover, JSON.stringify([{ uploadId: ref }])] });
    await preset("p_priv", boards.priv, "up_preset_priv_cover", "up_preset_priv_refs"); await preset("p_shared", boards.shared, "up_preset_shared_cover", "up_preset_shared_refs"); await preset("p_ws", null, "up_preset_ws_cover", "up_preset_ws_refs");
    await db.execute({ sql: "INSERT INTO messages(id,user_id,text,upload_id,created_at) VALUES('m1','u_a','hi','up_chat',0)", args: [] });
    /* A published asset of each board's bible, in the tenant's workbench media. */
    for (const [id, project] of [["wm_priv", boards.priv], ["wm_shared", boards.shared]] as const) {
      await db.execute({ sql: "INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES(?,'u_a','m','image/png','png',1,'/x','x')", args: [id] });
      await db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,2,'u_a',?,0)", args: [project, JSON.stringify({ assets: [{ url: `/api/workbench/media/${id}` }] })] });
    }
  }, { user: A });
  return { tenant, boards };
}
const open = async (tenant: typeof import("../../lib/tenant"), ws: TenantWorkspace, who: ReturnType<typeof user>, id: string) => {
  const { uploadOpenableBy } = await import("../../lib/uploadAccess");
  return tenant.runInTenant(ws, () => uploadOpenableBy(id, { id: who.id, role: who.role }), { user: who });
};

test("uploads: only people who can read a private board open an upload only its bible or presets use; a shared board's, a workspace-wide preset's and team chat's open for a teammate", async () => {
  const ws = workspace(`br-a-${run}`);
  const { tenant } = await fixture(ws);
  const gated = ["up_bible_priv", "up_preset_priv_cover", "up_preset_priv_refs"], open_ = ["up_bible_shared", "up_preset_shared_cover", "up_preset_shared_refs", "up_preset_ws_cover", "up_preset_ws_refs", "up_chat"];
  for (const id of UPLOADS) expect(await open(tenant, ws, A, id), `the uploader opens ${id}`).toBe(true);
  for (const id of gated) { expect(await open(tenant, ws, B, id), `a teammate without access: ${id}`).toBe(false); expect(await open(tenant, ws, ADMIN, id), `an admin, no audited path here: ${id}`).toBe(false); }
  for (const id of open_) { expect(await open(tenant, ws, B, id), `a teammate: ${id}`).toBe(true); expect(await open(tenant, ws, ADMIN, id), `an admin: ${id}`).toBe(true); }
});

test("uploads: once the board is shared, a teammate opens what its bible and presets use", async () => {
  const ws = workspace(`br-b-${run}`);
  const { tenant } = await fixture(ws);
  expect(await open(tenant, ws, B, "up_bible_priv")).toBe(false);
  const database = await import("../../lib/db");
  await tenant.runInTenant(ws, () => database.db().execute("UPDATE workbench_projects SET body=json_set(body,'$.teamShared',json('true')) WHERE key='u_a:d1'"), { user: A });
  for (const id of ["up_bible_priv", "up_preset_priv_cover", "up_preset_priv_refs"]) expect(await open(tenant, ws, B, id), id).toBe(true);
});

test("GET /api/pipelines lists a private board's published bible only to people who can read the board", async () => {
  const ws = workspace(`br-c-${run}`);
  const { tenant, boards } = await fixture(ws);
  let who = A;
  const route = loadRoute<{ GET: (r: Request) => Promise<Response> }>("app/api/pipelines/route.ts", () => who);
  const read = async (reader: ReturnType<typeof user>, query = "") => { who = reader; return tenant.runInTenant(ws, async () => { const res = await route.GET(new Request(`https://p.test/api/pipelines${query}`)); return { status: res.status, text: await res.text() }; }, { user: reader }); };
  const mine = await read(A);
  expect(mine.text).toContain(`PRIVATE-BRIEF-${run}`);
  for (const reader of [B, ADMIN]) {
    const got = await read(reader);
    expect(got.status, reader.id).toBe(200);
    expect(got.text, `${reader.id}: no private board's name or brief`).not.toMatch(/PRIVATE-BRIEF|A private board/);
    expect(got.text, `${reader.id}: the shared board's and an ordinary production's are listed`).toContain(`SHARED-BRIEF-${run}`);
    expect(got.text).toContain(`OPEN-BRIEF-${run}`);
    expect((await read(reader, `?projectId=${boards.priv}`)).text, `${reader.id}: asked for by id`).not.toContain(`PRIVATE-BRIEF`);
  }
});

test("POST /api/pipelines: a pipeline cannot be built on another member's private board's published version; the board's owner is not stopped by it", async () => {
  const ws = workspace(`br-d-${run}`);
  const { tenant, boards } = await fixture(ws);
  let who = B;
  const route = loadRoute<{ POST: (r: Request) => Promise<Response> }>("app/api/pipelines/route.ts", () => who);
  const post = async (reader: ReturnType<typeof user>) => { who = reader; return tenant.runInTenant(ws, async () => { const res = await route.POST(new Request("https://p.test/api/pipelines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: { context: { projectId: boards.priv, bibleVersion: 1 } }, expectedVersion: 0 }) })); return { status: res.status, text: await res.text() }; }, { user: reader }); };
  for (const reader of [B, ADMIN]) { const got = await post(reader); expect(got.status, reader.id).toBe(409); expect(got.text, reader.id).toContain("Publish the intended production context first"); }
  expect((await post(A)).text, "the owner is past that gate").not.toContain("Publish the intended production context first");
});

test("a published asset of a private board's bible is served to people who can read the board only", async () => {
  const ws = workspace(`br-e-${run}`);
  const { tenant } = await fixture(ws);
  const { findWorkbenchMedia } = await import("../../lib/workbench/media-records");
  const find = (id: string, who: ReturnType<typeof user>) => tenant.runInTenant(ws, () => findWorkbenchMedia(id, who.id), { user: who });
  expect(await find("wm_priv", A)).toBeTruthy();
  expect(await find("wm_priv", B)).toBeFalsy();
  expect(await find("wm_priv", ADMIN)).toBeFalsy();
  expect(await find("wm_shared", B), "a shared board's published asset").toBeTruthy();
});

test("another workspace reads nothing of this one", async () => {
  const ws = workspace(`br-f-${run}`), other = workspace(`br-f2-${run}`);
  const { tenant } = await fixture(ws);
  const database = await import("../../lib/db");
  await tenant.runInTenant(other, async () => { await database.ready(); }, { user: B });
  for (const id of UPLOADS) expect(await open(tenant, other, B, id), id).toBe(false);
  const { findWorkbenchMedia } = await import("../../lib/workbench/media-records");
  expect(await tenant.runInTenant(other, () => findWorkbenchMedia("wm_shared", "u_b"), { user: B })).toBeFalsy();
});
