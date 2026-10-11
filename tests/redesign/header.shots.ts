import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openAsTabs, redesignWithBoards } from "../helpers/v12Header";

/* The header (item A2) beside the prototype's Home, and with Activity open. The body below it is still today's Home. */
test.afterAll(closePrototypeServer);

test("the header, beside the prototype's Home", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Launch clips · 30 s ad", "Mirror film"]);
  await openAsTabs(page, ids);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "home");
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1200);
  await captureBeside(page, "header", "?");
});

test("the header with Activity open", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Launch clips · 30 s ad", "Mirror film"]);
  await openAsTabs(page, ids, "/suites?view=home&activity=1");
  await expect(page.getByTestId("v12-activity-menu")).toBeVisible();
  await page.waitForTimeout(1200);
  await captureBeside(page, "header-activity", "?activity=1");
});
