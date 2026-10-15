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
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject"), draft_ = draft;
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const board = (id: string) => draft.mappedId("prj_wb_", ws.id, "u_a", id);
  const boards = { priv: board("d1"), shared: board("d2"), sample: draft_.mappedId("prj_wb_", ws.id, "u_marker", "d3") };
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const u of ["u_a", "u_b", "u_admin", "u_marker", "u_root"]) await db.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,0)", args: [u, `${u}@example.test`, u, u === "u_admin" ? "admin" : "member"] });
    for (const [id, name] of [[boards.priv, "A private board"], [boards.shared, "A shared board"], ["prod_open", "Open production"]]) await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, name] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_a:d1','u_a','d1','d1',?,1,0)", args: [JSON.stringify({ productionProjectId: boards.priv })] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_a:d2','u_a','d2','d2',?,1,0)", args: [JSON.stringify({ productionProjectId: boards.shared, teamShared: true })] });
    for (const id of UPLOADS) await db.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,uploader_id) VALUES(?,?,'image/png','png',1,'x','/x',0,'u_a')", args: [id, `${id}.png`] });
    const bible = (project: string, brief: string, upload: string) => db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,1,'u_a',?,0)", args: [project, JSON.stringify({ brief, assets: [{ id: "a1", name: "asset", kind: "image", uploadId: upload }] })] });
    await bible(boards.priv, `PRIVATE-BRIEF-${run}`, "up_bible_priv"); await bible(boards.shared, `SHARED-BRIEF-${run}`, "up_bible_shared"); await bible("prod_open", `OPEN-BRIEF-${run}`, "up_chat");
    const preset = (id: string, project: string | null, cover: string, ref: string) => db.execute({ sql: "INSERT INTO shot_presets(id,project_id,name,created_at,cover_upload_id,refs) VALUES(?,?,?,0,?,?)", args: [id, project, id, cover, JSON.stringify([{ uploadId: ref }])] });
    await preset("p_priv", boards.priv, "up_preset_priv_cover", "up_preset_priv_refs"); await preset("p_shared", boards.shared, "up_preset_shared_cover", "up_preset_shared_refs"); await preset("p_ws", null, "up_preset_ws_cover", "up_preset_ws_refs");
    await db.execute({ sql: "INSERT INTO messages(id,user_id,text,upload_id,created_at) VALUES('m1','u_a','hi','up_chat',0)", args: [] });
    /* The marked sample (another person's board, shown to everyone): its bible, a preset and an upload only they use. */
    const sample = draft_.mappedId("prj_wb_", ws.id, "u_marker", "d3");
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,'Sample board',0)", args: [sample] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_marker:d3','u_marker','d3','d3',?,1,0)", args: [JSON.stringify({ ...newProject("d3"), id: "d3", productionProjectId: sample })] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_root:dr','u_root','dr','dr',?,1,0)", args: [JSON.stringify({ ...newProject("dr"), id: "dr", productionProjectId: sample })] });
    await db.execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES('sampleProduction',?,'u_admin',0)", args: [JSON.stringify({ version: 1, projectId: sample, name: "Sample board", draftOwner: "u_marker", draftId: "d3", markedBy: "u_admin", markedAt: 0 })] });
    await db.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,uploader_id) VALUES('up_sample','up_sample.png','image/png','png',1,'x','/x',0,'u_marker')", args: [] });
    await db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,1,'u_marker',?,0)", args: [sample, JSON.stringify({ brief: `SAMPLE-BRIEF-${run}`, assets: [{ id: "a1", name: "asset", kind: "image", uploadId: "up_sample" }, { url: "/api/workbench/media/wm_sample" }] })] });
    await db.execute({ sql: "INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES('wm_sample','u_marker','m','image/png','png',1,'/x','x')", args: [] });
    /* Drafts of the teammate's that link each board (as an opened link does), and a draft of A's own that links the private board. */
    for (const [id, project] of [["db1", boards.priv], ["db2", boards.shared], ["db3", sample]] as const)
      await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,'u_b',?,?,?,1,0)", args: [`u_b:${id}`, id, id, JSON.stringify({ ...newProject(id), id, productionProjectId: project })] });
    /* A published asset of each board's bible, in the tenant's workbench media. */
    for (const [id, project] of [["wm_priv", boards.priv], ["wm_shared", boards.shared]] as const) {
      await db.execute({ sql: "INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES(?,'u_a','m','image/png','png',1,'/x','x')", args: [id] });
      await db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,2,'u_a',?,0)", args: [project, JSON.stringify({ assets: [{ url: `/api/workbench/media/${id}`, uploadId: id === "wm_priv" ? "up_bible_priv" : "up_bible_shared" }] })] });
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

/* ── Follow-up: why a file is unavailable, and the #753 review nits ──────────────────────────────────────────────────────────────── */
test("a file from a private board someone cannot read says why, in one sentence with no board name, id or owner; other refusals stay what they were", async () => {
  const ws = workspace(`br-g-${run}`);
  const { tenant, boards } = await fixture(ws);
  const { PRIVATE_MEDIA, privateMediaMessage } = await import("../../lib/workbench/media-records");
  expect(PRIVATE_MEDIA).toBe("This uses media from a private board. Ask its owner to share it.");
  const why = (id: string, who: ReturnType<typeof user>) => tenant.runInTenant(ws, () => privateMediaMessage(id, who.id), { user: who });
  expect(await why("wm_priv", B)).toBe(PRIVATE_MEDIA);
  expect(await why("wm_priv", ADMIN), "no admin elevation here").toBe(PRIVATE_MEDIA);
  expect(await why("wm_priv", A), "the owner reads it").toBeNull();
  expect(await why("wm_shared", B), "a shared board's file opens").toBeNull();
  expect(await why("wm_missing", B), "no such file: still not found").toBeNull();
  /* The media route says nothing more than for an unknown file (a refused item looks exactly like one that is not there). */
  const who = B;
  const media = loadRoute<{ GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }>("app/api/workbench/media/[id]/route.ts", () => who);
  const get = (id: string) => tenant.runInTenant(ws, async () => { const res = await media.GET(new Request(`https://p.test/api/workbench/media/${id}`), { params: Promise.resolve({ id }) }); return { status: res.status, text: await res.text() }; }, { user: B });
  const refused = await get("wm_priv");
  expect(refused).toEqual({ status: 404, text: "Not found" });
  expect(await get("wm_missing")).toEqual(refused);
  /* The 3D render inputs, where the person's own project names the file, say why: one sentence, no board name, id or owner. */
  const { loadAstraRenderInputs } = await import("../../lib/astra-blender/render-storage");
  const asset = (id: string) => ({ id: "a1", name: "m", kind: "image", url: `/api/workbench/media/${id}` }) as never;
  const thrown = await tenant.runInTenant(ws, () => loadAstraRenderInputs([asset("wm_priv")], "u_b"), { user: B }).then(() => "", (e: Error) => e.message);
  for (const word of [boards.priv, "A private board", "u_a", "d1"]) expect(thrown, word).not.toContain(word);
  await expect(tenant.runInTenant(ws, () => loadAstraRenderInputs([asset("wm_priv")], "u_b"), { user: B })).rejects.toThrow(new RegExp(`^${PRIVATE_MEDIA.replace(/[.]/g, "\\.")}$`));
  await expect(tenant.runInTenant(ws, () => loadAstraRenderInputs([asset("wm_missing")], "u_b"), { user: B })).rejects.toThrow("A source file is unavailable or too large.");
});

test("GET /api/pipelines filters in SQL (the 100 are the readable ones) and the marked sample's bible stays listed for everyone", async () => {
  const ws = workspace(`br-h-${run}`);
  const { tenant } = await fixture(ws);
  const database = await import("../../lib/db");
  /* More than a hundred private bibles of A's newer than everything else: a filter after the limit would show B nothing. */
  await tenant.runInTenant(ws, async () => {
    const db = database.db(), draft = await import("../../lib/draftProject");
    for (let i = 0; i < 120; i++) {
      const id = draft.mappedId("prj_wb_", ws.id, "u_a", `many${i}`);
      await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, `Many ${i}`] });
      await db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,1,'u_a',?,5000)", args: [id, JSON.stringify({ brief: `MANY-${i}` })] });
    }
  }, { user: A });
  const who = B;
  const route = loadRoute<{ GET: (r: Request) => Promise<Response> }>("app/api/pipelines/route.ts", () => who);
  const text = await tenant.runInTenant(ws, async () => (await route.GET(new Request("https://p.test/api/pipelines"))).text(), { user: B });
  expect(text).not.toMatch(/MANY-|PRIVATE-BRIEF/);
  for (const brief of ["SHARED-BRIEF", "OPEN-BRIEF", "SAMPLE-BRIEF"]) expect(text, brief).toContain(`${brief}-${run}`);
});

test("the draft read and the project library take a linked board's bible only for people who can read it, and the sample's bible stays readable", async () => {
  const ws = workspace(`br-i-${run}`);
  const { tenant } = await fixture(ws);
  let who = B;
  const projects = loadRoute<{ GET: (r: Request) => Promise<Response> }>("app/api/workbench/projects/route.ts", () => who);
  const shared = async (reader: ReturnType<typeof user>, draftId: string) => { who = reader; return tenant.runInTenant(ws, async () => { const res = await projects.GET(new Request(`https://p.test/api/workbench/projects?id=${draftId}`)); return { status: res.status, body: await res.json() as { shared?: { brief?: string; version?: number } | null } }; }, { user: reader }); };
  /* B's drafts link A's private board, A's shared board and the sample. */
  expect((await shared(B, "db1")).body.shared ?? null, "a link to a private board B cannot read reads no bible").toBeNull();
  expect(JSON.stringify((await shared(B, "db2")).body.shared), "the shared board's latest published version").toContain("/api/workbench/media/wm_shared");
  expect((await shared(B, "db3")).body.shared?.brief, "the sample's bible").toBe(`SAMPLE-BRIEF-${run}`);
  /* The project library counts the linked board's published uploads as in use only for someone who can read it. */
  const { resolveProjectLibrary } = await import("../../lib/workbench/project-library");
  const used = async (draftId: string) => (await tenant.runInTenant(ws, () => resolveProjectLibrary("u_b", draftId), { user: B })).uploadIds;
  expect(await used("db1"), "a private board B cannot read").not.toContain("up_bible_priv");
  expect(await used("db2")).toContain("up_bible_shared");
  expect(await used("db3"), "the sample").toContain("up_sample");
});

test("publishing a bible re-checks that the draft's owner can write the board: a refusal says nothing of the version", async () => {
  const ws = workspace(`br-j-${run}`);
  const { tenant } = await fixture(ws);
  const { publishBible } = await import("../../lib/workbench/records");
  /* B's draft db1 is linked to A's private board: B cannot write it. */
  const refusal = await tenant.runInTenant(ws, () => publishBible("u_b", "B", "db1", 0).then(() => null, (e: Error) => e), { user: B });
  expect(refusal?.message).toBe("Save your project first.");
  expect(refusal?.message).not.toMatch(/version|published newer/i);
  expect((refusal as { currentVersion?: unknown }).currentVersion, "no version number").toBeUndefined();
  /* The same with a stale version number: still no version. */
  const stale = await tenant.runInTenant(ws, () => publishBible("u_b", "B", "db1", 7).then(() => null, (e: Error) => e), { user: B });
  expect((stale as { currentVersion?: unknown }).currentVersion).toBeUndefined();
});

test("the sample's marker and the platform owner can still publish a bible to the sample; a teammate cannot", async () => {
  const ws = workspace(`br-k-${run}`);
  const { tenant } = await fixture(ws);
  const { publishBible } = await import("../../lib/workbench/records");
  const { resetPlatformOwnerIdentity } = await import("../../lib/platformOwnerPrivacy");
  const before = process.env.SUPER_ADMIN_EMAIL;
  process.env.SUPER_ADMIN_EMAIL = `root-${run}@example.test`; resetPlatformOwnerIdentity();
  try {
    const marker = await tenant.runInTenant(ws, () => publishBible("u_marker", "Marker", "d3", 1), { user: user("u_marker") });
    expect(marker.version, "the marker publishes to their own sample").toBe(2);
    const owner = { ...user("u_root"), email: `root-${run}@example.test` };
    const root = await tenant.runInTenant(ws, () => publishBible("u_root", "Root", "dr", 2), { user: owner });
    expect(root.version, "the platform owner publishes to the sample").toBe(3);
    const mate = await tenant.runInTenant(ws, () => publishBible("u_b", "B", "db3", 3).then(() => null, (e: Error) => e), { user: B });
    expect(mate?.message, "a teammate's draft linked to the sample cannot publish to it").toBe("Save your project first.");
  } finally { if (before === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = before; resetPlatformOwnerIdentity(); }
});
