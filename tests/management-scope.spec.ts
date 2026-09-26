import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

test("stale settings, team and token controls cannot mutate a new workspace or a different account in the same workspace", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one real local management scope regression",
  );
  const original = await signInLocally(page.request);
  const owner = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${original.workspace.id}-${owner.id}`;
  const initialToken = await page.request.post("/api/tokens", {
    headers: { "X-Workbench-Scope": scope },
    data: { name: "Original account fixture", scope: "read" },
  });
  expect(initialToken.ok(), await initialToken.text()).toBe(true);
  const team = await page.context().newPage();
  const tokens = await page.context().newPage();
  try {
    // The owner record is deliberately rendered as a selectable test row. A
    // missing stale-scope guard still cannot demote this protected owner.
    await team.route("**/api/team", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          canSeeRoles: true,
          invites: [],
          users: [
            {
              id: owner.id,
              name: "Scope fixture member",
              email: "fixture@example.test",
              role: "member",
              permanent: false,
              disabled: false,
              locked: false,
              clips: 0,
              lastSeen: null,
            },
          ],
        }),
      }),
    );
    await page.goto("/settings");
    await page
      .getByLabel("Workspace name", { exact: true })
      .fill("Unsent original workspace name");
    await team.goto("/team");
    await expect(
      team.getByLabel("Role for Scope fixture member"),
    ).toBeVisible();
    await tokens.goto("/connect");
    await expect(
      tokens.getByText("Original account fixture", { exact: true }),
    ).toBeVisible();

    async function rejected(
      surface: Page,
      path: string,
      method: string,
      act: () => Promise<unknown>,
    ) {
      const response = surface.waitForResponse(
        (result) =>
          new URL(result.url()).pathname === path &&
          result.request().method() === method,
      );
      await act();
      const result = await response;
      expect(result.request().headers()["x-workbench-scope"]).toBe(scope);
      expect(result.status(), await result.text()).toBe(409);
    }
    async function staleActions() {
      await rejected(page, "/api/workspaces", "PATCH", () =>
        page.getByRole("button", { name: "Save name", exact: true }).click(),
      );
      await expect(
        page.getByLabel("Workspace name", { exact: true }),
      ).toHaveValue("Unsent original workspace name");
      await rejected(team, `/api/team/${owner.id}`, "PATCH", () =>
        team.getByLabel("Role for Scope fixture member").selectOption("admin"),
      );
      await tokens
        .getByRole("button", { name: "New token — read-only", exact: true })
        .click();
      const prompt = tokens.getByRole("dialog", {
        name: "New read-only token",
        exact: true,
      });
      await prompt.getByRole("textbox").fill("Private to original account");
      await rejected(tokens, "/api/tokens", "POST", () =>
        prompt.getByRole("button", { name: "Save", exact: true }).click(),
      );
      await tokens
        .getByRole("dialog", { name: "Couldn't create the token", exact: true })
        .getByRole("button", { name: "OK", exact: true })
        .click();
      await tokens.getByRole("button", { name: "Revoke", exact: true }).click();
      const confirm = tokens.getByRole("dialog", {
        name: 'Revoke "Original account fixture"?',
        exact: true,
      });
      const response = tokens.waitForResponse(
        (result) =>
          new URL(result.url()).pathname.startsWith("/api/tokens/") &&
          result.request().method() === "DELETE",
      );
      await confirm
        .getByRole("button", { name: "Revoke", exact: true })
        .click();
      const result = await response;
      expect(result.request().headers()["x-workbench-scope"]).toBe(scope);
      expect(result.status(), await result.text()).toBe(409);
      await tokens
        .getByRole("dialog", { name: "Couldn't revoke the token", exact: true })
        .getByRole("button", { name: "OK", exact: true })
        .click();
      await tokens.evaluate(() =>
        localStorage.setItem(
          "aw_draft:scope-sentinel",
          "keep this original draft",
        ),
      );
      await tokens
        .getByRole("button", { name: "Workspace menu", exact: true })
        .click();
      await rejected(tokens, "/api/auth/logout", "POST", () =>
        tokens.getByRole("menuitem", { name: "Sign out", exact: true }).click(),
      );
      await expect(tokens).toHaveURL(/\/connect$/);
      expect(
        await tokens.evaluate(() =>
          localStorage.getItem("aw_draft:scope-sentinel"),
        ),
      ).toBe("keep this original draft");
    }

    const changed = await signInLocally(page.request);
    const member = await page.request
      .get("/api/me")
      .then((response) => response.json());
    expect(changed.workspace.id).not.toBe(original.workspace.id);
    await staleActions();
    expect(
      (await page.request.get("/api/me").then((response) => response.json()))
        .workspace.name,
    ).toBe(changed.workspace.name);
    expect(
      (
        await page.request
          .get("/api/tokens")
          .then((response) => response.json())
      ).tokens,
    ).toEqual([]);

    const code = randomBytes(18).toString("base64url");
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      await db.execute({
        sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        args: [
          code,
          original.workspace.id,
          member.email,
          "Second account",
          "admin",
          owner.id,
          Date.now(),
          Date.now() + 3_600_000,
        ],
      });
    } finally {
      db.close();
    }
    const accepted = await page.request.post("/api/auth/accept", {
      data: { code },
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const current = await page.request
      .get("/api/me")
      .then((response) => response.json());
    expect(current.workspace.id).toBe(original.workspace.id);
    expect(current.id).not.toBe(owner.id);
    await staleActions();
    expect(
      (await page.request.get("/api/me").then((response) => response.json()))
        .workspace.name,
    ).toBe(original.workspace.name);
    expect(
      (
        await page.request
          .get("/api/tokens")
          .then((response) => response.json())
      ).tokens,
    ).toEqual([]);
  } finally {
    await team.close();
    await tokens.close();
  }
});

test("a verified account without a workspace can resume setup and sign out using its captured account scope", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "one account-only billing boundary regression",
  );
  await signInLocally(page.request);
  const account = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    // Leave this synthetic account authenticated but without a workspace, as
    // happens while verified self-serve provisioning is still incomplete.
    await db.batch(
      [
        {
          sql: "DELETE FROM memberships WHERE account_id=?",
          args: [account.id],
        },
        {
          sql: "UPDATE p_sessions SET workspace_id=NULL WHERE account_id=?",
          args: [account.id],
        },
      ],
      "write",
    );
  } finally {
    db.close();
  }
  const scope = `particl-account-${account.id}`;
  const calls: unknown[] = [];
  let pending: {
    requestId: string;
    name: string;
    state: string;
    error: null;
  }[] = [];
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() === "GET") {
      const actual = await route.fetch();
      const body = await actual.json();
      expect(body.active).toBeNull();
      return route.fulfill({
        json: { ...body, canCreate: true, reason: undefined, pending },
      });
    }
    expect(route.request().headers()["x-workbench-scope"]).toBe(scope);
    calls.push(route.request().postDataJSON());
    pending = [
      {
        requestId: "local-mock-provisioning",
        name: "First workspace",
        state: "pending",
        error: null,
      },
    ];
    // Provisioning is mocked; this test must never contact Turso or email.
    return route.fulfill({
      status: 202,
      json: { ok: true, provisioning: pending[0] },
    });
  });
  await page.goto("/billing?new=1");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("First workspace");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect.poll(() => calls).toEqual([{ name: "First workspace" }]);
  await page
    .getByRole("button", { name: "Retry workspace setup", exact: true })
    .click();
  await expect
    .poll(() => calls)
    .toEqual([
      { name: "First workspace" },
      { requestId: "local-mock-provisioning" },
    ]);
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  const logout = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/logout" &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  const response = await logout;
  expect(response.request().headers()["x-workbench-scope"]).toBe(scope);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
});
