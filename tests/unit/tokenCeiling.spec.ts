import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { parseCeiling } from "../../lib/tokenCeiling";

/* /connect's "New token — can generate" asks for a monthly ceiling. A
   cancelled dialog, "$20" or "twenty" used to mint a token with no limit. */
test("a ceiling is dollars above zero, blank is the only 'no limit', and anything else asks again", () => {
  expect(parseCeiling("20")).toEqual({ capUsd: 20 });
  expect(parseCeiling(" $20 ")).toEqual({ capUsd: 20 });
  expect(parseCeiling("$ 12.5")).toEqual({ capUsd: 12.5 });
  expect(parseCeiling("1,000")).toEqual({ capUsd: 1000 });
  expect(parseCeiling("20 USD")).toEqual({ capUsd: 20 });
  expect(parseCeiling("")).toEqual({ capUsd: null });
  expect(parseCeiling("   ")).toEqual({ capUsd: null });
  for (const bad of ["twenty", "0", "$0", "$", "USD", "0.001", "-5", "20$", "1e3", "NaN", "Infinity", "20 dollars"])
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
  for (const capUsd of ["twenty", 0, -5, "$"]) {
    const refused = await post({ name: "Assistant", scope: "render", capUsd });
    expect(refused.status, String(capUsd)).toBe(400);
  }
  expect(inserted).toEqual([]);
  expect((await (await post({ name: "Capped", scope: "render", capUsd: 20 })).json()).capUsd).toBe(20);
  expect((await (await post({ name: "Typed", scope: "render", capUsd: "$35" })).json()).capUsd).toBe(35);
  expect((await (await post({ name: "Open", scope: "render", capUsd: null })).json()).capUsd).toBeNull();
  expect((await (await post({ name: "Reader", scope: "read" })).json()).capUsd).toBeNull();
  expect(inserted.map((args) => args[5])).toEqual([20, 35, null, null]);
});
