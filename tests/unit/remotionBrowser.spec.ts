import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRealRenderer } from "../../remotion/node/renderer";
import { createFfprobe, FFPROBE_FORMATS } from "../../remotion/node/probe";

/* Opus review of #699: the worker never downloads a browser, and ffprobe reads only the media formats an export may name. */

test("the browser is the exact file named, checked before any render; a missing or non-executable file is an error that says the worker never downloads one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remotion-browser-"));
  const missing = path.join(dir, "chrome-headless-shell");
  await expect(createRealRenderer({ browserExecutable: missing }).prepare()).rejects.toThrow(`The browser is missing at ${missing}. This worker never downloads one.`);
  writeFileSync(missing, "#!/bin/sh\n");
  chmodSync(missing, 0o644);
  await expect(createRealRenderer({ browserExecutable: missing }).prepare()).rejects.toThrow("never downloads one");
  chmodSync(missing, 0o755);
  /* With a real executable present prepare() returns without loading @remotion/renderer (which would look for, and fetch, a browser). */
  await expect(createRealRenderer({ browserExecutable: missing }).prepare()).resolves.toBeUndefined();
});

test("ffprobe is told to read only the export media formats and only local files, and to print nothing else", async () => {
  const seen: string[][] = [];
  const run = ((_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    seen.push(args);
    done(null, JSON.stringify({ format: { duration: "2.0" }, streams: [{ codec_type: "video", width: 320, height: 180 }] }));
  }) as never;
  const facts = await createFfprobe("/bin/ffprobe", 1000, run).probe("/tmp/x/clip.mp4");
  expect(facts).toMatchObject({ width: 320, height: 180, hasVideo: true, durationSeconds: 2 });
  const args = seen[0];
  expect(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
  expect(args.slice(args.indexOf("-format_whitelist"), args.indexOf("-format_whitelist") + 2)).toEqual(["-format_whitelist", FFPROBE_FORMATS]);
  expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("-i"));
  expect(FFPROBE_FORMATS.split(",")).toEqual(expect.arrayContaining(["mov", "mp4", "matroska", "webm", "mp3", "wav", "ogg", "aac"]));
  expect(FFPROBE_FORMATS).not.toMatch(/hls|concat|image2|lavfi|rtsp|sdp|data/);
  expect(args.at(-1)).toBe("/tmp/x/clip.mp4");
});
