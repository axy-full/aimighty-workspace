import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBoard } from "../helpers/boardV12";

/* The board frame (item P2-a1: stage rail, stage header, right toolbar, view switch) beside prototype 12's stages. */
test.afterAll(closePrototypeServer);

for (const [stage, query] of [["storyboard", "?view=board&stage=Storyboard"], ["shots", "?view=board&stage=Shots"], ["elements", "?view=board&stage=Elements"]] as const) {
  test(`board · ${stage}`, async ({ page }) => {
    await openBoard(page, `/suites?view=board&stage=${stage}`);
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toBeVisible();
    await page.waitForTimeout(1500);
    await captureBeside(page, `board-${stage}`, query);
  });
}
