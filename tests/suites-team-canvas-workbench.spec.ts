import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * One shared Rig canvas per production (owner, 2026-09-24). The team canvas
 * is saved on the server per node; opening the Rig folds it into the draft,
 * nodes the canvas never saw join it, and every local edit is sent as a
 * per-node patch. The live room (Liveblocks) rides on the same patches and
 * is off on a local server without the owner's key. The API is what is held here; the two browser tests that drove the old Rig
 * page are gone with it (Q15).
 */
const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

test("the team canvas API: a saved production's canvas is merged per node and keeps what is taken off", async ({ request }) => {
  await signInLocally(request);
  const me = await request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject("Team canvas"), id: `team-${Date.now().toString(36)}`, nodes: [shot("a", "Opening", 0, 0)] };
  const saved = await request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  expect(productionProjectId).toBeTruthy();

  const empty = await request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}`, { headers }).then((r) => r.json());
  expect(empty).toMatchObject({ canvas: null, revision: 0, room: null });
  const first = await request.patch("/api/workbench/team-canvas", { headers, data: { productionId: productionProjectId, upsertNodes: [shot("a", "Opening", 0, 0), shot("b", "Close", 300, 0)], removeNodes: [], upsertAssets: [], order: ["a", "b"] } });
  expect(first.ok(), await first.text()).toBe(true);
  const second = await request.patch("/api/workbench/team-canvas", { headers, data: { productionId: productionProjectId, upsertNodes: [shot("a", "Opening, retitled", 40, 0)], removeNodes: ["b"], upsertAssets: [], order: null } });
  expect(await second.json()).toEqual({ revision: 2 });
  const read = await request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}`, { headers }).then((r) => r.json());
  expect(read.canvas.order).toEqual(["a"]);
  expect(read.canvas.nodes.a).toMatchObject({ title: "Opening, retitled", x: 40 });
  expect(read.canvas.removedIds).toEqual(["b"]);

  expect((await request.get("/api/workbench/team-canvas?productionId=not-here", { headers })).status()).toBe(404);
  expect((await request.patch("/api/workbench/team-canvas", { headers, data: { productionId: productionProjectId, upsertNodes: "x" } })).status()).toBe(400);
  // No Liveblocks secret on a local server: the live room is refused, the saved canvas still works.
  expect((await request.post("/api/collab/auth", { headers, data: { room: `particl:${me.workspace.id}:${productionProjectId}` } })).status()).toBe(503);
});
