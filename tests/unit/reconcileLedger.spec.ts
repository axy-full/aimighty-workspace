import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/* Engine balances for a workspace that pays its vendors itself. What a
   vendor was paid stays paid when a take or a conversation is hidden, and
   once a console reading is recorded the balance counts down by the same
   spend the unanchored ledger counts: renders, the prompt writer, Atomik. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-reconcile-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const ws: TenantWorkspace = {
  id: "ws_reconcile", slug: "reconcile", name: "Reconcile", legacy: false,
  dbUrl: `file:${path.join(dir, "reconcile.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};

test("hidden takes and chats stay spent, and a reading counts text down as well as renders", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { renderSpendByPayer, atomikTextSpend, spendSince, computedSpendUpTo } = await import("../../lib/reconcile");
  const before = 1_000, reading = 2_000, after = 3_000;
  await runInTenant(ws, async () => {
    await ready();
    const take = `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd,refine_model,refine_cost_usd,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    await db().batch([
      { sql: take, args: ["g1", "dreamina-seedance-2-5-260628", "one", "{}", "succeeded", before, before, "video", "byteplus", 1, "anthropic/claude-test", 0.05, 0] },
      // Deleted after it was paid for.
      { sql: take, args: ["g2", "dreamina-seedance-2-5-260628", "two", "{}", "succeeded", before, before, "video", "byteplus", 0.5, null, null, 1] },
      { sql: take, args: ["g3", "dreamina-seedance-2-5-260628", "three", "{}", "succeeded", after, after, "video", "byteplus", 0.25, "seed-text-test", 0.02, 1] },
      { sql: take, args: ["g4", "dreamina-seedance-2-5-260628", "four", "{}", "failed", after, after, "video", "byteplus", null, "anthropic/claude-test", 0.03, 0] },
      // A hidden voice line: ElevenLabs charged its credits, which total_tokens carries.
      { sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd,total_tokens,deleted) VALUES('g5','eleven-test','five','{}','succeeded',?,?,'audio','elevenlabs',0.3,100,1)`, args: [before, before] },
      { sql: `INSERT INTO atomik_chats(id,created_at,updated_at,deleted,text_cost_usd) VALUES('c_hidden',?,?,1,0.4),('c_live',?,?,0,0)`, args: [before, before, before, before] },
      { sql: `INSERT INTO atomik_messages(id,chat_id,role,cost_usd,created_at) VALUES('m1','c_hidden','assistant',0.3,?),('m2','c_hidden','assistant',0.1,?)`, args: [before, after] },
      { sql: `INSERT INTO atomik_spend(id,kind,cost_usd,created_at) VALUES('s1','idea',0.04,?)`, args: [after] },
    ]);

    const renders = new Map((await renderSpendByPayer()).map((r) => [r.provider, r]));
    expect(renders.get("byteplus")!.usd).toBeCloseTo(1.75, 6);
    // The counts are of the takes still shown (g1 and g4); the money is every take's.
    expect(renders.get("byteplus")!.attempts).toBe(2);
    expect(renders.get("byteplus")!.succeeded).toBe(1);
    expect(renders.get("elevenlabs")).toMatchObject({ attempts: 0, succeeded: 0, tokens: 100 });
    expect(renders.get("elevenlabs")!.usd).toBeCloseTo(0.3, 6);

    const atomik = await atomikTextSpend();
    expect(atomik.usd).toBeCloseTo(0.44, 6);
    expect(atomik.chats).toBe(1);

    // After the reading: the gateway paid for g4's prompt, one Atomik turn and one write-up.
    expect((await spendSince("vercel", reading)).usd).toBeCloseTo(0.03 + 0.1 + 0.04, 6);
    // ByteDance: g3's render and its own prompt writer.
    const byteplus = await spendSince("byteplus", reading);
    expect(byteplus.usd).toBeCloseTo(0.25 + 0.02, 6);
    expect(byteplus.renders).toBe(1);
    // Up to the reading, for the drift: like with like.
    expect((await computedSpendUpTo("vercel", reading)).usd).toBeCloseTo(0.05 + 0.3, 6);
    expect((await computedSpendUpTo("byteplus", reading)).usd).toBeCloseTo(1.5, 6);
  });
});
