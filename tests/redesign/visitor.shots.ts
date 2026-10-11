import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { setSite, signupInvite, teamInvite, visitorSite } from "../helpers/visitorV12";
import { signInLocally } from "../helpers/workbenchLocal";

/*
 * The visitor's new interface (P4) beside the prototype's `?guest=1` screens: Home, Make, the sample board, "You don't
 * have access", the join sheet and its invite states, and the phone's Home and bottom sheet at 390 × 844.
 */
test.afterAll(async () => { await closePrototypeServer(); await setSite({}); });
const PROMPT = "A 30 s ad for a spice brand · a desert camp at night";
let guestWorkspace: string | null = null;

test.beforeAll(async ({ browser }) => { ({ guestWorkspace } = await visitorSite(browser)); });

async function settle(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>("img")).every((img) => img.complete), null, { timeout: 30_000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
}

for (const [name, app, proto] of [
  ["visitor-home", "/?guest=1", "?guest=1"],
  ["visitor-make", "/?guest=1&screen=make", "?guest=1&view=make"],
  ["visitor-board", "/?guest=1&screen=board", "?guest=1&view=board"],
  ["visitor-no-access", "/?guest=1&board=another-workspace", "?guest=1&view=board&project=other"],
] as const) {
  test(name, async ({ page }) => {
    await page.goto(app);
    await expect(page.getByTestId("v12-visitor")).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await captureBeside(page, name, proto);
  });
}

test("visitor-join: the sheet over Home with the prompt", async ({ page }) => {
  await page.goto("/?guest=1");
  await page.getByTestId("v12-visitor-bar-input").fill(PROMPT);
  await page.getByTestId("v12-visitor-start").click();
  await expect(page.getByTestId("v12-join")).toBeVisible();
  await settle(page);
  await captureBeside(page, "visitor-join", "?guest=1&join=start");
});

test("visitor-join-requested", async ({ page }) => {
  await page.goto("/?guest=1&join=start&requested=1");
  await expect(page.getByTestId("v12-join-requested")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await captureBeside(page, "visitor-join-requested", "?guest=1&join=start&requested=1");
});

test("visitor invites: team, new workspace, plan, expired", async ({ page, browser }) => {
  const context = await browser.newContext();
  const owner = await signInLocally((await context.newPage()).request, "Inviting Owner");
  await context.close();
  const team = await teamInvite(owner.workspace.id), fresh = await signupInvite(), used = await signupInvite("used");
  for (const [name, code, proto, steps] of [
    ["visitor-invite-team", team.code, "?guest=1&invite=team", async () => {}],
    ["visitor-invite-new", fresh.code, "?guest=1&invite=new", async () => {}],
    ["visitor-invite-plan", fresh.code, "?guest=1&invite=new&step=plan", async () => { await page.getByTestId("v12-join-workspace").fill("North Quay Films"); await page.getByTestId("v12-join-continue").click(); }],
    ["visitor-invite-expired", used.code, "?guest=1&invite=expired", async () => {}],
  ] as const) {
    await page.goto(`/?guest=1&invite=${code}`);
    await expect(page.getByTestId("v12-join")).toBeVisible({ timeout: 60_000 });
    await steps();
    await settle(page);
    await captureBeside(page, name, proto);
  }
});

test("phone: Home and the bottom sheet at 390 × 844", async ({ page }, info) => {
  test.skip(info.project.name !== "redesign-1440x900", "one phone capture is enough");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?guest=1");
  await expect(page.getByTestId("v12-visitor-home")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await captureBeside(page, "visitor-phone-home", "?guest=1&device=phone", { phone: true });
  await page.getByTestId("v12-visitor-bar-input").fill(PROMPT);
  await page.getByTestId("v12-visitor-start").click();
  await expect(page.getByTestId("v12-join")).toBeVisible();
  await settle(page);
  await captureBeside(page, "visitor-phone-join", "?guest=1&device=phone&join=start", { phone: true });
  void guestWorkspace;
});
