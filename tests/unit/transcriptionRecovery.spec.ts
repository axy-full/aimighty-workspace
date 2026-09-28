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

/** Makes a claim `byMs` old — by default older than any transcription request can live, as a function killed mid-transcription leaves it. */
async function age(key: string, byMs?: number) {
  const { db } = await import("../../lib/db");
  const { TRANSCRIPTION_STALE_MS } = await import("../../lib/transcription");
  await db().execute({ sql: "UPDATE generation_requests SET created_at=? WHERE request_key=?", args: [Date.now() - (byMs ?? TRANSCRIPTION_STALE_MS + 60_000), key] });
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

test("a provider failure is answered for good with what the meter recorded: nothing charged, in a sentence of Particl's, never the provider's text", async () => {
  const ws = await setup("failure", 60);
  const { runInTenant } = await import("../../lib/tenant");
  const { XaiHttpError } = await import("../../lib/xaiErrors");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(60) };
    const raw = "Grok transcription failed (500): upstream said key xai-abc123 is over quota";
    const { deps, calls } = await provider(60, { fail: new XaiHttpError(500, raw) });
    const failed = await send(body, "stt-failure-001", deps);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Idempotency-Status")).toBe("complete");
    const reply = await failed.json();
    expect(reply).toEqual({ error: "Grok could not transcribe this take (500). Nothing was charged for it.", charged: 0 });
    expect(JSON.stringify(reply)).not.toContain("xai-abc123");
    expect(await meterRows(ws.id)).toMatchObject([{ status: "failed", credits: 0 }]);
    expect(await check("stt-failure-001", body)).toEqual({ state: "refused", status: 502, error: reply.error });
    expect((await send(body, "stt-failure-001", deps)).status).toBe(502);
    expect(calls.n).toBe(1);
    /* A timeout, and anything else, by kind: never its own text. */
    const late = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const odd = new Error("socket hang up at 10.0.0.7:443");
    for (const [key, fail, said] of [["stt-failure-002", late, "Grok did not answer in time."], ["stt-failure-003", odd, "This take could not be transcribed."]] as const) {
      const answer = await (await send(body, key, (await provider(60, { fail })).deps)).json();
      expect(answer).toEqual({ error: `${said} Nothing was charged for it.`, charged: 0 });
    }
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

/* ── A function killed at each step (TranscriptionStep): never charged without a saved transcript, never charged twice, never sent twice ── */

/** A source measured at SOURCE_S whose transcript counts SPOKEN_S: the reservation (at the estimate) and the charge (at its own length) differ, so the tests can tell them apart. */
const SOURCE_S = 30_000;
const SPOKEN_S = 6_000;
const creditsWord = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

/** The provider stub, and a step that never returns once `at` is reached: a function killed there. `reached` resolves when it is. */
async function killedAt(at: string, seconds = SPOKEN_S) {
  const { deps, calls } = await provider(seconds);
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  deps.step = (step) => {
    if (step !== at) return;
    reach();
    return new Promise<never>(() => {});
  };
  return { deps, calls, reached };
}

/**
 * What one claim has left behind: its transcript saved or not, the status it
 * was answered with, its bill queued or delivered, its meter event, what the
 * workspace is debited for that event and what the workspace's credits have
 * drawn in all. Every reading also holds the invariants: charged only with a
 * saved transcript, debited exactly what its event records, and credits drawn
 * exactly as debited.
 */
async function left(workspaceId: string, key: string) {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  const { transcriptionEventId } = await import("../../lib/transcription");
  await billingReady();
  const eventId = transcriptionEventId(workspaceId, { userId: USER, key });
  const tables = new Set((await db().execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name)));
  const saved = tables.has("transcription_outcomes")
    && (await db().execute({ sql: "SELECT 1 FROM transcription_outcomes WHERE user_id=? AND request_key=?", args: [USER, key] })).rows.length > 0;
  const bill = tables.has("generation_settlements") ? (await db().execute({ sql: "SELECT settled_at FROM generation_settlements WHERE id=?", args: [eventId] })).rows[0] : undefined;
  const claim = (await db().execute({ sql: "SELECT response_status FROM generation_requests WHERE user_id=? AND request_key=?", args: [USER, key] })).rows[0];
  const event = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE workspace_id=? AND id=?", args: [workspaceId, eventId] })).rows[0];
  const debit = (await platformDb().execute({ sql: "SELECT credits FROM billing_debits WHERE workspace_id=? AND event_id=?", args: [workspaceId, eventId] })).rows[0];
  const debits = (await platformDb().execute({ sql: "SELECT COALESCE(SUM(credits),0) AS n FROM billing_debits WHERE workspace_id=?", args: [workspaceId] })).rows[0];
  const drawn = (await platformDb().execute({ sql: "SELECT COALESCE(SUM(drawn),0) AS n FROM billing_lots WHERE workspace_id=?", args: [workspaceId] })).rows[0];
  const record = {
    saved,
    answered: claim?.response_status == null ? null : Number(claim.response_status),
    bill: bill ? (bill.settled_at == null ? "queued" : "delivered") : null,
    meter: event ? { status: String(event.status), credits: Number(event.billed_credits) } : null,
    debited: debit ? Number(debit.credits) : 0,
    drawn: Number(drawn.n),
  };
  if (record.meter?.status === "succeeded") expect(record.saved, "charged without a saved transcript").toBe(true);
  expect(record.debited).toBe(record.meter?.credits ?? 0);
  expect(record.drawn).toBe(Number(debits.n));
  return record;
}

test("a function killed after its claim, before anything was reserved, is answered once it cannot be running: interrupted, nothing charged", async () => {
  const ws = await setup("killed-claimed", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(SOURCE_S) };
    const key = "stt-killed-claimed";
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const req = new Request(`http://localhost${ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    void withGenerationRequest(req, USER, () => { reach(); return new Promise<Response>(() => {}); });
    await reached;
    expect(await check(key, body)).toEqual({ state: "pending" });
    expect(await left(ws.id, key)).toEqual({ saved: false, answered: null, bill: null, meter: null, debited: 0, drawn: 0 });
    await age(key);
    const interrupted = { state: "refused", status: 409, error: "It was interrupted before anything was charged." };
    expect(await check(key, body)).toEqual(interrupted);
    expect(await check(key, body)).toEqual(interrupted);
    const { deps, calls } = await provider(SPOKEN_S);
    expect((await send(body, key, deps)).status).toBe(409);
    expect(calls.n).toBe(0);
    expect(await left(ws.id, key)).toEqual({ saved: false, answered: 409, bill: null, meter: null, debited: 0, drawn: 0 });
  });
});

for (const at of ["reserved", "transcribed"] as const) {
  const when = at === "reserved" ? "after reserving, before the provider was asked" : "after the provider answered, before its transcript was saved";
  test(`a function killed ${when} holds its reservation for review, never charges it as a transcript, and never sends the audio again`, async () => {
    const ws = await setup(`killed-${at}`, SOURCE_S);
    const { runInTenant } = await import("../../lib/tenant");
    await runInTenant(ws, async () => {
      const reserved = await estimate(SOURCE_S);
      const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
      const key = `stt-killed-${at}`;
      const { deps, calls, reached } = await killedAt(at);
      void send(body, key, deps);
      await reached;
      const sent = at === "reserved" ? 0 : 1;
      expect(calls.n).toBe(sent);
      expect(await check(key, body)).toEqual({ state: "pending" });
      expect(await left(ws.id, key)).toEqual({ saved: false, answered: null, bill: null, meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved });
      await age(key);
      const held = { state: "unknown", error: `Your last transcription stopped without an answer. Its ${creditsWord(reserved)} stay reserved for review. Nothing was sent again.`, credits: reserved };
      expect(await check(key, body)).toEqual(held);
      expect(await check(key, body)).toEqual(held);
      const replay = await send(body, key, deps);
      expect(replay.status).toBe(502);
      expect(await replay.json()).toMatchObject({ code: "uncertain", charged: reserved });
      expect(calls.n).toBe(sent);
      expect(await left(ws.id, key)).toEqual({ saved: false, answered: 502, bill: null, meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved });
    });
  });
}

for (const at of ["saved", "settled", "answered"] as const) {
  const when = { saved: "after its transcript was saved, before it was charged", settled: "after it was charged, before its reply was made", answered: "with its reply made but never saved" }[at];
  test(`a function killed ${when} is answered by the check with its transcript, charged once at its own length`, async () => {
    const ws = await setup(`killed-${at}`, SOURCE_S);
    const { runInTenant } = await import("../../lib/tenant");
    const { transcriptSrt } = await import("../../lib/xaiVoice");
    const { creditsUsed } = await import("../../lib/meter");
    await runInTenant(ws, async () => {
      const reserved = await estimate(SOURCE_S), charged = await estimate(SPOKEN_S);
      expect(charged).toBeLessThan(reserved);
      const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
      const key = `stt-killed-${at}`;
      const { deps, calls, reached } = await killedAt(at);
      void send(body, key, deps);
      await reached;
      expect(await left(ws.id, key)).toEqual(at === "saved"
        ? { saved: true, answered: null, bill: "queued", meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved }
        : { saved: true, answered: null, bill: "delivered", meter: { status: "succeeded", credits: charged }, debited: charged, drawn: charged });
      /* A saved transcript is answered at once, and never as lost even once its claim is past the window. */
      if (at === "saved") await age(key);
      const reply = { text: "Not tonight.", language: "en", seconds: SPOKEN_S, words: WORDS, srt: transcriptSrt(WORDS), credits: charged };
      expect(await check(key, body)).toEqual({ state: "answered", reply });
      expect(await check(key, body)).toEqual({ state: "answered", reply });
      const replay = await send(body, key, deps);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(reply);
      expect(calls.n).toBe(1);
      expect(await left(ws.id, key)).toEqual({ saved: true, answered: 200, bill: "delivered", meter: { status: "succeeded", credits: charged }, debited: charged, drawn: charged });
      expect(await creditsUsed(ws.id)).toBe(charged);
    });
  });
}

test("a charge that reached the meter but was not marked delivered is delivered again without charging twice", async () => {
  const ws = await setup("half-delivered", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { meter } = await import("../../lib/meter");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S), charged = await estimate(SPOKEN_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-half-delivered";
    const { deps, calls, reached } = await killedAt("saved");
    void send(body, key, deps);
    await reached;
    /* The delivery wrote the meter and stopped before marking its bill delivered. */
    const queued = (await db().execute("SELECT event FROM generation_settlements WHERE settled_at IS NULL")).rows;
    expect(queued).toHaveLength(1);
    await meter({ ...JSON.parse(String(queued[0].event)), workspaceId: ws.id }, { critical: true });
    expect(await left(ws.id, key)).toMatchObject({ bill: "queued", meter: { status: "succeeded", credits: charged }, debited: charged });
    expect(await check(key, body)).toMatchObject({ state: "answered", reply: { credits: charged } });
    expect(calls.n).toBe(1);
    expect(await left(ws.id, key)).toEqual({ saved: true, answered: 200, bill: "delivered", meter: { status: "succeeded", credits: charged }, debited: charged, drawn: charged });
  });
});

test("the sync delivers a saved transcript's charge on its own, and the check then returns the transcript with that charge", async () => {
  const ws = await setup("synced", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { flushGenerationSettlements } = await import("../../lib/generationSettlement");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S), charged = await estimate(SPOKEN_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-synced-00001";
    const { deps, calls, reached } = await killedAt("saved");
    void send(body, key, deps);
    await reached;
    expect(await flushGenerationSettlements()).toEqual({ attempted: 1, failed: 0 });
    expect(await left(ws.id, key)).toEqual({ saved: true, answered: null, bill: "delivered", meter: { status: "succeeded", credits: charged }, debited: charged, drawn: charged });
    expect(await check(key, body)).toMatchObject({ state: "answered", reply: { text: "Not tonight.", credits: charged } });
    expect(await flushGenerationSettlements()).toEqual({ attempted: 0, failed: 0 });
    expect(calls.n).toBe(1);
    expect(await left(ws.id, key)).toMatchObject({ answered: 200, meter: { status: "succeeded", credits: charged }, debited: charged });
  });
});

test("a transcript whose charge the meter refuses for now is kept: its request says it was interrupted, the check says pending — even past the window — then returns it charged once", async () => {
  const ws = await setup("meter-refused", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { transcriptionEventId } = await import("../../lib/transcription");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S), charged = await estimate(SPOKEN_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-meter-refused";
    /* The meter refuses the bill while its event reads as another workspace's: it writes nothing. */
    const owner = (workspaceId: string) => platformDb().execute({ sql: "UPDATE meter_events SET workspace_id=? WHERE id=?", args: [workspaceId, transcriptionEventId(ws.id, { userId: USER, key })] });
    const { deps, calls } = await provider(SPOKEN_S);
    deps.step = async (step) => { if (step === "saved") await owner("ws_elsewhere"); };
    const lost = await send(body, key, deps);
    expect(lost.status).toBe(503);
    expect(lost.headers.get("Idempotency-Status")).toBeNull();
    expect(await check(key, body)).toEqual({ state: "pending" });
    await age(key);
    expect(await check(key, body)).toEqual({ state: "pending" });
    await owner(ws.id);
    expect(await left(ws.id, key)).toEqual({ saved: true, answered: null, bill: "queued", meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved });
    expect(await check(key, body)).toMatchObject({ state: "answered", reply: { text: "Not tonight.", credits: charged } });
    expect(calls.n).toBe(1);
    expect(await left(ws.id, key)).toEqual({ saved: true, answered: 200, bill: "delivered", meter: { status: "succeeded", credits: charged }, debited: charged, drawn: charged });
  });
});

test("a maintenance pause that lands after the transcript is saved loses nothing: checks fail while it lasts, then the transcript comes back charged once", async () => {
  const ws = await setup("paused", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { createClient } = await import("@libsql/client");
  /* The recovery fence, set from outside the app as a checkpoint sets it: every write the app makes is refused while it is closed. */
  const outside = createClient({ url: process.env.PLATFORM_DATABASE_URL! });
  const fence = (state: "open" | "closed") => outside.execute({ sql: "UPDATE recovery_fence SET state=? WHERE id=1", args: [state] });
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S), charged = await estimate(SPOKEN_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-paused-00001";
    const { deps, calls } = await provider(SPOKEN_S);
    deps.step = async (step) => { if (step === "saved") await fence("closed"); };
    try {
      const lost = await send(body, key, deps);
      expect(lost.status).toBe(503);
      await expect(check(key, body)).rejects.toThrow(/paused/);
    } finally {
      await fence("open");
      outside.close();
    }
    expect(await left(ws.id, key)).toEqual({ saved: true, answered: null, bill: "queued", meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved });
    expect(await check(key, body)).toMatchObject({ state: "answered", reply: { text: "Not tonight.", credits: charged } });
    expect(calls.n).toBe(1);
    expect(await left(ws.id, key)).toEqual({ saved: true, answered: 200, bill: "delivered", meter: { status: "succeeded", credits: charged }, debited: charged, drawn: charged });
  });
});

test("a request that outlives its window cannot save a transcript over the answer its check gave: that answer and the held reservation stand", async () => {
  const ws = await setup("late", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-late-000001";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, calls } = await provider(SPOKEN_S, { gate });
    const late = send(body, key, deps);
    await expect.poll(() => calls.n).toBe(1);
    await age(key);
    const held = { state: "unknown", error: `Your last transcription stopped without an answer. Its ${creditsWord(reserved)} stay reserved for review. Nothing was sent again.`, credits: reserved };
    expect(await check(key, body)).toEqual(held);
    release();
    /* It ended by being refused its save, so it answers with what its claim already says. */
    const answer = await late;
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({ error: held.error, code: "uncertain", charged: reserved });
    expect(await check(key, body)).toEqual(held);
    expect(calls.n).toBe(1);
    expect(await left(ws.id, key)).toEqual({ saved: false, answered: 502, bill: null, meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved });
  });
});

test("a transcription's claim waits ten minutes, not thirty: twice its route's limit, then it is answered for good", async () => {
  const { readFileSync } = await import("node:fs");
  const { TRANSCRIPTION_STALE_MS } = await import("../../lib/transcription");
  const { STALE_CLAIM_MS } = await import("../../lib/generationRequests");
  const limit = Number(/export const maxDuration = (\d+);/.exec(readFileSync(path.resolve("app/api/audio/transcribe/route.ts"), "utf8"))?.[1]);
  expect(limit).toBeGreaterThan(0);
  expect(TRANSCRIPTION_STALE_MS).toBeGreaterThanOrEqual(2 * limit * 1000);
  expect(TRANSCRIPTION_STALE_MS).toBeLessThan(STALE_CLAIM_MS);
  const ws = await setup("window", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-window-0001";
    const { deps, reached } = await killedAt("reserved");
    void send(body, key, deps);
    await reached;
    await age(key, TRANSCRIPTION_STALE_MS - 60_000);
    expect(await check(key, body)).toEqual({ state: "pending" });
    await age(key, TRANSCRIPTION_STALE_MS + 60_000);
    expect(await check(key, body)).toMatchObject({ state: "unknown", credits: reserved });
  });
});

test("a request from before transcripts were saved first, charged without one, is still told so plainly", async () => {
  const ws = await setup("legacy", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { withGenerationRequest, reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { meter } = await import("../../lib/meter");
  const { transcriptionEventId } = await import("../../lib/transcription");
  const { GROK_STT_MODEL, grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S), charged = await estimate(SPOKEN_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-legacy-0001";
    const req = new Request(`http://localhost${ROUTE}`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) });
    /* What the earlier order could leave: charged on the meter, then killed before the reply was saved. */
    expect((await withGenerationRequest(req, USER, async (claim) => {
      const event = { id: transcriptionEventId(ws.id, claim), kind: "audio" as const, engine: "xai", model: GROK_STT_MODEL };
      await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: grokTranscriptionUsd(SOURCE_S) });
      await meter({ ...event, status: "succeeded", engineCostUsd: grokTranscriptionUsd(SPOKEN_S) }, { critical: true });
      throw new Error("function killed");
    })).status).toBe(503);
    await age(key);
    expect(await check(key, body)).toEqual({ state: "unknown", error: `Your last transcription finished and was charged ${creditsWord(charged)}, but its transcript was not saved. Nothing was sent again.`, credits: charged });
  });
});

test("a reservation whose acknowledgement was lost is found by its event and released before the answer says nothing was charged", async () => {
  const ws = await setup("lost-reservation", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(SOURCE_S) };
    const said = { error: "The transcription could not be reserved. Nothing was sent or charged; try again.", charged: 0 };
    /* Committed, then the reply to the commit was lost. */
    const { deps, calls } = await provider(SPOKEN_S);
    deps.reserve = async (event, options) => { await reserveGenerationSpend(event, options); throw new Error("connection reset after commit"); };
    const landed = await send(body, "stt-lost-reserve1", deps);
    expect(landed.status).toBe(503);
    expect(landed.headers.get("Idempotency-Status")).toBe("complete");
    expect(await landed.json()).toEqual(said);
    expect(await left(ws.id, "stt-lost-reserve1")).toEqual({ saved: false, answered: 503, bill: null, meter: { status: "failed", credits: 0 }, debited: 0, drawn: 0 });
    expect(await check("stt-lost-reserve1", body)).toEqual({ state: "refused", status: 503, error: said.error });
    /* Refused by the connection before anything landed: nothing to release, the same answer, and no event written. */
    deps.reserve = async () => { throw new Error("connection refused"); };
    const never = await send(body, "stt-lost-reserve2", deps);
    expect(await never.json()).toEqual(said);
    expect(await left(ws.id, "stt-lost-reserve2")).toMatchObject({ answered: 503, meter: null, debited: 0 });
    /* A refusal of the reservation itself says what it is, as before. */
    const { SpendReservationError } = await import("../../lib/generationRequests");
    deps.reserve = async () => { throw new SpendReservationError("Every job slot is reserved. Wait for an active job to finish, then try again.", 409); };
    expect(await (await send(body, "stt-lost-reserve3", deps)).json()).toEqual({ error: "Every job slot is reserved. Wait for an active job to finish, then try again.", charged: 0 });
    expect(calls.n).toBe(0);
  });
});

test("a request that fails before it reserves is answered at once, interrupted with nothing charged, not left waiting on its window", async () => {
  const ws = await setup("failed-early", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: await estimate(SOURCE_S) };
    const key = "stt-failed-early";
    const { deps, calls } = await provider(SPOKEN_S);
    /* The workspace database fails the source lookup. */
    await db().execute("ALTER TABLE uploads RENAME TO uploads_away");
    let reply: Response;
    try { reply = await send(body, key, deps); }
    finally { await db().execute("ALTER TABLE uploads_away RENAME TO uploads"); }
    expect(reply.status).toBe(409);
    expect(reply.headers.get("Idempotency-Status")).toBe("complete");
    expect(await reply.json()).toEqual({ error: "It was interrupted before anything was charged.", charged: 0 });
    expect(await check(key, body)).toEqual({ state: "refused", status: 409, error: "It was interrupted before anything was charged." });
    expect(calls.n).toBe(0);
    expect(await left(ws.id, key)).toEqual({ saved: false, answered: 409, bill: null, meter: null, debited: 0, drawn: 0 });
  });
});

test("a request that fails after the provider answered, before its transcript was saved, is answered at once: its reservation held for review", async () => {
  const ws = await setup("failed-late", SOURCE_S);
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: reserved };
    const key = "stt-failed-late";
    const { deps, calls } = await provider(SPOKEN_S);
    deps.step = (step) => { if (step === "transcribed") throw new Error("the transcript could not be saved"); };
    const reply = await send(body, key, deps);
    const held = `Your last transcription stopped without an answer. Its ${creditsWord(reserved)} stay reserved for review. Nothing was sent again.`;
    expect(reply.status).toBe(502);
    expect(reply.headers.get("Idempotency-Status")).toBe("complete");
    expect(await reply.json()).toEqual({ error: held, code: "uncertain", charged: reserved });
    expect(await check(key, body)).toEqual({ state: "unknown", error: held, credits: reserved });
    expect(calls.n).toBe(1);
    expect(await left(ws.id, key)).toEqual({ saved: false, answered: 502, bill: null, meter: { status: "running", credits: reserved }, debited: reserved, drawn: reserved });
  });
});

test("a transcription killed mid-run keeps its credits held for review but frees its job slot once its window has passed", async () => {
  const ws = { ...(await setup("slots", SOURCE_S)), concurrency: 1 };
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  const { reserveGenerationSpend, TRANSCRIPTION_STALE_MS } = await import("../../lib/generationRequests");
  const { transcriptionEventId } = await import("../../lib/transcription");
  const { GROK_STT_MODEL, grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  await runInTenant(ws, async () => {
    const reserved = await estimate(SOURCE_S);
    const key = "stt-killed-slot";
    const { deps, reached } = await killedAt("transcribed");
    void send({ sourceUploadId: "up_line", diarize: true, maxCredits: reserved }, key, deps);
    await reached;
    const next = { id: `stt_${"b".repeat(32)}`, kind: "audio" as const, engine: "xai", model: GROK_STT_MODEL, status: "running" as const, engineCostUsd: grokTranscriptionUsd(60) };
    /* It may still be running: the workspace's one slot is taken. */
    await expect(reserveGenerationSpend(next)).rejects.toThrow("Every job slot is reserved");
    /* Past its window no function can be running it: the slot is free again, and its credits stay held. */
    const killed = transcriptionEventId(ws.id, { userId: USER, key });
    await platformDb().execute({ sql: "UPDATE meter_events SET created_at=? WHERE id=?", args: [Date.now() - TRANSCRIPTION_STALE_MS - 60_000, killed] });
    await reserveGenerationSpend(next);
    const rows = await meterRows(ws.id);
    expect(rows.find((r) => r.id === killed)).toMatchObject({ status: "running", credits: reserved });
    expect(rows.find((r) => r.id === next.id)).toMatchObject({ status: "running" });
    /* A fresh transcription holds its slot like any job. */
    await expect(reserveGenerationSpend({ ...next, id: `stt_${"c".repeat(32)}` })).rejects.toThrow("Every job slot is reserved");
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

test("the check's answers: never arrived or refused let go of the claim; no answer yet or unanswerable keep it and send nothing", async () => {
  const { settlePendingTranscription, transcriptionSlot } = await import("../../lib/workbench/transcription-request");
  const { claimPendingGeneration, readPendingGeneration } = await import("../../lib/workbench/pending-generation");
  const slot = transcriptionSlot(SCOPE, "prod", { uploadId: "up_a" }, { diarize: true });
  const earlier = { key: "earlier-transcript-1", body: JSON.stringify({ sourceUploadId: "up_a", diarize: true, maxCredits: 4 }), credits: 4, endpoint: "/api/audio/transcribe" as const };
  const cases: [Answer, unknown, boolean][] = [
    [{ json: { state: "absent" } }, { state: "released", reason: "Your last transcription never reached the server. Nothing was charged for it.", failed: false }, false],
    [{ json: { state: "refused", status: 502, error: "Grok could not transcribe this take (500). Nothing was charged for it." } },
      { state: "released", reason: "Your last transcription did not complete. Grok could not transcribe this take (500). Nothing was charged for it.", failed: true }, false],
    [{ json: { state: "unknown", error: "Your last transcription stopped without an answer. Its 4 credits stay reserved for review. Nothing was sent again.", credits: 4 } },
      { state: "released", reason: "Your last transcription stopped without an answer. Its 4 credits stay reserved for review. Nothing was sent again.", failed: true }, false],
    [{ json: { state: "pending" } }, { state: "unknown", reason: "Your last transcription has no answer yet and is being checked. Nothing new was sent.", waiting: true }, true],
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
    [{ status: 502, json: { error: "Grok could not transcribe this take (500). Nothing was charged for it.", charged: 0 }, headers: { "Idempotency-Status": "complete" } },
      { state: "released", reason: "Grok could not transcribe this take (500). Nothing was charged for it.", failed: true }, false],
    [{ status: 409, json: { error: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", estimatedCredits: 5 }, headers: { "Idempotency-Status": "complete" } },
      { state: "released", reason: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", failed: true, repriced: 5 }, false],
    [{ status: 402, json: { error: "Every job slot is reserved. Wait for an active job to finish, then try again.", charged: 0, estimatedCredits: 5 }, headers: { "Idempotency-Status": "complete" } },
      { state: "released", reason: "Every job slot is reserved. Wait for an active job to finish, then try again.", failed: true }, false],
    [{ status: 409, json: { error: "This request is still being accepted. Retry with the same Idempotency-Key; it will not submit another generation.", pending: true } },
      { state: "unknown", reason: "Your last transcription has no answer yet and is being checked. Nothing new was sent.", waiting: true }, true],
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
