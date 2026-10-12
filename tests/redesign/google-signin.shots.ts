import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/*
 * "Continue with Google" on the join sheet and the sign-in page, shown and hidden, at 1440 × 900 and 390 × 844. The prototype has no
 * Google button, so each screen is the build alone (no prototype beside it). The status route is stubbed: nothing leaves this machine.
 */
const SIZES = [[1440, 900], [390, 844]] as const;
const root = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots");
async function shoot(page: Page, name: string, url: string, ready: () => Promise<void>) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(url);
    await ready();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(dir, `${w}x${h}-app.png`) });
    writeFileSync(path.join(dir, `${w}x${h}.json`), JSON.stringify({ app: url, prototype: "none (the prototype has no Google button)" }));
  }
}
const status = (page: Page, enabled: boolean) => page.route("**/api/auth/google/status", (route) => route.fulfill({ json: { enabled } }));

for (const on of [true, false]) {
  test(`the join sheet, Google ${on ? "on" : "off"}`, async ({ page }, info) => {
    test.skip(info.project.name !== "redesign-1440x900", "sizes are set inside");
    await shoot(page, `join-google-${on ? "on" : "off"}`, `/v12-join?join=start${on ? "&google=1" : ""}`, async () => { await expect(page.getByTestId("v12-join")).toBeVisible(); });
  });
  test(`the sign-in page, Google ${on ? "on" : "off"}`, async ({ page }, info) => {
    test.skip(info.project.name !== "redesign-1440x900", "sizes are set inside");
    await status(page, on);
    await shoot(page, `login-google-${on ? "on" : "off"}`, "/login", async () => {
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      if (on) await expect(page.getByTestId("signin-google")).toBeVisible();
    });
  });
}
