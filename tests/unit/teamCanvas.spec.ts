import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { applyTeamPatch, diffForTeam, emptyTeamCanvas, joinTeamCanvas, orderedIds, withTeamCanvas } from "../../lib/workbench/team-canvas-model";

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
  const canvas = { nodes: { shared: node("shared", { title: "Team title" }) }, assets: { plate: asset("plate") }, order: ["shared"], removedIds: ["gone"] };
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
    const first = await store.patchTeamCanvas("prod-1", { upsertNodes: [node("a"), node("b")], removeNodes: [], upsertAssets: [asset("plate")], order: ["a", "b"] }, "ana");
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
