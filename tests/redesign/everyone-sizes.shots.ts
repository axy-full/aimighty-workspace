import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { seedHome } from "../helpers/v12Home";
import { openShotsBoard } from "../helpers/shotsV12";
import { openBilling } from "../helpers/billingV12";

/*
 * Home, Make, a board and Workspace › Credits of a workspace that is NOT the house workspace, with the new interface on for everyone, at the five
 * sizes (360x640, 390x844, 844x390, 1440x900, 1920x1080). The three phone sizes show the phone app, which this change leaves as it is. A fresh
 * test workspace, mocked media and engines, every name neutral. Files: REDESIGN_SHOTS_DIR/<screen>-<size>.png.
 */
const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots");
const isPhone = (page: Page) => { const v = page.viewportSize()!; return v.width < 768 || v.height <= 500; };
async function shoot(page: Page, name: string) {
  await mkdir(dir, { recursive: true });
  const size = page.viewportSize()!;
  await page.mouse.move(700, 120).catch(() => undefined);
  await page.waitForTimeout(1500);
  await writeFile(path.join(dir, `${name}-${size.width}x${size.height}.png`), await page.screenshot({ animations: "disabled" }));
}
const phoneReady = (page: Page) => expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 90_000 });

test("Home", async ({ page }) => {
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=home");
  if (isPhone(page)) await phoneReady(page);
  else { await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 }); await expect(page.getByTestId("v12-home-tile").first()).toBeVisible({ timeout: 60_000 }); }
  await page.waitForTimeout(2500);
  await shoot(page, "home");
});

test("Make", async ({ page }) => {
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=make");
  if (isPhone(page)) await phoneReady(page);
  else { await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 }); await expect(page.getByTestId("v12-make-tile").first()).toBeVisible({ timeout: 60_000 }); }
  await shoot(page, "make");
});

test("a board", async ({ page }) => {
  await openShotsBoard(page, "/suites?view=board&stage=shots");
  if (isPhone(page)) await phoneReady(page);
  else await expect(page.locator('.bd-node[data-card-kind="take"]').first()).toBeVisible({ timeout: 90_000 });
  await shoot(page, "board");
});

test("Workspace › Credits", async ({ page }) => {
  await openBilling(page);
  if (isPhone(page)) { await page.goto("/suites?view=workspace&tab=credits"); await phoneReady(page); }
  else await expect(page.getByTestId("v12-billing")).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await shoot(page, "workspace-credits");
});
