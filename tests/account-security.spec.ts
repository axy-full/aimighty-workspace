import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { totpAt } from "../lib/totp";

/**
 * The spec deliberately submits the PREVIOUS step's code to exercise the
 * server's one-step drift tolerance. That tolerance is judged at POST time,
 * so if the 30-second boundary passes between computing the code and the
 * server reading it, the code is two steps old and is refused — the flake
 * seen in CI at 360×640. Wait for a window with enough margin first.
 */
async function previousStepCode(secret: string, marginMs = 8_000): Promise<string> {
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < marginMs) await new Promise((resolve) => setTimeout(resolve, remaining + 250));
  return totpAt(secret, Date.now() - 30_000);
}

test("account security enrolls a real authenticator, rotates sessions, requires MFA and rejects a reused recovery code", async ({
  page,
  browser,
}, testInfo) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const oldBrowser = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const password = "a local browser test passphrase 42";
  try {
    await page.goto("/account/security");
    await expect(
      page.getByRole("heading", { name: "Account security", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const secret = await page
      .getByLabel("Setup key", { exact: true })
      .inputValue();
    await page
      .getByLabel("Authenticator or recovery code", { exact: true })
      .fill(await previousStepCode(secret));
    const enableResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/account/security") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Enable two-step sign-in", exact: true })
      .click();
    const enabled = await enableResponse.then((r) => r.json());
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect(enabled.session).toBeUndefined();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    expect(
      (
        await oldBrowser.request.get(
          `${testInfo.project.use.baseURL ?? process.env.PW_BASE_URL ?? "http://localhost:4551"}/api/account/security`,
          { headers: { "X-Workbench-Scope": scope } },
        )
      ).status(),
    ).toBe(401);
    await page
      .getByRole("button", { name: "I have saved my recovery codes" })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("account-security-enabled.png"),
      fullPage: true,
    });
    await page.context().clearCookies();
    await page.goto("/login?next=/account/security");
    await page.getByLabel("EMAIL", { exact: true }).fill(me.email);
    await page.getByLabel("PASSWORD", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const code = page.getByRole("textbox", {
      name: /AUTHENTICATOR OR RECOVERY CODE/,
    });
    await expect(code).toBeVisible();
    expect((await page.request.get("/api/me")).status()).toBe(401);
    await code.fill(enabled.recoveryCodes[0]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(
      page.getByText("9 unused codes remain.", { exact: false }),
    ).toBeVisible();
    await page.context().clearCookies();
    await page.goto("/login?next=/account/security");
    await page.getByLabel("EMAIL", { exact: true }).fill(me.email);
    await page.getByLabel("PASSWORD", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await code.fill(enabled.recoveryCodes[0]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "already used" }),
    ).toBeVisible();
    expect((await page.request.get("/api/me")).status()).toBe(401);
    await code.fill(enabled.recoveryCodes[1]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(
      page.getByText("8 unused codes remain.", { exact: false }),
    ).toBeVisible();
  } finally {
    await oldBrowser.close();
  }
});

test("a lost recovery-code replacement response resumes the same set after reload before activating it", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one real interrupted-response rehearsal",
  );
  await signInLocally(page.request);
  await page.goto("/account/security");
  const password = "a local browser test passphrase 42";
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = await page
    .getByLabel("Setup key", { exact: true })
    .inputValue();
  await page
    .getByLabel("Authenticator or recovery code", { exact: true })
    .fill(await previousStepCode(secret));
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/account/security") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Enable two-step sign-in", exact: true })
    .click();
  const original = await response.then((r) => r.json());
  await page
    .getByRole("button", { name: "I have saved my recovery codes" })
    .click();
  let lost = false,
    prepared: { batchId: string; recoveryCodes: string[] } | undefined;
  await page.route("**/api/account/security", async (route) => {
    if (
      route.request().method() !== "POST" ||
      route.request().postDataJSON().action !== "rotate_codes" ||
      lost
    )
      return route.continue();
    const result = await route.fetch();
    expect(result.ok()).toBe(true);
    prepared = await result.json();
    lost = true;
    await route.abort("failed");
  });
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page
    .getByLabel("Authenticator or recovery code", { exact: true })
    .fill(original.recoveryCodes[0]);
  await page
    .getByRole("button", { name: "Replace recovery codes", exact: true })
    .click();
  await expect.poll(() => lost).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume recovery code replacement" }),
  ).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Resume recovery code replacement" })
    .click();
  await expect(
    page.getByRole("list", { name: "New recovery codes" }).locator("code"),
  ).toHaveText(prepared!.recoveryCodes);
  await page
    .getByRole("button", { name: "I have saved my recovery codes" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "saved recovery codes are active" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "New recovery codes" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("10 unused codes remain.", { exact: false }),
  ).toBeVisible();
  const me = await page.request.get("/api/me").then((r) => r.json());
  const other = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    const login = await other.request.post("/api/auth/login", {
      data: { email: me.email, password, code: prepared!.recoveryCodes[0] },
    });
    expect(login.ok(), await login.text()).toBe(true);
    await page.reload();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page
      .getByLabel("Authenticator or recovery code", { exact: true })
      .fill(prepared!.recoveryCodes[1]);
    await page
      .getByRole("button", { name: "Replace recovery codes", exact: true })
      .click();
    await expect(
      page.getByRole("list", { name: "New recovery codes" }),
    ).toBeVisible();
    await page
      .getByLabel("Authenticator or recovery code", { exact: true })
      .fill(prepared!.recoveryCodes[2]);
    await page
      .getByRole("button", { name: "End all other sessions", exact: true })
      .click();
    await expect(
      page.getByRole("list", { name: "New recovery codes" }),
    ).toBeVisible();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await expect(
      page.getByRole("button", { name: "I have saved my recovery codes" }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "I have saved my recovery codes" })
      .click();
    await expect(
      page.getByRole("list", { name: "New recovery codes" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("10 unused codes remain.", { exact: false }),
    ).toBeVisible();
    expect((await other.request.get("/api/me")).status()).toBe(401);
  } finally {
    await other.close();
  }
});
