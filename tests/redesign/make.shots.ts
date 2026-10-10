import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";

/* Make as a page (redesign C3), beside the prototype's `?view=make` and its viewer `?view=make&viewer=1`. The test workspace's own takes. */
test.afterAll(closePrototypeServer);

async function settled(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="v12-make"] img')).every((img) => img.complete), null, { timeout: 30_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

test("make and its viewer beside the prototype", async ({ page }) => {
  test.setTimeout(300_000);
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make-tile")).toHaveCount(6, { timeout: 90_000 });
  await page.getByRole("radio", { name: "Image" }).click();
  await page.getByTestId("v12-make-bar-input").fill("A paper kite over a grey sea");
  await expect(page.getByTestId("v12-make-go")).toHaveText(/Make · \d/, { timeout: 60_000 });
  await settled(page);
  await captureBeside(page, "make", "?view=make");
  await page.goto("/suites?view=make&viewer=1");
  await expect(page.getByTestId("v12-make-viewer")).toBeVisible({ timeout: 90_000 });
  await settled(page);
  await captureBeside(page, "make-viewer", "?view=make&viewer=1");
});
