import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openAsTabs, redesignWithBoards } from "../helpers/v12Header";

/*
 * The v25 frame at the five sizes the owner reviews (1280x800, 1440x900, 1728x1117, 1920x1080, 2560x1440; owner, 15 Oct 2026, 22:30):
 * Home and a board on its Shots stage (the starter production: three takes waiting), each beside the prototype.
 * Home:  REDESIGN_PROTOTYPE_DIR=design/particl-prototype-25 REDESIGN_PROTOTYPE_PAGE="Particl app v25.html" ... -g "Home"
 * Board: REDESIGN_PROTOTYPE_DIR=design/particl-prototype-25 REDESIGN_PROTOTYPE_PAGE="Particl board v25.html" ... -g "board"
 */
test.afterAll(closePrototypeServer);

test("v25 Home at the five sizes", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Harbour film · 30 s ad", "Harbour film · social cut"]);
  await openAsTabs(page, ids);
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1200);
  await captureBeside(page, "v25-large-home", "");
});

test("v25 board on its Shots stage at the five sizes", async ({ page }) => {
  const { ids, scope } = (await redesignWithBoards(page, ["Harbour film · 30 s ad"])) as unknown as { ids: string[]; scope: string };
  const made = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { action: "starter" } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = ((await made.json()) as { project: { id: string } }).project.id;
  await openAsTabs(page, [ids[0]]);
  await page.goto(`/suites?view=board&project=${encodeURIComponent(id)}`);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="v12-stage-row"][data-stage="shots"]').click();
  await expect(page.locator('[data-testid="take-card"] img').first()).toBeVisible({ timeout: 60_000 });
  await page.mouse.move(700, 800);
  await page.waitForTimeout(1500);
  await captureBeside(page, "v25-large-board", "mode=director&step=shots");
});
