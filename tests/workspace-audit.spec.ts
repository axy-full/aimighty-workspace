import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

test("workspace activity loads, recovers errors and paginates committed changes with captured scope", async ({
  page,
}, testInfo) => {
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const cursor = "opaque+cursor/older?row";
  const now = Date.now();
  const entries = [
    {
      id: "newest",
      workspaceId: me.workspace.id,
      actorId: me.id,
      action: "member.updated",
      targetType: "member",
      targetId: me.id,
      createdAt: now,
      details: { role: "admin", disabled: false },
    },
    {
      id: "middle",
      workspaceId: me.workspace.id,
      actorId: null,
      action: "workspace.mode_changed",
      targetType: "workspace",
      targetId: me.workspace.id,
      createdAt: now - 60_000,
      details: { mode: "own" },
    },
    {
      id: "oldest",
      workspaceId: me.workspace.id,
      actorId: "retired-person",
      action: "api_token.revoked",
      targetType: "api_token",
      targetId: "token-record-id",
      createdAt: now - 120_000,
      details: { scope: "read" },
    },
  ];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const calls: (string | null)[] = [];
  await page.route("**/api/workspaces/audit?**", async (route) => {
    expect(route.request().headers()["x-workbench-scope"]).toBe(scope);
    const before = new URL(route.request().url()).searchParams.get("before");
    calls.push(before);
    if (fail) {
      await gate;
      return route
        .fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Activity is temporarily unavailable.",
          }),
        })
        .catch(() => {});
    }
    if (before) expect(before).toBe(cursor);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        events: before ? entries.slice(1) : entries.slice(0, 2),
        nextCursor: before ? null : cursor,
        actors: { [me.id]: "Ava Director" },
      }),
    });
  });
  await page.goto("/settings#activity");
  await expect(
    page.getByText("Loading activity…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Activity is temporarily unavailable." }),
  ).toBeVisible();
  fail = false;
  await page
    .getByRole("button", { name: "Retry activity", exact: true })
    .click();
  const history = page.getByRole("list", {
    name: "Workspace activity entries",
  });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history.getByText("System", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Load older activity", exact: true })
    .click();
  await expect(history.getByRole("listitem")).toHaveCount(3);
  await expect(
    history.getByText("Former member", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load older activity", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workspace-activity.png"),
    fullPage: true,
  });
  fail = true;
  await page
    .getByRole("button", { name: "Refresh activity", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Activity is temporarily unavailable." }),
  ).toBeVisible();
  await expect(history.getByRole("listitem")).toHaveCount(3);
  expect(calls.at(-1)).toBeNull();
  fail = false;
  await page
    .getByRole("button", { name: "Retry activity", exact: true })
    .click();
  await expect(history.getByRole("listitem")).toHaveCount(2);
  expect(calls.at(-1)).toBeNull();
});

test("members cannot open the workspace activity view or trigger its request", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one UI role-boundary regression",
  );
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  let calls = 0;
  await page.route("**/api/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...me, owner: false, role: "member" }),
    }),
  );
  await page.route("**/api/workspaces/audit?**", (route) => {
    calls++;
    return route.fulfill({ status: 403, body: "Forbidden" });
  });
  await page.goto("/settings#activity");
  await expect(
    page.getByText("Workspace activity is available to owners and admins.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Activity", exact: true }),
  ).toHaveCount(0);
  expect(calls).toBe(0);
});
