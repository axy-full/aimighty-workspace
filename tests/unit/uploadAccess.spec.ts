import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { servingFor } from "../../lib/serveType";
import { byteRange } from "../../lib/mediaRange";
import { attachmentDisposition } from "../../lib/contentDisposition";

/**
 * Who may open an upload (lib/uploadAccess.ts): the uploader; anyone in the workspace once shared work uses it; an admin for an unowned one; nobody
 * in another workspace. Everything else is a 404 that is the same as an unknown id's. Real temporary databases; storage and sign-in are fakes, so
 * no provider or bucket is touched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-upload-access-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false }) as TenantWorkspace;
const bytes = Buffer.from("not really a picture, only bytes");

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

async function harness() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const access = await import("../../lib/uploadAccess");
  const library = await import("../../lib/uploadLibrary");
  let viewer = { id: "u_up", role: "member" };
  const stream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  const auth = { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer }) };
  const deps = {
    "@/lib/auth": auth, "@/lib/db": database, "@/lib/tenant": tenant, "@/lib/uploadAccess": access, "@/lib/uploadLibrary": library,
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null }, "@/lib/workbench/records": {}, "@/lib/mediaBindings": {}, "@/lib/uploadReservations": {}, "@/lib/archive": {},
    "@/lib/contentDisposition": { attachmentDisposition }, "@/lib/serveType": { servingFor }, "@/lib/mediaRange": { byteRange },
    "@/lib/storage": { backendKind: () => "local", presignedUploadUrl: async () => null, openUploadStream: async () => ({ stream: stream(), size: bytes.length }) },
  };
  return {
    tenant, database, access,
    get: load<typeof import("../../app/api/uploads/[id]/route")>("app/api/uploads/[id]/route.ts", deps).GET,
    metadata: load<typeof import("../../app/api/uploads/[id]/metadata/route")>("app/api/uploads/[id]/metadata/route.ts", deps).GET,
    as: (id: string, role = "member") => { viewer = { id, role }; },
  };
}
type H = Awaited<ReturnType<typeof harness>>;
const request = (url: string) => new Request("https://particl.test" + url);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** An upload row, with or without an uploader, in the current workspace. */
async function seedUpload(h: H, id: string, uploader: string | null) {
  await h.database.db().execute({
    sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,uploader_id) VALUES(?,?,?,?,?,?,NULL,NULL,'',1,'image',?)",
    args: [id, "frame.png", "image/png", "png", bytes.length, "x", uploader],
  });
}
const status = async (h: H, id: string) => (await h.get(request(`/api/uploads/${id}`), ctx(id))).status;

test("the uploader opens it; a teammate gets a 404 that is an unknown id's 404, for the bytes and for the metadata", async () => {
  const h = await harness();
  const ws = workspace(`access-a-${run}`);
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    await seedUpload(h, `upl_a_${run}`, "u_up");
    h.as("u_up");
    expect(await status(h, `upl_a_${run}`)).toBe(200);
    expect((await h.metadata(request("/x"), ctx(`upl_a_${run}`))).status).toBe(200);
    h.as("u_mate");
    const hidden = await h.get(request(`/api/uploads/upl_a_${run}`), ctx(`upl_a_${run}`));
    const unknown = await h.get(request("/api/uploads/upl_nothing"), ctx("upl_nothing"));
    expect(hidden.status).toBe(404);
    expect([hidden.status, await hidden.text(), hidden.headers.get("content-type")]).toEqual([unknown.status, await unknown.text(), unknown.headers.get("content-type")]);
    expect((await h.metadata(request("/x"), ctx(`upl_a_${run}`))).status).toBe(404);
    /* An admin does not open a member's upload either, unless shared work uses it. */
    h.as("u_admin", "admin");
    expect(await status(h, `upl_a_${run}`)).toBe(404);
  });
});

test("a teammate opens it once shared work uses it: the shared canvas, a board, a library filing, a take, a shot, a bible, a cast member", async () => {
  const h = await harness();
  const ws = workspace(`access-b-${run}`);
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    const db = h.database.db();
    const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
    const { workbenchReady } = await import("../../lib/workbench/records");
    await teamCanvasReady(); await workbenchReady();
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod','Production',0)", args: [] });
    await db.execute("CREATE TABLE IF NOT EXISTS project_library_uploads (project_id TEXT NOT NULL, upload_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_id,upload_id))");
    const attach: Record<string, (id: string) => Promise<unknown>> = {
      canvas: (id) => db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES('prod',?,1,'u_up',1)", args: [JSON.stringify({ nodes: [{ id: "n1", media: { url: `/api/uploads/${id}` } }] })] }),
      board: (id) => db.execute({ sql: "INSERT INTO boards(id,project_id,name,nodes,wires,created_at,updated_at) VALUES(?,?,?,?,?,1,1)", args: [`brd_${id}`, "prod", "Board", JSON.stringify([{ id: "c", uploadId: id }]), "[]"] }),
      library: (id) => db.execute({ sql: "INSERT INTO project_library_uploads(project_id,upload_id,created_by,created_at) VALUES('prod',?,'u_up',1)", args: [id] }),
      take: (id) => db.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,'succeeded',1,1,'video')", args: [`gen_${id}`, "m", "p", JSON.stringify({ references: [{ uploadId: id }] })] }),
      shot: (id) => db.execute({ sql: "INSERT INTO shots(id,project_id,setup,created_at,updated_at) VALUES(?,'prod',?,1,1)", args: [`shot_${id}`, JSON.stringify({ look: { uploadId: id } })] }),
      bible: (id) => db.execute({ sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,1,'u_up',?,1)", args: [`bible_${id}`, JSON.stringify({ assets: [{ uploadId: id }] })] }),
      cast: (id) => db.execute({ sql: "INSERT INTO cast_members(id,project_id,name,upload_id,created_at) VALUES(?,'prod','Lead',?,1)", args: [`cast_${id}`, id] }),
    };
    for (const [name, link] of Object.entries(attach)) {
      const id = `upl_${name}_${run}`;
      await seedUpload(h, id, "u_up");
      h.as("u_mate");
      expect(await status(h, id), `${name}: before it is attached`).toBe(404);
      await link(id);
      expect(await status(h, id), `${name}: once it is attached`).toBe(200);
      expect((await h.metadata(request("/x"), ctx(id))).status, `${name}: metadata`).toBe(200);
    }
    /* A deleted take shows nothing. */
    const gone = `upl_gone_${run}`;
    await seedUpload(h, gone, "u_up");
    await db.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted) VALUES(?,?,?,?,'succeeded',1,1,'video',1)", args: [`gen_${gone}`, "m", "p", JSON.stringify({ uploadId: gone })] });
    expect(await status(h, gone)).toBe(404);
  });
});

test("a private draft and a person's own tools do not share an upload: it stays its uploader's", async () => {
  const h = await harness();
  const ws = workspace(`access-c-${run}`);
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    const { workbenchReady } = await import("../../lib/workbench/records");
    await workbenchReady();
    const id = `upl_draft_${run}`;
    await seedUpload(h, id, "u_up");
    await h.database.db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,1)", args: [`u_up:draft${run}`, "u_up", "draft", "Draft", JSON.stringify({ assets: [{ id: "a", uploadId: id, url: `/api/uploads/${id}` }] })] });
    h.as("u_mate");
    expect(await status(h, id)).toBe(404);
    h.as("u_up");
    expect(await status(h, id)).toBe(200);
  });
});

test("an unowned older upload is openable by members, as today; an owned one is not, and another workspace's never is", async () => {
  const h = await harness();
  const ws = workspace(`access-d-${run}`);
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    const old = `upl_old_${run}`, owned = `upl_owned_${run}`;
    await seedUpload(h, old, null);
    await seedUpload(h, owned, "u_up");
    for (const [who, role] of [["u_mate", "member"], ["u_admin", "admin"], ["u_up", "member"]] as const) {
      h.as(who, role);
      expect(await status(h, old), `${role} ${who}, unowned`).toBe(200);
      expect((await h.metadata(request("/x"), ctx(old))).status).toBe(200);
    }
    h.as("u_mate");
    expect(await status(h, owned)).toBe(404);
  });
  await h.tenant.runInTenant(workspace(`access-d2-${run}`), async () => {
    await h.database.ready();
    h.as("u_mate");
    expect(await status(h, `upl_old_${run}`)).toBe(404);
  });
});

test("another workspace never opens it: the same id there is a 404 for its admin and its members, and it opens its own upload of that id", async () => {
  const h = await harness();
  const one = workspace(`access-e1-${run}`), two = workspace(`access-e2-${run}`);
  const id = `upl_cross_${run}`;
  await h.tenant.runInTenant(one, async () => { await h.database.ready(); await seedUpload(h, id, "u_up"); });
  for (const [who, role] of [["u_up", "member"], ["u_other", "member"], ["u_admin", "admin"]] as const)
    await h.tenant.runInTenant(two, async () => {
      await h.database.ready();
      h.as(who, role);
      expect(await status(h, id), `${role} ${who}`).toBe(404);
      expect((await h.metadata(request("/x"), ctx(id))).status).toBe(404);
    });
  /* Shared work in the other workspace does not reach this one's upload: the check reads only the workspace in scope. */
  await h.tenant.runInTenant(two, async () => {
    await h.database.ready();
    await h.database.db().execute({ sql: "INSERT INTO cast_members(id,name,upload_id,created_at) VALUES(?,?,?,1)", args: [`cast_x_${run}`, "Lead", id] });
    h.as("u_other");
    expect(await status(h, id)).toBe(404);
  });
  await h.tenant.runInTenant(one, async () => { h.as("u_other"); expect(await status(h, id)).toBe(404); h.as("u_up"); expect(await status(h, id)).toBe(200); });
});

test("rows from before the column are filled from the chat message that carried them; a row nothing names stays unowned", async () => {
  const h = await harness();
  const file = path.join(dir, `legacy-${run}.db`);
  const legacy = createClient({ url: `file:${file}` });
  await legacy.batch([
    "CREATE TABLE uploads (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER, stored_url TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', mentions TEXT NOT NULL DEFAULT '[]', upload_id TEXT, created_at INTEGER NOT NULL)",
    `INSERT INTO uploads VALUES('upl_chat_${run}','a.png','image/png','png',1,'x',NULL,NULL,'',1)`,
    `INSERT INTO uploads VALUES('upl_nobody_${run}','b.png','image/png','png',1,'x',NULL,NULL,'',1)`,
    `INSERT INTO messages VALUES('m1','u_chatter','',  '[]','upl_chat_${run}',1)`,
  ], "write");
  legacy.close();
  const ws = { ...workspace(`access-f-${run}`), dbUrl: `file:${file}` };
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    const rows = (await h.database.db().execute("SELECT id,uploader_id FROM uploads ORDER BY id")).rows;
    expect(rows.map((r) => [String(r.id), r.uploader_id])).toEqual([[`upl_chat_${run}`, "u_chatter"], [`upl_nobody_${run}`, null]]);
  });
});

/** A draft owned by `owner`, linked to its own production project (`prj_wb_…`, lib/workbench/records.ts › linkProduction), as every private board is. */
async function seedDraft(h: H, owner: string, draft: string, projectId: string) {
  const { newProject } = await import("../../lib/workbench/studio");
  const { projectLibraryReady } = await import("../../lib/workbench/project-library");
  await projectLibraryReady();
  await h.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [projectId, projectId] });
  await h.database.db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)",
    args: [`${owner}:${draft}`, owner, draft, draft, JSON.stringify({ ...newProject(draft), id: draft, productionProjectId: projectId, assets: [] })] });
}

test("a private board's uploads stay private: the automatic filing into a draft's own project grants nothing, a filing into a shared project does", async () => {
  const h = await harness();
  const { linkProjectLibraryUpload } = await import("../../lib/workbench/project-library");
  await h.tenant.runInTenant(workspace(`access-h-${run}`), async () => {
    await h.database.ready();
    await seedDraft(h, "u_up", "draft1", "prj_wb_one");
    await h.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_shared','Shared',0)", args: [] });
    /* What the composer does for every upload into a board: it files it into the draft's own production project. */
    const mine = `upl_board_${run}`;
    await seedUpload(h, mine, "u_up");
    await linkProjectLibraryUpload("u_up", "draft1", mine);
    expect((await h.database.db().execute({ sql: "SELECT project_id FROM project_library_uploads WHERE upload_id=?", args: [mine] })).rows.map((r) => r.project_id)).toEqual(["prj_wb_one"]);
    h.as("u_mate");
    expect(await status(h, mine), "a teammate, with the draft's filing in place").toBe(404);
    h.as("u_up");
    expect(await status(h, mine)).toBe(200);
    /* A take and a board made inside the draft's project do not share its references either. */
    const viaTake = `upl_dtake_${run}`, viaBoard = `upl_dboard_${run}`;
    await seedUpload(h, viaTake, "u_up"); await seedUpload(h, viaBoard, "u_up");
    await h.database.db().execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,?,'succeeded',1,1,'image')", args: [`gen_d_${run}`, "prj_wb_one", "m", "p", JSON.stringify({ references: [{ uploadId: viaTake }] })] });
    await h.database.db().execute({ sql: "INSERT INTO boards(id,project_id,name,nodes,wires,created_at,updated_at) VALUES(?,?,?,?,?,1,1)", args: [`brd_d_${run}`, "prj_wb_one", "B", JSON.stringify([{ uploadId: viaBoard }]), "[]"] });
    h.as("u_mate");
    expect(await status(h, viaTake)).toBe(404);
    expect(await status(h, viaBoard)).toBe(404);
    /* The same work in a shared project does. */
    h.as("u_up");
    const shared = `upl_shared_${run}`;
    await seedUpload(h, shared, "u_up");
    await h.database.db().execute({ sql: "INSERT INTO project_library_uploads(project_id,upload_id,created_by,created_at) VALUES('prod_shared',?,'u_up',1)", args: [shared] });
    h.as("u_mate");
    expect(await status(h, shared)).toBe(200);
  });
});

test("nobody can file, chat, attach or save their way into someone else's private upload", async () => {
  const h = await harness();
  const { linkProjectLibraryUpload, ProjectLibraryError } = await import("../../lib/workbench/project-library");
  const { withMediaSources } = await import("../../lib/mediaMutation");
  const { writeCanvasRow, teamCanvasReady } = await import("../../lib/workbench/team-canvas");
  const { parseTeamCanvas } = await import("../../lib/workbench/team-canvas-model");
  const id = `upl_secret_${run}`;
  const as = (user: string) => ({ user: { id: user, email: "", name: user, role: "member" as const, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  const ws = workspace(`access-i-${run}`);
  await h.tenant.runInTenant(ws, async () => { await h.database.ready(); await seedUpload(h, id, "u_up"); await seedDraft(h, "u_mate", "dmate", "prj_wb_mate"); await teamCanvasReady();
    await h.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod',?,0)", args: ["Production"] }); });
  await h.tenant.runInTenant(ws, async () => {
    /* A library filing, as the B's draft would do it. */
    await expect(linkProjectLibraryUpload("u_mate", "dmate", id)).rejects.toBeInstanceOf(ProjectLibraryError);
    await expect(linkProjectLibraryUpload("u_mate", "dmate", id)).rejects.toMatchObject({ status: 404 });
    /* A chat message, a board, a shot's setup and a take's references all go through the same attach (lib/mediaMutation.ts). */
    for (const value of [{ uploadId: id }, [{ id: "n", uploadId: id }], { setup: { look: { uploadId: id } } }, { references: [{ uploadId: id }] }, { url: `/api/uploads/${id}` }])
      await expect(withMediaSources(value, async () => 1), JSON.stringify(value)).rejects.toThrow(/no longer available/);
    /* The shared canvas. */
    const canvas = parseTeamCanvas({ nodes: { n1: { id: "n1", uploadId: id } } });
    const refused = await h.database.db().transaction("write").then(async (tx) => { try { await writeCanvasRow(tx, "prod", canvas, 0, "u_mate"); return null; } catch (e) { return e as Error; } finally { await tx.rollback(); tx.close(); } });
    expect(refused?.message).toMatch(/no longer available/);
    /* The same refusal an unknown id gets: nothing says the upload exists. */
    const unknown = await withMediaSources({ uploadId: "upl_nothing" }, async () => 1).catch((e: Error) => e.message);
    const hidden = await withMediaSources({ uploadId: id }, async () => 1).catch((e: Error) => e.message);
    expect(hidden).toBe(unknown);
  }, as("u_mate"));
  /* None of it opened anything. */
  await h.tenant.runInTenant(ws, async () => { h.as("u_mate"); expect(await status(h, id)).toBe(404); }, as("u_mate"));
  /* The uploader, and anyone once shared work holds it, can attach it; a stray mention of the id in a note shares nothing. */
  await h.tenant.runInTenant(ws, async () => {
    await withMediaSources({ uploadId: id }, async () => 1);
    await h.database.db().execute({ sql: "INSERT INTO boards(id,project_id,name,nodes,wires,created_at,updated_at) VALUES(?,?,?,?,?,1,1)", args: [`brd_note_${run}`, "prod", "B", JSON.stringify([{ note: `see ${id} and ${id}` }]), "[]"] });
  }, as("u_up"));
  await h.tenant.runInTenant(ws, async () => { h.as("u_mate"); expect(await status(h, id), "an id in a note").toBe(404); }, as("u_mate"));
  await h.tenant.runInTenant(ws, async () => {
    await h.database.db().execute({ sql: "INSERT INTO boards(id,project_id,name,nodes,wires,created_at,updated_at) VALUES(?,?,?,?,?,1,1)", args: [`brd_real_${run}`, "prod", "B", JSON.stringify([{ uploadId: id }]), "[]"] });
  }, as("u_up"));
  await h.tenant.runInTenant(ws, async () => { h.as("u_mate"); expect(await status(h, id), "on a shared board").toBe(200); await withMediaSources({ uploadId: id }, async () => 1); }, as("u_mate"));
});

test("the library list and the planner's library show a person only what they may open, and still page completely", async () => {
  const h = await harness();
  const { listLibraryUploads } = await import("../../lib/uploadLibrary");
  const { plannerLibrary } = await import("../../lib/atomikLibrary");
  const ws = workspace(`access-j-${run}`);
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    const { workbenchReady } = await import("../../lib/workbench/records");
    await workbenchReady();
    await seedDraft(h, "u_mate", "dmate", "prj_wb_mate");
    await h.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod','Production',0)", args: [] });
    const seed = async (n: string, uploader: string | null, at: number) => h.database.db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,uploader_id) VALUES(?,?,'image/png','png',1,'secret-hash',640,480,'',?,'image',?)", args: [`upl_l_${n}_${run}`, `${n}.png`, at, uploader] });
    /* Newest first: seven of A's private uploads in a row, then B's own, one shared, one unowned. */
    for (let i = 0; i < 7; i++) await seed(`priv${i}`, "u_up", 100 - i);
    await seed("mine", "u_mate", 50); await seed("shared", "u_up", 40); await seed("old", null, 30);
    await h.database.db().execute({ sql: "INSERT INTO cast_members(id,project_id,name,upload_id,created_at) VALUES(?,'prod','Lead',?,1)", args: [`cast_l_${run}`, `upl_l_shared_${run}`] });
    const all = async (viewer: string) => {
      const out: string[] = []; let cursor: string | null = null;
      do {
        const page: { uploads: { id: string; sha256: string }[]; nextCursor: string | null } = await listLibraryUploads(new URLSearchParams(`limit=2${cursor ? `&cursor=${cursor}` : ""}`), undefined, undefined, { id: viewer });
        out.push(...page.uploads.map((u) => u.id)); cursor = page.nextCursor;
      } while (cursor);
      return out;
    };
    const mate = await all("u_mate");
    expect(mate.map((id) => id.replace(`_${run}`, ""))).toEqual(["upl_l_mine", "upl_l_shared", "upl_l_old"]);
    expect((await all("u_up")).length).toBe(9);
    /* The planner's library: B's draft names A's private upload (a draft saved before this rule), and it is neither listed nor cited. */
    await h.database.db().execute({ sql: "UPDATE workbench_projects SET body=json_set(body,'$.assets',json(?)) WHERE owner='u_mate'", args: [JSON.stringify([{ id: "a1", name: "x", uploadId: `upl_l_priv0_${run}`, url: `/api/uploads/upl_l_priv0_${run}`, kind: "image" }])] });
    const listed = async (owner: string) => (await plannerLibrary({ owner, projectId: "prj_wb_mate", studioProjectId: "dmate" })).map((item) => item.id);
    expect(await listed("u_mate")).not.toContain(`upl_l_priv0_${run}`);
  });
});

test("the identity preview's Soul references count as shared work; the backfill runs only when the column is new and takes the first poster", async () => {
  const h = await harness();
  const id = `upl_soul_${run}`;
  await h.tenant.runInTenant(workspace(`access-k-${run}`), async () => {
    await h.database.ready();
    await h.database.db().execute("CREATE TABLE IF NOT EXISTS soul_identities (id TEXT PRIMARY KEY, production_project_id TEXT, references_json TEXT NOT NULL)");
    await seedUpload(h, id, "u_up");
    h.as("u_mate");
    expect(await status(h, id)).toBe(404);
    /* An identity made in a private board's own project shares nothing; one in a shared production does. */
    await h.database.db().execute({ sql: "INSERT INTO soul_identities(id,production_project_id,references_json) VALUES('soul0','prj_wb_one',?)", args: [JSON.stringify([{ uploadId: id }])] });
    expect(await status(h, id)).toBe(404);
    await h.database.db().execute({ sql: "INSERT INTO soul_identities(id,production_project_id,references_json) VALUES('soul1','prod',?)", args: [JSON.stringify([{ uploadId: id }])] });
    expect(await status(h, id)).toBe(200);
  });
  /* A database that already has the column is not backfilled again; a new column takes the first message's author. */
  const file = path.join(dir, `legacy2-${run}.db`);
  const legacy = createClient({ url: `file:${file}` });
  await legacy.batch([
    "CREATE TABLE uploads (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER, stored_url TEXT NOT NULL, created_at INTEGER NOT NULL, uploader_id TEXT)",
    "CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', mentions TEXT NOT NULL DEFAULT '[]', upload_id TEXT, created_at INTEGER NOT NULL)",
    `INSERT INTO uploads VALUES('upl_had_${run}','a.png','image/png','png',1,'x',NULL,NULL,'',1,NULL)`,
    `INSERT INTO messages VALUES('m1','u_late','','[]','upl_had_${run}',9)`,
  ], "write");
  legacy.close();
  await h.tenant.runInTenant({ ...workspace(`access-l-${run}`), dbUrl: `file:${file}` }, async () => {
    await h.database.ready();
    expect((await h.database.db().execute("SELECT uploader_id FROM uploads")).rows[0].uploader_id).toBeNull();
    expect((await h.database.db().execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_upload'")).rows).toHaveLength(1);
  });
  const file2 = path.join(dir, `legacy3-${run}.db`);
  const old = createClient({ url: `file:${file2}` });
  await old.batch([
    "CREATE TABLE uploads (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER, stored_url TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', mentions TEXT NOT NULL DEFAULT '[]', upload_id TEXT, created_at INTEGER NOT NULL)",
    `INSERT INTO uploads VALUES('upl_two_${run}','a.png','image/png','png',1,'x',NULL,NULL,'',1)`,
    `INSERT INTO messages VALUES('m2','u_second','','[]','upl_two_${run}',9)`,
    `INSERT INTO messages VALUES('m1','u_first','','[]','upl_two_${run}',3)`,
  ], "write");
  old.close();
  await h.tenant.runInTenant({ ...workspace(`access-m-${run}`), dbUrl: `file:${file2}` }, async () => {
    await h.database.ready();
    expect((await h.database.db().execute("SELECT uploader_id FROM uploads")).rows[0].uploader_id).toBe("u_first");
  });
});

test("a private board's team canvas, its master locks and its Soul identities grant nothing; the shared production's do", async () => {
  const h = await harness();
  await h.tenant.runInTenant(workspace(`access-n-${run}`), async () => {
    await h.database.ready();
    const { teamCanvasReady } = await import("../../lib/workbench/team-canvas");
    await teamCanvasReady();
    const db = h.database.db();
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prj_wb_one','Draft one',0)", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod','Production',0)", args: [] });
    const canvasOf = (id: string) => JSON.stringify({ nodes: { n1: { id: "n1", uploadId: id } } });
    for (const [project, expected] of [["prj_wb_one", 404], ["prod", 200]] as const) {
      /* The team canvas: a draft's own is written by Rig, Atomik and every draft save (diffForTeam); the production's is the shared board. */
      const onCanvas = `upl_cv_${project}_${run}`;
      await seedUpload(h, onCanvas, "u_up");
      await db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,1,'u_up',1)", args: [project, canvasOf(onCanvas)] });
      /* A master lock: an element of the project with a catalog version that holds the upload (lib/masters.ts). */
      const locked = `upl_lock_${project}_${run}`;
      await seedUpload(h, locked, "u_up");
      await db.execute({ sql: "INSERT INTO elements(id,project_id,name,locked,created_at,updated_at) VALUES(?,?,?,1,1,1)", args: [`el_${project}_${run}`, project, "Hero"] }).catch(async () =>
        db.execute({ sql: "INSERT INTO elements(id,project_id,name) VALUES(?,?,?)", args: [`el_${project}_${run}`, project, "Hero"] }));
      await db.execute({ sql: "INSERT INTO attribute_versions(id,attribute_id,element_id,upload_id,created_at) VALUES(?,?,?,?,1)", args: [`av_${project}_${run}`, "attr", `el_${project}_${run}`, locked] });
      h.as("u_mate");
      expect(await status(h, onCanvas), `${project}: team canvas`).toBe(expected);
      expect(await status(h, locked), `${project}: master lock`).toBe(expected);
      h.as("u_up");
      expect(await status(h, onCanvas)).toBe(200);
    }
  });
});

test("every reader that takes an upload id asks: transcription, dubbing and voice change cannot use someone's private upload, nor leave a take that names it; Atomik's attachments too", async () => {
  const h = await harness();
  const { findStoredSource } = await import("../../lib/mediaSource.server");
  const { resolveVoiceChangeSource } = await import("../../lib/audioAdmission");
  const { resolveDubbingSource, executeDubbingAdmission } = await import("../../lib/dubbing");
  const { resolvePlanAttachments } = await import("../../lib/workbench/rig-agent-attachments");
  process.env.ENGINE_MOCK = "1";
  const ws = workspace(`access-o-${run}`);
  const as = (user: string) => ({ user: { id: user, email: "", name: user, role: "member" as const, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  const audio = `upl_voice_${run}`, picture = `upl_att_${run}`;
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    await h.database.db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s,uploader_id) VALUES(?,?,?,?,?,?,'',1,'audio',60,'u_up')", args: [audio, "take.mp3", "audio/mpeg", "mp3", 10, "x"] });
    await seedUpload(h, picture, "u_up");
    const { projectLibraryReady } = await import("../../lib/workbench/project-library");
    await projectLibraryReady();
    await h.database.db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prj_wb_two','Draft',0)", args: [] });
    await h.database.db().execute({ sql: "INSERT INTO project_library_uploads(project_id,upload_id,created_by,created_at) VALUES('prj_wb_two',?,'u_up',1)", args: [picture] });
  }, as("u_up"));
  await h.tenant.runInTenant(ws, async () => {
    expect(await findStoredSource({ uploadId: audio }), "the uploader").not.toBeNull();
    expect(await resolveVoiceChangeSource({ sourceUploadId: audio })).not.toMatchObject({ status: 404 });
    expect((await resolvePlanAttachments("prj_wb_two", [`upload:${picture}`])).map((a) => a.uploadId)).toEqual([picture]);
  }, as("u_up"));
  await h.tenant.runInTenant(ws, async () => {
    expect(await findStoredSource({ uploadId: audio }), "a teammate").toBeNull();
    expect(await resolveVoiceChangeSource({ sourceUploadId: audio })).toMatchObject({ status: 404 });
    expect(await resolveDubbingSource({ sourceUploadId: audio })).toMatchObject({ status: 404 });
    /* The dub quote, which is where a dub's source is first named (and what its take would later record). */
    const reply = await executeDubbingAdmission({ sourceUploadId: audio, targetLang: "es", quoteOnly: true }, as("u_mate"), { defer: async () => {} });
    expect(reply.status).toBe(404);
    expect((await h.database.db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n).toBe(0);
    /* Filed in the production's library is not enough for Atomik's attachments. */
    await expect(resolvePlanAttachments("prj_wb_two", [`upload:${picture}`])).rejects.toThrow(/isn't in this project's Library/);
  }, as("u_mate"));
});

test("autosave: a draft that already names a teammate's upload keeps saving; only what a save adds is asked", async () => {
  const h = await harness();
  const { workbenchTransaction, validateStoredMedia } = await import("../../lib/workbench/records");
  const { withMediaSources } = await import("../../lib/mediaMutation");
  const ws = workspace(`access-p-${run}`);
  const as = (user: string) => ({ user: { id: user, email: "", name: user, role: "member" as const, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  const named = `upl_named_${run}`, fresh = `upl_fresh_${run}`;
  await h.tenant.runInTenant(ws, async () => { await h.database.ready(); await seedUpload(h, named, "u_up"); await seedUpload(h, fresh, "u_up"); }, as("u_up"));
  await h.tenant.runInTenant(ws, async () => {
    const draft = (...ids: string[]) => ({ assets: ids.map((id) => ({ id: `a_${id}`, uploadId: id, url: `/api/uploads/${id}` })) });
    /* It named the upload before this rule; saving the same draft again, with more of its own, is not refused. */
    await workbenchTransaction((tx) => validateStoredMedia(tx, draft(named), draft(named)));
    await workbenchTransaction((tx) => validateStoredMedia(tx, { ...draft(named), notes: "more" }, draft(named)));
    /* Adding someone else's private upload is. The words are a missing upload's, with the id. */
    const hidden = await workbenchTransaction((tx) => validateStoredMedia(tx, draft(named, fresh), draft(named))).catch((e: Error) => e.message);
    const missing = await workbenchTransaction((tx) => validateStoredMedia(tx, draft(named, "upl_nothing"), draft(named))).catch((e: Error) => e.message);
    expect(hidden).toBe(String(missing).replace("upl_nothing", fresh));
    /* The same for a board's nodes and a shot's setup (withMediaSources with what the record held). */
    const prior = async () => [{ uploadId: named }];
    await withMediaSources([{ uploadId: named }, { note: "x" }], async () => 1, prior);
    await expect(withMediaSources([{ uploadId: named }, { uploadId: fresh }], async () => 1, prior)).rejects.toThrow(/no longer available/);
  }, as("u_mate"));
});

test("the preview door (thumbnails) answers the same: the uploader gets the picture, a teammate a 404 before any cached preview is looked up", async () => {
  const h = await harness();
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).png().toBuffer();
  let viewer = { id: "u_up", role: "member" };
  const preview = load<typeof import("../../app/api/workbench/preview/[kind]/[id]/route")>("app/api/workbench/preview/[kind]/[id]/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer }) },
    "@/lib/db": h.database, "@/lib/tenant": h.tenant, "@/lib/uploadAccess": h.access,
    "@/lib/storage": { readImageBytes: async () => png, readUploadBytes: async () => png },
  }).GET;
  const ws = workspace(`access-g-${run}`);
  await h.tenant.runInTenant(ws, async () => {
    await h.database.ready();
    const id = `upl_prev_${run}`;
    await seedUpload(h, id, "u_up");
    const ask = async () => (await preview(request(`/api/workbench/preview/upload/${id}`), { params: Promise.resolve({ kind: "upload", id }) })).status;
    expect(await ask()).toBe(200);
    viewer = { id: "u_mate", role: "member" };
    expect(await ask(), "a teammate, with the preview already cached for the uploader").toBe(404);
    await h.database.db().execute({ sql: "INSERT INTO cast_members(id,name,upload_id,created_at) VALUES(?,?,?,1)", args: [`cast_prev_${run}`, "Lead", id] });
    expect(await ask()).toBe(200);
  });
});

test("the review page's logo and the other doors keep their own rules: only the three upload doors ask uploadAccess", () => {
  const door = (file: string) => readFileSync(path.resolve(file), "utf8").includes("uploadOpenableBy");
  expect(door("app/api/uploads/[id]/route.ts")).toBe(true);
  expect(door("app/api/uploads/[id]/metadata/route.ts")).toBe(true);
  expect(door("app/api/workbench/preview/[kind]/[id]/route.ts")).toBe(true);
  /* A review link's logo is a workspace setting shown to a guest by token: unchanged. */
  expect(door("app/api/review/[token]/logo/route.ts")).toBe(false);
});
