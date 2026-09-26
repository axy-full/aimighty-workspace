import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { Step } from "../../lib/atomik";

/**
 * The Atomik rail's prices (audit: suites-atomik-ui).
 *
 * The rail used to take a step's estimate — the ENGINE'S dollars — and print
 * it as credits: $0.90 read "1 cr" on a Continue that billed 14, and an
 * audio step with no estimate read "0 cr" and was charged anyway, with no
 * ceiling on the approval. Now the server hands a credit workspace each
 * figure as admission bills it, the checkpoint is priced by the route that
 * will run it, and Continue sends that price as the ceiling.
 *
 * Nothing here reaches a provider: fetch is forbidden and the engines mocked.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-rail-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const step = (patch: Partial<Step>): Step => ({
  id: "astp_1", chatId: "ach_1", messageId: "amsg_1", position: 0, kind: "video", title: "Push in", prompt: "A slow push in on a bottle.",
  model: "seedance-2.0", params: { ratio: "16:9", resolution: "1080p", seconds: 5 }, refs: [], status: "proposed", genId: null,
  estCostUsd: null, error: null, createdAt: 1, ...patch,
});

async function inWorkspace<T>(name: string, platformKeys: boolean, fn: () => Promise<T>): Promise<T> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,?,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`, platformKeys ? 1 : 0],
  });
  if (platformKeys) await grantCredits(name, 10000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the rail pricing test"); };
  try {
    return await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      return fn();
    }, actor);
  } finally {
    globalThis.fetch = fetch;
  }
}

/** A chat with one planning turn and four steps: an own-engine shot, an old audio row with no estimate, one that ran, and a connected one. */
async function seedChat(videoModel: string, videoUsd: number) {
  const { db, now } = await import("../../lib/db");
  const { createChat } = await import("../../lib/atomik");
  const chatId = await createChat({ userId: "owner", projectId: "project", model: "auto", agentMode: "ask" });
  const ts = now();
  await db().execute({ sql: "INSERT INTO atomik_messages(id,chat_id,role,text,cost_usd,model,created_at) VALUES('amsg_1',?,'assistant','Three shots.',0.02,'auto',?)", args: [chatId, ts] });
  await db().execute({ sql: "UPDATE atomik_chats SET text_cost_usd=0.02 WHERE id=?", args: [chatId] });
  const insert = (id: string, position: number, kind: string, model: string, params: Record<string, unknown>, status: string, genId: string | null, est: number | null) =>
    db().execute({
      sql: `INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,gen_id,est_cost_usd,created_at,updated_at)
            VALUES(?,?,'amsg_1',?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, chatId, position, kind, `Step ${position}`, "A slow push in on a bottle.", model, JSON.stringify(params), status, genId, est, ts, ts],
    });
  await insert("astp_video", 0, "video", videoModel, { ratio: "16:9", resolution: "1080p", seconds: 5 }, "proposed", null, videoUsd);
  await insert("astp_audio", 1, "audio", "elevenlabs", { seconds: 4 }, "proposed", null, null);
  await insert("astp_done", 2, "video", videoModel, { ratio: "16:9", resolution: "1080p", seconds: 5 }, "done", "gen_done", 0.9);
  await insert("astp_connected", 3, "video", "connected:kling3_0", { connected: { jobId: "11111111-1111-4111-8111-000000000001", draftId: "d", credits: 42, workspaceId: "w" } }, "proposed", null, null);
  return chatId;
}

test("one body is quoted, approved and estimated, and the approval carries the quote as its ceiling", async () => {
  const { stepRender, readStepQuote, approvedBody } = await import("../../lib/atomikStepRender");
  const video = stepRender(step({ refs: [{ uploadId: "up_1", role: "reference_image" }] }), "project");
  expect(video).toEqual({
    url: "/api/generate", quoteUrl: "/api/generate/quote",
    body: { prompt: "A slow push in on a bottle.", model: "seedance-2.0", projectId: "project", ratio: "16:9", resolution: "1080p", duration: 5, references: [{ uploadId: "up_1", role: "reference_image" }], refine: false },
  });
  const audio = stepRender(step({ kind: "audio", model: "elevenlabs", title: "Rain", prompt: "Rain on a tin roof", params: { seconds: 4 } }), null);
  expect(audio).toEqual({ url: "/api/audio", quoteUrl: "/api/audio", body: { task: "sound", text: "Rain on a tin roof", projectId: null, title: "Rain", durationSeconds: 4 } });

  const fingerprint = "a".repeat(64);
  const quote = readStepQuote({ estimatedCredits: 14, price: 14, unit: "cr", fingerprint }, video);
  expect(quote).toEqual({ estimatedCredits: 14, price: 14, fingerprint });
  // /api/generate checks a fingerprint, so a generation quote without one is no quote.
  expect(readStepQuote({ estimatedCredits: 14, price: 14, unit: "cr" }, video)).toBeNull();
  expect(readStepQuote({ estimatedCredits: -1, price: 14, unit: "cr", fingerprint }, video)).toBeNull();
  expect(readStepQuote({ estimatedCredits: 1.5, price: 14, unit: "cr", fingerprint }, video)).toBeNull();
  expect(readStepQuote({ estimatedCredits: 14, price: 14, unit: "eur", fingerprint }, video)).toBeNull();
  expect(readStepQuote({ error: "Pick a voice." }, audio)).toBeNull();
  const sound = readStepQuote({ estimatedCredits: 2, price: 2, unit: "cr" }, audio)!;
  expect(sound).toEqual({ estimatedCredits: 2, price: 2, fingerprint: null });

  expect(approvedBody(video, quote!)).toEqual({ ...video.body, maxCredits: 14, quoteFingerprint: fingerprint });
  expect(approvedBody(audio, sound)).toEqual({ ...audio.body, maxCredits: 2 });
});

test("the checkpoint quote asks the route that runs the step, and only a failure worth repeating is retried", async () => {
  const { stepRender, fetchStepQuote, quoteMoved } = await import("../../lib/atomikStepRender");
  const video = stepRender(step({}), "project");
  const audio = stepRender(step({ kind: "audio", model: "elevenlabs", title: "Line", prompt: "Cold, clear.", params: { task: "speech" } }), null);
  const fingerprint = "c".repeat(64);
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const answer = (status: number, value: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  expect(await fetchStepQuote(video, "scope-1", undefined, answer(200, { estimatedCredits: 14, price: 14, unit: "cr", fingerprint })))
    .toEqual({ quote: { estimatedCredits: 14, price: 14, fingerprint } });
  // The body is the exact request Continue sends, with the workbench scope the quote route requires.
  expect(calls[0]).toEqual({ url: "/api/generate/quote", headers: { "Content-Type": "application/json", "X-Workbench-Scope": "scope-1" }, body: video.body });
  // Audio is quoted by /api/audio itself, in quote mode.
  expect(await fetchStepQuote(audio, "", undefined, answer(400, { error: "Pick a voice." }))).toEqual({ error: "Pick a voice.", retry: false });
  expect(calls[1]).toEqual({ url: "/api/audio", headers: { "Content-Type": "application/json" }, body: { ...audio.body, quoteOnly: true } });
  // A refusal of the request stands; a failing or busy route, a dropped connection and a malformed answer are asked again.
  expect(await fetchStepQuote(video, "s", undefined, answer(409, { error: "Your account or workspace changed." }))).toEqual({ error: "Your account or workspace changed.", retry: false });
  expect(await fetchStepQuote(video, "s", undefined, answer(500, {}))).toEqual({ error: "This step could not be priced.", retry: true });
  expect(await fetchStepQuote(video, "s", undefined, answer(429, { error: "Slow down." }))).toEqual({ error: "Slow down.", retry: true });
  expect(await fetchStepQuote(video, "s", undefined, answer(200, { estimatedCredits: 14, price: 14, unit: "cr" }))).toMatchObject({ retry: true });
  const offline = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  expect(await fetchStepQuote(video, "s", undefined, offline)).toMatchObject({ retry: true });
  // An abandoned quote is dropped, not reported.
  const controller = new AbortController(); controller.abort();
  const aborted = (async () => { throw new DOMException("Aborted", "AbortError"); }) as typeof fetch;
  await expect(fetchStepQuote(video, "s", controller.signal, aborted)).rejects.toThrow("Aborted");

  // Continue re-asks before it claims: a moved price is shown, never spent.
  const shown = { estimatedCredits: 14, price: 14, fingerprint };
  expect(quoteMoved(shown, { ...shown, fingerprint: "d".repeat(64) })).toBe(false);
  expect(quoteMoved(shown, { ...shown, estimatedCredits: 15, price: 15 })).toBe(true);
  expect(quoteMoved({ estimatedCredits: 14, price: 0.9, fingerprint }, { estimatedCredits: 14, price: 0.93, fingerprint })).toBe(true);
});

test("a step's price is the server's figure in the workspace's unit, and nothing unpriced reads as free", async () => {
  const { stepPrice, planTotal } = await import("../../lib/atomikStepRender");
  // Credits come from the server; the browser never converts the engine's dollars.
  expect(stepPrice(step({ estCostUsd: 0.9, estCredits: 14 }), true)).toBe(14);
  expect(stepPrice(step({ estCostUsd: 0.9 }), true)).toBeNull();
  expect(stepPrice(step({ estCostUsd: null, estCredits: null }), true)).toBeNull();
  // A step that ran is what the ledger billed.
  expect(stepPrice(step({ status: "done", estCredits: 14, billedCredits: 13 }), true)).toBe(13);
  // The checkpoint's live quote wins over the estimate.
  expect(stepPrice(step({ estCredits: 14 }), true, { estimatedCredits: 15, price: 15, fingerprint: null })).toBe(15);
  // A workspace that pays its vendors in dollars sees dollars.
  expect(stepPrice(step({ estCostUsd: 0.9, estCredits: 14 }), false)).toBe(0.9);
  expect(stepPrice(step({ estCostUsd: null }), false)).toBeNull();
  expect(stepPrice(step({ estCostUsd: 0.9 }), false, { estimatedCredits: 14, price: 0.92, fingerprint: null })).toBe(0.92);
  expect(planTotal([14, null, 3, 0])).toEqual({ total: 17, unpriced: 1 });
  expect(planTotal([])).toEqual({ total: 0, unpriced: 0 });
});

test("a credit workspace gets each estimate as admission bills it, and planning and run steps as the ledger billed them", async () =>
  inWorkspace("rail-credits", true, async () => {
    const { MODELS } = await import("../../lib/models");
    const { getChat, estimateStepUsd } = await import("../../lib/atomik");
    const { billCredits } = await import("../../lib/creditTerms");
    const { sfxCredits, usdForCredits } = await import("../../lib/elevenlabs");
    const { meter } = await import("../../lib/meter");
    const { executeAudioAdmission } = await import("../../lib/audioAdmission");
    const { prepareGeneration } = await import("../../lib/generationAdmission");
    const { stepRender } = await import("../../lib/atomikStepRender");
    const video = MODELS.find((m) => !m.hidden && m.kind === "video" && (m.supportsTasks ?? ["generate"]).includes("generate"))!;
    const params = { ratio: video.ratios.includes("16:9") ? "16:9" : video.ratios[0], resolution: video.resolutions[0], seconds: video.durations[0] };
    const usd = (await estimateStepUsd("video", video.id, params))!;
    expect(usd).toBeGreaterThan(0);
    const chatId = await seedChat(video.id, usd);
    const { db } = await import("../../lib/db");
    await db().execute({ sql: "UPDATE atomik_steps SET params=? WHERE id='astp_video'", args: [JSON.stringify(params)] });
    await meter({ id: "amsg_1", kind: "text", engine: "vercel", model: "auto", status: "succeeded", engineCostUsd: 0.02, projectId: "project", createdBy: "owner" });
    await meter({ id: "gen_done", kind: "video", engine: video.provider, model: video.id, status: "succeeded", engineCostUsd: 0.9, projectId: "project", createdBy: "owner" });

    const loaded = (await getChat(chatId))!;
    const by = (id: string) => loaded.steps.find((s) => s.id === id)!;
    // The shot: credits at the engine's margin, rounded up per job — not the dollars rounded up.
    expect(by("astp_video").estCredits).toBe(billCredits(usd, video.id));
    expect(by("astp_video").estCredits).toBeGreaterThan(Math.ceil(usd));
    // The old audio row is priced exactly as /api/audio prices a sound effect.
    const soundUsd = usdForCredits(sfxCredits(), null);
    expect(by("astp_audio").estCostUsd).toBe(soundUsd);
    expect(by("astp_audio").estCredits).toBe(billCredits(soundUsd, "elevenlabs"));
    // What ran reads what the ledger billed it: $0.90 at 1.5x over $0.10 is 14 credits, never "1 cr".
    expect(by("astp_done").billedCredits).toBe(14);
    expect(by("astp_video").billedCredits).toBeNull();
    // A connected step is priced in connected credits elsewhere, never here.
    expect(by("astp_connected").estCredits).toBeNull();
    expect(loaded.chat.textCredits).toBe(billCredits(0.02, "text"));

    // The rail's estimate is the admission's own price for the exact body Continue sends.
    const options = { defer: async () => {} };
    const audioQuote = await executeAudioAdmission({ ...stepRender(by("astp_audio"), "project").body, quoteOnly: true }, actor, options);
    expect(audioQuote.status).toBe(200);
    expect(audioQuote.body).toMatchObject({ estimatedCredits: by("astp_audio").estCredits, unit: "cr" });
    const prepared = await prepareGeneration(stepRender(by("astp_video"), "project").body, actor);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (prepared.ok) expect(prepared.value.quote).toMatchObject({ estimatedCredits: by("astp_video").estCredits, unit: "cr" });
    // A voice line has no voice from the planner: no advance price, and never zero.
    expect(await estimateStepUsd("audio", "elevenlabs", { task: "speech" })).toBeNull();
  }));

test("a workspace that pays its vendors in dollars keeps its dollars and gets no credit figures", async () =>
  inWorkspace("rail-dollars", false, async () => {
    const { getChat } = await import("../../lib/atomik");
    const chatId = await seedChat("seedance-2.0", 0.9);
    const loaded = (await getChat(chatId))!;
    expect(loaded.chat.textCredits).toBeUndefined();
    expect(loaded.chat.textCostUsd).toBe(0.02);
    for (const s of loaded.steps) {
      expect(s.estCredits).toBeUndefined();
      expect(s.billedCredits).toBeUndefined();
    }
    expect(loaded.steps.find((s) => s.id === "astp_done")!.estCostUsd).toBe(0.9);
    // The old audio row still gets its dollar estimate.
    expect(loaded.steps.find((s) => s.id === "astp_audio")!.estCostUsd).toBeGreaterThan(0);
  }));
