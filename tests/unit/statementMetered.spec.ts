import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/* A statement lists every credit the balance lost that month — including
   metered work that has no take of its own (a transcription, an Astra
   render) — and nothing twice. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-statement-metered-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const ws: TenantWorkspace = {
  id: "ws_statement", slug: "statement", name: "Statement", legacy: false,
  dbUrl: `file:${path.join(dir, "statement.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};

test("transcription and Astra renders are statement lines, and a take's meter row is never listed twice", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { meter } = await import("../../lib/meter");
  const { statementFor, monthOf, monthRange, statementCsv } = await import("../../lib/statements");
  const { GROK_STT_MODEL } = await import("../../lib/xaiVoice");
  const { ASTRA_COMPUTE_MODEL } = await import("../../lib/astra-blender/render-pricing");
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES('grant_statement',?,500,'manual',0)`,
    args: [ws.id],
  });
  const month = monthOf(Date.now());
  const earlier = monthRange(month)!.from - 60_000;
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: `INSERT INTO projects(id,name,created_at) VALUES('p1','Rooftop',0)` });
    const take = `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,project_id,cost_usd) VALUES(?,?,?,?,?,?,?,?,?,?)`;
    await db().execute({ sql: take, args: ["g1", "dreamina-seedance-2-5-260628", "a rooftop", "{}", "succeeded", Date.now(), Date.now(), "video", "p1", 1] });
    // A take made last month whose meter row landed this month: it belongs to last month's statement.
    await db().execute({ sql: take, args: ["g_edge", "dreamina-seedance-2-5-260628", "an edge", "{}", "succeeded", earlier, earlier, "video", "p1", 1] });
    await meter({ id: "g1", kind: "video", engine: "byteplus", model: "dreamina-seedance-2-5-260628", status: "succeeded", engineCostUsd: 1, projectId: "p1" });
    await meter({ id: "g_edge", kind: "video", engine: "byteplus", model: "dreamina-seedance-2-5-260628", status: "succeeded", engineCostUsd: 1, projectId: "p1" });
    await meter({ id: "stt_1", kind: "audio", engine: "xai", model: GROK_STT_MODEL, status: "succeeded", engineCostUsd: 0.2, projectId: "p1" });
    await meter({ id: "astra_1", kind: "image", engine: "vercel-sandbox", model: ASTRA_COMPUTE_MODEL, status: "succeeded", engineCostUsd: 0.5, projectId: "p1" });
    await meter({ id: "text_1", kind: "text", engine: "vercel", model: "test/text", status: "succeeded", engineCostUsd: 0.01, projectId: "p1" });

    const s = (await statementFor(month, null))!;
    const lines = s.projects.flatMap((p) => [...p.shots.flatMap((sh) => sh.lines), ...p.loose]);
    expect(lines.map((l) => l.id).sort()).toEqual(["astra_1", "g1", "stt_1", "text_1"]);
    const byId = new Map(lines.map((l) => [l.id, l]));
    expect(byId.get("g1")!.credits).toBe(15);
    expect(byId.get("stt_1")).toMatchObject({ credits: 3, take: "Transcript", what: "Transcription", kind: "audio" });
    expect(byId.get("astra_1")).toMatchObject({ credits: 8, take: "Astra", what: "Astra render", kind: "image" });
    expect(byId.get("text_1")!.credits).toBe(1);
    expect(s.totals.credits).toBe(27);
    // The funding split covers the same credits the total does.
    expect(Object.values(s.funding!).reduce((a, b) => a + b, 0)).toBe(27);
    expect(statementCsv(s)).toContain("Transcription");

    // One production: the same metered lines, filed under it.
    const one = (await statementFor(month, "p1"))!;
    expect(one.totals.credits).toBe(27);
    expect(one.projects.map((p) => p.name)).toEqual(["Rooftop"]);
  });
});
