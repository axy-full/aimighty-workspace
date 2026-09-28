import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A token's ceiling in credits (idea 20), held where the dollar ceiling is:
 * in the spend gate, under its lock, counting the token's reserved jobs. An
 * assistant that starts several takes before any settles cannot pass it, and
 * a held take is released against it like any other.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-token-credits-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = "dreamina-seedance-2-0-260128";
/* One run of the unit project shares a platform database across files: every id here is this run's own. */
const RUN = Math.random().toString(36).slice(2, 8);
const uid = (id: string) => `${id}_${RUN}`;

function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}_${RUN}`, slug: `${name}-${RUN}`, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}-${RUN}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 8, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}
async function setup(name: string, capCredits: number) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  const ws = workspace(name);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)",
    args: [uid(`grant_${name}`), ws.id, 1000, Date.now()],
  });
  return { ws, token: async () => {
    await ready();
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_test','member@example.invalid','Member','x',0)",
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,cap_credits,created_at) VALUES('tok_cr','hash','assistant','u_test',?,0)", args: [capCredits] },
    ], "write");
  } };
}
const take = (id: string) => ({ id: uid(id), kind: "video" as const, engine: "byteplus", model: SEEDANCE, status: "running" as const, engineCostUsd: 1, createdBy: "u_test" });

test("a burst of takes cannot pass a credits ceiling: reserved jobs count before any settles", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { ws, token } = await setup("burst", 30);
  await runInTenant(ws, async () => {
    await token();
    const capped = { token: { id: "tok_cr", capUsd: null, capCredits: 30 } };
    // Two fixture reservations fit the ceiling; the third must be refused.
    await reserveGenerationSpend(take("g1"), capped);
    await reserveGenerationSpend(take("g2"), capped);
    await expect(reserveGenerationSpend(take("g3"), capped)).rejects.toMatchObject({ status: 429, message: expect.stringContaining("30 cr monthly ceiling") });
    // The wall is the token's own: the workspace, and a take without the token, still start.
    await reserveGenerationSpend(take("g4"), {});
    const { platformDb } = await import("../../lib/platform");
    const metered = await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=? ORDER BY id", args: [ws.id] });
    expect(metered.rows.map((r) => String(r.id))).toEqual(["g1", "g2", "g4"].map(uid));
  });
});

test("a token ceiling retains the admitted terms when a reservation is checked again", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { platformDb } = await import("../../lib/platform");
  const { ws, token } = await setup("frozen", 15);
  await runInTenant(ws, async () => {
    await token();
    const capped = { token: { id: "tok_cr", capUsd: null, capCredits: 15 } };
    const event = take("frozen");
    await reserveGenerationSpend(event, capped);
    try {
      process.env.CREDIT_USD = "0.01";
      await reserveGenerationSpend(event, capped);
      const row = (await platformDb().execute({ sql: "SELECT billed_credits FROM meter_events WHERE id=?", args: [event.id] })).rows[0];
      expect(Number(row.billed_credits)).toBe(15);
      process.env.CREDIT_USD = "1.00";
      await expect(reserveGenerationSpend({ ...event, engineCostUsd: 2 }, capped)).rejects.toMatchObject({ status: 429 });
      const unchanged = (await platformDb().execute({ sql: "SELECT billed_credits FROM meter_events WHERE id=?", args: [event.id] })).rows[0];
      expect(Number(unchanged.billed_credits)).toBe(15);
    } finally {
      process.env.CREDIT_USD = "0.10";
    }
  });
});

test("a held take made with a credits-capped token is released against that ceiling", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { ws, token } = await setup("held", 10);
  await runInTenant(ws, async () => {
    await token();
    const { db } = await import("../../lib/db");
    const t = Date.now() - 60_000;
    for (const [id, tok, at] of [[uid("gen_capped"), "tok_cr", t], [uid("gen_free"), null, t + 1]] as const)
      await db().execute({
        sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,token_id,billed_to,task)
              VALUES(?,'video','byteplus',?,'test',?,'held','u_test',?,?,?,'byteplus','generate')`,
        args: [id, SEEDANCE, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, held: { estUsd: 1, needs: 15, at: 1, why: "credits" } }), at, at, tok],
      });
    const out = await releaseHeldJobs({ defer: async () => {} });
    expect(out.released).toEqual([uid("gen_free")]);
    const row = (await db().execute({ sql: "SELECT status,error FROM generations WHERE id=?", args: [uid("gen_capped")] })).rows[0];
    expect(row).toMatchObject({ status: "held", error: expect.stringContaining("10 cr monthly ceiling") });
  });
});
