import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/*
 * The spending setting an outside agent's paid tool reads (lib/mcpSpendPolicy.ts; rule 14, #790's follow-up). Through a real tenant database:
 * only an exact "auto" lets a call start anything; every other value, the default (no row) and an unreadable database are Ask; the line is the
 * Rig's per-job line, never above guardrail 4 (200 cr at $0.10); and the value is read past the settings memo, so a change made by another
 * server process a moment ago is the one acted on. Nothing is priced, sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-mcp-spend-policy-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string, dbUrl: string): TenantWorkspace => ({
  id, slug: id, name: "Spend policy", legacy: false, dbUrl, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
});

test("only an exact \"auto\" is Auto; the default, any other spelling and Ask are Ask; the line is guardrail 4's at most", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { setSetting } = await import("../../lib/settings");
  const { mcpSpendPolicy } = await import("../../lib/mcpSpendPolicy");
  const { jobApprovalLineCredits } = await import("../../lib/approvalRule");
  const { creditUsd } = await import("../../lib/creditTerms");
  const line = jobApprovalLineCredits(creditUsd());
  expect(line).toBe(200);
  await runInTenant(workspace("ws_mcppolicy", `file:${path.join(dir, "policy.db")}`), async () => {
    /* No row at all: Ask. */
    expect(await mcpSpendPolicy()).toEqual({ auto: false, lineCredits: line });
    await setSetting("spendWithoutAsking", "auto", "owner");
    expect(await mcpSpendPolicy()).toEqual({ auto: true, lineCredits: line });
    for (const value of ["ask", "", "Auto", "AUTO", " auto", "auto ", "true", "yes", "1", "on", "auto\n"]) {
      await setSetting("spendWithoutAsking", value, "owner");
      expect(await mcpSpendPolicy(), JSON.stringify(value)).toEqual({ auto: false, lineCredits: line });
    }
    /* The line is never above guardrail 4, whatever the setting. */
    await setSetting("spendWithoutAsking", "auto", "owner");
    expect((await mcpSpendPolicy()).lineCredits).toBeLessThanOrEqual(line);
  });
});

test("the setting is read past the memo: a change written by another process (no invalidation here) is the one acted on, both ways", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { allSettings, setSetting } = await import("../../lib/settings");
  const { db } = await import("../../lib/db");
  const { mcpSpendPolicy } = await import("../../lib/mcpSpendPolicy");
  await runInTenant(workspace("ws_mcpmemo", `file:${path.join(dir, "memo.db")}`), async () => {
    await setSetting("spendWithoutAsking", "auto", "owner");
    expect((await allSettings()).spendWithoutAsking).toBe("auto");
    expect((await mcpSpendPolicy()).auto).toBe(true);
    /* Another server process turns it back to Ask: its write only drops its own memo, not this one's. */
    await db().execute({ sql: `UPDATE settings SET value = ? WHERE key = ?`, args: ["ask", "spendWithoutAsking"] });
    /* The memo still says Auto; the policy must not. */
    expect((await allSettings()).spendWithoutAsking).toBe("auto");
    expect((await mcpSpendPolicy()).auto).toBe(false);
    /* And the other way: Ask to Auto elsewhere is read now too (the memo is no reason to refuse a standing choice). */
    await db().execute({ sql: `UPDATE settings SET value = ? WHERE key = ?`, args: ["auto", "spendWithoutAsking"] });
    expect((await mcpSpendPolicy()).auto).toBe(true);
  });
});

test("a database that cannot be read is Ask with a zero line: nothing can start", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { mcpSpendPolicy } = await import("../../lib/mcpSpendPolicy");
  /* A directory where the database file should be: it cannot be opened, so the read throws. */
  const unreadable = `file:${dir}`;
  await runInTenant(workspace("ws_mcpbroken", unreadable), async () => {
    expect(await mcpSpendPolicy()).toEqual({ auto: false, lineCredits: 0 });
  });
});
