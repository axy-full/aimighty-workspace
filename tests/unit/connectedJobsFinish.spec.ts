import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerJob, CreateConsumerJob } from "../../lib/higgsfield-consumer/jobs";
import type { Asset } from "../../lib/workbench/studio";
import {
  createResumeTracker, isResumable, resumableJobs, resumeAge, resumeDelayMs, resumePhase, resumeProblem,
} from "../../lib/higgsfield-consumer/resume";

/**
 * Connected-account jobs finish after the person leaves the page: the cron's
 * sweep asks after due jobs with each workflow's own status read (never a
 * quote or submit), a Gen take files itself into its project on the server,
 * and a page opened later follows what is still in flight.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-connected-jobs-finish-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-connected-jobs-finish-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";

let sequence = 0;
function workspace(): TenantWorkspace {
  const name = `finish-${++sequence}`;
  return {
    id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
}
async function modules() {
  return {
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    background: await import("../../lib/higgsfield-consumer/background"),
    filing: await import("../../lib/higgsfield-consumer/draft-filing"),
    records: await import("../../lib/workbench/records"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
  };
}
type M = Awaited<ReturnType<typeof modules>>;
async function inTenant<T>(run: (m: M) => Promise<T>) {
  const m = await modules();
  return m.tenant.runInTenant(workspace(), async () => {
    await m.database.ready();
    await m.records.workbenchReady();
    await (await import("../../lib/uploadReservations")).uploadReservationsReady();
    return run(m);
  });
}
async function draft(m: M, body: unknown, owner = "owner", id = "draft") {
  await m.database.db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
    args: [`${owner}:${id}`, owner, id, "Draft", JSON.stringify(body), Date.now()],
  });
}
const job = (m: M, overrides: Partial<CreateConsumerJob> = {}) => m.jobs.createConsumerJob({
  userId: "owner", draftId: "draft", connectedOwnerId: "owner", connectionGeneration: randomUUID(), workflow: "marketing-video",
  idempotencyKey: randomUUID(), payload: { params: { prompt: "Bottle on a plinth", duration: 15 }, count: 1 }, quoteCredits: 7,
  quoteExpiresAt: Date.now() + 60_000, originalAssetIds: ["product-original"], ...overrides,
}).then((r) => r.job);
const key = (j: ConsumerJob) => ({ userId: j.userId, draftId: j.draftId, id: j.id });
async function accepted(m: M, overrides: Partial<CreateConsumerJob> = {}) {
  const quoted = await job(m, overrides);
  const claim = (await m.jobs.claimConsumerDispatch(key(quoted)))!;
  return (await m.jobs.markConsumerAccepted({ ...key(quoted), claimToken: claim.claimToken, providerJobId: randomUUID() }))!;
}
async function uncertain(m: M, receipt: Record<string, string> | undefined) {
  const quoted = await job(m);
  const claim = (await m.jobs.claimConsumerDispatch(key(quoted)))!;
  return (await m.jobs.markConsumerUncertain({ ...key(quoted), claimToken: claim.claimToken, ...(receipt ? { providerReceipt: receipt } : {}) }))!;
}

test("the sweep lists only admitted jobs a status read can settle: accepted past their next poll first, then uncertain ones with a receipt, in this workspace only", async () => {
  const firstIds = await inTenant(async (m) => {
    await draft(m, { assets: [{ id: "product-original" }] });
    const open = await accepted(m);
    const leased = await accepted(m);
    const lease = (await m.jobs.claimConsumerPoll(key(leased)))!;
    const receipted = await uncertain(m, { response: "submitted" });
    const unpolled = await accepted(m, { workflow: "virality" });
    await job(m); // quoted: never sent, never swept
    // A read is out: the leased job waits for its lease, then for the next poll time it was given.
    expect((await m.jobs.listConsumerDueJobs()).map((j) => j.id)).toEqual([open.id, receipted.id]);
    const nextPollAt = Date.now() + 120_000;
    await m.jobs.releaseConsumerPoll({ ...key(leased), leaseToken: lease.leaseToken, nextPollAt });
    expect((await m.jobs.listConsumerDueJobs()).map((j) => j.id)).toEqual([open.id, receipted.id]);
    expect((await m.jobs.listConsumerDueJobs({ now: nextPollAt })).map((j) => j.id)).toEqual([open.id, leased.id, receipted.id]);
    // Bounded: the limit is honoured, and never above 50.
    expect(await m.jobs.listConsumerDueJobs({ now: nextPollAt, limit: 1 })).toHaveLength(1);
    await expect(m.jobs.listConsumerDueJobs({ limit: 51 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(unpolled.status).toBe("accepted");
    return [open.id, leased.id, receipted.id, unpolled.id];
  });
  await inTenant(async (m) => {
    await draft(m, { assets: [{ id: "product-original" }] });
    const blind = await uncertain(m, undefined); // no receipt: only the person can reconcile it
    expect(blind.status).toBe("uncertain");
    const due = await m.jobs.listConsumerDueJobs({ now: Date.now() + 3_600_000 });
    expect(due).toEqual([]);
    expect(due.some((j) => firstIds.includes(j.id))).toBe(false);
  });
});

test("the sweep reads status only, one job at a time, sorts problems by who can fix them, and leaves the rest for the next run at the deadline", async () => {
  const { background } = await modules();
  const due = ["generation", "virality", "genjutsu", "marketing-video", "shorts"].map((workflow, i) => ({
    id: `job-${i}`, userId: "owner", draftId: `draft-${i}`, workflow,
  })) as unknown as ConsumerJob[];
  const calls: unknown[] = [];
  const poll = (outcome: () => Promise<{ job: { status: string } }>) => async () => async (scope: unknown) => { calls.push(scope); return outcome(); };
  const pollers = {
    generation: poll(async () => ({ job: { status: "completed" } })),
    genjutsu: poll(async () => { throw Object.assign(new Error("reconnect"), { code: "reconnect_required" }); }),
    "marketing-video": poll(async () => { throw new Error("SQLITE_BUSY: private detail"); }),
    shorts: poll(async () => { throw Object.assign(new Error("slow"), { code: "status_unavailable" }); }),
  };
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: string) => { logged.push(line); };
  try {
    const report = await background.sweepConsumerJobs({ list: async (input) => { expect(input).toMatchObject({ limit: 4 }); return due; }, pollers });
    expect(report).toEqual({ attempted: 4, completed: 1, failed: 0, waiting: 1, retrying: 1, errors: 1, deferred: 0 });
    // Exactly the job's own scope: nothing a poll could use to quote or submit.
    expect(calls).toEqual([
      { userId: "owner", draftId: "draft-0", id: "job-0" }, { userId: "owner", draftId: "draft-2", id: "job-2" },
      { userId: "owner", draftId: "draft-3", id: "job-3" }, { userId: "owner", draftId: "draft-4", id: "job-4" },
    ]);
    // Logs carry fixed words only; provider text never reaches them.
    expect(logged.join("\n")).not.toContain("private detail");
    expect(logged.map((line) => JSON.parse(line).outcome)).toEqual(["waiting", "errors", "retrying"]);
  } finally {
    console.error = error;
  }
  // Out of time after the first job: the rest wait for the next sweep.
  let now = 1_000;
  calls.length = 0;
  const late = await background.sweepConsumerJobs({ list: async () => due, pollers, clock: () => (now += 10), deadlineAt: 1_025 });
  expect(late).toMatchObject({ attempted: 1, completed: 1, deferred: 4 });
  expect(calls).toHaveLength(1);
  expect(background.sweepOutcome(Object.assign(new Error("x"), { code: "quota" }))).toBe("waiting");
  expect(background.sweepOutcome(Object.assign(new Error("x"), { code: "timeout" }))).toBe("retrying");
  expect(background.sweepOutcome("not an error")).toBe("errors");
});

test("a collected Gen take is filed into its owner's saved draft once, never past the project's limit, never for a deleted original", async () => {
  await inTenant(async (m) => {
    const generationId = `gen_hfc_${"b".repeat(40)}`;
    await m.database.db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind) VALUES(?,'nano_banana_2','','{}','succeeded',?,1024,'owner',0,0,'higgsfield','image')",
      args: [generationId, `/api/media/${generationId}`],
    });
    const asset = m.filing.consumerTakeAsset({
      generationId, url: `/api/media/${generationId}`, kind: "image", mime: "image/png", credits: 9, modelName: "Nano Banana 2", prompt: "A plain bottle", enhanced: true,
    });
    expect(asset).toMatchObject({ id: generationId, generationId, kind: "image", category: "Generate", name: "Nano Banana 2 · A plain bottle", description: "Nano Banana 2 · 9 connected credits · enhanced on the account", status: "Draft", locked: false });
    expect(await m.filing.fileConsumerOriginal("owner", "draft", asset)).toBe("missing");
    await draft(m, { name: "Draft", assets: [{ id: "still" }] });
    await draft(m, { assets: [] }, "someone-else", "draft");
    expect(await m.filing.fileConsumerOriginal("owner", "draft", { ...asset, id: "other" })).toBe("unavailable");
    expect(await m.filing.fileConsumerOriginal("owner", "draft", asset)).toBe("filed");
    expect(await m.filing.fileConsumerOriginal("owner", "draft", asset)).toBe("present");
    const saved = await m.records.readDraft("owner", "draft");
    expect(saved!.revision).toBe(2);
    expect(saved!.project.name).toBe("Draft");
    expect(saved!.project.assets.map((a: Asset) => a.id)).toEqual(["still", generationId]);
    // Another person's draft of the same id is untouched.
    expect((await m.records.readDraft("someone-else", "draft"))!.project.assets).toEqual([]);
    // Full: the take stays in Takes; the draft is not grown past its limit.
    await m.database.db().execute({ sql: "UPDATE workbench_projects SET body=? WHERE owner='owner' AND project_id='draft'", args: [JSON.stringify({ assets: Array.from({ length: 6000 }, (_, i) => ({ id: `a${i}` })) })] });
    expect(await m.filing.fileConsumerOriginal("owner", "draft", asset)).toBe("full");
    // A deleted original is never put back into a project.
    await m.database.db().execute({ sql: "UPDATE workbench_projects SET body=? WHERE owner='owner' AND project_id='draft'", args: [JSON.stringify({ assets: [] })] });
    await m.database.db().execute({ sql: "UPDATE generations SET deleted=1 WHERE id=?", args: [generationId] });
    expect(await m.filing.fileConsumerOriginal("owner", "draft", asset)).toBe("unavailable");
  });
  const { filing } = await modules();
  // A media-tool preset is named after its source and filed under Tools, like Atomik's own filing.
  const tool = filing.consumerTakeAsset({
    generationId: "gen_x", url: "/api/media/gen_x", kind: "model", mime: "model/gltf-binary", credits: 3, modelName: "Topaz", prompt: "", enhanced: false,
    tool: { name: "upscale_image", sourceName: "harbour.png" },
  });
  expect(tool).toMatchObject({ kind: "document", category: "Tools", description: "Upscale image · Topaz · 3 connected credits" });
  expect(tool.name).toContain("harbour");
});

test("a page picks up only jobs still in flight, names each state in one word, and asks again on the server's pace", () => {
  const jobs = [
    { id: "a", status: "quoted", createdAt: 1 }, { id: "b", status: "accepted", createdAt: 2 }, { id: "c", status: "uncertain", createdAt: 5 },
    { id: "d", status: "completed", createdAt: 3 }, { id: "e", status: "dispatching", createdAt: 4 }, { id: "f", status: "failed", createdAt: 6 },
  ];
  expect(resumableJobs(jobs).map((j) => j.id)).toEqual(["c", "e", "b"]);
  expect(resumableJobs(jobs, (j) => j.id !== "c").map((j) => j.id)).toEqual(["e", "b"]);
  expect(["quoted", "dispatching", "accepted", "uncertain", "completed", "failed"].map(isResumable)).toEqual([false, true, true, true, false, false]);
  expect(["dispatching", "accepted", "uncertain", "completed", "failed", "quoted"].map((s) => resumePhase(s).label))
    .toEqual(["Submitting", "Rendering", "Confirming", "Complete", "Failed · not billed", "Quoted · not sent"]);
  expect(resumePhase("uncertain").tone).toBe("amber");
  expect([0, 59_000, 4 * 60_000, 3 * 3_600_000, 5 * 86_400_000].map((ms) => resumeAge(0, ms))).toEqual(["just now", "just now", "4 min", "3 h", "5 d"]);
  expect(resumeAge(10_000, 0)).toBe("just now");
  // The server's hint, bounded to 8–60 s; a job only the account can confirm every 30 s; misses back off to 2 min.
  expect([resumeDelayMs("accepted", 20), resumeDelayMs("accepted", 2), resumeDelayMs("accepted", 900), resumeDelayMs("accepted", null)]).toEqual([20_000, 8_000, 60_000, 10_000]);
  expect([resumeDelayMs("uncertain", 5), resumeDelayMs("accepted", 20, 1), resumeDelayMs("accepted", 20, 9)]).toEqual([30_000, 40_000, 120_000]);
  expect(resumeProblem("reconnect_required", "x")).toBe("Reconnect the account in Workspace › Engines to finish this take.");
  expect(resumeProblem("original_quota", "x")).toBe("Workspace storage is full. Make room to collect this take.");
  expect(resumeProblem(undefined, "Too many requests. Try again shortly.")).toBe("Too many requests. Try again shortly.");
  expect(resumeProblem(undefined, "x".repeat(300))).toBe("The account could not be reached. Trying again.");
});

test("the page's tracker follows several jobs on their own clocks until each settles, keeps going past one job's error, and goes quiet when stopped", async () => {
  type J = { id: string; status: string };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const replies = new Map<string, () => Promise<{ job: J; pollAfterSeconds?: number }>>();
  const seen: string[] = [];
  const asked: string[] = [];
  const tracker = createResumeTracker<J>({
    status: async (id) => { asked.push(id); return replies.get(id)!(); },
    onUpdate: (job) => seen.push(`update:${job.id}:${job.status}`),
    onSettled: (job) => seen.push(`settled:${job.id}:${job.status}`),
    onProblem: (id) => seen.push(`problem:${id}`),
    schedule: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    cancel: (handle) => { (handle as { live: boolean }).live = false; },
  });
  const fire = async () => {
    const due = timers.filter((t) => t.live);
    for (const t of due) t.live = false;
    for (const t of due) t.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return due.map((t) => t.ms);
  };
  tracker.track([{ id: "a", status: "accepted" }, { id: "b", status: "uncertain" }, { id: "c", status: "completed" }]);
  tracker.track([{ id: "a", status: "accepted" }]);
  expect(tracker.followed()).toEqual(["a", "b"]);
  replies.set("a", async () => ({ job: { id: "a", status: "accepted" }, pollAfterSeconds: 20 }));
  replies.set("b", async () => { throw new Error("offline"); });
  expect(await fire()).toEqual([1200, 1200]);
  expect(seen).toEqual(["update:a:accepted", "problem:b"]);
  // a follows the server's pace; b backs off from its own base.
  expect(timers.filter((t) => t.live).map((t) => t.ms)).toEqual([20_000, 60_000]);
  replies.set("a", async () => ({ job: { id: "a", status: "completed" } }));
  replies.set("b", async () => ({ job: { id: "b", status: "accepted" }, pollAfterSeconds: 15 }));
  await fire();
  expect(seen.slice(2)).toEqual(["update:a:completed", "settled:a:completed", "update:b:accepted"]);
  expect(tracker.followed()).toEqual(["b"]);
  // Dismissed or stopped: nothing is asked again and late replies are dropped.
  tracker.forget("b");
  expect(timers.filter((t) => t.live)).toHaveLength(0);
  tracker.track([{ id: "d", status: "dispatching" }]);
  tracker.stop();
  tracker.track([{ id: "e", status: "accepted" }]);
  expect(await fire()).toEqual([]);
  expect(asked).toEqual(["a", "b", "a", "b"]);
});
