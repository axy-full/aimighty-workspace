import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerJob, ConsumerJobScope, ConsumerWorkflow, CreateConsumerJob } from "../../lib/higgsfield-consumer/jobs";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-sweep-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-consumer-sweep-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
function workspace(): TenantWorkspace {
  const name = `sweep-${++sequence}`;
  return {
    id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
}
const owner = { userId: "owner", draftId: "draft" };
const input = (overrides: Partial<CreateConsumerJob> = {}): CreateConsumerJob => ({
  ...owner, connectedOwnerId: "connected-owner", connectionGeneration: randomUUID(), workflow: "marketing-video", idempotencyKey: randomUUID(),
  payload: { params: { prompt: "Bottle on a stone plinth", duration: 15 }, count: 1 }, quoteCredits: 7.5, quoteExpiresAt: Date.now() + 60_000,
  originalAssetIds: ["product-original"], ...overrides,
});
const key = (job: ConsumerJob) => ({ userId: job.userId, draftId: job.draftId, id: job.id });
async function modules() {
  return {
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    sweep: await import("../../lib/higgsfield-consumer/sweep"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
  };
}
type Modules = Awaited<ReturnType<typeof modules>>;
async function fixture(run: (m: Modules) => Promise<void>) {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    await m.database.ready();
    await m.database.db().execute({
      sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
      args: ["owner-draft", owner.userId, owner.draftId, "Test draft", JSON.stringify({ assets: [{ id: "product-original" }] }), Date.now()],
    });
    await run(m);
  });
}
/** A job through quote and one paid dispatch (the ledger only; nothing is sent). */
async function accepted(m: Modules, workflow: ConsumerWorkflow = "marketing-video") {
  const { job } = await m.jobs.createConsumerJob(input());
  const claim = await m.jobs.claimConsumerDispatch(key(job));
  const done = (await m.jobs.markConsumerAccepted({ ...key(job), claimToken: claim!.claimToken, providerJobId: randomUUID() }))!;
  // Each workflow validates its own payload at quote time; the sweep reads only the ledger row.
  if (workflow !== "marketing-video") await m.database.db().execute({ sql: "UPDATE higgsfield_consumer_jobs SET workflow=? WHERE id=?", args: [workflow, done.id] });
  return done;
}
const set = (m: Modules, sql: string, args: (string | number | null)[]) => m.database.db().execute({ sql, args });
/** Records every read and settles, fails or leaves each job as told. */
function polls(m: Modules, outcome: (scope: ConsumerJobScope) => "complete" | "throw" | "keep" = () => "keep") {
  const reads: string[] = [];
  const poll = async (scope: ConsumerJobScope) => {
    reads.push(scope.id);
    const result = outcome(scope);
    if (result === "throw") throw new Error("private provider detail https://cdn.example.invalid/x.mp4");
    const lease = await m.jobs.claimConsumerPoll(scope);
    if (!lease) return;
    if (result === "complete") await m.jobs.completeConsumerJob({ ...scope, leaseToken: lease.leaseToken, resultManifest: { original: null } });
    else await m.jobs.releaseConsumerPoll({ ...scope, leaseToken: lease.leaseToken, nextPollAt: Date.now() + 30_000 });
  };
  return { reads, polls: { "marketing-video": poll, generation: poll, shorts: poll } };
}

test("the heartbeat reads due accepted jobs with no page open, settles finished ones and frees their slots, never sends anything", async () => {
  await fixture(async (m) => {
    const done = await accepted(m), running = await accepted(m, "generation");
    const quoted = (await m.jobs.createConsumerJob(input())).job;
    // A job whose page asked to be read again later, and one past the background window, are left alone.
    const later = await accepted(m, "shorts");
    await set(m, "UPDATE higgsfield_consumer_jobs SET poll_lease_until=? WHERE id=?", [Date.now() + 60_000, later.id]);
    const old = await accepted(m);
    await set(m, "UPDATE higgsfield_consumer_jobs SET created_at=? WHERE id=?", [Date.now() - m.jobs.CONSUMER_SWEEP_AGE_MS - 1, old.id]);
    expect((await m.jobs.consumerCapacity(owner.userId)).active).toBe(3);

    const f = polls(m, (scope) => (scope.id === done.id ? "complete" : "keep"));
    const report = await m.sweep.sweepConsumerJobs({ limit: 5, deadlineAt: Date.now() + 60_000, polls: f.polls });
    expect(report).toEqual({ read: 2, unavailable: 0, deferred: false });
    expect(f.reads.sort()).toEqual([done.id, running.id].sort());
    expect((await m.jobs.getConsumerJob(key(done)))?.status).toBe("completed");
    expect((await m.jobs.getConsumerJob(key(running)))?.status).toBe("accepted");
    expect((await m.jobs.getConsumerJob(key(quoted)))?.status).toBe("quoted");
    // The settled job no longer holds a slot; nothing was dispatched again.
    expect((await m.jobs.consumerCapacity(owner.userId)).active).toBe(2);
    const statuses = (await set(m, "SELECT status,COUNT(*) AS n FROM higgsfield_consumer_jobs GROUP BY status ORDER BY status", [])).rows.map((r) => [String(r.status), Number(r.n)]);
    expect(statuses).toEqual([["accepted", 3], ["completed", 1], ["quoted", 1]]);

    // Read again at once: nothing is due (each job is taken at most once per interval).
    const again = polls(m);
    expect(await m.sweep.sweepConsumerJobs({ limit: 5, deadlineAt: Date.now() + 60_000, polls: again.polls })).toEqual({ read: 0, unavailable: 0, deferred: false });
    expect(again.reads).toEqual([]);
  });
});

test("a job that cannot be read steps behind the others; failures are counted, never thrown, and the deadline stops the visit", async () => {
  await fixture(async (m) => {
    const stuck = await accepted(m), first = await accepted(m), second = await accepted(m);
    for (const [index, job] of [stuck, first, second].entries())
      await set(m, "UPDATE higgsfield_consumer_jobs SET created_at=? WHERE id=?", [Date.now() - 30 * 60_000 + index * 60_000, job.id]);
    // Taken least recently first, then oldest: the stuck job goes first...
    const f = polls(m, (scope) => (scope.id === stuck.id ? "throw" : "keep"));
    expect(await m.sweep.sweepConsumerJobs({ limit: 1, deadlineAt: Date.now() + 60_000, polls: f.polls })).toEqual({ read: 0, unavailable: 1, deferred: false });
    expect(f.reads).toEqual([stuck.id]);
    expect((await m.jobs.getConsumerJob(key(stuck)))?.status).toBe("accepted");
    // ...and it does not hold the front of the line on the next visit.
    const { CONSUMER_SWEEP_INTERVAL_MS } = m.jobs;
    await set(m, "UPDATE higgsfield_consumer_jobs SET swept_at=swept_at-? WHERE swept_at IS NOT NULL", [CONSUMER_SWEEP_INTERVAL_MS + 1]);
    const next = polls(m, (scope) => (scope.id === stuck.id ? "throw" : "keep"));
    expect(await m.sweep.sweepConsumerJobs({ limit: 2, deadlineAt: Date.now() + 60_000, polls: next.polls })).toEqual({ read: 2, unavailable: 0, deferred: false });
    expect(next.reads).toEqual([first.id, second.id]);
    // Out of time before the first read: nothing is taken, and the visit says it was cut short.
    await set(m, "UPDATE higgsfield_consumer_jobs SET swept_at=NULL,poll_lease_until=NULL", []);
    const late = polls(m);
    expect(await m.sweep.sweepConsumerJobs({ limit: 2, deadlineAt: Date.now() - 1, polls: late.polls })).toEqual({ read: 0, unavailable: 0, deferred: true });
    expect(late.reads).toEqual([]);
    // Only the workflows with a poll are taken.
    const only = polls(m);
    await m.sweep.sweepConsumerJobs({ limit: 5, deadlineAt: Date.now() + 60_000, polls: { shorts: only.polls.shorts } });
    expect(only.reads).toEqual([]);
    await expect(m.jobs.claimConsumerSweep([])).rejects.toMatchObject({ code: "invalid_input" });
    // The real workflow polls: with no connected account the read stops before
    // any network call, is counted, and the job stays accepted for a later visit.
    const real = globalThis.fetch;
    let network = 0;
    globalThis.fetch = (async () => { network++; throw new Error("no network in this test"); }) as typeof fetch;
    try {
      expect(await m.sweep.sweepConsumerJobs({ limit: 1, deadlineAt: Date.now() + 60_000 })).toEqual({ read: 0, unavailable: 1, deferred: false });
    } finally { globalThis.fetch = real; }
    expect(network).toBe(0);
    expect((await set(m, "SELECT COUNT(*) AS n FROM higgsfield_consumer_jobs WHERE status='accepted'", [])).rows[0].n).toBe(3);
  });
});
