import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* What the sound tools (voice change, dubbing, transcription) accept as a
   source: an .m4a is sound, and a long interview is measurable. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-sound-sources-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const UPLOADS = path.join(process.cwd(), ".data", "uploads");
const stamp = `ss${Date.now().toString(36)}`;
const written: string[] = [];
test.afterAll(() => { for (const file of written) rmSync(file, { force: true }); });

/** An ISO BMFF head with the given major and compatible brands. */
function ftyp(major: string, compatible: string[]): Buffer {
  const box = Buffer.alloc(16 + compatible.length * 4);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  compatible.forEach((brand, i) => box.write(brand, 16 + i * 4, "latin1"));
  return Buffer.concat([box, Buffer.alloc(64)]);
}

/** The checked-in 1.5 s clip with its sample durations stretched: the same picture, 7.5 minutes long. */
function longClip(): Buffer {
  const bytes = Buffer.from(readFileSync(path.resolve("tests/fixtures/astra-source.mp4")));
  const stts = bytes.indexOf("stts", 0, "latin1");
  expect(stts).toBeGreaterThan(0);
  // One entry: 36 samples of 1 tick at 24 ticks a second. 300 ticks each is 450 s.
  expect([bytes.readUInt32BE(stts + 8), bytes.readUInt32BE(stts + 12), bytes.readUInt32BE(stts + 16)]).toEqual([1, 36, 1]);
  bytes.writeUInt32BE(300, stts + 16);
  return bytes;
}

test("an .m4a (an iPhone voice memo) is identified as audio, never as a video", async () => {
  const { identifyImage } = await import("../../lib/imagemeta");
  const { identifyAudio } = await import("../../lib/audioMeta");
  for (const brand of ["M4A ", "M4B "]) {
    const head = ftyp(brand, [brand, "mp42", "isom"]);
    expect(identifyImage(head)).toBeNull();
    expect(identifyImage(head) ?? identifyAudio(head)).toEqual({ kind: "audio", mime: "audio/mp4", ext: "m4a" });
  }
  expect(identifyImage(ftyp("isom", ["isom", "mp42"]))).toMatchObject({ kind: "video", mime: "video/mp4" });
  expect(identifyImage(ftyp("qt  ", ["qt  "]))).toMatchObject({ kind: "video", mime: "video/quicktime" });
  // A protected iTunes track is sound too, never a video.
  expect(identifyImage(ftyp("M4P ", ["M4P "])) ?? identifyAudio(ftyp("M4P ", ["M4P "]))).toMatchObject({ kind: "audio" });
});

/** An ISO BMFF box. */
const box = (type: string, ...children: Buffer[]) => {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
/** A track whose media handler is `handler` ('soun', 'vide' …). */
const trak = (handler: string) => {
  const hdlr = Buffer.alloc(24);
  hdlr.write(handler, 8, "latin1");
  return box("trak", box("tkhd", Buffer.alloc(84)), box("mdia", box("mdhd", Buffer.alloc(24)), box("hdlr", hdlr)));
};
const moov = (...tracks: Buffer[]) => box("moov", box("mvhd", Buffer.alloc(100)), ...tracks);
const brands = (major: string) => box("ftyp", Buffer.from(`${major}\0\0\0\0isommp42`, "latin1"));

test("an Android recording under a generic brand is sound when its tracks are all sound", async () => {
  const { identifyImage } = await import("../../lib/imagemeta");
  const { identifyAudio } = await import("../../lib/audioMeta");
  const sniff = (head: Buffer) => identifyImage(head) ?? identifyAudio(head);
  for (const major of ["isom", "mp42"]) {
    expect(sniff(Buffer.concat([brands(major), moov(trak("soun")), box("mdat", Buffer.alloc(32))]))).toEqual({ kind: "audio", mime: "audio/mp4", ext: "m4a" });
    expect(sniff(Buffer.concat([brands(major), moov(trak("vide"), trak("soun"))]))).toMatchObject({ kind: "video" });
    expect(sniff(Buffer.concat([brands(major), moov(trak("vide"))]))).toMatchObject({ kind: "video" });
  }
  // The movie header after the media, out of reach of the head: still read as video.
  const mdat = box("mdat", Buffer.alloc(4096));
  expect(sniff(Buffer.concat([brands("isom"), mdat.subarray(0, 64)]))).toMatchObject({ kind: "video" });
  // A truncated movie header is not guessed at either.
  expect(sniff(Buffer.concat([brands("isom"), moov(trak("soun")).subarray(0, 60)]))).toMatchObject({ kind: "video" });
  // The checked-in clip has a picture.
  expect(sniff(readFileSync(path.resolve("tests/fixtures/astra-source.mp4")))).toMatchObject({ kind: "video" });
});

test("audio dropped where a reference is wanted is told so, not called unrecognised", async () => {
  const { storeReferenceUpload } = await import("../../lib/uploadIntake");
  const memo = ftyp("M4A ", ["M4A ", "mp42", "isom"]);
  const claim = { bytes: memo.length } as Parameters<typeof storeReferenceUpload>[0];
  await expect(storeReferenceUpload(claim, memo, "memo.m4a")).rejects.toThrow(/^Audio can't be a reference\. Images: /);
  const junk = Buffer.alloc(64, 7);
  await expect(storeReferenceUpload({ ...claim, bytes: junk.length }, junk, "junk.bin")).rejects.toThrow(/^Unrecognised file\./);
});

test("sound tools read a misfiled .m4a as audio, and measure a video longer than five minutes", async () => {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { findStoredSource, resolveStoredDuration } = await import("../../lib/mediaSource.server");
  const { inspectOriginalVideo } = await import("../../lib/videoMetadata.server");
  await platformReady();
  const id = "sound-sources";
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await runInTenant(ws, async () => {
    await ready();
    const insert = (uploadId: string, ext: string, kind: string, mime: string, bytes: number) => db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,'x',NULL,NULL,?,?,NULL,?)",
      args: [uploadId, `${uploadId}.${ext}`, mime, ext, bytes, `/api/uploads/${uploadId}`, kind, Date.now()],
    });

    // A voice memo stored before the fix: kind 'video', mime 'video/mp4'.
    await insert(`${stamp}-memo`, "m4a", "video", "video/mp4", 100);
    expect(await findStoredSource({ uploadId: `${stamp}-memo` })).toMatchObject({ mediaKind: "audio", mime: "audio/mp4", ext: "m4a" });
    // One dropped where a reference goes kept the sniffed 'mp4'; its name says what it is.
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,'x',NULL,NULL,?,?,NULL,?)",
      args: [`${stamp}-ref`, "Voice Memo.M4A", "video/mp4", "mp4", 100, `/api/uploads/${stamp}-ref`, "video", Date.now()],
    });
    expect(await findStoredSource({ uploadId: `${stamp}-ref` })).toMatchObject({ mediaKind: "audio", mime: "audio/mp4", ext: "mp4" });

    // A 7.5 minute interview: priced per minute by the sound tools, still refused by Astra.
    const clip = longClip(), clipId = `${stamp}-interview`;
    mkdirSync(UPLOADS, { recursive: true });
    const file = path.join(UPLOADS, `${clipId}.mp4`);
    writeFileSync(file, clip);
    written.push(file);
    await insert(clipId, "mp4", "video", "video/mp4", clip.length);
    const source = (await findStoredSource({ uploadId: clipId }))!;
    expect(source.mediaKind).toBe("video");
    const measured = await resolveStoredDuration(source);
    expect(measured.reason).toBeUndefined();
    expect(measured.seconds).toBeCloseTo(450, 3);
    expect(Number((await db().execute({ sql: "SELECT duration_s FROM uploads WHERE id=?", args: [clipId] })).rows[0].duration_s)).toBeCloseTo(450, 3);

    const ref = { id: clipId, mime: "video/mp4", ext: "mp4", storedUrl: `/api/uploads/${clipId}`, role: "reference_video" as const, kind: "video" as const, fromGeneration: false };
    await expect(inspectOriginalVideo(ref, clip.length)).rejects.toThrow(/Astra accepts video clips up to five minutes/);
    await expect(inspectOriginalVideo(ref, clip.length, false, { maxSeconds: 60 })).rejects.toThrow("Use a video up to 1 minute long with valid picture dimensions.");
  });
});
