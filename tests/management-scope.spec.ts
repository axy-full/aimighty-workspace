import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Settings (Team, Connections, Advanced) and the workspace menu send their writes under the scope they were drawn in. A tab left
 * open across a sign-in as someone else, or across a switch of workspace, must not write into the new one. The old Settings, Team
 * and Connect pages drove this through their buttons; those pages are gone (their addresses are Settings sections), and the rule is
 * the routes': every write names the account and workspace it was drawn for and is refused whole (409) when they are not the
 * session's. So it is asserted of the routes the Settings sections call, with the same captured scope, and every check on what
 * was and was not written is kept.
 */
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
  const headers = { "X-Workbench-Scope": scope };
  const initialToken = await page.request.post("/api/tokens", {
    headers,
    data: { name: "Original account fixture", scope: "read" },
  });
  expect(initialToken.ok(), await initialToken.text()).toBe(true);
  const tokenId = String((await initialToken.json()).id);

  /* The writes Settings makes: rename (Advanced), a role (Team), make and revoke a token (Connections), and sign out. */
  async function staleActions(label: string) {
    const attempts = [
      ["PATCH", "/api/workspaces", { name: "Unsent original workspace name" }],
      ["PATCH", `/api/team/${owner.id}`, { role: "admin" }],
      ["POST", "/api/tokens", { name: "Private to original account", scope: "read" }],
      ["DELETE", `/api/tokens/${tokenId}`, undefined],
      ["POST", "/api/auth/logout", {}],
    ] as const;
    for (const [method, path, data] of attempts) {
      const response = await page.request.fetch(path, { method, headers, ...(data === undefined ? {} : { data }) });
      expect(response.status(), `${label}: ${method} ${path}: ${await response.text()}`).toBe(409);
    }
  }

  const changed = await signInLocally(page.request);
  const member = await page.request
    .get("/api/me")
    .then((response) => response.json());
  expect(changed.workspace.id).not.toBe(original.workspace.id);
  await staleActions("another workspace");
  /* The refused logout left the session standing, and nothing was written under the new workspace. */
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
  await staleActions("another account in the same workspace");
  expect(
    (await page.request.get("/api/me").then((response) => response.json()))
      .workspace.name,
  ).toBe(original.workspace.name);
  /* The first account's token is still there, and the second account made none. */
  const tokensNow = (await page.request.get("/api/tokens").then((response) => response.json())).tokens as { name: string }[];
  expect(tokensNow.map((token) => token.name)).not.toContain("Private to original account");
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
