import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { isCompact } from "./helpers/shellMode";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInToRedesign } from "./helpers/newInterface";

/*
 * Workspace settings in the new interface (prototype v14, README § V14.2; components/v12/settings/console), as a person uses it.
 * An admin has eight workspace sections and two for the account; a member only Your usage, Plan, Profile and Notifications, whatever
 * address they open. Each section saves through the routes the server tests hold (tests/workspace-settings-v12-workbench.spec.ts).
 * Phone sizes keep today's phone app: no console there, and no overflow. Local ENGINE_MOCK servers only; nothing is spent.
 */
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no horizontal overflow").toBeLessThanOrEqual(0);
const open = async (page: Page, query = "") => {
  await page.goto(`/suites?view=settings${query}`);
  await expect(page.getByTestId("v12-settings")).toBeVisible({ timeout: 90_000 });
};
const section = (page: Page) => page.getByTestId("v12-settings").getAttribute("data-section");

async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}
/** The owner (signed in on `page`, with the new interface) and a member of the same workspace, in a page of their own. */
async function withMember(page: Page, browser: Browser, name = "Console Member") {
  const owner = await signInToRedesign(page.request, "Console Owner");
  await platform((db) => db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [owner.workspace.id] }));
  const ownerAccount = (await (await page.request.get("/api/me")).json()) as { id: string };
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInLocally(memberPage.request, name);
  const account = (await (await memberPage.request.get("/api/me")).json()) as { email: string };
  const code = randomBytes(18).toString("base64url");
  await platform((db) => db.execute({ sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)", args: [code, owner.workspace.id, account.email, name, "member", ownerAccount.id, Date.now(), Date.now() + 3_600_000] }));
  const accepted = await memberPage.request.post("/api/auth/accept", { data: { code, accept: true } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  return { owner, memberPage, memberContext };
}

test("phones keep today's phone app: Workspace settings' address opens no console and nothing overflows", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop sizes are covered below");
  await signInToRedesign(page.request, "Console Phone");
  await page.goto("/suites?view=settings");
  await expect(page.getByTestId("phone-app").or(page.getByTestId("settings-view")).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-settings")).toHaveCount(0);
  await noOverflow(page);
});

test.describe("desktop", () => {
  test.beforeEach(({}, info) => test.skip(isCompact(info), "the console is a desktop screen; the phone is checked above"));

  test("an admin has the eight workspace sections and the account's two; the avatar menu opens them; the address and the Back button agree", async ({ page }) => {
    test.setTimeout(300_000);
    await signInToRedesign(page.request, "Console Admin");
    await open(page);
    expect(await section(page)).toBe("overview");
    await expect(page.getByTestId("v12-settings-title")).toHaveText("Overview");
    await expect(page.getByTestId("v12-settings").getByRole("button").filter({ has: page.locator(".v12-ws-item-name") })).toHaveText([
      /Overview/, /People/, /Credits & billing/, /Usage/, /Defaults/, /Style rules/, /Limits/, /Workspace/, /Profile/, /Notifications/,
    ]);
    await expect(page.getByTestId("v12-settings")).toContainText("Only people in this workspace can see this.");
    await expect(page.getByTestId("v12-settings-tile")).toHaveCount(4);
    await noOverflow(page);
    for (const id of ["people", "billing", "usage", "defaults", "rules", "limits", "workspace", "profile", "notifications"]) {
      await page.getByTestId(`v12-settings-nav-${id}`).click();
      await expect(page.getByTestId("v12-settings")).toHaveAttribute("data-section", id);
      await expect(page).toHaveURL(new RegExp(`section=${id}`));
      await noOverflow(page);
    }
    await page.goBack();
    await expect(page.getByTestId("v12-settings")).toHaveAttribute("data-section", "notifications".replace("notifications", "profile"));
    /* v14's other spellings. */
    await page.goto("/suites?view=billing");
    await expect(page.getByTestId("v12-settings")).toHaveAttribute("data-section", "billing", { timeout: 90_000 });
    await expect(page.getByTestId("v12-billing")).toBeVisible();
    /* The avatar menu: Workspace settings and Credits & billing. */
    await page.goto("/suites?view=home");
    await page.getByTestId("v12-avatar").click();
    await page.getByTestId("v12-account-settings").click();
    await expect(page.getByTestId("v12-settings")).toHaveAttribute("data-section", "overview", { timeout: 90_000 });
    await page.getByTestId("v12-avatar").click();
    await page.getByTestId("v12-account-billing").click();
    await expect(page.getByTestId("v12-settings")).toHaveAttribute("data-section", "billing");
    /* The older settings stay one press away. */
    await page.getByTestId("v12-settings-more").click();
    await expect(page.getByTestId("settings-view")).toBeVisible({ timeout: 90_000 });
  });

  test("People: invite by email, the roster with roles, remove in two presses, pending invitations to revoke", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const { owner, memberContext } = await withMember(page, browser, "Console Person");
    await open(page, "&section=people");
    await expect(page.getByTestId("v12-settings-person")).toHaveCount(2);
    await expect(page.getByTestId("v12-settings-owner")).toHaveCount(1);
    /* The owner has no menu; the member has a role and a menu. */
    await expect(page.getByTestId("v12-settings-person-more")).toHaveCount(1);
    const roleSelect = page.getByTestId("v12-settings-role");
    await expect(roleSelect).toHaveValue("member");
    const changed = page.waitForResponse((r) => /\/api\/team\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "PATCH");
    await roleSelect.selectOption("admin");
    expect((await changed).ok()).toBe(true);
    await expect(roleSelect).toHaveValue("admin");
    await roleSelect.selectOption("member");
    await expect(roleSelect).toHaveValue("member");
    /* Invite: mail is not set up on a local server, so the one-time link is shown, and the invitation is pending. */
    const address = `console-invite-${randomBytes(3).toString("hex")}@example.test`;
    await page.getByTestId("v12-settings-invite-email").fill(address);
    await page.getByTestId("v12-settings-invite-role").selectOption("admin");
    await page.getByTestId("v12-settings-invite-send").click();
    await expect(page.getByTestId("v12-settings-invite-link")).toContainText("/invite/");
    await expect(page.getByTestId("v12-settings-pending-row")).toHaveCount(1);
    await expect(page.getByTestId("v12-settings-pending-row")).toContainText(address);
    await expect(page.getByTestId("v12-settings-pending-row")).toContainText("Admin");
    await expect(page.getByTestId("v12-settings-badge-people")).toHaveText("1");
    await expect(page.getByTestId("v12-settings-invite")).toContainText(/of \d+ seats used|\d+ people/);
    await page.getByTestId("v12-settings-revoke").click();
    await expect(page.getByTestId("v12-settings-pending-row")).toHaveCount(0);
    await expect(page.getByText("None pending.")).toBeVisible();
    /* Remove: the first press asks, the second removes; right-click opens the same menu. */
    await page.getByTestId("v12-settings-person").filter({ hasText: "Console Person" }).click({ button: "right" });
    await expect(page.getByTestId("v12-settings-menu")).toBeVisible();
    await page.getByTestId("v12-settings-remove").click();
    await expect(page.getByTestId("v12-settings-person")).toHaveCount(2);
    await page.getByTestId("v12-settings-remove-confirm").click();
    await expect(page.getByTestId("v12-settings-person")).toHaveCount(1);
    await noOverflow(page);
    await memberContext.close();
    void owner;
  });

  test("a member opens only Your usage, Plan, Profile and Notifications; an admin address lands on Profile; their usage is theirs alone", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const { owner, memberPage, memberContext } = await withMember(page, browser, "Console Member Two");
    const member = (await (await memberPage.request.get("/api/me")).json()) as { id: string };
    await platform((db) => db.execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,1,?,?,?)", args: [`ui_${randomBytes(5).toString("hex")}`, owner.workspace.id, "image", "nano-banana", "nano-banana", "succeeded", 6, member.id, Date.now(), Date.now()] }));
    await open(memberPage, "&section=people");
    expect(await section(memberPage)).toBe("profile");
    await expect(memberPage.getByTestId("v12-settings").getByRole("button").filter({ has: memberPage.locator(".v12-ws-item-name") })).toHaveText([/Your usage/, /Plan/, /Profile/, /Notifications/]);
    for (const hidden of ["overview", "people", "defaults", "rules", "limits", "workspace"]) {
      await memberPage.goto(`/suites?view=settings&section=${hidden}`);
      await expect(memberPage.getByTestId("v12-settings")).toHaveAttribute("data-section", "profile", { timeout: 90_000 });
    }
    await memberPage.getByTestId("v12-settings-nav-usage").click();
    await expect(memberPage.getByTestId("v12-settings-title")).toHaveText("Your usage");
    await expect(memberPage.getByTestId("v12-settings-usage-person")).toHaveCount(1);
    await expect(memberPage.getByTestId("v12-settings-usage-person")).toContainText("6");
    /* The header is their own row's total, not the workspace's. */
    await expect(memberPage.getByTestId("v12-settings-usage-total")).toHaveText("6 cr spent");
    await expect(memberPage.getByTestId("v12-settings-usage-boards")).toHaveCount(0);
    await expect(memberPage.getByText("Console Owner")).toHaveCount(0);
    await memberPage.getByTestId("v12-settings-nav-billing").click();
    await expect(memberPage.getByTestId("v12-settings-title")).toHaveText("Plan");
    await expect(memberPage.getByTestId("v12-billing")).toBeVisible();
    await expect(memberPage.getByTestId("v12-billing-top-up")).toHaveCount(0);
    await expect(memberPage.getByTestId("v12-billing-plans")).toHaveCount(0);
    await expect(memberPage.getByTestId("v12-billing-history")).toHaveCount(0);
    await expect(memberPage.getByTestId("v12-billing-low")).toContainText("Low-credit warning");
    await memberPage.getByTestId("v12-settings-nav-notifications").click();
    /* A member is not offered the admin-only ones. */
    await expect(memberPage.getByTestId("v12-settings-notify-takeDone")).toBeVisible();
    await expect(memberPage.getByTestId("v12-settings-notify-balanceLow")).toHaveCount(0);
    await noOverflow(memberPage);
    await memberContext.close();
  });

  test("Defaults, Style rules, Limits, Profile and Notifications save themselves and stay saved", async ({ page }) => {
    test.setTimeout(300_000);
    await signInToRedesign(page.request, "Console Saver");
    /* Defaults: the shape a new board starts in, and an engine from the registry with the card's price. */
    await open(page, "&section=defaults");
    const aspect = page.getByTestId("v12-settings-aspect-9x16");
    await aspect.click();
    await expect(aspect).toHaveAttribute("aria-pressed", "true");
    const engine = page.getByTestId("v12-settings-defaultImageModel-select");
    await expect(engine.locator("option")).not.toHaveCount(1, { timeout: 60_000 });
    const options = await engine.locator("option").allTextContents();
    expect(options[0]).toBe("Particl’s default");
    expect(options.every((o, i) => i === 0 || /\d+ cr$/.test(o))).toBe(true);
    const value = await engine.locator("option").nth(1).getAttribute("value");
    await engine.selectOption(value);
    await expect(engine).toHaveValue(value!);
    await page.reload();
    await expect(page.getByTestId("v12-settings-aspect-9x16")).toHaveAttribute("aria-pressed", "true", { timeout: 90_000 });
    await expect(page.getByTestId("v12-settings-defaultImageModel-select")).toHaveValue(value!);
    /* A new board starts in the default shape. */
    const settings = (await (await page.request.get("/api/settings")).json()) as { settings: Record<string, string> };
    expect(settings.settings.defaultAspect).toBe("9:16");
    /* Style rules: add one, change its words, remove it in two presses. */
    await page.getByTestId("v12-settings-nav-rules").click();
    await page.getByTestId("v12-settings-rule-text").fill("Keep the light warm.");
    await page.getByTestId("v12-settings-rule-add").click();
    const mine = page.locator('[data-testid="v12-settings-rule"][data-source="workspace"]');
    await expect(mine).toHaveCount(1);
    await expect(mine.getByLabel("Rule", { exact: true })).toHaveValue("Keep the light warm.");
    await page.getByTestId("v12-settings-rule-remove").click();
    await expect(mine).toHaveCount(1);
    await page.getByTestId("v12-settings-rule-remove").click();
    await expect(mine).toHaveCount(0);
    /* Limits: Save writes what changed; Reset puts Particl's own back. */
    await page.getByTestId("v12-settings-nav-limits").click();
    const save = page.getByTestId("v12-settings-limits-save");
    await expect(save).toBeDisabled();
    await page.getByTestId("v12-settings-limit-board").fill("500");
    await page.getByTestId("v12-settings-limit-warn").fill("70");
    await expect(save).toBeEnabled();
    await save.click();
    const stored = async () => { const body = (await (await page.request.get("/api/settings")).json()) as { settings: Record<string, string> }; return [body.settings.productionBudgetCredits, body.settings.capWarnPct]; };
    await expect.poll(stored).toEqual(["500", "70"]);
    await expect(save).toBeDisabled();
    await page.getByTestId("v12-settings-limit-warn").fill("0");
    await save.click();
    await expect(page.getByTestId("v12-settings-limits-note")).toBeVisible();
    await page.getByTestId("v12-settings-limits-reset").click();
    await expect(page.getByTestId("v12-settings-limit-board")).toHaveValue("");
    await expect(page.getByTestId("v12-settings-limit-warn")).toHaveValue("80");
    /* Profile: the name, the account's own. */
    await page.getByTestId("v12-settings-nav-profile").click();
    await page.getByTestId("v12-settings-profile-name").fill("Console Renamed");
    await page.getByTestId("v12-settings-profile-save").click();
    await expect(page.getByTestId("v12-settings-profile-name")).toHaveValue("Console Renamed", { timeout: 60_000 });
    expect(((await (await page.request.get("/api/me")).json()) as { name: string }).name).toBe("Console Renamed");
    /* Notifications: a switch is this person's, kept. */
    await page.getByTestId("v12-settings-nav-notifications").click();
    const sw = page.getByTestId("v12-settings-notify-takeDone-switch");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await page.reload();
    await expect(page.getByTestId("v12-settings-notify-takeDone-switch")).toHaveAttribute("aria-checked", "false", { timeout: 90_000 });
    await noOverflow(page);
  });

  test("Workspace: Delete asks for the typed name and stays off until it matches; the owner cannot leave", async ({ page }) => {
    test.setTimeout(300_000);
    const owner = await signInToRedesign(page.request, "Console Closer");
    await open(page, "&section=workspace");
    await expect(page.getByTestId("v12-settings-leave")).toBeDisabled();
    await page.getByTestId("v12-settings-delete").click();
    const confirm = page.getByTestId("v12-settings-delete-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("v12-settings-delete-name").fill(owner.workspace.name.slice(0, -1));
    await expect(confirm).toBeDisabled();
    await page.getByTestId("v12-settings-delete-name").fill(owner.workspace.name);
    await expect(confirm).toBeEnabled();
    /* Rename first: the owner's, with the new name then needed to delete. */
    await page.getByTestId("v12-settings-delete").click();
    await page.getByTestId("v12-settings-name-input").fill(`${owner.workspace.name} two`);
    await page.getByTestId("v12-settings-name-save").click();
    await expect(page.locator(".v12-ws-nav-ws")).toHaveText(`${owner.workspace.name} two`, { timeout: 60_000 });
    const me = (await (await page.request.get("/api/me")).json()) as { workspace: { name: string } };
    expect(me.workspace.name).toBe(`${owner.workspace.name} two`);
    await noOverflow(page);
  });
});
