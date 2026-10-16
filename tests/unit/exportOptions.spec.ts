import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { MediaResolver } from "../../lib/exports/inputs";
import { exportWorkerPool } from "./remotionWorkerFake";
import { checkSpec } from "../../remotion/node/export";
import { CONFORM_MODES } from "../../remotion/node/conform";
import { CONFORM_VALUES, parseOutputOptions } from "../../remotion/src/lib/output";

/* What an export request may ask of the finished files (format, subtitles, conform), the voice lines of a narrated cut,
   and a large video that is streamed into storage instead of held. No network, no render, no engine, no credit. */
const directory = mkdtempSync(path.join(tmpdir(), "export-options-"));
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
const request = (requestId: string, output?: unknown, extra: Record<string, unknown> = {}) => ({
  requestId,
  composition: "captions" as const,
  props: { aspect: "9:16", scale: 0.25, captionStyle: "bold", clip: { source: { take: "take_one", hasAudio: true }, cues: [{ startMs: 500, endMs: 2500, text: "Every great film" }] }, ...extra },
  ...(output === undefined ? {} : { output: output as Record<string, unknown> }),
});

async function context(name: string, run: (m: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace(name), async () => run(await setup(name)));
}
async function setup(name: string) {
  const jobs = await import("../../lib/exports/jobs");
  const { db, ready } = await import("../../lib/db");
  await ready();
  await jobs.exportJobsReady();
  const pool = exportWorkerPool();
  const deps = (extra: Record<string, unknown> = {}) => ({ enabled: on, limits: () => LIMITS, resolver: () => resolver, reach: async () => true, loader: async () => Buffer.from("clip-bytes"), worker: { config: pool.config, fetch: pool.fetch }, ...extra });
  return { ...jobs, db, pool, deps, ws: workspace(name) };
}

test("the options: H.264 by default, ProRes 422 or HQ, subtitles srt and/or vtt, conform auto or off; H.265 and everything else is refused", () => {
  expect(parseOutputOptions(undefined)).toEqual({ ok: true, value: { format: "h264", subtitles: [], conform: "off" } });
  expect(parseOutputOptions({ format: "PRORES-422-HQ", subtitles: ["SRT", "vtt", "srt"], conform: "off" })).toEqual({ ok: true, value: { format: "prores-422-hq", subtitles: ["srt", "vtt"], conform: "off" } });
  for (const name of ["h265", "H.265", "hevc", " HEVC ", "x265", "h265-mp4"]) expect(parseOutputOptions({ format: name })).toEqual({ ok: false, errors: ["output.format: H.265 is not available."] });
  expect(parseOutputOptions({ format: "gif", subtitles: ["ass"], conform: "always", extra: 1 })).toEqual({ ok: false, errors: ["output.extra: is not allowed", "output.format: must be one of h264, prores-422, prores-422-hq", "output.subtitles: must be a list of srt and/or vtt", "output.conform: must be auto or off"] });
  expect(parseOutputOptions([])).toMatchObject({ ok: false });
  expect(parseOutputOptions({ subtitles: [] })).toMatchObject({ ok: false });
});

test("the app and the worker's command say the same words, and the conform values are the worker's", () => {
  expect([...CONFORM_VALUES]).toEqual([...CONFORM_MODES]);
  const props = { aspect: "16:9", scale: 0.25, title: null, clips: [{ source: { file: "a.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }], captionStyle: null, end: null, music: null };
  for (const output of [{ format: "h265" }, { format: "gif" }, { subtitles: ["ass"] }, { conform: "always" }]) {
    const app = parseOutputOptions(output);
    const worker = checkSpec({ version: 1, composition: "final", props, output });
    expect(app.ok).toBe(false);
    expect(worker.ok).toBe(false);
    expect((app as { errors: string[] }).errors[0]).toBe((worker as { errors: string[] }).errors[0].replace("spec.output.", "output."));
  }
});

test("an unwanted request is refused before anything is stored: H.265, an unknown name, subtitles with no captions, a ProRes cut over 60 s", async () => context("refuse", async (m) => {
  const bad = async (output: unknown, extra: Record<string, unknown> = {}, id = "request-bad-00001") => m.createExport(request(id, output, extra), { id: "u_test" }, m.deps()).then(() => null, (error) => error as { message: string; status: number });
  expect(await bad({ format: "h265" })).toMatchObject({ status: 400, message: expect.stringContaining("output.format: H.265 is not available.") });
  expect(await bad({ format: "avi" })).toMatchObject({ status: 400, message: expect.stringContaining("must be one of h264, prores-422, prores-422-hq") });
  expect(await bad({ subtitles: ["srt"] }, { clip: { source: { take: "take_one", hasAudio: true }, cues: [] } })).toMatchObject({ status: 400, message: expect.stringContaining("no caption text") });
  expect(await bad({ subtitles: ["srt"] }, { clip: { source: { take: "take_one", hasAudio: true }, cues: [{ startMs: 500, endMs: 2500, text: "{\\an8}" }] } }, "request-bad-00002")).toMatchObject({ status: 400, message: expect.stringContaining("every caption in this export is only styling, so there is no text to write") });
  /* 70 s: the take is 10 s in the resolver above, so use a final of seven clips */
  const final = (output: unknown) => m.createExport({ requestId: "request-long-0001", composition: "final", props: { aspect: "16:9", scale: 0.25, clips: Array.from({ length: 7 }, () => ({ source: { take: "take_one", hasAudio: true } })) }, output: output as Record<string, unknown> }, { id: "u_test" }, m.deps()).then(() => null, (error) => error as { message: string; status: number });
  expect(await final({ format: "prores-422" })).toMatchObject({ status: 413, message: "A ProRes export can be at most 1800 frames (60 s at 30 fps, 30 s at 60 fps); this one is 2100 frames (70.0 s at 30 fps). Use H.264 for a longer one." });
  expect((await m.db().execute("SELECT COUNT(*) AS n FROM export_jobs")).rows[0].n).toBe(0);
}));

test("the options are part of the request: the same id with another format is a different export", async () => context("same-id", async (m) => {
  const first = await m.createExport(request("request-same-0001", { format: "prores-422" }), { id: "u_test" }, m.deps());
  const again = await m.createExport(request("request-same-0001", { format: "prores-422" }), { id: "u_test" }, m.deps());
  expect(again).toMatchObject({ duplicate: true, job: { id: first.job.id } });
  await expect(m.createExport(request("request-same-0001", { format: "prores-422-hq" }), { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 409 });
  await expect(m.createExport(request("request-same-0001"), { id: "u_test" }, m.deps())).rejects.toMatchObject({ status: 409 });
}));

test("a ProRes export: the worker is told the format, the .mov is streamed into storage with its own name and type, and the job is ready", async () => context("prores", async (m) => {
  const created = await m.createExport(request("request-prores-001", { format: "prores-422" }), { id: "u_test" }, m.deps());
  m.pool.behave({ mp4: Buffer.alloc(5000, 9), contentLength: true });
  await m.runExport(created.job.id, m.deps());
  const job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job.status).toBe("ready");
  expect(job.outputs).toHaveLength(1);
  expect(job.outputs[0]).toMatchObject({ kind: "video", format: "prores-422", mime: "video/quicktime", bytes: 5000, url: `/api/uploads/${created.job.id}_video` });
  expect(job.outputs[0].filename).toMatch(/^export-[a-f0-9]{8}-prores\.mov$/);
  const spec = JSON.parse(m.pool.calls.find((call) => call.query?.endsWith("spec.json"))!.body!.toString());
  expect(spec.output).toEqual({ video: true, format: "prores-422", conform: "off" });
  const upload = (await m.db().execute({ sql: "SELECT mime, ext, bytes, kind, sha256, stored_url FROM uploads WHERE id=?", args: [`${created.job.id}_video`] })).rows[0];
  expect([upload.mime, upload.ext, Number(upload.bytes), upload.kind]).toEqual(["video/quicktime", "mov", 5000, "video"]);
  expect(String(upload.stored_url).startsWith(`ws/${m.ws.id}/uploads/`)).toBe(true);
  const { createHash } = await import("node:crypto");
  expect(upload.sha256).toBe(createHash("sha256").update(Buffer.alloc(5000, 9)).digest("hex"));
}));

test("the HQ name differs, and a reply with no stated length is still stored (capped while it is read)", async () => context("hq", async (m) => {
  const created = await m.createExport(request("request-hq-0000001", { format: "prores-422-hq" }), { id: "u_test" }, m.deps());
  m.pool.behave({ contentLength: false });
  await m.runExport(created.job.id, m.deps());
  const job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job.status).toBe("ready");
  expect(job.outputs[0]).toMatchObject({ format: "prores-422-hq", mime: "video/quicktime" });
  expect(job.outputs[0].filename).toMatch(/-prores-hq\.mov$/);
}));

test("subtitles: the video and each subtitle file are stored as their own outputs, in order, with their own type", async () => context("subs", async (m) => {
  const created = await m.createExport(request("request-subs-00001", { subtitles: ["srt", "vtt"], conform: "off" }), { id: "u_test" }, m.deps());
  await m.runExport(created.job.id, m.deps());
  const job = await m.getExport("u_test", created.job.id, m.deps());
  expect(job.status).toBe("ready");
  expect(job.outputs.map((o) => [o.kind, o.format, o.mime])).toEqual([["video", "h264", "video/mp4"], ["subtitle", "srt", "application/x-subrip"], ["subtitle", "vtt", "text/vtt"]]);
  expect(job.outputs.map((o) => o.filename.split(".").pop())).toEqual(["mp4", "srt", "vtt"]);
  const spec = JSON.parse(m.pool.calls.find((call) => call.query?.endsWith("spec.json"))!.body!.toString());
  expect(spec.output).toEqual({ video: true, format: "h264", subtitles: ["srt", "vtt"], conform: "off" });
  const rows = (await m.db().execute({ sql: "SELECT id, kind, mime, bytes FROM uploads WHERE id LIKE ? ORDER BY id", args: [`${created.job.id}%`] })).rows;
  expect(rows.map((r) => [String(r.id).replace(created.job.id, ""), r.kind, r.mime]).sort()).toEqual([["_subtitle_srt", "document", "application/x-subrip"], ["_subtitle_vtt", "document", "text/vtt"], ["_video", "video", "video/mp4"]]);
}));

test("a missing subtitle file or video ends the job as failed with Nothing billed", async () => context("missing", async (m) => {
  const a = await m.createExport(request("request-miss-00001", { subtitles: ["srt"] }), { id: "u_test" }, m.deps());
  m.pool.behave({ subtitles: { srt: null } });
  await m.runExport(a.job.id, m.deps());
  expect(await m.getExport("u_test", a.job.id, m.deps())).toMatchObject({ status: "failed", error: expect.stringContaining("without its subtitle file") });
  const b = await m.createExport(request("request-miss-00002", { format: "prores-422" }), { id: "u_test" }, m.deps());
  m.pool.behave({ mp4: null });
  await m.runExport(b.job.id, m.deps());
  expect(await m.getExport("u_test", b.job.id, m.deps())).toMatchObject({ status: "failed", error: expect.stringContaining("without a file") });
}));

test("voice lines of a narrated cut are bound like the music: each upload becomes a plain file in the worker's input folder, with its own length", async () => {
  const { bindMedia } = await import("../../lib/exports/inputs");
  const bound = await bindMedia("final", { aspect: "16:9", clips: [{ source: { take: "t1" } }], music: { upload: "u_music", volume: 0.4 }, voiceover: [{ upload: "u_v1", startSeconds: 1.5 }, { upload: "u_v2", startSeconds: 5, volume: 0.8 }, { upload: "u_v1" }], duck: 0.4 }, resolver);
  expect((bound.props.voiceover as Record<string, unknown>[])).toEqual([
    { file: "voice1.mp3", durationSeconds: 3, startSeconds: 1.5 },
    { file: "voice2.mp3", durationSeconds: 3, startSeconds: 5, volume: 0.8 },
    { file: "voice1.mp3", durationSeconds: 3 },
  ]);
  expect(bound.props.duck).toBe(0.4);
  expect(bound.media.map((x) => x.file).sort()).toEqual(["m1.mp4", "music1.mp3", "voice1.mp3", "voice2.mp3"]);
  const reject = (voiceover: unknown) => bindMedia("final", { aspect: "16:9", clips: [{ source: { take: "t1" } }], voiceover }, resolver).then(() => null, (error: Error) => error.message);
  expect(await reject("vo.mp3")).toBe("props.voiceover must be a list of voice lines.");
  expect(await reject([{ url: "https://x.test/a.mp3" }])).toContain("props.voiceover[0].url is not allowed here.");
  expect(await reject([{ upload: "a", take: "b" }])).toContain('props.voiceover[0] must name exactly one of "upload" or "take".');
  expect(await reject([{ startSeconds: 2 }])).toContain('props.voiceover[0] must name exactly one of "upload" or "take".');
  expect(await reject(Array.from({ length: 25 }, () => ({ upload: "u" })))).toBe("props.voiceover can have at most 24 voice lines.");
});

test("a large file is stored from a stream with a running hash, and a stream over its limit is refused", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { storeUploadStream } = await import("../../lib/storage");
  await runInTenant(workspace("stream"), async () => {
    const chunk = Buffer.alloc(256 * 1024, 3);
    const body = (n: number) => new ReadableStream<Uint8Array>({ pull(controller) { if (n-- > 0) controller.enqueue(new Uint8Array(chunk)); else controller.close(); } });
    const stored = await storeUploadStream("streamed_a", "mov", body(40), "video/quicktime", 20 * 1024 * 1024);
    expect(stored.bytes).toBe(40 * chunk.length);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256");
    for (let i = 0; i < 40; i++) hash.update(chunk);
    expect(stored.sha256).toBe(hash.digest("hex"));
    await expect(storeUploadStream("streamed_b", "mov", body(40), "video/quicktime", 5 * 1024 * 1024)).rejects.toThrow("A file exceeds its size limit.");
  });
});

test("an outside agent can ask for the options over MCP: output goes to the same route, and the tool says what it accepts", async () => {
  const { runTool, EXPORT_TOOLS } = await import("../../lib/mcp");
  process.env.REMOTION_EXPORTS = "1";
  try {
    const calls: { path: string; init: { method?: string; body?: unknown } }[] = [];
    const call = (async (pathname: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ path: pathname, init }); return { job: { id: "export_" + "c".repeat(32), status: "queued", queueLine: "Export queued — you are next", error: null, outputs: [] } }; }) as never;
    await runTool("export_video", { composition: "captions", props: { aspect: "9:16" } as never, output: { format: "prores-422", subtitles: ["srt"] } as never, request_id: "agent-request-0002" }, call, "https://app.test");
    expect(calls[0].init.body).toEqual({ requestId: "agent-request-0002", composition: "captions", props: { aspect: "9:16" }, output: { format: "prores-422", subtitles: ["srt"] } });
    await runTool("export_video", { composition: "captions", props: { aspect: "9:16" } as never, request_id: "agent-request-0003" }, call, "https://app.test");
    expect(calls[1].init.body).toEqual({ requestId: "agent-request-0003", composition: "captions", props: { aspect: "9:16" } });
  } finally { delete process.env.REMOTION_EXPORTS; }
  const tool = EXPORT_TOOLS.find((t) => t.name === "export_video")!;
  expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["composition", "props", "output", "request_id"]);
  expect(tool.description).toMatch(/prores-422-hq/);
  expect(tool.description).toMatch(/H\.265 is not available/);
  expect(tool.description).toMatch(/voiceover/);
  expect(tool.description).toMatch(/keep-speech/);
  /* The formats are H.264 and the ProRes mezzanine; DNxHR is dropped for now (owner, 16 Oct 2026) and the copy says so. */
  /* The sentence follows the closing brace of the output list; the list itself reads straight through. */
  expect(tool.description).toMatch(/H\.265 is not available\), subtitles:\['srt','vtt'\] \(written from the cues\), conform:'off'[^}]*\}\. H\.264 and the ProRes mezzanine are the only formats: DNxHR is not offered for now\. /);
  expect(JSON.stringify(tool.inputSchema)).toMatch(/the only formats; no DNxHR for now/);
  expect(parseOutputOptions({ format: "dnxhr" })).toMatchObject({ ok: false });
  expect(parseOutputOptions({ format: "DNxHD" })).toMatchObject({ ok: false });
});

test("the ProRes limit is the worker's: 1800 frames, so the same words, 60 s at 30 fps and 30 s at 60 fps, and a higher frame rate cannot get round it", async () => context("frames", async (m) => {
  const clips = (n: number) => Array.from({ length: n }, () => ({ source: { take: "take_one", hasAudio: true } }));
  const ask = (id: string, n: number, fps: number) => m.createExport({ requestId: id, composition: "final", props: { aspect: "16:9", fps, scale: 0.25, clips: clips(n) }, output: { format: "prores-422" } }, { id: "u_test" }, m.deps()).then((r) => r.job.id, (e: { status: number; message: string }) => `${e.status}: ${e.message}`);
  expect(String(await ask("request-frames-001", 6, 30))).toMatch(/^export_/);
  expect(String(await ask("request-frames-002", 3, 60))).toMatch(/^export_/);
  expect(await ask("request-frames-003", 4, 60)).toBe("413: A ProRes export can be at most 1800 frames (60 s at 30 fps, 30 s at 60 fps); this one is 2400 frames (40.0 s at 60 fps). Use H.264 for a longer one.");
  const worker = checkSpec({ version: 1, composition: "final", props: { aspect: "16:9", fps: 60, scale: 0.25, title: null, end: null, music: null, captionStyle: null, clips: Array.from({ length: 4 }, () => ({ source: { file: "a.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } })) }, output: { format: "prores-422" } });
  expect((worker as { errors: string[] }).errors[0]).toBe("A ProRes export can be at most 1800 frames (60 s at 30 fps, 30 s at 60 fps); this one is 2400 frames (40.0 s at 60 fps). Use H.264 for a longer one.");
}));

test("a file that arrives cut short (fewer bytes than the worker declared) or empty is not kept: the object is removed, no upload row is written, and the job fails with Nothing billed", async () => context("cut", async (m) => {
  const stored = (id: string) => (async () => (await m.db().execute({ sql: "SELECT COUNT(*) AS n FROM uploads WHERE id LIKE ?", args: [`${id}%`] })).rows[0].n)();
  const cut = await m.createExport(request("request-cut-0000001", { format: "prores-422" }), { id: "u_test" }, m.deps());
  m.pool.behave({ mp4: Buffer.alloc(5000, 9), contentLength: 9000 });
  await m.runExport(cut.job.id, m.deps());
  expect(await m.getExport("u_test", cut.job.id, m.deps())).toMatchObject({ status: "failed", outputs: [], error: "The export file did not arrive whole. Nothing billed." });
  expect(await stored(cut.job.id)).toBe(0);
  const short = await m.createExport(request("request-cut-0000002"), { id: "u_test" }, m.deps());
  m.pool.behave({ mp4: Buffer.alloc(8, 1), contentLength: false });
  await m.runExport(short.job.id, m.deps());
  expect(await m.getExport("u_test", short.job.id, m.deps())).toMatchObject({ status: "failed", error: "The export finished without a file. Nothing billed." });
  expect(await stored(short.job.id)).toBe(0);
}));

test("a save that never finished (the function was cut off mid-save) is ended by recovery: failed, Nothing billed, its worker session stopped", async () => context("savecut", async (m) => {
  const created = await m.createExport(request("request-save-000001", { format: "prores-422" }), { id: "u_test" }, m.deps());
  const name = "remotion-export-01234567-89ab-cdef-0123-456789abcdef";
  await m.db().execute({ sql: "UPDATE export_jobs SET status='saving', runtime_id=?, claimed_at=? WHERE id=?", args: [name, 1_000, created.job.id] });
  const before = m.pool.calls.length;
  await m.recoverExports({ deadlineAt: Date.now() + 100_000 }, { ...m.deps(), clock: () => 3 * 60 * 60_000, enqueue: async () => true });
  expect(await m.getExport("u_test", created.job.id, m.deps())).toMatchObject({ status: "failed", error: "The export did not finish. Nothing billed." });
  expect(m.pool.calls.slice(before).some((c) => c.method === "DELETE" && c.path.endsWith(name))).toBe(true);
}));
