import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";
import { makeFCPXML, makeXMEML } from "../../lib/workbench/editorial-xml";
import { withExportNames } from "../../lib/workbench/export-names";
import { assetFilename, makeEDL, newProject, type Asset, type Project } from "../../lib/workbench/studio";

/* SOW §9 / R9: a Studio export names its media by the workspace template, not the asset id. */
const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: `Asset ${id}`, kind: "video", mime: "video/mp4", category: "Shot", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });

function project(): Project {
  return {
    ...newProject("Nike AW26"), fps: 24,
    assets: [
      asset("a-wide", { generationId: "gen_wide" }),
      asset("a-wide-copy", { generationId: "gen_wide" }),
      asset("a-close", { generationId: "gen_close" }),
      asset("a-plate", { kind: "image", mime: "image/png", uploadId: "up_plate", name: "harbour-plate.png", url: "/api/uploads/up_plate" }),
    ],
    shots: [
      { id: "s1", name: "01", assetId: "a-wide", duration: 24, sourceIn: 0, note: "" },
      { id: "s2", name: "02", assetId: "a-close", duration: 24, sourceIn: 0, note: "" },
    ],
  };
}

test("renders take their template names; a repeat gets _2; uploads keep their own; the fetch is one batched request", async () => {
  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ names: { gen_wide: "NIKEAW26_SC04_SH110_SD25_v3_Akshay", gen_close: "NIKEAW26_SC04_SH120_SD25_v1_Akshay" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const named = await withExportNames(project());
    expect(calls).toEqual([{ generationIds: ["gen_wide", "gen_close"] }]);
    const byId = Object.fromEntries(named.assets.map((a) => [a.id, assetFilename(a)]));
    expect(byId).toEqual({
      "a-wide": "NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4",
      "a-wide-copy": "NIKEAW26_SC04_SH110_SD25_v3_Akshay_2.mp4",
      "a-close": "NIKEAW26_SC04_SH120_SD25_v1_Akshay.mp4",
      "a-plate": "a-plate_harbour-plate.png",
    });
    /* The EDL, FCPXML and Premiere XML point at the same names the package writes. */
    expect(makeEDL(named)).toContain("* FROM CLIP NAME: NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4");
    expect(makeFCPXML(named)).toContain('src="media/NIKEAW26_SC04_SH120_SD25_v1_Akshay.mp4"');
    expect(makeXMEML(named)).toContain("<pathurl>media/NIKEAW26_SC04_SH110_SD25_v3_Akshay.mp4</pathurl>");
  } finally { globalThis.fetch = original; }
});

test("if the names cannot be read the export keeps its previous names instead of failing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const p = project();
    expect(await withExportNames(p)).toBe(p);
    expect(assetFilename(p.assets[0])).toBe("a-wide_Asset_a-wide.mp4");
  } finally { globalThis.fetch = original; }
});

/*
 * POST /api/workbench/export-names, the route as it ships (auth stubbed, real temporary databases). A name carries the production, scene, shot and maker, so a take
 * of a private board is named only for the people who may read that board (lib/draftProject.ts mayReadTake: its owner, a workspace admin, a teammate once it is
 * shared). Anyone else gets what an id that names no take gets: the template with the id alone, in the same 200. Ordinary projects and unfiled takes are named
 * for every member, and nothing of another workspace is named at all.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-export-names-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL ??= `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0 } as TenantWorkspace;
}
const person = (id: string, role: "admin" | "member" = "member") =>
  ({ id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 }) as TenantUser;
const OWNER = person("u_owner"), MATE = person("u_mate"), ADMIN = person("u_admin", "admin");

async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, {});
}
/** A row with the given values and a placeholder in every other required column. */
async function insertRow(table: string, values: Record<string, unknown>) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const required = (await db().execute(`PRAGMA table_info(${table})`)).rows
    .filter((c) => Number(c.notnull) && c.dflt_value == null && !Number(c.pk) && !(String(c.name) in values));
  const row = { ...Object.fromEntries(required.map((c) => [String(c.name), /INT|REAL|NUM/i.test(String(c.type)) ? 0 : "x"])), ...values };
  await db().execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) as never[] });
}
const take = (id: string, projectId: string | null) =>
  insertRow("generations", { id, project_id: projectId, model: "dreamina-seedance-2-5-260628", prompt: "x", params: "{}", status: "succeeded", version: 3, created_by: OWNER.id, created_at: Date.now(), updated_at: Date.now() });

type Handler = (req: Request) => Promise<Response>;
async function ask(ws: TenantWorkspace, user: TenantUser, generationIds: string[]): Promise<{ status: number; cache: string | null; names: Record<string, string> }> {
  const auth = await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  const { POST } = loadRouteModule<{ POST: Handler }>("app/api/workbench/export-names/route.ts", {
    "@/lib/auth": { ...auth, withTenant: (fn: Handler) => (req: Request) => runInTenant(ws, () => fn(req), { user } as never), requireUser: async () => ({ user }) },
  });
  const res = await POST(new Request("http://localhost/api/workbench/export-names", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generationIds }) }));
  return { status: res.status, cache: res.headers.get("Cache-Control"), names: ((await res.json()) as { names: Record<string, string> }).names };
}

/** OWNER's private board and their shared one (drafts and `prj_wb_…` projects), an ordinary production, a take under each and one unfiled; another workspace with a take of its own. */
async function seed() {
  const { mappedId, DRAFT_PROJECT_PREFIX } = await import("../../lib/draftProject");
  const ws = workspace(), other = workspace();
  const priv = mappedId(DRAFT_PROJECT_PREFIX, ws.id, OWNER.id, "d1"), shared = mappedId(DRAFT_PROJECT_PREFIX, ws.id, OWNER.id, "d2");
  await inTenant(ws, async () => {
    const { db } = await import("../../lib/db");
    for (const u of [OWNER, MATE, ADMIN]) await insertRow("users", { id: u.id, email: u.email, name: u.name, role: u.role, created_at: 0 });
    await insertRow("projects", { id: priv, name: "LighthouseSecret", created_at: Date.now() });
    await insertRow("projects", { id: shared, name: "HarbourShared", created_at: Date.now() });
    await insertRow("projects", { id: "prj_ordinary", name: "OrdinaryProduction", created_at: Date.now() });
    const draft = (draftId: string, project: string, extra: Record<string, unknown> = {}) => db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
      args: [`${OWNER.id}:${draftId}`, OWNER.id, draftId, "Draft", JSON.stringify({ id: draftId, name: "Draft", productionProjectId: project, ...extra }), Date.now()] });
    await draft("d1", priv);
    await draft("d2", shared, { teamShared: true });
    await take("gen_private", priv);
    await take("gen_shared", shared);
    await take("gen_ordinary", "prj_ordinary");
    await take("gen_unfiled", null);
  });
  await inTenant(other, async () => {
    await insertRow("projects", { id: "prj_elsewhere", name: "ElsewhereProduction", created_at: Date.now() });
    await take("gen_elsewhere", "prj_elsewhere");
  });
  return ws;
}
const ALL = ["gen_private", "gen_shared", "gen_ordinary", "gen_unfiled", "gen_not_here", "gen_elsewhere"];

test("export names: a private board's take is named for its owner and an admin; another member gets the answer of an id that names no take", async () => {
  const ws = await seed();
  for (const who of [OWNER, ADMIN]) {
    const { status, cache, names } = await ask(ws, who, ALL);
    expect(status).toBe(200);
    expect(cache).toBe("no-store");
    expect(names.gen_private, `${who.id} reads the board`).toContain("LighthouseSecret");
    expect(names.gen_private).toContain("v3");
    expect(names.gen_shared).toContain("HarbourShared");
  }
  const { status, cache, names } = await ask(ws, MATE, ALL);
  expect(status).toBe(200);
  expect(cache).toBe("no-store");
  /* The same shape as an unknown id: the id alone, nothing of the board, the scene or the maker. */
  expect(names.gen_not_here).toBe("gen_not_here");
  expect(names.gen_private).toBe("gen_private");
  expect(JSON.stringify(names)).not.toContain("LighthouseSecret");
  /* A board its author shared is read by teammates; ordinary productions and unfiled takes are the workspace's. */
  expect(names.gen_shared).toContain("HarbourShared");
  expect(names.gen_ordinary).toContain("OrdinaryProduction");
  expect(names.gen_unfiled).toContain("v3");
  expect(names.gen_unfiled).toContain(OWNER.id);
});

test("export names: an id of another workspace is answered as one that names no take, for everyone", async () => {
  const ws = await seed();
  for (const who of [OWNER, MATE, ADMIN]) {
    const { status, names } = await ask(ws, who, ["gen_elsewhere", "gen_not_here"]);
    expect(status).toBe(200);
    expect(names).toEqual({ gen_elsewhere: "gen_elsewhere", gen_not_here: "gen_not_here" });
  }
});

test("export names: an id that fails the pattern is dropped, and more than the cap is refused with 413, uncached", async () => {
  const ws = await seed();
  expect(Object.keys((await ask(ws, MATE, ["gen_ordinary", "../bad"])).names)).toEqual(["gen_ordinary"]);
  const many = Array.from({ length: 2001 }, (_, i) => `gen_${i}`);
  const { status, cache } = await ask(ws, ADMIN, many);
  expect(status).toBe(413);
  expect(cache).toBe("no-store");
});
