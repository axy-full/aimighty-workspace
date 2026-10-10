import { test, expect, type Page } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBoard } from "../helpers/boardV12";
import { openShotsBoard } from "../helpers/shotsV12";

/*
 * The 4-across shot-card grid (item P2-b) beside prototype 12's Storyboard and Shots, with Atomik closed as the
 * prototype's URLs draw them: Storyboard, Shots with its cards finished, and Shots with finished and rendering cards
 * sharing rows (render=batch), where the prototype leaves a gap of about 100 px under its finished cards.
 */
test.afterAll(closePrototypeServer);

async function settle(page: Page) {
  /* Today's dock opens itself on Atomik's questions, a moment after the board: wait for it, then fold it as the prototype's URL draws it. */
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await expect(page.getByTestId("board-agent-panel")).toHaveCount(0);
  const gotIt = page.getByTestId("v12-tools-got-it");
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1500);
}

test("storyboard", async ({ page }) => {
  await openBoard(page, "/suites?view=board&stage=storyboard");
  await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await captureBeside(page, "shots-storyboard", "?view=board&stage=Storyboard");
});

test("shots, finished and rendering together", async ({ page }) => {
  await openShotsBoard(page);
  await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
  await settle(page);
  await captureBeside(page, "shots-batch", "?view=board&stage=Shots&render=batch");
});

test("shots, a card selected", async ({ page }) => {
  await openShotsBoard(page);
  await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
  await settle(page);
  await page.locator('.bd-node[data-card-kind="take"]').nth(1).click();
  await page.mouse.move(700, 120);
  await page.waitForTimeout(800);
  await captureBeside(page, "shots-selected", "?view=board&stage=Shots&render=batch&frame=2");
});

test("storyboard, a frame selected", async ({ page }) => {
  await openBoard(page, "/suites?view=board&stage=storyboard");
  await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await page.locator('.bd-node[data-card-kind="frame"]').nth(1).click();
  await expect(page.getByTestId("frame-details")).toBeVisible();
  await page.mouse.move(700, 120);
  await page.waitForTimeout(800);
  await captureBeside(page, "shots-storyboard-selected", "?view=board&stage=Storyboard&frame=1");
});
