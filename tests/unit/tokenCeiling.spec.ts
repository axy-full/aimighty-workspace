import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { parseCreditCeiling, tokenCeiling } from "../../lib/tokenCeiling";

test("a ceiling is whole credits above zero, blank alone means no limit", () => {
  for (const [text, capCredits] of [["20", 20], ["20 cr", 20], ["1,000 credits", 1000], ["", null], ["   ", null]] as const)
    expect(parseCreditCeiling(text)).toEqual({ capCredits });
  for (const bad of ["twenty", "0", "$20", "USD", "20 USD", "0.001", "-5", "1e3", "NaN", "Infinity", "9007199254740992"])
    expect(parseCreditCeiling(bad), bad).toHaveProperty("error");
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
    "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
    "@/lib/credits": { creditsApply: () => true },
    "@/lib/tokenUsage": { tokenCreditUsage: async () => new Map() },
    "@/lib/creditSql": { billedCreditsExpr: () => "0" },
    "@/lib/cycle": await import("../../lib/cycle"),
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
  // No dollar ceiling is ever stored for a new token: [cap_usd, cap_credits].
  expect(inserted.map((args) => [args[5], args[6]])).toEqual([[null, 20], [null, 35], [null, null], [null, null]]);
});

/* A workspace on the platform's keys pays in credits (lib/credits creditsApply):
   its ceilings are whole credits, a dollar figure is refused rather than
   converted, and the token list never carries the engine's dollars. */
test("a credits ceiling is whole credits; each workspace is held to its own unit", () => {
  expect(parseCreditCeiling("500")).toEqual({ capCredits: 500 });
  expect(parseCreditCeiling(" 1,000 cr ")).toEqual({ capCredits: 1000 });
  expect(parseCreditCeiling("250 credits")).toEqual({ capCredits: 250 });
  expect(parseCreditCeiling("")).toEqual({ capCredits: null });
  for (const bad of ["0", "2.5", "-3", "$20", "lots", "1e3", "1000001", "Infinity"])
    expect(parseCreditCeiling(bad), bad).toHaveProperty("error");
  const credits = { scope: "render" as const, inCredits: true };
  expect(tokenCeiling({ capCredits: 500 }, credits)).toEqual({ capUsd: null, capCredits: 500 });
  expect(tokenCeiling({ capCredits: "" }, credits)).toEqual({ capUsd: null, capCredits: null });
  expect(tokenCeiling({}, credits)).toEqual({ capUsd: null, capCredits: null });
  expect(tokenCeiling({ capUsd: 20 }, credits)).toHaveProperty("error", expect.stringContaining("counts in credits"));
  expect(tokenCeiling({ capCredits: 2.5 }, credits)).toHaveProperty("error");
  expect(tokenCeiling({ capCredits: 500 }, { scope: "read", inCredits: true })).toEqual({ capUsd: null, capCredits: null });
  const dollars = { scope: "render" as const, inCredits: false };
  expect(tokenCeiling({ capUsd: "$35" }, dollars)).toEqual({ capUsd: 35, capCredits: null });
  expect(tokenCeiling({ capCredits: 500 }, dollars)).toHaveProperty("error", expect.stringContaining("in dollars"));
  expect(tokenCeiling({ capUsd: 20 }, { scope: "read", inCredits: false })).toEqual({ capUsd: null, capCredits: null });
  expect(tokenCeiling({ capUsd: "twenty" }, { scope: "read", inCredits: false })).toHaveProperty("error");
});

test("in a credits workspace POST stores whole credits and GET names no dollar figure", async () => {
  type Handler = (request: Request) => Promise<Response>;
  const inserted: unknown[][] = [];
  let listed = "";
  const compiled = ts.transpileModule(readFileSync(path.join(process.cwd(), "app/api/tokens/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/securityAudit": { securityAuditStatement: () => ({ sql: "SELECT 1", args: [] }) },
    "@/lib/tenant": { requireTenant: () => ({ id: "tenant-fixture", legacy: false, usesPlatformKeys: true }) },
    "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
    "@/lib/credits": await import("../../lib/credits").then((m) => ({ creditsApply: m.creditsApply })),
    "@/lib/creditReceipts": { syncCreditReceipts: async () => {} },
    "@/lib/tokenUsage": { tokenCreditUsage: async () => new Map([["tok_a", 42]]) },
    "@/lib/creditSql": { billedCreditsExpr: () => "0" },
    "@/lib/cycle": await import("../../lib/cycle"),
    "@/lib/db": {
      db: () => ({
        batch: async (statements: { args: unknown[] }[]) => { inserted.push(statements[0].args); },
        execute: async ({ sql }: { sql: string }) => {
          listed = sql;
          return { rows: [{ id: "tok_a", name: "Claude", scope: "render", cap_usd: 20, cap_credits: null, last_used: null, created_at: 1, spend: 42 }] };
        },
      }),
      ready: async () => {}, now: () => 1, id: () => "tok_fixture",
    },
    "@/lib/auth": {
      currentUser: async () => ({ id: "caller" }),
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
  expect((await post({ name: "Dollars", scope: "render", capUsd: 20 })).status).toBe(400);
  expect((await post({ name: "Fraction", scope: "render", capCredits: 2.5 })).status).toBe(400);
  expect(inserted).toEqual([]);
  expect(await (await post({ name: "Capped", scope: "render", capCredits: 500 })).json()).toMatchObject({ capCredits: 500, capUsd: null });
  expect(await (await post({ name: "Open", scope: "render" })).json()).toMatchObject({ capCredits: null, capUsd: null });
  expect(inserted.map((args) => [args[5], args[6]])).toEqual([[null, 500], [null, null]]);

  const list = await (await mod.exports.GET(new Request("http://localhost/api/tokens"))).json();
  expect(listed).not.toContain("cost_usd");
  /* The month is the credits billed (#385), the ceiling is in credits, and a dollar ceiling set before credits is named, never shown. */
  expect(list.unit).toBe("cr");
  expect(list.tokens[0]).toEqual({ id: "tok_a", name: "Claude", scope: "render", spendThisMonth: 42, capCredits: null, legacyCeiling: true, lastUsed: null, createdAt: 1 });
  expect(JSON.stringify(list)).not.toMatch(/capUsd|usd/i);
});
