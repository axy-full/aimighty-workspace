import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as zod from "zod";
import { runWithStore, requireTenant, type TenantStore } from "../../lib/tenant";
import { workbenchScopeFor, workbenchScopeProblem } from "../../lib/workbench/request-scope";
import { readBoundedText, RequestBodyError } from "../../lib/requestBody";
import { ProductExtractionError } from "../../lib/workbench/product-fetch";

function fixture() {
  const store: TenantStore = {
    workspace: { id: "workspace" } as TenantStore["workspace"],
    user: { id: "owner", role: "member" } as TenantStore["user"],
  };
  let reads = 0, fetches = 0, limits = 0, error: Error | null = null, options: unknown;
  class LimitError extends Error { status = 429; }
  const dependencies: Record<string, unknown> = {
    "zod": zod,
    "@/lib/auth": {
      withTenant: (handler: unknown, value: unknown) => { options = value; return handler; },
      requireUser: async () => store.user ? { user: store.user, token: store.token } : { response: Response.json({ error: "Sign in" }, { status: 401 }) },
    },
    "@/lib/tenant": { requireTenant },
    "@/lib/accountDb": {
      AccountError: LimitError,
      takeAccountLimit: async (key: string, count: number, window: number) => {
        limits++;
        expect([key, count, window]).toEqual(["brand-extraction:workspace:owner", 10, 60_000]);
        if (error instanceof LimitError) throw error;
      },
    },
    "@/lib/requestBody": { readBoundedText, RequestBodyError },
    "@/lib/workbench/request-scope": { workbenchScopeProblem },
    "@/lib/workbench/records": { readDraft: async (owner: string, id: string) => {
      reads++;
      return store.workspace?.id === "workspace" && owner === "owner" && id === "draft-1" ? { project: { id } } : null;
    } },
    "@/lib/workbench/product-fetch": { ProductExtractionError },
    "@/lib/workbench/brand-extraction": { extractBrand: async (url: string) => {
      fetches++;
      expect(url).toBe("https://shop.example.com/brand");
      if (error) throw error;
      return { requiresReview: true, brand: { name: "Review me", description: "", colors: [], fontFamilies: [] }, logoCandidates: [], imageryCandidates: [] };
    } },
  };
  const output = { exports: {} as { POST(req: Request): Promise<Response> } };
  const code = ts.transpileModule(readFileSync("app/api/workbench/moleculr/extract-brand/route.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", code)((id: string) => {
    if (!(id in dependencies)) throw new Error(id);
    return dependencies[id];
  }, output, output.exports);
  return {
    store, counts: () => ({ reads, fetches, limits }), options: () => options,
    fail: (value: Error) => { error = value; },
    limit: () => { error = new LimitError("Too many requests."); },
    post: (scope: string | null = workbenchScopeFor("workspace", "owner"), body: unknown = { projectId: "draft-1", url: "https://shop.example.com/brand" }) =>
      runWithStore(store, () => output.exports.POST(new Request("https://particl.example/api/workbench/moleculr/extract-brand", {
        method: "POST", headers: scope === null ? {} : { "X-Workbench-Scope": scope },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }))),
  };
}

test("brand extraction checks login and captured scope before draft access or public fetch", async () => {
  const api = fixture(), user = api.store.user;
  api.store.user = null;
  expect((await api.post()).status).toBe(401);
  api.store.user = user;
  for (const scope of [null, "", workbenchScopeFor("other", "owner"), workbenchScopeFor("workspace", "other")])
    expect((await api.post(scope)).status).toBe(409);
  expect(api.counts()).toEqual({ reads: 0, fetches: 0, limits: 0 });
  expect(api.options()).toEqual({ requireRequestScope: true, readOnlyPostTransport: true });
});

test("brand extraction requires the owner's draft in the active workspace", async () => {
  const api = fixture();
  expect((await api.post(undefined, { projectId: "other-draft", url: "https://shop.example.com/brand" })).status).toBe(404);
  api.store.user = { ...api.store.user!, id: "other-owner" };
  expect((await api.post(workbenchScopeFor("workspace", "other-owner"))).status).toBe(404);
  api.store.workspace = { ...api.store.workspace!, id: "other-workspace" };
  expect((await api.post(workbenchScopeFor("other-workspace", "other-owner"))).status).toBe(404);
  expect(api.counts()).toEqual({ reads: 3, fetches: 0, limits: 0 });
});

test("brand review remains private and read-only including scoped bearer access", async () => {
  const api = fixture();
  api.store.token = { id: "token", scope: "read" } as TenantStore["token"];
  expect((await api.post(workbenchScopeFor("stale-workspace", "owner"))).status).toBe(409);
  const ok = await api.post(null);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await ok.json()).toMatchObject({ requiresReview: true, brand: { name: "Review me" }, logoCandidates: [], imageryCandidates: [] });
  expect(api.counts()).toEqual({ reads: 1, fetches: 1, limits: 1 });
});

test("brand input bounds, rate limits and safe error responses prevent unnecessary network work", async () => {
  const api = fixture();
  for (const body of ["{broken", "x".repeat(4097), { projectId: "../bad", url: "https://shop.example.com/brand" }, { projectId: "draft-1", url: "x".repeat(2049) }, { projectId: "draft-1", url: "https://shop.example.com/brand", owner: "other" }])
    expect([400, 413]).toContain((await api.post(undefined, body)).status);
  expect(api.counts()).toEqual({ reads: 0, fetches: 0, limits: 0 });
  api.limit();
  expect((await api.post()).status).toBe(429);
  expect(api.counts().fetches).toBe(0);
  api.fail(new ProductExtractionError("Use a public URL.", 400, "unsafe_url"));
  expect(await (await api.post()).json()).toEqual({ error: "Use a public URL.", code: "unsafe_url" });
  api.fail(new Error("PRIVATE ADDRESS AND TOKEN"));
  const response = await api.post();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("PRIVATE");
});
