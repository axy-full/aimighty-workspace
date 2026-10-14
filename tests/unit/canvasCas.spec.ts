import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { applyTeamPatch, diffForTeam, emptyTeamCanvas, overlay, refusedWrites, startedFrom, type TeamPatch } from "../../lib/workbench/team-canvas-model";
import { mergePatches } from "../../lib/workspace/team-canvas-outbox";

/**
 * Saved mode (no live room): a card-field edit is a compare and set. Each window sends the card as it started from, the canvas writes only the fields it still
 * holds that way, and the window is told of the others (it holds them and asks its person). In a live room edits are live and shared: nothing here changes.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-canvas-cas-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [], ...extra });
const project = (nodes: CanvasNode[]): Project => ({ ...newProject("Team"), id: "draft-a", productionProjectId: "prod-1", nodes });
const edit = (before: Project, id: string, change: Partial<CanvasNode>, at: number, cas = true): TeamPatch => {
  const after = { ...before, nodes: before.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) };
  const patch = diffForTeam(before, after, at)!;
  return cas ? startedFrom(patch, before) : patch;
};

test("an edit with no live room carries each changed card as it started from; a made, removed or unchanged card carries nothing", () => {
  const before = project([node("a", { text: "one" }), node("b")]);
  const changed = edit(before, "a", { text: "two" }, 5);
  expect(changed).toMatchObject({ cas: true, expect: { a: { id: "a", text: "one" } } });
  expect(Object.keys(changed.expect!)).toEqual(["a"]);
  const made = diffForTeam(before, { ...before, nodes: [...before.nodes, node("c")] }, 6)!;
  expect(startedFrom(made, before).cas).toBeUndefined();
  const removed = diffForTeam(before, { ...before, nodes: [before.nodes[0]] }, 7)!;
  expect(startedFrom(removed, before).expect).toBeUndefined();
});

test("two windows in saved mode: the second to write the same field is refused and named; a different field of the same card lands", () => {
  const start = project([node("a", { text: "one", title: "Shot" })]);
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: start.nodes, removeNodes: [], upsertAssets: [], order: ["a"], at: 1 });
  const first = edit(start, "a", { text: "Ana's line" }, 10);
  const second = edit(start, "a", { text: "Bo's line" }, 11);
  const third = edit(start, "a", { title: "Renamed" }, 12);
  canvas = applyTeamPatch(canvas, first);
  expect(canvas.nodes.a.text).toBe("Ana's line");
  expect(refusedWrites(canvas, second)).toEqual([{ nodeId: "a", fields: ["text"] }]);
  const after = applyTeamPatch(canvas, second);
  expect(after.nodes.a.text, "nothing is written over Ana's").toBe("Ana's line");
  expect(refusedWrites(after, third), "another field is no conflict").toEqual([]);
  expect(applyTeamPatch(after, third).nodes.a).toMatchObject({ text: "Ana's line", title: "Renamed" });
  /* Kept (sent again with no compare): this window's version is written. */
  const kept = edit(start, "a", { text: "Bo's line" }, 13, false);
  expect(applyTeamPatch(after, kept).nodes.a.text).toBe("Bo's line");
});

test("a card a teammate took off still comes back with a compare-and-set edit, as before; a catch-up's expect still does not bring it back", () => {
  const start = project([node("a", { text: "one" })]);
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: start.nodes, removeNodes: [], upsertAssets: [], order: ["a"], at: 1 });
  canvas = applyTeamPatch(canvas, { upsertNodes: [], removeNodes: ["a"], upsertAssets: [], order: null, at: 5 });
  expect(canvas.nodes.a).toBeUndefined();
  expect(refusedWrites(canvas, edit(start, "a", { text: "two" }, 10))).toEqual([]);
  expect(applyTeamPatch(canvas, edit(start, "a", { text: "two" }, 10)).nodes.a.text).toBe("two");
  const catchUp = { ...edit(start, "a", { text: "two" }, 11), cas: undefined };
  expect(applyTeamPatch(canvas, catchUp).nodes.a).toBeUndefined();
});

test("a live room is unchanged (no compare): the later write wins field by field", () => {
  const start = project([node("a", { text: "one" })]);
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: start.nodes, removeNodes: [], upsertAssets: [], order: ["a"], at: 1 });
  canvas = applyTeamPatch(canvas, edit(start, "a", { text: "Ana" }, 10, false));
  canvas = applyTeamPatch(canvas, edit(start, "a", { text: "Bo" }, 11, false));
  expect(canvas.nodes.a.text).toBe("Bo");
});

test("a waiting edit still shows as this window's own while it is sent (the compare is the server's); edits between sends keep the first starting point", () => {
  const start = project([node("a", { text: "one" })]);
  const canvas = { nodes: { a: node("a", { text: "Ana" }) }, assets: {}, order: ["a"], removedIds: [] };
  expect(overlay(canvas, edit(start, "a", { text: "Bo" }, 11)).nodes.a.text).toBe("Bo");
  const mid = { ...start, nodes: [node("a", { text: "two" })] };
  const merged = mergePatches(edit(start, "a", { text: "two" }, 5), edit(mid, "a", { text: "three" }, 6));
  expect(merged).toMatchObject({ cas: true, expect: { a: { text: "one" } }, fields: { a: ["text"] } });
  expect(merged.upsertNodes[0].text).toBe("three");
  expect(mergePatches(edit(start, "a", { text: "two" }, 5, false), edit(mid, "a", { text: "three" }, 6, false)).cas).toBeUndefined();
});

/* ── the route: the server answers which fields it did not write, with who changed them ── */

const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false }) as TenantWorkspace;
const person = (id: string) => ({ user: { id, email: "", name: id, role: "member" as const, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
function loadRoute<T>(file: string, viewer: () => { id: string; role: string }): T {
  const root = process.cwd();
  const real = createRequire(path.resolve(file));
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer() }), requireSession: async () => ({ user: viewer() }), requireRender: async () => ({ user: viewer() }) },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
    "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => null },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(fakes, name) ? fakes[name] : name.startsWith("@/") ? real(path.join(root, name.slice(2))) : real(name)), mod, mod.exports);
  return mod.exports as T;
}

test("the PATCH route: the second window's same-field edit is not written and comes back named with the card as it stands; a different field lands; no compare, as before", async () => {
  const ws = workspace(`cas-${Math.random().toString(36).slice(2, 8)}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db");
  const { teamCanvasReady, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  let who = { id: "u_ana", role: "member" };
  const route = loadRoute<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts", () => who);
  const patch = (body: unknown) => route.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never);
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await teamCanvasReady();
    const db = database.db();
    await db.execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_x','X',0)", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES('prod-1','Shared',0,'prod_x')", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,created_at) VALUES('u_ana','ana@example.test','Ana','x','member',0)", args: [] }).catch(() => {});
    const start = project([node("a", { text: "one", title: "Shot" })]);
    const seed = await patch({ productionId: "prod-1", upsertNodes: start.nodes, removeNodes: [], upsertAssets: [], order: ["a"] });
    expect(seed.status).toBe(200);
    const send = async (as: string, p: TeamPatch) => {
      who = { id: as, role: "member" };
      const res = await patch({ productionId: "prod-1", upsertNodes: p.upsertNodes, fields: p.fields, made: p.made, removeNodes: [], upsertAssets: [], order: null, ...(p.expect ? { expect: p.expect, cas: p.cas } : {}) });
      expect(res.status).toBe(200);
      return (await res.json()) as { revision: number; refused?: { nodeId: string; fields: string[]; node: CanvasNode; by: string | null; at?: number }[] };
    };
    const ana = await send("u_ana", edit(start, "a", { text: "Ana's line" }, 10));
    expect(ana.refused).toBeUndefined();
    const bo = await send("u_bo", edit(start, "a", { text: "Bo's line", title: "Bo's title" }, 11));
    expect(bo.refused).toHaveLength(1);
    expect(bo.refused![0]).toMatchObject({ nodeId: "a", fields: ["text"], node: { id: "a", text: "Ana's line" } });
    expect(bo.refused![0].by).toBe("Ana");
    const saved = (await readTeamCanvas("prod-1"))!.canvas.nodes.a;
    expect(saved, "Ana's text stands; Bo's other field landed").toMatchObject({ text: "Ana's line", title: "Bo's title" });
    /* Bo asks to keep his: the same field sent with no compare is written. */
    const kept = await send("u_bo", edit(start, "a", { text: "Bo's line" }, 12, false));
    expect(kept.refused).toBeUndefined();
    expect((await readTeamCanvas("prod-1"))!.canvas.nodes.a.text).toBe("Bo's line");
    /* A window's own other window: no name. */
    const own = await send("u_bo", edit(start, "a", { text: "Bo again" }, 13));
    expect(own.refused![0].by).toBeNull();
  }, person("u_ana"));
});

test("the PATCH route with a compare: another member of a private board, a viewer of a board shared to look at, and another workspace are refused and nothing is written; the owner is not", async () => {
  const id = Math.random().toString(36).slice(2, 8);
  const ws = workspace(`cas-p-${id}`), other = workspace(`cas-q-${id}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { teamCanvasReady, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { workbenchReady } = await import("../../lib/workbench/records");
  let who = { id: "u_owner", role: "member" };
  const route = loadRoute<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts", () => who);
  const patch = (body: unknown) => route.PATCH(new Request("https://particl.test/api/workbench/team-canvas", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), undefined as never);
  const start = project([node("a", { text: "one" })]);
  const privateBoard = draft.mappedId("prj_wb_", ws.id, "u_owner", "d-private");
  const lookBoard = draft.mappedId("prj_wb_", ws.id, "u_owner", "d-look");
  const body = (pid: string, text: string) => {
    const p = edit(start, "a", { text }, 10);
    return { productionId: pid, upsertNodes: p.upsertNodes, fields: p.fields, made: p.made, removeNodes: [], upsertAssets: [], order: null, expect: p.expect, cas: p.cas };
  };
  const as = async (w: TenantWorkspace, user: string, pid: string, text: string) => {
    who = { id: user, role: "member" };
    return tenant.runInTenant(w, async () => (await patch(body(pid, text))).status, person(user));
  };
  const text = (w: TenantWorkspace, pid: string) => tenant.runInTenant(w, async () => (await readTeamCanvas(pid))!.canvas.nodes.a.text, person("u_owner"));
  const fixture = async (w: TenantWorkspace, boards: { pid: string; draftId: string; flags: Record<string, boolean> }[]) => tenant.runInTenant(w, async () => {
    await database.ready(); await workbenchReady(); await teamCanvasReady();
    const db = database.db();
    await db.execute({ sql: "INSERT OR IGNORE INTO productions(id,name,created_at) VALUES('prod_x','X',0)", args: [] });
    for (const b of boards) {
      await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at,production_id) VALUES(?,?,0,'prod_x')", args: [b.pid, b.draftId] });
      await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`u_owner:${b.draftId}`, "u_owner", b.draftId, b.draftId, JSON.stringify({ ...newProject(b.draftId), id: b.draftId, productionProjectId: b.pid, ...b.flags })] });
      await db.execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,1,'u_owner',1)", args: [b.pid, JSON.stringify({ nodes: { a: node("a", { text: "one" }) }, assets: {}, order: ["a"] })] });
    }
  }, person("u_owner"));
  await fixture(ws, [{ pid: privateBoard, draftId: "d-private", flags: {} }, { pid: lookBoard, draftId: "d-look", flags: { teamShared: true } }]);
  await fixture(other, [{ pid: privateBoard, draftId: "d-private", flags: {} }]);
  expect(await as(ws, "u_mate", privateBoard, "Mate"), "a member on another member's private board").toBe(404);
  expect(await as(ws, "u_mate", lookBoard, "Mate"), "a viewer of a board shared to look at").toBe(404);
  expect(await text(ws, privateBoard)).toBe("one");
  expect(await text(ws, lookBoard)).toBe("one");
  /* The same ids in a workspace the person has no part in (their session is for the first): the board there is not theirs either. */
  expect(await as(other, "u_mate", privateBoard, "Mate"), "another workspace's private board").toBe(404);
  expect(await text(other, privateBoard)).toBe("one");
  /* A production that exists only in the first workspace is not found in another, even for its own owner. */
  expect(await as(workspace(`cas-r-${id}`), "u_owner", lookBoard, "Owner"), "a workspace that does not hold the board").toBe(404);
  expect(await as(ws, "u_owner", privateBoard, "Owner")).toBe(200);
  expect(await text(ws, privateBoard)).toBe("Owner");
  expect(await as(ws, "u_owner", lookBoard, "Owner")).toBe(200);
});
