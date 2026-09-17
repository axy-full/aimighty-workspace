import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  runWithStore,
  type TenantStore,
  requireTenant,
} from "../../lib/tenant";
import {
  workbenchScopeFor,
  workbenchScopeProblem,
} from "../../lib/workbench/request-scope";

function fixture() {
  let calls = 0,
    configured = true,
    failure: Error | null = null;
  const store: TenantStore = {
    workspace: { id: "workspace", deletedAt: null } as TenantStore["workspace"],
    user: {
      id: "owner",
      disabled: false,
      role: "admin",
    } as TenantStore["user"],
  };
  class LimitError extends Error {
    status = 429;
  }
  class ProviderError extends Error {
    status = 503;
    code = "provider_unavailable";
  }
  const compiled = ts.transpileModule(
    readFileSync("app/api/higgsfield/marketing/presets/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const output = { exports: {} as { GET(req: Request): Promise<Response> } };
  const deps: Record<string, unknown> = {
    "@/lib/auth": {
      withTenant: (fn: unknown) => fn,
      requireUser: async () =>
        store.user
          ? { user: store.user, token: store.token }
          : {
              response: Response.json(
                { error: "Not signed in" },
                { status: 401 },
              ),
            },
    },
    "@/lib/tenant": { requireTenant },
    "@/lib/workbench/request-scope": { workbenchScopeProblem },
    "@/lib/higgsfield": { higgsfieldConfigured: () => configured },
    "@/lib/accountDb": {
      AccountError: LimitError,
      takeAccountLimit: async () => {},
    },
    "@/lib/higgsfieldMarketing": {
      MarketingError: ProviderError,
      MARKETING_CAPABILITIES: { maxImages: 16 },
      listMarketingPresets: async (cursor?: string) => {
        calls++;
        if (failure) throw failure;
        return { items: [], total: 0, cursor: cursor ?? null };
      },
    },
  };
  new Function("require", "module", "exports", compiled)(
    (id: string) => {
      if (!(id in deps)) throw new Error(id);
      return deps[id];
    },
    output,
    output.exports,
  );
  return {
    store,
    calls: () => calls,
    configure: (value: boolean) => {
      configured = value;
    },
    fail: () => {
      failure = new Error("PRIVATE token and provider payload");
    },
    get: (scope?: string) =>
      runWithStore(store, () =>
        output.exports.GET(
          new Request("http://localhost/api/higgsfield/marketing/presets", {
            headers: scope === undefined ? {} : { "X-Workbench-Scope": scope },
          }),
        ),
      ),
  };
}

test("preset route requires authenticated captured browser context before configuration, catalog or provider reads", async () => {
  const route = fixture(),
    user = route.store.user;
  route.store.user = null;
  expect((await route.get()).status).toBe(401);
  route.store.user = user;
  for (const scope of [
    undefined,
    "",
    workbenchScopeFor("another", "owner"),
    workbenchScopeFor("workspace", "another"),
  ])
    expect((await route.get(scope)).status).toBe(409);
  expect(route.calls()).toBe(0);
  route.configure(false);
  const absent = await route.get(workbenchScopeFor("workspace", "owner"));
  expect(absent.status).toBe(503);
  expect(await absent.json()).toMatchObject({
    configured: false,
    code: "not_configured",
  });
  expect(route.calls()).toBe(0);
});

test("preset discovery permits scoped read tokens, never caches privately, and redacts unexpected failures", async () => {
  const route = fixture();
  route.store.token = {
    id: "read-token",
    scope: "read",
  } as TenantStore["token"];
  const ok = await route.get();
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await ok.json()).toEqual({
    configured: true,
    items: [],
    total: 0,
    cursor: null,
    capabilities: { maxImages: 16 },
  });
  route.fail();
  const bad = await route.get();
  expect(bad.status).toBe(503);
  expect(await bad.text()).not.toContain("PRIVATE");
});
