import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";
import { wav } from "./audioFixtures";

/**
 * Stored durations (PR C2, part 1): every audio and video original the app
 * keeps records its length in seconds when the bounded inspector can read
 * it, on the row, and is backfilled lazily on first read. Fixtures: a WAV
 * generated here (two seconds at 48 kHz) and the checked-in three-second
 * tone.mp3 the mocks play. No network, no decoder.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-media-duration-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const originalFetch = globalThis.fetch;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
/** Local storage lives under the checkout's .data; every file here carries the test's own id and is removed after. */
const UPLOADS = path.join(process.cwd(), ".data", "uploads");
const GENERATIONS = path.join(process.cwd(), ".data", "generations");
const stamp = `md${Date.now().toString(36)}`;
const written: string[] = [];
function put(folder: string, name: string, bytes: Buffer) {
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  writeFileSync(file, bytes);
  written.push(file);
  return file;
}
const tone = readFileSync(path.resolve("public/fixtures/tone.mp3"));

test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.afterAll(() => { for (const file of written) rmSync(file, { force: true }); });

test("audio headers are identified without decoding, and lengths are read from a buffer within the budget", async () => {
  const { identifyAudio } = await import("../../lib/audioMeta");
  const { inspectAudioBuffer, billableMinutes } = await import("../../lib/mediaSource.server");
  expect(identifyAudio(wav(0.1))).toEqual({ kind: "audio", mime: "audio/wav", ext: "wav" });
  expect(identifyAudio(tone)).toEqual({ kind: "audio", mime: "audio/mpeg", ext: "mp3" });
  expect(identifyAudio(Buffer.from("\x89PNG\r\n\x1a\n" + "0".repeat(30)))).toBeNull();
  expect(identifyAudio(Buffer.alloc(4))).toBeNull();
  const two = await inspectAudioBuffer(wav(2));
  expect(two.seconds).toBeCloseTo(2, 3);
  expect(two.sampleRate).toBe(48000);
  expect(two.channels).toBe(1);
  const mp3 = await inspectAudioBuffer(tone);
  expect(mp3.seconds).toBeGreaterThan(2.5);
  expect(mp3.seconds).toBeLessThan(3.5);
  await expect(inspectAudioBuffer(Buffer.from("not audio at all, just text"))).rejects.toThrow();
  await expect(inspectAudioBuffer(Buffer.alloc(0))).rejects.toThrow(/up to 100 MB/);
  expect(billableMinutes(0.5)).toBe(1);
  expect(billableMinutes(60)).toBe(1);
  expect(billableMinutes(60.01)).toBe(2);
  expect(billableMinutes(181)).toBe(4);
});

test("a stored upload or generation without a length is measured once through storage, persisted, then read from its column", async () => {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { findStoredSource, resolveStoredDuration, inspectOriginalAudio, readStoredSourceBytes } = await import("../../lib/mediaSource.server");
  await platformReady();
  const id = "duration-backfill";
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await runInTenant(ws, async () => {
    await ready();
    // An upload whose finish never measured it (an older row): kind "file", no mime, a .wav extension.
    const wavId = `${stamp}-wav`, bytes = wav(1.5);
    put(UPLOADS, `${wavId}.wav`, bytes);
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,NULL,?)",
      args: [wavId, "Take 1.wav", "application/octet-stream", "wav", bytes.length, "x", `/api/uploads/${wavId}`, "file", Date.now()],
    });
    const source = (await findStoredSource({ uploadId: wavId }))!;
    expect(source).toMatchObject({ kind: "upload", id: wavId, mediaKind: "audio", name: "Take 1.wav", ext: "wav", bytes: bytes.length, seconds: null });
    const measured = await inspectOriginalAudio(source);
    expect(measured.seconds).toBeCloseTo(1.5, 3);
    expect((await resolveStoredDuration(source)).seconds).toBeCloseTo(1.5, 3);
    expect(Number((await db().execute({ sql: "SELECT duration_s FROM uploads WHERE id=?", args: [wavId] })).rows[0].duration_s)).toBeCloseTo(1.5, 3);
    // Second read: the column answers, and the file is not needed.
    rmSync(path.join(UPLOADS, `${wavId}.wav`));
    const again = (await findStoredSource({ uploadId: wavId }))!;
    expect(again.seconds).toBeCloseTo(1.5, 3);
    expect((await resolveStoredDuration(again)).seconds).toBeCloseTo(1.5, 3);
    // An unreadable file: null with the reason, nothing persisted.
    const badId = `${stamp}-bad`;
    put(UPLOADS, `${badId}.mp3`, Buffer.from("this is not an mp3 " + "x".repeat(200)));
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,NULL,?)",
      args: [badId, "broken.mp3", "audio/mpeg", "mp3", 219, "x", `/api/uploads/${badId}`, "audio", Date.now()],
    });
    const bad = (await findStoredSource({ uploadId: badId }))!;
    const verdict = await resolveStoredDuration(bad);
    expect(verdict.seconds).toBeNull();
    expect(verdict.reason).toBeTruthy();
    expect((await db().execute({ sql: "SELECT duration_s FROM uploads WHERE id=?", args: [badId] })).rows[0].duration_s).toBeNull();
    // A generated audio original: measured from its stored MP3, persisted on generations.duration_s.
    const genId = `${stamp}-gen`;
    put(GENERATIONS, `${genId}.mp3`, tone);
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,kind,created_at,updated_at) VALUES(?,?,?,?,'succeeded',?,?,'audio',1,1)",
      args: [genId, "eleven_multilingual_v2", "A line", JSON.stringify({ task: "speech" }), `/api/media/${genId}`, tone.length],
    });
    const gen = (await findStoredSource({ genId }))!;
    expect(gen).toMatchObject({ kind: "generation", mediaKind: "audio", mime: "audio/mpeg", ext: "mp3", seconds: null });
    const seconds = (await resolveStoredDuration(gen)).seconds!;
    expect(seconds).toBeGreaterThan(2.5);
    expect(Number((await db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [genId] })).rows[0].duration_s)).toBeCloseTo(seconds, 3);
    expect((await readStoredSourceBytes(gen)).equals(tone)).toBe(true);
    // Images and unfinished generations are not sources.
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,1,1,?,?,NULL,?)",
      args: [`${stamp}-png`, "still.png", "image/png", "png", 10, "x", "/api/uploads/x", "image", Date.now()],
    });
    expect(await findStoredSource({ uploadId: `${stamp}-png` })).toBeNull();
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,kind,created_at,updated_at) VALUES(?,?,?,?,'running','audio',1,1)",
      args: [`${stamp}-running`, "eleven_sfx", "Rain", "{}"],
    });
    expect(await findStoredSource({ genId: `${stamp}-running` })).toBeNull();
    expect(await findStoredSource({ uploadId: "missing" })).toBeNull();
  }, actor);
});

test("a delivered audio take records its own length when sealed", async () => {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { loadJob, produce, seal } = await import("../../lib/renderWork");
  await platformReady();
  const id = "duration-seal";
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 100, "Test funds", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await runInTenant(ws, async () => {
    await ready();
    const genId = `${stamp}-sealed`;
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,kind,provider,created_at,updated_at) VALUES(?,?,?,?,'running','audio','elevenlabs',?,?)",
      args: [genId, "eleven_sfx", "Rain on a tin roof", JSON.stringify({ task: "sound", durationSeconds: 3, estCredits: 200 }), Date.now(), Date.now()],
    });
    await reserveGenerationSpend({ id: genId, kind: "audio", engine: "elevenlabs", model: "eleven_sfx", status: "running", engineCostUsd: 0.05 });
    const job = (await loadJob(genId))!;
    const out = (await produce(job))!;
    written.push(path.join(GENERATIONS, `${genId}.mp3`));
    expect(out.kind).toBe("audio");
    expect(out.kind === "audio" && out.seconds).toBeGreaterThan(2.5);
    await seal(job, out);
    const row = (await db().execute({ sql: "SELECT status,duration_s FROM generations WHERE id=?", args: [genId] })).rows[0];
    expect(row.status).toBe("succeeded");
    expect(Number(row.duration_s)).toBeGreaterThan(2.5);
    // A row the sound tools can now read, with its length, without measuring again.
    const { findStoredSource } = await import("../../lib/mediaSource.server");
    expect((await findStoredSource({ genId }))?.seconds).toBeGreaterThan(2.5);
  }, actor);
});
