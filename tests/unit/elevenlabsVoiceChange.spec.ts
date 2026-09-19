import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";
import { wav } from "./audioFixtures";

/**
 * Voice change (PR C2, part 2): audio task `voiceChange` on the existing
 * admission, priced per started minute of the SOURCE from lib/vendorRates.ts,
 * calling POST /v1/speech-to-speech/{voice_id} as multipart on
 * eleven_multilingual_sts_v2. Nothing here reaches the network.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-eleven-voicechange-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const originalFetch = globalThis.fetch;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const UPLOADS = path.join(process.cwd(), ".data", "uploads");
const stamp = `vc${Date.now().toString(36)}`;
const written: string[] = [];
function put(name: string, bytes: Buffer) {
  mkdirSync(UPLOADS, { recursive: true });
  const file = path.join(UPLOADS, name);
  writeFileSync(file, bytes);
  written.push(file);
}
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_BASE_URL; });
test.afterAll(() => { for (const file of written) rmSync(file, { force: true }); });

test("voice change is priced per started minute of input at the vendor rate", async () => {
  const { ELEVENLABS_RATES } = await import("../../lib/vendorRates");
  const { voiceChangeUsd, VOICE_CHANGE_MODEL } = await import("../../lib/elevenlabs");
  expect(ELEVENLABS_RATES.voiceChange).toMatchObject({ modelId: "eleven_multilingual_sts_v2", usdPerMinute: 0.12 });
  expect(VOICE_CHANGE_MODEL).toBe("eleven_multilingual_sts_v2");
  expect(voiceChangeUsd(1)).toBe(0.12);
  expect(voiceChangeUsd(60)).toBe(0.12);
  expect(voiceChangeUsd(61)).toBe(0.24);
  expect(voiceChangeUsd(150)).toBe(0.36);
  expect(() => voiceChangeUsd(0)).toThrow(/length/);
  expect(() => voiceChangeUsd(NaN)).toThrow(/length/);
});

test("speechToSpeech posts the source as multipart audio to /v1/speech-to-speech/{voice} with only the documented fields", async () => {
  process.env.ENGINE_MOCK = "0";
  process.env.ELEVENLABS_API_KEY = "unit-eleven-key";
  process.env.ELEVENLABS_BASE_URL = "https://eleven.test";
  const { speechToSpeech } = await import("../../lib/elevenlabs");
  const { elevenlabs } = await import("../../lib/engines/elevenlabs");
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(Buffer.from("ID3changed"), { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "req-sts-1" } });
  };
  const source = wav(0.5);
  const out = await speechToSpeech({ voiceId: "voiceAAA01", audio: source, filename: "Take 1.wav", mime: "audio/wav", seconds: 61, removeBackgroundNoise: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://eleven.test/v1/speech-to-speech/voiceAAA01?output_format=mp3_44100_128");
  expect(calls[0].init?.method).toBe("POST");
  const headers = calls[0].init?.headers as Record<string, string>;
  expect(headers["xi-api-key"]).toBe("unit-eleven-key");
  expect(headers.Accept).toBe("audio/mpeg");
  expect(headers["Content-Type"]).toBeUndefined(); // multipart boundary is the runtime's
  const form = calls[0].init?.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect([...form.keys()].sort()).toEqual(["audio", "model_id", "remove_background_noise"]);
  expect(form.get("model_id")).toBe("eleven_multilingual_sts_v2");
  expect(form.get("remove_background_noise")).toBe("true");
  const file = form.get("audio") as File;
  expect(file.name).toBe("Take 1.wav");
  expect(file.type).toBe("audio/wav");
  expect(Buffer.from(await file.arrayBuffer()).equals(source)).toBe(true);
  expect(out.bytes.toString()).toBe("ID3changed");
  expect(out.costUsd).toBe(0.24);
  expect(out.credits).toBeNull();
  expect(out.requestId).toBe("req-sts-1");
  // Optional fields are absent unless given; nothing unverified is ever sent.
  await speechToSpeech({ voiceId: "voiceAAA01", audio: source, filename: "a.wav", mime: "audio/wav", seconds: 5, seed: 7, settings: { stability: 0.4 } });
  const second = calls[1].init?.body as FormData;
  expect([...second.keys()].sort()).toEqual(["audio", "model_id", "seed", "voice_settings"]);
  expect(second.get("seed")).toBe("7");
  expect(JSON.parse(String(second.get("voice_settings")))).toEqual({ stability: 0.4 });
  // The engine adapter estimates from the measured source length and refuses to guess.
  expect(elevenlabs.estimate({ kind: "audio", genId: "g", modelId: "eleven_multilingual_sts_v2", task: "voiceChange", text: "", params: { sourceSeconds: 61 } })).toBe(0.24);
  expect(elevenlabs.estimate({ kind: "audio", genId: "g", modelId: "eleven_multilingual_sts_v2", task: "voiceChange", text: "", params: {} })).toBeNull();
  // A vendor refusal is a received rejection, never a retry.
  globalThis.fetch = async () => Response.json({ detail: { status: "invalid_request", message: "bad voice" } }, { status: 422 });
  await expect(speechToSpeech({ voiceId: "voiceAAA01", audio: source, filename: "a.wav", mime: "audio/wav", seconds: 5 })).rejects.toMatchObject({ status: 422, rejectedBeforeGeneration: true });
  // A source over the bound is refused before any call.
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  await expect(speechToSpeech({ voiceId: "voiceAAA01", audio: Buffer.alloc(100 * 1024 * 1024 + 1), filename: "a.wav", mime: "audio/wav", seconds: 5 })).rejects.toThrow(/up to 100 MB/);
});

test("the admission quotes a voice change from the source's stored length and refuses one it cannot measure", async () => {
  process.env.ENGINE_MOCK = "1";
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { executeAudioAdmission } = await import("../../lib/audioAdmission");
  const { billCredits } = await import("../../lib/creditTerms");
  await platformReady();
  const id = "voicechange-quote";
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 100, "Test funds", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await runInTenant(ws, async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
    const options = { defer: async () => {} };
    const insert = (uploadId: string, ext: string, mime: string, kind: string, bytes: number, seconds: number | null) => db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?,?)",
      args: [uploadId, `${uploadId}.${ext}`, mime, ext, bytes, "x", `/api/uploads/${uploadId}`, kind, seconds, Date.now()],
    });
    // A stored length prices without touching the file: 90 s → 2 started minutes.
    await insert(`${stamp}-known`, "mp3", "audio/mpeg", "audio", 1000, 90);
    const quote = await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-known`, voiceId: "voiceAAA01", projectId: "project", quoteOnly: true }, actor, options);
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ estimatedCredits: billCredits(0.24, "elevenlabs"), unit: "cr", sourceSeconds: 90, minutes: 2 });
    // A missing length is measured on first read (a real WAV on disk), then persisted.
    const bytes = wav(1);
    put(`${stamp}-measure.wav`, bytes);
    await insert(`${stamp}-measure`, "wav", "audio/wav", "audio", bytes.length, null);
    const measured = await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-measure`, voiceId: "voiceAAA01", projectId: "project", quoteOnly: true }, actor, options);
    expect(measured.status).toBe(200);
    expect(measured.body).toMatchObject({ estimatedCredits: billCredits(0.12, "elevenlabs"), minutes: 1 });
    expect(Number((await db().execute({ sql: "SELECT duration_s FROM uploads WHERE id=?", args: [`${stamp}-measure`] })).rows[0].duration_s)).toBeCloseTo(1, 3);
    // No length and nothing readable: refused, with the reason, and no row filed.
    put(`${stamp}-mystery.mp3`, Buffer.from("plainly not audio ".repeat(20)));
    await insert(`${stamp}-mystery`, "mp3", "audio/mpeg", "audio", 360, null);
    const refused = await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-mystery`, voiceId: "voiceAAA01", projectId: "project", quoteOnly: true }, actor, options);
    expect(refused.status).toBe(422);
    expect(String(refused.body.error)).toMatch(/no measured length/);
    // A video is not a voice change source; a missing source, a missing voice and two sources are each refused.
    await insert(`${stamp}-video`, "mp4", "video/mp4", "video", 1000, 12);
    expect((await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-video`, voiceId: "voiceAAA01", quoteOnly: true }, actor, options)).status).toBe(400);
    expect((await executeAudioAdmission({ task: "voiceChange", sourceUploadId: "nope", voiceId: "voiceAAA01", quoteOnly: true }, actor, options)).status).toBe(404);
    expect((await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-known`, quoteOnly: true }, actor, options)).status).toBe(400);
    expect((await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-known`, sourceGenId: "g", voiceId: "voiceAAA01", quoteOnly: true }, actor, options)).status).toBe(400);
    expect((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n).toBe(0);
    // Submitted: the row carries the source, its seconds and the dollar estimate the settlement will use.
    const submitted = await executeAudioAdmission(
      { task: "voiceChange", sourceUploadId: `${stamp}-known`, voiceId: "voiceAAA01", voiceName: "Avery", projectId: "project", maxCredits: billCredits(0.24, "elevenlabs"), title: "Take 1 · voice changed (Avery)" },
      actor, { ...options, requestClaim: { userId: "owner", key: "voice-change-request-1" } },
    );
    expect(submitted.status).toBe(200);
    const row = (await db().execute({ sql: "SELECT model,prompt,params,title,status FROM generations WHERE id=?", args: [String(submitted.body.id)] })).rows[0];
    expect(row.model).toBe("eleven_multilingual_sts_v2");
    expect(row.title).toBe("Take 1 · voice changed (Avery)");
    expect(String(row.prompt)).toMatch(/^Voice change · /);
    expect(JSON.parse(String(row.params))).toMatchObject({ task: "voiceChange", sourceUploadId: `${stamp}-known`, sourceSeconds: 90, voiceId: "voiceAAA01", estUsd: 0.24, removeBackgroundNoise: false });
    // Too low a ceiling is refused before anything is filed.
    const over = await executeAudioAdmission({ task: "voiceChange", sourceUploadId: `${stamp}-known`, voiceId: "voiceAAA01", projectId: "project", maxCredits: 1 }, actor, options);
    expect(over.status).toBe(409);
  }, actor);
});
