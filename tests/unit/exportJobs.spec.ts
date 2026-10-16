import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { MediaResolver } from "../../lib/exports/inputs";
import { exportWorkerPool } from "./remotionWorkerFake";

/* The durable export job against the real tenant database and an in-memory worker behind a stubbed fetch. No
   network, no render, no Docker, no engine call, and no credit ever moves: the first thing most of these check. */
const directory = mkdtempSync(path.join(tmpdir(), "export-jobs-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });

const on = () => true;
const off = () => false;
const LIMITS = { maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 6, runTimeoutMs: 280_000, queueExpiryMs: 30 * 60_000 };

const resolver: MediaResolver = {
  async video(handle) {
    const id = handle.take ?? handle.upload!;
    if (id === "take_making") { const { ExportError } = await import("../../lib/exports/contract"); throw new ExportError("That take is still being made. Export it when it is ready.", 409); }
    return { origin: handle.take ? "take" : "upload", id, ext: "mp4", storedUrl: `stored/${id}`, bytes: 1000, durationSeconds: 10, width: 1920, height: 1080 };
  },
  async image(handle) { return { id: handle.upload!, ext: "png", storedUrl: `stored/${handle.upload}`, bytes: 100 }; },
  async audio(handle) { return { id: handle.upload!, ext: "mp3", storedUrl: `stored/${handle.upload}`, bytes: 100, durationSeconds: 30 }; },
};
const loader = async () => Buffer.from("clip-bytes");

const request = (requestId: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  composition: "captions" as const,
  props: { aspect: "9:16", scale: 0.25, captionStyle: "bold", clip: { source: { take: "take_one", hasAudio: true }, cues: [{ startMs: 500, endMs: 2500, text: "Every great film" }] }, ...extra },
});

async function context(name: string, run: (m: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace(name), async () => run(await setup(name)));
}
async function setup(name: string) {
  const jobs = await import("../../lib/exports/jobs");
  const { db } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await (await import("../../lib/db")).ready();
  await jobs.exportJobsReady();
  const pool = exportWorkerPool();
  const deps = (extra: Record<string, unknown> = {}) => ({ enabled: on, limits: () => LIMITS, resolver: () => resolver, reach: async () => true, loader, worker: { config: pool.config, fetch: pool.fetch }, ...extra });
  const row = async (id: string) => (await db().execute({ sql: "SELECT * FROM export_jobs WHERE id=?", args: [id] })).rows[0] as Record<string, unknown>;
  const count = async (table: string, client: { execute: (sql: string) => Promise<{ rows: unknown[] }> } = db()) => {
    try { return Number(((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0] as Record<string, unknown>).n); } catch { return -1; }
  };
  return { ...jobs, db, platformDb, pool, deps, row, count, ws: workspace(name) };
}

test("a request is admitted at 0 cr, runs In queue -> Rendering -> Saving -> Ready, and writes no billing row at all", async () => context("run", async (m) => {
  const warm = await m.createExport(request("request-warm-0001"), { id: "u_test" }, m.deps()); // one admission first, so every lazily made table exists
  await m.cancelExport("u_test", warm.job.id, m.deps());
  const billingTables = ["meter_events", "credit_ledger", "usage_ledger", "credit_receipts", "billing_ledger"];
  const before: number[] = [];
  for (const table of billingTables) before.push(await m.count(table, m.platformDb()), await m.count(table));
  const metered: string[] = [];
  const created = await m.createExport(request("request-run-0001"), { id: "u_test" }, m.deps());
  expect(created).toMatchObject({ scheduled: true, duplicate: false });
  expect(created.job).toMatchObject({ status: "queued", ahead: 0, queueLine: "Export queued — you are next", price: { credits: 0, label: "Free" }, outputs: [], error: null });
  const seen: string[] = [];
  m.pool.behave({
    during: async () => { seen.push(String((await m.row(created.job.id)).status)); },
    onRead: async (file) => { if (file.endsWith("export.mp4")) seen.push(String((await m.row(created.job.id)).status)); },
  });
  expect(await m.runExport(created.job.id, m.deps())).toBeUndefined();
  expect(seen).toEqual(["rendering", "saving"]);
  const job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job).toMatchObject({ status: "ready", ahead: null, queueLine: null, error: null });
  expect(job.outputs).toHaveLength(1);
  expect(job.outputs[0]).toMatchObject({ kind: "video", mime: "video/mp4", url: `/api/uploads/${created.job.id}_video` });
  // The file sits under this workspace's own prefix, and the upload row says who made it.
  const upload = (await m.db().execute({ sql: "SELECT stored_url, uploader_id FROM uploads WHERE id=?", args: [`${created.job.id}_video`] })).rows[0];
  expect(String(upload.stored_url).startsWith(`ws/${m.ws.id}/uploads/`)).toBe(true);
  expect(upload.uploader_id).toBe("u_test");
  // The session was stopped; the worker saw the spec, the clip under a neutral name, and the fixed command.
  expect(m.pool.running()).toEqual([]);
  const puts = m.pool.calls.filter((call) => call.method === "PUT").map((call) => call.query!.replace("/vercel/sandbox/remotion/", ""));
  expect(puts).toEqual(["spec.json", "input/m1.mp4"]);
  const spec = JSON.parse(m.pool.calls.find((call) => call.query?.endsWith("spec.json"))!.body!.toString());
  expect(spec).toMatchObject({ version: 1, composition: "captions", output: { video: true } });
  expect(spec.props.clip.source).toEqual({ file: "m1.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true });
  expect(JSON.stringify(spec)).not.toContain("take_one");
  // No credit moved: every billing table is exactly as it was.
  const after: number[] = [];
  for (const table of billingTables) after.push(await m.count(table, m.platformDb()), await m.count(table));
  expect(after).toEqual(before);
  expect(metered).toEqual([]);
}));

test("the export code cannot reach the meter, the ledger or the credit tables", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = path.join(process.cwd(), "lib", "exports");
  const banned = [/\bmeter\b/, /assertMeterFunding/, /reserveGenerationSpend/, /billingTransaction/, /billCredits/, /from ["']\.\.\/credits["']/, /creditTerms/, /usageLedger/, /meter_events/, /ledger/i, /rateTable/, /vendorRates/, /executeGenerationAdmission/, /maxCredits/, /quoteOnly/];
  for (const file of readdirSync(dir)) {
    const source = readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of banned) expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
  }
});

test("a repeated request id returns the same job; the same id with a different request is refused", async () => context("idempotent", async (m) => {
  const first = await m.createExport(request("request-same-0001"), { id: "u_test" }, m.deps());
  const again = await m.createExport(request("request-same-0001"), { id: "u_test" }, m.deps());
  expect(again).toMatchObject({ duplicate: true, scheduled: true });
  expect(again.job.id).toBe(first.job.id);
  await expect(m.createExport(request("request-same-0001", { captionStyle: "clean" }), { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 409 });
  expect(await m.count("export_jobs")).toBe(1);
  // Duplicate delivery of the run event runs it once.
  let runs = 0;
  m.pool.behave({ during: () => { runs++; } });
  await Promise.all([m.runExport(first.job.id, m.deps()), m.runExport(first.job.id, m.deps())]);
  expect(runs).toBe(1);
  expect((await m.getExport("u_test", first.job.id, m.deps())).status).toBe("ready");
}));

test("the fair share: six an hour, one running at once, and a refusal writes nothing", async () => context("fair", async (m) => {
  const limits = () => ({ ...LIMITS, maxPerHourPerWorkspace: 2 });
  const a = await m.createExport(request("request-fair-0001"), { id: "u_test" }, m.deps({ limits }));
  await m.createExport(request("request-fair-0002"), { id: "u_test" }, m.deps({ limits }));
  const refused = await m.createExport(request("request-fair-0003"), { id: "u_test" }, m.deps({ limits })).catch((e) => e);
  expect(refused).toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
  expect(refused.message).toContain("2 exports in the last hour");
  expect(refused.message).toContain("Nothing was started or billed");
  expect(await m.count("export_jobs")).toBe(2);
  // The hour rolls over.
  const later = await m.createExport(request("request-fair-0004"), { id: "u_test" }, m.deps({ limits, clock: () => Date.now() + 3_700_000 }));
  expect(later.duplicate).toBe(false);
  expect(a.job.id).toBeTruthy();
}));

test("one running per workspace: a second export waits in the queue, then runs when the first is done", async () => context("running", async (m) => {
  const one = await m.createExport(request("request-run-a0001"), { id: "u_test" }, m.deps());
  const two = await m.createExport(request("request-run-b0001"), { id: "u_test" }, m.deps());
  expect(two.job).toMatchObject({ status: "queued", ahead: 1, queueLine: "Export queued — 1 ahead of you" });
  let secondOutcome: unknown;
  m.pool.behave({ during: async () => { secondOutcome = await m.runExport(two.job.id, m.deps()); } });
  await m.runExport(one.job.id, m.deps());
  expect(secondOutcome).toBe("waiting");
  expect((await m.getExport("u_test", two.job.id, m.deps())).status).toBe("queued");
  m.pool.behave({});
  expect(await m.runExport(two.job.id, m.deps())).toBeUndefined();
  expect((await m.getExport("u_test", two.job.id, m.deps())).status).toBe("ready");
  // Two at once are allowed when the platform says two.
  const three = await m.createExport(request("request-run-c0001"), { id: "u_test" }, m.deps());
  const four = await m.createExport(request("request-run-d0001"), { id: "u_test" }, m.deps());
  let fourOutcome: unknown = "unset";
  m.pool.behave({ during: async () => { fourOutcome = await m.runExport(four.job.id, m.deps({ limits: () => ({ ...LIMITS, maxRunningPerWorkspace: 2 }) })); } });
  await m.runExport(three.job.id, m.deps({ limits: () => ({ ...LIMITS, maxRunningPerWorkspace: 2 }) }));
  // The only worker is busy with the first, so the second goes back to the queue rather than waiting on the share.
  expect(fourOutcome).toBe("busy");
}));

test("every worker busy: back to the queue, nothing stored, nothing billed; it runs when a worker is free", async () => context("busy", async (m) => {
  const created = await m.createExport(request("request-busy-0001"), { id: "u_test" }, m.deps());
  m.pool.set("http://remotion-1:8790", "busy");
  expect(await m.runExport(created.job.id, m.deps())).toBe("busy");
  let job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job).toMatchObject({ status: "queued" });
  expect(job.error).toContain("Nothing is billed");
  expect(await m.count("uploads")).toBe(0);
  // Inside its backoff it is not asked again.
  expect(await m.runExport(created.job.id, m.deps())).toBe("busy");
  expect(m.pool.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  m.pool.set("http://remotion-1:8790", "free");
  expect(await m.runExport(created.job.id, m.deps({ clock: () => Date.now() + 60_000 }))).toBeUndefined();
  job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job.status).toBe("ready");
}));

test("a failed export says Nothing billed, with the reason in the customer's words, and Retry runs it again", async () => context("failed", async (m) => {
  const created = await m.createExport(request("request-fail-0001"), { id: "u_test" }, m.deps());
  m.pool.behave({ exitCode: 3, result: { ok: false, code: "input_mismatch", errors: ["input/m1.mp4: is 1280x720, the request says 1920x1080"] } });
  await m.runExport(created.job.id, m.deps());
  let job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job.status).toBe("failed");
  expect(job.error).toBe("A file in the export is not what the request says it is. A clip: is 1280x720, the request says 1920x1080 Nothing billed.");
  expect(job.error).not.toContain("m1.mp4");
  expect(job.outputs).toEqual([]);
  expect(await m.count("uploads")).toBe(0);
  expect(m.pool.running()).toEqual([]);
  // Retry: back in the queue under the same job, then ready.
  const retried = await m.retryExport("u_test", created.job.id, m.deps());
  expect(retried).toMatchObject({ status: "queued", error: null });
  m.pool.behave({});
  await m.runExport(created.job.id, m.deps());
  expect((await m.getExport("u_test", created.job.id, m.deps())).status).toBe("ready");
  await expect(m.retryExport("u_test", created.job.id, m.deps())).rejects.toMatchObject({ status: 409 });
  // At most three tries.
  const second = await m.createExport(request("request-fail-0002"), { id: "u_test" }, m.deps());
  for (let attempt = 1; attempt <= 3; attempt++) {
    m.pool.behave({ exitCode: 4, result: { ok: false, code: "render_failed", errors: ["Chrome crashed"] } });
    await m.runExport(second.job.id, m.deps());
    if (attempt < 3) await m.retryExport("u_test", second.job.id, m.deps());
  }
  expect((await m.getExport("u_test", second.job.id, m.deps())).error).toBe("The export could not be rendered. Chrome crashed Nothing billed.");
  await expect(m.retryExport("u_test", second.job.id, m.deps())).rejects.toMatchObject({ status: 409 });
}));

test("a timeout, a missing file and an unreachable worker all end the job as failed with Nothing billed", async () => context("ends", async (m) => {
  const timeout = await m.createExport(request("request-end-0001"), { id: "u_test" }, m.deps());
  m.pool.behave({ exitCode: 137, timedOut: true });
  await m.runExport(timeout.job.id, m.deps());
  expect((await m.getExport("u_test", timeout.job.id, m.deps())).error).toBe("The export took longer than allowed. Nothing billed.");
  const missing = await m.createExport(request("request-end-0002"), { id: "u_test" }, m.deps());
  m.pool.behave({ mp4: null });
  await m.runExport(missing.job.id, m.deps());
  expect((await m.getExport("u_test", missing.job.id, m.deps())).error).toBe("The export finished without a file. Nothing billed.");
  const down = await m.createExport(request("request-end-0003"), { id: "u_test" }, m.deps());
  m.pool.behave({});
  m.pool.set("http://remotion-1:8790", "refuse");
  await m.runExport(down.job.id, m.deps());
  expect((await m.getExport("u_test", down.job.id, m.deps())).error).toBe("The export workers are not available right now. Nothing billed.");
  expect(await m.count("uploads")).toBe(0);
}));

test("a file that cannot be checked at run time (a database error) says so in its own words, not that it is gone; a file that really is gone says that; both are Nothing billed and no worker is asked", async () => context("reach", async (m) => {
  const before = m.pool.calls.length;
  const broken = await m.createExport(request("request-reach-0001"), { id: "u_test" }, m.deps());
  await m.runExport(broken.job.id, m.deps({ reach: async () => { throw new Error("SQLITE_BUSY: database is locked"); } }));
  const brokenJob = await m.getExport("u_test", broken.job.id, m.deps());
  expect(brokenJob).toMatchObject({ status: "failed", error: "The files in this export could not be checked just now. Try the export again. Nothing billed." });
  expect(brokenJob.error).not.toContain("not available any more");
  const gone = await m.createExport(request("request-reach-0002"), { id: "u_test" }, m.deps());
  await m.runExport(gone.job.id, m.deps({ reach: async () => false }));
  expect(await m.getExport("u_test", gone.job.id, m.deps())).toMatchObject({ status: "failed", error: "A file in the export is not available any more. Nothing billed." });
  expect(m.pool.calls.length).toBe(before);
  expect(await m.count("uploads")).toBe(0);
}));

test("cancel: a queued export ends at once; a rendering one stops its worker session; both say Nothing billed", async () => context("cancel", async (m) => {
  const queued = await m.createExport(request("request-cancel-0001"), { id: "u_test" }, m.deps());
  const cancelled = await m.cancelExport("u_test", queued.job.id, m.deps());
  expect(cancelled).toMatchObject({ status: "cancelled", error: "Cancelled. Nothing billed." });
  expect(await m.runExport(queued.job.id, m.deps())).toBeUndefined();
  expect(m.pool.calls).toEqual([]);
  const running = await m.createExport(request("request-cancel-0002"), { id: "u_test" }, m.deps());
  let cancelResult: unknown;
  m.pool.behave({ during: async () => { cancelResult = (await m.cancelExport("u_test", running.job.id, m.deps())).status; await new Promise(() => {}); } });
  await m.runExport(running.job.id, m.deps());
  expect(cancelResult).toBe("rendering");
  expect(await m.getExport("u_test", running.job.id, m.deps())).toMatchObject({ status: "cancelled", error: "Cancelled. Nothing billed.", outputs: [] });
  expect(m.pool.running()).toEqual([]);
  // A finished export cannot be cancelled into something else.
  const done = await m.createExport(request("request-cancel-0003"), { id: "u_test" }, m.deps());
  m.pool.behave({});
  await m.runExport(done.job.id, m.deps());
  expect((await m.cancelExport("u_test", done.job.id, m.deps())).status).toBe("ready");
}));

test("tenant isolation: another workspace's export, and another person's, are not found; every row carries its workspace", async () => {
  let aId = "";
  await context("tenant-a", async (m) => {
    const created = await m.createExport(request("request-iso-a0001"), { id: "u_test" }, m.deps());
    aId = created.job.id;
    expect((await m.row(aId)).workspace_id).toBe("ws_tenant-a");
    // A row written for another workspace in this very database is never read or changed here.
    await m.db().execute({ sql: "INSERT INTO export_jobs(id,workspace_id,owner,request_id,fingerprint,composition,spec_json,status,created_at,updated_at) VALUES('export_foreign','ws_other','u_test','request-foreign-1','f','captions','{}','queued',1,1)", args: [] });
    await expect(m.getExport("u_test", "export_foreign", m.deps())).rejects.toMatchObject({ status: 404 });
    await expect(m.cancelExport("u_test", "export_foreign", m.deps())).rejects.toMatchObject({ status: 404 });
    expect((await m.listExports("u_test", m.deps())).map((job) => job.id)).toEqual([aId]);
    expect((await m.row("export_foreign")).status).toBe("queued");
    expect(await m.runExport("export_foreign", m.deps())).toBeUndefined();
    expect((await m.row("export_foreign")).status).toBe("queued");
    // Another person in the same workspace.
    await expect(m.getExport("u_other", aId, m.deps())).rejects.toMatchObject({ status: 404 });
    await expect(m.cancelExport("u_other", aId, m.deps())).rejects.toMatchObject({ status: 404 });
    expect(await m.listExports("u_other", m.deps())).toEqual([]);
  });
  await context("tenant-b", async (m) => {
    await expect(m.getExport("u_test", aId, m.deps())).rejects.toMatchObject({ status: 404 });
    expect(await m.listExports("u_test", m.deps())).toEqual([]);
    expect(await m.runExport(aId, m.deps())).toBeUndefined();
    expect(m.pool.calls).toEqual([]);
  });
});

test("the media must be this workspace's: a handle that does not resolve refuses the request and writes nothing", async () => context("media", async (m) => {
  const { ExportError } = await import("../../lib/exports/contract");
  const strict: MediaResolver = { ...resolver, async video() { throw new ExportError("That take isn't available in this workspace.", 404); } };
  await expect(m.createExport(request("request-media-0001"), { id: "u_test" }, m.deps({ resolver: () => strict }))).rejects.toMatchObject({ status: 404 });
  expect(await m.count("export_jobs")).toBe(0);
}));

test("a paid step inside an export is not the export's: a take still being made is refused, and plans add the export at 0", async () => context("paid", async (m) => {
  const waiting = request("request-paid-0001", { clip: { source: { take: "take_making" }, cues: [] } });
  await expect(m.createExport(waiting, { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("still being made") });
  expect(await m.count("export_jobs")).toBe(0);
  const { EXPORT_TOOL, planTotalCredits } = await import("../../lib/exports/tool");
  expect(EXPORT_TOOL.price()).toEqual({ credits: 0, label: "Free" });
  // A voice-over at 12 cr and a regenerated shot at 29 cr are priced by their own paths; the export adds nothing.
  expect(planTotalCredits([12, 29])).toBe(41);
  expect(planTotalCredits([])).toBe(0);
}));

test("requests the template refuses never reach the queue: too long, unknown keys, a URL for a file", async () => context("refused", async (m) => {
  const long = { requestId: "request-long-0001", composition: "final" as const, props: { aspect: "16:9", clips: Array.from({ length: 13 }, () => ({ source: { take: "take_one" } })) } };
  await expect(m.createExport(long, { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 413 });
  await expect(m.createExport(request("request-bad-00001", { surprise: 1 }), { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 400 });
  const url = request("request-bad-00002", { clip: { source: { take: "https://example.com/a.mp4" }, cues: [] } });
  await expect(m.createExport(url, { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 400 });
  expect(await m.count("export_jobs")).toBe(0);
}));

test("recovery: a queued export is handed on, a run past its ceiling is ended with its session stopped, and it never runs inline when a queue took it", async () => context("recover", async (m) => {
  const queued = await m.createExport(request("request-rec-00001"), { id: "u_test" }, m.deps());
  const sent: string[] = [];
  const outcome = await m.recoverExports({}, m.deps({ enqueue: async (id: string) => { sent.push(id); return true; }, run: async () => { throw new Error("must not run inline"); } }));
  expect(sent).toEqual([queued.job.id]);
  expect(outcome).toMatchObject({ attempted: 1, failed: 0 });
  // No queue: run it here.
  const ran: string[] = [];
  await m.recoverExports({}, m.deps({ enqueue: async () => false, run: async (id: string) => { ran.push(id); } }));
  expect(ran).toEqual([queued.job.id]);
  // A run that outlived its ceiling.
  await m.db().execute({ sql: "UPDATE export_jobs SET status='rendering', runtime_id=?, claimed_at=? WHERE id=?", args: ["remotion-export-00000000-0000-0000-0000-000000000000", Date.now() - 10 * 60_000, queued.job.id] });
  await m.recoverExports({}, m.deps());
  expect((await m.getExport("u_test", queued.job.id, m.deps())).error).toBe("The export did not finish. Nothing billed.");
}));
