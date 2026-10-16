import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { wav } from "./audioFixtures";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * The Hindi version (lib/hindiVersion.ts): one plan over the existing tools. Mocked: Sarvam's calls are functions this file hands the steps, the lip-sync worker is
 * driven by this file's fake vendor, and the in-process fixtures cover the rest; no request leaves this process and no provider is paid. Local temporary databases
 * only. SARVAM_USD_PER_INR is a SAMPLE rate here.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-hindi-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
const realFetch = globalThis.fetch;
/* The adapters run for real against a stubbed network: Sarvam's own request shape in, its reply shape out (lib/sarvam.ts). Nothing leaves this process. */
test.beforeEach(() => { process.env.ENGINE_MOCK = "0"; process.env.SARVAM_API_KEY = "sample-key"; process.env.SYNC_API_KEY = "sample-key"; process.env.SARVAM_USD_PER_INR = "0.012"; process.env.SARVAM_ENABLED = "1"; process.env.SYNC_ENABLED = "1"; });
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.SARVAM_ENABLED; delete process.env.SYNC_ENABLED; delete process.env.SARVAM_USD_PER_INR; delete process.env.SARVAM_API_KEY; delete process.env.SYNC_API_KEY; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const deferred: (() => Promise<unknown>)[] = [];
const options = (): AdmissionExecution => ({ defer: async (work) => { deferred.push(work); } });

async function clipUpload(seconds: number, uploader: string | null = null): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid("clip");
  const bytes = Buffer.from(`sample-video-${id}`);
  await storeUpload(id, "mp4", bytes, "video/mp4");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.mp4`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s,uploader_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.mp4`, "video/mp4", "mp4", bytes.length, "x", `uploads/${id}.mp4`, Date.now(), "video", seconds, uploader] });
  return id;
}
async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
async function meter(engine: "sarvam" | "syncso") {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute({ sql: "SELECT id,status,engine_cost_usd FROM meter_events WHERE engine=? ORDER BY created_at, id", args: [engine] })).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql: "SELECT status,kind,shot_id,prompt,json_extract(params,'$.hindi') AS hindi FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
}

/** Sarvam's network, stubbed: translate answers the English wrapped in Hindi, speech answers a WAV of the given length; a text containing `failTranslateOn` is refused 422. */
function fakeSarvam(over: { speechSeconds?: number; failTranslateOn?: string } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    if (u.endsWith("/translate")) {
      calls.push(`translate:${body.input}`);
      if (over.failTranslateOn && body.input.includes(over.failTranslateOn)) return new Response(JSON.stringify({ message: "Sarvam is down" }), { status: 422 });
      return Response.json({ translated_text: `हिंदी ${body.input}` });
    }
    if (u.endsWith("/text-to-speech")) { calls.push(`speak:${body.text}`); return Response.json({ audios: [wav(over.speechSeconds ?? 3).toString("base64")] }); }
    throw new Error(`The network is closed: ${u}`);
  }) as typeof fetch;
  return { seams: {} as import("../../lib/hindiVersion").HindiSeams, calls };
}
function fakeSync() {
  let polls = 0, assets = 0;
  return {
    upload: async () => `asset_${++assets}`, submit: async () => ({ id: "job_1" }),
    status: async () => (++polls < 2 ? { id: "job_1", status: "processing" as const } : { id: "job_1", status: "completed" as const, outputUrl: "https://example.invalid/out.mp4", outputDuration: 4 }),
    download: async () => Buffer.from("lip-synced-clip"), store: async (genId: string, bytes: Buffer) => ({ url: `stored/${genId}.mp4`, bytes: bytes.length }),
    deleteJob: async () => true, deleteAsset: async () => true,
  };
}
async function admit(body: Record<string, unknown>, seams: import("../../lib/hindiVersion").HindiSeams = {}, actor: AdmissionActor = OWNER) {
  const { admitHindiVersion } = await import("../../lib/hindiVersion");
  return admitHindiVersion(body, actor, options(), seams);
}
const lines = (clip: string) => [
  { text: "Meet the new Particl.", shotId: undefined, clipUploadId: clip, hero: true },
  { hindi: "यह सीधा हिंदी में लिखा है", clipUploadId: clip, hero: false },
  { text: "Make it in minutes." },
];
const stamp = () => `hv_${Date.now().toString(36)}${++n}`;

test("off: with Sarvam off or not priced there is no tool; a plan with a synced shot needs lip-sync too, and says so in words", async () => {
  const { hindiVersionTools } = await import("../../lib/hindiVersion");
  await asTenant(house(), async () => {
    const clip = await clipUpload(4);
    delete process.env.SARVAM_ENABLED;
    expect(await hindiVersionTools()).toEqual([]);
    expect(await admit({ lines: lines(clip), quoteOnly: true })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    process.env.SARVAM_ENABLED = "1";
    expect((await hindiVersionTools()).map((t) => t.id)).toEqual(["hindi_version"]);
    delete process.env.SARVAM_USD_PER_INR;
    expect(await hindiVersionTools()).toEqual([]);
    process.env.SARVAM_USD_PER_INR = "0.012";
    /* Lip-sync off here: a plan with a synced line is refused in words; the voice alone still quotes. */
    delete process.env.SYNC_ENABLED;
    expect(await admit({ lines: lines(clip), quoteOnly: true })).toMatchObject({ status: 400, body: { error: expect.stringContaining("Lip-sync is not on here") } });
    expect((await admit({ lines: lines(clip), lipSync: "none", quoteOnly: true })).status).toBe(200);
  });
});

test("the quote: every step asks its own tool for its price; 'up to', the voice alone for a line that is not synced; a quote writes and holds nothing", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const clip = await clipUpload(4);
    const before = { sarvam: (await meter("sarvam")).length, sync: (await meter("syncso")).length };
    const q = await admit({ lines: lines(clip), quoteOnly: true });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const steps = q.body.steps as { order: number; translate: number; voice: number; lipSync: number; synced: boolean }[];
    expect(q.body).toMatchObject({ lines: 3, synced: 1, voiceOnly: 2, lipSync: "hero", upTo: true });
    /* Line 1 is translated, spoken and synced; line 2 has its Hindi written (no translation) and is not synced; line 3 is translated and spoken. */
    expect(steps.map((s) => [s.translate > 0, s.voice > 0, s.lipSync > 0, s.synced])).toEqual([[true, true, true, true], [false, true, false, false], [true, true, false, false]]);
    expect(Number(q.body.estimatedCredits)).toBe(steps.reduce((t, s) => t + s.translate + s.voice + s.lipSync, 0));
    /* Which shots are synced is the person's: all, none, or the hero lines. */
    expect(await admit({ lines: lines(clip), lipSync: "all", quoteOnly: true })).toMatchObject({ status: 400, body: { error: expect.stringContaining("Line 3 is lip-synced: name its video") } });
    expect(await admit({ lines: lines(clip), lipSync: "none", quoteOnly: true })).toMatchObject({ status: 200, body: { synced: 0, voiceOnly: 3 } });
    expect(await admit({ lines: lines(clip).slice(1), quoteOnly: true })).toMatchObject({ status: 200, body: { synced: 0 } });
    /* Words first. */
    for (const bad of [{ lines: [] }, { lines: [{}] }, { lines: [{ text: "x", shotId: "../x" }] }, { lines: [{ text: "x", clipTakeId: "a", clipUploadId: "b" }] }, { lines: lines(clip), lipSync: "some" }, { lines: Array.from({ length: 25 }, () => ({ text: "x" })) }])
      expect((await admit({ ...bad, quoteOnly: true })).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    expect((await meter("sarvam")).length).toBe(before.sarvam);
    expect((await meter("syncso")).length).toBe(before.sync);
  });
});

test("approval: only a person, once, for the whole plan: no amount, or one under the quote, runs nothing; an agent's approval is refused", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { db, ready } = await import("../../lib/db");
  await asTenant(house(), async () => {
    const clip = await clipUpload(4);
    const q = await admit({ lines: lines(clip), quoteOnly: true });
    const total = Number(q.body.estimatedCredits);
    const f = fakeSarvam();
    const before = (await meter("sarvam")).length;
    expect(await admit({ lines: lines(clip), versionId: stamp() }, f.seams)).toMatchObject({ status: 409, body: { error: expect.stringContaining("Approve the price first") } });
    expect((await admit({ lines: lines(clip), versionId: stamp(), maxCredits: total - 1 }, f.seams)).status).toBe(409);
    expect((await admit({ lines: lines(clip), maxCredits: total }, f.seams)).status).toBe(400);
    expect((await admit({ lines: lines(clip), versionId: "x", maxCredits: total }, f.seams)).status).toBe(400);
    expect(f.calls).toEqual([]);
    expect((await meter("sarvam")).length).toBe(before);
    /* An Atomik run acts for its owner and may prepare, never approve. */
    await ready(); await rigAgentReady();
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_hv", "prod_x", "draft_x", "owner", "req_hv", "goal", "auto", "finished"] });
    const agent: AdmissionActor = { user: { ...OWNER.user, id: "agent:run_hv", role: "member", owner: false } as AdmissionActor["user"] };
    await runInTenant(house(), async () => {
      expect((await admit({ lines: lines(clip), quoteOnly: true }, f.seams, agent)).status).toBe(200);
      expect(await admit({ lines: lines(clip), versionId: stamp(), maxCredits: total }, f.seams, agent)).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
    }, { user: agent.user } as never);
    await runInTenant(house(), async () => {
      expect(await admit({ lines: lines(clip), quoteOnly: true }, f.seams, { user: { ...agent.user, id: "agent:run_none" } as AdmissionActor["user"] })).toMatchObject({ status: 403, body: { error: "A person must be behind this request to use their uploads." } });
    }, { user: { ...agent.user, id: "agent:run_none" } } as never);
    expect(f.calls).toEqual([]);
  });
});

test("the run: translate only what is not written, speak every line, lip-sync only the hero line; the takes are tagged, the status reads them, and a retry buys nothing twice", async () => {
  const { hindiVersionStatus } = await import("../../lib/hindiVersion");
  const { advanceLipSyncJobWith } = await import("../../lib/lipSync");
  await asTenant(house(), async () => {
    const projectId = uid("prod");
    await project(projectId);
    const clip = await clipUpload(4);
    const q = await admit({ lines: lines(clip), projectId, quoteOnly: true });
    const total = Number(q.body.estimatedCredits);
    const f = fakeSarvam({ speechSeconds: 3 });
    const version = stamp();
    const sarvamBefore = (await meter("sarvam")).length, syncBefore = (await meter("syncso")).length;
    deferred.length = 0;
    const r = await admit({ lines: lines(clip), projectId, versionId: version, maxCredits: total }, f.seams);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: version, versionId: version, status: "running", stopped: 0 });
    /* Two translations (lines 1 and 3), three voices, one lip-sync. Line 2's Hindi was written, so it was never sent to be translated. */
    expect(f.calls.filter((c) => c.startsWith("translate:")).sort()).toEqual(["translate:Make it in minutes.", "translate:Meet the new Particl."]);
    expect(f.calls.filter((c) => c.startsWith("speak:")).sort()).toEqual(["speak:हिंदी Make it in minutes.", "speak:हिंदी Meet the new Particl.", "speak:यह सीधा हिंदी में लिखा है"].sort());
    expect((await meter("sarvam")).length - sarvamBefore).toBe(5);
    expect((await meter("syncso")).length - syncBefore).toBe(1);
    expect(Number(r.body.spent)).toBeLessThanOrEqual(total);
    const out = (r.body.lines as { order: number; hindi: string; voiceTakeId: string; syncedTakeId?: string }[]);
    expect(out.map((l) => [l.order, Boolean(l.voiceTakeId), Boolean(l.syncedTakeId)])).toEqual([[0, true, true], [1, true, false], [2, true, false]]);
    expect(out[0].hindi).toBe("हिंदी Meet the new Particl.");
    /* The takes carry the tag the cut reads. */
    expect(await gen(out[0].voiceTakeId)).toMatchObject({ kind: "audio", prompt: "हिंदी Meet the new Particl." });
    expect(JSON.parse(String((await gen(out[0].voiceTakeId)).hindi))).toMatchObject({ version, order: 0, role: "voice" });
    expect(JSON.parse(String((await gen(out[0].syncedTakeId!)).hindi))).toMatchObject({ version, order: 0, role: "synced", of: clip });
    /* The lip-sync worker runs on its own; the status follows the takes. */
    let status = await hindiVersionStatus(version);
    expect(status).toMatchObject({ versionId: version, done: false, failed: 0 });
    const sync = fakeSync();
    for (let i = 0; i < 4; i++) await advanceLipSyncJobWith(out[0].syncedTakeId!, sync);
    status = await hindiVersionStatus(version);
    expect(status?.done).toBe(true);
    expect(status?.lines.map((l) => [l.order, l.voice?.status, l.synced?.status ?? null])).toEqual([[0, "succeeded", "succeeded"], [1, "succeeded", null], [2, "succeeded", null]]);
    expect(status?.lines[1].voice?.hindi).toBe("यह सीधा हिंदी में लिखा है");
    /* The same version again (a retry): everything is made, so nothing is asked of any tool and nothing is bought. */
    const calls = f.calls.length, again = await admit({ lines: lines(clip), projectId, versionId: version, maxCredits: total }, f.seams);
    expect(again.status).toBe(200);
    expect(f.calls.length).toBe(calls);
    expect((await meter("sarvam")).length - sarvamBefore).toBe(5);
    expect((await meter("syncso")).length - syncBefore).toBe(1);
    expect(await hindiVersionStatus("hv_nothing_here")).toBeNull();
  });
});

test("a step that fails costs nothing and stops only its line; a retry under the same version makes only what is missing", async () => {
  await asTenant(house(), async () => {
    const clip = await clipUpload(4);
    const total = Number((await admit({ lines: lines(clip), quoteOnly: true })).body.estimatedCredits);
    const version = stamp();
    const bad = fakeSarvam({ failTranslateOn: "minutes" });
    const before = (await meter("sarvam")).length;
    const first = await admit({ lines: lines(clip), versionId: version, maxCredits: total }, bad.seams);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "partial", stopped: 1 });
    const l = first.body.lines as { order: number; stopped?: boolean; reason?: string; voiceTakeId?: string }[];
    expect(l[2]).toMatchObject({ order: 2, stopped: true, reason: expect.stringContaining("Nothing was billed") });
    expect(l[0].voiceTakeId && l[1].voiceTakeId).toBeTruthy();
    /* Failed translation: its meter line is recorded at nothing. */
    const rows = (await meter("sarvam")).slice(before);
    expect(rows.filter((r) => r.status === "failed").every((r) => Number(r.engine_cost_usd) === 0)).toBe(true);
    const good = fakeSarvam();
    const second = await admit({ lines: lines(clip), versionId: version, maxCredits: total }, good.seams);
    expect(second.body).toMatchObject({ status: "running", stopped: 0 });
    expect(good.calls).toEqual(["translate:Make it in minutes.", "speak:हिंदी Make it in minutes."]);
    /* Every step failing, and nothing started, is an error, not a partial success. */
    const dead = await admit({ lines: [{ text: "Only line" }], versionId: stamp(), maxCredits: total }, fakeSarvam({ failTranslateOn: "Only" }).seams);
    expect(dead.status).toBe(422);
    expect(dead.body).toMatchObject({ error: expect.stringContaining("Nothing was billed") });
  });
});

test("the approved total holds: a step that would take the plan past it is not run, and asks again", async () => {
  await asTenant(house(), async () => {
    const clip = await clipUpload(4);
    const one = [{ hindi: "छोटी पंक्ति", clipUploadId: clip, hero: true }];
    const total = Number((await admit({ lines: one, quoteOnly: true })).body.estimatedCredits);
    /* The voice runs 12 s against the 4 s clip: the lip-sync costs more than the plan estimated (the voice's length is not known until it is spoken). */
    const long = fakeSarvam({ speechSeconds: 12 });
    const before = (await meter("syncso")).length;
    const r = await admit({ lines: one, versionId: stamp(), maxCredits: total }, long.seams);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "partial", stopped: 1 });
    expect((r.body.lines as { reason: string; voiceTakeId: string }[])[0]).toMatchObject({ reason: expect.stringContaining("past the approved amount"), voiceTakeId: expect.any(String) });
    expect((await meter("syncso")).length).toBe(before);
    expect(Number(r.body.spent)).toBeLessThanOrEqual(total);
  });
});

test("the reply the claim keeps has no Hindi in it; the tool is declared beside its handler and over MCP, always asks, and is never filed; the route is the one door", async () => {
  const { recordedHindiReply, HINDI_VERSION_TOOL } = await import("../../lib/hindiVersion");
  const kept = JSON.parse(recordedHindiReply(JSON.stringify({ id: "hv_1", lines: [{ order: 0, hindi: "गुप्त", voiceTakeId: "gen_1" }] })));
  expect(kept).toEqual({ id: "hv_1", lines: [{ order: 0, voiceTakeId: "gen_1" }] });
  expect(recordedHindiReply("not json")).toBe("not json");
  expect(HINDI_VERSION_TOOL).toMatchObject({ id: "hindi_version", route: "/api/hindi-version", who: "prepare: anyone; approve: a person" });
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  await asTenant(house(), async () => {
    expect((await directEngineMcpTools()).map((t) => t.name)).toContain("hindi_version");
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const call = async (p: string, init?: { body?: unknown }) => {
      const body = (init?.body ?? {}) as Record<string, unknown>;
      calls.push({ path: p, body });
      return p === "/api/hindi-version" ? { estimatedCredits: 12, price: 12, unit: "cr" } : {};
    };
    const said = await runDirectEngineTool("hindi_version", { lines_json: JSON.stringify([{ text: "Hello" }]), lip_sync: "none" }, call as never);
    expect(said).toMatch(/Priced, not started/);
    expect(said).toMatch(/12 cr/);
    expect(calls.map((c) => [c.path, c.body.quoteOnly === true])).toEqual([["/api/hindi-version", true]]);
    expect(calls.some((c) => "maxCredits" in c.body)).toBe(false);
    await expect(runDirectEngineTool("hindi_version", { lines_json: "{", maxCredits: 5 } as never, call as never)).rejects.toThrow(/not yours to approve/);
    await expect(runDirectEngineTool("hindi_version", { lines_json: "nope" }, call as never)).rejects.toThrow(/JSON array/);
  });
  const lib = readFileSync("lib/hindiVersion.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  /* No price, vendor call or reservation of its own: it asks the steps. */
  expect(lib).not.toMatch(/reserveGenerationSpend|fetch\(|quotedCredits|creditUsd|from "\.\/sarvam"[^;]*\b(speak|translate)\b|\bsubmitLipSync\b/);
  const route = readFileSync("app/api/hindi-version/route.ts", "utf8");
  expect(route).toContain("requireRender()");
  expect(route).toContain("sampleWorkspaceOff");
  expect(route).toContain("withGenerationRequest");
});

test("the board: the Hindi is placed whole as boardVoice.hi: a voice line per spoken line at its start, a swap per synced take-named shot; a line that overlaps or has no length is left out and named", async () => {
  const { db } = await import("../../lib/db");
  await asTenant(house(), async () => {
    /* The cut's take for the synced shot is a video take (a generation) of 4 s, so a swap can name it. */
    const clip = await clipUpload(4);
    const { ready } = await import("../../lib/db");
    await ready();
    const cutTake = uid("gen_cut");
    await db().execute({ sql: "INSERT INTO generations (id, kind, model, prompt, params, status, created_by, created_at, updated_at, stored_url, duration_s) VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: [cutTake, "video", "sample-model", "a shot", "{}", "succeeded", "owner", Date.now(), Date.now(), `generations/${cutTake}.mp4`, 4] });
    const three = [
      { text: "Meet the new Particl.", clipTakeId: cutTake, hero: true },
      { hindi: "दूसरी पंक्ति", clipUploadId: clip },
      { hindi: "तीसरी पंक्ति", startSeconds: 20 },
    ];
    const seen: { owner: string; draftId: string; voice: import("../../lib/v12/board/cut-data").LanguageVoice }[] = [];
    const draft = async (owner: string, draftId: string, voice: import("../../lib/v12/board/cut-data").LanguageVoice) => { seen.push({ owner, draftId, voice }); return { written: voice.lines.length }; };
    const q = await admit({ lines: three, draftId: "board_1", quoteOnly: true });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    fakeSarvam({ speechSeconds: 3 });
    const r = await admit({ lines: three, draftId: "board_1", versionId: stamp(), maxCredits: Number(q.body.estimatedCredits) }, { draft });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ owner: "owner", draftId: "board_1" });
    const lines3 = r.body.lines as { voiceTakeId: string; syncedTakeId?: string }[];
    /* Line 1 starts at 0 (3 s of Hindi in a 4 s shot), line 2 at 4 (the shot's own length), line 3 where it was told. Each is a recorded-length audio take. */
    expect(seen[0].voice.lines.map((l) => [l.take === lines3[0].voiceTakeId || l.take === lines3[1].voiceTakeId || l.take === lines3[2].voiceTakeId, l.startSeconds])).toEqual([[true, 0], [true, 4], [true, 20]]);
    expect(seen[0].voice.lines[0].text).toBe("हिंदी Meet the new Particl.");
    expect(seen[0].voice.swap).toEqual({ [cutTake]: lines3[0].syncedTakeId });
    expect(r.body.draft).toMatchObject({ language: "hi", written: 3, swaps: 1 });
    expect(JSON.stringify(r.body.draft)).not.toContain("left");
    for (const l of seen[0].voice.lines) expect(Number((await db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [l.take] })).rows[0].duration_s)).toBeGreaterThan(0);
    /* A voice longer than its slot is named, and left out of the draft rather than overlapped. */
    fakeSarvam({ speechSeconds: 6 });
    const q2 = await admit({ lines: three.slice(0, 2), draftId: "board_1", quoteOnly: true });
    const r2 = await admit({ lines: three.slice(0, 2), draftId: "board_1", versionId: stamp(), maxCredits: Number(q2.body.estimatedCredits) + 20 }, { draft });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.draft).toMatchObject({ written: 1, left: [{ order: 0, why: expect.stringContaining("past its slot") }] });
    /* No start to go on: said in words, before anything is bought. */
    expect((await admit({ lines: [{ text: "One" }, { text: "Two" }], draftId: "board_1", quoteOnly: true })).status).toBe(400);
    expect((await admit({ lines: [{ text: "One", startSeconds: -1 }], quoteOnly: true })).status).toBe(400);
    expect((await admit({ lines: [{ text: "One" }], draftId: "../x", quoteOnly: true })).status).toBe(400);
  });
});

test("the board: written through the real draft path, the language replaces itself whole and the rest of the draft is untouched; no board there is said, not thrown", async () => {
  const { writeHindiToDraft } = await import("../../lib/hindiVersion");
  const { newProject } = await import("../../lib/workbench/studio");
  const { saveDraft, readDraft } = await import("../../lib/workbench/records");
  await asTenant(house(), async () => {
    const id = uid("board");
    const draft = { ...newProject("A board"), id, boardVoice: { fr: { lines: [{ take: "gen_fr", startSeconds: 0, text: "bonjour" }] }, hi: { lines: [{ take: "gen_old", startSeconds: 1, text: "पुराना" }] } } };
    await saveDraft("owner", draft as never, 0);
    expect(await writeHindiToDraft("owner", id, { lines: [{ take: "gen_new", startSeconds: 0, text: "नया" }], swap: { gen_a: "gen_b" } })).toEqual({ written: 1 });
    const after = await readDraft("owner", id);
    expect(after?.project.boardVoice).toEqual({ fr: { lines: [{ take: "gen_fr", startSeconds: 0, text: "bonjour" }] }, hi: { lines: [{ take: "gen_new", startSeconds: 0, text: "नया" }], swap: { gen_a: "gen_b" } } });
    expect(after?.revision).toBe(2);
    expect(after?.project.name).toBe("A board");
    expect(await writeHindiToDraft("owner", uid("none"), { lines: [] })).toMatchObject({ written: 0, note: "That board is not here." });
  });
});

test("a customer workspace on the list pays in credits what each step quotes, once, within the approved total; one at its own $0 cap is refused in the cap's words with nothing held or written", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  await platformReady();
  const make = async (id: string, allowance: number | null) => {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, allowance] });
    await grantCredits(id, 500, "Test", "owner", "manual");
    return (await getWorkspace(id))!;
  };
  const open = await make("ws_hindi_listed", null), capped = await make("ws_hindi_capped", 0);
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const setSite = (v: unknown) => platformDb().execute({ sql: "INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [JSON.stringify(v)] });
  const billed = async (ws: string) => (await platformDb().execute({ sql: "SELECT billed_credits, status FROM meter_events WHERE workspace_id=? AND engine='sarvam' ORDER BY created_at", args: [ws] })).rows;
  try {
    await setSite({ enginesOnWorkspaces: ["ws_hindi_listed", "ws_hindi_capped"] });
    const two = [{ text: "Meet the new Particl." }, { hindi: "यह सीधा हिंदी में लिखा है" }];
    await asTenant(open, async () => {
      const q = await admit({ lines: two, lipSync: "none", quoteOnly: true });
      expect(q.body).toMatchObject({ unit: "cr", lines: 2, synced: 0 });
      const total = Number(q.body.estimatedCredits);
      fakeSarvam();
      const before = (await creditState())!.balance;
      const r = await admit({ lines: two, lipSync: "none", versionId: stamp(), maxCredits: total });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const rows = await billed("ws_hindi_listed");
      expect(rows).toHaveLength(3);
      const paid = rows.reduce((n, x) => n + Number(x.billed_credits), 0);
      expect(paid).toBe(Number(r.body.spent));
      expect(paid).toBeLessThanOrEqual(total);
      expect((await creditState())!.balance).toBeCloseTo(before - paid, 6);
    });
    await asTenant(capped, async () => {
      fakeSarvam();
      const q = await admit({ lines: two, lipSync: "none", quoteOnly: true });
      const r = await admit({ lines: two, lipSync: "none", versionId: stamp(), maxCredits: Number(q.body.estimatedCredits) });
      expect(r.status, JSON.stringify(r.body)).toBe(429);
      expect(String(r.body.error).replace(/^Line \d+: /, "")).not.toMatch(/\$|\d/);
      expect(await billed("ws_hindi_capped")).toHaveLength(0);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});
