import { test, expect } from "@playwright/test";
import { openBilling } from "./helpers/billingV12";
import { PLAN_CARDS } from "../lib/marketing/planCards";

/**
 * Settings › Credits & billing in the new interface (docs/redesign-plan.md, item B2; components/v12/settings/CreditsBilling.tsx).
 * Desktop with the switch on: the new screen, display only, Top up opening today's flow, and no sideways scroll.
 * Phones with the switch on: today's phone app, unchanged. Switch off: today's Plan & credits.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

const noSideways = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("the new Credits & billing: balance, plan, cycle, month, low-balance rule, placeholder plans, per board, history", async ({ page }) => {
    const { errors } = await openBilling(page);
    const screen = page.getByTestId("v12-billing");
    await expect(screen).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByRole("heading", { name: "Credits & billing" })).toBeVisible();
    await expect(page.getByTestId("v12-billing-credits")).toContainText(/\d[\d,]* cr/);
    await expect(page.getByTestId("v12-billing-plan")).toContainText("Studio");
    await expect(page.getByTestId("v12-billing-cycle")).toContainText("400 cr included");
    await expect(page.getByTestId("v12-billing-month")).toContainText("163 cr settled · 20 cr held");
    await expect(page.getByTestId("v12-billing-low")).toHaveAttribute("data-low", "false");
    await expect(page.getByTestId("v12-billing-low")).toContainText("below 20% of your plan’s credits");
    /* The placeholder cards, from the one config. */
    const cards = page.getByTestId("v12-billing-plan-card");
    await expect(cards).toHaveCount(PLAN_CARDS.length);
    for (const [i, card] of PLAN_CARDS.entries()) await expect(cards.nth(i)).toContainText(card.name);
    await expect(page.getByTestId("v12-billing-plans")).toContainText("Placeholders");
    /* Per board this month, and History with money in and out. */
    await expect(page.getByTestId("v12-billing-board")).toHaveCount(4);
    await expect(page.getByTestId("v12-billing-board").first()).toContainText("186 cr");
    const history = page.getByTestId("v12-billing-history-row");
    await expect(history.first()).toContainText("−10 cr");
    await expect(page.getByTestId("v12-billing-history")).toContainText("+500 cr");
    await expect(page.getByTestId("v12-billing-history")).toContainText("20 cr held");
    await expect(page.getByTestId("v12-billing-export")).toHaveAttribute("href", /\/api\/usage\?rows=1&format=csv&month=\d{4}-\d{2}/);
    /* One filled primary: Top up, labelled from today's smallest pack. */
    const topUp = page.getByTestId("v12-billing-top-up");
    await expect(topUp).toHaveText("Top up · 500 cr · $50");
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Top up opens today's top-up flow, unchanged, and requests nothing on its own", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/workspaces\/topups/.test(r.url())) posts.push(r.url()); });
    await openBilling(page);
    await page.getByTestId("v12-billing-top-up").click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await expect(page.getByTestId("settings-pack").first()).toBeVisible();
    await expect(page.getByTestId("v12-billing")).toHaveCount(0);
    expect(posts).toEqual([]);
  });

  test("Open on a board opens that board", async ({ page }) => {
    await openBilling(page);
    await page.getByTestId("v12-billing-board").first().getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveURL(/view=board/);
    await expect(page).toHaveURL(/project=ws-billing/);
  });

  test("with the balance under 20% of the base, the screen says the low-balance chip is showing", async ({ page }) => {
    await openBilling(page, { low: true });
    await expect(page.getByTestId("v12-billing-low")).toHaveAttribute("data-low", "true", { timeout: 60_000 });
    await expect(page.getByTestId("v12-billing-low")).toContainText("Showing now");
    expect(await noSideways(page)).toBe(true);
  });

  test("switch off: today's Plan & credits, as it was", async ({ page }) => {
    await openBilling(page, { on: false });
    await expect(page.getByTestId("settings-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-billing")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));

  test("the phone app still shows today's Settings, with no sideways scroll", async ({ page }) => {
    const { errors } = await openBilling(page);
    await expect(page.getByTestId("settings-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-billing")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
