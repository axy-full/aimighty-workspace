import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";

/* The walls a customer can walk into say nothing about what the vendors
   charge: a token's monthly ceiling trips on what the workspace pays, the
   monthly cap on the platform's engines is refused without its figures, a
   quote exposes only the approval amount and the workspace's own unit. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-vendor-walls-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const run = randomUUID().slice(0, 8);
function workspace(name: string, credits: boolean, allowanceUsd: number | null = null): TenantWorkspace {
  return {
    id: `ws_walls_${name}_${run}`, slug: `walls-${name}-${run}`, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: credits,
    allowanceUsd, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 10, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
  };
}
const SEEDANCE = "dreamina-seedance-2-5-260628";

async function granted(ws: TenantWorkspace, credits = 500) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,?,'unit','manual',0)", args: [`grant_${ws.id}`, ws.id, credits] });
}

test("a token credit ceiling includes reserved work and does not expose provider amounts", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { tokenSpendThisMonth } = await import("../../lib/auth");
  const { billCredits } = await import("../../lib/creditTerms");
  const ws = workspace("token", true);
  /* The next job must include the existing reservation in the credit ceiling. */
  const perJob = billCredits(1, SEEDANCE);
  const cap = perJob + Math.floor(perJob / 2);
  await granted(ws);
  await runInTenant(ws, async () => {
    await ready();
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u_owner','owner@example.test','Owner','x','admin',0)",
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_credits,created_at) VALUES('tok_walls','hash_walls','Agent','u_owner','render',?,0)", args: [cap] },
    ], "write");
    const token = { id: "tok_walls", capCredits: cap, capUsd: null };
    const job = (id: string) => ({ id, kind: "video" as const, engine: "byteplus", model: SEEDANCE, status: "running" as const, engineCostUsd: 1, createdBy: "u_owner" });
    await reserveGenerationSpend(job("gen_walls_1"), { token });
    await db().execute({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,cost_usd,token_id) VALUES('gen_walls_1',?,'one','{}','running',?,?,'video',1,'tok_walls')`, args: [SEEDANCE, Date.now(), Date.now()] });
    /* A second reservation exceeds the approved credit ceiling. */
    const refused = await reserveGenerationSpend(job("gen_walls_2"), { token }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(SpendReservationError);
    expect((refused as InstanceType<typeof SpendReservationError>).status).toBe(429);
    expect((refused as Error).message).toContain("token's monthly credit ceiling");
    /* Legacy accounting remains private and unchanged; no amount enters the refusal. */
    expect(await tokenSpendThisMonth("tok_walls")).toBe(1);
    expect((refused as Error).message).not.toMatch(/\$|\d/);
  });
});

test("the monthly cap on the platform's engines refuses without a figure", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { allowanceCheck, ALLOWANCE_REACHED } = await import("../../lib/allowance");
  const ws = workspace("allowance", true, 0.5);
  await granted(ws);
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd) VALUES('gen_cap',?,'p','{}','succeeded',?,?,'video','byteplus',0.731301)`, args: [SEEDANCE, Date.now(), Date.now()] });
    const verdict = await allowanceCheck("ark", 0.1, SEEDANCE);
    expect(verdict).toEqual({ ok: false, status: 429, error: ALLOWANCE_REACHED });
    expect(ALLOWANCE_REACHED).not.toMatch(/\$|\d/);
  });
});

test("current and migrated studios receive the same retail credit quote", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { quotedCredits } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { publicQuote, quoteOf, liveTerms } = await import("../../lib/quote");
  expect(await runInTenant(workspace("quote_cr", true), async () => quotedCredits(1.339101, SEEDANCE))).toBe(billCredits(1.339101, SEEDANCE));
  /* Stored funding preferences cannot bypass managed retail quotes. */
  expect(await runInTenant(workspace("quote_usd", false), async () => quotedCredits(1.339101, SEEDANCE))).toBe(billCredits(1.339101, SEEDANCE));
  /* A quote leaves the server in credits alone (/api/rig/quote). */
  const q = quoteOf([{ key: "s1", usd: 1.339101, engine: SEEDANCE }, { key: "s2", usd: 0.512901, engine: SEEDANCE }], liveTerms());
  const shown = publicQuote(q);
  expect(JSON.stringify(shown)).not.toMatch(/usd/i);
  expect(shown.totalCredits).toBe(q.totalCredits);
  expect(shown.lines.map((l) => l.credits)).toEqual(q.lines.map((l) => l.credits));
});

test("the MCP tools print a credit workspace's takes and projects in credits", async () => {
  const { runTool } = await import("../../lib/mcp");
  const call = async (pathname: string) => {
    if (pathname === "/api/projects") return { projects: [{ id: "p1", name: "Harbour", genCount: 2, credits: 36 }] };
    if (pathname.startsWith("/api/jobs/")) return { generation: { id: "g1", status: "succeeded", prompt: "A harbour", costUsd: null, creditsBilled: 21 } };
    throw new Error(`unexpected ${pathname}`);
  };
  const projects = await runTool("list_projects", {}, call as never, "https://example.invalid");
  expect(projects).toBe("Harbour — 2 renders · 36 cr");
  const done = await runTool("wait_for_render", { id: "g1", timeout_seconds: 5 }, call as never, "https://example.invalid");
  expect(done).toContain("Cost 21 cr.");
  expect(done).not.toContain("$");
});
