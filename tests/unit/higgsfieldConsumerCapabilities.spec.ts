import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  runWithStore,
  NoTenantError,
  type TenantStore,
} from "../../lib/tenant";
import { MediaSourceError } from "../../lib/mediaBindings";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";
import { AccountError } from "../../lib/accountDb";
import { ConsumerDiscoveryError } from "../../lib/higgsfield-consumer/mcp";

const secret = "private-access-token-no-client-exposure";
const discovered = {
  status: "discovered",
  discoveryOnly: true,
  capabilitiesVerified: false,
  protocolVersion: "2025-11-25",
  tools: [
    {
      name: "brand_kit_fetch",
      description: "Untrusted description",
      inputSchema: { type: "object" },
    },
  ],
  summary: { brandExtraction: ["brand_kit_fetch"] },
};

/** Executes the real route, withTenant and requireOwner; only identity resolution,
 * rate storage, OAuth refresh and outbound discovery are isolated fixtures. */
async function fixture() {
  const auth = await import("../../lib/auth");
  const tenant = await import("../../lib/tenant");
  let store = {
    workspace: { id: "workspace", keys: {}, legacy: false, deletedAt: null },
    user: {
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      role: "admin",
      owner: true,
    },
  } as TenantStore;
  const source = ts.createSourceFile(
    "auth.ts",
    readFileSync("lib/auth.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = source.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === "withTenant",
  )!;
  const wrapper = ts.transpileModule(statement.getText(source), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const wrapperExports = {} as Pick<typeof auth, "withTenant">;
  new Function(
    "exports",
    "resolveStore",
    "runWithStore",
    "NoTenantError",
    "MediaSourceError",
    "workbenchScopeFor",
    "recoveryRoute",
    wrapper,
  )(
    wrapperExports,
    async () => store,
    runWithStore,
    NoTenantError,
    MediaSourceError,
    workbenchScopeFor,
    (fn: unknown) => fn,
  );
  class OAuthError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
    ) {
      super(secret);
    }
  }
  const tokenRequests: string[][] = [];
  const discoveries: string[] = [];
  const limits: unknown[][] = [];
  let token: string | null = secret;
  let failure: unknown;
  let tokenFailure: unknown;
  let limited = false;
  const deps: Record<string, unknown> = {
    "@/lib/auth": { ...auth, withTenant: wrapperExports.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/accountDb": {
      AccountError,
      takeAccountLimit: async (...args: unknown[]) => {
        limits.push(args);
        if (limited) throw new AccountError(secret, 429);
      },
    },
    "@/lib/higgsfield-consumer/oauth": {
      ConsumerOAuthError: OAuthError,
      getConsumerAccessToken: async (...ids: string[]) => {
        tokenRequests.push(ids);
        if (tokenFailure) throw tokenFailure;
        return token;
      },
    },
    "@/lib/higgsfield-consumer/mcp": { ConsumerDiscoveryError },
    "@/lib/higgsfield-consumer/discovery": {
      discoverConsumerCapabilities: async (value: string) => {
        discoveries.push(value);
        if (failure) throw failure;
        return discovered;
      },
    },
  };
  const output = {
    exports: {} as { POST(req: Request, ctx: unknown): Promise<Response> },
  };
  const route = ts.transpileModule(
    readFileSync("app/api/higgsfield/consumer/capabilities/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", route)(
    (name: string) => {
      if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`);
      return deps[name];
    },
    output,
    output.exports,
  );
  return {
    store: () => store,
    setStore: (value: TenantStore) => {
      store = value;
    },
    tokenRequests,
    discoveries,
    limits,
    disconnect: () => {
      token = null;
    },
    fail: (value: unknown) => {
      failure = value;
    },
    failToken: (code: string, status: number) => {
      tokenFailure = new OAuthError(code, status);
    },
    limit: () => {
      limited = true;
    },
    post: (
      scope: string | null = workbenchScopeFor("workspace", "owner"),
      origin?: string,
    ) =>
      output.exports.POST(
        new Request("http://localhost/api/higgsfield/consumer/capabilities", {
          method: "POST",
          headers: {
            ...(scope === null ? {} : { "X-Workbench-Scope": scope }),
            ...(origin ? { origin } : {}),
          },
          // Caller-supplied identities, endpoints or tool calls must be ignored.
          body: JSON.stringify({
            workspaceId: "other",
            userId: "other",
            endpoint: "https://evil.example",
            method: "tools/call",
          }),
        }),
        undefined,
      ),
  };
}

test("capabilities route rejects unauthenticated, nonowner, bearer and stale browser scopes before any token/provider access", async () => {
  const f = await fixture();
  const original = f.store();
  for (const scope of [
    null,
    "",
    workbenchScopeFor("other", "owner"),
    workbenchScopeFor("workspace", "other"),
  ])
    expect((await f.post(scope)).status).toBe(409);
  expect((await f.post(undefined, "https://evil.example")).status).toBe(403);
  f.setStore({ ...original, user: null });
  expect((await f.post(null)).status).toBe(401);
  f.setStore({ ...original, user: { ...original.user!, owner: false } });
  expect((await f.post()).status).toBe(403);
  for (const scope of ["read", "render"] as const) {
    f.setStore({
      ...original,
      token: { id: "token", scope } as TenantStore["token"],
    });
    expect((await f.post(null)).status).toBe(403);
  }
  expect(f.tokenRequests).toEqual([]);
  expect(f.discoveries).toEqual([]);
  expect(f.limits).toEqual([]);
});

test("owner discovery uses only resolved account/workspace, returns unverified schemas, and never caches or returns tokens", async () => {
  const f = await fixture();
  const response = await f.post();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual(discovered);
  expect(text).not.toContain(secret);
  expect(f.tokenRequests).toEqual([["workspace", "owner"]]);
  expect(f.discoveries).toEqual([secret]);
  expect(f.limits).toEqual([
    ["higgsfield-consumer-discovery:workspace:owner", 6, 60_000],
  ]);
});

test("disconnected and rate-limited callers perform no MCP discovery", async () => {
  const disconnected = await fixture();
  disconnected.disconnect();
  const absent = await disconnected.post();
  expect(absent.status).toBe(409);
  expect(await absent.json()).toMatchObject({
    status: "unavailable",
    code: "not_connected",
  });
  expect(disconnected.discoveries).toEqual([]);
  const limited = await fixture();
  limited.limit();
  const blocked = await limited.post();
  expect(blocked.status).toBe(429);
  expect(await blocked.text()).not.toContain(secret);
  expect(limited.tokenRequests).toEqual([]);
  expect(limited.discoveries).toEqual([]);
});

test("OAuth refresh failures and provider/network errors expose only safe categories", async () => {
  for (const [code, status] of [
    ["reconnect_required", 401],
    ["connection_busy", 409],
    ["unavailable", 503],
  ] as const) {
    const f = await fixture();
    f.failToken(code, status);
    const response = await f.post();
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).code).toBe(code);
    expect(f.discoveries).toEqual([]);
  }
  for (const failure of [
    new ConsumerDiscoveryError("protocol_error"),
    new Error(secret),
  ]) {
    const f = await fixture();
    f.fail(failure);
    const response = await f.post();
    expect(response.status).toBe(
      failure instanceof ConsumerDiscoveryError ? 502 : 503,
    );
    expect(await response.text()).not.toContain(secret);
  }
});
