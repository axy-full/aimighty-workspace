import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/* The cap on a screen, the 80% warning, the pre-checks and the reservation
   gate read one figure: every take ever made (a hidden take was paid for),
   merged with the meter's own rows. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cap-spend-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const ws: TenantWorkspace = {
  id: "ws_caps", slug: "caps", name: "Caps", legacy: false,
  dbUrl: `file:${path.join(dir, "caps.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};
const SEEDANCE = "dreamina-seedance-2-5-260628";

test("deleted takes, moved takes and metered text count toward a production's and a shot's spend exactly as the gate counts them", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { meter } = await import("../../lib/meter");
  const { projectCap, checkCap, spentBy } = await import("../../lib/caps");
  const { shotCreditsSoFar } = await import("../../lib/shotCap");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('grant_caps',?,500,'manual',0)`,
    args: [ws.id],
  });
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: `INSERT INTO projects(id,name,created_at,cap_credits) VALUES('p1','Rooftop',0,30),('p2','Harbour',0,NULL)` });
    const take = `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,project_id,shot_id,cost_usd,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
    const at = Date.now() - 2 * 3_600_000;
    await db().batch([
      { sql: take, args: ["g_live", SEEDANCE, "live", "{}", "succeeded", at, at, "video", "p1", "s1", 1, 0] },
      // Deleted: hidden from the production, still paid for.
      { sql: take, args: ["g_hidden", SEEDANCE, "hidden", "{}", "succeeded", at, at, "video", "p1", "s1", 0.6, 1] },
      // Moved to p2 after the meter filed it under p1: the meter's production wins.
      { sql: take, args: ["g_moved", SEEDANCE, "moved", "{}", "succeeded", at, at, "video", "p2", null, 0.2, 0] },
    ]);
    await meter({ id: "g_live", kind: "video", engine: "byteplus", model: SEEDANCE, status: "succeeded", engineCostUsd: 1, projectId: "p1", shotId: "s1" });
    await meter({ id: "g_hidden", kind: "video", engine: "byteplus", model: SEEDANCE, status: "succeeded", engineCostUsd: 0.6, projectId: "p1", shotId: "s1" });
    await meter({ id: "g_moved", kind: "video", engine: "byteplus", model: SEEDANCE, status: "succeeded", engineCostUsd: 0.2, projectId: "p1" });
    // Writing for the production: metered, no take of its own.
    await meter({ id: "text_p1", kind: "text", engine: "vercel", model: "test/text", status: "succeeded", engineCostUsd: 0.2, projectId: "p1" });

    const spent = await spentBy("project_id", ["p1", "p2"]);
    expect(spent.get("p1")!.credits).toBe(15 + 9 + 3 + 3);
    expect(spent.get("p1")!.usd).toBeCloseTo(2, 6);
    expect(spent.get("p2")!.credits).toBe(0);
    expect((await projectCap("p1"))!.spent).toBe(30);
    expect(await shotCreditsSoFar("s1")).toBe(24);

    // The pre-check and the gate refuse the same take with the same sentence.
    const pre = await checkCap("p1", 0.1, SEEDANCE);
    expect(pre.allow).toBe(false);
    expect(pre.error).toContain("30 cr spent");
    const gate = await reserveGenerationSpend({ id: "g_next", kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: 0.1, projectId: "p1", createdBy: "owner" })
      .then(() => null, (error: unknown) => error);
    expect(gate).toBeInstanceOf(SpendReservationError);
    expect((gate as Error).message).toBe(pre.error);
  });
});
