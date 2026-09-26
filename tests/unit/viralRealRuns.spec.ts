import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerJobStatus, ConsumerWorkflow, CreateConsumerJob } from "../../lib/higgsfield-consumer/jobs";
import { RUN_STATUS, mergeRuns, runInFlight, runStatus } from "../../lib/shell/viral";

/**
 * Viral's Recent and History list real runs only (idea 17): an estimate is
 * never a run, pages go by cursor, and every job still awaiting
 * reconciliation rides on the first page however old it is. The ledger
 * itself keeps every quote.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-viral-runs-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-viral-runs-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
function workspace(): TenantWorkspace {
  const name = `runs-${++sequence}`;
  return {
    id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
}
const owner = { userId: "owner", draftId: "draft" };
async function modules() {
  return {
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
  };
}
async function inTenant<T>(run: (m: Awaited<ReturnType<typeof modules>>) => Promise<T>) {
  const m = await modules();
  return m.tenant.runInTenant(workspace(), async () => {
    await m.database.ready();
    for (const [userId, draftId] of [[owner.userId, owner.draftId], [owner.userId, "other-draft"], ["someone-else", owner.draftId]])
      await m.database.db().execute({
        sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
        args: [`${userId}-${draftId}`, userId, draftId, "Test draft", JSON.stringify({ assets: [{ id: "product-original" }] }), Date.now()],
      });
    return run(m);
  });
}
/** One ledger row in the given state, created at the given moment (test setup writes the row directly). */
async function row(
  m: Awaited<ReturnType<typeof modules>>,
  status: ConsumerJobStatus,
  createdAt: number,
  scope: { userId?: string; draftId?: string; workflow?: ConsumerWorkflow } = {},
) {
  const input: CreateConsumerJob = {
    userId: scope.userId ?? owner.userId, draftId: scope.draftId ?? owner.draftId, connectedOwnerId: "connected-owner",
    connectionGeneration: randomUUID(), workflow: scope.workflow ?? "marketing-video", idempotencyKey: randomUUID(),
    payload: { params: { prompt: "Bottle on a stone plinth" } }, quoteCredits: 12, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: ["product-original"],
  };
  const { job } = await m.jobs.createConsumerJob(input);
  await m.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET status=?, created_at=? WHERE id=?", args: [status, createdAt, job.id] });
  return job.id;
}

test("runs leave estimates out, page by cursor, and keep an old paid job on the first page", async () => {
  await inTenant(async (m) => {
    const t = 1_700_000_000_000;
    const stuck = await row(m, "accepted", t);            // sent long ago, still rendering
    const failed = await row(m, "failed", t + 1_000);
    const done = [];
    for (let i = 0; i < 5; i++) done.push(await row(m, "completed", t + 10_000 + i * 1_000));
    /* Thirty estimates, all newer than every run: before, they filled the window. */
    for (let i = 0; i < 30; i++) await row(m, "quoted", t + 100_000 + i);
    await row(m, "completed", t + 200_000, { workflow: "virality" });
    await row(m, "completed", t + 200_000, { draftId: "other-draft" });
    await row(m, "completed", t + 200_000, { userId: "someone-else" });

    const first = await m.jobs.listConsumerRuns({ ...owner, workflow: "marketing-video", limit: 3 });
    expect(first.items.map((j) => j.id)).toEqual([done[4], done[3], done[2], stuck]);
    expect(first.items.every((j) => j.status !== "quoted")).toBe(true);
    expect(first.nextCursor).toEqual({ createdAt: t + 12_000, id: done[2] });

    const second = await m.jobs.listConsumerRuns({ ...owner, workflow: "marketing-video", limit: 3, before: first.nextCursor! });
    expect(second.items.map((j) => j.id)).toEqual([done[1], done[0], failed]);
    const third = await m.jobs.listConsumerRuns({ ...owner, workflow: "marketing-video", limit: 3, before: second.nextCursor! });
    /* A later page may repeat the pinned job; the browser keeps one row per job. */
    expect(third.items.map((j) => j.id)).toEqual([stuck]);
    expect(third.nextCursor).toBeNull();

    /* Nothing is deleted: every estimate is still in the ledger. */
    const ledger = await m.jobs.listConsumerJobs({ ...owner, limit: 50 });
    expect(ledger.items.filter((j) => j.status === "quoted")).toHaveLength(30);

    /* Other workflows, projects and people never appear. */
    expect((await m.jobs.listConsumerRuns({ ...owner, workflow: "virality" })).items).toHaveLength(1);
    expect((await m.jobs.listConsumerRuns({ ...owner, draftId: "other-draft", workflow: "marketing-video" })).items).toHaveLength(1);
    expect((await m.jobs.listConsumerRuns({ userId: "someone-else", draftId: owner.draftId, workflow: "marketing-video" })).items).toHaveLength(1);

    await expect(m.jobs.listConsumerRuns({ ...owner, workflow: "marketing-video", limit: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(m.jobs.listConsumerRuns({ ...owner, workflow: "not-a-workflow" as ConsumerWorkflow })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

test("another workspace never sees these runs", async () => {
  const id = await inTenant(async (m) => {
    const made = await row(m, "completed", Date.now());
    expect((await m.jobs.listConsumerRuns({ ...owner, workflow: "marketing-video" })).items.map((j) => j.id)).toEqual([made]);
    return made;
  });
  await inTenant(async (m) => {
    const listed = await m.jobs.listConsumerRuns({ ...owner, workflow: "marketing-video" });
    expect(listed.items.map((j) => j.id)).not.toContain(id);
    expect(listed.items).toEqual([]);
  });
});

test("a run cursor is one opaque value that round-trips and refuses anything else", async () => {
  const { jobs } = await modules();
  const cursor = { createdAt: 1_700_000_000_123, id: randomUUID() };
  expect(jobs.parseConsumerJobCursor(jobs.formatConsumerJobCursor(cursor))).toEqual(cursor);
  for (const bad of ["", "123", ".abc", "12.ab c", "1e3.abc", "99999999999999999.abc", `12.${"a".repeat(201)}`, "12.abc;drop"])
  {
    let code: unknown = null;
    try { jobs.parseConsumerJobCursor(bad); } catch (error) { code = (error as { code?: string }).code; }
    expect(code, bad).toBe("invalid_input");
  }
});

test("every status reads as words, never the raw code", () => {
  expect(Object.fromEntries(Object.entries(RUN_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
    quoted: "Estimate", dispatching: "Queued", accepted: "Rendering", uncertain: "Checking", failed: "Failed · not billed", completed: "Done",
  });
  expect(runStatus("accepted")).toEqual({ label: "Rendering", tone: "active" });
  expect(runStatus("completed").tone).toBe("done");
  expect(runStatus("failed").tone).toBe("failed");
  /* A state this build does not know yet is still not printed raw. */
  expect(runStatus("reconciling").label).toBe("Checking");
  expect(["dispatching", "accepted", "uncertain"].every(runInFlight)).toBe(true);
  expect(["quoted", "failed", "completed"].some(runInFlight)).toBe(false);
});

test("the browser keeps one row per run, the freshest copy, newest first, and no estimates", () => {
  const job = (id: string, status: string, createdAt: number) => ({ id, status, createdAt });
  const onHand = [job("b", "accepted", 20), job("a", "completed", 10), job("old", "failed", 1)];
  const merged = mergeRuns([job("b", "completed", 20), job("c", "accepted", 30), job("q", "quoted", 40)], onHand);
  expect(merged.map((j) => [j.id, j.status])).toEqual([["c", "accepted"], ["b", "completed"], ["a", "completed"], ["old", "failed"]]);
  /* Equal times fall back to the id, the server's own tiebreak. */
  expect(mergeRuns([job("x", "completed", 5), job("y", "completed", 5)], []).map((j) => j.id)).toEqual(["y", "x"]);
  expect(mergeRuns([], [job("q", "quoted", 1)])).toEqual([]);
});
