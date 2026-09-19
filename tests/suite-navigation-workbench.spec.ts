import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { SUITES, suiteHref } from "../lib/suites";
import { DEFAULT_PLANS } from "../lib/plans";

test("shared suite shell keeps draft context, account controls and guarded keyboard navigation", async ({
  page,
}, info) => {
  test.skip(
    ![
      "workbench-360x640",
      "workbench-390x844",
      "workbench-844x390",
      "workbench-1440x900",
      "workbench-1920x1080",
    ].includes(info.project.name),
    "every configured viewport",
  );
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const project = {
    ...newProject("Suite navigation project"),
    id: "suite-draft",
    productionProjectId: "backend-production",
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) => route.fulfill({ json: data });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects")
      return json({
        project,
        revision: 1,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    if (path === "/api/projects")
      return json({
        projects: [{ id: project.productionProjectId, name: project.name }],
      });
    if (path === "/api/workbench/library")
      return json({
        uploads: [],
        generations: [],
        nextCursor: null,
        nextPageCursor: null,
      });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audio: { configured: false, voices: [], speechModels: [] } });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/atomik/chats") return json({ chats: [] });
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/settings")
      return json({ settings: {}, defaults: {}, models: null });
    if (path === "/api/limits")
      return json({
        limits: { storageBytes: 1_000_000_000 },
        standing: { usedBytes: 0 },
      });
    if (path === "/api/engines") return json({ engines: [] });
    if (path === "/api/me/notify") return json({ prefs: {} });
    return json({});
  });
  await page.goto("/library?project=" + project.id);
  await expect(
    page.getByRole("button", { name: "Select project", exact: true }),
  ).toContainText(project.name);
  await expect(
    page.getByRole("button", { name: "Workspace menu", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Workspace credits and billing",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "All assets", exact: true })).toHaveAttribute("href", "/library?all=1&project=" + project.id);
  const rooms = page.getByRole("navigation", { name: "Rooms", exact: true });
  await expect(
    rooms.getByRole("link", { name: "Make", exact: true }),
  ).toHaveAttribute("href", "/generate?project=" + project.id);
  await expect(
    rooms.getByRole("link", { name: "Library", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const dock = page.getByRole("navigation", {
    name: "Particl Production Studio pages",
    exact: true,
  });
  await expect(
    dock.getByRole("link", { name: "Rig", exact: true }),
  ).toHaveAttribute("href", suiteHref("particl", project.id, "canvas"));
  for (const suite of SUITES)
    await expect(
      page.getByRole("navigation", { name: "Suites", exact: true }).getByRole("link", { name: suite.name, exact: true }),
    ).toHaveAttribute("href", suiteHref(suite.id, project.id));
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const cancel = (event: Event) => {
      (event as CustomEvent<{ checks: Promise<boolean>[] }>).detail.checks.push(
        Promise.resolve(false),
      );
      window.removeEventListener("particl:before-page-leave", cancel);
    };
    window.addEventListener("particl:before-page-leave", cancel);
  });
  await rooms.getByRole("link", { name: "Make", exact: true }).click();
  await expect(page).toHaveURL("/library?project=" + project.id);
  await page.evaluate((scope) => {
    localStorage.setItem(scope, "another-tab-draft");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: scope,
        newValue: "another-tab-draft",
      }),
    );
  }, `particl-active-${me.workspace.id}-${me.id}`);
  await rooms.getByRole("link", { name: "Workspace", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/settings");
  await expect(
    page.getByRole("heading", { name: "Your workspace", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This screen stopped", { exact: true }),
  ).toHaveCount(0);
  await expect(
    rooms.getByRole("link", { name: "Make", exact: true }),
  ).toHaveAttribute("href", "/generate?project=" + project.id);
  await rooms.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "What are we making?", exact: true })).toBeVisible();
  // The home route has no project query. It must retain this tab's captured
  // selection, even though another tab changed the persisted preference above.
  for (const suite of SUITES)
    await expect(page.locator(".suite-home-card").filter({ hasText: suite.name })).toHaveAttribute("href", suiteHref(suite.id, project.id));
  await expect(page.getByRole("link", { name: "Break down a screenplay", exact: true })).toHaveAttribute("href", suiteHref("particl", project.id, "script"));
  await expect(page.getByRole("link", { name: "Start from a saved recipe", exact: true })).toHaveAttribute("href", suiteHref("atomik", project.id, "recipes"));
  await expect(page.getByRole("textbox", { name: "Your next production brief", exact: true })).toBeEnabled();
  await page.locator(".suite-home-card").filter({ hasText: "Atomik Super Agent" }).click();
  await expect(page).toHaveURL(suiteHref("atomik", project.id));
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Suites", exact: true }).getByRole("link")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("shared-suite-shell.png") });
});

test("billing retains scoped suite navigation while checkout stays unavailable", async ({
  page,
}, info) => {
  test.skip(
    !["workbench-360x640", "workbench-1440x900"].includes(info.project.name),
    "phone and desktop billing shell",
  );
  const signed = await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const errors: string[] = [];
  let mutations = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ scope, project }) => localStorage.setItem(scope, project),
    {
      scope: `particl-active-${signed.workspace.id}-${me.id}`,
      project: "remembered-billing-draft",
    },
  );
  await page.route("**/api/**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") mutations++;
    if (path === "/api/me") return route.fulfill({ json: me });
    if (path === "/api/billing")
      return route.fulfill({
        json: {
          configured: false,
          canManage: true,
          reason: "Payments are not connected for this deployment.",
          workspace: signed.workspace,
          plans: DEFAULT_PLANS,
          subscription: null,
          credits: {
            balance: 120,
            includedBalance: 100,
            purchasedBalance: 20,
            bonusBalance: 0,
            nextExpiryAt: null,
          },
        },
      });
    if (path === "/api/workspaces")
      return route.fulfill({
        json: {
          active: signed.workspace.id,
          workspaces: [{ ...signed.workspace, role: "owner" }],
          canCreate: false,
        },
      });
    if (path === "/api/plans")
      return route.fulfill({
        json: {
          plans: DEFAULT_PLANS,
          annualDiscountPercent: 20,
          checkoutAvailable: false,
        },
      });
    if (path === "/api/workspaces/topups")
      return route.fulfill({
        json: {
          applies: true,
          canRequest: false,
          provider: "manual",
          packs: [],
          requests: [],
          credits: { balance: 120 },
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/billing?plan=agency&cadence=annual");
  await expect(
    page.getByRole("heading", { name: "Plans & credits", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Checkout is not available yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Workspace menu", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Rooms", exact: true })
      .getByRole("link", { name: "Make", exact: true }),
  ).toHaveAttribute("href", "/generate?project=remembered-billing-draft");
  await expect(
    page.getByRole("navigation", { name: "Suites", exact: true }).getByRole("link", { name: "Moleculr Business Suite", exact: true }),
  ).toHaveAttribute("href", suiteHref("moleculr", "remembered-billing-draft"));
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(mutations).toBe(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("billing-suite-shell.png") });
});
