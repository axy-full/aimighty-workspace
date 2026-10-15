import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zod from "zod";
import { unzipSync } from "fflate";
import { loadRoute } from "../helpers/routeModule";
import type { TenantWorkspace } from "../../lib/tenant";
import type { MediaResolver } from "../../lib/exports/inputs";
import { exportWorkerPool } from "./remotionWorkerFake";
import { zipStream, ZIP_LIMIT_BYTES, type ZipEntry } from "../../lib/exports/zip";

/* Download all: one ready export's files as one streamed zip. The owner only; nothing held in memory; no network. */
const directory = mkdtempSync(path.join(tmpdir(), "export-zip-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
const on = () => true;
const LIMITS = { maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 20, runTimeoutMs: 280_000, queueExpiryMs: 30 * 60_000 };
const resolver: MediaResolver = {
  async video(handle) { const id = handle.take ?? handle.upload!; return { origin: handle.take ? "take" : "upload", id, ext: "mp4", storedUrl: `stored/${id}`, bytes: 1000, durationSeconds: 10, width: 1920, height: 1080 }; },
  async image(handle) { return { id: handle.upload!, ext: "png", storedUrl: `stored/${handle.upload}`, bytes: 100 }; },
  async audio(handle) { return { id: handle.upload!, ext: "mp3", storedUrl: `stored/${handle.upload}`, bytes: 100, durationSeconds: 3 }; },
};
const request = (requestId: string, output?: unknown) => ({
  requestId, composition: "captions" as const,
  props: { aspect: "9:16", scale: 0.25, captionStyle: "bold", clip: { source: { take: "take_one", hasAudio: true }, cues: [{ startMs: 500, endMs: 2500, text: "Every great film" }] } },
  ...(output === undefined ? {} : { output: output as Record<string, unknown> }),
});
async function context(name: string, run: (m: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace(name), async () => run(await setup(name)));
}
async function setup(name: string) {
  const jobs = await import("../../lib/exports/jobs");
  const zip = await import("../../lib/exports/zip");
  const { db, ready } = await import("../../lib/db");
  await ready();
  await jobs.exportJobsReady();
  const pool = exportWorkerPool();
  const deps = (extra: Record<string, unknown> = {}) => ({ enabled: on, limits: () => LIMITS, resolver: () => resolver, reach: async () => true, loader: async () => Buffer.from("clip-bytes"), worker: { config: pool.config, fetch: pool.fetch }, ...extra });
  return { ...jobs, ...zip, db, pool, deps, ws: workspace(name) };
}

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
  return Buffer.concat(parts);
};
const source = (chunks: number, byte: number, size = 64 * 1024, log?: { pulls: number; cancelled: boolean }): ReadableStream<Uint8Array> => {
  let left = chunks;
  return new ReadableStream<Uint8Array>({ pull(controller) { if (log) log.pulls += 1; if (left-- > 0) controller.enqueue(new Uint8Array(size).fill(byte)); else controller.close(); }, cancel() { if (log) log.cancelled = true; } }, { highWaterMark: 0 });
};

test("a zip of several entries is a valid archive with each file byte for byte, stored, and an empty file is allowed", async () => {
  const entries: ZipEntry[] = [
    { name: "a.mp4", bytes: 6 * 64 * 1024, stream: source(6, 1) },
    { name: "b.srt", bytes: 64 * 1024, stream: source(1, 2) },
    { name: "empty.vtt", bytes: 0, stream: source(0, 0) },
  ];
  const archive = unzipSync(new Uint8Array(await collect(zipStream(entries))));
  expect(Object.keys(archive).sort()).toEqual(["a.mp4", "b.srt", "empty.vtt"]);
  expect(Buffer.from(archive["a.mp4"]).equals(Buffer.alloc(6 * 64 * 1024, 1))).toBe(true);
  expect(Buffer.from(archive["b.srt"]).equals(Buffer.alloc(64 * 1024, 2))).toBe(true);
  expect(archive["empty.vtt"].length).toBe(0);
});

test("it is read at the consumer's pace, one chunk at a time: a later file is not read until the first is done, and a cancel closes every file still open", async () => {
  const first = { pulls: 0, cancelled: false };
  const second = { pulls: 0, cancelled: false };
  const stream = zipStream([
    { name: "big.mov", bytes: 1e9, stream: new ReadableStream<Uint8Array>({ pull(controller) { first.pulls += 1; controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { first.cancelled = true; } }) },
    { name: "after.srt", bytes: 10, stream: source(1, 1, 10, second) },
  ]);
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  expect(first.pulls).toBeGreaterThan(0);
  expect(second.pulls).toBe(0);
  await reader.cancel();
  expect(first.cancelled).toBe(true);
  expect(second.cancelled).toBe(true);
});

test("an empty chunk from storage does not stall the archive", async () => {
  const withEmpty = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(0)); controller.enqueue(new Uint8Array(10).fill(7)); controller.enqueue(new Uint8Array(0)); controller.close(); } });
  const archive = unzipSync(new Uint8Array(await collect(zipStream([{ name: "x.srt", bytes: 10, stream: withEmpty }, { name: "y.vtt", bytes: 1, stream: source(1, 9, 1) }]))));
  expect(Buffer.from(archive["x.srt"]).equals(Buffer.alloc(10, 7))).toBe(true);
  expect(Buffer.from(archive["y.vtt"]).equals(Buffer.alloc(1, 9))).toBe(true);
});

test("a ready export's zip holds its video and its subtitle files, named as they are listed, and only those", async () => context("zip", async (m) => {
  const created = await m.createExport(request("request-zip-000001", { subtitles: ["srt", "vtt"] }), { id: "u_test" }, m.deps());
  m.pool.behave({ mp4: Buffer.alloc(300_000, 5) });
  await m.runExport(created.job.id, m.deps());
  const result = await m.exportZip("u_test", created.job.id, m.deps());
  expect(result.filename).toBe(`export-${created.job.id.slice(7, 15)}.zip`);
  const job = await m.getExport("u_test", created.job.id, m.deps());
  const archive = unzipSync(new Uint8Array(await collect(result.stream)));
  expect(Object.keys(archive).sort()).toEqual(job.outputs.map((o) => o.filename).sort());
  expect(Buffer.from(archive[job.outputs[0].filename]).equals(Buffer.alloc(300_000, 5))).toBe(true);
  expect(Buffer.from(archive[job.outputs[1].filename]).toString()).toContain("00:00:00,500 --> 00:00:02,500");
  expect(Buffer.from(archive[job.outputs[2].filename]).toString()).toMatch(/^WEBVTT/);
  expect(result.bytes).toBe(job.outputs.reduce((sum, o) => sum + o.bytes, 0));
}));

test("only the owner, only when ready: another person gets 404, a queued export 409, the switch off 404, a file gone 404", async () => context("zipgate", async (m) => {
  const created = await m.createExport(request("request-zip-000002"), { id: "u_test" }, m.deps());
  await expect(m.exportZip("u_test", created.job.id, m.deps())).rejects.toMatchObject({ status: 409, message: "That export is not ready yet." });
  await m.runExport(created.job.id, m.deps());
  await expect(m.exportZip("u_other", created.job.id, m.deps())).rejects.toMatchObject({ status: 404 });
  await expect(m.exportZip("u_test", created.job.id, m.deps({ enabled: () => false }))).rejects.toMatchObject({ status: 404 });
  await expect(m.exportZip("u_test", "export_" + "d".repeat(32), m.deps())).rejects.toMatchObject({ status: 404 });
  expect((await m.exportZip("u_test", created.job.id, m.deps())).filename).toMatch(/\.zip$/);
  await m.db().execute({ sql: "DELETE FROM uploads WHERE id=?", args: [`${created.job.id}_video`] });
  await expect(m.exportZip("u_test", created.job.id, m.deps())).rejects.toMatchObject({ status: 404, message: "A file of that export is not available any more." });
}));

test("an export that would pass the zip limit is refused, not written wrong", async () => context("ziglimit", async (m) => {
  const created = await m.createExport(request("request-zip-000003"), { id: "u_test" }, m.deps());
  await m.runExport(created.job.id, m.deps());
  await m.db().execute({ sql: "UPDATE uploads SET bytes=? WHERE id=?", args: [Math.ceil(ZIP_LIMIT_BYTES) + 1, `${created.job.id}_video`] });
  await expect(m.exportZip("u_test", created.job.id, m.deps())).rejects.toMatchObject({ status: 413 });
}));

test("the route: owner only, streamed as an attachment, 404 for a bad id, and the failures say what the other export routes say", async () => {
  const log: string[] = [];
  const http = await import("../../lib/exports/http");
  const contract = await import("../../lib/exports/contract");
  const { attachmentDisposition } = await import("../../lib/contentDisposition");
  process.env.REMOTION_EXPORTS = "1";
  try {
    let behave: "ok" | "conflict" = "ok";
    const shared = {
      zod,
      "@/lib/auth": { withTenant: <T>(h: T) => h, requireUser: async () => { log.push("requireUser"); return { user: { id: "u_test" } }; } },
      "@/lib/exports/contract": contract,
      "@/lib/exports/http": http,
      "@/lib/contentDisposition": { attachmentDisposition },
      "@/lib/exports/zip": { exportZip: async (owner: string, id: string) => { log.push(`zip ${owner} ${id}`); if (behave === "conflict") throw new contract.ExportError("That export is not ready yet.", 409); return { filename: "export-abcdef12.zip", bytes: 3, stream: new Response("zip").body! }; } },
    };
    const route = loadRoute<{ GET: (req: Request, ctx: unknown) => Promise<Response> }>("app/api/exports/[id]/zip/route.ts", shared);
    const id = "export_" + "a".repeat(32);
    const ok = await route.GET(new Request("https://app.test/z"), { params: Promise.resolve({ id }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/zip");
    expect(ok.headers.get("content-disposition")).toContain("export-abcdef12.zip");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(await ok.text()).toBe("zip");
    expect(log).toEqual(["requireUser", `zip u_test ${id}`]);
    log.length = 0;
    expect((await route.GET(new Request("https://app.test/z"), { params: Promise.resolve({ id: "../x" }) })).status).toBe(404);
    expect(log).toEqual(["requireUser"]);
    behave = "conflict";
    const waiting = await route.GET(new Request("https://app.test/z"), { params: Promise.resolve({ id }) });
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({ error: "That export is not ready yet." });
  } finally { delete process.env.REMOTION_EXPORTS; }
  /* Off, it answers 404 before the session is read. */
  const offLog: string[] = [];
  const off = loadRoute<{ GET: (req: Request, ctx: unknown) => Promise<Response> }>("app/api/exports/[id]/zip/route.ts", {
    zod, "@/lib/auth": { withTenant: <T>(h: T) => h, requireUser: async () => { offLog.push("requireUser"); return { user: { id: "u" } }; } },
    "@/lib/exports/contract": contract, "@/lib/exports/http": http, "@/lib/contentDisposition": { attachmentDisposition }, "@/lib/exports/zip": { exportZip: async () => { offLog.push("zip"); throw new Error("no"); } },
  });
  const response = await off.GET(new Request("https://app.test/z"), { params: Promise.resolve({ id: "export_" + "a".repeat(32) }) });
  expect(response.status).toBe(404);
  expect(offLog).toEqual([]);
});

test("every file is opened inside exportZip while the workspace is in scope (the response is read later, outside it), in listed order", async () => context("zipscope", async (m) => {
  const { currentTenant } = await import("../../lib/tenant");
  const created = await m.createExport(request("request-zip-000010", { subtitles: ["srt", "vtt"] }), { id: "u_test" }, m.deps());
  await m.runExport(created.job.id, m.deps());
  const opened: { upload: string; workspace: string | undefined }[] = [];
  const open = async (uploadId: string) => { opened.push({ upload: uploadId.replace(created.job.id, ""), workspace: currentTenant()?.workspace?.id }); return source(1, 3); };
  const result = await m.exportZip("u_test", created.job.id, m.deps(), { open });
  expect(opened).toEqual([{ upload: "_video", workspace: "ws_zipscope" }, { upload: "_subtitle_srt", workspace: "ws_zipscope" }, { upload: "_subtitle_vtt", workspace: "ws_zipscope" }]);
  /* Reading the body later, outside any workspace, opens nothing more. */
  await collect(result.stream);
  expect(opened).toHaveLength(3);
}));

test("a row whose stored object is gone is a clean 404 before any response, not a 200 that stops; files opened before it are let go", async () => context("zipgone", async (m) => {
  const created = await m.createExport(request("request-zip-000011", { subtitles: ["srt"] }), { id: "u_test" }, m.deps());
  await m.runExport(created.job.id, m.deps());
  /* The real storage: delete the video's object and keep its row. */
  const { deleteUpload } = await import("../../lib/storage");
  const row = (await m.db().execute({ sql: "SELECT ext, stored_url FROM uploads WHERE id=?", args: [`${created.job.id}_video`] })).rows[0];
  await deleteUpload(`${created.job.id}_video`, String(row.ext), String(row.stored_url));
  await expect(m.exportZip("u_test", created.job.id, m.deps())).rejects.toMatchObject({ status: 404, message: "A file of that export is not available any more." });
  /* A later file failing lets go of the earlier ones. */
  const first = { pulls: 0, cancelled: false };
  const open = async (uploadId: string) => { if (uploadId.endsWith("_subtitle_srt")) throw new Error("blob not found"); return source(1, 1, 10, first); };
  await expect(m.exportZip("u_test", created.job.id, m.deps(), { open })).rejects.toMatchObject({ status: 404 });
  expect(first.cancelled).toBe(true);
}));

test("a size that is not a whole number cannot slip past the limit: NULL, text and negative sizes are refused", async () => context("zipsize", async (m) => {
  const created = await m.createExport(request("request-zip-000012"), { id: "u_test" }, m.deps());
  await m.runExport(created.job.id, m.deps());
  for (const bad of ["'abc'", "-5", "1.5"]) {
    await m.db().execute(`UPDATE uploads SET bytes=${bad} WHERE id='${created.job.id}_video'`);
    await expect(m.exportZip("u_test", created.job.id, m.deps()), bad).rejects.toMatchObject({ status: 404, message: "A file of that export is not available any more." });
  }
}));
