import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { applyTeamPatch, diffForTeam, emptyTeamCanvas, joinTeamCanvas, orderedIds, withTeamCanvas, liveCanvasAssets } from "../../lib/workbench/team-canvas-model";

/* Owner, 2026-09-24: one shared Rig canvas per production, edited live by the team. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-team-canvas-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [], ...extra });
const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, name: id, kind: "image", category: "Shot", url: `/a/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
const project = (nodes: CanvasNode[], assets: Asset[] = []): Project => ({ ...newProject("Team"), id: "draft-a", productionProjectId: "prod-1", nodes, assets });

test("a local edit becomes a per-node patch carrying the assets its nodes use, and nothing else", () => {
  const before = project([node("a"), node("b")], [asset("plate"), asset("private")]);
  const after = { ...before, nodes: [node("a", { title: "Moved", x: 40, assetId: "plate" }), node("b"), node("c")] };
  const patch = diffForTeam(before, after, 5)!;
  expect(patch.upsertNodes.map((n) => n.id)).toEqual(["a", "c"]);
  expect(patch.removeNodes).toEqual([]);
  expect(patch.upsertAssets.map((a) => a.id)).toEqual(["plate"]);
  expect(patch.order).toEqual(["a", "b", "c"]);
  expect(diffForTeam(after, { ...after }, 6)).toBeNull();
  expect(diffForTeam(after, { ...after, nodes: [after.nodes[0], after.nodes[2]] }, 7)).toMatchObject({ removeNodes: ["b"], upsertNodes: [] });
});

test("writes settle per node by time; a node taken off the canvas is kept whole, and a later write brings it back", () => {
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [node("a"), node("b")], removeNodes: [], upsertAssets: [], order: ["a", "b"], at: 10 });
  canvas = applyTeamPatch(canvas, { upsertNodes: [node("a", { title: "Newer" })], removeNodes: [], upsertAssets: [], order: null, at: 20 });
  canvas = applyTeamPatch(canvas, { upsertNodes: [node("a", { title: "Stale" })], removeNodes: [], upsertAssets: [], order: null, at: 15 });
  expect(canvas.nodes.a.title).toBe("Newer");
  canvas = applyTeamPatch(canvas, { upsertNodes: [], removeNodes: ["b"], upsertAssets: [], order: null, at: 30 });
  expect(canvas.nodes.b).toBeUndefined();
  expect(canvas.removed.b).toMatchObject({ id: "b" });
  expect(orderedIds(canvas)).toEqual(["a"]);
  canvas = applyTeamPatch(canvas, { upsertNodes: [node("b", { title: "Back" })], removeNodes: [], upsertAssets: [], order: ["b", "a"], at: 40 });
  expect(canvas.removed.b).toBeUndefined();
  expect(orderedIds(canvas)).toEqual(["b", "a"]);
});

test("joining folds the canvas in, adds nodes it never saw, and leaves a teammate's removal removed", () => {
  const canvas = { nodes: { shared: node("shared", { title: "Team title", assetId: "plate" }) }, assets: { plate: asset("plate") }, order: ["shared"], removedIds: ["gone"] };
  const mine = project([node("shared", { title: "My old title" }), node("private", { assetId: "mine" }), node("gone")], [asset("mine"), asset("other")]);
  const { project: joined, patch } = joinTeamCanvas(mine, canvas, 50);
  expect(joined.nodes.map((n) => [n.id, n.title])).toEqual([["shared", "Team title"], ["private", "private"]]);
  expect(joined.assets.map((a) => a.id).sort()).toEqual(["mine", "other", "plate"]);
  expect(patch).toMatchObject({ upsertNodes: [{ id: "private" }], upsertAssets: [{ id: "mine" }], order: ["shared", "private"] });
  // Already in step: nothing to send, and the same object comes back so nothing re-saves.
  const again = joinTeamCanvas(joined, { ...canvas, nodes: { shared: joined.nodes[0], private: joined.nodes[1] }, order: ["shared", "private"], assets: { plate: asset("plate"), mine: asset("mine") } }, 60);
  expect(again.patch).toBeNull();
  expect(withTeamCanvas(joined, { nodes: { shared: joined.nodes[0], private: joined.nodes[1] }, assets: { plate: asset("plate"), mine: asset("mine") }, order: ["shared", "private"] })).toBe(joined);
});

test("the server canvas: only a production of this workspace, patches merged per node, removals kept, rooms scoped to the workspace", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const store = await import("../../lib/workbench/team-canvas");
  const ws = { id: "team", name: "team", slug: "team", dbUrl: `file:${path.join(dir, "team.db")}`, legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    await ready();
    await expect(store.requireProduction("prod-1")).rejects.toThrow("not in this workspace");
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)", args: [] });
    await store.requireProduction("prod-1");
    expect(await store.readTeamCanvas("prod-1")).toBeNull();
    const first = await store.patchTeamCanvas("prod-1", { upsertNodes: [node("a"), node("b", { assetId: "plate" })], removeNodes: [], upsertAssets: [asset("plate")], order: ["a", "b"] }, "ana");
    expect(first.revision).toBe(1);
    await store.patchTeamCanvas("prod-1", { upsertNodes: [node("a", { x: 99 })], removeNodes: ["b"], upsertAssets: [], order: null }, "bo");
    const saved = (await store.readTeamCanvas("prod-1"))!;
    expect(saved.revision).toBe(2);
    expect(saved.canvas.nodes.a.x).toBe(99);
    expect(Object.keys(saved.canvas.nodes)).toEqual(["a"]);
    expect(saved.canvas.removed.b).toMatchObject({ id: "b" });
    expect(saved.canvas.assets.plate).toMatchObject({ id: "plate" });
  });
  expect(store.teamRoomFor("team", "prod-1")).toBe("particl:team:prod-1");
  expect(store.productionOfRoom("particl:team:prod-1", "team")).toBe("prod-1");
  expect(store.productionOfRoom("particl:other:prod-1", "team")).toBeNull();
  expect(store.productionOfRoom("particl:team:../x", "team")).toBeNull();
  const parsed = store.teamPatchSchema.safeParse({ productionId: "prod-1", upsertNodes: [node("a")], removeNodes: [], upsertAssets: [], order: null });
  expect(parsed.success).toBe(true);
  expect(store.teamPatchSchema.safeParse({ productionId: "../prod", upsertNodes: [], removeNodes: [], upsertAssets: [], order: null }).success).toBe(false);
});

test("an asset no node uses any more is retired, not erased; a node taken off keeps its own so it comes back whole", () => {
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [node("a", { assetId: "p1" }), node("b", { assetId: "p2" })], removeNodes: [], upsertAssets: [asset("p1"), asset("p2"), asset("take", { nodeId: "a" })], order: ["a", "b"], at: 10 });
  expect(Object.keys(canvas.assets).sort()).toEqual(["p1", "p2", "take"]);
  // "a" now shows another picture: the one it left is no longer shared.
  canvas = applyTeamPatch(canvas, { upsertNodes: [node("a", { assetId: "p3" })], removeNodes: [], upsertAssets: [asset("p3")], order: null, at: 20 });
  expect(Object.keys(canvas.assets).sort()).toEqual(["p2", "p3", "take"]);
  expect(Object.keys(canvas.retired)).toEqual(["p1"]);
  expect(canvas.stamps["a:p1"]).toBe(10);
  // "b" is taken off: kept whole with its picture, but no draft is handed that picture while it is off.
  canvas = applyTeamPatch(canvas, { upsertNodes: [], removeNodes: ["b"], upsertAssets: [], order: null, at: 30 });
  expect(Object.keys(canvas.assets).sort()).toEqual(["p2", "p3", "take"]);
  expect(liveCanvasAssets(canvas).map((a) => a.id).sort()).toEqual(["p3", "take"]);
  // An asset sent with no node that uses it is not shared, only kept.
  canvas = applyTeamPatch(canvas, { upsertNodes: [], removeNodes: [], upsertAssets: [asset("stray")], order: null, at: 40 });
  expect(canvas.assets.stray).toBeUndefined();
  expect(canvas.retired.stray).toEqual(asset("stray"));
});

test("a teammate's stale edit that points a node back at a retired asset brings the asset back", () => {
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: [node("x", { assetId: "a1" })], removeNodes: [], upsertAssets: [asset("a1")], order: ["x"], at: 10 });
  // B moves x to another picture: a1 is retired.
  canvas = applyTeamPatch(canvas, { upsertNodes: [node("x", { assetId: "a2" })], removeNodes: [], upsertAssets: [asset("a2")], order: null, at: 20 });
  expect(canvas.assets.a1).toBeUndefined();
  // A, still showing x on a1, edits its prompt; a1 is not resent, since A's view already had it.
  const stale = project([node("x", { assetId: "a1" })], [asset("a1")]);
  const patch = diffForTeam(stale, { ...stale, nodes: [node("x", { assetId: "a1", text: "Push in." })] }, 30)!;
  expect(patch.upsertAssets).toEqual([]);
  canvas = applyTeamPatch(canvas, patch);
  expect(canvas.nodes.x.assetId).toBe("a1");
  expect(canvas.assets.a1).toEqual(asset("a1"));
  expect(Object.keys(canvas.retired)).toEqual(["a2"]);
  // A teammate who joins now gets the picture the node shows.
  const joined = withTeamCanvas(project([], []), canvas);
  expect(joined.assets.map((a) => a.id)).toEqual(["a1"]);
});

test("folding the canvas in never puts back an asset the draft removed and no live node uses", () => {
  const canvas = { nodes: { a: node("a", { assetId: "p3" }) }, assets: { p1: asset("p1"), p3: asset("p3") }, order: ["a"] };
  const draft = project([node("a", { assetId: "p3" })], [asset("mine"), asset("p3")]);
  const folded = withTeamCanvas(draft, canvas);
  expect(folded).toBe(draft);
  expect(folded.assets.map((a) => a.id).sort()).toEqual(["mine", "p3"]);
});

test("media on a live canvas node cannot be deleted from the Library; once off the canvas, it can", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const store = await import("../../lib/workbench/team-canvas");
  const { workbenchReady, workbenchTransaction } = await import("../../lib/workbench/records");
  const { mediaBindingProblem } = await import("../../lib/mediaBindings");
  const ws = { id: "team-media", name: "team", slug: "team", dbUrl: `file:${path.join(dir, "team-media.db")}`, legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    await ready();
    await workbenchReady();
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-1','Team',0)", args: [] });
    const take = asset("take-1", { url: "/api/media/gen-take", generationId: "gen-take" });
    await store.patchTeamCanvas("prod-1", { upsertNodes: [node("a", { assetId: "take-1" })], removeNodes: [], upsertAssets: [take], order: ["a"] }, "ana");
    expect(await workbenchTransaction((tx) => mediaBindingProblem(tx, "generation", "gen-take"))).toMatch(/shared Rig canvas/);
    await store.patchTeamCanvas("prod-1", { upsertNodes: [node("a")], removeNodes: [], upsertAssets: [], order: null }, "ana");
    expect((await store.readTeamCanvas("prod-1"))!.canvas.retired["take-1"]).toEqual(take);
    expect(await workbenchTransaction((tx) => mediaBindingProblem(tx, "generation", "gen-take"))).toBeNull();
    /* Only a canvas that names the media is read: a damaged one blocks only the media it mentions. */
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-2','Other',0)", args: [] });
    await db().execute({ sql: "INSERT INTO workbench_team_canvas(production_id,body,revision,updated_at) VALUES('prod-2','{\"nodes\":{\"b\":{\"assetId\":\"/api/media/gen-other\"',1,0)", args: [] });
    expect(await workbenchTransaction((tx) => mediaBindingProblem(tx, "generation", "gen-take"))).toBeNull();
    expect(await workbenchTransaction((tx) => mediaBindingProblem(tx, "generation", "gen-other"))).toMatch(/could not be checked/);
  });
});
