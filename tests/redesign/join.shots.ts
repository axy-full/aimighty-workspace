import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";

/*
 * The join sheet (P4 · p4-join) beside the prototype's ?guest=1&join=start, its confirmation, and the phone's bottom
 * sheet at 390 × 844. Until the visitor screens land (p4-visitor) the sheet opens over the test-only page
 * app/(test)/v12-join, so only the sheet is to compare, not what is behind it.
 */
test.afterAll(closePrototypeServer);
const PROMPT = "A 30 s ad for a spice brand · a desert camp at night";

test("the join sheet", async ({ page }) => {
  await page.goto(`/v12-join?join=start&prompt=${encodeURIComponent(PROMPT)}`);
  await expect(page.getByTestId("v12-join")).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "join-start", "?guest=1&join=start");
});

test("the join sheet: you're on the list", async ({ page }) => {
  await page.goto(`/v12-join?join=start&requested=1&prompt=${encodeURIComponent(PROMPT)}`);
  await expect(page.getByTestId("v12-join-requested")).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "join-requested", "?guest=1&join=start&requested=1");
});

test("the phone's join sheet at 390 × 844", async ({ page }, info) => {
  test.skip(info.project.name !== "redesign-1440x900", "one phone capture is enough");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/v12-join?join=start&phone=1&prompt=${encodeURIComponent(PROMPT)}`);
  await expect(page.getByTestId("v12-join")).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "join-phone", "?guest=1&device=phone&join=start", { phone: true });
});
