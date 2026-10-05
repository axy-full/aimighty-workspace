import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { applyTeamPatch, emptyTeamCanvas, orderedIds, type TeamCanvas } from "../lib/workbench/team-canvas-model";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * One shared Rig canvas per production (owner, 2026-09-24). The team canvas
 * is saved on the server per node; opening the Rig folds it into the draft,
 * nodes the canvas never saw join it, and every local edit is sent as a
 * per-node patch. The live room (Liveblocks) rides on the same patches and
 * is off on a local server without the owner's key.
 */
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
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

/** The team canvas route, in memory, with the server's own merge. */
async function mockTeamCanvas(page: Page, canvas: TeamCanvas) {
  const store = { canvas, patches: [] as { upsertNodes: CanvasNode[]; removeNodes: string[]; order: string[] | null }[] };
  await page.route("**/api/workbench/team-canvas**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { canvas: { nodes: store.canvas.nodes, assets: store.canvas.assets, order: orderedIds(store.canvas), removedIds: Object.keys(store.canvas.removed) }, revision: store.patches.length + 1, room: null } });
    const body = request.postDataJSON();
    store.patches.push(body);
    store.canvas = applyTeamPatch(store.canvas, { ...body, at: Date.now() });
    return route.fulfill({ json: { revision: store.patches.length + 1 } });
  });
  return store;
}


test("an edit made just before the page reloads still reaches the team canvas, so the next open does not undo it", async ({ page }, info) => {
  /* Real server throughout: a request sent while a page unloads bypasses route mocks. */
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject("Reload study"), id: `team-reload-${Date.now().toString(36)}`, nodes: [shot("rig-a", "The encounter", 100, 100)] };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  const canvas = async () => (await page.request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}`, { headers }).then((r) => r.json())).canvas;

  await page.goto(`/workspace?project=${draft.id}&suite=particl&page=rig&sel=shot:rig-a`);
  await expect(page.getByTestId("rig-team")).toContainText("Team canvas");
  await expect.poll(async () => (await canvas())?.order ?? []).toEqual(["rig-a"]);
  await expect(page.getByTestId("shot-duration")).toHaveText("5s");
  await page.getByRole("button", { name: "Longer" }).click();
  await expect(page.getByTestId("shot-duration")).toHaveText("6s");
  await page.reload();
  await expect.poll(async () => (await canvas())?.nodes["rig-a"]?.durationS).toBe(6);
  await expect(page.getByTestId("shot-duration")).toHaveText("6s");
});

test("an edit made while the team canvas is still loading is kept, not overwritten by the older canvas", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject("Early edit study"), id: `team-early-${Date.now().toString(36)}`, nodes: [shot("rig-a", "The encounter", 100, 100)] };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  /* The canvas already holds this shot at 5 s, as a teammate left it. */
  expect((await page.request.patch("/api/workbench/team-canvas", { headers, data: { productionId: productionProjectId, upsertNodes: [shot("rig-a", "The encounter", 100, 100)], removeNodes: [], upsertAssets: [], order: ["rig-a"] } })).ok()).toBe(true);
  /* The canvas answer is slow; the edit lands before it does. */
  await page.route(/\/api\/workbench\/team-canvas\?/, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
  await page.goto(`/workspace?project=${draft.id}&suite=particl&page=rig&sel=shot:rig-a`);
  await expect(page.getByTestId("shot-duration")).toHaveText("5s");
  await expect(page.getByTestId("rig-team")).toHaveCount(0);
  await page.getByRole("button", { name: "Longer" }).click();
  await expect(page.getByTestId("shot-duration")).toHaveText("6s");
  await expect(page.getByTestId("rig-team")).toContainText("Team canvas");
  await expect(page.getByTestId("shot-duration")).toHaveText("6s");
  const canvas = async () => (await page.request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}`, { headers }).then((r) => r.json())).canvas;
  await expect.poll(async () => (await canvas())?.nodes["rig-a"]?.durationS).toBe(6);
  await expect.poll(async () => (await page.request.get(`/api/workbench/projects?id=${draft.id}`, { headers }).then((r) => r.json())).project.nodes[0].durationS).toBe(6);
});
