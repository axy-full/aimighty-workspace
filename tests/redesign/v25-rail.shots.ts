import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";

/*
 * The v25 stepper rail (components/v12/board/StepRail.tsx) on its test page, beside the prototype's Shots step, at 1440, 1280 and 1920. The
 * build's steps are mock. Run with REDESIGN_PROTOTYPE_DIR=<design/particl-prototype-25> REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" (the
 * offline file: the .dc.html loads React from unpkg, which the screenshot tool refuses).
 */
test.afterAll(closePrototypeServer);

test("the v25 rail, ten Film steps beside the prototype", async ({ page }) => {
  await page.goto("/v25-rail-parts");
  await expect(page.getByTestId("v25-rail-film")).toBeVisible();
  await page.mouse.move(700, 700);
  await page.waitForTimeout(700);
  await captureBeside(page, "v25-rail", "mode=director&step=shots");
});

test("the v25 rail, hovering a step: the tooltip carries its status", async ({ page }) => {
  await page.goto("/v25-rail-parts");
  await page.locator('[data-testid="v25-rail-film"] [data-step="edit"]').hover();
  await page.waitForTimeout(900);
  await captureBeside(page, "v25-rail-tip", "mode=director&step=shots", async (proto) => {
    await proto.locator('[data-rail-step="edit"]').first().hover();
    await proto.waitForTimeout(900);
  });
});
