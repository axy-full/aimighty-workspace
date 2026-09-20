import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { DEFAULT_PLANS } from "../lib/plans";
import type { Project } from "../lib/workbench/studio";
import { legacyShell, askForLegacyShell } from "./helpers/legacyShell";

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
  /* This spec drives the OLD shell; ask for it (docs/workspace-switchover.md). */
  await askForLegacyShell(page);
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
    settings: {
      namingTemplate: "{project}_{shot}_v{version}",
      defaultVideoModel: "",
      defaultImageModel: "",
      approvalRule: "cap",
      shotCapCredits: "50",
      capWarnPct: "80",
      atCap: "producer",
      atomikEngines: "[]",
      deriveForApi: "1",
      retentionDays: "0",
      editOutputFormat: "mp4",
      lockNewAssets: "0",
      trainOnCreate: "ask",
    } as Record<string, string>,
    settingsWrites: [] as Record<string, unknown>[],
    packRequests: [] as Record<string, unknown>[],
    invites: [] as {
      code: string;
      name: string;
      email: string;
      expiresAt: number;
    }[],
    members: [
      {
        id: "owner-fixture",
        name: "Production House Owner",
        email: "owner@example.test",
        role: "admin",
        permanent: true,
        disabled: false,
        locked: false,
        clips: 3,
        lastSeen: Date.now(),
      },
      {
        id: "member-fixture",
        name: "Camera Operator",
        email: "camera@example.test",
        role: "member",
        permanent: false,
        disabled: false,
        locked: false,
        clips: 2,
        lastSeen: Date.now(),
      },
    ],
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
    if (path === "/api/atomik")
      return json({
        chats: [],
        engines: [],
        models: { featured: [], rest: [] },
      });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me")
      return json({
        ...account,
        id: "owner-fixture",
        email: "owner@example.test",
        role: state.owner ? "admin" : "member",
        owner: state.owner,
      });
    if (path === "/api/settings") {
      if (request.method() === "PATCH") {
        state.settingsWrites.push(body);
        Object.assign(state.settings, body);
      }
      return json({
        settings: state.settings,
        defaults: state.settings,
        models: { video: "", image: "" },
      });
    }
    if (path === "/api/team") {
      if (request.method() === "POST") {
        const invite = {
          code: "new-invite-" + state.invites.length,
          name: String(body.name),
          email: String(body.email),
          expiresAt: Date.now() + 86400000,
        };
        state.invites.push(invite);
        return json({ ...invite, sent: false });
      }
      return json({
        canSeeRoles: state.owner,
        mail: { configured: false },
        users: state.members,
        invites: state.invites,
        requests: [],
      });
    }
    if (path === "/api/team/member-fixture") {
      Object.assign(state.members[1], body);
      return json({ ok: true });
    }
    if (path === "/api/engines")
      return json({ engines: [], refiner: { writer: "none", label: "None" } });
    if (path === "/api/limits")
      return json({
        limits: { storageBytes: 10000000000 },
        standing: { usedBytes: 2000000000 },
      });
    if (path === "/api/me/notify") return json({ prefs: {} });
    if (path === "/api/workspaces/topups") {
      if (request.method() === "POST") {
        state.packRequests.push(body);
        return json({
          request: { id: "pack-request" },
          checkout: { kind: "queued" },
        });
      }
      return json({
        applies: true,
        provider: "manual",
        canRequest: state.owner,
        credits: { balance: 120 },
        packs: [
          {
            id: "starter",
            label: "Starter",
            credits: 500,
            bonus: 0,
            total: 500,
            usd: 50,
          },
          {
            id: "team",
            label: "Team",
            credits: 2000,
            bonus: 200,
            total: 2200,
            usd: 200,
          },
          {
            id: "studio",
            label: "Studio",
            credits: 5000,
            bonus: 750,
            total: 5750,
            usd: 500,
          },
          {
            id: "agency",
            label: "Agency",
            credits: 20000,
            bonus: 4000,
            total: 24000,
            usd: 2000,
          },
        ],
        requests: [],
      });
    }
    if (path === "/api/usage")
      return json({
        spentCredits: 30,
        spentUsd: 0,
        totalGenerations: 5,
        succeeded: 4,
        failed: 1,
        pending: 0,
        storage: null,
        vendors: [{ id: "fal", label: "fal" }],
        byProject: [{ name: "Opening sequence", n: 4, spend: 0, credits: 25 }],
        byPerson: [{ name: "Camera Operator", n: 5, spend: 0, credits: 30 }],
        byMonth: [{ month: "2026-09", n: 5, spend: 0, credits: 30 }],
        recent: [
          {
            id: "fixture-take",
            kind: "video",
            title: "Opening wide",
            label: "Kling",
            provider: "fal",
            prompt: "A quiet opening scene",
            costUsd: 0,
            credits: 5,
            params: { resolution: "1080p", ratio: "16:9" },
            createdAt: Date.now(),
          },
        ],
      });
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
    if (path === "/api/workspaces/security" && request.method() === "GET")
      return json({
        requiresMfa: false,
        ownerEnrolled: false,
        members: 1,
        unenrolled: 1,
      });
    if (path === "/api/workspaces") {
      if (request.method() === "GET")
        return json({
          active: account.workspace.id,
          workspaces: account.workspaces,
          pending: state.pending,
          canCreate: true,
        });
      if (request.method() === "PATCH") {
        account.workspace = { ...account.workspace, name: String(body.name) };
        return json({ ok: true, workspace: account.workspace });
      }
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
    if (path === "/api/auth/logout") {
      state.events.push("logout");
      return json({ ok: true });
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
    if (path === "/api/workbench/development" && request.method() === "GET")
      return json({ configured: false, models: [], jobs: [] });
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
    .getByRole("button", { name: "Start a project", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Project name", { exact: true })
    .fill("Our first commercial");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
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
    page.getByRole("menuitem", { name: "Credits & plan", exact: true }),
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
  await page.goto(await legacyShell(page, "/workbench"));
  await page
    .getByRole("button", { name: "Start a project", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Project name", { exact: true })
    .fill("First workspace production");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect.poll(() => state.draft?.name).toBe("First workspace production");
  state.holdSave = true;
  await page
    .getByLabel("Project title", { exact: true })
    .fill("Save before workspace switch");
  await expect.poll(() => state.saveHeld).toBeTruthy();
  await page
    .getByLabel("Project title", { exact: true })
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
    .getByLabel("Project title", { exact: true })
    .fill("Still editable after refusal");
  await expect
    .poll(() => state.draft?.name)
    .toBe("Still editable after refusal");
});

test("workspace management saves settings, invites locally and requests the unchanged credit pack", async ({
  page,
}, testInfo) => {
  const state = await customerFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Your workspace", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Updated Customer Pictures");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByText("Workspace changes saved.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await page.getByLabel("Shot credit cap", { exact: true }).fill("75");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => state.settings.shotCapCredits).toBe("75");
  expect(state.settingsWrites).toContainEqual({ shotCapCredits: "75" });
  await noOverflow(page);
  await page.locator(".shell-page").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("management-workspace.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete workspace", exact: true }),
  ).toBeVisible();
  await page.goto("/team");
  await expect(
    page.getByText("Camera Operator", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Invite someone", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Second Camera");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("second-camera@example.test");
  await page
    .getByRole("button", { name: "Create invite", exact: true })
    .click();
  await expect(
    page.getByText("second-camera@example.test", { exact: true }),
  ).toBeVisible();
  expect(state.invites).toHaveLength(1);
  await noOverflow(page);
  await page.locator(".shell-page").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("management-people.png"),
    fullPage: false,
  });
  await page.goto("/billing");
  await expect(
    page.getByRole("heading", { name: "Plans & credits", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Continue to secure checkout",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Request pack", exact: true })
    .first()
    .click();
  await expect.poll(() => state.packRequests).toEqual([{ packId: "starter" }]);
  await expect(
    page.getByText("Credit pack requested.", { exact: false }),
  ).toBeVisible();
  await noOverflow(page);
  await page.locator(".shell-page").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("management-credits.png"),
    fullPage: false,
  });
  await page.goto("/usage");
  await expect(
    page.getByRole("heading", { name: "Activity ledger", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Opening wide/ }).click();
  await expect(
    page.getByText("A quiet opening scene", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.locator(".shell-page").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("management-usage.png"),
    fullPage: false,
  });
  expect(state.checkouts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("dirty workspace settings survive cancelled navigation and discard only after approval", async ({
  page,
}) => {
  const state = await customerFixture(page);
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.accept();
  });
  await page.goto("/settings");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Unsaved Customer Pictures");
  await page.getByRole("button", { name: "Production", exact: true }).click();
  const video = page.getByLabel("Default video model", { exact: true });
  await expect(
    video.getByRole("option", { name: "Topaz Astra 2", exact: true }),
  ).toHaveCount(0);
  await expect(
    video.getByRole("option", { name: "Luma Ray 2", exact: true }),
  ).toHaveCount(0);
  expect(await video.locator("option").count()).toBeGreaterThan(1);
  await page.getByLabel("Shot credit cap", { exact: true }).fill("75");
  const management = page.getByRole("navigation", {
    name: "Workspace management",
  });
  await management.getByRole("link", { name: "People", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Shot credit cap", { exact: true })).toHaveValue(
    "75",
  );
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "Unsaved Customer Pictures",
  );
  expect(state.settingsWrites).toEqual([]);
  await page.getByRole("link", { name: "Manage people", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(
    page.getByText("Camera Operator", { exact: true }),
  ).toBeVisible();
  expect(nativeDialogs).toEqual([]);
  expect(state.settingsWrites).toEqual([]);
  await management
    .getByRole("link", { name: "Workspace", exact: true })
    .click();
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "Customer Pictures",
  );
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByLabel("Shot credit cap", { exact: true })).toHaveValue(
    "50",
  );
  await page.getByLabel("Shot credit cap", { exact: true }).fill("75");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Workspace changes saved.", { exact: true }),
  ).toBeVisible();
  await management.getByRole("link", { name: "People", exact: true }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(dialog).toHaveCount(0);
  expect(state.settingsWrites).toEqual([{ shotCapCredits: "75" }]);
  await management
    .getByRole("link", { name: "Workspace", exact: true })
    .click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Discarded menu edit");
  await page
    .getByRole("button", { name: "Workspace credits and billing", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/billing$/);
  await expect(
    page.getByRole("heading", { name: "Plans & credits", exact: true }),
  ).toBeVisible();
  expect(nativeDialogs).toEqual([]);
  expect(state.settingsWrites).toEqual([{ shotCapCredits: "75" }]);
});

test("mobile suite tabs preserve unsaved settings confirmation", async ({
  page,
}) => {
  test.skip(page.viewportSize()!.width >= 760, "phone suite tabs");
  const state = await customerFixture(page);
  await page.goto("/settings");
  const workspaceName = page.getByLabel("Workspace name", { exact: true });
  await workspaceName.fill("Unsaved drawer edit");
  const confirm = page.getByRole("dialog", {
    name: "Discard unsaved changes?",
    exact: true,
  });
  const openSuite = () => page.getByRole("navigation", { name: "Suites", exact: true }).getByRole("link", { name: "Particl Production Studio", exact: true }).click();

  await openSuite();
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  // A normal click must work: the old drawer left this confirmation under its
  // pointer lock and focus trap, making both safe and destructive choices inert.
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(workspaceName).toHaveValue("Unsaved drawer edit");
  expect(state.settingsWrites).toEqual([]);
  expect(state.events).toEqual([]);

  await page.getByRole("button", { name: "Workspace menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Second Studio", exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(workspaceName).toHaveValue("Unsaved drawer edit");
  expect(state.events).toEqual([]);

  await openSuite();
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await confirm.getByRole("button", { name: "Discard and leave", exact: true }).click();
  await expect(page).toHaveURL(/\/workbench(?:\?stage=brief)?$/);
  expect(state.settingsWrites).toEqual([]);
  expect(state.events).toEqual([]);
  await page.goto("/settings");
  await expect(workspaceName).toHaveValue("Customer Pictures");
});

test("dirty settings guard account mutations before POST and recover after a refused switch", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one focused account mutation check",
  );
  const state = await customerFixture(page);
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.accept();
  });
  await page.goto("/settings");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Unsaved account change");
  const dialog = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await page
    .getByRole("button", { name: "Workspace credits and billing", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Second Studio", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.events).toEqual([]);
  state.failSwitch = true;
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Second Studio", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(
    page.getByText("Workspace switching is temporarily unavailable.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.events).toEqual(["switch:other-workspace"]);
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "Unsaved account change",
  );
  await page
    .getByRole("navigation", { name: "Workspace management" })
    .getByRole("link", { name: "People", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.events).toEqual(["switch:other-workspace"]);
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.events).toEqual(["switch:other-workspace"]);
  await page.route("**/login", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Signed out fixture</h1>",
    }),
  );
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Signed out fixture" }),
  ).toBeVisible();
  expect(state.events).toEqual(["switch:other-workspace", "logout"]);
  expect(nativeDialogs).toEqual([]);
  expect(state.settingsWrites).toEqual([]);
});

test("opening Gen drains the latest studio edit before leaving", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one focused save-drain check",
  );
  const state = await customerFixture(page);
  await page.goto(await legacyShell(page, "/workbench"));
  await page
    .getByRole("button", { name: "Start a project", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Project name", { exact: true })
    .fill("Navigation production");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect.poll(() => state.draft?.name).toBe("Navigation production");
  state.holdSave = true;
  await page
    .getByLabel("Project title", { exact: true })
    .fill("First pending edit");
  await expect.poll(() => state.saveHeld).toBeTruthy();
  await page
    .getByLabel("Project title", { exact: true })
    .fill("Latest edit before Gen");
  await page
    .getByRole("navigation", { name: "Rooms", exact: true })
    .getByRole("link", { name: "Make", exact: true })
    .click();
  await expect(page).toHaveURL(/workbench/);
  expect(state.draft?.name).toBe("Navigation production");
  await page.route("**/generate?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Gen destination fixture</h1>",
    }),
  );
  state.releaseSave();
  await expect.poll(() => state.draft?.name).toBe("Latest edit before Gen");
  await expect(page).toHaveURL(/generate/);
});
