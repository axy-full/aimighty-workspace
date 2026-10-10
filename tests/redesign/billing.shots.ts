import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBilling } from "../helpers/billingV12";

/* Settings › Credits & billing (item B2) beside prototype 12's `?view=billing`, and with the balance low. */
test.afterAll(closePrototypeServer);

test("Credits & billing", async ({ page }) => {
  await openBilling(page);
  await expect(page.getByTestId("v12-billing-board")).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByTestId("v12-billing-history-row").first()).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "billing", "?view=billing");
});

test("Credits & billing, balance low", async ({ page }) => {
  await openBilling(page, { low: true });
  await expect(page.getByTestId("v12-billing-low")).toHaveAttribute("data-low", "true", { timeout: 60_000 });
  await page.waitForTimeout(800);
  await captureBeside(page, "billing-low", "?view=billing&credits=low");
});
