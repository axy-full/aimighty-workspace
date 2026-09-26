import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { totpAt } from "../lib/totp";
import { password, noSideScroll, signupInvite } from "./helpers/identityAdmin";

/* Identity fixes, in the browser at every size the customer config runs (its
   shards already serve the account pages, so these add no new routes to a
   workbench shard's dev server). Named to sort beside account-security and
   away from gen.spec, whose 1440 upload test leaves a shard's dev server
   near the runner's memory limit. The platform desk has its own spec
   (tests/platform-desk.spec.ts). Local ENGINE_MOCK server only. */

test("after a reset that needs the second factor, sign-in says the password changed", async ({ page }) => {
  await page.goto("/login?passwordReset=1");
  await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await page.goto("/login");
  await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toHaveCount(0);
});

test("sign-up from an invitation keeps the invitation through sign-in, and a gateway error reads as a status", async ({ page }) => {
  const code = await signupInvite(`invited-${randomBytes(6).toString("hex")}@example.test`);
  await page.goto(`/signup?invite=${code}`);
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute(
    "href",
    "/login?next=" + encodeURIComponent(`/signup?invite=${code}`),
  );
  expect(await noSideScroll(page)).toBe(true);
  await page.route("**/api/auth/signup?code=*", (route) =>
    route.fulfill({ status: 502, contentType: "text/html", body: "<!DOCTYPE html><h1>Bad gateway</h1>" }),
  );
  await page.reload();
  await expect(page.getByText("The server answered 502. Try again in a moment.")).toBeVisible();
  await expect(page.getByText(/not valid JSON|Unexpected token/)).toHaveCount(0);
});

test("a new teammate agrees to the terms on the invitation page before the account is made", async ({ page, browser }, testInfo) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const email = `teammate-${randomBytes(6).toString("hex")}@example.test`;
  const made = await page.request.post("/api/team", {
    headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` },
    data: { email, name: "Teammate", role: "member", send: false },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { code } = await made.json();
  const guest = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
  });
  try {
    const invitee = await guest.newPage();
    await invitee.goto(`/invite/${code}`);
    await invitee.getByLabel("PASSWORD", { exact: true }).fill(password);
    await invitee.getByLabel("CONFIRM", { exact: true }).fill(password);
    const agree = invitee.getByRole("checkbox");
    const box = await invitee.locator("label").filter({ has: agree }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await noSideScroll(invitee)).toBe(true);
    await invitee.getByRole("button", { name: "Join the workspace" }).click();
    await expect(invitee).toHaveURL(new RegExp(`/invite/${code}$`));
    expect((await invitee.request.get("/api/me")).status()).toBe(401);
    await agree.check();
    await invitee.getByRole("button", { name: "Join the workspace" }).click();
    // Joined once the session exists; the page then moves on to the workspace.
    await expect
      .poll(async () => (await invitee.request.get("/api/me")).status(), { timeout: 60_000 })
      .toBe(200);
    const joined = await invitee.request.get("/api/me").then((r) => r.json());
    expect(joined.email).toBe(email);
  } finally {
    await guest.close();
  }
});

test("a copied invitation link asks for the invitation email before a new account is made", async ({ page }) => {
  const code = `copied-${randomBytes(6).toString("hex")}`;
  const info = { ok: true, workspace: "Harbour", email: "new@example.test", name: "New", role: "member", hasAccount: false, signedInAsInvitee: false };
  const looked: string[] = [];
  const posted: Record<string, unknown>[] = [];
  // The mocks answer in the accept route's own shapes.
  await page.route("**/api/auth/accept**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const url = new URL(req.url());
      looked.push(url.search);
      return route.fulfill({ json: { ...info, mailboxNeeded: url.searchParams.get("m") !== "proof-from-email" } });
    }
    posted.push(req.postDataJSON());
    return route.fulfill({ json: { ok: true, sent: true } });
  });
  await page.goto(`/invite/${code}`);
  const ask = page.getByRole("button", { name: "Email me the link" });
  await expect(ask).toBeVisible();
  await expect(page.getByLabel("PASSWORD", { exact: true })).toHaveCount(0);
  expect((await ask.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await noSideScroll(page)).toBe(true);
  await ask.click();
  await expect(page.getByRole("status").filter({ hasText: "Open the link in that email" })).toBeVisible();
  expect(posted).toEqual([{ code, emailLink: true }]);
  // Opened from the email, the proof travels with the look-up and the join.
  await page.goto(`/invite/${code}?m=proof-from-email`);
  await expect(page.getByLabel("PASSWORD", { exact: true })).toBeVisible();
  expect(looked.at(-1)).toContain("m=proof-from-email");
  await page.getByLabel("PASSWORD", { exact: true }).fill(password);
  await page.getByLabel("CONFIRM", { exact: true }).fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Join the workspace" }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]).toMatchObject({ code, m: "proof-from-email", accept: true });
});

test("the Team page says an invitation hit the mail limit, not that delivery failed", async ({ page }) => {
  await signInLocally(page.request);
  const limit = "That address has been sent 3 invitations from this workspace today. Copy the invitation link instead.";
  // Only the invitation POST is answered here, in the route's own shape; the roster loads for real.
  await page.route("**/api/team", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ json: { code: "limited-code", email: "someone@example.test", name: "Someone", role: "member", expiresInDays: 7, sent: false, mailError: limit, mailLimited: true } })
      : route.fallback(),
  );
  await page.goto("/team");
  await page.getByRole("button", { name: "Invite someone" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("Someone");
  await page.getByLabel("Email address", { exact: true }).fill("someone@example.test");
  await page.getByRole("button", { name: /Send invite|Create invite/ }).click();
  await expect(page.getByText(`Invitation created, not emailed. ${limit}`)).toBeVisible();
  await expect(page.getByText(/Email delivery failed/)).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
});

test("a member whose workspace requires two-step sign-in replaces a lost authenticator", async ({ page }) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.goto("/account/security");
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const oldSecret = await page.getByLabel("Setup key", { exact: true }).inputValue();
  await page.getByLabel("Authenticator or recovery code", { exact: true }).fill(totpAt(oldSecret, Date.now()));
  const enabled = page.waitForResponse((r) => r.url().endsWith("/api/account/security") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Enable two-step sign-in", exact: true }).click();
  const codes = (await enabled.then((r) => r.json())).recoveryCodes as string[];
  await page.getByRole("button", { name: "I have saved my recovery codes" }).click();
  const required = await page.request.post("/api/workspaces/security", {
    headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` },
    data: { requiresMfa: true, password, code: codes[0] },
  });
  expect(required.ok(), await required.text()).toBe(true);
  await page.reload();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByLabel("Authenticator or recovery code", { exact: true }).fill(codes[1]);
  await expect(page.getByRole("button", { name: "Turn off two-step sign-in" })).toBeDisabled();
  await page.getByRole("button", { name: "Replace authenticator" }).click();
  await expect(page.getByRole("heading", { name: "Add Particl to your new authenticator" })).toBeVisible();
  const newSecret = await page.getByLabel("Setup key", { exact: true }).inputValue();
  expect(newSecret).not.toBe(oldSecret);
  await expect(page.getByLabel("Authenticator or recovery code", { exact: true })).toHaveValue("");
  await page.getByLabel("Authenticator or recovery code", { exact: true }).fill(totpAt(newSecret, Date.now()));
  await page.getByRole("button", { name: "Use new authenticator", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your new authenticator is active" })).toBeVisible();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  const state = await page.request
    .get("/api/account/security", { headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` } })
    .then((r) => r.json());
  expect(state.enabled).toBe(true);
  expect(state.recoveryCodesRemaining).toBe(8);
});
