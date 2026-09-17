import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as zod from "zod";
import {
  runWithStore,
  requireTenant,
  type TenantStore,
} from "../../lib/tenant";
import {
  workbenchScopeFor,
  workbenchScopeProblem,
} from "../../lib/workbench/request-scope";
import { readBoundedText, RequestBodyError } from "../../lib/requestBody";
import { ProductExtractionError } from "../../lib/workbench/product-fetch";
import { attachmentDisposition } from "../../lib/contentDisposition";

const originalBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]);
function fixture(image = false, imageBytes = originalBytes) {
  const route = image ? "import-image" : "extract-product";
  const store: TenantStore = {
    workspace: { id: "workspace" } as TenantStore["workspace"],
    user: { id: "owner", role: "member" } as TenantStore["user"],
  };
  let reads = 0,
    fetches = 0,
    limits = 0,
    error: Error | null = null;
  let options: unknown;
  class LimitError extends Error {
    status = 429;
  }
  const dependencies: Record<string, unknown> = {
    "@/lib/auth": {
      withTenant: (handler: unknown, value: unknown) => {
        options = value;
        return handler;
      },
      requireUser: async () =>
        store.user
          ? { user: store.user, token: store.token }
          : { response: Response.json({ error: "Sign in" }, { status: 401 }) },
    },
    "@/lib/tenant": { requireTenant },
    "@/lib/accountDb": {
      AccountError: LimitError,
      takeAccountLimit: async (key: string, count: number) => {
        limits++;
        expect(key).toBe(
          `${image ? "product-image" : "product-extraction"}:workspace:owner`,
        );
        expect(count).toBe(image ? 12 : 10);
        if (error instanceof LimitError) throw error;
      },
    },
    "@/lib/requestBody": { readBoundedText, RequestBodyError },
    "@/lib/contentDisposition": { attachmentDisposition },
    "@/lib/workbench/request-scope": { workbenchScopeProblem },
    "@/lib/workbench/records": {
      readDraft: async (owner: string, id: string) => {
        reads++;
        return store.workspace?.id === "workspace" &&
          owner === "owner" &&
          id === "draft-1"
          ? { project: { id } }
          : null;
      },
    },
    "@/lib/workbench/product-fetch": { ProductExtractionError },
    "@/lib/workbench/product-image": {
      downloadProductImage: async (url: string) => {
        fetches++;
        expect(url).toBe("https://shop.example.com/product");
        if (error) throw error;
        return {
          bytes: imageBytes,
          mime: "image/png",
          filename: "product-original-0123456789ab.png",
          width: 320,
          height: 320,
        };
      },
    },
    "@/lib/workbench/product-extraction": {
      extractProduct: async (url: string) => {
        fetches++;
        expect(url).toBe("https://shop.example.com/product");
        if (error) throw error;
        return {
          requiresReview: true,
          product: { name: "Review me" },
          imageCandidates: [],
        };
      },
    },
  };
  const output = { exports: {} as { POST(req: Request): Promise<Response> } };
  const code = ts.transpileModule(
    readFileSync(`app/api/workbench/moleculr/${route}/route.ts`, "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", code)(
    (id: string) => {
      if (id === "zod") return zod;
      if (!(id in dependencies)) throw new Error(id);
      return dependencies[id];
    },
    output,
    output.exports,
  );
  return {
    store,
    counts: () => ({ reads, fetches, limits }),
    options: () => options,
    fail: (value: Error) => {
      error = value;
    },
    limit: () => {
      error = new LimitError("Too many requests.");
    },
    post: (
      scope: string | null | undefined = workbenchScopeFor(
        "workspace",
        "owner",
      ),
      body: unknown = {
        projectId: "draft-1",
        url: "https://shop.example.com/product",
      },
    ) =>
      runWithStore(store, () =>
        output.exports.POST(
          new Request(
            `https://particl.example/api/workbench/moleculr/${route}`,
            {
              method: "POST",
              headers: scope === null ? {} : { "X-Workbench-Scope": scope },
              body: typeof body === "string" ? body : JSON.stringify(body),
            },
          ),
        ),
      ),
  };
}

test("extraction refuses anonymous or stale browser scope before any project or network work", async () => {
  const api = fixture(),
    user = api.store.user;
  api.store.user = null;
  expect((await api.post()).status).toBe(401);
  api.store.user = user;
  for (const scope of [
    null,
    "",
    workbenchScopeFor("other", "owner"),
    workbenchScopeFor("workspace", "other"),
  ])
    expect((await api.post(scope)).status).toBe(409);
  expect(api.counts()).toEqual({ reads: 0, fetches: 0, limits: 0 });
  expect(api.options()).toEqual({
    requireRequestScope: true,
    readOnlyPostTransport: true,
  });
});

test("only an owned draft in the current workspace may inspect a page", async () => {
  const api = fixture();
  expect(
    (
      await api.post(undefined, {
        projectId: "someone-elses-draft",
        url: "https://shop.example.com/product",
      })
    ).status,
  ).toBe(404);
  api.store.user = { ...api.store.user!, id: "another-owner" };
  expect(
    (await api.post(workbenchScopeFor("workspace", "another-owner"))).status,
  ).toBe(404);
  api.store.workspace = { ...api.store.workspace!, id: "another-workspace" };
  expect(
    (await api.post(workbenchScopeFor("another-workspace", "another-owner")))
      .status,
  ).toBe(404);
  expect(api.counts().fetches).toBe(0);
  expect(api.counts().limits).toBe(0);
});

test("valid extraction is private, read-only and available to a scoped read token", async () => {
  const api = fixture();
  api.store.token = { id: "token", scope: "read" } as TenantStore["token"];
  const response = await api.post(
    workbenchScopeFor("another-workspace", "owner"),
  );
  // Supplied stale context is refused even for a bearer caller.
  expect(response.status).toBe(409);
  const ok = await api.post(null);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await ok.json()).toMatchObject({ requiresReview: true });
  expect(api.counts()).toEqual({ reads: 1, limits: 1, fetches: 1 });
});

test("bounded inputs and rate limits fail before fetching; unexpected errors are redacted", async () => {
  const api = fixture();
  for (const body of [
    "{broken",
    "x".repeat(4097),
    { projectId: "../bad", url: "https://shop.example.com/product" },
    {
      projectId: "draft-1",
      url: "https://shop.example.com/product",
      owner: "another",
    },
  ])
    expect([400, 413]).toContain((await api.post(undefined, body)).status);
  expect(api.counts().fetches).toBe(0);
  api.limit();
  expect((await api.post()).status).toBe(429);
  expect(api.counts().fetches).toBe(0);
  api.fail(new Error("PRIVATE IP ADDRESS AND TOKEN"));
  const bad = await api.post();
  expect(bad.status).toBe(503);
  expect(await bad.text()).not.toContain("PRIVATE");
});

test("image download keeps exact bytes private and refuses auth scope ownership and rate failures before fetching", async () => {
  const api = fixture(true),
    user = api.store.user;
  api.store.user = null;
  expect((await api.post()).status).toBe(401);
  api.store.user = user;
  for (const scope of [
    null,
    "",
    workbenchScopeFor("other", "owner"),
    workbenchScopeFor("workspace", "another"),
  ])
    expect((await api.post(scope)).status).toBe(409);
  expect(
    (
      await api.post(undefined, {
        projectId: "someone-elses-draft",
        url: "https://shop.example.com/product",
      })
    ).status,
  ).toBe(404);
  expect(api.counts().fetches).toBe(0);
  api.limit();
  expect((await api.post()).status).toBe(429);
  expect(api.counts().fetches).toBe(0);
  const success = fixture(true),
    response = await success.post();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.has("Content-Length")).toBe(false);
  expect(response.headers.get("Content-Disposition")).toContain(
    'attachment; filename="product-original-0123456789ab.png"',
  );
  expect(Buffer.from(await response.arrayBuffer()).equals(originalBytes)).toBe(
    true,
  );
  expect(success.counts()).toEqual({ reads: 1, fetches: 1, limits: 1 });
  expect(success.options()).toEqual({
    requireRequestScope: true,
    readOnlyPostTransport: true,
  });
  success.fail(
    new ProductExtractionError(
      "Choose an image with no more than 40 million pixels.",
      422,
      "image_dimensions",
    ),
  );
  expect(await (await success.post()).json()).toMatchObject({
    code: "image_dimensions",
  });
});

test("image originals stream the full 10 MiB unchanged in chunks bounded to 64 KiB", async () => {
  const bytes = Buffer.alloc(10 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const response = await fixture(true, bytes).post();
  expect(response.headers.has("Content-Length")).toBe(false);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    expect(next.value.byteLength).toBeGreaterThan(0);
    expect(next.value.byteLength).toBeLessThanOrEqual(64 * 1024);
    chunks.push(next.value);
  }
  expect(chunks).toHaveLength(160);
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
});

test("image response slicing is demand-driven and stops after consumer cancellation", async () => {
  const bytes = Buffer.alloc(3 * 64 * 1024 + 7, 17);
  let slices = 0;
  const slice = bytes.subarray.bind(bytes);
  bytes.subarray = (start, end) => {
    slices++;
    return slice(start, end);
  };
  const response = await fixture(true, bytes).post();
  await Promise.resolve();
  expect(slices).toBe(0);
  const reader = response.body!.getReader();
  expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
  await Promise.resolve();
  expect(slices).toBe(1);
  await reader.cancel();
  expect((await reader.read()).done).toBe(true);
  expect(slices).toBe(1);
});
