import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openAsTabs, redesignWithBoards } from "../helpers/v12Header";

/* Rule 7's phone widths on the screen the top bar sits on: a phone keeps the phone app (no desktop bar), and nothing overflows. Writes <REDESIGN_SHOTS_DIR>/v25-topbar-phones/<w>x<h>.png. */
test.use({ hasTouch: true });
test("phone widths: the phone app, no horizontal overflow", async ({ page }, info) => {
  test.skip(info.project.name !== "redesign-1440x900", "once");
  const { ids } = await redesignWithBoards(page, ["Harbour film"]);
  await openAsTabs(page, ids);
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", "v25-topbar-phones");
  await mkdir(dir, { recursive: true });
  for (const [w, h] of [[360, 640], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/suites?view=home");
    await expect(page.getByTestId("phone-app")).toBeVisible();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${w}x${h} overflow`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(dir, `${w}x${h}.png`) });
  }
});
