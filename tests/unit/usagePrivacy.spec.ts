import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { pinCreditUsd } from "../helpers/creditRate";

/* GET /api/usage's own body (no ?rows) under the rule /api/analytics and the
   per-job ledger keep: everyone's spend by person is the owners' and admins'.
   A member reads their own row by name and the rest of the team as
   "Teammate" — in the credit body and in the dollar body alike, with no
   teammate's name or email anywhere in the answer. The route runs as it
   ships, on per-workspace databases; only the vendors' own consoles are
   stubbed. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-usage-privacy-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
pinCreditUsd("0.10");
process.env.ENGINE_MOCK = "1";

const run = randomUUID().slice(0, 8);
function workspace(name: string, credits: boolean): TenantWorkspace {
  return {
    id: `ws_usage_privacy_${name}_${run}`, slug: `usage-privacy-${name}`, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: credits,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 10, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
  };
}

/* The team. The viewer under test is the member; everyone else is a teammate. */
const PEOPLE = [
  { id: "u_owner", name: "Owner Fixture", email: "owner-fixture@example.test", role: "admin" as const, owner: true },
  { id: "u_editor", name: "Editor Fixture", email: "editor-fixture@example.test", role: "admin" as const, owner: false },
  { id: "u_crew", name: "Crew Fixture", email: "crew-fixture@example.test", role: "member" as const, owner: false },
  { id: "u_member", name: "Member Fixture", email: "member-fixture@example.test", role: "member" as const, owner: false },
];
const person = (id: string): TenantUser => {
  const p = PEOPLE.find((x) => x.id === id)!;
  return { ...p, disabled: false, lastSeen: null, createdAt: 0 };
};
/* What only a teammate's row could carry, as the member reads it. */
const TEAMMATES = PEOPLE.filter((p) => p.id !== "u_member").flatMap((p) => [p.name, p.email, p.email.split("@")[0]]);

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
type Row = { name: string; n: number; spend: number; credits: number };
type Body = { unit?: string; byPerson: Row[]; vendors: { id: string; anchor?: { authorName: string | null } | null }[] };

/** GET /api/usage as `user` reads it in `ws`: its real code, its real libraries; the vendors' own consoles stubbed. */
async function usageAs(ws: TenantWorkspace, user: TenantUser): Promise<{ body: Body; wire: string }> {
  const { runInTenant } = await import("../../lib/tenant");
  const GET = load<{ GET: Handler }>("app/api/usage/route.ts", {
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/auth": {
      requireUser: async () => ({ user }),
      withTenant: (fn: Handler) => (req: Request) => runInTenant(ws, () => fn(req), { user }),
    },
    "@/lib/db": await import("../../lib/db"),
    "@/lib/jobs": { syncActive: async () => {} },
    "@/lib/models": await import("../../lib/models"),
    "@/lib/enhance": { hasFreeTier: () => false, gatewayCredits: async () => null },
    "@/lib/providers": await import("../../lib/providers"),
    "@/lib/elevenlabs": { elevenConfigured: () => false, subscription: async () => null, FALLBACK_USD_PER_CREDIT: 0.0001 },
    "@/lib/reconcile": await import("../../lib/reconcile"),
    "@/lib/storageCost": { storageLedger: async () => null },
    "@/lib/creditReceipts": await import("../../lib/creditReceipts"),
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/creditUsage": await import("../../lib/creditUsage"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/creditTerms": await import("../../lib/creditTerms"),
    "@/lib/usageLedger": await import("../../lib/usageLedger"),
    "@/lib/usageParams": await import("../../lib/usageParams"),
  }).GET;
  const response = await GET(new Request("http://localhost/api/usage"));
  expect(response.status).toBe(200);
  const wire = await response.text();
  return { body: JSON.parse(wire) as Body, wire };
}

async function team(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    for (const p of PEOPLE)
      await db().execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,0)", args: [p.id, p.email, p.name, p.role] });
  });
}
const names = (body: Body) => body.byPerson.map((r) => r.name);

/* What the vendors charged for the seeded jobs: figures a dollar leak would carry. */
const VENDOR_USD = ["2.8667", "1.3333", "0.7777", "0.4444", "0.0421"];

test("a credit workspace's usage: owners and admins read every name; a member reads their own and one Teammate row, and never a dollar", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const ws = workspace("credits", true);
  await team(ws);
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,500,'unit','manual',0)", args: [`grant_${run}`, ws.id] });
  const at = Date.now();
  const jobs: [string, string | null, string, string, string, number, number][] = [
    ["owner", "u_owner", "video", "byteplus", "dreamina-seedance-2-5-260628", 2.8667, 43],
    ["editor", "u_editor", "video", "fal", "fal-ai/kling-video/v3/standard", 1.3333, 20],
    ["crew", "u_crew", "image", "google", "gemini-3.1-flash-image", 0.7777, 12],
    ["member", "u_member", "image", "google", "gemini-3.1-flash-image", 0.4444, 7],
    /* A job the meter recorded without an author. */
    ["nobody", null, "text", "vercel", "anthropic/claude-sonnet-4.6", 0.0421, 1],
  ];
  for (const [key, by, kind, engine, model, usd, credits] of jobs)
    await platformDb().execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'succeeded',?,?,1,?,?,?)`,
      args: [`me_${key}_${run}`, ws.id, kind, engine, model, usd, credits, by, at, at],
    });

  const owner = await usageAs(ws, person("u_owner"));
  expect(owner.body.unit).toBe("credits");
  expect(owner.body.byPerson).toEqual([
    { name: "Owner Fixture", n: 1, credits: 43, spend: 43 },
    { name: "Editor Fixture", n: 1, credits: 20, spend: 20 },
    { name: "Crew Fixture", n: 1, credits: 12, spend: 12 },
    { name: "Member Fixture", n: 1, credits: 7, spend: 7 },
    { name: "Unknown", n: 1, credits: 1, spend: 1 },
  ]);
  /* An admin who is not the owner reads the whole team too. */
  expect(names((await usageAs(ws, person("u_editor"))).body)).toEqual(["Owner Fixture", "Editor Fixture", "Crew Fixture", "Member Fixture", "Unknown"]);

  /* A member: their own row by name, and the rest of the team as one row — no teammate's spend told apart. */
  const member = await usageAs(ws, person("u_member"));
  expect(member.body.byPerson).toEqual([
    { name: "Teammate", n: 3, credits: 43 + 20 + 12, spend: 43 + 20 + 12 },
    { name: "Member Fixture", n: 1, credits: 7, spend: 7 },
    { name: "Unknown", n: 1, credits: 1, spend: 1 },
  ]);
  for (const other of TEAMMATES) expect(member.wire, `a member's usage names ${other}`).not.toContain(other);
  /* Another member sees the same team from their side. */
  expect((await usageAs(ws, person("u_crew"))).body.byPerson.map((r) => [r.name, r.credits])).toEqual([["Teammate", 43 + 20 + 7], ["Crew Fixture", 12], ["Unknown", 1]]);

  /* Still credits alone, whoever reads it (#385, #407). */
  for (const { wire } of [owner, member]) {
    expect(wire).not.toMatch(/usd|\$/i);
    for (const figure of VENDOR_USD) expect(wire).not.toContain(figure);
  }
});

test("a workspace that pays its vendors: the same rule on its dollar body, the vendor reading's author included", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { recordCheck } = await import("../../lib/reconcile");
  const ws = workspace("dollars", false);
  await team(ws);
  const at = Date.now() - 60_000;
  await runInTenant(ws, async () => {
    const take = "INSERT INTO generations(id,model,prompt,params,status,kind,provider,cost_usd,refine_cost_usd,created_by,created_at,updated_at) VALUES(?,?,?,'{}','succeeded','video','byteplus',?,?,?,?,?)";
    /* "u_gone" made a take and has since left: no user row, so nobody reads a name for it. */
    for (const [key, by, usd, refine] of [["owner", "u_owner", 1.25, 0.05], ["editor", "u_editor", 0.5, null], ["crew", "u_crew", 0.25, null], ["member", "u_member", 0.1, null], ["gone", "u_gone", 0.05, null]] as const)
      await db().execute({ sql: take, args: [`g_${key}`, "dreamina-seedance-2-5-260628", `a harbour, ${key}`, usd, refine, by, at, at] });
    const { meter } = await import("../../lib/meter");
    for (const [key, by, cost] of [["owner", "u_owner", 1.3], ["editor", "u_editor", .5], ["crew", "u_crew", .25], ["member", "u_member", .1], ["gone", "u_gone", .05]] as const)
      await meter({ id: `privacy_migrated_${key}`, kind: "video", engine: "byteplus", model: "fixture", status: "succeeded", engineCostUsd: cost, createdBy: by });
    /* The owner read the vendor's console: the reading carries who took it. */
    await recordCheck({ provider: "byteplus", balanceUsd: 40, spendUsd: 10, balanceCredits: null, spendCredits: null, note: "", checkedAt: at + 1_000, userId: "u_owner" });
  });

  const owner = await usageAs(ws, person("u_owner"));
  expect(owner.body.unit).toBe("credits");
  expect(owner.body.byPerson.map((r) => [r.name, r.n, r.spend])).toEqual([
    ["Owner Fixture", 1, 20], ["Editor Fixture", 1, 8], ["Crew Fixture", 1, 4], ["Member Fixture", 1, 2], ["Unknown", 1, 1],
  ]);
  expect(owner.body.vendors.find((v) => v.id === "byteplus")?.anchor).toBeUndefined();

  /* The one who left is someone else's work to a member: part of the Teammate row. */
  const member = await usageAs(ws, person("u_member"));
  expect(member.body.byPerson.map((r) => r.name)).toEqual(["Teammate", "Member Fixture"]);
  expect(member.body.byPerson[0].n).toBe(4);
  expect(member.body.byPerson[0].spend).toBe(33);
  expect(member.body.byPerson[1]).toMatchObject({ n: 1, spend: 2 });
  expect(member.body.vendors.find((v) => v.id === "byteplus")?.anchor).toBeUndefined();
  for (const other of TEAMMATES) expect(member.wire, `a member's usage names ${other}`).not.toContain(other);
});
