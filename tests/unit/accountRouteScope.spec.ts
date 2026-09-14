import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import * as requestScope from "../../lib/workbench/request-scope";
import * as accountRequestScope from "../../lib/accountRequestScope";

type Context = {
  user: { id: string; email: string; name: string };
  workspace: { id: string } | null;
  workspaces: { id: string }[];
};
type Action = "logout" | "switch" | "create";
function load(action: Action, ctx: Context | null) {
  const mutations: string[] = [];
  const reads: string[] = [];
  const paths = {
    logout: "app/api/auth/logout/route.ts",
    switch: "app/api/workspaces/switch/route.ts",
    create: "app/api/workspaces/route.ts",
  };
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "next/headers": {
      cookies: async () => ({
        get: () => ({ value: "fixture-session" }),
        delete: () => mutations.push("cookie.delete"),
      }),
    },
    "@/lib/workbench/request-scope": requestScope,
    "@/lib/accountRequestScope": accountRequestScope,
    "@/lib/auth": {
      SESSION_COOKIE: "aw_session",
      currentContext: async () => ctx,
      destroySession: async () => {
        mutations.push("session.destroy");
      },
      withTenant: (handler: unknown) => handler,
    },
    "@/lib/platform": {
      switchSessionWorkspace: async () => {
        mutations.push("workspace.switch");
      },
    },
    "@/lib/tenant": {},
    "@/lib/workspaceProvisioning": {
      workspaceCreationReadiness: () => ({ canCreate: true }),
      pendingWorkspaces: async () => {
        reads.push("workspace.pending");
        return [];
      },
      requestWorkspace: async () => {
        mutations.push("workspace.request");
        return "request";
      },
      resumeWorkspace: async () => {
        mutations.push("workspace.resume");
        return { workspace: { id: "new", name: "New", slug: "new" } };
      },
    },
    "@/lib/accountDb": {
      sameOriginProblem: () => false,
      accountFailure: (error: unknown) => {
        throw error;
      },
      AccountError: Error,
    },
    "@/lib/deletion": {},
    "@/lib/purge": {},
  };
  const compiled = ts.transpileModule(readFileSync(paths[action], "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const mod = {
    exports: {} as {
      POST: (req: Request) => Promise<Response>;
      GET: (req: Request) => Promise<Response>;
    },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in mocks))
        throw new Error("Unexpected route dependency " + name);
      return mocks[name];
    },
    mod,
    mod.exports,
  );
  return {
    mutations,
    reads,
    get: (scope?: string) =>
      mod.exports.GET(
        new Request("http://localhost/api/workspaces", {
          headers: scope === undefined ? {} : { "X-Workbench-Scope": scope },
        }),
      ),
    post: (scope?: string) =>
      mod.exports.POST(
        new Request("http://localhost/api/" + action, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(scope === undefined ? {} : { "X-Workbench-Scope": scope }),
          },
          body: JSON.stringify({ id: "target", name: "New workspace" }),
        }),
      ),
  };
}
const account = (workspace: string | null = "current"): Context => ({
  user: { id: "current-user", email: "current@example.test", name: "Current" },
  workspace: workspace ? { id: workspace } : null,
  workspaces: [{ id: "target" }],
});

for (const action of ["logout", "switch", "create"] as const) {
  test(`${action} rejects stale account/workspace scope, including a current account without any workspace, before mutation`, async () => {
    for (const [ctx, scope] of [
      [account(), requestScope.workbenchScopeFor("current", "old-user")],
      [
        account(),
        requestScope.workbenchScopeFor("old-workspace", "current-user"),
      ],
      [
        account(null),
        requestScope.workbenchScopeFor("old-workspace", "old-user"),
      ],
      [account(), ""],
      [account(null), requestScope.accountScopeFor("old-user")],
      [account(), requestScope.accountScopeFor("current-user")],
    ] as [Context, string][]) {
      const route = load(action, ctx);
      expect((await route.post(scope)).status).toBe(409);
      expect(route.mutations).toEqual([]);
    }
    const matching = load(action, account());
    expect(
      (
        await matching.post(
          requestScope.workbenchScopeFor("current", "current-user"),
        )
      ).status,
    ).toBe(action === "create" ? 201 : 200);
    expect(matching.mutations.length).toBeGreaterThan(0);
    const accountOnly = load(action, account(null));
    expect(
      (await accountOnly.post(requestScope.accountScopeFor("current-user")))
        .status,
    ).toBe(action === "create" ? 201 : 200);
    expect(accountOnly.mutations.length).toBeGreaterThan(0);
  });
}

test("zero-workspace onboarding and signout still work without a supplied scope", async () => {
  for (const action of ["logout", "switch", "create"] as const) {
    const route = load(action, account(null));
    expect((await route.post()).status).toBe(action === "create" ? 201 : 200);
    expect(route.mutations.length).toBeGreaterThan(0);
  }
  const logout = load("logout", account());
  expect((await logout.post()).status).toBe(409);
  expect(logout.mutations).toEqual([]);
});

test("workspace reads reject stale provided scope before accessing pending provisioning and preserve optional/account-only reads", async () => {
  for (const [ctx, scope] of [
    [account(), requestScope.workbenchScopeFor("current", "old-user")],
    [
      account(),
      requestScope.workbenchScopeFor("old-workspace", "current-user"),
    ],
    [account(null), requestScope.workbenchScopeFor("old", "current-user")],
    [account(null), requestScope.accountScopeFor("old-user")],
    [account(), ""],
  ] as [Context, string][]) {
    const route = load("create", ctx);
    expect((await route.get(scope)).status).toBe(409);
    expect(route.reads).toEqual([]);
    expect(route.mutations).toEqual([]);
  }
  for (const [ctx, scope] of [
    [account(), undefined],
    [account(), requestScope.workbenchScopeFor("current", "current-user")],
    [account(null), requestScope.accountScopeFor("current-user")],
  ] as [Context, string | undefined][]) {
    const route = load("create", ctx);
    const response = await route.get(scope);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active: ctx.workspace?.id ?? null,
      pending: [],
    });
    expect(route.reads).toEqual(["workspace.pending"]);
    expect(route.mutations).toEqual([]);
  }
});

test("expired current session cannot let an old scope delete the cookie or mutate workspace selection", async () => {
  for (const action of ["logout", "switch", "create"] as const) {
    const route = load(action, null);
    expect(
      (await route.post(requestScope.workbenchScopeFor("old", "old-user")))
        .status,
    ).toBe(action === "logout" ? 409 : 401);
    expect(route.mutations).toEqual([]);
  }
});
