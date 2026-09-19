import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-dispatch-log-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

/** The log lives in whichever disposable platform database this worker process already opened. */
async function platform() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute("DELETE FROM dispatch_log");
  return platformDb();
}

test("the platform bootstrap creates dispatch_log with its created_at index", async () => {
  const db = await platform();
  const columns = (await db.execute("PRAGMA table_info(dispatch_log)")).rows.map((r) => String(r.name));
  expect(columns).toEqual(["id", "event_id", "name", "phase", "outcome", "status", "duration_ms", "workspace_id", "created_at"]);
  const indexes = (await db.execute("PRAGMA index_list(dispatch_log)")).rows.map((r) => String(r.name));
  expect(indexes).toContain("idx_dispatch_log_created");
});

test("recordDispatch writes identifiers and outcomes only, recentDispatches answers newest first within the limit", async () => {
  await platform();
  const { recordDispatch, recentDispatches, DISPATCH_LOG_RECENT_LIMIT } = await import("../../lib/dispatch-log");
  expect(DISPATCH_LOG_RECENT_LIMIT).toBe(10);
  let at = 1_000_000;
  const clock = () => at;
  expect(await recordDispatch({ eventId: "render-ws_1-gen_1", name: "render/requested", phase: "send", outcome: "sent", status: 202, durationMs: 41.6, workspaceId: "ws_1" }, { clock })).toBe(true);
  at += 10;
  expect(await recordDispatch({ eventId: "render-ws_1-gen_1", name: "render/requested", phase: "run", outcome: "finished-ok", durationMs: 1234, workspaceId: "ws_1" }, { clock })).toBe(true);
  at += 10;
  expect(await recordDispatch({ eventId: "probe-1", name: "worker/probe", phase: "run", outcome: "busy" }, { clock })).toBe(true);
  const rows = await recentDispatches();
  expect(rows.map((r) => [r.phase, r.outcome])).toEqual([["run", "busy"], ["run", "finished-ok"], ["send", "sent"]]);
  expect(rows[2]).toMatchObject({ eventId: "render-ws_1-gen_1", name: "render/requested", status: 202, durationMs: 42, workspaceId: "ws_1", createdAt: 1_000_000 });
  expect(rows[1]).toMatchObject({ status: null, durationMs: 1234, workspaceId: "ws_1" });
  expect(rows[0]).toMatchObject({ status: null, durationMs: null, workspaceId: null });
  expect(rows.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
  expect(await recentDispatches(2)).toHaveLength(2);
  expect((await recentDispatches(1))[0].outcome).toBe("busy");
  // The default is the health page's ten.
  for (let n = 0; n < 12; n++) { at += 1; await recordDispatch({ eventId: `e${n}`, name: "worker/probe", phase: "send", outcome: "refused", status: 401 }, { clock }); }
  expect(await recentDispatches()).toHaveLength(10);
});

test("writes prune rows past the seven-day retention, a bounded batch at a time, and never throw when the platform is unavailable", async () => {
  const db = await platform();
  const { recordDispatch, recentDispatches, DISPATCH_LOG_RETENTION_MS, DISPATCH_LOG_PRUNE_BATCH } = await import("../../lib/dispatch-log");
  expect(DISPATCH_LOG_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  let at = 10_000_000;
  const clock = () => at;
  // Old rows, more than one prune batch of them, plus one that is exactly within the window.
  const stale = DISPATCH_LOG_PRUNE_BATCH + 5;
  for (let n = 0; n < stale; n++) await recordDispatch({ eventId: `old${n}`, name: "worker/probe", phase: "send", outcome: "sent", status: 202 }, { clock });
  at += DISPATCH_LOG_RETENTION_MS; // the "old" rows are now exactly retention old: kept (created_at < cutoff is strict)
  await recordDispatch({ eventId: "edge", name: "worker/probe", phase: "send", outcome: "sent", status: 202 }, { clock });
  const count = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM dispatch_log")).rows[0].n);
  expect(await count()).toBe(stale + 1);
  at += 1; // now every "old" row is past retention; one write prunes one batch of them
  await recordDispatch({ eventId: "new1", name: "worker/probe", phase: "run", outcome: "finished-ok" }, { clock });
  expect(await count()).toBe(stale + 2 - DISPATCH_LOG_PRUNE_BATCH);
  await recordDispatch({ eventId: "new2", name: "worker/probe", phase: "run", outcome: "finished-ok" }, { clock });
  expect(await count()).toBe(3); // edge, new1, new2 — the remaining five stale rows went with the second write
  expect((await recentDispatches()).map((r) => r.eventId)).toEqual(["new2", "new1", "edge"]);
  // A platform that cannot be reached: false, not a throw — and a read that throws stays a throw for the caller to handle.
  const unavailable = async () => { throw new Error("SECRET_DATABASE_URL"); };
  await expect(recordDispatch({ eventId: "x", name: "worker/probe", phase: "send", outcome: "failed" }, { platform: unavailable })).resolves.toBe(false);
  await expect(recentDispatches(10, { platform: unavailable })).rejects.toThrow();
  expect(await count()).toBe(3);
});
