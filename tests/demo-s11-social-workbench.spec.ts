import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { SHOTS, desktop, seedAds } from "./helpers/s11-board";

test.describe.configure({ retries: 1 });

test("Social board: first look", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedAds(page, null, "social");
  await page.goto(`/suites?project=${project.id}&view=board&kind=social&frame=1`);
  await expect(page.getByTestId("social-start")).toBeVisible({ timeout: 60_000 });
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/social-empty.png` });
  await page.getByTestId("social-start-file").setInputFiles({ name: "walk.mp4", mimeType: "video/mp4", buffer: readFileSync("public/fixtures/clip.mp4") });
  await expect(page.locator('[data-card-kind="social-source"]')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/social-first-look.png` });
});
