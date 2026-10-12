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
