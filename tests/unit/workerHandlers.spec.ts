import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkerEvent } from "../../lib/dispatch";
import type { Job, Produced } from "../../lib/renderWork";
const dir = mkdtempSync(path.join(tmpdir(), "particl-worker-handlers-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

async function workspace(id: string) {
  const { platformDb, platformReady, getWorkspace } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,owner_id,legacy,created_at,updated_at) VALUES(?,?,?,?,?,0,0,0)",
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`, "u_test"],
  });
  return (await getWorkspace(id))!;
}

const stillJob = (genId: string): Job =>
  ({ genId, kind: "image", modelId: "fixture", startedAt: Date.now(), references: [], size: "1K" }) as unknown as Job;
const produced: Produced = { kind: "image", storedUrl: "local.png", bytes: 1, cost: 0.01, tokens: 1, via: "google", timings: { queueMs: 0, engineMs: 0, storeMs: 0 } } as Produced;

test("native development runs phases until the wall-time budget, then hands off exactly once with the phase-keyed id", async () => {
  const ws = await workspace("ws_dev_handler");
  const { handleDevelopment } = await import("../../lib/worker-handlers");
  const data = { jobId: "wb_development_0123abcd-0000-4000-8000-000000000001", owner: "u_test", workspaceId: ws.id };
  let now = 0, steps = 0;
  const dispatched: WorkerEvent[] = [];
  const deps = {
    getWorkspace: async () => ws,
    runStep: async () => { steps++; now += 100_000; return { done: false, waiting: false }; },
    nextPhase: async () => 7,
    dispatch: async (event: WorkerEvent) => { dispatched.push(event); return true; },
    clock: () => now,
  };
  expect(await handleDevelopment(data, deps)).toEqual({ jobId: data.jobId, continued: true });
  // 0 s, 100 s, 200 s ran; at 300 s the budget (240 s) is spent and the rest is re-dispatched.
  expect(steps).toBe(3);
  expect(dispatched).toEqual([{ id: `development-${data.jobId}-phase-7`, name: "workbench/development.requested", data }]);

  // Done, waiting and settlement-pending each stop without a hand-off.
  for (const [result, expected] of [
    [{ done: true, waiting: false }, { jobId: data.jobId, complete: true }],
    [{ done: false, waiting: true }, { jobId: data.jobId, waitingForExistingClaim: true }],
    [{ done: false, waiting: false, settlementPending: true }, { jobId: data.jobId, settlementPending: true }],
  ] as const) {
    now = 0;
    expect(await handleDevelopment(data, { ...deps, runStep: async () => result })).toEqual(expected);
  }
  expect(dispatched).toHaveLength(1);
  // A refused hand-off is loud, so the saved job is resumed rather than silently stalled.
  now = 0;
  await expect(handleDevelopment(data, { ...deps, dispatch: async () => false })).rejects.toThrow(/could not be dispatched/);
  await expect(handleDevelopment({ ...data, jobId: "not-a-job" }, deps)).rejects.toThrow(/Invalid development/);
});

test("native render is single-attempt: a thrown produce fails the row with its message", async () => {
  const ws = await workspace("ws_render_fail");
  const { handleRender } = await import("../../lib/worker-handlers");
  const failed: { genId: string; message: string }[] = [];
  let produces = 0;
  const data = { genId: "gen_fail", kind: "image" as const, workspaceId: ws.id };
  await expect(
    handleRender(data, {
      workspaceOf: async () => ws,
      ready: async () => undefined,
      loadJob: async () => stillJob("gen_fail"),
      produce: async () => { produces++; throw new Error("Vendor refused the request."); },
      seal: async () => { throw new Error("must not seal"); },
      failJob: async (genId, message) => { failed.push({ genId, message }); },
    }),
  ).rejects.toThrow("Vendor refused the request.");
  expect(produces).toBe(1);
  expect(failed).toEqual([{ genId: "gen_fail", message: "Vendor refused the request." }]);
  // A terminal or missing row is skipped without paying or failing anything.
  expect(await handleRender(data, { workspaceOf: async () => ws, ready: async () => undefined, loadJob: async () => null, produce: async () => { throw new Error("unreachable"); } })).toEqual({ genId: "gen_fail", skipped: true });
  // Video: a thrown submission ends the dispatch, not the still path.
  const videoFailed: string[] = [];
  await expect(handleRender({ ...data, genId: "gen_video", kind: "video" }, {
    workspaceOf: async () => ws, ready: async () => undefined,
    submitVideoRow: async () => { throw new Error("Provider unreachable."); },
    failVideoDispatch: async (genId) => { videoFailed.push(genId); },
    failJob: async () => { throw new Error("wrong path"); },
  })).rejects.toThrow("Provider unreachable.");
  expect(videoFailed).toEqual(["gen_video"]);
});

test("a seal failure after a paid produce never re-runs produce, does not fail the row, and marks it for the cron to seal", async () => {
  const ws = await workspace("ws_render_seal");
  const { handleRender } = await import("../../lib/worker-handlers");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind) VALUES('gen_seal','fixture','p',?,'running',1,1,'image')",
      args: [JSON.stringify({ paidClaim: 1, producedOutcome: produced })],
    });
  });
  let produces = 0, fails = 0;
  await expect(
    handleRender({ genId: "gen_seal", kind: "image", workspaceId: ws.id }, {
      workspaceOf: async () => ws,
      ready: async () => undefined,
      loadJob: async () => stillJob("gen_seal"),
      produce: async () => { produces++; return produced; },
      seal: async () => { throw new Error("Ledger write lost https://db.example/?token=SECRET"); },
      failJob: async () => { fails++; },
    }),
  ).rejects.toThrow(/Ledger write lost/);
  expect(produces).toBe(1);
  expect(fails).toBe(0);
  await runInTenant(ws, async () => {
    const row = (await db().execute("SELECT status,params FROM generations WHERE id='gen_seal'")).rows[0];
    expect(row.status).toBe("running");
    const params = JSON.parse(String(row.params));
    expect(params.sealFailed).toContain("Ledger write lost");
    expect(params.producedOutcome).toEqual(produced);
    expect(params.paidClaim).toBe(1);
  });
});

test("a dubbing event advances its job inside the tenant, routes by name, and refuses a malformed id", async () => {
  const ws = await workspace("ws_dubbing_handler");
  const { handleDubbing, runWorkerHandler, workerJobId } = await import("../../lib/worker-handlers");
  const { EVENTS, WORKER_EVENT_NAMES } = await import("../../lib/dispatch");
  const { currentTenant } = await import("../../lib/tenant");
  expect(EVENTS.dubbing).toBe("audio/dubbing.requested");
  expect(WORKER_EVENT_NAMES).toContain(EVENTS.dubbing);
  const jobId = "dub_" + "a".repeat(32);
  const event: WorkerEvent = { id: `dubbing-${jobId}`, name: EVENTS.dubbing, data: { jobId, workspaceId: ws.id } };
  expect(workerJobId(event)).toBe(jobId);
  const advanced: { id: string; tenant: string | undefined }[] = [];
  const deps = { workspaceOf: async () => ws, advance: async (id: string) => { advanced.push({ id, tenant: currentTenant()?.workspace?.id }); return null; } };
  expect(await handleDubbing({ jobId, workspaceId: ws.id }, deps)).toEqual({ jobId, status: "missing" });
  expect(advanced).toEqual([{ id: jobId, tenant: ws.id }]);
  await expect(handleDubbing({ jobId: "not-a-dub", workspaceId: ws.id }, deps)).rejects.toThrow(/Invalid dubbing/);
  // The switch reaches the real handler; a missing row is a no-op, never a submission.
  expect(await runWorkerHandler(event)).toEqual({ jobId, status: "missing" });
});

