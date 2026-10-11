import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";

/*
 * Make › Remix (redesign P6-c) beside prototype 12's URL `view=make&mk=Remix`: the four ops with their price line or "quoted", and the
 * note an op gives when there is no source. Nothing is generated or spent.
 */
test.afterAll(closePrototypeServer);

test("remix · the ops and the no-source note", async ({ page }) => {
  test.setTimeout(240_000);
  await seedHome(page, { takes: 4 });
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("radio", { name: "Remix" }).click();
  await expect(page.getByTestId("v12-make-op")).toHaveCount(4);
  await page.locator('[data-op="motion"]').click();
  await expect(page.getByText("Paste a link or drop a video first.")).toBeVisible();
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1200);
  await captureBeside(page, "remix-ops", "?view=make&mk=Remix");
});
