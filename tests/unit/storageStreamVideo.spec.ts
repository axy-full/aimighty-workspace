import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadIsolated } from "./storageSeam";
import { generatedSha256, startFakeProvider, type FakeProvider } from "../helpers/fake-provider-server";
import { start as startFakeS3 } from "../helpers/fake-s3-server.mjs";
import { createTransferLimiter, TransferQueueTimeoutError, transferConcurrency } from "../../lib/storage/transfers";
import { readBodyCapped, BodyTooLargeError } from "../../lib/boundedBody";

/* storeVideo streams a provider's file into storage: through a real fake S3
 * (tests/helpers/fake-s3-server.mjs, the same SigV4 multipart path the R2
 * backend uses in production) or onto local disk, never holding it whole. */

type Storage = typeof import("../../lib/storage");
type FakeS3 = Awaited<ReturnType<typeof startFakeS3>>;

const MiB = 1024 * 1024;
let s3: FakeS3, provider: FakeProvider, s3Dir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  s3Dir = mkdtempSync(path.join(tmpdir(), "stream-s3-"));
  s3 = await startFakeS3({ dir: s3Dir, port: 0 });
  provider = await startFakeProvider();
});
test.afterAll(async () => {
  await provider?.close();
  await s3?.close();
  rmSync(s3Dir, { recursive: true, force: true });
});

function isolatedProcess(env: Record<string, string>, cwd = process.cwd()): NodeJS.Process {
  return Object.create(process, { env: { value: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env } }, cwd: { value: () => cwd } });
}

/** A fresh lib/storage.ts (and so a fresh transfer limiter) on the fake R2. */
function r2Storage(extra: Record<string, string> = {}): Storage {
  return loadIsolated<Storage>("lib/storage.ts", {}, {
    process: isolatedProcess({
      STORAGE_BACKEND: "r2",
      R2_ACCOUNT_ID: "0123456789abcdef",
      R2_ACCESS_KEY_ID: "AKIAFAKESTREAMTEST",
      R2_SECRET_ACCESS_KEY: "fake-secret-never-real",
      R2_BUCKET: "particl-stream-test",
      R2_ENDPOINT: s3.endpoint,
      ...extra,
    }),
  });
}

const stored = (genId: string) => s3.object(`generations/${genId}.mp4`, "particl-stream-test");
const openUploads = () => s3.state().uploads.filter((u: { key: string }) => u.key.startsWith("generations/"));

test("streams a multi-part render into R2 with the exact bytes", async () => {
  const storage = r2Storage();
  const size = 20 * MiB + 12_345; // three parts: 8 + 8 + the rest
  const out = await storage.storeVideo("stream-ok", provider.url(size));
  expect(out).toEqual({ url: "generations/stream-ok.mp4", bytes: size });
  const object = stored("stream-ok");
  expect(object?.size).toBe(size);
  expect(object?.sha256).toBe(generatedSha256(size));
  expect(object?.contentType).toBe("video/mp4");
  expect(object?.etag).toMatch(/-3"$/);
  expect(openUploads()).toEqual([]);
});

test("a body with no declared length is counted as it flows", async () => {
  const storage = r2Storage();
  const size = 9 * MiB + 7;
  const out = await storage.storeVideo("stream-chunked", provider.url(size, { declare: false }));
  expect(out.bytes).toBe(size);
  expect(stored("stream-chunked")?.sha256).toBe(generatedSha256(size));
});

test("a file past the cap aborts the multipart upload and leaves no object", async () => {
  const storage = r2Storage({ MAX_PROVIDER_VIDEO_BYTES: String(10 * MiB) });
  const abortedBefore = s3.state().aborted;
  // Undeclared length: the cap is found mid-stream, after a part has gone up.
  await expect(storage.storeVideo("stream-cap", provider.url(20 * MiB, { declare: false }))).rejects.toThrow(/larger than the 10 MB storage limit/);
  expect(stored("stream-cap")).toBeNull();
  expect(openUploads()).toEqual([]);
  expect(s3.state().aborted).toBe(abortedBefore + 1);
  // Declared length over the cap: refused before any upload starts.
  const requestsBefore = s3.state().requests;
  await expect(storage.storeVideo("stream-cap-declared", provider.url(20 * MiB))).rejects.toThrow(/larger than the 10 MB storage limit/);
  expect(s3.state().requests).toBe(requestsBefore);
  expect(stored("stream-cap-declared")).toBeNull();
});

test("a stalled provider times out, aborts the upload and leaves no object", async () => {
  const storage = r2Storage();
  const abortedBefore = s3.state().aborted;
  const started = Date.now();
  await expect(storage.storeVideo("stream-stall", provider.url(30 * MiB, { stallAfter: 9 * MiB }), { timeoutMs: 1500 }))
    .rejects.toThrow("The render's file did not finish downloading in 2s.");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(stored("stream-stall")).toBeNull();
  expect(openUploads()).toEqual([]);
  expect(s3.state().aborted).toBe(abortedBefore + 1);
});

test("a file that ends before its declared length is not completed", async () => {
  const storage = r2Storage();
  await expect(storage.storeVideo("stream-short", provider.url(20 * MiB, { truncateAt: 17 * MiB }))).rejects.toThrow();
  expect(stored("stream-short")).toBeNull();
  expect(openUploads()).toEqual([]);
});

test("a provider error is reported and nothing is stored", async () => {
  const storage = r2Storage();
  await expect(storage.storeVideo("stream-404", provider.url(10, { status: 404 }))).rejects.toThrow("Could not download render (404)");
  expect(stored("stream-404")).toBeNull();
});

test("a retry overwrites, including after a failed first attempt", async () => {
  const storage = r2Storage({ MAX_PROVIDER_VIDEO_BYTES: String(12 * MiB) });
  await expect(storage.storeVideo("stream-retry", provider.url(13 * MiB, { declare: false }))).rejects.toThrow(/storage limit/);
  expect(stored("stream-retry")).toBeNull();
  await storage.storeVideo("stream-retry", provider.url(3 * MiB));
  expect(stored("stream-retry")?.sha256).toBe(generatedSha256(3 * MiB));
  // A second save of the same take replaces the object (overwrite: true).
  const again = await storage.storeVideo("stream-retry", provider.url(11 * MiB + 1));
  expect(again.bytes).toBe(11 * MiB + 1);
  expect(stored("stream-retry")?.sha256).toBe(generatedSha256(11 * MiB + 1));
  expect(openUploads()).toEqual([]);
});

test("the fifth concurrent transfer waits for a slot, then completes", async () => {
  const storage = r2Storage();
  const before = provider.requests;
  const saves = Array.from({ length: 5 }, (_, i) => storage.storeVideo(`stream-queue-${i}`, provider.url(MiB + i, { hold: true })));
  await expect.poll(() => provider.requests - before, { timeout: 5000 }).toBe(4);
  // Give a fifth request every chance to slip through if the limit were missing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(provider.requests - before).toBe(4);
  provider.release();
  const results = await Promise.all(saves);
  expect(results.map((r) => r.bytes)).toEqual([0, 1, 2, 3, 4].map((i) => MiB + i));
  expect(provider.requests - before).toBe(5);
  for (let i = 0; i < 5; i++) expect(stored(`stream-queue-${i}`)?.sha256).toBe(generatedSha256(MiB + i));
});

test("a queued transfer gives up at its wait bound, deadline or signal without starting", async () => {
  const storage = r2Storage({ STORAGE_TRANSFER_CONCURRENCY: "1" });
  const held = provider.url(MiB, { hold: true });
  const before = provider.requests;
  // Re-arm the hold for this test's first transfer.
  const fresh = await startFakeProvider();
  try {
    const first = storage.storeVideo("stream-slot-0", fresh.url(MiB, { hold: true }));
    await expect.poll(() => fresh.requests).toBe(1);
    await expect(storage.storeVideo("stream-slot-1", held, { maxQueueMs: 100 })).rejects.toThrow(/Storage is busy/);
    await expect(storage.storeVideo("stream-slot-2", held, { deadlineAt: Date.now() + 100 })).rejects.toThrow(/Storage is busy/);
    const controller = new AbortController();
    const cancelled = storage.storeVideo("stream-slot-3", held, { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(cancelled).rejects.toThrow("caller gave up");
    expect(provider.requests).toBe(before);
    fresh.release();
    await first;
    expect(stored("stream-slot-0")?.size).toBe(MiB);
    for (const id of ["stream-slot-1", "stream-slot-2", "stream-slot-3"]) expect(stored(id)).toBeNull();
  } finally { await fresh.close(); }
});

test("local disk streams through a temporary file and keeps nothing partial", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "stream-local-"));
  try {
    const storage = loadIsolated<Storage>("lib/storage.ts", {}, { process: isolatedProcess({ STORAGE_BACKEND: "local", MAX_PROVIDER_VIDEO_BYTES: String(8 * MiB) }, cwd) });
    const dir = path.join(cwd, ".data", "generations");
    const out = await storage.storeVideo("local-ok", provider.url(5 * MiB + 3));
    expect(out).toEqual({ url: "generations/local-ok.mp4", bytes: 5 * MiB + 3 });
    expect(createHash("sha256").update(readFileSync(path.join(dir, "local-ok.mp4"))).digest("hex")).toBe(generatedSha256(5 * MiB + 3));
    await expect(storage.storeVideo("local-cap", provider.url(9 * MiB, { declare: false }))).rejects.toThrow(/8 MB storage limit/);
    await expect(storage.storeVideo("local-stall", provider.url(7 * MiB, { stallAfter: MiB }), { timeoutMs: 800 })).rejects.toThrow(/did not finish downloading/);
    expect(existsSync(path.join(dir, "local-cap.mp4"))).toBe(false);
    expect(existsSync(path.join(dir, "local-stall.mp4"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["local-ok.mp4"]);
    // A fixture still goes through the fixture reader on local disk.
    const fixture = await storage.storeVideo("local-fixture", "fixture:clip.mp4");
    expect(fixture.bytes).toBe(readFileSync(path.join(process.cwd(), "public", "fixtures", "clip.mp4")).length);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("transfer limiter: FIFO slots, bounded waits, configured size", async () => {
  expect(transferConcurrency({})).toBe(4);
  expect(transferConcurrency({ STORAGE_TRANSFER_CONCURRENCY: "2" })).toBe(2);
  expect(transferConcurrency({ STORAGE_TRANSFER_CONCURRENCY: "0" })).toBe(4);
  expect(transferConcurrency({ STORAGE_TRANSFER_CONCURRENCY: "nope" })).toBe(4);
  const limiter = createTransferLimiter(2);
  const a = await limiter.acquire(), b = await limiter.acquire();
  const order: string[] = [];
  const c = limiter.acquire().then((r) => { order.push("c"); return r; });
  const d = limiter.acquire().then((r) => { order.push("d"); return r; });
  expect(limiter.waiting).toBe(2);
  await expect(limiter.acquire({ maxWaitMs: 20 })).rejects.toBeInstanceOf(TransferQueueTimeoutError);
  await expect(limiter.acquire({ deadlineAt: Date.now() - 1 })).rejects.toBeInstanceOf(TransferQueueTimeoutError);
  expect(limiter.waiting).toBe(2);
  a(); a(); // a second release of the same slot is ignored
  const releaseC = await c;
  expect(limiter.active).toBe(2);
  b();
  const releaseD = await d;
  expect(order).toEqual(["c", "d"]);
  releaseC(); releaseD();
  expect(limiter.active).toBe(0);
  expect(limiter.waiting).toBe(0);
});

test("small provider files are read whole only up to their cap", async () => {
  const ok = await readBodyCapped(new Response(Buffer.alloc(10, 1)), 10);
  expect(ok.length).toBe(10);
  const declared = new Response(Buffer.alloc(11), { headers: { "content-length": "11" } });
  await expect(readBodyCapped(declared, 10, "too big")).rejects.toThrow("too big");
  const undeclared = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close(); } }));
  await expect(readBodyCapped(undeclared, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  const { fetchBytes, FETCH_BYTES_DEFAULT_MAX } = await import("../../lib/mockFs");
  expect(FETCH_BYTES_DEFAULT_MAX).toBe(100 * MiB);
  await expect(fetchBytes(provider.url(2 * MiB, { declare: false }), 10_000, MiB)).rejects.toThrow("The provider file exceeds the download limit.");
  await expect(fetchBytes(provider.url(2 * MiB), 10_000, MiB)).rejects.toThrow("The provider file exceeds the download limit.");
  expect((await fetchBytes(provider.url(MiB), 10_000, MiB)).length).toBe(MiB);
});

test("the fake S3 answers the R2 backend's conditional writes, ranges, listing and deletes", async () => {
  const { createR2Backend } = await import("../../lib/storage/r2");
  const r2 = createR2Backend({ accountId: "x", accessKeyId: "AKIAFAKE", secretAccessKey: "fake", bucket: "fake-s3-check", endpoint: s3.endpoint });
  const body = Buffer.from("conditional body");
  await r2.put("check/one.bin", body, { contentType: "application/octet-stream", overwrite: false });
  await expect(r2.put("check/one.bin", body, { contentType: "application/octet-stream", overwrite: false })).rejects.toThrow(/^Object already exists/);
  const big = async function* () { for (let i = 0; i < 3; i++) yield Buffer.alloc(4 * MiB, i + 1); };
  await r2.put("check/multi.bin", big(), { contentType: "video/mp4", overwrite: false, multipart: true });
  const abortedBefore = s3.state().aborted;
  await expect(r2.put("check/multi.bin", big(), { contentType: "video/mp4", overwrite: false, multipart: true })).rejects.toThrow(/^Object already exists/);
  expect(s3.state().aborted).toBe(abortedBefore + 1); // Complete refused with 412, upload aborted
  expect(await r2.head("check/multi.bin")).toEqual({ size: 12 * MiB });
  const ranged = await r2.get("check/multi.bin", { range: { start: 4 * MiB - 2, end: 4 * MiB + 1, total: 12 * MiB } });
  expect(ranged?.statusCode).toBe(206);
  expect(ranged?.headers.get("content-range")).toBe(`bytes ${4 * MiB - 2}-${4 * MiB + 1}/${12 * MiB}`);
  expect([...Buffer.from(await new Response(ranged!.stream).arrayBuffer())]).toEqual([1, 1, 2, 2]);
  const listed = await r2.list({ prefix: "check/", limit: 1 });
  expect(listed.items.map((i) => i.key)).toEqual(["check/multi.bin"]);
  expect(listed.hasMore).toBe(true);
  expect((await r2.list({ prefix: "check/", cursor: listed.cursor })).items.map((i) => i.key)).toEqual(["check/one.bin"]);
  await r2.del(["check/one.bin", "check/multi.bin"]);
  expect(await r2.head("check/one.bin")).toBeNull();
  expect(await r2.get("check/multi.bin")).toBeNull();
});
