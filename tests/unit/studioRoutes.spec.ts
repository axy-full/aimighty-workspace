import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/* Projects, shots and video stills: the routes' own answers, run against a real workspace database. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-studio-routes-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(name: string, extra: Partial<TenantWorkspace> = {}): TenantWorkspace {
  return { id: name, name, slug: name, legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, ...extra } as TenantWorkspace;
}
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function route(file: string, dependencies: Record<string, unknown>): Promise<Record<string, Handler>> {
  const all: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/auth": {
      withTenant: (handler: Handler) => handler,
      requireUser: async () => ({ user: { id: "owner", name: "Owner" } }),
    },
    ...dependencies,
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in all)) throw new Error("Unexpected import " + name);
      return all[name];
    },
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}
const json = (method: string, body: unknown) =>
  new Request("http://localhost/api/fixture", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a project refused by the plan's production ceiling leaves no empty production behind", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { DEFAULT_PLANS, planById } = await import("../../lib/plans");
  const invite = planById(DEFAULT_PLANS, "invite")!;
  const projects = await route("app/api/projects/route.ts", {
    "@/lib/productions": await import("../../lib/productions"),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/cache": await import("../../lib/cache"),
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/platform": { planOf: async () => invite, getPlatformLayer: async () => null },
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/planLimits": await import("../../lib/planLimits"),
  });
  await runInTenant(workspace("ceiling"), async () => {
    await ready();
    const first = await projects.POST(json("POST", { name: "First" }), { params: Promise.resolve({ id: "" }) });
    expect(first.status).toBe(200);
    const count = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM productions")).rows[0].n);
    const before = await count();
    for (let attempt = 0; attempt < 3; attempt++) {
      const refused = await projects.POST(json("POST", { name: "Second" }), { params: Promise.resolve({ id: "" }) });
      expect(refused.status).toBe(402);
    }
    expect(await count()).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM projects")).rows[0].n)).toBe(1);
  });
});

test("a shot moved to another project takes its Rig wires along; a wire to the old project's private element is archived", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const cache = await import("../../lib/cache");
  const shots = await route("app/api/shots/[id]/route.ts", {
    "@/lib/db": await import("../../lib/db"),
    "@/lib/archive": await import("../../lib/archive"),
    "@/lib/mediaMutation": await import("../../lib/mediaMutation"),
    "@/lib/shots": await import("../../lib/shots"),
    "@/lib/cache": cache,
  });
  await runInTenant(workspace("shot-move"), async () => {
    await ready();
    await db().batch([
      "INSERT INTO projects(id,name,created_at) VALUES('old','Old',0),('new','New',0)",
      "INSERT INTO shots(id,project_id,code,title,status,position,created_at,updated_at) VALUES('shot-1','old','010','Opening','draft',0,0,0)",
      "INSERT INTO elements(id,project_id,kind,name,created_at,updated_at) VALUES('shared',NULL,'character','Shared',0,0),('private','old','prop','Private',0,0),('mine','new','prop','Mine',0,0)",
      "INSERT INTO bindings(id,shot_id,project_id,slot,ordinal,element_id,created_at,updated_at) VALUES('b-shared','shot-1','old','character',0,'shared',0,0),('b-private','shot-1','old','prop',0,'private',0,0)",
    ], "write");
    cache.putCache(cache.PROJECTS_KEY, { projects: [] });
    const moved = await shots.PATCH(json("PATCH", { projectId: "new" }), { params: Promise.resolve({ id: "shot-1" }) });
    expect(moved.status).toBe(200);
    const bindings = (await db().execute("SELECT id,project_id FROM bindings WHERE shot_id='shot-1' ORDER BY id")).rows.map((row) => [row.id, row.project_id]);
    expect(bindings).toEqual([["b-shared", "new"]]);
    const archived = (await db().execute("SELECT row_id,reason FROM archived_rows WHERE table_name='bindings'")).rows.map((row) => [row.row_id, row.reason]);
    expect(archived).toEqual([["b-private", "shot moved to another project"]]);
    expect(cache.cached(cache.PROJECTS_KEY, 60_000)).toBeNull();
  });
});

test("a video still that cannot be stored says why (storage full), instead of 'reopen the project'", async () => {
  const tenant = await import("../../lib/tenant");
  const { runInTenant } = tenant;
  const uploads = await import("../../lib/uploadReservations");
  const references = await import("../../lib/workbench/atomik-references");
  const sharpStub = () => ({ metadata: async () => ({ format: "png" }), rotate() { return this; }, resize() { return this; }, flatten() { return this; }, jpeg() { return this; }, toBuffer: async () => ({ data: Buffer.from("x"), info: { width: 1, height: 1 } }) });
  const frames = (problem: Error) => route("app/api/workbench/atomik/frames/route.ts", {
    sharp: sharpStub,
    "@/lib/tenant": tenant,
    "@/lib/uploadReservations": { ...uploads, beginDirectUpload: async () => { throw problem; } },
    "@/lib/storage": { storeUpload: async () => { throw new Error("not reached"); } },
    "@/lib/workbench/atomik-server": { getAtomikProject: async () => ({}) },
    "@/lib/workbench/atomik-references": { ...references, assertAtomikVideoSource: async () => {} },
  });
  const ws = workspace("frames");
  const send = async (problem: Error) => {
    const handler = (await frames(problem)).POST;
    return runInTenant(ws, async () => {
      const response = await handler(new Request("http://localhost/api/workbench/atomik/frames?projectId=p1&assetId=v1", {
        method: "POST", headers: { "X-Workbench-Scope": "particl-active-frames-owner" }, body: new Uint8Array([1, 2, 3]),
      }), { params: Promise.resolve({ id: "" }) });
      return { status: response.status, error: ((await response.json()) as { error: string }).error };
    });
  };
  expect(await send(new uploads.UploadError("Workspace storage is full. Free space or raise the quota.", 507))).toEqual({ status: 507, error: "Workspace storage is full. Free space or raise the quota." });
  expect(await send(new references.AtomikReferenceError("Choose a saved video from this workspace."))).toEqual({ status: 422, error: "Choose a saved video from this workspace." });
  expect(await send(new Error("disk exploded"))).toEqual({ status: 422, error: "The video still could not be prepared. Reopen the project and try again." });
});

test("the selects count is one per approved take, even when a prompt holds a line break", async () => {
  const tenant = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const selects = await route("app/api/export/selects/route.ts", {
    "@/lib/db": await import("../../lib/db"),
    "@/lib/settings": await import("../../lib/settings"),
    "@/lib/naming": await import("../../lib/naming"),
    "@/lib/models": await import("../../lib/models"),
    "@/lib/creditTerms": await import("../../lib/creditTerms"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tenant": tenant,
    "@/lib/storage": { openMediaStream: async () => { throw new Error("A count opens no media."); } },
    "@/lib/zip": await import("../../lib/zip"),
    "@/lib/selects": await import("../../lib/selects"),
  });
  await tenant.runInTenant(workspace("selects"), async () => {
    await ready();
    await db().batch([
      "INSERT INTO projects(id,name,created_at) VALUES('prod','Harbour',0)",
      { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,review_state,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0,0)", args: ["g1", "prod", "video", "fixture", "Wide on the ice\nthen push in", "{}", "succeeded", "approved"] },
      { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,review_state,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0,0)", args: ["g2", "prod", "video", "fixture", "Close on the fox", "{}", "succeeded", "approved"] },
      { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,review_state,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0,0)", args: ["g3", "prod", "video", "fixture", "A draft", "{}", "succeeded", "draft"] },
    ], "write");
    const get = (format: string) => selects.GET(new Request(`http://localhost/api/export/selects?projectId=prod&format=${format}`), { params: Promise.resolve({ id: "" }) });
    expect(await (await get("count")).json()).toEqual({ approved: 2 });
    /* The CSV keeps the line break inside its quoted cell, which is what the old line count tripped on. */
    expect((await (await get("csv")).text()).split(/\r?\n/).filter((line) => line.trim()).length - 1).toBeGreaterThan(2);
  });
});
