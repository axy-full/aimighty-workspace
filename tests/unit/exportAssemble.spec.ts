import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { assembleSchema, assembleToExport, ASSEMBLE_LIMITS } from "../../lib/exports/assemble";
import { subtitleCuesOf, subtitleText } from "../../remotion/src/lib/subtitles";
import { toTimeline } from "../../remotion/src/lib/timeline";
import { validateProps } from "../../remotion/src/lib/validate";
import { DEFAULT_THEME, type FinalProps } from "../../remotion/src/lib/types";
import { exportWorkerPool } from "./remotionWorkerFake";

/**
 * The assembly tool (lib/exports/assemble.ts, POST /api/exports/assemble, MCP assemble_film): one timeline of shots, voice
 * lines, music, titles and words cut into an MP4 on the export worker. Pure checks first, then the real tenant database and an
 * in-memory worker behind a stubbed fetch: no network, no render, no engine, and no credit moves.
 */
const directory = mkdtempSync(path.join(tmpdir(), "export-assemble-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const HINDI = ["हर अच्छी फ़िल्म", "एक छोटी कहानी से शुरू होती है"];

const film = (extra: Record<string, unknown> = {}) => ({
  requestId: "film-request-0001",
  timeline: {
    aspect: "16:9",
    title: { title: "Monsoon", durationSeconds: 2 },
    shots: [{ take: "take_a" }, { take: "take_b", trim: { startSeconds: 1, endSeconds: 7 }, hasAudio: true }],
    voice: [{ take: "voice_en", startSeconds: 2.5, text: "Every great film" }, { upload: "voice_up", startSeconds: 9, volume: 0.8, text: "starts small" }],
    music: { upload: "music_up", volume: 0.2 },
    captions: "bold",
    end: { headline: "Coming soon" },
    ...extra,
  },
  output: { subtitles: ["srt", "vtt"] },
});

test("a film maps to the final template by handles alone: shots in order, silent unless asked, lines on the film's clock", () => {
  const request = assembleToExport(assembleSchema.parse(film()));
  expect(request).toEqual({
    requestId: "film-request-0001",
    composition: "final",
    props: {
      aspect: "16:9",
      title: { title: "Monsoon", durationSeconds: 2 },
      clips: [{ source: { take: "take_a", hasAudio: false } }, { source: { take: "take_b", hasAudio: true }, trim: { startSeconds: 1, endSeconds: 7 } }],
      captionStyle: "bold",
      end: { headline: "Coming soon" },
      music: { upload: "music_up", volume: 0.2 },
      voiceover: [{ take: "voice_en", startSeconds: 2.5, text: "Every great film" }, { upload: "voice_up", startSeconds: 9, volume: 0.8, text: "starts small" }],
    },
    output: { subtitles: ["srt", "vtt"] },
  });
  expect(JSON.stringify(request)).not.toMatch(/https?:|\/api\/|storedUrl|file/);
  /* Same input, same request: the tool is a pure translation. */
  expect(assembleToExport(assembleSchema.parse(film()))).toEqual(request);
  /* Without captions asked for, none are burned in. */
  expect(assembleToExport(assembleSchema.parse(film({ captions: undefined }))).props.captionStyle).toBeNull();
});

test("what the tool refuses before anything is looked up: URLs and paths, two handles or none, unknown fields, too many", () => {
  const bad = (timeline: Record<string, unknown>) => assembleSchema.safeParse({ requestId: "film-request-0002", timeline: { aspect: "16:9", shots: [{ take: "t" }], ...timeline } }).success;
  expect(bad({})).toBe(true);
  expect(bad({ shots: [{ url: "https://example.test/a.mp4" }] })).toBe(false);
  expect(bad({ shots: [{ file: "../../etc/passwd" }] })).toBe(false);
  expect(bad({ shots: [{ take: "t", upload: "u" }] })).toBe(false);
  expect(bad({ shots: [{}] })).toBe(false);
  expect(bad({ shots: [{ take: "../x" }] })).toBe(false);
  expect(bad({ shots: [{ take: "https://example.test/a.mp4" }] })).toBe(false);
  expect(bad({ shots: [] })).toBe(false);
  expect(bad({ shots: Array.from({ length: ASSEMBLE_LIMITS.shots + 1 }, (_, i) => ({ take: `t${i}` })) })).toBe(false);
  expect(bad({ voice: Array.from({ length: ASSEMBLE_LIMITS.voice + 1 }, (_, i) => ({ take: `v${i}`, startSeconds: i })) })).toBe(false);
  expect(bad({ voice: [{ take: "v", upload: "u", startSeconds: 1 }] })).toBe(false);
  expect(bad({ voice: [{ take: "v" }] })).toBe(false);
  expect(bad({ voice: [{ take: "v", startSeconds: -1 }] })).toBe(false);
  expect(bad({ voice: [{ take: "v", startSeconds: 1, text: "x".repeat(ASSEMBLE_LIMITS.text + 1) }] })).toBe(false);
  expect(bad({ music: { url: "https://example.test/m.mp3" } })).toBe(false);
  expect(bad({ captions: "sparkly" })).toBe(false);
  expect(bad({ fps: 29 })).toBe(false);
  expect(bad({ aspect: "4:3" })).toBe(false);
  expect(bad({ surprise: true })).toBe(false);
  expect(assembleSchema.safeParse({ requestId: "short", timeline: { aspect: "16:9", shots: [{ take: "t" }] } }).success).toBe(false);
  expect(assembleSchema.safeParse({ requestId: "film-request-0003", price: 0, timeline: { aspect: "16:9", shots: [{ take: "t" }] } }).success).toBe(false);
});

/* The template's props as the export route hands them on, after the handles are resolved to files. */
const resolved = (lines: { startSeconds: number; durationSeconds: number; text?: string }[], captionStyle: FinalProps["captionStyle"] = "clean") => {
  const clip = (file: string) => ({ source: { file, durationSeconds: 5, width: 1920, height: 1080, hasAudio: false }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } });
  const checked = validateProps("final", {
    aspect: "16:9", fps: 30, scale: 0.25, captionStyle,
    title: { title: "Title", durationSeconds: 2, theme: DEFAULT_THEME }, end: { headline: "End", durationSeconds: 2, theme: DEFAULT_THEME },
    clips: [clip("m1.mp4"), clip("m2.mp4")],
    voiceover: lines.map((line, i) => ({ file: `voice${i + 1}.mp3`, volume: 1, ...line })),
  });
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  return toTimeline("final", checked.value);
};

test("a voice line's words are a caption for as long as it plays, split between the shots it runs across", () => {
  /* Title 0-2 s, shot one 2-7 s, shot two 7-12 s, end card 12-14 s. The line runs 5-9 s: across the cut at 7 s. */
  const timeline = resolved([{ startSeconds: 5, durationSeconds: 4, text: "one two three four five six seven eight" }]);
  const clips = timeline.items.filter((item) => item.kind === "clip");
  expect(clips).toHaveLength(2);
  const [first, second] = clips as Extract<(typeof clips)[number], { kind: "clip" }>[];
  expect(first.subtitleCues.map((cue) => [cue.startMs, cue.endMs, cue.text])).toEqual([[3000, 5000, "one two three four"]]);
  expect(second.subtitleCues.map((cue) => [cue.startMs, cue.endMs, cue.text])).toEqual([[0, 2000, "five six seven eight"]]);
  /* Burned in with the style asked for; on the film's clock the pieces meet at the cut. */
  expect(first.cues).toEqual(first.subtitleCues);
  expect(subtitleCuesOf(timeline).map((cue) => [cue.startMs, cue.endMs])).toEqual([[5000, 7000], [7000, 9000]]);
  /* No style: nothing burned in, the subtitle files still have the words. */
  const quiet = resolved([{ startSeconds: 5, durationSeconds: 4, text: "one two three four five six seven eight" }], null);
  expect(quiet.items.flatMap((item) => (item.kind === "clip" ? item.cues : []))).toEqual([]);
  expect(subtitleCuesOf(quiet)).toHaveLength(2);
});

test("a line without words is not a caption; a line over a title or end card has none there; a line inside one shot is one cue", () => {
  expect(subtitleCuesOf(resolved([{ startSeconds: 3, durationSeconds: 2 }]))).toEqual([]);
  /* 0.5-2 s is the title card: nothing to caption it on. 1.5-4 s: the part on the first shot only. */
  const overTitle = resolved([{ startSeconds: 0.5, durationSeconds: 3.5, text: "alpha beta gamma delta" }]);
  const cues = subtitleCuesOf(overTitle);
  expect(cues).toHaveLength(1);
  expect(cues[0].startMs).toBe(2000);
  expect(cues[0].endMs).toBe(4000);
  expect(subtitleCuesOf(resolved([{ startSeconds: 3, durationSeconds: 2, text: "a short line" }])).map((cue) => [cue.startMs, cue.endMs, cue.text])).toEqual([[3000, 5000, "a short line"]]);
});

test("Hindi lines caption and subtitle exactly as English ones do: the words are kept whole, in order, in both files", () => {
  const timeline = resolved([{ startSeconds: 3, durationSeconds: 3, text: HINDI[0] }, { startSeconds: 7.5, durationSeconds: 4, text: HINDI[1] }]);
  const cues = subtitleCuesOf(timeline);
  expect(cues.map((cue) => cue.text).join(" ")).toBe(`${HINDI[0]} ${HINDI[1]}`);
  const srt = subtitleText("srt", cues);
  const vtt = subtitleText("vtt", cues);
  for (const file of [srt, vtt]) for (const word of HINDI.join(" ").split(" ")) expect(file).toContain(word);
  expect(srt.startsWith("1\n00:00:03,000 --> 00:00:06,000\n")).toBe(true);
  expect(vtt.startsWith("WEBVTT\n\n1\n00:00:03.000 --> 00:00:06.000\n")).toBe(true);
});

test("voice lines still cannot overlap, and text is held to the template's length", () => {
  expect(() => resolved([{ startSeconds: 3, durationSeconds: 3, text: "a" }, { startSeconds: 5, durationSeconds: 3, text: "b" }])).toThrow(/overlaps/);
  expect(() => resolved([{ startSeconds: 3, durationSeconds: 3, text: "x".repeat(161) }])).toThrow(/at most 160/);
});

/* ---- the real tenant database, an in-memory worker ---- */

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null } as unknown as TenantWorkspace);
const OWNER = { id: "u_owner", role: "member" }, MATE = { id: "u_mate", role: "member" };
const FACTS = async () => ({ durationSeconds: 10, width: 1920, height: 1080 });
const LIMITS = { maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 3, runTimeoutMs: 200_000, queueExpiryMs: 30 * 60_000 };

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
  const client = db();
  const board = draft.mappedId("prj_wb_", ws.id, "u_owner", "d1");
  await client.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "Private board"] });
  await client.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_owner:d1", "u_owner", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1" }), ]});
  for (const [id, role] of [["u_owner", "member"], ["u_mate", "member"]]) {
    await client.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,0)", args: [id, `${id}@example.test`, id, "x", role] });
  }
  const take = (id: string, kind: "video" | "audio", projectId: string | null, seconds: number | null = null) => client.execute({
    sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes,duration_s) VALUES(?,?,?,?,?,1,1,?,0,'u_owner',?,'/stored/x',1000,?)",
    args: [id, "m", "a take", "{}", "succeeded", kind, projectId, seconds],
  });
  await take("take_a", "video", null);
  await take("take_b", "video", null);
  await take("take_private", "video", board);
  await take("voice_en", "audio", null, 3);
  await take("voice_hi", "audio", null, 3.5);
  await take("voice_private", "audio", board, 3);
  await take("voice_nolength", "audio", null, null);
  await client.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes,duration_s) VALUES('voice_making','m','p','{}','running',1,1,'audio',0,'u_owner',NULL,NULL,NULL,NULL)", args: [] });
  await client.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,duration_s,uploader_id) VALUES('music_up','m.mp3','audio/mpeg','mp3',100,'x',NULL,NULL,'/stored/m.mp3',1,'audio',30,'u_owner')", args: [] });
  await client.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,duration_s,uploader_id) VALUES('voice_up','v.mp3','audio/mpeg','mp3',100,'x',NULL,NULL,'/stored/v.mp3',1,'audio',2,'u_owner')", args: [] });
  const resolverFor = (viewer: { id: string; role?: string }) => inputs.createMediaResolver(viewer, { facts: FACTS });
  const pool = exportWorkerPool();
  const deps = (extra: Record<string, unknown> = {}) => ({ enabled: () => true, limits: () => LIMITS, resolver: resolverFor, reach: async () => true, loader: async () => Buffer.from("bytes"), worker: { config: pool.config, fetch: pool.fetch }, ...extra });
  const rows = async () => Number((await client.execute("SELECT COUNT(*) AS n FROM export_jobs")).rows[0].n);
  return { ...jobs, ...inputs, db, pool, deps, rows, resolverFor, ws };
}

test("the agent can run it: a film with an English and a Hindi voice is admitted free, runs to ready, and the worker gets files, never addresses", async () => context("assemble-run", async (m) => {
  const seen: { spec: Record<string, unknown> | null; files: string[] }[] = [];
  m.pool.behave({ during: (session) => { seen.push({ spec: session.spec, files: session.files }); } });
  const english = assembleToExport(assembleSchema.parse(film()));
  const hindi = assembleToExport(assembleSchema.parse({ ...film({ voice: [{ take: "voice_hi", startSeconds: 2.5, text: HINDI[0] }, { take: "voice_en", startSeconds: 9, text: HINDI[1] }] }), requestId: "film-request-0002" }));
  const a = await m.createExport(english, OWNER, m.deps());
  expect(a).toMatchObject({ scheduled: true, duplicate: false });
  expect(a.job).toMatchObject({ composition: "final", status: "queued", price: { credits: 0, label: "Free" }, error: null });
  expect(await m.runExport(a.job.id, m.deps())).toBeUndefined();
  const done = await m.getExport("u_owner", a.job.id, m.deps());
  expect(done).toMatchObject({ status: "ready", error: null });
  expect(done.outputs.map((o) => o.kind)).toEqual(expect.arrayContaining(["video", "subtitle"]));
  const spec = seen[0].spec as { props: { voiceover: { file: string; text: string; startSeconds: number }[]; music: { file: string }; clips: { source: { file: string } }[] } };
  expect(spec.props.clips.map((c) => c.source.file)).toEqual(["m1.mp4", "m2.mp4"]);
  expect(spec.props.voiceover.map((v) => [v.file, v.text, v.startSeconds])).toEqual([["voice1.mp3", "Every great film", 2.5], ["voice2.mp3", "starts small", 9]]);
  expect(spec.props.music.file).toBe("music1.mp3");
  expect(seen[0].files).toEqual(expect.arrayContaining(["input/m1.mp4", "input/m2.mp4", "input/voice1.mp3", "input/voice2.mp3", "input/music1.mp3"]));
  expect(JSON.stringify(spec)).not.toMatch(/https?:|stored|\/api\//);
  /* The Hindi cut is another film of the same shots: its words arrive whole. */
  const b = await m.createExport(hindi, OWNER, m.deps());
  await m.runExport(b.job.id, m.deps());
  expect((await m.getExport("u_owner", b.job.id, m.deps())).status).toBe("ready");
  const hindiSpec = seen[1].spec as { props: { voiceover: { text: string }[] } };
  expect(hindiSpec.props.voiceover.map((v) => v.text)).toEqual(HINDI);
}));

test("it is idempotent per request id: the same film returns the job it started, a different film under that id is refused", async () => context("assemble-idempotent", async (m) => {
  const request = assembleToExport(assembleSchema.parse(film()));
  const first = await m.createExport(request, OWNER, m.deps());
  const again = await m.createExport(assembleToExport(assembleSchema.parse(film())), OWNER, m.deps());
  expect(again).toMatchObject({ duplicate: true });
  expect(again.job.id).toBe(first.job.id);
  expect(await m.rows()).toBe(1);
  await expect(m.createExport(assembleToExport(assembleSchema.parse(film({ duck: 0.5 }))), OWNER, m.deps())).rejects.toMatchObject({ status: 409 });
  expect(await m.rows()).toBe(1);
}));

test("the fair-share limits hold for films: past the workspace's hourly share the film is refused with when to try again, and nothing is written", async () => context("assemble-fair", async (m) => {
  for (let i = 1; i <= LIMITS.maxPerHourPerWorkspace; i += 1) {
    const created = await m.createExport(assembleToExport(assembleSchema.parse({ ...film(), requestId: `film-request-fair${i}` })), OWNER, m.deps());
    await m.cancelExport("u_owner", created.job.id, m.deps());
  }
  const refused = await m.createExport(assembleToExport(assembleSchema.parse({ ...film(), requestId: "film-request-fair9" })), OWNER, m.deps()).catch((e) => e);
  expect(refused).toMatchObject({ status: 429 });
  expect(refused.message).toContain("Nothing was started or billed");
  expect(await m.rows()).toBe(LIMITS.maxPerHourPerWorkspace);
}));

test("whose files: an audio take resolves in its own workspace for people who can reach it, and answers as an unknown id for anyone else", async () => {
  await context("assemble-reach", async (m) => {
    const unknown = await m.resolverFor(MATE).audio({ take: "voice_nothing" }).catch((e) => e);
    expect(unknown).toMatchObject({ status: 404 });
    const hidden = await m.resolverFor(MATE).audio({ take: "voice_private" }).catch((e) => e);
    expect(hidden).toMatchObject({ status: 404, message: unknown.message });
    expect(await m.resolverFor(OWNER).audio({ take: "voice_private" })).toMatchObject({ origin: "take", id: "voice_private", durationSeconds: 3, ext: "mp3" });
    expect(await m.resolverFor(MATE).audio({ take: "voice_en" })).toMatchObject({ origin: "take", id: "voice_en" });
    /* A video take is not a voice; a voice take is not a shot. */
    await expect(m.resolverFor(OWNER).audio({ take: "take_a" })).rejects.toMatchObject({ status: 404 });
    await expect(m.resolverFor(OWNER).video({ take: "voice_en" })).rejects.toMatchObject({ status: 404 });
    /* One still being made waits; one with no recorded length cannot be placed. */
    await expect(m.resolverFor(OWNER).audio({ take: "voice_making" })).rejects.toMatchObject({ status: 409 });
    await expect(m.resolverFor(OWNER).audio({ take: "voice_nolength" })).rejects.toMatchObject({ status: 422 });
    await m.db().execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes,duration_s) VALUES('voice_a_only','m','p','{}','succeeded',1,1,'audio',0,'u_owner',NULL,'/stored/x',1000,3)", args: [] });
    expect(await m.resolverFor(OWNER).audio({ take: "voice_a_only" })).toMatchObject({ id: "voice_a_only" });
    /* Through the request: refused before a row is written. */
    const secret = assembleToExport(assembleSchema.parse({ ...film({ voice: [{ take: "voice_private", startSeconds: 2 }] }), requestId: "film-request-reach1", output: undefined }));
    await expect(m.createExport(secret, MATE, m.deps())).rejects.toMatchObject({ status: 404 });
    expect(await m.rows()).toBe(0);
    expect((await m.createExport(secret, OWNER, m.deps())).duplicate).toBe(false);
  });
  /* Another workspace holds none of it: the same ids are simply not there. */
  await context("assemble-other", async (m) => {
    await expect(m.resolverFor(OWNER).audio({ take: "voice_a_only" })).rejects.toMatchObject({ status: 404 });
    const request = assembleToExport(assembleSchema.parse({ ...film({ voice: [{ take: "voice_a_only", startSeconds: 2 }] }), requestId: "film-request-other1", output: undefined }));
    await expect(m.createExport(request, OWNER, m.deps())).rejects.toMatchObject({ status: 404 });
    expect(await m.rows()).toBe(0);
  });
});

test("the job asks again when it runs: an audio take deleted in between ends the film as failed, Nothing billed, with nothing sent to the worker", async () => context("assemble-gone", async (m) => {
  const created = await m.createExport(assembleToExport(assembleSchema.parse(film())), OWNER, m.deps({ reach: undefined }));
  await m.db().execute("UPDATE generations SET deleted=1 WHERE id='voice_en'");
  await m.runExport(created.job.id, m.deps({ reach: undefined }));
  expect(await m.getExport("u_owner", created.job.id, m.deps({ reach: undefined }))).toMatchObject({ status: "failed", error: "A file in the export is not available any more. Nothing billed." });
  expect(m.pool.calls).toEqual([]);
}));

test("the tool is declared as rule 11 asks: an id, who may call, the same route family and gate as exports, a price of 0", async () => {
  const { ASSEMBLE_TOOL, EXPORT_TOOL } = await import("../../lib/exports/tool");
  expect(ASSEMBLE_TOOL).toMatchObject({ id: "assemble_film", kind: "app-action", callers: "render", route: "/api/exports/assemble", composition: "final", priceLabel: "Free", keys: EXPORT_TOOL.keys });
  expect(ASSEMBLE_TOOL.price()).toEqual({ credits: 0, label: "Free" });
  expect(EXPORT_TOOL.compositions).toContain(ASSEMBLE_TOOL.composition);
});

test("an outside agent runs it over MCP: one POST to the assemble route, free, and a link to collect it; off, it does not exist", async () => {
  const { runTool, EXPORT_TOOLS } = await import("../../lib/mcp");
  const calls: { path: string; init: { method?: string; body?: unknown } }[] = [];
  const call = (async (pathname: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path: pathname, init });
    return { job: { id: "export_" + "c".repeat(32), status: "queued", queueLine: "Export queued — you are next", error: null, outputs: [] } };
  }) as never;
  process.env.REMOTION_EXPORTS = "1";
  try {
    const timeline = film().timeline;
    const text = await runTool("assemble_film", { timeline: timeline as never, request_id: "agent-film-0001", output: { subtitles: ["srt"] } as never }, call, "https://app.test");
    expect(calls).toEqual([{ path: "/api/exports/assemble", init: { method: "POST", body: { requestId: "agent-film-0001", timeline, output: { subtitles: ["srt"] } } } }]);
    expect(text).toContain("Export queued — you are next");
    expect(text).toContain("price: Free (0 cr)");
    await expect(runTool("assemble_film", { timeline: timeline as never }, call, "https://app.test", { exports: false })).rejects.toThrow("Unknown tool");
    const tool = EXPORT_TOOLS.find((t) => t.name === "assemble_film")!;
    expect(tool.description).toContain("Free");
    expect(JSON.stringify(tool)).not.toMatch(/\bcredits? (?!it costs no)\d|\$\d|REMOTION_|secret/i);
    /* The schema the route enforces accepts exactly what the tool's own example shapes say. */
    expect(assembleSchema.safeParse({ requestId: "agent-film-0001", timeline }).success).toBe(true);
  } finally {
    delete process.env.REMOTION_EXPORTS;
  }
});

/* An audio take whose tool did not record its length (an older take, an upload from before lengths were kept, another engine's)
   is measured from its stored original at bind time, by the bounded backfill the sound tools use, and the length is written back. */
const GENERATIONS = path.join(process.cwd(), ".data", "generations");
const stamp = `as${Date.now().toString(36)}`;
const written: string[] = [];
test.afterAll(() => { for (const file of written) rmSync(file, { force: true }); });

test("an audio take with no recorded length is measured from its stored file, then recorded; one whose file is missing is refused as before", async () => context("assemble-probe", async (m) => {
  const tone = readFileSync(path.resolve("public/fixtures/tone.mp3"));
  mkdirSync(GENERATIONS, { recursive: true });
  const id = `voice_${stamp}`;
  const file = path.join(GENERATIONS, `${id}.mp3`);
  writeFileSync(file, tone);
  written.push(file);
  const insert = (genId: string) => m.db().execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes,duration_s) VALUES(?,?,?,?,?,1,1,'audio',0,'u_owner',NULL,?,?,NULL)", args: [genId, "elevenlabs", "a line", "{}", "succeeded", `/stored/${genId}.mp3`, tone.byteLength] });
  await insert(id);
  await insert(`voice_${stamp}_gone`);
  const found = await m.resolverFor(OWNER).audio({ take: id });
  expect(found).toMatchObject({ origin: "take", id, ext: "mp3" });
  expect(found.durationSeconds).toBeGreaterThan(2.5);
  expect(found.durationSeconds).toBeLessThan(3.5);
  expect(Number((await m.db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [id] })).rows[0].duration_s)).toBeCloseTo(found.durationSeconds, 3);
  /* Through a whole film: admitted. */
  const request = assembleToExport(assembleSchema.parse({ ...film({ voice: [{ take: id, startSeconds: 2, text: "from a take with no recorded length" }] }), requestId: "film-request-probe1" }));
  const created = await m.createExport(request, OWNER, m.deps());
  expect(created.duplicate).toBe(false);
  /* No stored file to read: still refused with the same plain words. */
  await expect(m.resolverFor(OWNER).audio({ take: `voice_${stamp}_gone` })).rejects.toMatchObject({ status: 422 });
}));
