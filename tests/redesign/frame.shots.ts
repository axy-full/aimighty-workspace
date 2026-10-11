import { test, expect } from "@playwright/test";
import { signInToRedesign } from "../helpers/newInterface";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";

/* A1 has no prototype screen of its own: the frame only (the .v12 root and its header slot, still holding today's
   header and today's Home), beside the prototype's Home, so the review sees where the frame starts from. */
test.afterAll(closePrototypeServer);

test("the frame, beside the prototype's Home", async ({ page }) => {
  await signInToRedesign(page.request);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-root")).toBeVisible();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "home");
  await page.waitForTimeout(1500);
  await captureBeside(page, "frame", "?");
});
