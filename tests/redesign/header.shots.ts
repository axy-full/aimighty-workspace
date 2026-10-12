import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openAsTabs, redesignWithBoards } from "../helpers/v12Header";
import { setSite, visitorSite } from "../helpers/visitorV12";

/*
 * The header (prototype v14; set REDESIGN_PROTOTYPE_DIR to its folder until it is merged) beside the prototype: Home with a
 * few tabs, ten boards (the field at its width, the tabs that fit and "+N ▾"), the avatar menu, and the visitor's header.
 * The body below the header is still today's.
 */
test.afterAll(async () => { await closePrototypeServer(); await setSite({}); });
const LONG = Array.from({ length: 10 }, (_, i) => ["Launch clips · 30 s ad", "Mirror film", "Dune Studies", "Northwind spring", "Lantern pilot", "Harbor reel", "Atlas teaser", "Summit recap", "Orchard story", "Delta cut"][i]!);

test("the header, beside the prototype's Home", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, LONG.slice(0, 2));
  await openAsTabs(page, ids);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "home");
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1200);
  await captureBeside(page, "header", "?view=home");
});

test("the header with ten boards", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, LONG);
  await openAsTabs(page, ids);
  await page.mouse.move(700, 600);
  await expect(page.getByTestId("v12-tab-more")).toBeVisible();
  await page.waitForTimeout(1200);
  await captureBeside(page, "header-ten-boards", "?view=home&tabs=10");
});

test("the header with Activity open", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, LONG.slice(0, 2));
  await openAsTabs(page, ids, "/suites?view=home&activity=1");
  await expect(page.getByTestId("v12-activity-menu")).toBeVisible();
  await page.waitForTimeout(1200);
  await captureBeside(page, "header-activity", "?activity=1");
});

test("the avatar menu", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, LONG.slice(0, 2));
  await openAsTabs(page, ids);
  await page.getByTestId("v12-avatar").click();
  await expect(page.getByTestId("v12-account-menu")).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "header-avatar-menu", "?view=home&acct=1");
});

test("the visitor's header", async ({ page, browser }) => {
  await visitorSite(browser);
  await page.goto("/?guest=1");
  await expect(page.getByTestId("v12-visitor")).toBeVisible({ timeout: 60_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  await captureBeside(page, "header-visitor", "?guest=1");
});
