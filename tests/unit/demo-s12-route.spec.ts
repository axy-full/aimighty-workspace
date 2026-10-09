import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantToken, TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * POST and GET /api/demo/sample, and the copy each person opens (lib/demo/open.server.ts).
 *
 * People only, owner or admin to build, any member to open their own copy; a token never builds, undoes or opens.
 * Opening copies the owner's finished draft into the viewer's own draft in the same workspace and writes no take, no
 * ledger row and no meter event.
 */
const dir = mkdtempSync(path.join(tmpdir(), "demo-s12-route-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "demo-s12-route-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const originalFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

function workspace(): TenantWorkspace {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
    allowanceUsd: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0 } as TenantWorkspace;
}
const person = (id: string, over: Partial<TenantUser> = {}): TenantUser =>
  ({ id, email: `${id}@example.test`, name: id, role: "member", owner: false, disabled: false, lastSeen: null, createdAt: 0, ...over });
const OWNER = person("u_owner", { role: "admin", owner: true });
const MEMBER = person("u_member");
const TOKEN: TenantToken = { id: "tok_1", name: "a token", scope: "render", capUsd: null };

type Handler = (req: Request) => Promise<Response>;
type Route = { GET: Handler; POST: Handler };
function routeFor(ws: TenantWorkspace, who: { user: TenantUser | null; token?: TenantToken }): Route {
  return loadRouteModule<Route>("app/api/demo/sample/route.ts", {
    "@/lib/auth": {
      ...require("../../lib/auth"),
      withTenant: (fn: Handler) => (req: Request) => import("../../lib/tenant").then(({ runInTenant }) => runInTenant(ws, () => fn(req), who)),
    },
  });
}
const scopeOf = (ws: TenantWorkspace, user: TenantUser) => `particl-active-${ws.id}-${user.id}`;
const post = (route: Route, ws: TenantWorkspace, user: TenantUser, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(new Request("https://studio.test/api/demo/sample", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scopeOf(ws, user), ...headers }, body: JSON.stringify(body) }));
const get = (route: Route) => route.GET(new Request("https://studio.test/api/demo/sample"));

async function counts(client: { execute: (sql: string) => Promise<{ rows: unknown[] }> }) {
  const tables = (await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).rows as unknown as { name: string }[];
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = Number(((await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`)).rows[0] as { n: number }).n);
  return out;
}
function diff(before: Record<string, number>, after: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] ?? 0) - (before[name] ?? 0);
    if (d) out[name] = d;
  }
  return out;
}

/** The owner's finished production in the current workspace: a saved draft with a cut, a cast and two shots mapped to rows. */
async function finishedProduction(owner: string) {
  const { newProject } = await import("../../lib/workbench/studio");
  const { saveDraft, workbenchReady } = await import("../../lib/workbench/records");
  const { db, ready } = await import("../../lib/db");
  const { archiveReady } = await import("../../lib/archive");
  const { platformReady } = await import("../../lib/platform");
  await ready(); await workbenchReady(); await archiveReady(); await platformReady();
  const draft = newProject("Neutral film");
  draft.id = `project-${randomUUID().slice(0, 8)}`;
  draft.nodes = [{ id: "node-a", title: "One", type: "scene", x: 0, y: 0, width: 300, linked: [] }, { id: "node-b", title: "Two", type: "scene", x: 400, y: 0, width: 300, linked: [] }];
  draft.production = { cast: { entries: [{ id: "k1", name: "Lead", kind: "character", description: "ivory suit, short dark bob", prompt: "", takes: [] }] } };
  const saved = await saveDraft(owner, draft, 0);
  const shots: string[] = [];
  for (const [i, node] of ["node-a", "node-b"].entries()) {
    const id = `shot_${i}_${randomUUID().slice(0, 6)}`;
    await db().execute({ sql: `INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty) VALUES (?,?,?,?,?,?,'open',?,?,?,?,5,'{}','[]','render',1)`, args: [id, saved.productionProjectId, "", `C${i}`, node, "", i, owner, 1, 1] });
    await db().execute({ sql: `INSERT INTO workbench_shots(owner,draft_id,node_id,project_id,shot_id) VALUES (?,?,?,?,?)`, args: [owner, draft.id, node, saved.productionProjectId, id] });
    shots.push(id);
  }
  return { draftId: draft.id, productionId: saved.productionProjectId, shots };
}

test("the owner builds through the route; a member, a token and a wrong scope or origin are refused and nothing is written", async () => {
  const ws = workspace();
  const { db } = await import("../../lib/db");
  await (await import("../../lib/tenant")).runInTenant(ws, async () => {
    const made = await finishedProduction(OWNER.id);
    const before = await counts(db());
    const asMember = routeFor(ws, { user: MEMBER });
    expect((await post(asMember, ws, MEMBER, { action: "mark", draftId: made.draftId })).status).toBe(403);
    const asToken = routeFor(ws, { user: OWNER, token: TOKEN });
    const refused = await post(asToken, ws, OWNER, { action: "mark", draftId: made.draftId });
    expect(refused.status).toBe(403);
    expect((await post(asToken, ws, OWNER, { action: "undo" })).status).toBe(403);
    expect((await post(asToken, ws, OWNER, { action: "open" })).status).toBe(403);
    const asOwner = routeFor(ws, { user: OWNER });
    expect((await post(asOwner, ws, OWNER, { action: "mark", draftId: made.draftId }, { "X-Workbench-Scope": "particl-active-other-u" })).status).toBe(409);
    expect((await post(asOwner, ws, OWNER, { action: "mark", draftId: made.draftId }, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await post(asOwner, ws, OWNER, { action: "nonsense" })).status).toBe(400);
    expect(diff(before, await counts(db()))).toEqual({});
    /* Signed out: no user in the store. */
    const anon = routeFor(ws, { user: null });
    expect((await post(anon, ws, OWNER, { action: "mark", draftId: made.draftId })).status).toBe(401);
    expect((await get(anon)).status).toBe(401);

    const ok = await post(asOwner, ws, OWNER, { action: "mark", draftId: made.draftId });
    expect(ok.status).toBe(200);
    expect((await ok.json()).sample).toMatchObject({ projectId: made.productionId, name: "Neutral film" });
    expect(diff(before, await counts(db()))).toEqual({ settings: 1 });
  });
});

test("GET answers any member in the workspace with the sample's board, and nothing when there is none", async () => {
  const ws = workspace();
  await (await import("../../lib/tenant")).runInTenant(ws, async () => {
    const made = await finishedProduction(OWNER.id);
    const asMember = routeFor(ws, { user: MEMBER });
    expect(await (await get(asMember)).json()).toEqual({ board: null });
    await post(routeFor(ws, { user: OWNER }), ws, OWNER, { action: "mark", draftId: made.draftId });
    const res = await get(asMember);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { board } = await res.json();
    expect(board.sample.projectId).toBe(made.productionId);
    expect(board.line).toBe("Sample production · nothing here spends credits");
    expect(board.cast.map((c: { line: string }) => c.line)).toEqual(["Lead · ivory suit, short dark bob"]);
    /* A token may read it too: reading spends nothing. */
    expect((await get(routeFor(ws, { user: MEMBER, token: { ...TOKEN, scope: "read" } }))).status).toBe(200);
  });
});

test("a member opens their own copy: the owner's draft in the same workspace, its shots mapped, once per person, nothing paid written", async () => {
  const ws = workspace();
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  await (await import("../../lib/tenant")).runInTenant(ws, async () => {
    const made = await finishedProduction(OWNER.id);
    await post(routeFor(ws, { user: OWNER }), ws, OWNER, { action: "mark", draftId: made.draftId });
    const asMember = routeFor(ws, { user: MEMBER });
    const platformBefore = await counts(platformDb()), tenantBefore = await counts(db());

    const first = await (await post(asMember, ws, MEMBER, { action: "open" })).json();
    expect(first.created).toBe(true);
    expect(first.project.id).toMatch(/^sample-[0-9a-f]{24}$/);
    expect(first.project.productionProjectId).toBe(made.productionId);
    expect(first.project.name).toBe("Neutral film");
    expect(Object.values(first.project.shotMappings).sort()).toEqual([...made.shots].sort());
    expect(first.project.production.cast.entries[0].description).toBe("ivory suit, short dark bob");

    /* A second press opens the same copy; another person's copy is another draft. */
    const again = await (await post(asMember, ws, MEMBER, { action: "open" })).json();
    expect(again).toMatchObject({ created: false, revision: first.revision });
    expect(again.project.id).toBe(first.project.id);
    const other = person("u_other");
    const theirs = await (await post(routeFor(ws, { user: other }), ws, other, { action: "open" })).json();
    expect(theirs.project.id).not.toBe(first.project.id);
    /* Racing presses make one copy. */
    const racer = person("u_racer");
    const racing = await Promise.all([1, 2, 3].map(() => post(routeFor(ws, { user: racer }), ws, racer, { action: "open" }).then((r) => r.json())));
    expect(new Set(racing.map((r) => r.project.id)).size).toBe(1);

    /* Copies are drafts and their shot mappings, and nothing else: no take, no ledger row, no meter event. */
    expect(diff(platformBefore, await counts(platformDb()))).toEqual({});
    const written = diff(tenantBefore, await counts(db()));
    expect(Object.keys(written).sort()).toEqual(["workbench_projects", "workbench_shots"]);
    expect(written.workbench_projects).toBe(3);
    expect(written.workbench_shots).toBe(6);
    /* The owner's own draft is untouched. */
    expect((await db().execute({ sql: `SELECT revision FROM workbench_projects WHERE owner = ? AND project_id = ?`, args: [OWNER.id, made.draftId] })).rows[0].revision).toBe(1);
  });
});

test("opening needs a sample, and a fresh mark gives fresh copies; the copy of an undone sample is not served as the current one", async () => {
  const ws = workspace();
  await (await import("../../lib/tenant")).runInTenant(ws, async () => {
    const made = await finishedProduction(OWNER.id);
    const asOwner = routeFor(ws, { user: OWNER }), asMember = routeFor(ws, { user: MEMBER });
    expect((await post(asMember, ws, MEMBER, { action: "open" })).status).toBe(404);
    await post(asOwner, ws, OWNER, { action: "mark", draftId: made.draftId });
    const first = (await (await post(asMember, ws, MEMBER, { action: "open" })).json()).project.id;
    expect(await (await post(asOwner, ws, OWNER, { action: "undo" })).json()).toEqual({ undone: true });
    expect((await post(asMember, ws, MEMBER, { action: "open" })).status).toBe(404);
    await new Promise((r) => setTimeout(r, 5));
    await post(asOwner, ws, OWNER, { action: "mark", draftId: made.draftId });
    const second = (await (await post(asMember, ws, MEMBER, { action: "open" })).json()).project.id;
    expect(second).not.toBe(first);
  });
});
