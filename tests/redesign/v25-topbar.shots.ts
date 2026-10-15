import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openAsTabs, redesignWithBoards } from "../helpers/v12Header";

/*
 * The v25 top bar (design/particl-prototype-25) beside the prototype's Home, at 1440, 1280 and 1920: the dot logo, Home and Make,
 * board tabs with letter tiles, the ⌘K bar on the right, the Activity pill and the avatar; and with the ⌘K bar focused (160 px wider).
 * Run with REDESIGN_PROTOTYPE_DIR=design/particl-prototype-25 REDESIGN_PROTOTYPE_PAGE="Particl app v25.html" (the body below the bar is still today's Home).
 */
test.afterAll(closePrototypeServer);

test("the v25 top bar, beside the prototype's Home", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Harbour film · 30 s ad", "Harbour film · social cut"]);
  await openAsTabs(page, ids);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "home");
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1200);
  await captureBeside(page, "v25-topbar", "");
});

test("the v25 top bar with the ⌘K bar focused", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Harbour film · 30 s ad", "Harbour film · social cut"]);
  await openAsTabs(page, ids);
  await page.getByTestId("v12-ask").focus();
  await page.waitForTimeout(800);
  await captureBeside(page, "v25-topbar-focus", "", async (proto) => {
    await proto.locator("button", { hasText: "Ask Atomik, search or go to" }).first().focus();
    await proto.waitForTimeout(400);
  });
});

/* On a board the bar has no Atomik panel button (owner, 15 Oct: ⌘J opens the board's own dock). Run this one with REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" and -g "board". */
test("the v25 top bar on a board: no panel button, the board's own Atomik rail at the right", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Harbour film · 30 s ad", "Harbour film · social cut"]);
  await openAsTabs(page, ids, `/suites?view=board&project=${encodeURIComponent(ids[0])}`);
  await expect(page.getByTestId("agent-rail")).toBeVisible();
  await page.mouse.move(700, 800);
  await page.waitForTimeout(1200);
  await captureBeside(page, "v25-topbar-board", "mode=director&step=shots");
});
