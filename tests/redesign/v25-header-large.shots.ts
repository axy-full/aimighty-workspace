import { test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { signInLocally } from "../helpers/workbenchLocal";
import { sizeTag } from "../helpers/ownerSizes";

/* The customer app's header (the real wordmark, #756) at the sizes the owner reviews: the app's own page only, no prototype (the customer app is not in v25). Writes <REDESIGN_SHOTS_DIR>/v25-large-customer-home/<tag>-app.png (the tag is 2560x1440@2x at a pixel ratio of 2, in device pixels). */
test("the customer Home header at the owner's sizes", async ({ page }) => {
  await signInLocally(page.request, "Header Shots");
  await page.goto("/suites?view=home");
  await page.locator("header.gx-header").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const size = page.viewportSize()!;
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", "v25-large-customer-home");
  await mkdir(dir, { recursive: true });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  await page.screenshot({ path: path.join(dir, `${sizeTag(size.width, size.height, dpr)}-app.png`), animations: "disabled" });
});
