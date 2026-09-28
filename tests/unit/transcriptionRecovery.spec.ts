import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import type { TranscriptionDeps } from "../../lib/transcription";

/**
 * Paid transcription under a durable request identity — lib/transcription.ts
 * inside the claim of lib/generationRequests.ts, composed as its route
 * composes them. A key seen again is answered from its saved reply and never
 * billed twice; a request whose reply was lost is asked about by that key
 * (checkTranscriptionRequest) and never re-sent; settlement follows the
 * transcript's own length through the credit terms (the price shown is
 * approximate), never above three times the estimate. The provider is stubbed
 * and the databases are local files: nothing is billed.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-transcription-recovery-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const ROUTE = "/api/audio/transcribe";
const USER = "u_stt";
const WORDS = [{ text: "Not", start: 0, end: 0.3, speaker: 0 }, { text: "tonight.", start: 0.3, end: 0.9, speaker: 1 }];

function workspace(name: string): TenantWorkspace {
  const id = `ws_stt_${name}_${randomUUID().slice(0, 8)}`;
  return { id, slug: id, name, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: USER, createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}

/** A workspace with credits and one measured audio upload of `seconds`. */
async function setup(name: string, seconds: number) {
  const ws = workspace(name);
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_${ws.id}`, ws.id, 5000, "Test", 0] });
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,0)",
      args: ["up_line", "line.wav", "audio/wav", "wav", 1000, "sha", "/api/uploads/up_line", "audio", seconds],
    });
  });
  return ws;
}

/** The provider stub: it reports `seconds` of audio, priced as the adapter prices it, and counts its calls. */
async function provider(seconds: number, options: { gate?: Promise<void>; fail?: Error } = {}) {
  const { grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  const calls = { n: 0 };
  const deps: TranscriptionDeps = {
    readSource: async () => Buffer.from("audio"),
    provider: async () => {
      calls.n++;
      await options.gate;
      if (options.fail) throw options.fail;
      return { text: "Not tonight.", language: "en", seconds, words: WORDS, costUsd: grokTranscriptionUsd(seconds) };
    },
  };
  return { deps, calls };
}

/** POST /api/audio/transcribe as the route composes it: the claim, then the transcription inside it. */
async function send(body: Record<string, unknown>, key: string, deps: TranscriptionDeps) {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { transcribe } = await import("../../lib/transcription");
  const req = new Request(`http://localhost${ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
  return withGenerationRequest(req, USER, async (claim) => {
    const reply = await transcribe(body, USER, { claim, deps });
    return Response.json(reply.body, { status: reply.status });
  });
}

async function check(key: string, body: Record<string, unknown>) {
  const { generationFingerprint } = await import("../../lib/generationRequests");
  const { checkTranscriptionRequest } = await import("../../lib/transcription");
  return checkTranscriptionRequest({ userId: USER, key, fingerprint: generationFingerprint({ method: "POST", path: ROUTE, body }) });
}

async function meterRows(workspaceId: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT id,status,billed_credits,engine_cost_usd FROM meter_events WHERE workspace_id=? ORDER BY created_at,id", args: [workspaceId] })).rows
    .map((r) => ({ id: String(r.id), status: String(r.status), credits: Number(r.billed_credits), costUsd: Number(r.engine_cost_usd) }));
}

async function estimate(seconds: number) {
  const { billCredits } = await import("../../lib/creditTerms");
  const { grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  return billCredits(grokTranscriptionUsd(seconds), "xai");
}

/** Makes a claim look older than any request can live, as a function killed mid-transcription leaves it. */
async function age(key: string) {
  const { db } = await import("../../lib/db");
  const { STALE_CLAIM_MS } = await import("../../lib/generationRequests");
  await db().execute({ sql: "UPDATE generation_requests SET created_at=? WHERE request_key=?", args: [Date.now() - STALE_CLAIM_MS - 60_000, key] });
}

test("a key sent again is answered from its saved transcript and charge; the provider and the meter see one request", async () => {
  const ws = await setup("replay", 60);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const shown = await estimate(60);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: shown };
    const { deps, calls } = await provider(60);
    const first = await send(body, "stt-replay-0001", deps);
    expect(first.status).toBe(200);
    expect(first.headers.get("Idempotency-Status")).toBe("complete");
    const reply = await first.json();
    expect(reply).toMatchObject({ text: "Not tonight.", seconds: 60, credits: shown });
    const again = await send(body, "stt-replay-0001", deps);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(reply);
    expect(calls.n).toBe(1);
    const rows = await meterRows(ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", credits: shown });
    /* The event is named by the claim, so the key alone finds it. */
    const { transcriptionEventId } = await import("../../lib/transcription");
    expect(rows[0].id).toBe(transcriptionEventId(ws.id, { userId: USER, key: "stt-replay-0001" }));
    /* A lost reply asked about by its key returns the same transcript and charge. */
    expect(await check("stt-replay-0001", body)).toEqual({ state: "answered", reply });
    /* The same key naming another request is refused, never run. */
    expect((await send({ ...body, diarize: false }, "stt-replay-0001", deps)).status).toBe(409);
    expect(await check("stt-replay-0001", { ...body, diarize: false })).toEqual({ state: "mismatch" });
    expect(calls.n).toBe(1);
  });
});

test("a transcript longer than its source is charged by its own length: the price shown is approximate", async () => {
  const ws = await setup("longer", 3000);
  const { runInTenant } = await import("../../lib/tenant");
  const { grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  const { billCredits } = await import("../../lib/creditTerms");
  const { creditsUsed } = await import("../../lib/meter");
  await runInTenant(ws, async () => {
    const shown = await estimate(3000);
    /* Twice the measured length, inside the limit: its own count is what it costs, above the price shown. */
    const charged = billCredits(grokTranscriptionUsd(6000), "xai");
    expect(charged).toBeGreaterThan(shown);
    const { deps } = await provider(6000);
    const response = await send({ sourceUploadId: "up_line", diarize: true, maxCredits: shown }, "stt-longer-001", deps);
    expect(response.status).toBe(200);
    expect((await response.json()).credits).toBe(charged);
    const [row] = await meterRows(ws.id);
    expect(row).toMatchObject({ status: "succeeded", credits: charged });
    expect(row.costUsd).toBeCloseTo(grokTranscriptionUsd(6000), 9);
    expect(await creditsUsed(ws.id)).toBe(charged);
  });
});

test("a runaway provider count is held to three times the estimate", async () => {
  const ws = await setup("runaway", 3000);
  const { runInTenant } = await import("../../lib/tenant");
  const { grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  const { billCredits } = await import("../../lib/creditTerms");
  await runInTenant(ws, async () => {
    const shown = await estimate(3000);
    const limit = grokTranscriptionUsd(3000) * 3;
    const { deps } = await provider(30000);
    const response = await send({ sourceUploadId: "up_line", diarize: true, maxCredits: shown }, "stt-runaway-01", deps);
    expect((await response.json()).credits).toBe(billCredits(limit, "xai"));
    const [row] = await meterRows(ws.id);
    expect(row).toMatchObject({ status: "succeeded", credits: billCredits(limit, "xai") });
    expect(row.costUsd).toBeCloseTo(limit, 9);
  });
});

test("a shorter transcript is charged its own, lower count, as before", async () => {
  const ws = await setup("shorter", 3000);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const shown = await estimate(3000);
    const shorter = await estimate(600);
    expect(shorter).toBeLessThan(shown);
    const { deps } = await provider(600);
    const response = await send({ sourceUploadId: "up_line", diarize: true, maxCredits: shown }, "stt-shorter-01", deps);
    expect((await response.json()).credits).toBe(shorter);
    expect((await meterRows(ws.id))[0]).toMatchObject({ status: "succeeded", credits: shorter });
  });
});

test("a key the server never saw is set aside by the check; the request arriving after it runs nothing", async () => {
  const ws = await setup("absent", 60);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(60) };
    const { deps, calls } = await provider(60);
    expect(await check("stt-absent-0001", body)).toEqual({ state: "absent" });
    const late = await send(body, "stt-absent-0001", deps);
    expect(late.status).toBe(409);
    expect(late.headers.get("Idempotency-Status")).toBe("complete");
    expect((await late.json()).code).toBe("set_aside");
    expect(await check("stt-absent-0001", body)).toEqual({ state: "absent" });
    expect(calls.n).toBe(0);
    expect(await meterRows(ws.id)).toEqual([]);
  });
});

test("a transcription still running is pending to the check, then answered with its transcript once it finishes", async () => {
  const ws = await setup("pending", 60);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(60) };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, calls } = await provider(60, { gate });
    const running = send(body, "stt-pending-001", deps);
    await expect.poll(() => calls.n).toBe(1);
    expect(await check("stt-pending-001", body)).toEqual({ state: "pending" });
    /* The same key pressed again meanwhile is not a second transcription. */
    const duplicate = await send(body, "stt-pending-001", deps);
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).pending).toBe(true);
    release();
    const reply = await (await running).json();
    expect(await check("stt-pending-001", body)).toEqual({ state: "answered", reply });
    expect(calls.n).toBe(1);
    expect(await meterRows(ws.id)).toHaveLength(1);
  });
});

test("a provider failure is answered for good with what the meter recorded: nothing charged", async () => {
  const ws = await setup("failure", 60);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(60) };
    const { deps, calls } = await provider(60, { fail: new Error("Grok transcription failed (500): unavailable") });
    const failed = await send(body, "stt-failure-001", deps);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Idempotency-Status")).toBe("complete");
    const reply = await failed.json();
    expect(reply).toEqual({ error: "Grok transcription failed (500): unavailable Nothing was charged for it.", charged: 0 });
    expect(await meterRows(ws.id)).toMatchObject([{ status: "failed", credits: 0 }]);
    expect(await check("stt-failure-001", body)).toEqual({ state: "refused", status: 502, error: reply.error });
    expect((await send(body, "stt-failure-001", deps)).status).toBe(502);
    expect(calls.n).toBe(1);
  });
});

test("an estimate above the price shown is refused before anything is reserved", async () => {
  const ws = await setup("repriced", 3000);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const shown = await estimate(3000);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: shown - 1 };
    const { deps, calls } = await provider(3000);
    const refused = await send(body, "stt-repriced-01", deps);
    expect(refused.status).toBe(409);
    expect((await refused.json()).estimatedCredits).toBe(shown);
    expect(await check("stt-repriced-01", body)).toMatchObject({ state: "refused", status: 409 });
    expect(calls.n).toBe(0);
    expect(await meterRows(ws.id)).toEqual([]);
  });
});

test("a request that died before reserving is answered, once it cannot be running, as interrupted with nothing charged", async () => {
  const ws = await setup("interrupted", 60);
  const { runInTenant } = await import("../../lib/tenant");
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(60) };
    const req = new Request(`http://localhost${ROUTE}`, { method: "POST", headers: { "Idempotency-Key": "stt-interrupt-1" }, body: JSON.stringify(body) });
    expect((await withGenerationRequest(req, USER, async () => { throw new Error("function killed"); })).status).toBe(503);
    expect(await check("stt-interrupt-1", body)).toEqual({ state: "pending" });
    await age("stt-interrupt-1");
    expect(await check("stt-interrupt-1", body)).toEqual({ state: "refused", status: 409, error: "It was interrupted before anything was charged." });
    const { deps, calls } = await provider(60);
    const replay = await send(body, "stt-interrupt-1", deps);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "It was interrupted before anything was charged.", charged: 0 });
    expect(calls.n).toBe(0);
    expect(await meterRows(ws.id)).toEqual([]);
  });
});

test("a request that died holding its reservation is answered as unknown with the credits it holds, and is never run again", async () => {
  const ws = await setup("held", 60);
  const { runInTenant } = await import("../../lib/tenant");
  const { withGenerationRequest, reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { transcriptionEventId } = await import("../../lib/transcription");
  const { GROK_STT_MODEL, grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  await runInTenant(ws, async () => {
    const reserved = await estimate(60);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const req = new Request(`http://localhost${ROUTE}`, { method: "POST", headers: { "Idempotency-Key": "stt-held-00001" }, body: JSON.stringify(body) });
    /* Reserved, then killed before the provider answered: the claim has no reply, the event still runs. */
    expect((await withGenerationRequest(req, USER, async (claim) => {
      await reserveGenerationSpend({ id: transcriptionEventId(ws.id, claim), kind: "audio", engine: "xai", model: GROK_STT_MODEL, status: "running", engineCostUsd: grokTranscriptionUsd(60) });
      throw new Error("function killed");
    })).status).toBe(503);
    expect(await check("stt-held-00001", body)).toEqual({ state: "pending" });
    await age("stt-held-00001");
    const held = `Your last transcription stopped without an answer. Its ${reserved} credit${reserved === 1 ? "" : "s"} stay reserved for review. Nothing was sent again.`;
    expect(await check("stt-held-00001", body)).toEqual({ state: "unknown", error: held, credits: reserved });
    const { deps, calls } = await provider(60);
    const replay = await send(body, "stt-held-00001", deps);
    expect(replay.status).toBe(502);
    expect(await replay.json()).toMatchObject({ code: "uncertain", charged: reserved });
    expect(calls.n).toBe(0);
    expect(await meterRows(ws.id)).toMatchObject([{ status: "running", credits: reserved }]);
    /* Released later by reconciliation, the same check says so from the meter. */
    const { meter } = await import("../../lib/meter");
    await meter({ id: transcriptionEventId(ws.id, { userId: USER, key: "stt-held-00001" }), kind: "audio", engine: "xai", model: GROK_STT_MODEL, status: "failed", engineCostUsd: 0 });
    expect(await check("stt-held-00001", body)).toEqual({ state: "unknown", error: "Your last transcription stopped without an answer. Its reserved credits were returned. Nothing was sent again.", credits: 0 });
  });
});

/* ── The browser's side: lib/workbench/transcription-request.ts against a stub server ── */

const SCOPE = "particl-active-ws_unit-u_unit";
function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}
type Call = { path: string; key: string | null; body: Record<string, unknown> };
type Answer = { status?: number; json: unknown; headers?: Record<string, string> } | "network";
async function withServer(routes: Record<string, (body: Record<string, unknown>) => Answer>, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const at = String(url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: at, key: headers.get("Idempotency-Key"), body });
    const answer = routes[at]?.(body);
    if (!answer) throw new Error(`Unexpected request: ${at}`);
    if (answer === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "Content-Type": "application/json", ...answer.headers } });
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const TRANSCRIPT = { text: "The ferry is here.", language: "en", seconds: 5, words: [{ text: "The", start: 0, end: 0.2, speaker: 0 }], srt: "1\n", credits: 3 };

test("the slot is one per source and settings, and the body is the same one quoted and sent", async () => {
  const { transcriptionSlot, transcriptionBody } = await import("../../lib/workbench/transcription-request");
  const slots = [
    transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true }),
    transcriptionSlot(SCOPE, "prod", { genId: "gen_b" }, { diarize: true }),
    transcriptionSlot(SCOPE, "prod", { uploadId: "gen_a" }, { diarize: true }),
    transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: false }),
    transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true, language: "fr" }),
    transcriptionSlot(SCOPE, "other", { genId: "gen_a" }, { diarize: true }),
    transcriptionSlot("particl-active-ws_unit-u_other", "prod", { genId: "gen_a" }, { diarize: true }),
  ];
  expect(new Set(slots).size).toBe(slots.length);
  expect(transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true })).toBe(slots[0]);
  expect(transcriptionBody({ genId: "gen_a" }, "prod", { diarize: true })).toEqual({ sourceGenId: "gen_a", projectId: "prod", diarize: true });
  expect(transcriptionBody({ uploadId: "up_a" }, undefined, { diarize: true, language: "fr" })).toEqual({ sourceUploadId: "up_a", diarize: true, language: "fr" });
});

test("a press is claimed before it is sent, goes once under that key with the price shown as its ceiling, and lets go of its slot on the transcript", async () => {
  const { sendTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const { readPendingGeneration } = await import("../../lib/workbench/pending-generation");
  const storage = memory();
  const slot = transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true });
  const body = { sourceGenId: "gen_a", projectId: "prod", diarize: true, maxCredits: 3 };
  let claimedWhenSent: string | null = null;
  await withServer({ "/api/audio/transcribe": () => { claimedWhenSent = readPendingGeneration(storage, slot)?.key ?? null; return { json: TRANSCRIPT, headers: { "Idempotency-Status": "complete" } }; } }, async (calls) => {
    const outcome = await sendTranscription({ scope: SCOPE, slot, body, credits: 3, storage });
    expect(outcome).toEqual({ state: "done", result: TRANSCRIPT, recovered: false, note: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual(body);
    expect(calls[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimedWhenSent).toBe(calls[0].key);
    expect(readPendingGeneration(storage, slot)).toBeNull();
  });
});

test("a lost reply keeps its claim; the next press asks by that key first and returns the transcript without sending again", async () => {
  const { sendTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const { readPendingGeneration } = await import("../../lib/workbench/pending-generation");
  const storage = memory();
  const slot = transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true });
  const body = { sourceGenId: "gen_a", projectId: "prod", diarize: true, maxCredits: 3 };
  await withServer({
    "/api/audio/transcribe": () => "network",
    "/api/generate/check": () => ({ json: { state: "answered", reply: TRANSCRIPT } }),
  }, async (calls) => {
    const lost = await sendTranscription({ scope: SCOPE, slot, body, credits: 3, storage });
    expect(lost).toEqual({ state: "unknown", reason: "The connection dropped before the server answered. Asking what became of it; it is never sent twice.", waiting: false });
    const claim = readPendingGeneration(storage, slot)!;
    expect(claim).toMatchObject({ key: calls[0].key, credits: 3, endpoint: "/api/audio/transcribe", body: JSON.stringify(body) });
    const again = await sendTranscription({ scope: SCOPE, slot, body, credits: 3, storage });
    expect(again).toEqual({ state: "done", result: TRANSCRIPT, recovered: true, note: "Your last transcription finished and was charged 3 credits. Nothing was sent again." });
    expect(calls.map((c) => c.path)).toEqual(["/api/audio/transcribe", "/api/generate/check"]);
    expect(calls[1].body).toEqual({ key: claim.key, endpoint: "/api/audio/transcribe", body: claim.body });
    expect(readPendingGeneration(storage, slot)).toBeNull();
  });
});

test("the check's answers: never arrived or refused let go of the claim; still running or unanswerable keep it and send nothing", async () => {
  const { settlePendingTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const { claimPendingGeneration, readPendingGeneration } = await import("../../lib/workbench/pending-generation");
  const slot = transcriptionSlot(SCOPE, "prod", { uploadId: "up_a" }, { diarize: true });
  const earlier = { key: "earlier-transcript-1", body: JSON.stringify({ sourceUploadId: "up_a", diarize: true, maxCredits: 4 }), credits: 4, endpoint: "/api/audio/transcribe" as const };
  const cases: [Answer, unknown, boolean][] = [
    [{ json: { state: "absent" } }, { state: "released", reason: "Your last transcription never reached the server. Nothing was charged for it.", failed: false }, false],
    [{ json: { state: "refused", status: 502, error: "Grok transcription failed (500): unavailable Nothing was charged for it." } },
      { state: "released", reason: "Your last transcription did not complete. Grok transcription failed (500): unavailable Nothing was charged for it.", failed: true }, false],
    [{ json: { state: "unknown", error: "Your last transcription stopped without an answer. Its 4 credits stay reserved for review. Nothing was sent again.", credits: 4 } },
      { state: "released", reason: "Your last transcription stopped without an answer. Its 4 credits stay reserved for review. Nothing was sent again.", failed: true }, false],
    [{ json: { state: "pending" } }, { state: "unknown", reason: "Your last transcription is still running. Nothing new was sent; asking again shortly.", waiting: true }, true],
    ["network", { state: "unknown", reason: "Your last transcription could not be checked. Nothing new was sent.", waiting: false }, true],
    [{ status: 409, json: { error: "This Idempotency-Key names a different request." } }, { state: "unknown", reason: "Your last transcription could not be checked. Nothing new was sent.", waiting: false }, true],
    [{ json: { state: "answered", reply: { text: "no words or subtitles" } } }, { state: "unknown", reason: "Your last transcription could not be checked. Nothing new was sent.", waiting: false }, true],
  ];
  for (const [answer, outcome, kept] of cases) {
    const storage = memory();
    claimPendingGeneration(storage, slot, earlier);
    await withServer({ "/api/generate/check": () => answer, "/api/audio/transcribe": () => { throw new Error("A check never sends the transcription."); } }, async (calls) => {
      expect(await settlePendingTranscription({ scope: SCOPE, slot, storage })).toEqual(outcome);
      expect(calls).toEqual([{ path: "/api/generate/check", key: null, body: { key: earlier.key, endpoint: "/api/audio/transcribe", body: earlier.body } }]);
      expect(readPendingGeneration(storage, slot)?.key ?? null).toBe(kept ? earlier.key : null);
    });
  }
  /* Nothing claimed: nothing is asked. Unreadable storage is never a new paid attempt. */
  await withServer({}, async (calls) => {
    expect(await settlePendingTranscription({ scope: SCOPE, slot, storage: memory() })).toEqual({ state: "none" });
    const broken = memory();
    broken.setItem(slot, "{broken");
    expect(await settlePendingTranscription({ scope: SCOPE, slot, storage: broken })).toEqual({ state: "unknown", reason: "The saved transcription request cannot be read. Check Activity before starting another.", waiting: false });
    expect(calls).toEqual([]);
  });
});

test("a claim another check already let go is still asked about by the key the caller read, and its transcript still comes back", async () => {
  const { settlePendingTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const slot = transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true });
  const earlier = { key: "earlier-transcript-2", body: JSON.stringify({ sourceGenId: "gen_a", diarize: true, maxCredits: 3 }), credits: 3, endpoint: "/api/audio/transcribe" as const };
  await withServer({ "/api/generate/check": () => ({ json: { state: "answered", reply: TRANSCRIPT } }) }, async (calls) => {
    const outcome = await settlePendingTranscription({ scope: SCOPE, slot, storage: memory(), attempt: earlier });
    expect(outcome).toMatchObject({ state: "done", result: TRANSCRIPT, recovered: true });
    expect(calls[0].body).toEqual({ key: earlier.key, endpoint: "/api/audio/transcribe", body: earlier.body });
  });
});

test("a press finds an earlier request still running, or storage it cannot write, and sends nothing", async () => {
  const { sendTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const { claimPendingGeneration, readPendingGeneration } = await import("../../lib/workbench/pending-generation");
  const slot = transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true });
  const body = { sourceGenId: "gen_a", projectId: "prod", diarize: true, maxCredits: 3 };
  const earlier = { key: "earlier-transcript-3", body: JSON.stringify(body), credits: 3, endpoint: "/api/audio/transcribe" as const };
  await withServer({ "/api/generate/check": () => ({ json: { state: "pending" } }) }, async (calls) => {
    const storage = memory();
    claimPendingGeneration(storage, slot, earlier);
    expect(await sendTranscription({ scope: SCOPE, slot, body, credits: 3, storage })).toMatchObject({ state: "unknown", waiting: true });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
    expect(readPendingGeneration(storage, slot)?.key).toBe(earlier.key);
  });
  await withServer({}, async (calls) => {
    const blocked = { getItem: () => null, setItem: () => { throw new Error("storage blocked"); }, removeItem: () => undefined };
    expect(await sendTranscription({ scope: SCOPE, slot, body, credits: 3, storage: blocked })).toEqual({ state: "released", reason: "Enable local storage to safely recover this transcription. Nothing was sent.", failed: true });
    expect(calls).toEqual([]);
  });
});

test("a completed refusal is final and lets go; one the server has not settled keeps the claim for the check", async () => {
  const { sendTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const { readPendingGeneration } = await import("../../lib/workbench/pending-generation");
  const slot = transcriptionSlot(SCOPE, "prod", { genId: "gen_a" }, { diarize: true });
  const body = { sourceGenId: "gen_a", projectId: "prod", diarize: true, maxCredits: 3 };
  const answers: [Answer, unknown, boolean][] = [
    [{ status: 502, json: { error: "Grok transcription failed (500): unavailable Nothing was charged for it.", charged: 0 }, headers: { "Idempotency-Status": "complete" } },
      { state: "released", reason: "Grok transcription failed (500): unavailable Nothing was charged for it.", failed: true }, false],
    [{ status: 409, json: { error: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", estimatedCredits: 5 }, headers: { "Idempotency-Status": "complete" } },
      { state: "released", reason: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", failed: true }, false],
    [{ status: 409, json: { error: "This request is still being accepted. Retry with the same Idempotency-Key; it will not submit another generation.", pending: true } },
      { state: "unknown", reason: "Your last transcription is still running. Nothing new was sent; asking again shortly.", waiting: true }, true],
    [{ status: 503, json: { error: "The request was interrupted. Retry with the same Idempotency-Key to recover its job; it will not be submitted twice." } },
      { state: "unknown", reason: "The connection dropped before the server answered. Asking what became of it; it is never sent twice.", waiting: false }, true],
  ];
  for (const [answer, outcome, kept] of answers) {
    const storage = memory();
    await withServer({ "/api/audio/transcribe": () => answer }, async (calls) => {
      expect(await sendTranscription({ scope: SCOPE, slot, body, credits: 3, storage })).toEqual(outcome);
      expect(calls).toHaveLength(1);
      expect(readPendingGeneration(storage, slot)?.key ?? null).toBe(kept ? calls[0].key : null);
    });
  }
});
