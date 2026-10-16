import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";

/*
 * Home with "+ New project", and the board it makes (demo plan PR 32 + D-1), at the owner's five sizes, each beside the prototype.
 * Home:  REDESIGN_PROTOTYPE_DIR=<v25 folder> REDESIGN_PROTOTYPE_PAGE="Particl app v25.html" ... -g "Home"
 * Board: REDESIGN_PROTOTYPE_DIR=<v25 folder> REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" ... -g "board"
 */
test.afterAll(closePrototypeServer);

test("v25 Home with New project", async ({ page }) => {
  test.setTimeout(300_000);
  await seedHome(page);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home-new-project")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home-tile")).toHaveCount(6, { timeout: 90_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="v12-home"] img')).every((img) => img.complete), null, { timeout: 30_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await captureBeside(page, "v25-new-project-home", "");
});

test("v25 board made by New project", async ({ page }) => {
  test.setTimeout(300_000);
  await seedHome(page, { takes: 0 });
  await page.goto("/suites?view=home");
  await page.getByTestId("v12-home-new-project").click();
  await expect(page.getByTestId("v12-stage-row").first()).toBeVisible({ timeout: 90_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1200);
  await captureBeside(page, "v25-new-project-board", "mode=director&kind=film&fresh=1");
});
