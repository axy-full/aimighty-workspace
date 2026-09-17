import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantStore } from "../../lib/tenant";
import { runWithStore, NoTenantError } from "../../lib/tenant";
import { MediaSourceError } from "../../lib/mediaBindings";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";
import { AccountError } from "../../lib/accountDb";

const directory = mkdtempSync(
  path.join(tmpdir(), "particl-higgsfield-verify-"),
);
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "tenant.db")}`;
process.env.ENGINE_MOCK = "0";
const secret = "fixture-key-id:fixture-key-secret";
process.env.HF_CREDENTIALS = secret;
const id = "31a51537-0563-4bcf-bc5a-f99f2979759f";
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = secret;
});

const verified = {
  configured: true,
  auth: "verified",
  readyIdentityAvailable: false,
  error: null,
  estimates: {
    "720p": { status: "skipped", error: "no_ready_identity" },
    "1080p": { status: "skipped", error: "no_ready_identity" },
  },
};

test("verification lists one account-owned identity and only estimates exact Soul Character inputs on fixed hosts", async () => {
  const { verifyHiggsfieldConnection } =
    await import("../../lib/higgsfieldVerification");
  const calls: { url: string; method: string }[] = [];
  const sizes: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    if (init?.method === "GET") {
      expect(String(url)).toBe(
        "https://dev-api.higgsfield.com/v1/custom-references/list?page=1&page_size=1",
      );
      expect(headers.get("hf-api-key")).toBe("fixture-key-id");
      expect(headers.get("hf-secret")).toBe("fixture-key-secret");
      expect(headers.has("Authorization")).toBe(false);
      return Response.json({
        total: 1,
        page: 1,
        page_size: 1,
        total_pages: 1,
        items: [
          {
            id,
            status: "completed",
            name: "PRIVATE NAME",
            thumbnail_url: "https://private.example.invalid/portrait",
          },
        ],
      });
    }
    expect(String(url)).toBe(
      "https://api.higgsfield.ai/estimate/higgsfield-ai/soul/character",
    );
    expect(headers.get("Authorization")).toBe(`Key ${secret}`);
    expect(headers.has("hf-secret")).toBe(false);
    const body = JSON.parse(String(init?.body));
    sizes.push(body.resolution);
    expect(body).toEqual({
      prompt: "Editorial portrait in soft daylight",
      custom_reference_id: id,
      custom_reference_strength: 1,
      batch_size: 1,
      resolution: body.resolution,
      aspect_ratio: "3:4",
      enhance_prompt: false,
    });
    return Response.json({
      usd: body.resolution === "720p" ? "0.12" : "0.24",
      credits: "99",
      diagnostic: "PRIVATE PROVIDER FIELD",
    });
  };
  const result = await verifyHiggsfieldConnection();
  expect(result).toEqual({
    configured: true,
    auth: "verified",
    readyIdentityAvailable: true,
    error: null,
    estimates: {
      "720p": { status: "quoted", usd: 0.12 },
      "1080p": { status: "quoted", usd: 0.24 },
    },
  });
  expect(calls).toHaveLength(3);
  expect(sizes.sort()).toEqual(["1080p", "720p"]);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|31a51537|fixture-key|portrait|thumbnail|credits/,
  );
});

test("empty or still-training first page verifies authentication but skips estimates without inventing a UUID", async () => {
  const { verifyHiggsfieldConnection } =
    await import("../../lib/higgsfieldVerification");
  for (const items of [[], [{ id, status: "queued" }]]) {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      expect(init?.method).toBe("GET");
      return Response.json({ items });
    };
    expect(await verifyHiggsfieldConnection()).toEqual(verified);
    expect(calls).toBe(1);
  }
});

test("missing configuration and mock mode make no provider calls", async () => {
  const { verifyHiggsfieldConnection } =
    await import("../../lib/higgsfieldVerification");
  delete process.env.HF_CREDENTIALS;
  delete process.env.HF_API_KEY_ID;
  delete process.env.HF_API_KEY_SECRET;
  globalThis.fetch = async () => {
    throw new Error("must not fetch");
  };
  expect(await verifyHiggsfieldConnection()).toMatchObject({
    configured: false,
    auth: "not_configured",
    error: "missing_configuration",
    readyIdentityAvailable: false,
  });
  process.env.ENGINE_MOCK = "1";
  expect(await verifyHiggsfieldConnection()).toMatchObject({
    auth: "mock",
    error: "mock_mode",
    readyIdentityAvailable: false,
    estimates: { "720p": { status: "skipped", error: "mock_mode" } },
  });
});

test("authentication, provider and transport failures expose only fixed safe categories", async () => {
  const { verifyHiggsfieldConnection } =
    await import("../../lib/higgsfieldVerification");
  for (const [status, category] of [
    [401, "authentication_rejected"],
    [403, "authentication_rejected"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
  ] as const) {
    globalThis.fetch = async () =>
      new Response(`SENSITIVE ${secret} ${id}`, { status });
    const result = await verifyHiggsfieldConnection();
    expect(result.error).toBe(category);
    expect(JSON.stringify(result)).not.toMatch(
      /SENSITIVE|fixture-key|31a51537/,
    );
  }
  globalThis.fetch = async () => {
    throw new Error(`SENSITIVE ${secret}`);
  };
  expect((await verifyHiggsfieldConnection()).error).toBe(
    "provider_unavailable",
  );
});

test("malformed, oversized, and unexpected list responses fail closed before estimates", async () => {
  const { verifyHiggsfieldConnection } =
    await import("../../lib/higgsfieldVerification");
  for (const response of [
    () => new Response("not JSON"),
    () => Response.json({ items: [{ id: "invented", status: "completed" }] }),
    () =>
      Response.json({
        items: [
          { id, status: "completed" },
          { id, status: "completed" },
        ],
      }),
    () => new Response("x".repeat(65537)),
    () =>
      Response.json({ items: [] }, { headers: { "content-length": "70000" } }),
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    expect((await verifyHiggsfieldConnection()).error).toBe("invalid_response");
    expect(calls).toBe(1);
  }
});

test("estimate returns only positive authoritative USD and fixed errors while preserving verified authentication", async () => {
  const { verifyHiggsfieldConnection } =
    await import("../../lib/higgsfieldVerification");
  for (const usd of [0, -1, "0", "NaN", "0x10", null, {}, undefined]) {
    globalThis.fetch = async (_url, init) =>
      init?.method === "GET"
        ? Response.json({ items: [{ id, status: "completed" }] })
        : Response.json({ usd, credits: "1.5" });
    const result = await verifyHiggsfieldConnection();
    expect(result.auth).toBe("verified");
    expect(result.estimates["720p"]).toEqual({
      status: "unavailable",
      error: "invalid_response",
    });
  }
  globalThis.fetch = async (_url, init) =>
    init?.method === "GET"
      ? Response.json({ items: [{ id, status: "completed" }] })
      : new Response(`SENSITIVE ${secret}`, { status: 404 });
  const result = await verifyHiggsfieldConnection();
  expect(result.estimates["1080p"]).toEqual({
    status: "unavailable",
    error: "model_unavailable",
  });
  expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|fixture-key/);
});

/** Real withTenant/requireOwner execution; only session lookup and outbound helper are fixtures. */
async function routeFixture() {
  const auth = await import("../../lib/auth");
  const tenant = await import("../../lib/tenant");
  let store = {
    workspace: { id: "workspace", legacy: true, keys: {}, deletedAt: null },
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
  const fn = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "withTenant",
  )!;
  const wrapperExports = {} as Pick<typeof auth, "withTenant">;
  const compiled = ts.transpileModule(fn.getText(source), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function(
    "exports",
    "resolveStore",
    "runWithStore",
    "NoTenantError",
    "MediaSourceError",
    "workbenchScopeFor",
    "recoveryRoute",
    compiled,
  )(
    wrapperExports,
    async () => store,
    runWithStore,
    NoTenantError,
    MediaSourceError,
    workbenchScopeFor,
    (handler: unknown) => handler,
  );
  let checks = 0,
    limited = false;
  const limits: unknown[][] = [];
  const dependencies: Record<string, unknown> = {
    "@/lib/auth": { ...auth, withTenant: wrapperExports.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/accountDb": {
      AccountError,
      takeAccountLimit: async (...args: unknown[]) => {
        limits.push(args);
        if (limited) throw new AccountError("Too many requests.", 429);
      },
    },
    "@/lib/higgsfieldVerification": {
      verifyHiggsfieldConnection: async () => {
        checks++;
        return verified;
      },
    },
  };
  const route = ts.transpileModule(
    readFileSync("app/api/workspaces/keys/higgsfield/verify/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const routeModule = {
    exports: {} as {
      POST: (request: Request, context: unknown) => Promise<Response>;
    },
  };
  new Function("require", "module", "exports", route)(
    (name: string) => {
      if (!(name in dependencies))
        throw new Error("Unexpected dependency " + name);
      return dependencies[name];
    },
    routeModule,
    routeModule.exports,
  );
  return {
    setStore: (next: TenantStore) => {
      store = next;
    },
    getStore: () => store,
    checks: () => checks,
    limits,
    limit: () => {
      limited = true;
    },
    post: (scope?: string, origin?: string) =>
      routeModule.exports.POST(
        new Request("http://localhost/api/workspaces/keys/higgsfield/verify", {
          method: "POST",
          headers: {
            ...(scope === undefined ? {} : { "X-Workbench-Scope": scope }),
            ...(origin ? { origin } : {}),
          },
        }),
        undefined,
      ),
  };
}
const validScope = workbenchScopeFor("workspace", "owner");

test("actual verify route rejects missing/stale scope, wrong origin, unauthorized owner and both bearer scopes before any outbound check", async () => {
  const route = await routeFixture();
  const original = route.getStore();
  for (const scope of [
    undefined,
    "",
    workbenchScopeFor("other", "owner"),
    workbenchScopeFor("workspace", "other"),
  ])
    expect((await route.post(scope)).status).toBe(409);
  expect((await route.post(validScope, "https://other.invalid")).status).toBe(
    403,
  );
  route.setStore({ ...original, user: { ...original.user!, owner: false } });
  expect((await route.post(validScope)).status).toBe(403);
  route.setStore({ workspace: null, user: null });
  expect((await route.post()).status).toBe(401);
  for (const scope of ["read", "render"] as const) {
    route.setStore({
      ...original,
      token: { id: "token", name: "Token", scope, capUsd: null },
    });
    expect((await route.post(validScope)).status).toBe(403);
  }
  expect(route.checks()).toBe(0);
  expect(route.limits).toHaveLength(0);
});

test("legacy owner and explicit BYOK owner can verify, but customers cannot probe shared deployment credentials", async () => {
  const route = await routeFixture();
  const original = route.getStore();
  const legacy = await route.post(validScope);
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get("Cache-Control")).toBe("private, no-store");
  route.setStore({
    ...original,
    workspace: {
      ...original.workspace!,
      legacy: false,
      keys: {},
      usesPlatformKeys: true,
    },
  });
  const shared = await route.post(validScope);
  expect(shared.status).toBe(403);
  expect(await shared.json()).toEqual({
    error: "Connect your own Higgsfield account to verify it.",
  });
  route.setStore({
    ...original,
    workspace: {
      ...original.workspace!,
      legacy: false,
      keys: { higgsfield: secret },
    },
  });
  expect((await route.post(validScope)).status).toBe(200);
  expect(route.checks()).toBe(2);
  expect(route.limits).toEqual(
    Array.from({ length: 2 }, () => [
      "higgsfield-verify:workspace:owner",
      5,
      300000,
    ]),
  );
  route.limit();
  expect((await route.post(validScope)).status).toBe(429);
  expect(route.checks()).toBe(2);
});
