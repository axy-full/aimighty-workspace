import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { totpAt } from "../lib/totp";
import { legacyShell } from "./helpers/legacyShell";
const password = "a local browser test passphrase 42";
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
    await member.goto(await legacyShell(page, "/workbench"));
    // The suite header keeps the account status visible on phone and desktop;
    // it no longer uses the legacy mobile workspace drawer.
    await expect(
      member.getByRole("button", {
        name: "Workspace credits and billing",
        exact: true,
      }),
    ).toBeVisible();
    await page.goto("/account/security");
    const ownerCodes = await enrol(page);
    await page
      .getByRole("button", { name: "I have saved my recovery codes" })
      .click();
    await page.goto("/team");
    if (testInfo.project.name === "customer-1440x900") {
      let lost = false;
      await page.route("**/api/workspaces/security", async (route) => {
        if (route.request().method() !== "POST" || lost)
          return route.continue();
        lost = true;
        const committed = await route.fetch();
        expect(committed.ok(), await committed.text()).toBe(true);
        await route.abort("failed");
      });
    }
    await expect(
      page.getByText("Optional for members", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Owner password", { exact: true }).fill(password);
    await page
      .getByLabel("Fresh authenticator or recovery code", { exact: true })
      .fill(ownerCodes[0]);
    await page
      .getByRole("button", { name: "Require two-step sign-in", exact: true })
      .click();
    await expect(
      page.getByText("Required for all members", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("1 of 2 active members have enrolled.", { exact: false }),
    ).toBeVisible();
    await member.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      member.getByRole("link", { name: "Set up sign-in", exact: true }),
    ).toBeVisible();
    await expect(member).toHaveURL(/\/workbench$/);
    await page
      .getByRole("heading", { name: "Workspace sign-in policy", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("workspace-policy-owner.png"),
      fullPage: false,
    });
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
    await expect(member).toHaveURL(/\/workbench$/);
    expect((await member.request.get("/api/jobs?sync=0")).status()).toBe(200);
    expect((await bearer.get("/api/jobs?sync=0")).status()).toBe(200);
    await page.getByLabel("Owner password", { exact: true }).fill(password);
    await page
      .getByLabel("Fresh authenticator or recovery code", { exact: true })
      .fill(ownerCodes[1]);
    await page
      .getByRole("button", {
        name: "Make two-step sign-in optional",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Optional for members", { exact: true }),
    ).toBeVisible();
  } finally {
    await bearer?.dispose();
    await memberContext.close();
  }
});
