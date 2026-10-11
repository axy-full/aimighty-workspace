import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBilling } from "../helpers/billingV12";

/*
 * Credits & billing reachable (fix/r1-credits-reachable): the avatar menu beside prototype 12's, and the house workspace's
 * dollar page beside `?view=billing` (the prototype has no house variant, so it is the layout reference). Nothing is spent.
 */
test.afterAll(closePrototypeServer);

const TEAM = "/suites?view=workspace&tab=team";

test("the avatar menu: balance, Top up, Credits & billing", async ({ page }) => {
  await openBilling(page, { path: TEAM });
  await expect(page.getByTestId("settings-section-credits")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("v12-avatar").click();
  await expect(page.getByTestId("v12-account-topup")).toBeVisible();
  await page.mouse.move(900, 600);
  await page.waitForTimeout(800);
  await captureBeside(page, "credits-avatar", "?", async (proto) => { await proto.getByText("AP", { exact: true }).first().click(); });
});

test("the avatar menu for a member: who can ask", async ({ page }) => {
  await openBilling(page, { path: TEAM, canRequest: false });
  await expect(page.getByTestId("settings-section-credits")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("v12-avatar").click();
  await expect(page.getByTestId("v12-account-ask-admin")).toBeVisible();
  await page.mouse.move(900, 600);
  await page.waitForTimeout(800);
  await captureBeside(page, "credits-avatar-member", "?", async (proto) => { await proto.getByText("AP", { exact: true }).first().click(); });
});

test("the house workspace: Credits & billing in dollars", async ({ page }) => {
  await openBilling(page, { house: true });
  await expect(page.getByTestId("v12-billing-board")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("v12-billing-history-row").first()).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "credits-house", "?view=billing");
});

test("the house workspace's avatar menu", async ({ page }) => {
  await openBilling(page, { house: true, path: TEAM });
  await expect(page.getByTestId("settings-section-credits")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("v12-avatar").click();
  await expect(page.getByTestId("v12-account-no-topup")).toBeVisible();
  await page.mouse.move(900, 600);
  await page.waitForTimeout(800);
  await captureBeside(page, "credits-avatar-house", "?", async (proto) => { await proto.getByText("AP", { exact: true }).first().click(); });
});
