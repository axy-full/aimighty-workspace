import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, type LibraryRoute } from "./helpers/workspaceFixtures";

/**
 * SOW §5, high-volume projects: a project with thousands of takes and shots
 * keeps only what is on screen in the page. The Library, the Gen results, the
 * Takes grid and the Rig list each mount a small window of their items and
 * bring the rest in as they scroll; the counts, order and selection behave as
 * before.
 */
const DESKTOP = ["workbench-1440x900"];
const N = 1500;

const shot = (i: number): CanvasNode => ({
  id: `rig-${i}`, title: `Shot ${String(i + 1).padStart(4, "0")}`, type: "scene", x: 100, y: 100 + i * 10, width: 238, linked: [],
  role: "Director", status: "draft", mode: "Video", engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});
const project = (): Project => ({
  ...newProject("Feature volume"), id: "ws-volume", productionProjectId: "prod-ws", shotMappings: {},
  nodes: Array.from({ length: N }, (_, i) => shot(i)),
});
const library = (): LibraryRoute => ({
  pageSize: N,
  uploads: [],
  generations: Array.from({ length: N }, (_, i) => generation({ id: `gen_${i}`, title: `Take ${String(i + 1).padStart(4, "0")}`, createdAt: Date.UTC(2026, 8, 1) + (N - i) * 1000 })),
});

async function open(page: Page, url: string) {
  const account = await signInLocally(page.request);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [account.workspace.id] }); } finally { db.close(); }
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: project() });
  await mockLibrary(page, library());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  return errors;
}

/** Scroll whatever scrolls `list` until `target` is mounted. */
async function scrollUntil(list: Locator, target: Locator) {
  for (let i = 0; i < 80 && !(await target.count()); i++) {
    await list.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      const scrolls = (n: HTMLElement) => ["auto", "scroll"].includes(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1;
      while (node && !scrolls(node)) node = node.parentElement;
      const scroller = node ?? document.scrollingElement!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await list.page().waitForTimeout(40);
  }
}

test("the Rig list mounts a window of a 1,500-shot project and scrolls to the last shot", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const errors = await open(page, "/suites?suite=studio&page=rig");
  const list = page.getByRole("list", { name: "Shots" });
  await expect(list.getByRole("listitem").first()).toContainText("Shot 0001");
  await expect(list).toHaveAttribute("data-virtual", "on");
  expect(await list.locator(".pxw-rig-row").count()).toBeLessThan(80);
  await scrollUntil(list, list.getByText("Shot 1500", { exact: true }));
  await expect(list.getByText("Shot 1500", { exact: true })).toBeVisible();
  expect(await list.locator(".pxw-rig-row").count()).toBeLessThan(80);
  await list.getByText("Shot 1500", { exact: true }).click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Shot 1500");
  expect(errors).toEqual([]);
});

test("the Library and the Gen results mount a window of 1,500 renders", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const errors = await open(page, "/suites?view=gen");
  const grid = page.locator(".gx-gen-grid");
  await expect(grid).toHaveAttribute("data-virtual", "on");
  await expect(grid.locator(".gx-asset").first()).toContainText("Take 0001");
  expect(await grid.locator(".gx-asset").count()).toBeLessThan(120);
  await scrollUntil(grid, grid.getByText("Take 1500", { exact: true }));
  await expect(grid.getByText("Take 1500", { exact: true })).toBeVisible();

  const assets = page.getByTestId("library-assets");
  if (await assets.count()) {
    await expect(assets).toHaveAttribute("data-virtual", "on");
    expect(await assets.locator(".gx-asset").count()).toBeLessThan(80);
    const last = assets.locator(".gx-asset-name", { hasText: /^Take 1500$/ });
    await scrollUntil(assets, last);
    await expect(last).toBeVisible();
    expect(await assets.locator(".gx-asset").count()).toBeLessThan(80);
  }
  expect(errors).toEqual([]);
});

test("the Takes grid mounts a window of 1,500 renders; arrow keys still walk every take and keep the selection in view", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const errors = await open(page, "/workspace?project=ws-volume&suite=particl&page=takes");
  const grid = page.getByTestId("take-grid");
  await expect(grid).toHaveAttribute("data-virtual", "on");
  await expect(grid.locator(".pxw-take-card").first()).toContainText("Take 0001");
  expect(await grid.locator(".pxw-take-card").count()).toBeLessThan(120);
  await grid.locator('[data-take-id="generation:gen_0"]').click();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  const selected = grid.locator('.pxw-take-card[aria-pressed="true"]');
  await expect(selected).toHaveAttribute("data-take-id", "generation:gen_30");
  await expect(selected).toBeInViewport();
  expect(errors).toEqual([]);
});
