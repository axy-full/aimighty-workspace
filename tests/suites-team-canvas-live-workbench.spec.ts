import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { kindSectionId } from "../lib/workspace/rig-board";

const shot = (id: string, title: string, x: number, y: number, linked: string[] = []): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});
/* Drafted scattered: b takes a as its input; c stands alone. */
const board = () => [shot("a", "Harbour wide", 900, 700), shot("b", "The encounter", 100, 1200, ["a"]), shot("c", "Departure", 1500, 100)];
/* Tidied by sections (lib/workspace/rig-board.ts): the Shots title made at (60,60), a (60,140), b (60,400), c (60,660), shots down
   their column in canvas order; on the graph, shifted to the top-left card (the title). */
const SHOTS = kindSectionId("shots");const TIDIED_AT = { a: [60, 140], b: [60, 400], c: [60, 660], [SHOTS]: [60, 60] };
async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `live-${Date.now().toString(36)}`, nodes: board() };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}



const canvasOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode> } | null; server: { what: string } | null };






test("the canvas action API: Tidy is free, checked, scoped to this workspace, and a repeated press changes nothing twice", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: API only");
  const { headers, productionId } = await setUp(page, "Tidy API");
  const api = page.request;
  /* The Rig opens the canvas first; a production nobody opened has nothing to tidy. */
  expect((await api.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: board(), removeNodes: [], upsertAssets: [], order: ["a", "b", "c"] } })).ok()).toBe(true);
  const head = async () => api.get(`/api/workbench/team-canvas?productionId=${productionId}&head=1`, { headers }).then((r) => r.json());
  expect(await head()).toEqual({ head: true, revision: 1, server: null });
  expect((await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId } })).status()).toBe(400);
  expect((await api.post("/api/workbench/team-canvas", { headers, data: { action: "explode", productionId, opId: "abcdefgh" } })).status()).toBe(400);
  expect((await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId: "not-here", opId: "abcdefgh" } })).status()).toBe(404);
  expect((await api.post("/api/workbench/team-canvas", { data: { action: "tidy", productionId, opId: "abcdefgh" } })).status()).toBe(409);
  const opId = `api-${Date.now().toString(36)}`;
  const first = await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId } }).then((r) => r.json());
  expect(first).toEqual({ revision: 2, moved: 3, sections: 1, live: "off", credits: 0 });
  /* The same press arriving twice: the same answer, and the canvas does not move again. */
  expect(await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId } }).then((r) => r.json())).toEqual(first);
  const light = await head();
  expect(light).toMatchObject({ head: true, revision: 2, server: { what: "tidy", agent: false } });
  const full = await canvasOf(api, headers, productionId);
  expect(full.server).toEqual(light.server);
  expect(Object.fromEntries(Object.entries(full.canvas!.nodes).map(([id, n]) => [id, [n.x, n.y]]))).toEqual(TIDIED_AT);
  /* A new press on a tidy board: nothing to move, and no news for open windows. */
  expect(await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId: `${opId}-again` } }).then((r) => r.json())).toEqual({ revision: 2, moved: 0, sections: 0, live: "off", credits: 0 });
  expect((await head()).server).toEqual(light.server);
});
