import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Atomik steps from proposal to render (audit, 25 September): an engine
 * change carries the settings the new engine can make, the planner may only
 * propose engines the workspace left on, a claim cut off before its render
 * is settled from the render request's record, and the planner is told
 * about the workspace-wide cast.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-steps-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = "dreamina-seedance-2-5-260628";
const SEEDANCE_2 = "dreamina-seedance-2-0-260128";
const KLING = "fal-ai/kling-video/v3/standard";
const TOPAZ = "topaz/upscale/video/creative";
const STILL = "gemini-3-pro-image";

let n = 0;
function workspace(): TenantWorkspace {
  const id = `ws${++n}_${Date.now().toString(36)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false } as TenantWorkspace;
}
async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(workspace(), fn);
}
async function step(fields: { id: string; chat: string; kind?: string; model?: string; params?: Record<string, unknown>; status?: string; updatedAt?: number }) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  const at = fields.updatedAt ?? Date.now();
  await db().execute({
    sql: `INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, est_cost_usd, created_at, updated_at)
          VALUES (?,?,'m',0,?,?,'A slow push-in on a kitchen table.',?,?,'[]',?,NULL,?,?)`,
    args: [fields.id, fields.chat, fields.kind ?? "video", fields.id, fields.model ?? SEEDANCE, JSON.stringify(fields.params ?? {}), fields.status ?? "proposed", at, at],
  });
}

async function chat(id: string, owner: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: `INSERT INTO atomik_chats (id, project_id, title, model, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted) VALUES (?,NULL,'Chat','auto','ask','waiting',0,?,0,0,0)`,
    args: [id, owner],
  });
}
const render = (key: string, body: unknown) => new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });

test("an engine's settings are snapped to the nearest thing it offers", async () => {
  const { fitStepParams } = await import("../../lib/atomik");
  const { getModel } = await import("../../lib/models");
  expect(fitStepParams(getModel(KLING), { seconds: 20, resolution: "480p", ratio: "adaptive" })).toEqual({ seconds: 15, resolution: "1080p", ratio: "16:9" });
  expect(fitStepParams(getModel(KLING), { seconds: 5, resolution: "1080p", ratio: "21:9" })).toMatchObject({ seconds: 5, ratio: "16:9" });
  expect(fitStepParams(getModel(KLING), { ratio: "4:3" }).ratio).toBe("1:1");
  expect(fitStepParams(getModel(KLING), { ratio: "3:4" }).ratio).toBe("9:16");
  expect(fitStepParams(getModel(SEEDANCE), { seconds: 5, resolution: "4k", ratio: "16:9" })).toEqual({ seconds: 5, resolution: "1080p", ratio: "16:9" });
  expect(fitStepParams(getModel(SEEDANCE_2), { seconds: 30, resolution: "720P" })).toMatchObject({ seconds: 15, resolution: "720p" });
  const still = fitStepParams(getModel(STILL), { resolution: "3K", seconds: 8, ratio: "9:16" });
  expect(still).toEqual({ resolution: "2K", ratio: "9:16" });
});

test("the planner's reply is held to the engines it was offered", async () => {
  const { extractTurn } = await import("../../lib/atomik");
  const reply = (model: string, kind = "video") => JSON.stringify({ say: "One shot.", propose: [{ kind, title: "Kitchen", prompt: "A kitchen at dawn.", model, seconds: 20, resolution: "480p" }] });
  const allowed = [{ id: KLING, kind: "video" as const }, { id: STILL, kind: "image" as const }, { id: "elevenlabs", kind: "audio" as const }];

  // A switched-off engine, named exactly, is replaced by one that is on — and the settings follow it.
  const off = extractTurn(reply(SEEDANCE), allowed)!;
  expect(off.propose[0]).toMatchObject({ model: KLING, params: { seconds: 15, resolution: "1080p" } });
  // An upscaler cannot make a shot, even by default.
  expect(extractTurn(reply(TOPAZ))!.propose[0].model).toBe(SEEDANCE);
  expect(extractTurn(reply(TOPAZ), allowed)!.propose[0].model).toBe(KLING);
  // An unknown id no longer falls back to a switched-off first engine.
  expect(extractTurn(reply("made-up"), allowed)!.propose[0].model).toBe(KLING);
  // Nothing of that kind is on: nothing is proposed, and the reply says so.
  const none = extractTurn(reply(SEEDANCE), [{ id: STILL, kind: "image" }])!;
  expect(none.propose).toEqual([]);
  expect(none.say).toContain("Not proposed");
  expect(none.say).toContain("Kitchen");
  // Audio is still Particl's own voice engine.
  expect(extractTurn(reply("anything", "audio"), allowed)!.propose[0].model).toBe("elevenlabs");
});

test("changing a step's engine carries settings that engine can make, priced as rendered", async () => {
  await inTenant(async () => {
    const { patchStep, estimateStepUsd, StepEditError } = await import("../../lib/atomik");
    const { setSetting } = await import("../../lib/settings");
    await step({ id: "s1", chat: "c1", params: { seconds: 20, resolution: "480p", ratio: "adaptive" } });
    const moved = (await patchStep("s1", { model: KLING }))!;
    expect(moved.model).toBe(KLING);
    expect(moved.params).toMatchObject({ seconds: 15, resolution: "1080p", ratio: "16:9" });
    expect(moved.estCostUsd).toBe(await estimateStepUsd("video", KLING, { seconds: 15, resolution: "1080p", ratio: "16:9" }));
    expect(moved.estCostUsd).not.toBeNull();

    // A still engine cannot make a video step; an upscaler cannot make a shot.
    await expect(patchStep("s1", { model: STILL })).rejects.toBeInstanceOf(StepEditError);
    await expect(patchStep("s1", { model: TOPAZ })).rejects.toBeInstanceOf(StepEditError);
    // Nor can an engine the workspace switched off.
    await setSetting("atomikEngines", JSON.stringify([SEEDANCE]), "owner");
    await expect(patchStep("s1", { model: SEEDANCE })).rejects.toThrow("cannot make this video step");
    expect((await patchStep("s1", { model: SEEDANCE_2 }))!.model).toBe(SEEDANCE_2);

    // A connected step keeps its quoted engine.
    await step({ id: "s2", chat: "c1", model: "connected:kling3_0", params: { connected: { jobId: "j", draftId: "d", credits: 3, workspaceId: "w" } } });
    await expect(patchStep("s2", { model: KLING })).rejects.toBeInstanceOf(StepEditError);
    // Settings edited on their own are snapped too.
    const edited = (await patchStep("s1", { params: { seconds: 99, resolution: "8k" } }))!;
    expect(edited.params).toMatchObject({ seconds: 15, resolution: "4k" });
  });
});

test("a claimed step the browser never reported back on is settled from the render request's record", async () => {
  await inTenant(async () => {
    const { reconcileRunningSteps, getStep, stepRequestKey, STRANDED_CLAIM_MS, INTERRUPTED_REQUEST_MS } = await import("../../lib/atomik");
    const { generationRequestsReady } = await import("../../lib/generationRequests");
    const { db } = await import("../../lib/db");
    const at = Date.now();
    const old = at - STRANDED_CLAIM_MS - 1000;
    await chat("c", "u");
    await step({ id: "made", chat: "c", status: "running", updatedAt: old });
    await step({ id: "held", chat: "c", status: "running", updatedAt: old });
    await step({ id: "refused", chat: "c", status: "running", updatedAt: old });
    await step({ id: "short", chat: "c", status: "running", updatedAt: old });
    await step({ id: "admitting", chat: "c", status: "running", updatedAt: old });
    await step({ id: "cut-job", chat: "c", status: "running", updatedAt: old });
    await step({ id: "cut-failed", chat: "c", status: "running", updatedAt: old });
    await step({ id: "lost", chat: "c", status: "running", updatedAt: old });
    await step({ id: "fresh", chat: "c", status: "running", updatedAt: at - 1000 });
    await step({ id: "accepting", chat: "c", status: "running", updatedAt: old });
    await step({ id: "cut", chat: "c", status: "running", updatedAt: old });
    await step({ id: "other-chat", chat: "d", status: "running", updatedAt: old });
    await generationRequestsReady();
    const job = (id: string, status: string, error: string | null = null) => db().execute({
      sql: `INSERT INTO generations (id, model, prompt, params, status, error, created_at, updated_at) VALUES (?, ?, 'p', '{}', ?, ?, ?, ?)`, args: [id, SEEDANCE, status, error, at, at],
    });
    await job("gen_made", "running");
    await job("gen_held", "held");
    await job("gen_short", "failed", "Not enough credits: this take needs 14, 3 left.");
    await job("gen_admitting", "running");
    await job("gen_cut", "running");
    await job("gen_cut_failed", "failed", "Over this production's cap.");
    const request = (key: string, genId: string | null, json: string | null, status: number | null, createdAt = at) => db().execute({
      sql: `INSERT INTO generation_requests (user_id, request_key, fingerprint, generation_id, response_json, response_status, created_at, updated_at) VALUES ('u', ?, 'f', ?, ?, ?, ?, ?)`,
      args: [key, genId, json, status, createdAt, createdAt],
    });
    const cut = at - INTERRUPTED_REQUEST_MS - 1000;
    await request(stepRequestKey("made"), "gen_made", JSON.stringify({ id: "gen_made", status: "running" }), 202);
    await request(stepRequestKey("held"), "gen_held", JSON.stringify({ id: "gen_held", status: "held", held: true }), 202);
    await request(stepRequestKey("refused"), null, JSON.stringify({ error: "Not enough credits." }), 402);
    // Admission binds the job before it reserves the spend: a refused reservation answers 4xx WITH a job id.
    await request(stepRequestKey("short"), "gen_short", JSON.stringify({ id: "gen_short", status: "failed", error: "Not enough credits: this take needs 14, 3 left." }), 402);
    await request(stepRequestKey("admitting"), "gen_admitting", null, null);
    await request(stepRequestKey("accepting"), null, null, null);
    await request(stepRequestKey("cut"), null, null, null, cut);
    await request(stepRequestKey("cut-job"), "gen_cut", null, null, cut);
    await request(stepRequestKey("cut-failed"), "gen_cut_failed", null, null, cut);

    expect(await reconcileRunningSteps("c", at)).toBe(8);
    expect(await getStep("made")).toMatchObject({ status: "done", genId: "gen_made", error: null });
    expect(await getStep("held")).toMatchObject({ status: "done", genId: "gen_held", error: null });
    expect(await getStep("refused")).toMatchObject({ status: "failed", genId: null, error: "Not enough credits." });
    expect(await getStep("short")).toMatchObject({ status: "failed", genId: null, error: "Not enough credits: this take needs 14, 3 left." });
    // Cut off with no reply: the job it filed says what it became.
    expect(await getStep("cut-job")).toMatchObject({ status: "done", genId: "gen_cut" });
    expect(await getStep("cut-failed")).toMatchObject({ status: "failed", genId: null, error: "Over this production's cap." });
    expect(await getStep("lost")).toMatchObject({ status: "proposed", genId: null });
    expect((await getStep("lost"))!.error).toContain("nothing was sent");
    expect(await getStep("cut")).toMatchObject({ status: "failed" });
    // A claim a moment old, or a request still being accepted (with or without its job yet), is left alone; so is another chat.
    expect(await getStep("fresh")).toMatchObject({ status: "running" });
    expect(await getStep("accepting")).toMatchObject({ status: "running" });
    expect(await getStep("admitting")).toMatchObject({ status: "running", genId: null });
    expect(await getStep("other-chat")).toMatchObject({ status: "running" });
    // Settled once: a second read changes nothing.
    expect(await reconcileRunningSteps("c", at)).toBe(0);
    // The step that went back to proposed may be approved again, and the claim clears why it was reset.
    const { claimStep } = await import("../../lib/atomik");
    expect(await claimStep("lost")).toMatchObject({ status: "running", error: null });
    // The lookup by the step's key alone is indexed, not a scan of every request.
    const plan = await db().execute({ sql: `EXPLAIN QUERY PLAN SELECT generation_id FROM generation_requests WHERE request_key = ? ORDER BY created_at DESC LIMIT 1`, args: [stepRequestKey("made")] });
    expect(plan.rows.map((r) => String(r.detail)).join(" ")).toContain("generation_requests_request_key");
  });
});

/* A render that was only delayed, not lost, must not land after its step went back to proposed. */
test("a stranded step's render key is fenced before the step is proposed again: the late render admits nothing, and approving again renders under a key of its own", async () => {
  await inTenant(async () => {
    const { reconcileRunningSteps, getStep, claimStep, stepRequestKey, STRANDED_CLAIM_MS } = await import("../../lib/atomik");
    const { withGenerationRequest } = await import("../../lib/generationRequests");
    const { db } = await import("../../lib/db");
    await chat("c2", "u_owner");
    await step({ id: "late", chat: "c2" });
    /* The approval's render key names the step's thread (threadStepRequestKey). */
    const taken = (await claimStep("late", "u_taker"))!;
    expect(taken).toMatchObject({ status: "running", requestKey: "atomik-step:c2:late" });
    /* Two minutes on, no render has arrived: the step goes back to proposed, and nothing was sent. */
    expect(await reconcileRunningSteps("c2", Date.now() + STRANDED_CLAIM_MS + 1000)).toBe(1);
    expect(await getStep("late")).toMatchObject({ status: "proposed", genId: null });
    /* The render was only delayed, and arrives now: answered, never admitted; nothing is made or charged. */
    let ran = 0;
    const body = { prompt: "A slow push-in on a kitchen table.", model: SEEDANCE, projectId: null, maxCredits: 14 };
    const admit = (key: string, user: string) => withGenerationRequest(render(key, body), user, async () => { ran++; return Response.json({ id: `gen_${ran}`, status: "queued" }, { status: 202 }); }, { atomicBinding: true });
    const late = await admit(taken.requestKey!, "u_taker");
    expect({ status: late.status, complete: late.headers.get("Idempotency-Status"), admitted: ran }).toEqual({ status: 409, complete: "complete", admitted: 0 });
    expect(await late.json()).toMatchObject({ code: "set_aside" });
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(0);
    expect(await getStep("late")).toMatchObject({ status: "proposed" });
    /* Approving again takes a key of its own; its render is admitted, once. */
    const again = (await claimStep("late", "u_taker"))!;
    expect(again.requestKey).toBe("atomik-step:c2:late:2");
    expect((await admit(again.requestKey!, "u_taker")).status).toBe(202);
    expect(ran).toBe(1);
    /* A step taken before takers were recorded is fenced for its chat's owner. */
    await chat("c3", "u_owner");
    await step({ id: "older", chat: "c3", status: "running", updatedAt: Date.now() - STRANDED_CLAIM_MS - 1000 });
    expect(await reconcileRunningSteps("c3")).toBe(1);
    expect((await admit(stepRequestKey("older"), "u_owner")).status).toBe(409);
    expect(ran).toBe(1);
    /* A render that did arrive is never fenced over: its own record decides, and the step waits for it. */
    await step({ id: "racing", chat: "c3", status: "running", updatedAt: Date.now() - STRANDED_CLAIM_MS - 1000 });
    expect(await claimStep("racing", "u_taker")).toBeNull();
    await db().execute({ sql: "UPDATE atomik_steps SET claimed_by='u_taker' WHERE id='racing'" });
    const { fenceGenerationRequest } = await import("../../lib/generationRequests");
    await db().execute({ sql: "INSERT INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES('u_taker',?, 'f', ?, ?)", args: [stepRequestKey("racing"), Date.now(), Date.now()] });
    expect(await fenceGenerationRequest({ userId: "u_taker", key: stepRequestKey("racing"), fingerprint: "x" })).toBe(false);
    expect(await reconcileRunningSteps("c3")).toBe(0);
    expect(await getStep("racing")).toMatchObject({ status: "running" });
  });
});

test("the planner is told about the workspace-wide cast, and a production's own name wins", async () => {
  await inTenant(async () => {
    const { projectContext } = await import("../../lib/atomik");
    const { db, ready } = await import("../../lib/db");
    await ready();
    const cast = (id: string, projectId: string | null, name: string, description: string) => db().execute({
      sql: `INSERT INTO cast_members (id, project_id, name, kind, description, created_at) VALUES (?,?,?,'character',?,0)`, args: [id, projectId, name, description],
    });
    for (const id of ["p1", "p2"]) await db().execute({ sql: `INSERT INTO projects (id, name, created_at) VALUES (?,?,0)`, args: [id, id] });
    await cast("a", "p1", "Maya", "the lead, in this film");
    await cast("b", null, "Maya", "the house presenter");
    await cast("c", null, "Harbour", "the studio's standing location");
    await cast("d", "p2", "Otto", "another film's lead");
    const film = await projectContext("p1");
    expect(film).toContain("@Maya (character) — the lead, in this film");
    expect(film).not.toContain("the house presenter");
    expect(film).toContain("@Harbour");
    expect(film).not.toContain("@Otto");
    const unfiled = await projectContext(null);
    expect(unfiled).toContain("@Harbour");
    expect(unfiled).toContain("the house presenter");
    expect(unfiled).not.toContain("@Otto");
  });
});
