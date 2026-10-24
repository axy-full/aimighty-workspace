import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * The public pricing page (the owner's final plans; lib/plans.ts) at the sizes the owner reviews. The prototype has no pricing page, so
 * this is the build alone: pricing/<size>-app.png.
 */
test("pricing", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/pricing");
  await expect(page.getByTestId("plans-individual")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("plans-team")).toBeVisible();
  await page.waitForTimeout(800);
  const size = page.viewportSize()!;
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", "pricing");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${size.width}x${size.height}-app.png`), await page.locator("#plans").screenshot({ animations: "disabled" }));
});

