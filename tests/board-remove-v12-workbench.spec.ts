import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openBoard } from "./helpers/boardV12";
import { openRigBoard, type ShotRow } from "./helpers/rigV12";

/**
 * Remove, on the canvas (owner, 13 Oct: "Delete/Backspace, right-click › Remove and ⋯ › Remove"): the card leaves the board and goes to the board's Trash;
 * "Removed · Undo" brings it back, and so does ⌘Z; the same through the right-click menu and the ⋯ menu; a locked card says it is locked and nothing
 * leaves; a card the board makes from your work says why it cannot be removed. Desktop only (the new interface's board). BOARD_REMOVE_SHOTS saves screenshots.
 */
const SHOTS = process.env.BOARD_REMOVE_SHOTS;
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }];

async function trash(page: Page, scope: string, projectId: string) {
  const draft = await (await page.request.get(`/api/workbench/projects?id=${projectId}`, { headers: { "X-Workbench-Scope": scope } })).json() as { project?: { productionProjectId?: string } };
  const board = draft.project?.productionProjectId;
  expect(board, "the board's production project").toBeTruthy();
  return async () => ((await (await page.request.get(`/api/boards/${board}/trash`)).json()) as { items: { kind: string; label: string }[] }).items;
}

test.describe("desktop", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "workbench-1440x900" && info.project.name !== "workbench-1920x1080", "desktop sizes"));

  test("Delete, right-click › Remove and ⋯ › Remove take a card off the board into its Trash; Undo and ⌘Z bring it back", async ({ page }) => {
    test.setTimeout(300_000);
    const { project, scope, errors } = await openBoard(page, "/suites?view=board&stage=shots");
    const trashed = await trash(page, scope, project.id);
    const cards = page.locator('.bd-node[data-removable="true"]');
    await expect(cards.first()).toBeVisible({ timeout: 90_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(2);
    const ids = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-card-id")!));
    const card = (id: string) => page.locator(`.bd-node[data-card-id="${id}"]`);
    const toast = page.getByTestId("toast");

    /* Delete, at each size: the card is gone, said with its name and an Undo, and recorded; Undo brings it back and the Trash no longer holds it. */
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.waitForTimeout(400);
      await card(ids[0]).click();
      await page.keyboard.press("Delete");
      await expect(card(ids[0])).toHaveCount(0);
      await expect(toast).toContainText("Removed");
      await expect(page.getByTestId("toast-undo")).toBeVisible();
      /* The toast waits while the pointer is on it. */
      await page.getByTestId("toast").hover();
      if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `removed-toast-${size.width}x${size.height}.png`) }); }
      await expect.poll(async () => (await trashed()).length, { timeout: 30_000 }).toBe(1);
      await page.getByTestId("toast-undo").click();
      await expect(card(ids[0])).toHaveCount(1);
      await expect.poll(async () => (await trashed()).length, { timeout: 30_000 }).toBe(0);
    }
    await page.setViewportSize(SIZES[0]);

    /* Backspace and ⌘Z. */
    await card(ids[1]).click();
    await page.keyboard.press("Backspace");
    await expect(card(ids[1])).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(card(ids[1])).toHaveCount(1);

    /* Right-click › Remove. */
    await card(ids[1]).click({ button: "right" });
    const item = page.getByTestId("v12-card-menu").getByRole("menuitem", { name: /^Remove/ });
    await expect(item).toBeVisible();
    await item.click();
    await expect(card(ids[1])).toHaveCount(0);
    await page.getByTestId("toast-undo").click();
    await expect(card(ids[1])).toHaveCount(1);

    /* ⋯ › Remove, with a selection. */
    await card(ids[2]).click();
    await page.getByTestId("v12-board-menu").click();
    await page.getByTestId("v12-menu-remove").click();
    await expect(card(ids[2])).toHaveCount(0);
    await page.getByTestId("toast-undo").click();
    await expect(card(ids[2])).toHaveCount(1);
    /* With nothing selected the ⋯ menu has no Remove. */
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.getByTestId("v12-board-menu").click();
    await expect(page.getByTestId("v12-menu-remove")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("in the Rig, Delete, right-click › Remove and ⋯ › Remove take a shot off the board into its Trash, with Undo", async ({ page }) => {
    test.setTimeout(300_000);
    const MADE: ShotRow[] = Array.from({ length: 8 }, () => ({ status: "succeeded", ageS: 3600 }));
    const board = await openRigBoard(page, "/suites?view=board&stage=shots&v=rig", { rows: MADE, rig: true });
    await expect(page.getByTestId("v12-rig")).toBeVisible({ timeout: 90_000 });
    const shots = page.getByTestId("v12-rig-shot");
    await expect(shots).toHaveCount(8);
    /* The Atomik dock covers the Rig's right edge: closed, as the Rig's own specs do. */
    const collapse = page.getByTestId("agent-collapse");
    await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (await collapse.isVisible().catch(() => false)) await collapse.click({ timeout: 2_000 }).catch(() => {});
    const trashed = await trash(page, board.scope, board.project.id);
    const toast = page.getByTestId("toast");

    /* Delete on a picked shot. */
    await shots.nth(0).click();
    await page.keyboard.press("Delete");
    await expect(shots).toHaveCount(7);
    await expect(toast).toContainText("Removed");
    await expect.poll(async () => (await trashed()).length, { timeout: 30_000 }).toBe(1);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "rig-removed-1440x900.png") }); }
    await page.getByTestId("toast-undo").click();
    await expect(shots).toHaveCount(8, { timeout: 30_000 });
    await expect.poll(async () => (await trashed()).length, { timeout: 30_000 }).toBe(0);

    /* Right-click › Remove. */
    await shots.nth(1).click({ button: "right" });
    await page.getByTestId("v12-rig-menu-remove").click();
    await expect(shots).toHaveCount(7);
    await page.getByTestId("toast-undo").click();
    await expect(shots).toHaveCount(8, { timeout: 30_000 });

    /* ⋯ › Remove, with a shot picked. */
    await shots.nth(2).click();
    await page.getByTestId("v12-board-menu").click();
    await page.getByTestId("v12-menu-remove").click();
    await expect(shots).toHaveCount(7);
    await page.getByTestId("toast-undo").click();
    await expect(shots).toHaveCount(8, { timeout: 30_000 });
  });

  test("a drawn storyboard frame is removed by its drawing, which goes to the Trash whole (the takes stay in the Library), with Undo", async ({ page }) => {
    test.setTimeout(300_000);
    const { project, scope, errors } = await openBoard(page, "/suites?view=board&stage=storyboard");
    const trashed = await trash(page, scope, project.id);
    const frames = page.locator('.bd-node[data-card-kind="frame"][data-removable="true"]');
    await expect(frames.first()).toBeVisible({ timeout: 90_000 });
    const toast = page.getByTestId("toast");
    await frames.first().click();
    await page.keyboard.press("Delete");
    await expect(toast).toContainText("Removed", { timeout: 30_000 });
    await page.getByTestId("toast").hover();
    await expect.poll(async () => (await trashed()).map((i) => i.kind), { timeout: 30_000 }).toEqual(["frame"]);
    await page.getByTestId("toast-undo").click();
    await expect.poll(async () => (await trashed()).length, { timeout: 30_000 }).toBe(0);
    expect(errors).toEqual([]);
  });
});
