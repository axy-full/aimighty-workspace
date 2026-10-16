import { test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { signInLocally } from "../helpers/workbenchLocal";

/* The customer app's header (the real wordmark, #756) at the five sizes the owner reviews: the app's own page only, no prototype (the customer app is not in v25). Writes <REDESIGN_SHOTS_DIR>/v25-large-customer-home/<w>x<h>-app.png. */
test("the customer Home header at the five sizes", async ({ page }) => {
  await signInLocally(page.request, "Header Shots");
  await page.goto("/suites?view=home");
  await page.locator("header.gx-header").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const size = page.viewportSize()!;
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", "v25-large-customer-home");
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${size.width}x${size.height}-app.png`), animations: "disabled" });
});
