import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openAsTabs, redesignWithBoards } from "../helpers/v12Header";
import { openShotsBoard } from "../helpers/shotsV12";

/*
 * The v25 frame at the five sizes the owner reviews (1280x800, 1440x900, 1728x1117, 1920x1080, 2560x1440; owner, 15 Oct 2026, 22:30):
 * Home and a board on its Shots stage (the prototype's eight shots: three finished, two rendering, three not started), each beside the prototype.
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
  /* The prototype's board: eight shots in mixed states (three finished, two rendering, three not started), Atomik's dock folded as the prototype draws it. */
  await openShotsBoard(page, "/suites?view=board&stage=shots");
  await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
  await expect(page.locator('.bd-node[data-card-kind="take"] img, .bd-node[data-card-kind="take"] video').first()).toBeVisible({ timeout: 60_000 });
  await page.mouse.move(700, 800);
  await page.waitForTimeout(1500);
  await captureBeside(page, "v25-large-board", "mode=director&step=shots");
});
