import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSpec, runExport, type CompositionInfo, type Renderer } from "../../remotion/node/export";
import { createFfmpegSilenceDetector, type SilenceDetector } from "../../remotion/node/silence";
import type { Prober } from "../../remotion/node/probe";
import { MAX_KEEP_RANGES, SPEECH_PAD_SECONDS, mergeKeep, parseSilence, speechRanges, validateProps, type Range } from "../../remotion/src/lib";

/* Silence-aware cutdowns: the quiet stretches of the source are found, the spoken ones become the cut's marked moments. */

const r = (startSeconds: number, endSeconds: number): Range => ({ startSeconds, endSeconds });

const LOG = `
[silencedetect @ 0x5b1] silence_start: 2.0035
[silencedetect @ 0x5b1] silence_end: 5.0013 | silence_duration: 2.9978
[silencedetect @ 0x5b1] silence_start: 7.5
size=N/A time=00:00:10.00 bitrate=N/A speed= 300x
`;

test("the quiet stretches are read from ffmpeg's log; a silence that never ends runs to the end; odd values are clamped", () => {
  expect(parseSilence(LOG, 10)).toEqual([r(2.0035, 5.0013), r(7.5, 10)]);
  expect(parseSilence("silence_start: -0.02\nsilence_end: 12 | silence_duration: 12", 10)).toEqual([r(0, 10)]);
  expect(parseSilence("", 10)).toEqual([]);
  expect(parseSilence("silence_end: 4.0 | silence_duration: 4", 10)).toEqual([]);
  expect(parseSilence("silence_start: 10", 10)).toEqual([]);
});

test("the spoken stretches: the complement of the silence, padded, merged where the pads meet, blips dropped", () => {
  expect(speechRanges([r(2, 5), r(7, 10)], 10)).toEqual([r(0, 2 + SPEECH_PAD_SECONDS), r(5 - SPEECH_PAD_SECONDS, 7 + SPEECH_PAD_SECONDS)]);
  /* Two silences 0.1 s apart leave a blip between them, which is dropped. */
  expect(speechRanges([r(2, 2.5), r(2.6, 5)], 6)).toEqual([r(0, 2.15), r(4.85, 6)]);
  /* A 0.1 s click between two silences is not speech. */
  expect(speechRanges([r(1, 3), r(3.1, 6)], 8)).toEqual([r(0, 1.15), r(5.85, 8)]);
  expect(speechRanges([], 8)).toEqual([r(0, 8)]);
  expect(speechRanges([r(0, 8)], 8)).toEqual([]);
  expect(speechRanges([r(0, 4)], 8)).toEqual([r(3.85, 8)]);
});

test("more than 12 spoken stretches: the longest 12, in time order", () => {
  const silences = Array.from({ length: 20 }, (_, i) => r(i * 3 + 1 + (i % 2 === 0 ? 0 : 0.5), i * 3 + 3));
  const speech = speechRanges(silences, 62, { pad: 0 });
  expect(speech.length).toBeLessThanOrEqual(MAX_KEEP_RANGES);
  expect(speech.map((x) => x.startSeconds)).toEqual([...speech.map((x) => x.startSeconds)].sort((a, b) => a - b));
  const merged = mergeKeep([r(0, 1)], Array.from({ length: 15 }, (_, i) => r(10 + i * 5, 10 + i * 5 + 1 + (i % 3))));
  expect(merged).toHaveLength(MAX_KEEP_RANGES);
});

test("explicit keep ranges and detected speech are merged", () => {
  expect(mergeKeep([r(1, 3), r(20, 22)], [r(2.5, 6), r(8, 9)])).toEqual([r(1, 6), r(8, 9), r(20, 22)]);
  expect(mergeKeep([], [])).toEqual([]);
});

const SOURCE = { file: "talk.mp4", durationSeconds: 20, width: 1920, height: 1080, hasAudio: true };
const cutdown = (extra: Record<string, unknown> = {}, source = SOURCE) => ({ aspect: "16:9", scale: 0.25, source, targetSeconds: 6, keep: [], cues: [], captionStyle: null, reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 }, ...extra });

test("the prop: silence is off by default, off or keep-speech; anything else is refused", () => {
  expect(validateProps("cutdown", cutdown())).toMatchObject({ ok: true, value: { silence: "off" } });
  expect(validateProps("cutdown", cutdown({ silence: "keep-speech" }))).toMatchObject({ ok: true, value: { silence: "keep-speech" } });
  const bad = validateProps("cutdown", cutdown({ silence: "remove" }));
  expect(bad).toMatchObject({ ok: false });
  expect(validateProps("final", { aspect: "16:9", scale: 0.25, title: null, clips: [], silence: "off" })).toMatchObject({ ok: false });
});

test("a real ffmpeg run on a WAV with two quiet stretches finds them (skipped where Remotion is not installed)", async () => {
  const compositor = path.join(process.cwd(), "remotion", "node_modules", "@remotion", "compositor-linux-x64-gnu");
  test.skip(!existsSync(path.join(compositor, "ffmpeg")), "needs `npm ci` in remotion/");
  const dir = mkdtempSync(path.join(os.tmpdir(), "remotion-silence-real-"));
  try {
    const rate = 8000, seconds = 10;
    const pcm = Buffer.alloc(rate * seconds * 2);
    const loud = (t: number) => (t < 2 || (t >= 5 && t < 7) ? 0.5 : 0);
    for (let i = 0; i < rate * seconds; i++) pcm.writeInt16LE(Math.round(loud(i / rate) * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const file = path.join(dir, "talk.wav");
    writeFileSync(file, Buffer.concat([header, pcm]));
    const silences = await createFfmpegSilenceDetector(path.join(compositor, "ffmpeg")).detect(file, seconds);
    expect(silences).toHaveLength(2);
    expect(silences[0].startSeconds).toBeGreaterThan(1.9);
    expect(silences[0].startSeconds).toBeLessThan(2.3);
    expect(Math.abs(silences[0].endSeconds - 5)).toBeLessThan(0.3);
    expect(Math.abs(silences[1].startSeconds - 7)).toBeLessThan(0.3);
    expect(silences[1].endSeconds).toBe(10);
    const speech = speechRanges(silences, seconds);
    expect(speech).toHaveLength(2);
    expect(speech[0].startSeconds).toBe(0);
    expect(Math.abs(speech[1].startSeconds - 4.85)).toBeLessThan(0.3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the ffmpeg command: the first sound track of a local file, silencedetect at -35 dB for 0.6 s, thrown away", async () => {
  const seen: string[][] = [];
  const run = ((_b: string, args: string[], _o: unknown, done: (e: Error | null, out: string, err: string) => void) => { seen.push(args); done(null, "", LOG); }) as never;
  const found = await createFfmpegSilenceDetector("/bin/ffmpeg", 1000, run).detect("/in/talk.mp4", 10);
  expect(found).toEqual([r(2.0035, 5.0013), r(7.5, 10)]);
  const args = seen[0];
  expect(args).toEqual(expect.arrayContaining(["-vn", "-map", "0:a:0", "-af", "silencedetect=noise=-35dB:d=0.6", "-f", "null", "-"]));
  expect(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
  await expect(createFfmpegSilenceDetector("/bin/ffmpeg", 1000, ((_b: string, _a: string[], _o: unknown, done: (e: Error | null) => void) => done(new Error("x"))) as never).detect("/in/talk.mp4", 10)).rejects.toThrow("could not be read for silence");
});

test.describe("the export command plans the cut from the speech", () => {
  let base: string;
  test.beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "remotion-silence-"));
    mkdirSync(path.join(base, "bundle"), { recursive: true });
    writeFileSync(path.join(base, "bundle", "index.html"), "<html></html>");
    mkdirSync(path.join(base, "input"), { recursive: true });
    writeFileSync(path.join(base, "input", "talk.mp4"), "video");
  });
  test.afterEach(() => rmSync(base, { recursive: true, force: true }));
  const prober: Prober = { probe: async () => ({ durationSeconds: 20, width: 1920, height: 1080, hasVideo: true, hasAudio: true }) };
  const rendered: { props?: Record<string, unknown> } = {};
  const renderer: Renderer = {
    prepare: async () => {},
    selectComposition: async ({ id, inputProps }) => {
      rendered.props = inputProps;
      const planned = checkSpec({ version: 1, composition: "cutdown", props: inputProps });
      if (!planned.ok) throw new Error("not valid");
      return { id, width: planned.timeline.width, height: planned.timeline.height, fps: planned.timeline.fps, durationInFrames: planned.timeline.durationInFrames, props: inputProps } as CompositionInfo;
    },
    renderVideo: async ({ outputLocation }) => writeFileSync(outputLocation, "mp4"),
    renderStill: async ({ outputLocation }) => writeFileSync(outputLocation, "png"),
  };
  const detector = (silences: Range[], calls: string[] = []): SilenceDetector => ({ detect: async (file) => { calls.push(path.basename(file)); return silences; } });
  const args = (props: Record<string, unknown>, silenceDetector?: SilenceDetector) => ({ prober, spec: { version: 1, composition: "cutdown", props }, inputDir: path.join(base, "input"), outputDir: path.join(base, "output"), bundleDir: path.join(base, "bundle"), workDir: path.join(base, "work"), renderer, ...(silenceDetector ? { silenceDetector } : {}) });

  test("keep-speech: speech between 4 and 9 s becomes the cut (6 s), the render gets the keep ranges, and result.json says what was found", async () => {
    const calls: string[] = [];
    /* silence 0-4 and 9-20: one spoken stretch, 3.85 to 9.15 */
    const result = await runExport(args(cutdown({ silence: "keep-speech" }), detector([r(0, 4), r(9, 20)], calls)));
    expect(result).toMatchObject({ ok: true, durationInFrames: 180 });
    if (!result.ok) return;
    expect(calls).toEqual(["talk.mp4"]);
    expect(rendered.props).toMatchObject({ silence: "off", keep: [r(3.85, 9.15)] });
    expect(result.silence).toEqual({ file: "talk.mp4", silentSeconds: 15, speech: [r(3.85, 9.15)], kept: [r(3.85, 9.15)] });
    expect(JSON.parse(readFileSync(path.join(base, "output", "result.json"), "utf8")).silence.kept).toEqual([r(3.85, 9.15)]);
  });

  test("explicit keep ranges are kept as well as the speech", async () => {
    const result = await runExport(args(cutdown({ silence: "keep-speech", keep: [r(15, 16)] }), detector([r(0, 4), r(9, 14)])));
    expect(result).toMatchObject({ ok: true });
    /* silence 0-4 and 9-14: speech 3.85-9.15 and 13.85-20; the explicit 15-16 lies inside the second */
    expect(rendered.props?.keep).toEqual([r(3.85, 9.15), r(13.85, 20)]);
  });

  test("off (the default): the detector is never asked, and the cut is planned as before", async () => {
    const calls: string[] = [];
    await runExport(args(cutdown(), detector([r(0, 4)], calls)));
    expect(calls).toEqual([]);
    expect(rendered.props?.keep).toEqual([]);
  });

  test("refusals: no detector here, a source with no sound, a detector that fails; none reaches the renderer", async () => {
    rendered.props = undefined;
    expect(await runExport(args(cutdown({ silence: "keep-speech" })))).toEqual({ ok: false, code: "spec_invalid", errors: ["props.silence: silence detection is not available here"] });
    expect(await runExport(args(cutdown({ silence: "keep-speech" }, { ...SOURCE, hasAudio: false }), detector([])))).toMatchObject({ ok: false, code: "spec_invalid", errors: ["props.silence: the source has no sound to find silence in"] });
    const failing: SilenceDetector = { detect: async () => { throw new Error("could not be read for silence"); } };
    expect(await runExport(args(cutdown({ silence: "keep-speech" }), failing))).toEqual({ ok: false, code: "input_mismatch", errors: ["input/talk.mp4: could not be read for silence"] });
    expect(rendered.props).toBeUndefined();
  });

  test("all quiet: no speech is found, nothing is added, and the cut is the even spread", async () => {
    const result = await runExport(args(cutdown({ silence: "keep-speech" }), detector([r(0, 20)])));
    expect(result).toMatchObject({ ok: true, silence: { speech: [], kept: [] } });
    expect(rendered.props?.keep).toEqual([]);
  });
});
