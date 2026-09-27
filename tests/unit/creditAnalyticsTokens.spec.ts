import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/* A credit workspace is never shown the vendor's dollars: beside its credits
   they are the margin (lib/analyticsRedact.ts). So its API tokens report the
   month in credits billed, and its analytics lists are ordered by credits —
   an order by the dollars it no longer sees would still say what the vendor
   charged. A workspace on its own keys pays those dollars and keeps them. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-credit-analytics-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";

function workspace(id: string, credits: boolean): TenantWorkspace {
  return {
    id, slug: id, name: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: credits, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

/** The route file, compiled as it ships, with its imports answered by `dependencies`. */
function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith("@/")) throw new Error(`Unstubbed import ${name} in ${file}`);
      return require(name);
    },
    mod, mod.exports,
  );
  return mod.exports as T;
}
type Handler = (req: Request) => Promise<Response>;
const nextServer = { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };

/**
 * Two of everything. H cost the vendor more ($1.00 against $0.98); L was
 * billed more (16 cr against 15), because credits round up per job: H is one
 * $1.00 take (15 cr) and a failed one, L is two $0.49 takes (8 cr each).
 * Every take went through the owner's token.
 */
async function seed(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    const now = Date.now();
    const take = (id: string, group: "h" | "l", cost: number, status: string) => ({
      sql: `INSERT INTO generations(id,project_id,shot_id,model,prompt,params,status,created_at,updated_at,kind,created_by,cost_usd,token_id)
            VALUES(?,?,?,?,'A fox','{}',?,?,?,'video',?,?,'tok_1')`,
      args: [id, `p_${group}`, `s_${group}`, group === "h" ? "kling-v3-pro" : "gemini-3.1-flash-image", status, now, now, group, cost],
    });
    await db().batch([
      ...[["owner", "Owner", "admin"], ["h", "Heavy", "member"], ["l", "Light", "member"]].map(([id, name, role]) => ({
        sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,?)", args: [id, `${id}@example.invalid`, name, role, now],
      })),
      ...(["h", "l"] as const).flatMap((group) => [
        { sql: "INSERT INTO projects(id,name,category,created_at) VALUES(?,?,?,?)", args: [`p_${group}`, `Project ${group.toUpperCase()}`, `Category ${group.toUpperCase()}`, now] },
        { sql: "INSERT INTO shots(id,project_id,code,created_at,updated_at) VALUES(?,?,?,?,?)", args: [`s_${group}`, `p_${group}`, group.toUpperCase(), now, now] },
      ]),
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_usd,created_at) VALUES('tok_1','hash','Assistant','owner','render',20,?)", args: [now] },
      take("h1", "h", 1.0, "succeeded"), take("h2", "h", 0, "failed"),
      take("l1", "l", 0.49, "succeeded"), take("l2", "l", 0.49, "succeeded"),
    ], "write");
  });
}

async function routes(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const user = { id: "owner", role: "admin", name: "Owner", email: "owner@example.invalid" };
  const modules = {
    "next/server": nextServer,
    "@/lib/auth": {
      requireUser: async () => ({ user }),
      currentUser: async () => user,
      withTenant: (fn: Handler) => (req: Request) => runInTenant(ws, () => fn(req), { user } as never),
    },
    "@/lib/db": await import("../../lib/db"),
    "@/lib/models": await import("../../lib/models"),
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/maskEmail": await import("../../lib/maskEmail"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/analyticsRedact": await import("../../lib/analyticsRedact"),
    "@/lib/tokenCeiling": await import("../../lib/tokenCeiling"),
    "@/lib/securityAudit": { securityAuditStatement: () => ({ sql: "SELECT 1", args: [] }) },
  };
  const analytics = load<{ GET: Handler }>("app/api/analytics/route.ts", modules).GET;
  const tokens = load<{ GET: Handler }>("app/api/tokens/route.ts", modules).GET;
  return {
    analytics: () => analytics(new Request("https://studio.test/api/analytics")).then((r) => r.json()),
    tokens: () => tokens(new Request("https://studio.test/api/tokens")).then((r) => r.json()),
  };
}

type Body = Record<string, { model?: string; name?: string; id?: string; category?: string; code?: string; credits: number; spend?: number }[]>;
/** Which group leads each list, and the group order of each. */
const orders = (body: Body) => ({
  byModel: body.byModel.map((r) => (r.model === "kling-v3-pro" ? "h" : "l")),
  byProject: body.byProject.map((r) => r.name?.slice(-1).toLowerCase()),
  byPerson: body.byPerson.map((r) => r.id),
  byCategory: body.byCategory.map((r) => r.category?.slice(-1).toLowerCase()),
  byShot: body.byShot.map((r) => r.code?.toLowerCase()),
});

test("a credit workspace's analytics are credits alone, and every list is ordered by them", async () => {
  const ws = workspace("ws_credit_analytics", true);
  await seed(ws);
  const body = await (await routes(ws)).analytics();
  expect(JSON.stringify(body)).not.toMatch(/"spend"|"promptSpend"|"credit":/);
  expect(body.totals.credits).toBe(31);
  expect(body.byModel.map((r: { credits: number }) => r.credits)).toEqual([16, 15]);
  expect(orders(body)).toEqual({ byModel: ["l", "h"], byProject: ["l", "h"], byPerson: ["l", "h"], byCategory: ["l", "h"], byShot: ["l", "h"] });
});

test("a workspace on its own keys reads its own dollars, ordered by them", async () => {
  const ws = workspace("ws_own_keys_analytics", false);
  await seed(ws);
  const body = await (await routes(ws)).analytics();
  expect(body.totals.spend).toBeCloseTo(1.98, 6);
  expect(body.byModel[0].spend).toBeCloseTo(1, 6);
  expect(orders(body)).toEqual({ byModel: ["h", "l"], byProject: ["h", "l"], byPerson: ["h", "l"], byCategory: ["h", "l"], byShot: ["h", "l"] });
});

test("API tokens: a credit workspace's month is the credits billed; one on its own keys reads dollars", async () => {
  const credit = workspace("ws_credit_tokens", true), own = workspace("ws_own_keys_tokens", false);
  await seed(credit);
  await seed(own);
  const inCredits = await (await routes(credit)).tokens();
  expect(inCredits).toMatchObject({ unit: "cr", tokens: [{ id: "tok_1", capUsd: 20, spendThisMonth: 31 }] });
  const inDollars = await (await routes(own)).tokens();
  expect(inDollars.unit).toBe("usd");
  expect(inDollars.tokens[0].spendThisMonth).toBeCloseTo(1.98, 6);
});
