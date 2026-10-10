import { test, expect, type Page } from "@playwright/test";
import { signInToRedesign } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";

/**
 * After joining, the person lands back where they were (docs/redesign/inventory.md § 8.6; lib/v12/joinReturn.ts): the
 * join sheet leaves a note and the visitor's words; the first signed-in page reads the note once. Home: the words in the
 * bar, with Start's price beside them. Make: Make opens with the words in its composer, where Make prices them.
 * Neutral words only; nothing is generated (forbidPaidWork).
 */
const WORDS = "A paper boat on a still lake at dawn";
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];

async function joinedFrom(page: Page, view: "home" | "make") {
  await signInToRedesign(page.request);
  await forbidPaidWork(page);
  await page.addInitScript(([words, where]) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("particl:guest-brief", JSON.stringify({ v: { text: words }, at: Date.now() }));
    localStorage.setItem("particl:join-return", JSON.stringify({ at: Date.now(), view: where }));
  }, [WORDS, view] as const);
  await page.goto("/suites?view=home");
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("from the visitor's Home: back on Home, the words in the bar and Start's price beside them; the note is used once", async ({ page }) => {
    await joinedFrom(page, "home");
    await expect(page.getByTestId("v12-home-bar-input")).toHaveValue(WORDS, { timeout: 90_000 });
    await expect(page.getByTestId("v12-home-start")).toContainText(/Start/);
    await expect(page.getByTestId("v12-home-start-price")).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => [localStorage.getItem("particl:join-return"), localStorage.getItem("particl:guest-brief")])).toEqual([null, null]);
    /* A reload has no note: the bar is not filled again. */
    await page.getByTestId("v12-home-bar-input").fill("");
    await page.reload();
    await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-home-bar-input")).toHaveValue("");
  });

  test("from the visitor's Make: Make opens with the words in its composer", async ({ page }) => {
    await joinedFrom(page, "make");
    await expect(page.getByTestId("gen-prompt").or(page.getByTestId("v12-make-bar-input")).first()).toHaveValue(WORDS, { timeout: 90_000 });
    expect(await page.evaluate(() => localStorage.getItem("particl:join-return"))).toBeNull();
  });
});
