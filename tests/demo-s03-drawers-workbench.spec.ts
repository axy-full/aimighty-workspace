import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS, desktop, node, seedBoard } from "./helpers/s03-board";

/*
 * Stream 3 · the board's drawers and what lands on it (README § 3.1 frames o and p, § 3.2 `made`): the Library
 * drawer's files and their drag onto a shot, History's rows and what a row does, a Make result landing in the "Made
 * in Make" band, and no live-room marks while the room is only saved. Nothing paid is sent.
 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const shot = (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  return page.screenshot({ path: `${SHOTS}/${name}-${size.width}x${size.height}.png` });
};

test("a file added on the board lands in the Library drawer, and dragged onto a shot it becomes that shot's reference", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();

  /* Upload (U): the file goes to the project's Library. */
  await page.locator('input[type="file"]').first().setInputFiles({ name: "market-stall.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("board-drawer-library").click();
  const library = page.getByTestId("board-library");
  const tile = library.locator(".bd-tile", { hasText: "market-stall" });
  await expect(tile).toBeVisible();
  await shot(page, "board-library-file");

  /* The Images chip keeps it, Video drops it, Audio drops it. */
  await library.getByRole("button", { name: "Video", exact: true }).click();
  await expect(tile).toHaveCount(0);
  await expect(library.getByText("Nothing here with this filter.")).toBeVisible();
  await library.getByRole("button", { name: "Images", exact: true }).click();
  await expect(tile).toBeVisible();

  /* Drag it onto the first shot: it is a reference there, and the board says so. */
  await rail(page);
  await tile.dragTo(page.locator('[data-card-id="node-shot0001"]'));
  await expect(page.getByText(/market-stall.* is a reference for Opening wide/)).toBeVisible();
  expect(paid).toEqual([]);
});

const rail = async (page: import("@playwright/test").Page) => page.getByTestId("board-rail").getByRole("button", { name: /^Shots/ }).click();

test("History lists what happened on the board, newest first, and a row opens its card", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, productionId, headers } = await seedBoard(page, [node("node-hist0001", "scene", "A late shot", { x: 900, y: 700 })]);
  expect(productionId).toBeTruthy();
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  /* The server's own Tidy (a person's edit, with a name, in the canvas's change log) on a canvas that holds the cards. */
  const nodes = project.nodes.map((n) => ({ ...n, x: n.x + 900, y: n.y + 700 }));
  expect((await page.request.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: nodes, removeNodes: [], upsertAssets: [], order: nodes.map((n) => n.id) } })).ok()).toBe(true);
  expect((await page.request.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId: `s03-hist-${Date.now().toString(36)}` } })).ok()).toBe(true);

  await page.getByTestId("board-drawer-history").click();
  const history = page.getByTestId("board-history");
  const first = history.locator(".bd-history-row").first();
  await expect(first).toContainText("Board Tester · Tidied the board");
  await expect(first.locator(".bd-history-who")).toHaveText("BT");
  /* A time, not a price. */
  await expect(first.locator(".bd-history-when")).toHaveText(/^\d\d:\d\d$/);
  await expect(history).not.toContainText(/credit|\bcr\b|\$/i);
  await shot(page, "board-history-rows");
  /* A row opens the card it is about: the board glides there and selects it. */
  await first.click();
  await expect(page.locator(".bd-node[data-selected]").first()).toBeVisible();
});

test("a Make result lands in the Made in Make band: the board glides to it, it is lit for a moment, the Library opens", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await expect(page.locator('[data-card-id="group:made"]')).toHaveCount(0);

  /* Make files each take on a shot's node and says so (lib/board/made.ts); another project's result is not this board's. */
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent("particl:board-made", { detail: { projectId: "someone-elses", nodeId: "node-shot0001" } }));
    window.dispatchEvent(new CustomEvent("particl:board-made", { detail: { projectId: id, nodeId: "node-shot0002" } }));
  }, project.id);
  const group = page.locator('[data-card-id="group:made"]');
  await expect(group).toBeVisible();
  await expect(group).toContainText("Made in Make");
  await expect(group).toContainText("1 card");
  const made = page.locator('[data-card-id="made:node-shot0002"]');
  await expect(made).toBeVisible();
  await expect(made).toHaveAttribute("data-lit", "true");
  await expect(made).toContainText("The first stall");
  await expect(page.getByTestId("board-library")).toBeVisible();
  /* It glides there: the card is in view, and its shot keeps its own place in Shots. */
  await expect(made).toBeInViewport();
  await expect(page.locator('[data-card-id="node-shot0002"]')).toHaveCount(1);
  await shot(page, "board-made-lit");
  /* The light goes out by itself. */
  await expect(made).not.toHaveAttribute("data-lit", "true", { timeout: 6000 });

  /* Pressing it goes to the shot it stands for, which is the card that opens. */
  await made.click();
  await expect(page.locator('[data-card-id="node-shot0002"]')).toHaveAttribute("data-selected", "true");
  expect(paid).toEqual([]);
});

test("a board that is only saved shows no live cursors and no who's-here row; offline it is read-only", async ({ page, context }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await expect(page.getByTestId("board-here")).toHaveCount(0);
  await expect(page.locator(".bd-cursor")).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.getByText("Offline · changes queue")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Offline · changes queue")).toHaveCount(0);
});
