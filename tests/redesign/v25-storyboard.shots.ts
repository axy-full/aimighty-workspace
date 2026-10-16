import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBoard } from "../helpers/boardV12";

/*
 * Storyboard (demo plan PR 18) at the owner's five sizes, beside the prototype's board:
 * REDESIGN_PROTOTYPE_DIR=<v25 folder> REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" ... v25-storyboard
 */
test.afterAll(closePrototypeServer);

test("v25 Storyboard step", async ({ page }) => {
  test.setTimeout(300_000);
  await openBoard(page, "/suites?view=board&stage=storyboard");
  await expect(page.getByTestId("v12-storyboard-stage").getByTestId("v12-card")).toHaveCount(8, { timeout: 90_000 });
  await expect(page.getByTestId("v12-storyboard-draw")).toHaveAttribute("data-spend", "priced", { timeout: 90_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1200);
  await captureBeside(page, "v25-storyboard", "mode=director&kind=film&step=storyboard");
});

test("v25 Storyboard, the board sheet", async ({ page }) => {
  test.setTimeout(300_000);
  await openBoard(page, "/suites?view=board&stage=storyboard");
  await expect(page.getByTestId("v12-storyboard-stage").getByTestId("v12-card")).toHaveCount(8, { timeout: 90_000 });
  await page.getByTestId("v12-storyboard-sheet").click();
  await expect(page.getByTestId("v12-sheet-page")).toHaveCount(2);
  await page.waitForTimeout(800);
  await captureBeside(page, "v25-storyboard-sheet", "mode=director&kind=film&step=storyboard");
});
