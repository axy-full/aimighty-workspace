import { test, expect, type Page } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openShotsBoard, ROUND_ROWS } from "../helpers/shotsV12";

/*
 * Client rounds (redesign P2-c) beside prototype 12's URLs: the pasted reply and its checklist (`feedback=1&atomik=1`), Round 2
 * on Storyboard and Cut (`round=2&stage=…`), and Compare (`compare=1`). The prototype has no URL for the What changed list
 * from the header's badge (it opens by a click), so that one is shown beside the Cut stage. A round is seeded in the draft
 * with its takes; the first case runs the real ask against the local scripted planner. Nothing is generated or spent.
 */
test.afterAll(closePrototypeServer);

async function settle(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
  const gotIt = page.getByTestId("v12-tools-got-it");
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1200);
}
const takes = (page: Page) => page.locator('.bd-node[data-card-kind="take"]');
const stage = (page: Page, name: string) => page.getByTestId("v12-stage-rail").getByText(name, { exact: true }).click();

test("round · the client's reply, planned", async ({ page }) => {
  test.setTimeout(300_000);
  await openShotsBoard(page, "/suites?view=board&stage=shots");
  await expect(takes(page)).toHaveCount(8, { timeout: 90_000 });
  await settle(page);
  await page.getByTestId("v12-board-bar-inner-input").fill("Loving it. Shot 2 — sphere bigger in the wide. Shot 4: bottle fuller, label to camera. Shot 7 lose the second figure. Rest approved");
  await expect(page.getByTestId("v12-board-bar-price")).toHaveAttribute("data-price-state", "ready", { timeout: 30_000 });
  await page.getByTestId("v12-board-bar-ask").click();
  const plan = page.locator('[data-card-id="plan:run"]').getByTestId("board-plan");
  await expect(plan).toBeVisible({ timeout: 90_000 });
  await plan.getByTestId("board-plan-primary").click();
  await expect(plan.getByTestId("board-plan-primary")).toHaveText(/^Approve all · /, { timeout: 120_000 });
  await page.mouse.move(700, 120);
  await page.waitForTimeout(800);
  await captureBeside(page, "round-feedback", "?view=board&feedback=1&atomik=1");
});

test("round · Round 2 on Storyboard and Cut, the list, Compare", async ({ page }) => {
  test.setTimeout(300_000);
  await openShotsBoard(page, "/suites?view=board&stage=storyboard", { rows: ROUND_ROWS, round: true });
  await expect(page.getByTestId("v12-round-badge")).toHaveText("Round 2 · 3 changed", { timeout: 90_000 });
  await settle(page);
  await expect(page.locator('[data-card-id="round:changed"]')).toBeVisible({ timeout: 30_000 });
  await captureBeside(page, "round-storyboard", "?view=board&round=2&stage=Storyboard");
  await stage(page, "Cut");
  await expect(page.locator('[data-card-id="round:cut"]')).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(700, 120);
  await page.waitForTimeout(800);
  await captureBeside(page, "round-cut", "?view=board&round=2&stage=Cut");
  await page.getByTestId("v12-round-badge").click();
  await expect(page.getByTestId("v12-round-change")).toHaveCount(3);
  await captureBeside(page, "round-changed", "?view=board&round=2&stage=Cut");
  await page.keyboard.press("Escape");
  await page.locator('[data-card-id="round:cut"]').getByTestId("v12-round-compare").click();
  await expect(page.getByTestId("v12-compare")).toBeVisible();
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="v12-compare"] img')).every((img) => img.complete), null, { timeout: 30_000 });
  await captureBeside(page, "round-compare", "?view=board&compare=1");
});
