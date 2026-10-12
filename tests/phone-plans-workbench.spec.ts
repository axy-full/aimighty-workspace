import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { DEFAULT_PLANS } from "../lib/plans";
import { BUSINESS_LEVELS, BUSINESS_FROM_USD, ENTERPRISE, INDIVIDUAL_CARDS } from "../lib/planCards";
import { smallTargets, smallText } from "./phoneFloors";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The phone's Settings › Plan & credits shows the plans the desktop shows (#661; components/graphite/settings/credits/PlanRows.tsx): Individual
 * (Explore $50 / 500, Create $100 / 1,000, Master $250 / 2,500), Business (from $100 a seat; 100, 250 and 500 a seat), Enterprise with "Get in
 * touch". A workspace still on a retired plan sees its name and never its old price ("Studio · $49 a month"). Display only: Choose changes nothing.
 * Local ENGINE_MOCK server; the plans are the platform layer's, as GET /api/billing returns them. Phones only: the new interface has its own page.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.PHONE_PLANS_SHOTS;

async function open(page: Page, planId: string) {
  await signInLocally(page.request, "Phone Plans");
  await forbidPaidWork(page);
  await page.route("**/api/billing", async (route) => {
    const real = await route.fetch();
    const body = await real.json();
    const now = Date.now();
    await route.fulfill({ response: real, json: { ...body, canManage: true, plans: DEFAULT_PLANS, subscription: { planId, status: "active", interval: "month", currentPeriodStart: now - 86_400_000, currentPeriodEnd: now + 20 * 86_400_000, cancelAtPeriodEnd: false } } });
  });
  await page.goto("/suites?view=workspace&tab=credits");
  await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits", { timeout: 90_000 });
  await expect(page.getByTestId("settings-plans-individual")).toBeVisible({ timeout: 60_000 });
}

test.describe("phone", () => {
  test.beforeEach(({}, info) => test.skip(!PHONES.includes(info.project.name), "phone sizes"));

  test("the plans are the desktop's: Individual, Business, Enterprise; a retired plan's price is never shown", async ({ page }, info) => {
    await open(page, "studio");
    const view = page.getByTestId("settings-view");
    const text = await view.innerText();
    /* Individual: name, price a month and credits, from the one plan source. */
    const individual = page.getByTestId("settings-plan-card");
    await expect(individual).toHaveCount(INDIVIDUAL_CARDS.length);
    for (const [i, card] of INDIVIDUAL_CARDS.entries()) {
      await expect(individual.nth(i)).toContainText(card.name);
      await expect(individual.nth(i)).toContainText(`$${card.priceUsd.toLocaleString("en-US")}/month · ${card.credits.toLocaleString("en-US")} credits`);
    }
    /* Business: three levels, per seat, and the "from" price; Enterprise says Get in touch. */
    const levels = page.getByTestId("settings-plan-level");
    await expect(levels).toHaveCount(BUSINESS_LEVELS.length);
    for (const [i, level] of BUSINESS_LEVELS.entries()) {
      await expect(levels.nth(i)).toContainText(level.name);
      await expect(levels.nth(i)).toContainText(`$${level.perSeatUsd.toLocaleString("en-US")} per seat/month · ${level.perSeatCredits.toLocaleString("en-US")} credits per seat`);
    }
    await expect(page.getByTestId("settings-plans-business")).toContainText(`from $${BUSINESS_FROM_USD} per seat`);
    await expect(page.getByTestId("settings-plan-enterprise")).toContainText(ENTERPRISE.blurb);
    await expect(page.getByTestId("settings-plan-enterprise").getByRole("button", { name: ENTERPRISE.line })).toBeVisible();
    /* The retired plan's name, and nothing of its price, anywhere on the page. */
    await expect(page.getByTestId("settings-plan")).toContainText("Studio");
    expect(text).not.toMatch(/Studio\s*·\s*\$/);
    expect(text).not.toContain("$49");
    /* Display only: Choose says so and changes nothing (no write goes out). */
    const writes: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET") writes.push(r.method() + " " + new URL(r.url()).pathname); });
    await individual.first().getByRole("button", { name: "Choose" }).click();
    const note = page.getByTestId("settings-plan-choose-note");
    await expect(note).toHaveText("Checkout is not open yet. Nothing was changed.");
    /* Tapping Choose visibly does something: the note is on screen, in the Individual section beside the tapped row, not out of sight below. */
    await expect(note).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("settings-plans-individual").getByTestId("settings-plan-choose-note")).toHaveCount(1);
    await expect(page.getByTestId("settings-plan-choose-note")).toHaveCount(1);
    expect(writes).toEqual([]);
    /* Every plan row stays inside the screen and keeps its name on one line of words (a long figure never squeezes the name into a column). */
    const rows = await page.locator('[data-testid^="settings-plan-"]').evaluateAll((els, width) => els.map((el) => {
      const box = el.getBoundingClientRect();
      const name = el.querySelector(".gs-row-name")?.getBoundingClientRect();
      return { right: box.right, nameWidth: name?.width ?? 999, text: (el.textContent ?? "").slice(0, 30) };
    }).filter((r) => r.right > width + 0.5 || r.nameWidth < 60), page.viewportSize()!.width);
    expect(rows, "plan rows outside the screen or with a squeezed name").toEqual([]);
    /* Floors: nothing sideways, touch targets, readable text. */
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "horizontal overflow").toBeLessThanOrEqual(1);
    expect(await smallTargets(page, '[data-testid="settings-view"]'), "targets under 44x44").toEqual([]);
    expect(await smallText(page), "text under 12 px").toEqual([]);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.getByTestId("settings-plans-individual").scrollIntoViewIfNeeded(); await page.waitForTimeout(500); await page.screenshot({ path: path.join(SHOTS, `plans-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" }); await page.getByTestId("settings-plans-enterprise").scrollIntoViewIfNeeded(); await page.waitForTimeout(500); await page.screenshot({ path: path.join(SHOTS, `plans-business-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" }); }
  });

  test("a workspace on one of the new plans sees it as Current plan", async ({ page }) => {
    await open(page, "create");
    await expect(page.getByTestId("settings-plan")).toContainText("Create");
    const create = page.getByTestId("settings-plan-card").filter({ hasText: "Create" });
    await expect(create.getByRole("button", { name: "Current plan" })).toBeDisabled();
    await expect(page.getByTestId("settings-plan-card").filter({ hasText: "Explore" }).getByRole("button", { name: "Choose" })).toBeEnabled();
  });
});
