import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ByteRange } from "../../lib/mediaRange";
import { currentTenant } from "../../lib/tenant";
import { loadIsolated } from "./storageSeam";

/**
 * A viewer who leaves while a local upload or original is streaming must not
 * crash the server.
 *
 * The routes hand `req.signal` to the local readers. Aborted mid-read, the
 * fs read is destroyed with an AbortError that toWeb passes to the reader.
 * Aborted while the route was still looking the file up, createReadStream
 * destroyed the read before toWeb could listen to it, and the AbortError
 * surfaced as `⨯ uncaughtException: Error [AbortError] ... at
 * openUploadStream` — several per navigation, with unrelated requests on the
 * same dev server reset in the same window.
 *
 * Both windows are asserted for every local reader: the reader sees the
 * abort, the process sees nothing. Ranges, sizes and the length check are
 * asserted unchanged alongside.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-local-stream-abort-"));
const SIZE = 4 * 1024 * 1024;
const bytes = randomBytes(SIZE);
for (const [folder, file] of [["uploads", "clip.mp4"], ["generations", "gen.mp4"]]) {
  mkdirSync(path.join(directory, ".data", folder), { recursive: true });
  writeFileSync(path.join(directory, ".data", folder, file), bytes);
}

const storage = loadIsolated<typeof import("../../lib/storage")>(
  "lib/storage.ts",
  { "./tenant": { currentTenant } },
  {
    process: {
      ...process,
      cwd: () => directory,
      env: { ...process.env, STORAGE_BACKEND: "local", BLOB_READ_WRITE_TOKEN: "" },
    },
  },
);

type Open = (range: ByteRange, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
const readers: Record<string, Open> = {
  openUploadStream: async (range, signal) =>
    (await storage.openUploadStream("clip", "mp4", range, undefined, signal)).stream as ReadableStream<Uint8Array>,
  openVideoStream: (range, signal) => storage.openVideoStream("gen", range, signal),
  openOriginalStream: async (range, signal) => (await storage.openOriginalStream("video", "gen", range, signal)).stream,
};
const whole: ByteRange = { start: 0, end: SIZE - 1, total: SIZE };

/** How a read ends: "ended" when it reached its end, otherwise the error it failed with. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  try {
    while (!(await reader.read()).done);
    return "ended";
  } catch (error) {
    return error;
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** Every uncaughtException and unhandledRejection raised while `run` and the reads it started settle. */
async function escaped(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const record = (error: unknown) => { seen.push(error); };
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  try {
    await run();
    // A read destroyed before it opened emits its error only once the file it opened is closed again.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
  }
  return seen;
}

test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const [name, open] of Object.entries(readers)) {
  test(`${name}: aborted mid-read, the reader sees the abort and the process sees nothing`, async () => {
    const controller = new AbortController();
    let first: ReadableStreamReadResult<Uint8Array> | undefined, ending: unknown;
    const errors = await escaped(async () => {
      const reader = (await open(whole, controller.signal)).getReader();
      first = await reader.read();
      controller.abort();
      ending = await drain(reader);
    });
    expect(errors).toEqual([]);
    expect(first?.done).toBe(false);
    expect(ending).toMatchObject({ name: "AbortError" });
  });

  test(`${name}: aborted while the file is looked up, the reader sees the abort and the process sees nothing`, async () => {
    const controller = new AbortController();
    let ending: unknown;
    const errors = await escaped(async () => {
      const opening = open(whole, controller.signal);
      // Lands during the stat, before the file is opened: the route's window.
      controller.abort();
      ending = await drain((await opening).getReader());
    });
    expect(errors).toEqual([]);
    // Not an empty body that looks complete.
    expect(ending).toMatchObject({ name: "AbortError" });
  });
}

test("an unaborted local read still returns exactly the requested bytes, sizes and length check", async () => {
  const range: ByteRange = { start: 1_000, end: 70_000, total: SIZE };
  const signal = new AbortController().signal;
  const slice = bytes.subarray(1_000, 70_001);

  const ranged = await storage.openUploadStream("clip", "mp4", range, undefined, signal);
  expect(ranged.size).toBe(69_001);
  expect(await collect(ranged.stream as ReadableStream<Uint8Array>)).toEqual(slice);
  const full = await storage.openUploadStream("clip", "mp4", null);
  expect(full.size).toBe(SIZE);
  expect(await collect(full.stream as ReadableStream<Uint8Array>)).toEqual(bytes);

  expect(await collect(await storage.openVideoStream("gen", range, signal))).toEqual(slice);
  const original = await storage.openOriginalStream("video", "gen", range, signal);
  expect(original.size).toBe(69_001);
  expect(await collect(original.stream)).toEqual(slice);
  expect((await storage.openOriginalStream("video", "gen", null)).size).toBe(SIZE);

  const stale: ByteRange = { start: 0, end: 15, total: SIZE + 1 };
  await expect(storage.openUploadStream("clip", "mp4", stale)).rejects.toThrow(/Upload length changed/);
  await expect(storage.openVideoStream("gen", stale)).rejects.toThrow(/Original video length changed/);
  await expect(storage.openOriginalStream("video", "gen", stale)).rejects.toThrow(/Original length changed/);
});
