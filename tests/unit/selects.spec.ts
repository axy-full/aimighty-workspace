import { test, expect } from "@playwright/test";
import { selectsCsv, edl, tc, type Select } from "../../lib/selects";
import { crc32, zipName, uniqueNames, zipStream } from "../../lib/zip";

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

/** An edit list an editor can conform against (brief 2.6). */
test("the edit list lays the takes end to end, each naming its own master", () => {
  const out = edl(rows, { title: "Layer cap test" });
  const lines = out.trim().split("\r\n");
  expect(lines[0]).toBe("TITLE: Layer cap test");
  expect(lines[1]).toBe("FCM: NON-DROP FRAME");
  expect(lines[2]).toContain("001  SH010");
  expect(lines[2]).toContain("00:00:00:00 00:00:05:00 00:00:00:00 00:00:05:00");
  expect(lines[3]).toBe("* FROM CLIP NAME: prod_1_SH010_SD25_v2_ana.mp4");
  expect(lines[4]).toBe("* COMMENT: The jetty");
  // the second take starts where the first ended
  expect(lines[5]).toContain("00:00:05:00 00:00:09:00");
  expect(tc(90_000, 25)).toBe("01:00:00:00");
  expect(tc(0)).toBe("00:00:00:00");
});

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
