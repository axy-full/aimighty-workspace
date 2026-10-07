import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { SIGN_IN_OFF } from "../../lib/higgsfield-consumer/retired";

/**
 * Cinema Studio's time limit (owner's decision, 6 October 2026): a take with no
 * answer from its provider 24 hours after it was sent ends as failed, charged
 * nothing, its hold released, said as "Failed · not charged" and recorded for the
 * platform admin desk. The cron sync runs it as a stage of its own, and every
 * other stage still runs around it, a failing one included. Mocked, local
 * temporary databases only; nothing is sent to any provider.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cinema-hold-timeout-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const CINEMA = "higgsfield-cinema-studio-4.0";
const OWNER = { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null };
const USD = 2;
const HOUR = 3_600_000;

async function workspace(id: string, credits: number) {
  const { platformDb, platformReady, getWorkspace, grantCredits } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  await platformReady(); await billingReady();
  await platformDb().execute({ sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,'owner',1,0,0,20,200)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`] });
  await grantCredits(id, credits, "fixture", "owner", "manual");
  return (await getWorkspace(id))!;
}

test("a take with no answer for 24 hours: failed, charged nothing, its hold back, \"Failed · not charged\", and on the admin desk", async () => {
  const ws = await workspace("timeout_ws", 1_000);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const { db, ready } = await import("../../lib/db");
    await ready();
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { billingStateFor } = await import("../../lib/billingLedger");
    const { platformDb } = await import("../../lib/platform");
    const at = Date.now();
    const params = (extra: Record<string, unknown> = {}) => JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, higgsfieldVendorCostUsd: USD, ...extra });
    const put = async (id: string, sentAgo: number, extra: Record<string, unknown> = {}) => {
      await db().execute({ sql: `INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_by,created_at,updated_at) VALUES(?,'video',?,'A harbour at dawn',?,'running','higgsfield','generate','owner',?,?)`,
        args: [id, CINEMA, params(extra), at - sentAgo, at - sentAgo] });
      await reserveGenerationSpend({ id, kind: "video", engine: "higgsfield", model: CINEMA, status: "running", engineCostUsd: USD }, { holdBand: 3 });
    };
    const before = (await billingStateFor("timeout_ws")).credits.balance;
    await put("t_stale", 25 * HOUR);
    await put("t_fresh", 23 * HOUR);
    /* Its collector holds the lease right now: its answer may be arriving, so it is not cut off. */
    await put("t_collecting", 30 * HOUR, { higgsfieldVideoPollUntil: at + 60_000, higgsfieldVideoPollToken: "lease" });
    const held = before - (await billingStateFor("timeout_ws")).credits.balance;
    const { expireUnansweredCinemaTakes, CINEMA_UNANSWERED } = await import("../../lib/genjutsuVideo");
    expect(await expireUnansweredCinemaTakes({ at })).toEqual({ expired: ["t_stale"] });
    /* Once is enough: a second pass finds nothing more. */
    expect(await expireUnansweredCinemaTakes({ at })).toEqual({ expired: [] });
    const row = async (id: string) => (await db().execute({ sql: "SELECT status,error FROM generations WHERE id=?", args: [id] })).rows[0];
    expect(await row("t_stale")).toMatchObject({ status: "failed", error: CINEMA_UNANSWERED });
    expect(await row("t_fresh")).toMatchObject({ status: "running" });
    expect(await row("t_collecting")).toMatchObject({ status: "running" });
    const meterOf = async (id: string) => (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
    expect(await meterOf("t_stale")).toMatchObject({ status: "failed", billed_credits: 0 });
    /* Its whole hold is back: the balance is down only by the two still running. */
    expect(before - (await billingStateFor("timeout_ws")).credits.balance).toBe((held / 3) * 2);
    /* The person reads "Failed · not charged"; the platform admin desk reads the record. */
    const { getGeneration } = await import("../../lib/jobs");
    const { withLedgerCharges } = await import("../../lib/usageLedger");
    const { failedChip, failureLine } = await import("../../lib/errors");
    const [gen] = await withLedgerCharges([(await getGeneration("t_stale"))!]);
    expect(failedChip(gen.failure)).toBe("Failed · not charged");
    expect(failureLine(gen.failure!).charge).toBe("Not charged");
    expect(JSON.stringify(gen)).not.toMatch(/overrun|engine_cost/i);
    const { engineTrayJob } = await import("../../lib/jobsTray");
    expect(engineTrayJob({ ...gen, settledAt: gen.settledAt ?? null }, { unit: "cr", reserved: null, charged: 0, needs: null }).label).toBe("Failed · not charged");
    const { providerFailuresSince } = await import("../../lib/meter");
    expect((await providerFailuresSince(0, 100)).recent.find((r) => r.id === "t_stale")).toMatchObject({ engine: "higgsfield", kind: "no_answer", message: CINEMA_UNANSWERED });
  }, { user: OWNER } as never);
});

/* ── The cron sync: the new stage runs among the others, and a failing stage stops none of them ── */
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    throw new Error(`The cron test must mock ${name}`);
  }, target, target.exports);
  return target.exports as T;
}

async function cron(failing: string | null) {
  const ran: string[] = [];
  const settings: Record<string, string> = {};
  const step = (name: string, value: unknown = {}) => async () => { ran.push(name); if (name === failing) throw new Error("stage failed"); return value; };
  const route = load<{ GET(req: Request): Promise<Response> }>("app/api/cron/sync/route.ts", {
    "@/lib/recovery": { recoveryFence: () => ({ status: async () => ({ state: "open" }) }), recoveryRoute: (h: () => Promise<Response>) => h, reserveRecoveryContinuation: async (_: string, fn: unknown) => fn },
    "@/lib/recoveryDrain": { drainRecoveryJobs: async () => ({}), RECOVERY_DRAIN_WORK_BUDGET_MS: 1 },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) }, after: () => {} },
    "@/lib/db": { db: () => ({ execute: async () => ({ rows: [{ pending: 0, atrisk: 0 }] }) }), ready: async () => {} },
    "@/lib/jobs": { syncPending: step("generations", { failed: 0, deferred: 0 }) },
    "@/lib/identities": { syncTrainingIdentities: step("training", { failed: 0 }) },
    "@/lib/soulIdentities": { syncSoulIdentities: step("soul_training", { failed: 0 }) },
    "@/lib/storageCost": { backfillSizes: step("storage_sizes") },
    "@/lib/settings": { setSetting: async (key: string, value: string) => { settings[key] = value; } },
    "@/lib/platform": { getWorkspace: async () => ({ id: "cron_ws", deletedAt: null }), platformDb: () => ({}), platformReady: async () => {} },
    "@/lib/tenant": { runInTenant: (_: unknown, fn: () => Promise<unknown>) => fn() },
    "@/lib/held": { releaseHeldJobs: step("held_jobs") },
    "@/lib/purge": { retireDeletedWorkspaces: async () => {} },
    "@/lib/reconciliation": { reconcileWorkspaces: async (o: { visit: (id: string, deadlineAt: number) => Promise<{ failed: boolean }> }) => {
      const r = await o.visit("cron_ws", Date.now() + 60_000); return { ok: !r.failed, visited: 1 }; } },
    "@/lib/uploadReservations": { cleanupExpiredUploads: step("expired_uploads", {}) },
    "@/lib/pipeline/executor": { drainPipelineWakeups: step("pipelines", { failed: 0 }) },
    "@/lib/higgsfield-consumer/sweep": { sweepConsumerJobs: step("connected_jobs", { deferred: false }) },
    "@/lib/higgsfield-consumer/retired": { SIGN_IN_OFF },
    "@/lib/workbench/canvas-push": { drainCanvasPushes: step("canvas_pushes") },
    "@/lib/workbench/rig-agent": { drainRigAgentWakeups: step("rig_agents") },
    "@/lib/genjutsuVideo": { expireUnansweredCinemaTakes: step("cinema_unanswered", { expired: [] }) },
  });
  const reply = await route.GET(new Request("http://localhost/api/cron/sync"));
  return { ran, settings, status: reply.status };
}

test("the cron sync runs the time limit as a stage of its own, before held takes, and every other stage still runs", async () => {
  /* Connected-account jobs are swept only while the Higgsfield sign-in is on (off for Release 1). */
  const all = ["generations", "pipelines", "training", "soul_training", ...(SIGN_IN_OFF ? [] : ["connected_jobs"]), "canvas_pushes", "rig_agents", "storage_sizes", "expired_uploads", "cinema_unanswered", "held_jobs"];
  const ok = await cron(null);
  expect(ok.ran).toEqual(all);
  expect(ok.status).toBe(200);
  expect(ok.settings.lastCronStatus).toBe("succeeded");
  /* The new stage failing stops nothing: the rest run, and the visit says it failed. */
  const failing = await cron("cinema_unanswered");
  expect(failing.ran).toEqual(all);
  expect(failing.settings.lastCronStatus).toBe("failed");
  /* Nor does an earlier stage failing stop the new one. */
  expect((await cron("generations")).ran).toEqual(all);
});
