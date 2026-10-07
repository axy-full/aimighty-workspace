import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { totpAt } from "../lib/totp";
const password = "a local browser test passphrase 42";

/**
 * The workspace's two-step rule is set in Settings > Team > Security (the old People page that drew it is gone; /team opens
 * Settings > Team), through the same route the old page used: POST /api/workspaces/security with the owner's password and a
 * fresh authenticator or recovery code. The owner turns it on and off there in the browser; anyone else sees it and cannot
 * change it; and every check the server makes on that route is still asserted on its answer.
 */
const SECURITY = "/suites?view=workspace&tab=team&open=security";
const rule = (page: Page) => page.getByTestId("settings-workspace-two-step");
const toggle = (page: Page) => page.getByTestId("settings-workspace-two-step-toggle");

/** Turn the rule on or off as an owner does: the row's button, then their password and a fresh code. */
async function setPolicy(page: Page, scope: string, requiresMfa: boolean, code: string) {
  await page.goto(SECURITY);
  await expect(rule(page)).toContainText(requiresMfa ? "off" : "on");
  await toggle(page).click();
  const form = page.getByTestId("settings-workspace-two-step-form");
  await form.getByLabel("Your password").fill(password);
  await form.getByLabel("Authenticator or recovery code").fill(code);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/workspaces/security") && r.request().method() === "POST");
  await page.getByTestId("settings-workspace-two-step-confirm").click();
  const response = await answer;
  expect(response.ok(), await response.text()).toBe(true);
  /* The same body the old page sent, under the captured scope. */
  expect(response.request().postDataJSON()).toEqual({ requiresMfa, password, code });
  expect(response.request().headers()["x-workbench-scope"]).toBe(scope);
  await expect(rule(page)).toContainText(requiresMfa ? "on" : "off");
  await expect(form).toHaveCount(0);
  await expect(toggle(page)).toHaveText(requiresMfa ? "Turn off" : "Turn on");
  const read = await page.request.get("/api/workspaces/security", { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
  expect(read.requiresMfa).toBe(requiresMfa);
  return read as { requiresMfa: boolean; members: number; unenrolled: number };
}
async function enrol(page: Page) {
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = await page
    .getByLabel("Setup key", { exact: true })
    .inputValue();
  await page
    .getByLabel("Authenticator or recovery code", { exact: true })
    .fill(totpAt(secret, Date.now()));
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/account/security") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Enable two-step sign-in", exact: true })
    .click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const data = await result.json();
  expect(data.recoveryCodes).toHaveLength(10);
  await expect(
    page.getByRole("list", { name: "New recovery codes" }),
  ).toBeVisible();
  return data.recoveryCodes as string[];
}
test("owner policy blocks existing member data and tokens, allows workspace switching, then restores access after authenticator enrollment", async ({
  page,
  browser,
  playwright,
}, testInfo) => {
  /* Two accounts through sign-up, enrolment and Settings on a dev server that compiles each page on first sight. */
  test.setTimeout(180_000);
  await signInLocally(page.request);
  const owner = await page.request.get("/api/me").then((r) => r.json());
  const ownerScope = `particl-active-${owner.workspace.id}-${owner.id}`;
  const baseURL = String(
    testInfo.project.use.baseURL ?? process.env.PW_BASE_URL,
  );
  const memberContext = await browser.newContext({
    baseURL,
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
  });
  const member = await memberContext.newPage();
  let bearer:
    Awaited<ReturnType<typeof playwright.request.newContext>> | undefined;
  try {
    const own = await signInLocally(member.request);
    const me = await member.request.get("/api/me").then((r) => r.json());
    const invitation = await page.request.post("/api/team", {
      headers: { "X-Workbench-Scope": ownerScope },
      data: {
        email: me.email,
        name: "Policy member",
        role: "member",
        send: false,
      },
    });
    expect(invitation.ok(), await invitation.text()).toBe(true);
    const invite = await invitation.json();
    expect(invite.sent).toBe(false);
    const accepted = await member.request.post("/api/auth/accept", {
      data: { code: invite.code },
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const memberScope = `particl-active-${owner.workspace.id}-${me.id}`;
    const tokenResponse = await member.request.post("/api/tokens", {
      headers: { "X-Workbench-Scope": memberScope },
      data: { name: "Local policy probe", scope: "read" },
    });
    expect(tokenResponse.ok(), await tokenResponse.text()).toBe(true);
    const token = await tokenResponse.json();
    bearer = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token.token}` },
    });
    expect((await bearer.get("/api/jobs?sync=0")).status()).toBe(200);
    expect((await member.request.get("/api/jobs?sync=0")).status()).toBe(200);
    await member.goto("/suites");
    await expect(member).toHaveURL(/\/suites(\?|$)/);
    /* The shell's header keeps the account status visible: the credits, on a desktop's header or the phone's own. */
    await expect(member.locator('[data-testid="workspace-credits"], [data-testid="phone-credits"]').first()).toBeVisible();
    /* Before the owner's own two-step is on, the row offers to set it up first; the server refuses the change anyway (409),
       and a write without the captured scope is refused too (409). */
    await page.goto(SECURITY);
    await expect(rule(page)).toContainText("off");
    await expect(toggle(page)).toHaveCount(0);
    await expect(page.getByTestId("settings-workspace-two-step-enrol")).toHaveAttribute("href", "/account/security");
    const early = await page.request.post("/api/workspaces/security", { headers: { "X-Workbench-Scope": ownerScope }, data: { requiresMfa: true, password, code: "000000" } });
    expect(early.status()).toBe(409);
    expect((await early.json()).error).toMatch(/Set up your own authenticator/);
    expect((await page.request.get("/api/workspaces/security")).status()).toBe(409);
    /* A member sees the rule and cannot change it: no control, and the route is the owner's alone (403). */
    await member.goto(SECURITY);
    await expect(rule(member)).toContainText("off");
    await expect(rule(member)).toContainText("Set by the workspace owner");
    await expect(toggle(member)).toHaveCount(0);
    expect((await member.request.post("/api/workspaces/security", { headers: { "X-Workbench-Scope": memberScope }, data: { requiresMfa: true, password, code: "000000" } })).status()).toBe(403);
    expect((await member.request.get("/api/workspaces/security", { headers: { "X-Workbench-Scope": memberScope } })).status()).toBe(403);
    await page.goto("/account/security");
    const ownerCodes = await enrol(page);
    await page
      .getByRole("button", { name: "I have saved my recovery codes" })
      .click();
    // The codes are activated by a request; until it lands the owner still
    // owes a second factor, and /team would send them back to security.
    await expect(
      page.getByRole("button", { name: "I have saved my recovery codes" }),
    ).toHaveCount(0);
    const before = await page.request.get("/api/workspaces/security", { headers: { "X-Workbench-Scope": ownerScope } }).then((r) => r.json());
    expect(before.requiresMfa).toBe(false);
    /* A wrong code is refused by the server (401) and said as it says it; the rule stays as it was. */
    await page.goto(SECURITY);
    await toggle(page).click();
    await page.getByTestId("settings-workspace-two-step-form").getByLabel("Your password").fill(password);
    await page.getByTestId("settings-workspace-two-step-form").getByLabel("Authenticator or recovery code").fill("000000");
    const refused = page.waitForResponse((r) => r.url().endsWith("/api/workspaces/security") && r.request().method() === "POST");
    await page.getByTestId("settings-workspace-two-step-confirm").click();
    expect((await refused).status()).toBe(401);
    await expect(page.getByTestId("settings-workspace-two-step-note")).toContainText("That code is invalid or already used");
    await expect(rule(page)).toContainText("off");
    /* The fields are cleared after every answer; nothing typed is kept. */
    await expect(page.getByTestId("settings-workspace-two-step-form").getByLabel("Your password")).toHaveValue("");
    let policy;
    if (testInfo.project.name === "customer-1440x900") {
      /* The answer to the owner's POST is lost after the server committed it: the rule is read back, never guessed. */
      let lost = false;
      await page.route("**/api/workspaces/security", async (route) => {
        if (route.request().method() !== "POST" || lost) return route.continue();
        lost = true;
        const committed = await route.fetch();
        expect(committed.ok(), await committed.text()).toBe(true);
        await route.abort("failed");
      });
      const form = page.getByTestId("settings-workspace-two-step-form");
      await form.getByLabel("Your password").fill(password);
      await form.getByLabel("Authenticator or recovery code").fill(ownerCodes[0]);
      await page.getByTestId("settings-workspace-two-step-confirm").click();
      await expect(page.getByTestId("settings-workspace-two-step-note")).toContainText("The connection dropped");
      await expect(rule(page)).toContainText("on");
      await expect(toggle(page)).toHaveText("Turn off");
      await page.unroute("**/api/workspaces/security");
      policy = await page.request.get("/api/workspaces/security", { headers: { "X-Workbench-Scope": ownerScope } }).then((r) => r.json());
    } else {
      policy = await setPolicy(page, ownerScope, true, ownerCodes[0]);
    }
    await expect(rule(page)).toContainText("1 of 2 people have not set it up");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace-rule-owner.png"), fullPage: false });
    expect(policy.requiresMfa).toBe(true);
    /* "1 of 2 active members have enrolled": the owner has, the member has not. */
    expect(policy.members - policy.unenrolled).toBe(1);
    expect(policy.members).toBe(2);
    /* A member's open page learns of it on the next request: the API refuses (below), and the shell goes to sign-in setup. */
    for (const path of [
      "/api/jobs?sync=0",
      "/api/uploads/private-probe",
      "/api/team",
    ])
      expect((await member.request.get(path)).status()).toBe(428);
    const denied = await member.request.post("/api/generate", {
      headers: { "X-Workbench-Scope": memberScope },
      data: {},
    });
    expect(denied.status()).toBe(428);
    expect((await bearer.get("/api/jobs?sync=0")).status()).toBe(401);
    const restricted = await member.request
      .get("/api/me")
      .then((r) => r.json());
    expect(restricted).toMatchObject({
      id: me.id,
      mfaRequired: true,
      credits: null,
      models: null,
      setup: null,
    });
    expect(restricted.rates).toBeUndefined();
    const switched = await member.request.post("/api/workspaces/switch", {
      headers: { "X-Workbench-Scope": memberScope },
      data: { id: own.workspace.id },
    });
    expect(switched.ok()).toBe(true);
    expect((await member.request.get("/api/jobs?sync=0")).status()).toBe(200);
    expect(
      (
        await member.request.post("/api/workspaces/switch", {
          headers: {
            "X-Workbench-Scope": `particl-active-${own.workspace.id}-${me.id}`,
          },
          data: { id: owner.workspace.id },
        })
      ).ok(),
    ).toBe(true);
    for (const path of [
      "/suites",
      "/workbench",
      "/workbench/movie",
      "/billing",
      "/team",
    ]) {
      await member.goto(path);
      await expect(member).toHaveURL(/\/account\/security$/);
    }
    await expect(
      member.getByText(/requires two-step sign-in\. Set up your authenticator/),
    ).toBeVisible();
    await enrol(member);
    await expect(
      member.getByRole("link", { name: "Continue to workspace", exact: true }),
    ).toHaveCount(0);
    await expect(
      member.getByRole("button", {
        name: "Turn off two-step sign-in",
        exact: true,
      }),
    ).toBeDisabled();
    await member
      .getByRole("button", { name: "I have saved my recovery codes" })
      .click();
    await expect(
      member.getByRole("link", { name: "Continue to workspace", exact: true }),
    ).toBeVisible();
    await member
      .getByRole("link", { name: "Continue to workspace", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await member.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await member.screenshot({
      path: testInfo.outputPath("workspace-member-enrolled.png"),
      fullPage: false,
    });
    await member
      .getByRole("link", { name: "Continue to workspace", exact: true })
      .click();
    await expect(member).toHaveURL(/\/suites(\?|$)/);
    expect((await member.request.get("/api/jobs?sync=0")).status()).toBe(200);
    expect((await bearer.get("/api/jobs?sync=0")).status()).toBe(200);
    await member.goto(SECURITY);
    await expect(rule(member)).toContainText("on");
    await expect(toggle(member)).toHaveCount(0);
    await expect(member.getByTestId("settings-workspace-two-step-form")).toHaveCount(0);
    /* The owner makes it optional again, in the browser, with a second fresh code. */
    expect((await setPolicy(page, ownerScope, false, ownerCodes[1])).requiresMfa).toBe(false);
  } finally {
    await bearer?.dispose();
    await memberContext.close();
  }
});
