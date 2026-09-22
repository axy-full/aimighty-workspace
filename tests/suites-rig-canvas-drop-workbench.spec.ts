import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Assets on every page (FINAL_SPEC §1 step 1, README › Drag & drop): a Library
 * render dropped on a Rig canvas node is filed on that shot, exactly as on the
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
  ...newProject("Coastal light study"), id: "ws-rig-drop", productionProjectId: "prod-ws", shotMappings: { "rig-a": "shot_a" },
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

test("a render dropped on a Rig canvas node is filed on that shot; an upload is refused; ⌘Z unfiles", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths");
  const { errors, calls } = await open(page);
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph")).toBeVisible();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  const node = page.locator('.pxw-graph-node[data-node-id="rig-a"]');
  await expect(node).toBeVisible();

  await dropTile(page, "Wide on the water", node);
  await expect(page.getByTestId("toast")).toHaveText("Wide on the water filed on The encounter");
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/jobs/gen_wide", body: { shotId: "shot_a" } });

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toHaveText(/unfiled from The encounter/);
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/jobs/gen_wide", body: { shotId: null } });

  await dropTile(page, "harbour-plate.webp", node);
  await expect(page.getByTestId("toast")).toHaveText("Only a render can be filed on a shot. Use it as a reference instead.");
  expect(calls).toHaveLength(2);
  expect(errors).toEqual([]);
});
