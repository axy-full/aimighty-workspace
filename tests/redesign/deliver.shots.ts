import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { filmBoard, openBoard } from "../helpers/boardV12";

/* The Deliver stage and the Pre-vis PPM deck (P2-d) beside prototype 12's `?stage=Deliver` and `?project=recipe&stage=PPM deck`. */
test.afterAll(closePrototypeServer);

async function settle(page: import("@playwright/test").Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 8_000 }).then(() => collapse.click()).catch(() => {});
  const gotIt = page.getByTestId("v12-tools-got-it");
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1200);
}

test("deliver", async ({ page }) => {
  await openBoard(page, "/suites?view=board&stage=deliver");
  await expect(page.getByTestId("v12-deliver-stage")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await captureBeside(page, "deliver", "?view=board&stage=Deliver&delivered=1");
});

test("ppm deck", async ({ page }) => {
  await openBoard(page, "/suites?view=board&stage=ppm-deck", { project: { ...filmBoard(), boardKind: "studio", boardFlavor: "previs" } });
  await expect(page.getByTestId("v12-ppm-stage")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await captureBeside(page, "ppm-deck", "?view=board&project=recipe&stage=PPM%20deck");
});
