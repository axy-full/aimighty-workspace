import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * Workspace activity, read for owners and admins only, in Settings › Team › Security (the old /settings#activity page is gone in
 * Release 1; its address opens Settings). The read goes under the captured scope, names the people it can name (a system change, a
 * former member), says when it fails, and is never made at all for a member. Settings shows the five most recent entries and has
 * no paging: older ones are read from the route (a cursor, covered by tests/unit/securityAudit.spec.ts).
 */
const SECURITY = "/suites?view=workspace&tab=team&open=security";

test("workspace activity is read under the captured scope, says when it fails, and lists the most recent changes", async ({
  page,
}, testInfo) => {
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
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
  let fail = true;
  const seen: { scope: string | undefined; limit: string | null }[] = [];
  await page.route("**/api/workspaces/audit?**", async (route) => {
    const url = new URL(route.request().url());
    seen.push({ scope: route.request().headers()["x-workbench-scope"], limit: url.searchParams.get("limit") });
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Activity is temporarily unavailable." }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: entries, nextCursor: null, actors: { [me.id]: "Ava Director" } }),
    });
  });
  await page.goto(SECURITY);
  const row = page.getByTestId("settings-audit");
  await expect(row).toContainText("Activity is temporarily unavailable.");
  fail = false;
  await page.reload();
  await expect(row).toContainText("Changed member access");
  await expect(row).toContainText("Changed model access");
  await expect(row).toContainText("Revoked API token");
  await expect(row).not.toContainText("Nothing recorded yet");
  /* Every read went under this workspace and this person's scope. */
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen.every((call) => call.scope === scope)).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workspace-activity.png"),
    fullPage: true,
  });
});

test("members cannot open the workspace activity or trigger its request", async ({
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
  await page.goto(SECURITY);
  await expect(page.getByTestId("settings-security")).toBeVisible();
  await expect(page.getByTestId("settings-two-step")).toBeVisible();
  await expect(page.getByTestId("settings-audit")).toHaveCount(0);
  await expect(page.getByText("Recent activity", { exact: true })).toHaveCount(0);
  expect(calls).toBe(0);
});
