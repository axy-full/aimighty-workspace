import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import v8 from "node:v8";
import vm from "node:vm";
import { loadIsolated } from "./storageSeam";
import { generatedSha256, startFakeProvider, type FakeProvider } from "../helpers/fake-provider-server";

/* How much memory one provider → R2 save holds. A 500 MB render is served
 * from a generator (never allocated here) and saved through storeVideo onto a
 * fake R2 in a separate process (tests/helpers/fake-s3-server.mjs), so this
 * process's growth is the save's own. The STREAM_MEMORY line is printed (and
 * kept as an annotation) before the assertion, so a run against code that
 * buffers the whole file still reports its number. Run it by name only: it
 * moves 1 GB through local sockets and writes it to a temp dir. */

const MiB = 1024 * 1024;
const SIZE = 500 * MiB;
const BUCKET = "particl-memory-test";

let provider: FakeProvider, s3: ChildProcess | null = null, endpoint = "", dir = "";

test.describe.configure({ mode: "serial", timeout: 300_000 });

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "stream-memory-s3-"));
  s3 = spawn(process.execPath, [path.resolve("tests/helpers/fake-s3-server.mjs"), "--port", "0", "--dir", dir], { stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: s3!.stdout! });
    rl.once("line", resolve);
    s3!.once("exit", (code) => reject(new Error(`fake S3 exited (${code})`)));
  });
  endpoint = JSON.parse(line).endpoint;
  provider = await startFakeProvider();
});

test.afterAll(async () => {
  await provider?.close();
  if (s3 && s3.exitCode == null) { s3.kill("SIGTERM"); await new Promise((r) => s3!.once("exit", r)); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Storage = typeof import("../../lib/storage");
type Peak = { rss: number; arrayBuffers: number; bytes: number; seconds: number; failure: unknown };

/* A full collection before each sample, so the peak is what the save holds
   (live buffers), not garbage V8 has yet to collect: undici alone leaves
   ~64-100 MB of already-dead socket chunks between collections, whatever the
   save does, and that is per process rather than per transfer. The run
   without collections is reported too (STREAM_MEMORY_NOGC), never asserted. */
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

async function measure(storage: Storage, genId: string, collect: boolean): Promise<Peak> {
  gc();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const base = process.memoryUsage();
  let rss = 0, arrayBuffers = 0;
  const sample = () => {
    if (collect) gc();
    const now = process.memoryUsage();
    rss = Math.max(rss, now.rss - base.rss);
    arrayBuffers = Math.max(arrayBuffers, now.arrayBuffers - base.arrayBuffers);
  };
  const timer = setInterval(sample, 50);
  const started = Date.now();
  let bytes = 0, failure: unknown = null;
  try { bytes = (await storage.storeVideo(genId, provider.url(SIZE))).bytes; }
  catch (error) { failure = error; }
  finally { clearInterval(timer); sample(); }
  return { rss, arrayBuffers, bytes, seconds: (Date.now() - started) / 1000, failure };
}

const line = (tag: string, p: Peak) =>
  `${tag} peakRssDeltaMiB=${(p.rss / MiB).toFixed(1)} peakArrayBuffersDeltaMiB=${(p.arrayBuffers / MiB).toFixed(1)} bytes=${p.bytes} seconds=${p.seconds.toFixed(1)}`;

test("storeVideo of a 500 MB render holds far less than the file", async ({}, testInfo) => {
  const storage = loadIsolated<Storage>("lib/storage.ts", {}, {
    process: Object.create(process, { env: { value: {
      PATH: process.env.PATH ?? "", NODE_ENV: "test",
      STORAGE_BACKEND: "r2", R2_ACCOUNT_ID: "0123456789abcdef", R2_ACCESS_KEY_ID: "AKIAFAKEMEMORYTEST",
      R2_SECRET_ACCESS_KEY: "fake-secret-never-real", R2_BUCKET: BUCKET, R2_ENDPOINT: endpoint,
    } } }),
  });
  // Warm up: load the S3 SDK and open sockets before any baseline.
  await storage.storeVideo("memory-warmup", provider.url(MiB));

  const held = await measure(storage, "memory-500mb", true);
  const heldLine = line("STREAM_MEMORY", held);
  console.log(heldLine);
  testInfo.annotations.push({ type: "STREAM_MEMORY", description: heldLine });
  const raw = await measure(storage, "memory-500mb-nogc", false);
  const rawLine = line("STREAM_MEMORY_NOGC", raw);
  console.log(rawLine);
  testInfo.annotations.push({ type: "STREAM_MEMORY_NOGC", description: rawLine });

  if (held.failure) throw held.failure;
  if (raw.failure) throw raw.failure;
  expect(held.bytes).toBe(SIZE);
  const state = await (await fetch(`${endpoint}/__fake__/state`)).json() as { objects: { key: string; size: number; sha256: string }[] };
  const object = state.objects.find((o) => o.key === "generations/memory-500mb.mp4");
  expect(object?.size).toBe(SIZE);
  expect(object?.sha256).toBe(generatedSha256(SIZE));
  expect(held.arrayBuffers).toBeLessThan(64 * MiB);
});
