import { test, expect } from "@playwright/test";
import { selectsCsv, type Select } from "../../lib/selects";
import { crc32, zipName, uniqueNames, zipStream } from "../../lib/zip";
import { originalKindOf } from "../../lib/originalMedia";
import { currentTenant, runInTenant, type TenantWorkspace } from "../../lib/tenant";
import { loadIsolated } from "./storageSeam";

const rows: Select[] = [
  { id: "gen_a", shot: "SH010", shotTitle: "The jetty", version: 2, kind: "video", engine: "SD25", credits: 40, usd: 2.86, seconds: 5, prompt: "a boat at dawn", filename: "prod_1_SH010_SD25_v2_ana.mp4" },
  { id: "gen_b", shot: "SH020", shotTitle: "", version: 1, kind: "video", engine: "KL3", credits: 6, usd: 0.42, seconds: 4, prompt: 'the "hand-off", wide', filename: "prod_1_SH020_KL3_v1_ana.mp4" },
];

/** The shot list a producer bills from (brief 2.6). */
test("the shot list carries what a client is billed for, quoting what needs quoting", () => {
  const csv = selectsCsv(rows, "cr");
  const [head, first, second] = csv.trim().split("\r\n");
  expect(head).toBe("shot,shot_title,take,version,engine,credits,seconds,prompt,file");
  expect(first).toBe("SH010,The jetty,gen_a,2,SD25,40,5,a boat at dawn,prod_1_SH010_SD25_v2_ana.mp4");
  expect(second).toContain('"the ""hand-off"", wide"');
  expect(selectsCsv(rows, "$").split("\r\n")[1]).toContain("2.86");
});

/* The CMX 3600 edit list that used to be tested here is gone, and so is the
   timecode helper it carried. An EDL is a conform artefact for a cutting room
   this product does not sit in; the masters and the shot list are what the
   handover actually needs, and the zip still carries both. */

/** The zip itself (brief 2.6): stored entries, real checksums, names that survive any machine. */
test("a zip is written whole, with a checksum per entry and no name repeated", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  expect(zipName("a/b:c*.mp4", "x.mp4")).toBe("a-b-c-.mp4");
  expect(zipName("", "x.mp4")).toBe("x.mp4");
  expect(uniqueNames(["SH010.mp4", "SH010.mp4", "sh010.mp4", "other.mp4"])).toEqual(["SH010.mp4", "SH010 (2).mp4", "sh010 (3).mp4", "other.mp4"]);
});

test("the archive's own structure: a local header per file, a directory, and an end record", async () => {
  const enc = new TextEncoder();
  const stream = zipStream([
    { name: "one.txt", body: async () => enc.encode("hello") },
    { name: "two.txt", body: async () => enc.encode("world!") },
  ], new Date(Date.UTC(2026, 8, 7, 12, 0, 0)));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) parts.push(value); }
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
  const sig = (o: number) => all[o] | (all[o + 1] << 8) | (all[o + 2] << 16) | (all[o + 3] << 24);
  expect(sig(0) >>> 0).toBe(0x04034b50);                                   // the first file
  expect(sig(all.length - 22) >>> 0).toBe(0x06054b50);                     // the end record
  expect(all[all.length - 22 + 8] | (all[all.length - 22 + 9] << 8)).toBe(2); // two entries in the directory
  const text = new TextDecoder().decode(all);
  expect(text).toContain("one.txt");
  expect(text).toContain("hello");
  expect(text).toContain("world!");
});

/* A package of approved masters must not outrun the producer's connection:
   storage is read one chunk per pull, never all at once into memory. */
test("the zip reads storage only as fast as the download drains, and a cancelled download stops the read", async () => {
  let pulled = 0, cancelled = false;
  const master = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64 * 1024));
      if (pulled >= 2000) c.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const reader = zipStream([{ name: "SH010_v2.mp4", body: async () => master }]).getReader();
  for (let i = 0; i < 4; i++) expect((await reader.read()).done).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(pulled).toBeLessThan(8);
  await reader.cancel();
  expect(cancelled).toBe(true);
});

/* The zip is drained by the response after the route handler (and the
   workspace scope it ran in) has returned. Every entry must still read the
   workspace's own keys on cloud storage, never the bare legacy ones. */
test("a package built for a workspace reads that workspace's keys even after the handler has returned", async () => {
  const gets: string[] = [];
  const blob = {
    async get(name: string) {
      gets.push(name);
      if (!name.startsWith("ws/studio-a/")) return null;
      return { stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(name)); c.close(); } }), headers: new Headers(), statusCode: 200 };
    },
  };
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "local-sdk-fixture-no-network";
  try {
    const storage = loadIsolated<typeof import("../../lib/storage")>("lib/storage.ts", {
      "@vercel/blob": blob,
      "./tenant": { currentTenant },
    });
    const takes = [{ id: "gen_v", kind: "video" }, { id: "gen_i", kind: "image" }, { id: "gen_m", kind: "model" }];
    const stream = await runInTenant({ id: "studio-a", legacy: false } as TenantWorkspace, async () => zipStream(
      takes.map((t) => ({ name: `${t.id}.bin`, body: async () => storage.openMediaStream(t.id, originalKindOf(t.kind)) })),
    ));
    expect(currentTenant()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) parts.push(value); }
    expect(gets).toEqual([
      "ws/studio-a/generations/gen_v.mp4",
      "ws/studio-a/generations/gen_i.png",
      "ws/studio-a/generations/gen_m.glb",
    ]);
    const text = new TextDecoder().decode(Buffer.concat(parts));
    expect(text).toContain("ws/studio-a/generations/gen_m.glb");
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});
