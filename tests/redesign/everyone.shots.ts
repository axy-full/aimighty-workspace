import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedHome } from "../helpers/v12Home";
import { openShotsBoard } from "../helpers/shotsV12";
import { openBilling } from "../helpers/billingV12";

/*
 * The new interface for a workspace that is not the house workspace (redesign: on for every workspace): Home, Make, a board, Settings and
 * Credits & billing, at the sizes the owner reviews (1440x900 and 1280x800 from the config; 390x844 from here, the phone app). The workspace
 * is a fresh test workspace with no opt-out; every name is neutral. App only: pictures of the build, no prototype beside them.
 */
const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots");
async function shoot(page: Page, name: string) {
  await mkdir(path.join(dir, name), { recursive: true });
  const size = page.viewportSize()!;
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1200);
  await writeFile(path.join(dir, name, `${size.width}x${size.height}-app.png`), await page.screenshot({ animations: "disabled" }));
}
/** The same screen on the phone: today's phone app, unchanged. */
async function shootPhone(page: Page, name: string, ready: () => Promise<void>) {
  if ((page.viewportSize()?.width ?? 0) < 1400) return;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await ready();
  await shoot(page, name);
}

test("Home", async ({ page }) => {
  test.setTimeout(240_000);
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home-tile").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Harbour film").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2500);
  await shoot(page, "everyone-home");
  await shootPhone(page, "everyone-home", async () => { await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 }); });
});

test("Make", async ({ page }) => {
  test.setTimeout(240_000);
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-make-tile").first()).toBeVisible({ timeout: 60_000 });
  await shoot(page, "everyone-make");
  await shootPhone(page, "everyone-make", async () => { await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 }); });
});

test("a board", async ({ page }) => {
  test.setTimeout(240_000);
  await openShotsBoard(page, "/suites?view=board&stage=shots");
  await expect(page.locator('.bd-node[data-card-kind="take"]').first()).toBeVisible({ timeout: 90_000 });
  await shoot(page, "everyone-board");
  await shootPhone(page, "everyone-board", async () => { await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 }); });
});

test("Settings", async ({ page }) => {
  test.setTimeout(240_000);
  await openBilling(page);
  await page.goto("/suites?view=workspace&tab=team");
  await expect(page.getByRole("heading", { name: "Team", level: 1 })).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  await shoot(page, "everyone-settings");
  await shootPhone(page, "everyone-settings", async () => { await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 }); });
});

test("Credits & billing", async ({ page }) => {
  test.setTimeout(240_000);
  await openBilling(page);
  await expect(page.getByTestId("v12-billing")).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await shoot(page, "everyone-billing");
  await shootPhone(page, "everyone-billing", async () => { await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 }); });
});
