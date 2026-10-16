import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { exportWorkerPool } from "./remotionWorkerFake";

/* Who may export what. An export is a copy of a file as the caller's own upload, so the caller must be able to reach the file:
   a take filed under someone else's private board, and an upload that is not theirs, answer exactly as an id that does not exist.
   Real temporary databases; the worker is in memory; nothing is sent or spent. */
const directory = mkdtempSync(path.join(tmpdir(), "export-reach-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
const OWNER = { id: "u_owner", role: "member" }, MATE = { id: "u_mate", role: "member" }, ADMIN = { id: "u_admin", role: "admin" };
const FACTS = async () => ({ durationSeconds: 10, width: 1920, height: 1080 });
const LIMITS = { maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 6, runTimeoutMs: 200_000, queueExpiryMs: 30 * 60_000 };
const NOT_AVAILABLE = /isn't available in this workspace/;

async function context(name: string, run: (m: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace(name), async () => run(await setup(name)));
}

async function setup(name: string) {
  const jobs = await import("../../lib/exports/jobs");
  const inputs = await import("../../lib/exports/inputs");
  const draft = await import("../../lib/draftProject");
  const { db, ready } = await import("../../lib/db");
  const { platformReady } = await import("../../lib/platform");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  await platformReady(); await ready(); await workbenchReady(); await jobs.exportJobsReady();
  const ws = workspace(name);
  const board = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
  const client = db();
  await client.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "Private board"] });
  await client.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_open','Ordinary production',0)", args: [] });
  await client.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: board })] });
  for (const [id, role] of [["u_owner", "member"], ["u_mate", "member"], ["u_admin", "admin"]]) {
    await client.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x", role] });
  }
  const take = (id: string, projectId: string | null) => client.execute({
    sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes) VALUES(?,?,?,?,?,1,1,'video',0,'u_owner',?,'/stored/x.mp4',1000)",
    args: [id, "m", "a take", "{}", "succeeded", projectId],
  });
  await take("take_private", board);
  await take("take_open", "prod_open");
  await take("take_free", null);
  const upload = (id: string, uploader: string | null) => client.execute({
    sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,uploader_id) VALUES(?,?,?,?,1000,'x',NULL,NULL,'/stored/u.mp4',1,'video',?)",
    args: [id, "clip.mp4", "video/mp4", "mp4", uploader],
  });
  await upload("upload_owner", "u_owner");
  const resolverFor = (viewer: { id: string; role?: string }) => inputs.createMediaResolver(viewer, { facts: FACTS });
  const pool = exportWorkerPool();
  const deps = (extra: Record<string, unknown> = {}) => ({ enabled: () => true, limits: () => LIMITS, resolver: resolverFor, loader: async () => Buffer.from("clip"), worker: { config: pool.config, fetch: pool.fetch }, ...extra });
  const count = async () => Number((await client.execute("SELECT COUNT(*) AS n FROM export_jobs")).rows[0].n);
  return { ...jobs, ...inputs, db, pool, deps, count, resolverFor, ws };
}

const request = (requestId: string, source: Record<string, unknown>) => ({
  requestId,
  composition: "reframe" as const,
  props: { aspect: "9:16", scale: 0.25, clip: { source, cues: [] } },
});

test("a take of someone else's private board is not found: same 404 as an unknown id, nothing written; its owner and a workspace admin may export it", async () => context("reach-takes", async (m) => {
  const unknown = await m.resolverFor(MATE).video({ take: "take_nothing" }).catch((e) => e);
  expect(unknown).toMatchObject({ status: 404 });
  const hidden = await m.resolverFor(MATE).video({ take: "take_private" }).catch((e) => e);
  expect(hidden).toMatchObject({ status: 404, message: unknown.message });
  expect(hidden.message).toMatch(NOT_AVAILABLE);
  // Through the request: refused, and no row, no file.
  await expect(m.createExport(request("request-reach-0001", { take: "take_private" }), MATE, m.deps())).rejects.toMatchObject({ status: 404 });
  expect(await m.count()).toBe(0);
  // A token acts as its person: the same answer.
  await expect(m.createExport(request("request-reach-0002", { take: "take_private" }), { id: "u_mate" }, m.deps())).rejects.toMatchObject({ status: 404 });
  // The board's owner, and an admin of the workspace.
  for (const who of [OWNER, ADMIN]) expect(await m.resolverFor(who).video({ take: "take_private" })).toMatchObject({ origin: "take", id: "take_private" });
  expect((await m.createExport(request("request-reach-0003", { take: "take_private" }), OWNER, m.deps())).duplicate).toBe(false);
  expect((await m.createExport(request("request-reach-0004", { take: "take_private" }), ADMIN, m.deps())).duplicate).toBe(false);
  // Ordinary productions and unfiled takes stay open to every member.
  for (const id of ["take_open", "take_free"]) expect(await m.resolverFor(MATE).video({ take: id })).toMatchObject({ id });
}));

test("once the owner shares the board, a teammate may export its takes", async () => context("reach-shared", async (m) => {
  await expect(m.resolverFor(MATE).video({ take: "take_private" })).rejects.toMatchObject({ status: 404 });
  const row = (await m.db().execute("SELECT body FROM workbench_projects WHERE key='u_owner:d1'")).rows[0];
  await m.db().execute({ sql: "UPDATE workbench_projects SET body=? WHERE key='u_owner:d1'", args: [JSON.stringify({ ...JSON.parse(String(row.body)), teamShared: true })] });
  expect(await m.resolverFor(MATE).video({ take: "take_private" })).toMatchObject({ id: "take_private" });
}));

test("an upload that is not the caller's is not found, as an unknown id is; the uploader may export it", async () => context("reach-uploads", async (m) => {
  const unknown = await m.resolverFor(MATE).video({ upload: "upload_nothing" }).catch((e) => e);
  const foreign = await m.resolverFor(MATE).video({ upload: "upload_owner" }).catch((e) => e);
  expect(foreign).toMatchObject({ status: 404, message: unknown.message });
  expect(foreign.message).toMatch(NOT_AVAILABLE);
  await expect(m.createExport(request("request-reach-0010", { upload: "upload_owner" }), MATE, m.deps())).rejects.toMatchObject({ status: 404 });
  expect(await m.count()).toBe(0);
  expect(await m.resolverFor(OWNER).video({ upload: "upload_owner" })).toMatchObject({ origin: "upload", id: "upload_owner" });
  // Logos and music go through the same door.
  await m.db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,duration_s,uploader_id) VALUES('logo_owner','l.png','image/png','png',100,'x',NULL,NULL,'/stored/l.png',1,'image',NULL,'u_owner'),('music_owner','m.mp3','audio/mpeg','mp3',100,'x',NULL,NULL,'/stored/m.mp3',1,'audio',30,'u_owner')", args: [] });
  await expect(m.resolverFor(MATE).image({ upload: "logo_owner" })).rejects.toMatchObject({ status: 404 });
  await expect(m.resolverFor(MATE).audio({ upload: "music_owner" })).rejects.toMatchObject({ status: 404 });
  expect(await m.resolverFor(OWNER).image({ upload: "logo_owner" })).toMatchObject({ id: "logo_owner" });
  expect(await m.resolverFor(OWNER).audio({ upload: "music_owner" })).toMatchObject({ id: "music_owner", durationSeconds: 30 });
}));

test("the media is asked about again when the job runs: a deleted take, a lost role or a disabled person ends it as failed, Nothing billed, with nothing sent to a worker", async () => context("reach-run", async (m) => {
  const deps = (extra: Record<string, unknown> = {}) => m.deps({ reach: undefined, ...extra });
  // Admin exports a private take, then is made a member: the job must not run.
  const asAdmin = await m.createExport(request("request-reach-0020", { take: "take_private" }), ADMIN, deps());
  await m.db().execute("UPDATE users SET role='member' WHERE id='u_admin'");
  await m.runExport(asAdmin.job.id, deps());
  expect(await m.getExport("u_admin", asAdmin.job.id, deps())).toMatchObject({ status: "failed", error: "A file in the export is not available any more. Nothing billed." });
  expect(m.pool.calls).toEqual([]);
  // The owner's own export of a take that is deleted before it runs.
  const gone = await m.createExport(request("request-reach-0021", { take: "take_open" }), OWNER, deps());
  await m.db().execute("UPDATE generations SET deleted=1 WHERE id='take_open'");
  await m.runExport(gone.job.id, deps());
  expect((await m.getExport("u_owner", gone.job.id, deps())).status).toBe("failed");
  // A disabled person.
  const disabled = await m.createExport(request("request-reach-0022", { take: "take_free" }), MATE, deps());
  await m.db().execute("UPDATE users SET disabled=1 WHERE id='u_mate'");
  await m.runExport(disabled.job.id, deps());
  expect((await m.getExport("u_mate", disabled.job.id, deps())).error).toContain("not available any more");
  expect(m.pool.calls).toEqual([]);
  // Someone who is no longer among the workspace's people (removed, or never listed) reaches nothing, not even an open take.
  const removed = await m.createExport(request("request-reach-0024", { take: "take_free" }), OWNER, deps());
  await m.db().execute("DELETE FROM users WHERE id='u_owner'");
  await m.runExport(removed.job.id, deps());
  expect(await m.getExport("u_owner", removed.job.id, deps())).toMatchObject({ status: "failed", error: "A file in the export is not available any more. Nothing billed." });
  expect(m.pool.calls).toEqual([]);
  await m.db().execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u_owner','u_owner@example.test','u_owner','x','member',0)", args: [] });
  // While reach holds, it runs.
  const fine = await m.createExport(request("request-reach-0023", { take: "take_free" }), OWNER, deps());
  await m.runExport(fine.job.id, deps());
  expect((await m.getExport("u_owner", fine.job.id, deps())).status).toBe("ready");
}));

test("the hourly share is read before any file is opened or inspected", async () => context("reach-hour", async (m) => {
  const limits = () => ({ ...LIMITS, maxPerHourPerWorkspace: 1 });
  let resolved = 0;
  const counting = (who: { id: string; role?: string }) => { const inner = m.resolverFor(who); return { video: async (h: never) => { resolved++; return inner.video(h); }, image: inner.image, audio: inner.audio }; };
  await m.createExport(request("request-hour-0001", { take: "take_free" }), OWNER, m.deps({ limits, resolver: counting }));
  expect(resolved).toBe(1);
  const refused = await m.createExport(request("request-hour-0002", { take: "take_free" }), OWNER, m.deps({ limits, resolver: counting })).catch((e) => e);
  expect(refused).toMatchObject({ status: 429 });
  expect(resolved).toBe(1);
  expect(await m.count()).toBe(1);
}));

test("a retry is a start: it counts against the hour, is refused when the hour is used, and the job stays failed", async () => context("reach-retry", async (m) => {
  const limits = () => ({ ...LIMITS, maxPerHourPerWorkspace: 2 });
  const first = await m.createExport(request("request-retry-0001", { take: "take_free" }), OWNER, m.deps({ limits }));
  m.pool.behave({ exitCode: 4, result: { ok: false, code: "render_failed", errors: ["Chrome crashed"] } });
  await m.runExport(first.job.id, m.deps({ limits }));
  // One export plus one retry is the whole hour.
  await m.retryExport("u_owner", first.job.id, m.deps({ limits }));
  const blocked = await m.createExport(request("request-retry-0002", { take: "take_free" }), OWNER, m.deps({ limits })).catch((e) => e);
  expect(blocked).toMatchObject({ status: 429 });
  await m.runExport(first.job.id, m.deps({ limits }));
  expect((await m.getExport("u_owner", first.job.id, m.deps({ limits }))).status).toBe("failed");
  const refused = await m.retryExport("u_owner", first.job.id, m.deps({ limits })).catch((e) => e);
  expect(refused).toMatchObject({ status: 429 });
  expect(refused.message).toContain("Nothing was started or billed");
  expect((await m.getExport("u_owner", first.job.id, m.deps({ limits }))).status).toBe("failed");
  // The hour passes: a retry is allowed again, and a new export too.
  const later = m.deps({ limits, clock: () => Date.now() + 3_700_000 });
  expect((await m.retryExport("u_owner", first.job.id, later)).status).toBe("queued");
  expect((await m.createExport(request("request-retry-0003", { take: "take_free" }), OWNER, later)).duplicate).toBe(false);
}));
