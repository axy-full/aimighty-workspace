import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-worker-slots-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

/** Slots live in whichever disposable platform database this worker process already opened. */
async function platform() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute("DELETE FROM worker_slots");
  return platformDb();
}

test("worker slots enforce four platform-wide and two per workspace, refuse a running job, and free on release or expiry", async () => {
  await platform();
  const { acquireSlot, releaseSlot, liveSlots, WORKER_SLOT_LIMIT, WORKER_SLOT_WORKSPACE_LIMIT } = await import("../../lib/worker-slots");
  expect([WORKER_SLOT_LIMIT, WORKER_SLOT_WORKSPACE_LIMIT]).toEqual([4, 2]);
  let at = 1_000_000;
  const clock = () => at;
  const kind = "render/requested";
  const a1 = await acquireSlot({ kind, workspaceId: "ws_a", jobId: "job_a1" }, { clock });
  const a2 = await acquireSlot({ kind, workspaceId: "ws_a", jobId: "job_a2" }, { clock });
  expect(a1 && a2).toBeTruthy();
  // Per-workspace ceiling: a third for ws_a is refused while the platform still has room.
  expect(await acquireSlot({ kind, workspaceId: "ws_a", jobId: "job_a3" }, { clock })).toBeNull();
  // The same job again is "already running", not a second slot.
  expect(await acquireSlot({ kind, workspaceId: "ws_b", jobId: "job_a1" }, { clock })).toBeNull();
  const b1 = await acquireSlot({ kind, workspaceId: "ws_b", jobId: "job_b1" }, { clock });
  const c1 = await acquireSlot({ kind, workspaceId: "ws_c", jobId: "job_c1" }, { clock });
  expect(b1 && c1).toBeTruthy();
  // Platform ceiling: four live, a fifth workspace is refused.
  expect(await acquireSlot({ kind, workspaceId: "ws_d", jobId: "job_d1" }, { clock })).toBeNull();
  // Another kind has its own ceiling.
  expect(await acquireSlot({ kind: "astra-blender/render.requested", workspaceId: "ws_d", jobId: "astra_d1" }, { clock })).not.toBeNull();
  expect((await liveSlots({ clock })).map((s) => s.jobId).sort()).toEqual(["astra_d1", "job_a1", "job_a2", "job_b1", "job_c1"]);
  // Release frees exactly that slot.
  await releaseSlot(b1!.id);
  expect(await acquireSlot({ kind, workspaceId: "ws_d", jobId: "job_d1" }, { clock })).not.toBeNull();
  expect(await acquireSlot({ kind, workspaceId: "ws_e", jobId: "job_e1" }, { clock })).toBeNull();
  // A crashed function's slot expires with its TTL instead of leaking.
  at += 330_001;
  expect(await liveSlots({ clock })).toEqual([]);
  expect(await acquireSlot({ kind, workspaceId: "ws_a", jobId: "job_a1" }, { clock })).not.toBeNull();
  expect(await acquireSlot({ kind, workspaceId: "ws_e", jobId: "job_e1" }, { clock })).not.toBeNull();
  // Concurrent acquisitions serialise: exactly two of five parallel ws_f requests win.
  const race = await Promise.all([1, 2, 3, 4, 5].map((n) => acquireSlot({ kind: "worker/probe", workspaceId: "ws_f", jobId: `probe_${n}` }, { clock })));
  expect(race.filter(Boolean)).toHaveLength(2);
});

test("after a release the chain offers the freed slot to exactly one queued job of the same kind and workspace, best-effort", async () => {
  const db = await platform();
  const { getWorkspace } = await import("../../lib/platform");
  const { chainDispatch } = await import("../../lib/worker-slots");
  await db.execute({
    sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,owner_id,legacy,created_at,updated_at) VALUES(?,?,?,?,?,0,0,0)",
    args: ["ws_chain", "ws_chain", "Chain", `file:${path.join(dir, "ws_chain.db")}`, "u_test"],
  });
  expect(await getWorkspace("ws_chain")).toBeTruthy();
  const found: string[] = [], enqueued: { kind: string; jobId: string }[] = [];
  const deps = {
    findQueued: async (kind: string) => { found.push(kind); return "gen_queued"; },
    enqueue: async (kind: string, jobId: string) => { enqueued.push({ kind, jobId }); return true; },
  };
  expect(await chainDispatch({ kind: "render/requested", workspaceId: "ws_chain" }, deps)).toBe(true);
  expect(found).toEqual(["render/requested"]);
  expect(enqueued).toEqual([{ kind: "render/requested", jobId: "gen_queued" }]);
  // Nothing queued: no enqueue.
  expect(await chainDispatch({ kind: "astra-blender/render.requested", workspaceId: "ws_chain" }, { ...deps, findQueued: async () => null })).toBe(false);
  expect(enqueued).toHaveLength(1);
  // Only render and Astra chain; a probe or development event never does.
  expect(await chainDispatch({ kind: "worker/probe", workspaceId: "ws_chain" }, deps)).toBe(false);
  expect(await chainDispatch({ kind: "workbench/development.requested", workspaceId: "ws_chain" }, deps)).toBe(false);
  expect(found).toHaveLength(1);
  // Unknown workspace and a throwing lookup both answer false, never throw.
  expect(await chainDispatch({ kind: "render/requested", workspaceId: "ws_missing" }, deps)).toBe(false);
  expect(await chainDispatch({ kind: "render/requested", workspaceId: "ws_chain" }, { ...deps, findQueued: async () => { throw new Error("SECRET"); } })).toBe(false);
  // The real default lookup runs against an empty tenant database without error.
  expect(await chainDispatch({ kind: "render/requested", workspaceId: "ws_chain" })).toBe(false);
  expect(await chainDispatch({ kind: "astra-blender/render.requested", workspaceId: "ws_chain" })).toBe(false);
});
