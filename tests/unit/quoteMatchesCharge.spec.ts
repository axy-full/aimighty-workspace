import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";
import type { TranscriptionDeps } from "../../lib/transcription";
import { creditsFigure, fromDeci, toDeci } from "../../lib/creditTerms";

/** A tenth of a credit less: the smallest step a charge, a ceiling or a balance takes. */
const less = (credits: number) => fromDeci(toDeci(credits) - 1);

/**
 * The price a person approves is what is reserved and charged for it. A Grok
 * transcription and a Grok Voice line are quoted, held to their approval
 * ceiling and checked against the balance — a line also against its
 * production's cap — at the terms their reservation and settlement charge
 * (lib/billingTerms.ts currentBillingTerms). Here every key either could be
 * priced at (the vendor, the audio class, the model, the fallback) has its own
 * margin, a different multiple of the fallback's, so a quote read at any key
 * but the reservation's is a different number of credits and these fail.
 * Local databases, a stubbed transcription provider and ENGINE_MOCK: nothing is
 * billed, and nothing leaves the process.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-quote-terms-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const USER = "owner";
const actor: AdmissionActor = {
  user: { id: USER, email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const originalFetch = globalThis.fetch;
let restoreMargins: (() => void) | null = null;

test.beforeAll(async () => {
  const { margins, marginFor } = await import("../../lib/creditTerms");
  const { GROK_STT_MODEL, GROK_TTS_MODEL } = await import("../../lib/xaiVoice");
  const table = margins();
  const before = { ...table };
  const fallback = marginFor("*");
  /* Distinct multiples of whatever the fallback is: no figure is stated, and no two keys agree. */
  [["xai", 2], ["elevenlabs", 3], [GROK_STT_MODEL, 5], [GROK_TTS_MODEL, 7]].forEach(([key, times]) => { table[key as string] = fallback * Number(times); });
  restoreMargins = () => {
    for (const key of Object.keys(table)) delete table[key];
    Object.assign(table, before);
  };
});
test.afterAll(() => restoreMargins?.());
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

/** A registered workspace on the platform's keys holding exactly `credits`. */
async function workspace(name: string, credits: number): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  const id = `ws_terms_${name}_${randomUUID().slice(0, 8)}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,?,0,0)",
    args: [id, id, name, `file:${path.join(dir, `${id}.db`)}`, USER],
  });
  if (credits > 0) await grantCredits(id, credits, "Test funds", USER, "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

async function meterRow(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits) } : null;
}

async function balance(workspaceId: string) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(workspaceId)).credits.balance;
}

/** The margin table tells every key apart at this estimate, so agreeing on the credits means agreeing on the key. */
async function keysDiffer(usd: number, model: string) {
  const { billCredits } = await import("../../lib/creditTerms");
  const byKey = ["*", "xai", "elevenlabs", model].map((key) => billCredits(usd, key));
  expect(new Set(byKey).size, "each key prices this estimate differently").toBe(byKey.length);
}

/* ── Transcription (lib/transcription.ts) ── */

const SECONDS = 1800;
const ROUTE = "/api/audio/transcribe";

/** A workspace holding `credits` and one audio upload measured at SECONDS. */
async function transcriptionWorkspace(name: string, credits: number) {
  const ws = await workspace(name, credits);
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,0)",
      args: ["up_line", "line.wav", "audio/wav", "wav", 1000, "sha", "/api/uploads/up_line", "audio", SECONDS],
    });
  });
  return ws;
}

/** The provider stub reports a transcript as long as the source, priced as the adapter prices it. */
async function provider(onStep?: TranscriptionDeps["step"]): Promise<TranscriptionDeps> {
  const { grokTranscriptionUsd } = await import("../../lib/xaiVoice");
  return {
    readSource: async () => Buffer.from("audio"),
    provider: async () => ({ text: "Not tonight.", language: "en", seconds: SECONDS, words: [{ text: "Not", start: 0, end: 0.3, speaker: 0 }], costUsd: grokTranscriptionUsd(SECONDS) }),
    step: onStep,
  };
}

/** POST /api/audio/transcribe as the route composes it: the claim, then the transcription inside it. */
async function transcribeOnce(body: Record<string, unknown>, key: string, deps: TranscriptionDeps) {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { transcribe } = await import("../../lib/transcription");
  const req = new Request(`http://localhost${ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
  const response = await withGenerationRequest(req, USER, async (claim) => {
    const reply = await transcribe(body, USER, { claim, deps });
    return Response.json(reply.body, { status: reply.status });
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a transcription is reserved and charged the credits its quote showed, its ceiling is that quote, and the credit wall asks for it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { transcribe, transcriptionEventId } = await import("../../lib/transcription");
  const { grokTranscriptionUsd, GROK_STT_MODEL } = await import("../../lib/xaiVoice");
  await keysDiffer(grokTranscriptionUsd(SECONDS), GROK_STT_MODEL);

  const ws = await transcriptionWorkspace("stt", 1_000_000);
  const shown = await runInTenant(ws, async () => {
    const quote = await transcribe({ sourceUploadId: "up_line", diarize: true, quoteOnly: true }, USER);
    expect(quote.status).toBe(200);
    const shown = Number(quote.body.estimatedCredits);
    expect(shown).toBeGreaterThanOrEqual(0.2);
    const body = { sourceUploadId: "up_line", diarize: true, maxCredits: shown };

    /* A ceiling a tenth under the quote (credits are charged in tenths) is refused before anything is reserved, with the quote. */
    const under = await transcribeOnce({ ...body, maxCredits: less(shown) }, "stt-terms-under-0001", await provider());
    expect(under.status).toBe(409);
    expect(under.body.estimatedCredits).toBe(shown);
    expect(await meterRow(transcriptionEventId(ws.id, { userId: USER, key: "stt-terms-under-0001" }))).toBeNull();

    /* At the quote: reserved at it, then charged it for a transcript as long as its source. */
    const key = "stt-terms-paid-0001";
    const event = transcriptionEventId(ws.id, { userId: USER, key });
    let reserved: { status: string; credits: number } | null = null;
    const paid = await transcribeOnce(body, key, await provider(async (step) => { if (step === "reserved") reserved = await meterRow(event); }));
    expect(paid.status).toBe(200);
    expect(reserved).toEqual({ status: "running", credits: shown });
    expect(paid.body.credits).toBe(shown);
    expect(await meterRow(event)).toEqual({ status: "succeeded", credits: shown });
    return shown;
  });

  /* The credit wall asks for the quote: exactly that balance is enough, and a tenth less is refused, naming it. */
  const exact = await transcriptionWorkspace("stt-exact", shown);
  await runInTenant(exact, async () => {
    const paid = await transcribeOnce({ sourceUploadId: "up_line", diarize: true, maxCredits: shown }, "stt-terms-exact-0001", await provider());
    expect(paid.status).toBe(200);
    expect(paid.body.credits).toBe(shown);
  });
  expect(await balance(exact.id)).toBe(0);
  const short = await transcriptionWorkspace("stt-short", less(shown));
  await runInTenant(short, async () => {
    const refused = await transcribeOnce({ sourceUploadId: "up_line", diarize: true, maxCredits: shown }, "stt-terms-short-0001", await provider());
    expect(refused.status).toBe(402);
    expect(String(refused.body.error)).toContain(`this needs ${creditsFigure(shown)}, ${creditsFigure(less(shown))} left`);
    expect(await meterRow(transcriptionEventId(short.id, { userId: USER, key: "stt-terms-short-0001" }))).toBeNull();
  });
  expect(await balance(short.id)).toBe(less(shown));
});

/* ── Grok Voice (lib/audioAdmission.ts, speech on grok-tts) ── */

const LINE = "The ferry is here, and it will not wait for anyone tonight. ".repeat(80).trim().slice(0, 4800);
const options = { defer: async () => {} };
const speech = (voice: Record<string, unknown> = {}) => ({ task: "speech", modelId: "grok-tts", voiceId: "eve", text: LINE, ...voice });

async function projects(rows: [id: string, capCredits: number | null][]) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  for (const [id, cap] of rows) await db().execute({ sql: "INSERT INTO projects(id,name,cap_credits,created_at) VALUES(?,?,?,0)", args: [id, id, cap] });
}

test("a Grok Voice line is reserved the credits its quote and its prepared quote showed; its ceiling, the credit wall and the production's cap all ask for that figure", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { executeAudioAdmission, prepareAudio, admitAudio } = await import("../../lib/audioAdmission");
  const { grokSpeechUsd, GROK_TTS_MODEL } = await import("../../lib/xaiVoice");
  expect(GROK_TTS_MODEL).toBe("grok-tts");
  await keysDiffer(grokSpeechUsd(LINE), GROK_TTS_MODEL);

  const ws = await workspace("voice", 1_000_000);
  const shown = await runInTenant(ws, async () => {
    const quote = await executeAudioAdmission(speech({ quoteOnly: true }), actor, options);
    expect(quote.status).toBe(200);
    expect(quote.body.unit).toBe("cr");
    const shown = Number(quote.body.estimatedCredits);
    expect(shown).toBeGreaterThanOrEqual(0.2);
    expect(quote.body.price).toBe(shown);

    /* A ceiling a tenth under the quote is refused before anything is filed. */
    const under = await executeAudioAdmission(speech({ maxCredits: less(shown) }), actor, { ...options, requestClaim: { userId: USER, key: "voice-terms-under-1" } });
    expect(under.status).toBe(409);

    /* At the quote: reserved at it. */
    const admitted = await executeAudioAdmission(speech({ maxCredits: shown }), actor, { ...options, requestClaim: { userId: USER, key: "voice-terms-paid-1" } });
    expect(admitted.status).toBe(200);
    expect(admitted.body).toMatchObject({ status: "running", estimatedCredits: shown });
    expect(await meterRow(String(admitted.body.id))).toEqual({ status: "running", credits: shown });

    /* The production's cap asks for the quote: a cap of exactly it admits the line, a tenth less refuses it before it is filed. */
    await projects([["p_exact", shown], ["p_under", less(shown)]]);
    const capped = await executeAudioAdmission(speech({ maxCredits: shown, projectId: "p_under" }), actor, { ...options, requestClaim: { userId: USER, key: "voice-terms-cap-under-1" } });
    expect(capped.status).toBe(409);
    expect(String(capped.body.error)).toContain(`this needs ${creditsFigure(shown)} cr`);
    const fits = await executeAudioAdmission(speech({ maxCredits: shown, projectId: "p_exact" }), actor, { ...options, requestClaim: { userId: USER, key: "voice-terms-cap-exact-1" } });
    expect(fits.status).toBe(200);
    expect(await meterRow(String(fits.body.id))).toEqual({ status: "running", credits: shown });
    return shown;
  }, { user: actor.user });

  /* A prepared line (the pipeline's quote, then its admission) is quoted and reserved the same figure. */
  const piped = await workspace("voice-prepared", 1_000_000);
  await runInTenant(piped, async () => {
    const prepared = await prepareAudio(speech(), actor);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.quote.estimatedCredits).toBe(shown);
    expect(prepared.value.request.maxCredits).toBe(shown);
    const admitted = await admitAudio(prepared.value, actor, { requestKey: "voice-terms-prepared-1", defer: options.defer });
    expect(admitted.status).toBe(200);
    expect(await meterRow(String(admitted.body.id))).toEqual({ status: "running", credits: shown });
  }, { user: actor.user });

  /* The credit wall asks for the quote: exactly that balance is reserved, a tenth less is held for credits with nothing reserved. */
  const exact = await workspace("voice-exact", shown);
  await runInTenant(exact, async () => {
    const admitted = await executeAudioAdmission(speech({ maxCredits: shown }), actor, { ...options, requestClaim: { userId: USER, key: "voice-terms-exact-1" } });
    expect(admitted.status).toBe(200);
    expect(admitted.body).toMatchObject({ status: "running" });
    expect(await meterRow(String(admitted.body.id))).toEqual({ status: "running", credits: shown });
  }, { user: actor.user });
  expect(await balance(exact.id)).toBe(0);
  const short = await workspace("voice-short", less(shown));
  await runInTenant(short, async () => {
    const held = await executeAudioAdmission(speech({ maxCredits: shown }), actor, { ...options, requestClaim: { userId: USER, key: "voice-terms-short-1" } });
    expect(held.status).toBe(202);
    expect(held.body).toMatchObject({ status: "held", held: true, needs: shown });
    expect(await meterRow(String(held.body.id))).toBeNull();
  }, { user: actor.user });
  expect(await balance(short.id)).toBe(less(shown));
});
