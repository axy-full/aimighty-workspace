import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { filmBoard, openBoard } from "../helpers/boardV12";

/*
 * Brief and Script (demo plan PR 11) at the owner's five sizes, each beside the prototype's board. The prototype's Brief and Script steps:
 * REDESIGN_PROTOTYPE_DIR=<v25 folder> REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" ... v25-text-steps
 */
test.afterAll(closePrototypeServer);
const SCRIPT = "PICTURE: Harbour, dawn. SOUND: Gulls, a rope on a cleat.\nVO (SKIPPER): “Every morning starts the same.”\n\nPICTURE: The boat pulls away.\nSOUND: The engine catches.";
const board = () => ({ ...filmBoard(), script: SCRIPT });

test("v25 Brief step", async ({ page }) => {
  test.setTimeout(300_000);
  await openBoard(page, "/suites?view=board&stage=brief", { project: board() });
  await expect(page.getByTestId("v12-text-stage")).toBeVisible({ timeout: 90_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await captureBeside(page, "v25-text-brief", "mode=director&kind=film&step=brief");
});

test("v25 Script step", async ({ page }) => {
  test.setTimeout(300_000);
  await openBoard(page, "/suites?view=board&stage=script", { project: board() });
  await expect(page.getByTestId("v12-text-stage")).toBeVisible({ timeout: 90_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await captureBeside(page, "v25-text-script", "mode=director&kind=film&step=script");
});

test("v25 Script, the Hindi script made", async ({ page }) => {
  test.setTimeout(300_000);
  await openBoard(page, "/suites?view=board&stage=script", { project: board() });
  await page.getByTestId("v12-text-stage").locator('[data-card="script"]').click();
  await page.getByRole("radio", { name: "हिन्दी" }).click();
  const make = page.getByTestId("v12-hindi-make");
  await expect(make).toHaveAttribute("data-spend", "priced", { timeout: 60_000 });
  await make.click();
  await expect(page.getByTestId("v12-hindi-words")).toHaveValue(/नमूना/);
  await page.waitForTimeout(500);
  await captureBeside(page, "v25-text-hindi", "mode=director&kind=film&step=script");
});
