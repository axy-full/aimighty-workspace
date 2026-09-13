import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { DEFAULT_PLANS } from "../lib/plans";
import type { Project } from "../lib/workbench/studio";

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
}
async function customerFixture(page: Page) {
  const signed = await signInLocally(page.request);
  const account = {
    name: "Production House Owner",
    workspace: { id: signed.workspace.id, name: "Customer Pictures" },
    workspaces: [
      { id: signed.workspace.id, name: "Customer Pictures", role: "owner" },
      { id: "other-workspace", name: "Second Studio", role: "member" },
    ],
    credits: { balance: 120 },
  };
  const state = {
    configured: false,
    owner: true,
    pending: [] as {
      requestId: string;
      name: string;
      state: string;
      error: string | null;
    }[],
    draft: null as Project | null,
    revision: 0,
    signups: [] as Record<string, unknown>[],
    resends: 0,
    verifications: 0,
    checkouts: [] as Record<string, unknown>[],
    provision: [] as Record<string, unknown>[],
    events: [] as string[],
    failSwitch: false,
    holdSave: false,
    saveHeld: false,
    releaseSave: () => {},
  };
  let barrier: Promise<void> | null = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const body = request.method() === "GET" ? {} : request.postDataJSON();
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/plans")
      return json({
        plans: DEFAULT_PLANS,
        annualDiscountPercent: 20,
        checkoutAvailable: state.configured,
        reason: "Payments are not connected for this deployment.",
      });
    if (path === "/api/auth/signup") {
      if (request.method() === "GET")
        return json({
          mode: "self-serve",
          open: true,
          verificationRequired: true,
        });
      state.signups.push(body);
      return json(
        {
          ok: true,
          verificationRequired: true,
          email: body.email,
          message: "Open the verification link in your email to continue.",
        },
        202,
      );
    }
    if (path === "/api/auth/signup/resend") {
      state.resends++;
      return json(
        { ok: true, message: "A new verification email is on its way." },
        202,
      );
    }
    if (path === "/api/auth/verify") {
      state.verifications++;
      return json({
        ok: true,
        planId: "agency",
        cadence: "annual",
        next: "/billing?plan=agency&cadence=annual&onboarding=1",
      });
    }
    if (path === "/api/me") return json(account);
    if (path === "/api/billing")
      return json({
        configured: state.configured,
        reason: "Payments are not connected for this deployment.",
        canManage: state.owner,
        workspace: account.workspace,
        plans: DEFAULT_PLANS,
        annualDiscountPercent: 20,
        subscription: null,
        credits: {
          balance: 120,
          includedBalance: 100,
          purchasedBalance: 20,
          bonusBalance: 0,
          nextExpiryAt: Date.now() + 86400000,
        },
      });
    if (path === "/api/billing/checkout") {
      state.checkouts.push(body);
      return json({
        url: "/billing?checkout=success&plan=agency&cadence=annual",
      });
    }
    if (path === "/api/workspaces") {
      if (request.method() === "GET")
        return json({
          active: account.workspace.id,
          workspaces: account.workspaces,
          pending: state.pending,
          canCreate: true,
        });
      state.provision.push(body);
      state.pending = [
        {
          requestId: "provision-customer",
          name: body.name || "New House",
          state: "failed",
          error: "Workspace resources are temporarily unavailable.",
        },
      ];
      return json({ ok: true, provisioning: state.pending[0] }, 202);
    }
    if (path === "/api/workspaces/switch") {
      state.events.push("switch:" + body.id);
      if (state.failSwitch)
        return json(
          { error: "Workspace switching is temporarily unavailable." },
          503,
        );
      account.workspace = { id: "other-workspace", name: "Second Studio" };
      return json({ ok: true, active: "other-workspace" });
    }
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        if (state.holdSave) {
          state.holdSave = false;
          state.saveHeld = true;
          barrier = new Promise<void>((resolve) => {
            state.releaseSave = resolve;
          });
          await barrier;
        }
        state.draft = body.project;
        state.events.push("save:" + body.project.name);
        return json({
          revision: ++state.revision,
          productionProjectId: "customer-production",
          shotMappings: {},
        });
      }
      return json({
        project: state.draft,
        revision: state.revision,
        projects: state.draft
          ? [{ id: state.draft.id, name: state.draft.name }]
          : [],
        productions: [],
      });
    }
    if (path === "/api/workbench/engines")
      return json({ models: [], credits: 0 });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/jobs") return json({ generations: [] });
    throw new Error(
      `Unexpected customer browser API: ${request.method()} ${path}`,
    );
  });
  return state;
}

test("customer can choose annual plan, verify email, review billing and start a production", async ({
  page,
}, testInfo) => {
  const state = await customerFixture(page),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", {
      name: "A workspace for the whole production.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Annual Save 20%" }).click();
  await expect(
    page.getByText("$1,910.40 billed annually", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("pricing.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Choose Agency", exact: true }).click();
  await expect(page).toHaveURL(/plan=agency&cadence=annual/);
  await page.getByLabel(/^Your name$/i).fill("Camera House Owner");
  await page.getByLabel(/^Work email$/i).fill("verified-owner@example.test");
  await page.getByLabel(/^Workspace name$/i).fill("Camera House");
  await page.getByLabel(/^Password$/i).fill("a valid local passphrase 82");
  await page
    .getByLabel(/^Confirm password$/i)
    .fill("a valid local passphrase 82");
  await page.getByRole("checkbox").check();
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("signup.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "Create account and verify email",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true }),
  ).toBeVisible();
  expect(state.signups).toHaveLength(1);
  expect(state.signups[0]).toMatchObject({
    planId: "agency",
    cadence: "annual",
    workspace: "Camera House",
  });
  expect(state.checkouts).toHaveLength(0);
  await page
    .getByRole("button", { name: "Resend verification email", exact: true })
    .click();
  await expect.poll(() => state.resends).toBe(1);
  await page.goto("/signup?verify=customer-token");
  await expect(page).toHaveURL(/billing\?plan=agency&cadence=annual/);
  expect(state.verifications).toBe(1);
  await expect(
    page.getByRole("combobox", { name: "Workspace plan" }),
  ).toHaveValue("agency");
  await expect(
    page.getByRole("combobox", { name: "Billing period" }),
  ).toHaveValue("annual");
  const checkout = page.getByRole("button", {
    name: "Continue to secure checkout",
    exact: true,
  });
  await expect(checkout).toBeDisabled();
  await expect(
    page.getByText("Checkout is not available yet.", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("billing-unavailable.png"),
    fullPage: true,
  });
  state.configured = true;
  await page.reload();
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect(page).toHaveURL(/checkout=success/);
  expect(state.checkouts).toEqual([{ planId: "agency", cadence: "annual" }]);
  await page
    .getByRole("link", { name: "Open your studio", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What are you making next?" }),
  ).toBeVisible();
  expect(state.draft).toBeNull();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("first-production.png") });
  await page
    .getByRole("button", { name: "Explore sample", exact: true })
    .click();
  await expect(page.locator(".sample-preview-banner")).toBeVisible();
  expect(state.draft).toBeNull();
  await page
    .locator(".sample-preview-banner")
    .getByRole("button", { name: "Start a production", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Production name", { exact: true })
    .fill("Our first commercial");
  await dialog
    .getByRole("button", { name: "Create production", exact: true })
    .click();
  await expect.poll(() => state.draft?.name).toBe("Our first commercial");
  await expect(page.locator(".sample-preview-banner")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Team", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Billing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Usage", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("workspace setup retries the same request and members cannot start checkout", async ({
  page,
}, testInfo) => {
  const state = await customerFixture(page);
  await page.goto("/billing?workspace=new&plan=studio&cadence=monthly");
  await page
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill("New House");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByText("Workspace resources are temporarily unavailable.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry workspace setup", exact: true })
    .click();
  await expect.poll(() => state.provision.length).toBe(2);
  expect(state.provision).toEqual([
    { name: "New House" },
    { requestId: "provision-customer" },
  ]);
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("workspace-setup-retry.png"),
    fullPage: true,
  });
  state.owner = false;
  state.configured = true;
  await page.goto("/billing");
  await expect(
    page.getByRole("button", {
      name: "Continue to secure checkout",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText("The workspace owner manages the subscription.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(state.checkouts).toHaveLength(0);
});

test("workspace switch drains saves and a refused switch retains editing", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "desktop save-drain regression; customer flow covers each responsive layout",
  );
  const state = await customerFixture(page);
  await page.goto("/workbench");
  await page
    .getByRole("button", { name: "Start a production", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Production name", { exact: true })
    .fill("First workspace production");
  await dialog
    .getByRole("button", { name: "Create production", exact: true })
    .click();
  await expect.poll(() => state.draft?.name).toBe("First workspace production");
  state.holdSave = true;
  await page
    .getByLabel("Production title", { exact: true })
    .fill("Save before workspace switch");
  await expect.poll(() => state.saveHeld).toBeTruthy();
  await page
    .getByLabel("Production title", { exact: true })
    .fill("Final edit before workspace switch");
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Second Studio", exact: true })
    .click();
  expect(state.events.some((event) => event.startsWith("switch:"))).toBeFalsy();
  state.failSwitch = true;
  state.releaseSave();
  await expect
    .poll(() =>
      state.events.some((event) => event === "switch:other-workspace"),
    )
    .toBeTruthy();
  expect(state.draft?.name).toBe("Final edit before workspace switch");
  expect(state.events.at(-2)).toBe("save:Final edit before workspace switch");
  await expect(
    page.getByText("Workspace switching is temporarily unavailable.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Production title", { exact: true })
    .fill("Still editable after refusal");
  await expect
    .poll(() => state.draft?.name)
    .toBe("Still editable after refusal");
});
