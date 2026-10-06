import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { totpAt } from "../lib/totp";
const password = "a local browser test passphrase 42";

/**
 * The workspace's two-step rule is set through the same route the old People page used (POST /api/workspaces/security: the
 * owner's password and a fresh authenticator or recovery code). The page that drew it is gone (/team is Settings > Team, which
 * shows the rule read-only), so the owner's side is driven at the route, with every check on its answer kept.
 */
async function setPolicy(page: Page, scope: string, requiresMfa: boolean, code: string) {
  const response = await page.request.post("/api/workspaces/security", {
    headers: { "X-Workbench-Scope": scope },
    data: { requiresMfa, password, code },
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).requiresMfa).toBe(requiresMfa);
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
    if (testInfo.project.name === "customer-1440x900") {
      /* The answer to the owner's POST is lost after the server committed it: the policy is read back, never guessed. */
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
    const before = await page.request.get("/api/workspaces/security", { headers: { "X-Workbench-Scope": ownerScope } }).then((r) => r.json());
    expect(before.requiresMfa).toBe(false);
    let policy;
    if (testInfo.project.name === "customer-1440x900") {
      /* page.request is not routed: drive the lost answer through the page's own fetch so the abort applies. */
      const lostAnswer = await page.evaluate(async ({ scope, password: pw, code }) => {
        try {
          await fetch("/api/workspaces/security", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify({ requiresMfa: true, password: pw, code }) });
          return "answered";
        } catch {
          return "lost";
        }
      }, { scope: ownerScope, password, code: ownerCodes[0] });
      expect(lostAnswer).toBe("lost");
      policy = await page.request.get("/api/workspaces/security", { headers: { "X-Workbench-Scope": ownerScope } }).then((r) => r.json());
      expect(policy.requiresMfa).toBe(true);
    } else {
      policy = await setPolicy(page, ownerScope, true, ownerCodes[0]);
    }
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
    /* The owner makes it optional again, with a second fresh code. */
    expect((await setPolicy(page, ownerScope, false, ownerCodes[1])).requiresMfa).toBe(false);
  } finally {
    await bearer?.dispose();
    await memberContext.close();
  }
});
