import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openLibrary } from "../helpers/libraryV12";

/* The Library tray (item C4) beside prototype 12's `?view=board&drawer=Library`, and over Home. */
test.afterAll(closePrototypeServer);

test("Library tray on a board", async ({ page }) => {
  await openLibrary(page, "/suites?view=board&drawer=Library");
  await expect(page.getByTestId("v12-library-tile")).toHaveCount(7, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  await captureBeside(page, "library", "?view=board&drawer=Library");
});

test("Library tray over Home", async ({ page }) => {
  await openLibrary(page, "/suites?view=home&drawer=Library");
  await expect(page.getByTestId("v12-library-tile")).toHaveCount(7, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  await captureBeside(page, "library-home", "?view=home&drawer=Library");
});
