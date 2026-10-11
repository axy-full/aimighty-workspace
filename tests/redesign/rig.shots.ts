import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openRigBoard, type ShotRow } from "../helpers/rigV12";

/* The Rig (item P5) beside prototype 12's `?view=board&v=rig` (default) and `&rig=input` (one input picked). The board is a
   neutral seeded one (tests/helpers/rigV12.ts); the prototype's own names are samples and never appear in the app. */
test.afterAll(closePrototypeServer);

const MADE: ShotRow[] = Array.from({ length: 8 }, () => ({ status: "succeeded", ageS: 3600 }));

async function openRig(page: import("@playwright/test").Page) {
  await openRigBoard(page, "/suites?view=board&stage=shots&v=rig", { rows: MADE, rig: true });
  await expect(page.getByTestId("v12-rig")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-rig-shot")).toHaveCount(8);
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 8_000 }).then(() => collapse.click()).catch(() => {});
  await page.mouse.move(700, 4);
  await page.waitForTimeout(1200);
}

test("rig · default", async ({ page }) => {
  await openRig(page);
  await captureBeside(page, "rig", "?view=board&v=rig");
});

test("rig · an input picked", async ({ page }) => {
  await openRig(page);
  await page.getByTestId("v12-rig-got-it").click().catch(() => {});
  await page.getByTestId("v12-rig-input").filter({ hasText: "Skipper" }).click();
  await expect(page.getByTestId("v12-rig-price")).toHaveAttribute("data-price-state", /ready|unknown|loading/, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  await captureBeside(page, "rig-input", "?view=board&v=rig&rig=input");
});
