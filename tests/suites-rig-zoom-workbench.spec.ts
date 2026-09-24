import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Zoom and pan on the Suites Rig canvas (owner, 2026-09-24; rebuilt from the
 * v2 change request CR1 §6). Pinch or ⌘-wheel zooms about the cursor and the
 * page never zooms or scrolls; a plain wheel or a drag on the empty board
 * pans; − / 100% / + / Fit and ⌘0 / ⌘= / ⌘- step and fit; a node dragged at
 * any zoom moves by what the pointer travelled on the board; the view is
 * remembered for the project on this device.
 */
const DESKTOPS = ["workbench-1440x900"];
const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = { current: { ...newProject("Zoom study"), id: "ws-zoom", productionProjectId: "prod-zoom", shotMappings: {}, nodes: [shot("a", "Opening", 100, 100), shot("b", "Middle", 700, 100), shot("c", "Far", 1900, 1400)] } as Project };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Zoom study");
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  const board = page.getByTestId("rig-graph-surface");
  await expect(board).toBeVisible();
  return { board, errors, store };
}
const node = (page: Page, id: string) => page.locator(`.pxw-graph-node[data-node-id="${id}"]`);

test("⌘-wheel zooms about the cursor without zooming the page; wheel and drag pan; the cluster and keys step and fit", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  const { board, errors } = await open(page);
  await expect(board).toHaveAttribute("data-zoom", "100");
  const b = (await board.boundingBox())!;
  const a0 = (await node(page, "a").boundingBox())!;

  /* ⌘-wheel over node a's corner: zoom in, and that corner stays under the cursor. */
  const at = { x: a0.x + 10, y: a0.y + 10 };
  await page.mouse.move(at.x, at.y);
  const before = await page.evaluate(() => ({ page: window.scrollY, zoom: window.visualViewport?.scale ?? 1 }));
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await board.getAttribute("data-zoom"))).toBeGreaterThan(100);
  const a1 = (await node(page, "a").boundingBox())!;
  expect(Math.abs(a1.x + 10 * (a1.width / a0.width) - at.x)).toBeLessThan(2);
  expect(Math.abs(a1.y + 10 * (a1.width / a0.width) - at.y)).toBeLessThan(2);
  expect(await page.evaluate(() => ({ page: window.scrollY, zoom: window.visualViewport?.scale ?? 1 }))).toEqual(before);

  /* 100% puts it back; + and − step by 125%. */
  await page.getByTestId("rig-zoom-level").click();
  await expect(board).toHaveAttribute("data-zoom", "100");
  await page.getByTestId("rig-zoom-in").click();
  await expect(board).toHaveAttribute("data-zoom", "125");
  await page.getByTestId("rig-zoom-out").click();
  await expect(board).toHaveAttribute("data-zoom", "100");

  /* A plain wheel pans: the content follows the gesture. */
  const p0 = (await node(page, "b").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => Math.round((await node(page, "b").boundingBox())!.y)).toBe(Math.round(p0.y - 200));

  /* A drag on the empty board pans; it does not select anything. */
  const p1 = (await node(page, "b").boundingBox())!;
  const bb = (await board.boundingBox())!;
  expect(bb.y + bb.height).toBeLessThanOrEqual(900);
  await page.mouse.move(bb.x + 20, bb.y + bb.height - 20);
  await page.mouse.down();
  await page.mouse.move(bb.x + 120, bb.y + bb.height - 70, { steps: 5 });
  await page.mouse.up();
  const p2 = (await node(page, "b").boundingBox())!;
  expect(Math.round(p2.x - p1.x)).toBe(100);
  expect(Math.round(p2.y - p1.y)).toBe(-50);

  /* Fit (and ⌘0) shows every node inside the board, never above 100%. */
  await page.getByTestId("rig-zoom-fit").click();
  const bf = (await board.boundingBox())!;
  const fitted = Number(await board.getAttribute("data-zoom"));
  expect(fitted).toBeLessThan(100);
  for (const id of ["a", "b", "c"]) {
    const n = (await node(page, id).boundingBox())!;
    expect(n.x).toBeGreaterThanOrEqual(bf.x);
    expect(n.y).toBeGreaterThanOrEqual(bf.y);
    expect(n.x + n.width).toBeLessThanOrEqual(bf.x + bf.width);
    expect(n.y + n.height).toBeLessThanOrEqual(bf.y + bf.height);
    /* …and clear of the zoom cluster. */
    const z = (await page.getByRole("group", { name: "Zoom" }).boundingBox())!;
    expect(n.x + n.width <= z.x || n.y + n.height <= z.y).toBe(true);
  }
  await page.getByTestId("rig-zoom-level").click();
  await expect(board).toHaveAttribute("data-zoom", "100");
  await page.mouse.move(bf.x + 5, bf.y + 5);
  await page.keyboard.press("ControlOrMeta+0");
  await expect(board).toHaveAttribute("data-zoom", String(fitted));
  await page.keyboard.press("ControlOrMeta+=");
  await expect.poll(async () => Number(await board.getAttribute("data-zoom"))).toBeGreaterThan(fitted);
  expect(errors).toEqual([]);
});

test("a node dragged at 200% moves by what the pointer travelled on the board, and the view is remembered", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  const { board, errors, store } = await open(page);
  const card = node(page, "b");
  /* ⌘-wheel over node b: it stays under the cursor while the board goes to 200%. */
  const b0 = (await card.boundingBox())!;
  await page.mouse.move(b0.x + 20, b0.y + 20);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect(board).toHaveAttribute("data-zoom", "200");
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 + 200, box.y + 20 + 100, { steps: 6 });
  await page.mouse.up();
  /* 200 px on screen at 200% is 100 board units. */
  await expect.poll(() => store.current.nodes.find((n) => n.id === "b")?.x).toBe(800);
  expect(store.current.nodes.find((n) => n.id === "b")?.y).toBe(150);
  await page.reload();
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph-surface")).toHaveAttribute("data-zoom", "200");
  expect(errors).toEqual([]);
});
