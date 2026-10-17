import { test, expect, type Page } from "@playwright/test";
import { seedHome, signInSwitchedOn } from "./helpers/v12Home";

/**
 * "+ New project" on the new Home (demo plan PR 32 + D-1; lib/v12/board/new-project.ts): one press makes a Film board whose
 * rail starts with the demo's steps and opens it on Pitch. Free: nothing is asked of Atomik, nothing is spent. Local
 * ENGINE_MOCK server. At phone sizes the phone app is unchanged with the switch on (rule 7).
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
}

test("desktop: + New project makes a Film board with the demo's steps and opens on Pitch", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedHome(page, { takes: 0 });
  const asks: string[] = [];
  const generates: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/generate$/.test(r.url())) generates.push(r.url()); });
  await page.route((url) => url.pathname === "/api/workbench/team-canvas", (route) => {
    if (route.request().method() === "POST") { asks.push(route.request().postData() ?? ""); return route.fulfill({ status: 409, json: { error: "Not in this test." } }); }
    return route.fallback();
  });

  await page.goto("/suites?view=home");
  const button = page.getByTestId("v12-home-new-project");
  await expect(button).toHaveText("+ New project", { timeout: 90_000 });
  await expect(button).toBeEnabled();
  await noOverflow(page);
  await button.click();

  const rows = page.getByTestId("v12-stage-row");
  await expect(rows.first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-stage-kind")).toHaveText("FILM");
  expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-stage")))).toEqual(["pitch", "brief", "script", "cast", "elements", "storyboard", "shots", "edit", "deliver"]);
  /* Opens on its first step. */
  await expect(page.locator('[data-testid="v12-stage-row"][data-stage="pitch"] .v12-rail-btn')).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Pitch");
  /* Free: Atomik was not asked, so nothing was billed. */
  expect(asks).toEqual([]);
  expect(generates).toEqual([]);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("phones keep today's app: no new Home, no sideways scroll", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone sizes");
  await signInSwitchedOn(page);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home-new-project")).toHaveCount(0);
  await noOverflow(page);
});
