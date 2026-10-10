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
    /* As the prototype's URL draws it: Atomik closed (today's dock opens itself on questions; collapsed here) and the tools
       past their first visit (the labels are `?first=1`'s). */
    const collapse = page.getByTestId("agent-collapse");
    if (await collapse.isVisible().catch(() => false)) await collapse.click();
    const gotIt = page.getByTestId("v12-tools-got-it");
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
    await page.mouse.move(700, 120);
    await page.waitForTimeout(1500);
    await captureBeside(page, `board-${stage}`, query);
  });
}
