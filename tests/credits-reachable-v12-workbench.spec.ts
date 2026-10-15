import { test, expect, type Page } from "@playwright/test";
import { openBilling } from "./helpers/billingV12";

/**
 * Credits & billing is reachable in the new interface (fix/r1-credits-reachable; docs/redesign/inventory.md § 5.5, § 5.6): the
 * avatar menu holds the balance, Top up only where a top-up can be asked for (an owner or admin of a workspace on credits), a
 * line saying why where it cannot, and the link to Settings › Credits & billing, whose Settings tab is called the same. The
 * house workspace, which pays in dollars at the engines' cost, gets the same page in dollars from the Usage reads: spend by
 * board, history and the CSV export, and no credits, plans or top-up. Phones keep the phone app; the house's chip says why
 * there is no top-up. Every read is today's route, answered here; nothing is requested or spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const TEAM = "/suites?view=workspace&tab=team";
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function openAvatar(page: Page) {
  await page.getByTestId("v12-avatar").click();
  const menu = page.getByTestId("v12-account-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("an owner or admin: the balance, Top up, and Credits & billing; the Settings tab has the same name", async ({ page }) => {
    const { errors } = await openBilling(page, { path: TEAM });
    /* The Settings tab is called what its page is. */
    await expect(page.getByTestId("settings-section-credits")).toHaveText("Credits & billing", { timeout: 60_000 });
    const menu = await openAvatar(page);
    await expect(menu.getByTestId("v12-account-balance")).toHaveText(/\d[\d,]*\s*cr$/);
    await expect(menu.getByTestId("v12-account-topup")).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(["Top up", "Workspace settings", "Credits & billing", "Sign out"]);
    await expect(menu.getByTestId("v12-account-ask-admin")).toHaveCount(0);
    await menu.getByTestId("v12-account-billing").click();
    await expect(page.getByTestId("v12-billing")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-billing-board").first()).toBeVisible();
    await expect(page.getByTestId("v12-billing-export")).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Top up in the menu opens today's top-up flow (packs), and requests nothing on its own", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/workspaces\/topups/.test(r.url())) posts.push(r.url()); });
    await openBilling(page, { path: TEAM });
    const menu = await openAvatar(page);
    await menu.getByTestId("v12-account-topup").click();
    await expect(page).toHaveURL(/open=packs/);
    expect(posts).toEqual([]);
  });

  test("a member: no Top up button, a line saying who can ask, and the same link", async ({ page }) => {
    await openBilling(page, { path: TEAM, canRequest: false });
    const menu = await openAvatar(page);
    await expect(menu.getByTestId("v12-account-ask-admin")).toHaveText("Ask an admin for credits");
    await expect(menu.getByTestId("v12-account-topup")).toHaveCount(0);
    await expect(menu.getByRole("menuitem")).toHaveText(["Workspace settings", "Credits & billing", "Sign out"]);
    await menu.getByTestId("v12-account-billing").click();
    await expect(page.getByTestId("v12-billing")).toBeVisible({ timeout: 60_000 });
    /* A member still reads the boards and the history: the existing rule. */
    await expect(page.getByTestId("v12-billing-board").first()).toBeVisible();
  });

  test("the house workspace: dollars at cost in the menu and on the page; no credits, no plans, no top-up", async ({ page }) => {
    const { errors } = await openBilling(page, { path: TEAM, house: true });
    const menu = await openAvatar(page);
    await expect(menu.getByTestId("v12-account-balance")).toHaveText("$12.50 spent");
    await expect(menu.getByTestId("v12-account-no-topup")).toHaveText("At cost · no top-up");
    await expect(menu.getByTestId("v12-account-topup")).toHaveCount(0);
    /* This person also belongs to another workspace, so "Switch to …" sits among the items. */
    await expect(menu.getByTestId("v12-account-billing")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Top up" })).toHaveCount(0);
    await menu.getByTestId("v12-account-billing").click();
    const screen = page.getByTestId("v12-billing");
    await expect(screen).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByRole("heading", { name: "Credits & billing" })).toBeVisible();
    await expect(page.getByTestId("v12-billing-house")).toContainText("In dollars, at the engines’ cost");
    await expect(page.getByTestId("v12-billing-spent")).toContainText("$12.50");
    await expect(page.getByTestId("v12-billing-no-topup")).toContainText("no credits to buy");
    /* Per board (all time) and the month's history, from the Usage reads, in dollars. */
    const boards = page.getByTestId("v12-billing-board");
    await expect(boards).toHaveCount(3);
    await expect(boards.first()).toContainText("Launch film");
    await expect(boards.first()).toContainText("$7.20");
    const history = page.getByTestId("v12-billing-history-row");
    await expect(history).toHaveCount(2);
    await expect(history.first()).toContainText("$0.04");
    await expect(page.getByTestId("v12-billing-history")).toContainText("$1.80");
    await expect(page.getByTestId("v12-billing-export")).toHaveAttribute("href", /\/api\/usage\?rows=1&format=csv&month=\d{4}-\d{2}/);
    /* No credit figure, plan card or top-up anywhere on it. */
    await expect(page.getByTestId("v12-billing-plans")).toHaveCount(0);
    await expect(page.getByTestId("v12-billing-top-up")).toHaveCount(0);
    expect(await screen.innerText()).not.toMatch(/\bcr\b/);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe("phones", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));

  test("the phone app keeps its credits chip; the house's chip says why there is no top-up", async ({ page }) => {
    await openBilling(page, { path: "/suites" });
    await expect(page.getByTestId("phone-credits")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("phone-credits")).toContainText(/\d/);
    await expect(page.getByTestId("v12-avatar")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });

  test("the house's chip reads At cost, with the reason on hover and for a screen reader", async ({ page }) => {
    await openBilling(page, { path: "/suites", house: true });
    const chip = page.getByTestId("phone-credits");
    await expect(chip).toBeVisible({ timeout: 60_000 });
    await expect(chip).toHaveText("At cost");
    await expect(chip).toHaveAttribute("title", /no credits to top up/);
    await expect(chip).toHaveAttribute("aria-label", "At cost, no top-up");
    expect(await noSideways(page)).toBe(true);
  });
});
