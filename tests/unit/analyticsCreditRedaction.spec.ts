import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A credit workspace is billed in credits and never shown the vendor's
 * dollars behind them: with both, `credits × 0.10 ÷ spend` is the markup per
 * engine. /api/analytics and /api/tokens used to send both to any member.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-analytics-credits-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

function workspace(id: string, usesPlatformKeys: boolean): TenantWorkspace {
  return {
    id, name: id, slug: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys, allowanceUsd: null,
    ownerId: "member", createdAt: 0, gatewayKeyId: null,
    suspendedAt: null, suspendedReason: null, flaggedAt: null,
    flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

async function seed(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    const now = Date.now();
    await db().batch([
      { sql: "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('member','member@example.invalid','Member','x',?)", args: [now] },
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_usd,created_at) VALUES('tok-1','hash','Assistant','member','render',20,?)", args: [now] },
      ...["a", "b"].map((id, i) => ({
        sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,created_by,cost_usd,refine_cost_usd,refine_model,token_id)
              VALUES(?,?,'A fox','{}','succeeded',?,?,'video','member',?,?,?,'tok-1')`,
        args: [id, i ? "kling-v3-pro" : "gemini-3.1-flash-image", now, now, i ? 0.84 : 0.045, i ? 0.01 : null, i ? "claude" : null],
      })),
    ]);
  });
}

async function routes() {
  const tenant = await import("../../lib/tenant");
  const auth = {
    withTenant: (handler: unknown) => handler,
    requireUser: async () => ({ user: { id: "member", role: "member" } }),
    currentUser: async () => ({ id: "member", role: "member" }),
  };
  const dependencies = {
    "@/lib/auth": auth, "@/lib/tenant": tenant,
    "@/lib/db": await import("../../lib/db"),
    "@/lib/models": await import("../../lib/models"),
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/maskEmail": await import("../../lib/maskEmail"),
    "@/lib/securityAudit": {},
  };
  return {
    analytics: load<{ GET: (req: Request) => Promise<Response> }>("app/api/analytics/route.ts", dependencies).GET,
    tokens: load<{ GET: () => Promise<Response> }>("app/api/tokens/route.ts", dependencies).GET,
    run: <T>(ws: TenantWorkspace, fn: () => Promise<T>) => tenant.runInTenant(ws, fn),
  };
}

/** Every `spend`/`promptSpend` figure anywhere in a JSON body. */
function dollars(value: unknown, found: number[] = []): number[] {
  if (Array.isArray(value)) value.forEach((v) => dollars(v, found));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if ((key === "spend" || key === "promptSpend") && typeof v === "number") found.push(v);
      else dollars(v, found);
    }
  }
  return found;
}

test("a credit workspace's analytics carry credits and no vendor dollars, ordered by credits", async () => {
  const ws = workspace("credit-ws", true);
  await seed(ws);
  const api = await routes();
  const body = await api.run(ws, async () => (await api.analytics(new Request("https://studio.test/api/analytics"))).json());
  expect(body.unit).toBe("cr");
  expect(dollars(body)).toEqual([]);
  expect(body.totals.credits).toBeGreaterThan(0);
  expect(body.byModel.length).toBe(2);
  for (const row of body.byModel) {
    expect(row.credits).toBeGreaterThan(0);
    expect(row).not.toHaveProperty("spend");
  }
  expect(body.byModel[0].credits).toBeGreaterThanOrEqual(body.byModel[1].credits);
  /* All-time spend is the credits billed, not the vendor's 0.895 dollars. */
  expect(body.credit.spentAllTime).toBe(body.totals.credits);
});

test("a vendor-paying workspace still reads its own dollars", async () => {
  const ws = workspace("byok-ws", false);
  await seed(ws);
  const api = await routes();
  const body = await api.run(ws, async () => (await api.analytics(new Request("https://studio.test/api/analytics"))).json());
  expect(body.unit).toBe("usd");
  expect(body.totals.spend).toBeCloseTo(0.895, 6);
  expect(body.totals.promptSpend).toBeCloseTo(0.01, 6);
  expect(body.byModel.every((row: { spend?: number }) => typeof row.spend === "number")).toBe(true);
});

test("a credit workspace's API tokens report their month in credits billed", async () => {
  const credit = workspace("credit-tokens", true), byok = workspace("byok-tokens", false);
  await seed(credit);
  await seed(byok);
  const api = await routes();
  const inCredits = await api.run(credit, async () => (await api.tokens()).json());
  expect(inCredits.unit).toBe("cr");
  /* 0.045 × 1.5 / 0.10 → 1 cr, and 0.85 × 1.5 / 0.10 → 13 cr. */
  expect(inCredits.tokens[0].spendThisMonth).toBe(14);
  const inDollars = await api.run(byok, async () => (await api.tokens()).json());
  expect(inDollars.unit).toBe("usd");
  expect(inDollars.tokens[0].spendThisMonth).toBeCloseTo(0.895, 6);
});
