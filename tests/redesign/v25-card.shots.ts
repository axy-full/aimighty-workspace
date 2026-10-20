import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";

/*
 * The v25 card (components/v12/board/StepCard.tsx) on its test page, beside the prototype's Shots step, at 1440, 1280 and 1920. The build's
 * data is mock. Run with REDESIGN_PROTOTYPE_DIR=<design/particl-prototype-25> REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" (the offline file: the .dc.html loads React from unpkg, which the screenshot tool refuses).
 */
test.afterAll(closePrototypeServer);
const URL = "mode=director&step=shots";

test("the v25 card, the Shots step beside the prototype", async ({ page }) => {
  await page.goto("/v25-board-parts");
  await expect(page.getByTestId("v25-board-shots")).toBeVisible();
  await page.mouse.move(2, 600);
  await page.waitForTimeout(600);
  await captureBeside(page, "v25-card", URL);
});

test("the v25 card, hovering Shot 4: ✓ ✕ ⋯", async ({ page }) => {
  await page.goto("/v25-board-parts");
  await page.locator('[data-testid="v25-board-shots"] [data-card="s4"]').hover({ position: { x: 100, y: 120 } });
  await page.waitForTimeout(500);
  await captureBeside(page, "v25-card-hover", `${URL}&hovercard=s4`, async (proto) => {
    await proto.locator('[data-card="s4"]').first().hover({ position: { x: 100, y: 120 } });
    await proto.waitForTimeout(400);
  });
});

test("the v25 card, ✕ on Shot 4: the reasons", async ({ page }) => {
  await page.goto("/v25-board-parts");
  const s4 = page.locator('[data-testid="v25-board-shots"] [data-card="s4"]');
  await s4.hover({ position: { x: 100, y: 120 } });
  await s4.getByRole("button", { name: /^Not right/ }).click();
  await page.mouse.move(2, 600);
  await page.waitForTimeout(500);
  await captureBeside(page, "v25-card-reasons", URL, async (proto) => {
    const card = proto.locator('[data-card="s4"]').first();
    await card.hover({ position: { x: 100, y: 120 } });
    await card.getByRole("button", { name: "Reject" }).click();
    await proto.mouse.move(2, 600);
    await proto.waitForTimeout(400);
  });
});
