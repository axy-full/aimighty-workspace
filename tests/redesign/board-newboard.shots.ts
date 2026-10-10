import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBoard } from "../helpers/boardV12";

/* The new-board flow (item P2-a2) beside prototype 12's `?new=1` screens, and a Campaign and a Social rail on a started board. */
test.afterAll(closePrototypeServer);

for (const [name, query, pick] of [
  ["new", "?view=board&new=1", ""],
  ["new-film", "?view=board&new=1&kind=Film", "&pick=film"],
  ["new-campaign", "?view=board&new=1&kind=Campaign", "&pick=campaign"],
  ["new-social", "?view=board&new=1&kind=Social", "&pick=social"],
] as const) {
  test(`new board · ${name}`, async ({ page }) => {
    await openBoard(page, `/suites?view=board&newboard=1${pick}`);
    await expect(page.getByTestId("v12-newboard")).toBeVisible({ timeout: 60_000 });
    await page.mouse.move(700, 120);
    await page.waitForTimeout(1200);
    await captureBeside(page, `board-${name}`, query);
  });
}
