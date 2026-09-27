import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { parseCeiling } from "../../lib/tokenCeiling";

test("a ceiling is whole credits above zero, blank alone means no limit", () => {
  for (const [text, capCredits] of [["20", 20], ["20 cr", 20], ["1,000 credits", 1000], ["", null], ["   ", null]] as const)
    expect(parseCeiling(text)).toEqual({ capCredits });
  for (const bad of ["twenty", "0", "$20", "USD", "20 USD", "0.001", "-5", "1e3", "NaN", "Infinity", "1,2", "9007199254740992"])
    expect(parseCeiling(bad), bad).toHaveProperty("error");
});

test("POST /api/tokens refuses a ceiling it cannot read instead of storing no limit", async () => {
  type Handler = (request: Request) => Promise<Response>;
  const inserted: unknown[][] = [];
  const compiled = ts.transpileModule(readFileSync(path.join(process.cwd(), "app/api/tokens/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/securityAudit": { securityAuditStatement: () => ({ sql: "SELECT 1", args: [] }) },
    "@/lib/tenant": { requireTenant: () => ({ id: "tenant-fixture" }) },
    "@/lib/tokenCeiling": { parseCeiling },
    "@/lib/credits": { creditsApply: () => true },
    "@/lib/tokenUsage": { tokenCreditUsage: async () => new Map() },
    "@/lib/creditSql": { billedCreditsExpr: () => "0" },
    "@/lib/db": {
      db: () => ({ batch: async (statements: { args: unknown[] }[]) => { inserted.push(statements[0].args); } }),
      ready: async () => {}, now: () => 1, id: () => "tok_fixture",
    },
    "@/lib/auth": {
      currentUser: async () => null,
      requireSession: async () => ({ user: { id: "caller" } }),
      mintTokenSecret: () => "secret", tokenHash: () => "hash",
      withTenant: (h: Handler) => h,
    },
  };
  const mod = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, mod, mod.exports);
  const post = (body: unknown) => mod.exports.POST(new Request("http://localhost/api/tokens", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  for (const capCredits of ["twenty", 0, -5, "$"]) {
    const refused = await post({ name: "Assistant", scope: "render", capCredits });
    expect(refused.status, String(capCredits)).toBe(400);
  }
  expect((await post({ name: "Old client", scope: "render", capUsd: 20 })).status).toBe(400);
  expect(inserted).toEqual([]);
  expect((await (await post({ name: "Capped", scope: "render", capCredits: 20 })).json()).capCredits).toBe(20);
  expect((await (await post({ name: "Typed", scope: "render", capCredits: "35 cr" })).json()).capCredits).toBe(35);
  expect((await (await post({ name: "Open", scope: "render", capCredits: null })).json()).capCredits).toBeNull();
  expect((await (await post({ name: "Reader", scope: "read" })).json()).capCredits).toBeNull();
  expect(inserted.map((args) => args[5])).toEqual([20, 35, null, null]);
});
