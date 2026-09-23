import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Assets on every page (FINAL_SPEC §1 step 1, README › Drag & drop) and the
 * owner's Rig notes (23 September): a Library render or upload dropped on a Rig
 * canvas node becomes that shot's input, and a brief joins its prompt — as on the
 * list's row — the node lights while the asset hovers, the job is re-filed,
 * the toast names the shot, ⌘Z unfiles it. An upload is refused with the reason.
 */
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const shot = (id: string, title: string, note: string, y: number): CanvasNode => ({
  id, title, type: "scene", x: 100, y, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
  operations: [{ id: `op-${id}`, kind: "direction", enabled: true, values: { note } }],
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});
const fixture = (): Project => ({
  ...newProject("Coastal light study"), id: "ws-rig-drop", productionProjectId: "prod-ws", shotMappings: { "rig-a": "shot_a" }, brief: "A fox crosses the frozen harbour at dusk.",
  nodes: [shot("rig-a", "The encounter", "She enters.", 100), shot("rig-b", "Departure", "Wide again.", 500)],
});

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" })],
  });
  const calls: { method: string; path: string; body: unknown }[] = [];
  await page.route(/\/api\/jobs\/gen_wide(\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") { calls.push({ method: "PATCH", path: "/api/jobs/gen_wide", body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { generation: generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }) } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, calls };
}

/** The Library tile's own drag payload (text/plain = asset id), dropped on a target. */
async function dropTile(page: Page, tileName: string, target: ReturnType<Page["locator"]>) {
  const id = await page.getByTestId("library").locator(`.gx-asset:has([title="${tileName}"])`).getAttribute("data-asset");
  expect(id, `asset id of ${tileName}`).toBeTruthy();
  await target.evaluate((el, assetId) => {
    const data = new DataTransfer();
    data.setData("text/plain", assetId!);
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, id);
  await expect(target).toHaveAttribute("data-drop", "true");
  await target.evaluate((el, assetId) => {
    const data = new DataTransfer();
    data.setData("text/plain", assetId!);
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, id);
  await expect(target).not.toHaveAttribute("data-drop", "true");
}

test("a render or an upload dropped on a Rig node becomes that shot's input; a brief from the Rig library joins its prompt", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths");
  const { errors, calls } = await open(page);
  /* The Rig's own library lists what the project holds, by group. */
  const rigLibrary = page.getByTestId("rig-library");
  await expect(rigLibrary.getByTestId("rig-library-Generations")).toHaveText("Generations · 1");
  await expect(rigLibrary.getByTestId("rig-library-Uploads")).toHaveText("Uploads · 1");

  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph")).toBeVisible();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  const node = page.locator('.pxw-graph-node[data-node-id="rig-a"]');
  await expect(node).toBeVisible();

  await dropTile(page, "Wide on the water", node);
  await expect(page.getByTestId("toast")).toHaveText("Wide on the water is an input of The encounter");
  await dropTile(page, "harbour-plate.webp", node);
  await expect(page.getByTestId("toast")).toHaveText("harbour-plate.webp is an input of The encounter");
  /* Nothing is re-filed as a take any more. */
  expect(calls).toHaveLength(0);

  /* A brief dragged from the Rig library onto a shot joins its prompt. */
  await rigLibrary.getByTestId("rig-library-Briefs").click();
  const brief = rigLibrary.getByTestId("rig-library-item").first();
  const key = await brief.evaluate((el) => { const data = new DataTransfer(); el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true })); return data.getData("text/plain"); });
  expect(key).toMatch(/^brief:/);
  await node.evaluate((el, k) => { const data = new DataTransfer(); data.setData("text/plain", k); el.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true })); el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })); }, key);
  await expect(page.getByTestId("toast")).toHaveText(/is in The encounter’s prompt$/);
  expect(errors).toEqual([]);
});
