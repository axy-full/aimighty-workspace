import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerJobStatus, ConsumerWorkflow, CreateConsumerJob } from "../../lib/higgsfield-consumer/jobs";
import { INITIAL_VIRAL, RUN_STATUS, mergeRuns, originalNote, runCannotSettle, runInFlight, runStatus, viralBlock } from "../../lib/shell/viral";

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
  scope: { userId?: string; draftId?: string; workflow?: ConsumerWorkflow; variant?: string } = {},
) {
  const input: CreateConsumerJob = {
    userId: scope.userId ?? owner.userId, draftId: scope.draftId ?? owner.draftId, connectedOwnerId: "connected-owner",
    connectionGeneration: randomUUID(), workflow: scope.variant ? "marketing-video" : scope.workflow ?? "marketing-video", idempotencyKey: randomUUID(),
    payload: { params: { prompt: "Bottle on a stone plinth" }, ...(scope.variant ? { input: { variant: scope.variant } } : {}) },
    quoteCredits: 12, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: ["product-original"],
  };
  const { job } = await m.jobs.createConsumerJob(input);
  /* A variant's row is written as the Genjutsu run it stands for, without the source checks a real quote passes. */
  await m.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET status=?, created_at=?, workflow=? WHERE id=?", args: [status, createdAt, scope.workflow ?? "marketing-video", job.id] });
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

test("a variant narrows the runs to one page's own, the in-flight pin included", async () => {
  await inTenant(async (m) => {
    const t = 1_700_000_000_000;
    const swaps = [];
    for (let i = 0; i < 6; i++) swaps.push(await row(m, "completed", t + 10_000 + i, { workflow: "genjutsu", variant: "object-swap" }));
    const motion = await row(m, "completed", t, { workflow: "genjutsu", variant: "motion-transfer" });
    const stuck = await row(m, "accepted", t - 50_000, { workflow: "genjutsu", variant: "motion-transfer" });
    await row(m, "accepted", t - 60_000, { workflow: "genjutsu", variant: "object-swap" });
    await row(m, "quoted", t + 90_000, { workflow: "genjutsu", variant: "motion-transfer" });
    /* The newest page of every run is all Object Swap; Motion Transfer's own list still finds its runs. */
    const all = await m.jobs.listConsumerRuns({ ...owner, workflow: "genjutsu", limit: 3 });
    expect(all.items.slice(0, 3).map((j) => j.id)).toEqual([swaps[5], swaps[4], swaps[3]]);
    const mine = await m.jobs.listConsumerRuns({ ...owner, workflow: "genjutsu", limit: 3, variant: "motion-transfer" });
    expect(mine.items.map((j) => j.id)).toEqual([motion, stuck]);
    expect(mine.nextCursor).toBeNull();
    const theirs = await m.jobs.listConsumerRuns({ ...owner, workflow: "genjutsu", limit: 3, variant: "object-swap" });
    expect(theirs.items.slice(0, 3).map((j) => j.id)).toEqual([swaps[5], swaps[4], swaps[3]]);
    expect(theirs.items).toHaveLength(4);
    for (const bad of ["", "Object-Swap", "x".repeat(41), "swap'--"])
      await expect(m.jobs.listConsumerRuns({ ...owner, workflow: "genjutsu", variant: bad })).rejects.toMatchObject({ code: "invalid_input" });
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

test("a read that started before a run landed never sets it back", () => {
  const landed = { id: "r", status: "completed", createdAt: 10, updatedAt: 50 };
  /* A list read taken before the poll landed it arrives later. */
  expect(mergeRuns([{ id: "r", status: "accepted", createdAt: 10, updatedAt: 20 }], [landed])).toEqual([landed]);
  expect(mergeRuns([{ id: "r", status: "uncertain", createdAt: 10 }], [{ id: "r", status: "accepted", createdAt: 10 }])[0].status).toBe("accepted");
  /* Same state: the later-updated copy wins; a genuinely fresher copy always does. */
  expect(mergeRuns([{ id: "r", status: "accepted", createdAt: 10, updatedAt: 30 }], [{ id: "r", status: "accepted", createdAt: 10, updatedAt: 40 }])[0].updatedAt).toBe(40);
  expect(mergeRuns([{ id: "r", status: "completed", createdAt: 10, updatedAt: 60 }], [{ id: "r", status: "accepted", createdAt: 10, updatedAt: 40 }])[0].status).toBe("completed");
});

test("a run that cannot move on its own is known; a missing original and an unread account are said in words", () => {
  expect(runCannotSettle({ status: "dispatching" })).toBe(true);
  expect(runCannotSettle({ status: "uncertain", providerReceipt: null })).toBe(true);
  expect(runCannotSettle({ status: "uncertain", providerReceipt: { response: {} } })).toBe(false);
  expect(runCannotSettle({ status: "accepted" })).toBe(false);
  expect(originalNote({ originalAvailable: true, originalAvailability: "available" })).toBeNull();
  expect(originalNote({ originalAvailable: false, originalAvailability: "deleted" })).toBe("Archived");
  expect(originalNote({ originalAvailable: false, originalAvailability: "unavailable" })).toBe("Original unavailable");
  const base = { connected: false, owner: true, hasProject: true };
  expect(viralBlock(INITIAL_VIRAL, base)).toBe("Connect the account in Workspace › Engines.");
  expect(viralBlock(INITIAL_VIRAL, { ...base, account: "Reading the connected account…" })).toBe("Reading the connected account…");
  expect(viralBlock(INITIAL_VIRAL, { ...base, account: "The connected account could not be read." })).toBe("The connected account could not be read.");
  expect(viralBlock(INITIAL_VIRAL, { ...base, hasProject: false, account: "Reading the connected account…" })).toBe("Open a project first.");
});
