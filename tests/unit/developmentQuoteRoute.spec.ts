import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";

/*
 * A credit workspace that brought its own language key pays that model's
 * provider in dollars. Its quote must keep the dollar ceiling: the start
 * locks it (maxUsd), and the server refuses an own-key start without it.
 */

process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
type Handler = (req: Request) => Promise<Response>;

async function route(quote: Record<string, unknown>): Promise<Record<string, Handler>> {
  const server = await import("../../lib/workbench/development-server");
  const dependencies: Record<string, unknown> = {
    "next/server": { after: () => {} },
    zod: createRequire(path.resolve("package.json"))("zod"),
    "@/lib/auth": {
      withTenant: (handler: Handler) => handler,
      requireUser: async () => ({ user: { id: "owner" } }),
      requireRender: async () => ({ user: { id: "owner" } }),
    },
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/db": { db: () => { throw new Error("A quote reads no rows here."); } },
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/requestBody": await import("../../lib/requestBody"),
    "@/lib/recovery": { reserveRecoveryContinuation: async () => () => {} },
    "@/lib/mock": await import("../../lib/mock"),
    "@/lib/platformSpend": await import("../../lib/platformSpend"),
    "@/lib/openai-direct": await import("../../lib/openai-direct"),
    "@/lib/workbench/atomik-response": await import("../../lib/workbench/atomik-response"),
    "@/lib/workbench/development-server": { ...server, quoteDevelopmentJob: async (input: { model: string }) => ({ ...quote, model: input.model }) },
    "@/lib/workbench/development-worker": { enqueueDevelopmentJob: async () => true },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/workbench/development/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}

function workspace(extra: Partial<TenantWorkspace>): TenantWorkspace {
  return { id: "ws-quote", slug: "unit", name: "Unit", legacy: false, dbUrl: "file:/nonexistent/never-opened.db", dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null, ...extra } as TenantWorkspace;
}

async function quoteFor(ws: TenantWorkspace, model: string) {
  const exports = await route({ quoteOnly: true, effort: "auto", kind: "write", sourceHash: "a".repeat(64), estimateCredits: 0, estimateUsd: 0.42, chunks: 1, calls: 3, sourceCharacters: 10 });
  const response = await runInTenant(ws, () => exports.POST(new Request("http://localhost/api/workbench/development", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "project-1", requestId: "request-0001", kind: "write", model, effort: "auto", quoteOnly: true }),
  })));
  expect(response.status).toBe(200);
  return (await response.json()) as { estimateUsd?: number; estimateCredits: number };
}

test("a credit workspace's own-key model keeps its dollar ceiling in the quote; a platform-paid one is credits only", async () => {
  const ownKey = workspace({ keys: { openai: "test-only-never-sent" } });
  expect((await quoteFor(ownKey, "openai/gpt-5")).estimateUsd).toBe(0.42);
  /* The same workspace's gateway models are paid by the platform: credits, no dollars. */
  expect((await quoteFor(ownKey, "anthropic/claude-sonnet-4.6")).estimateUsd).toBeUndefined();
  expect((await quoteFor(workspace({}), "openai/gpt-5")).estimateUsd).toBeUndefined();
  /* A workspace on its own keys everywhere sees dollars, as before. */
  expect((await quoteFor(workspace({ usesPlatformKeys: false, keys: { gateway: "test-only-never-sent" } }), "anthropic/claude-sonnet-4.6")).estimateUsd).toBe(0.42);
});
