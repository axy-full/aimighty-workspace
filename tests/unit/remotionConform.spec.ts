import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSpec, runExport, usedWindow, type CompositionInfo, type Renderer } from "../../remotion/node/export";
import { createFfmpegConformer, filesToConform, highQualitySource, reportInputs, type Conformer } from "../../remotion/node/conform";
import { factsFromFfprobe, parseRate, type MediaFacts, type Prober } from "../../remotion/node/probe";
import { toTimeline, type CompositionId } from "../../remotion/src/lib";

/* The constant-frame-rate pre-pass: probe the rate, conform only variable-rate pictures, report every picture input. */

const stream = (rate: string, avg: string, extra: Record<string, unknown> = {}) => ({ format: { duration: "10.0" }, streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: rate, avg_frame_rate: avg, ...extra }, { codec_type: "audio" }] });

test("a rate is read from ffprobe's fraction; nonsense is no rate", () => {
  expect([parseRate("30/1"), parseRate("30000/1001"), parseRate("0/0"), parseRate("30"), parseRate(undefined), parseRate("1/0"), parseRate("5000/1")]).toEqual([30, 30000 / 1001, null, null, null, null, null]);
});

test("constant frame rate is not variable: 30/1, NTSC 30000/1001, and the usual small rounding", () => {
  expect(factsFromFfprobe(stream("30/1", "30/1"))).toMatchObject({ fps: 30, variableFrameRate: false });
  expect(factsFromFfprobe(stream("30000/1001", "30000/1001"))).toMatchObject({ fps: 29.97, variableFrameRate: false });
  expect(factsFromFfprobe(stream("30/1", "2997/100"))).toMatchObject({ fps: 29.97, variableFrameRate: false });
});

test("a phone clip that says 30 but averages 24.8 is variable frame rate; the average is its fps", () => {
  expect(factsFromFfprobe(stream("30/1", "2480/100"))).toMatchObject({ fps: 24.8, variableFrameRate: true });
  expect(factsFromFfprobe(stream("60/1", "30/1"))).toMatchObject({ fps: 30, variableFrameRate: true });
});

test("a missing average falls back to the nominal rate and is not called variable; audio only has no rate; rotation is still honoured", () => {
  expect(factsFromFfprobe(stream("25/1", "0/0"))).toMatchObject({ fps: 25, variableFrameRate: false });
  const audio = factsFromFfprobe({ format: { duration: "3" }, streams: [{ codec_type: "audio" }] });
  expect(audio.fps).toBeUndefined();
  expect(audio.variableFrameRate).toBeUndefined();
  expect(factsFromFfprobe(stream("30/1", "30/1", { side_data_list: [{ rotation: -90 }] }))).toMatchObject({ width: 1080, height: 1920, fps: 30 });
});

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({ durationSeconds: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30, variableFrameRate: false, ...over });

test("auto converts only variable-rate pictures; off converts nothing; audio is never converted", () => {
  const inputs = [{ file: "a.mp4", facts: facts() }, { file: "b.mp4", facts: facts({ variableFrameRate: true, fps: 24.8 }) }, { file: "c.mp4", facts: facts({ fps: 24 }) }, { file: "m.mp3", facts: facts({ hasVideo: false, variableFrameRate: true }) }];
  expect(filesToConform(inputs, "auto")).toEqual(["b.mp4"]);
  expect(filesToConform(inputs, "off")).toEqual([]);
});

test("the report: every picture input with its rate; a constant file at another rate is resampled, not conformed; a conformed one is neither", () => {
  const inputs = [{ file: "a.mp4", facts: facts() }, { file: "b.mp4", facts: facts({ variableFrameRate: true, fps: 24.8 }) }, { file: "c.mp4", facts: facts({ fps: 24 }) }, { file: "d.mp4", facts: facts({ variableFrameRate: true, fps: 20 }) }, { file: "m.mp3", facts: facts({ hasVideo: false }) }];
  expect(reportInputs(inputs, 30, new Set(["b.mp4"]), new Set(["d.mp4"]))).toEqual([
    { file: "a.mp4", fps: 30, variableFrameRate: false, targetFps: 30, conformed: false, resampled: false },
    { file: "b.mp4", fps: 24.8, variableFrameRate: true, targetFps: 30, conformed: true, resampled: false },
    { file: "c.mp4", fps: 24, variableFrameRate: false, targetFps: 30, conformed: false, resampled: true },
    { file: "d.mp4", fps: 20, variableFrameRate: true, targetFps: 30, conformed: false, resampled: true, conformFailed: true },
  ]);
});

test("the ffmpeg command: a local file only, one picture and the sound, constant rate at the export's fps, a high-quality intermediate, no network", async () => {
  const seen: string[][] = [];
  const run = ((_bin: string, args: string[], _o: unknown, done: (error: Error | null) => void) => { seen.push(args); done(null); }) as never;
  await createFfmpegConformer("/bin/ffmpeg", 1000, run).conform("/in/a.mp4", "/out/0.mp4", 30);
  const args = seen[0];
  expect(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
  expect(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2)).toEqual(["-r", "30"]);
  expect(args.slice(args.indexOf("-fps_mode"), args.indexOf("-fps_mode") + 2)).toEqual(["-fps_mode", "cfr"]);
  expect(args.slice(args.indexOf("-crf"), args.indexOf("-crf") + 2)).toEqual(["-crf", "14"]);
  expect(args).toEqual(expect.arrayContaining(["-map", "0:v:0", "0:a?"]));
  expect(args.at(-1)).toBe("/out/0.mp4");
  expect(args[args.indexOf("-i") + 1]).toBe("/in/a.mp4");
  await expect(createFfmpegConformer("/bin/ffmpeg", 1000, ((_b: string, _a: string[], _o: unknown, done: (e: Error | null) => void) => done(new Error("x"))) as never).conform("/in/a.mp4", "/out/0.mp4", 30)).rejects.toThrow("could not be conformed to a constant frame rate");
});

test("the spec: output.conform is off (the default) or auto", () => {
  const props = { aspect: "16:9", scale: 0.25, title: null, clips: [{ source: { file: "a.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }], captionStyle: null, end: null, music: null };
  const spec = (output: unknown) => checkSpec({ version: 1, composition: "final", props, output });
  expect(spec(undefined)).toMatchObject({ ok: true, conform: "off" });
  expect(spec({ conform: "auto" })).toMatchObject({ ok: true, conform: "auto" });
  expect(spec({ conform: "OFF" })).toMatchObject({ ok: true, conform: "off" });
  expect(spec({ conform: "always" })).toEqual({ ok: false, code: "spec_invalid", errors: ["spec.output.conform: must be auto or off"] });
  expect(spec({ conform: true })).toMatchObject({ ok: false });
});

test.describe("the export command with a conformer", () => {
  let base: string;
  test.beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "remotion-conform-"));
    mkdirSync(path.join(base, "bundle", "public", "fonts"), { recursive: true });
    writeFileSync(path.join(base, "bundle", "index.html"), "<html></html>");
    mkdirSync(path.join(base, "input"), { recursive: true });
    for (const name of ["vfr.mp4", "cfr.mp4", "slow.mp4"]) writeFileSync(path.join(base, "input", name), `original-${name}`);
  });
  test.afterEach(() => rmSync(base, { recursive: true, force: true }));

  const FACTS: Record<string, MediaFacts> = {
    "vfr.mp4": facts({ fps: 24.8, variableFrameRate: true }),
    "cfr.mp4": facts({ fps: 30 }),
    "slow.mp4": facts({ fps: 24 }),
  };
  const prober: Prober = { probe: async (file) => FACTS[path.basename(file)] };
  const clip = (file: string) => ({ source: { file, durationSeconds: 10, width: 1920, height: 1080, hasAudio: true }, trim: { startSeconds: 0, endSeconds: 2 }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } });
  const spec = (output: unknown = {}) => ({ version: 1, composition: "final", props: { aspect: "16:9", scale: 0.25, title: null, clips: [clip("vfr.mp4"), clip("cfr.mp4"), clip("slow.mp4")], captionStyle: null, end: null, music: null }, output });
  const planned = checkSpec(spec());
  const timeline = planned.ok ? planned.timeline : toTimeline("final" as CompositionId, undefined as never);
  const seenInput: Record<string, string> = {};
  const renderer: Renderer = {
    prepare: async () => {},
    selectComposition: async ({ id, serveUrl, inputProps }) => {
      for (const name of Object.keys(FACTS)) seenInput[name] = readFileSync(path.join(serveUrl, "public", "input", name), "utf8");
      const info: CompositionInfo = { id, width: timeline.width, height: timeline.height, fps: timeline.fps, durationInFrames: timeline.durationInFrames, props: inputProps };
      return info;
    },
    renderVideo: async ({ outputLocation }) => writeFileSync(outputLocation, "mp4"),
    renderStill: async ({ outputLocation }) => writeFileSync(outputLocation, "png"),
  };
  const args = (output: unknown, conformer?: Conformer) => ({ prober, spec: spec(output), inputDir: path.join(base, "input"), outputDir: path.join(base, "output"), bundleDir: path.join(base, "bundle"), workDir: path.join(base, "work"), renderer, ...(conformer ? { conformer } : {}) });
  const conformerLog: { input: string; output: string; fps: number; window?: unknown; timeoutMs?: number }[] = [];
  const fakeConformer = (fail = false): Conformer => ({ conform: async (input, output, fps, options) => { conformerLog.push({ input: path.basename(input), output: path.basename(output), fps, window: options?.window, timeoutMs: options?.timeoutMs }); if (fail) throw new Error("boom"); writeFileSync(output, `conformed-${path.basename(input)}`); } });
  test.beforeEach(() => { conformerLog.length = 0; Object.keys(seenInput).forEach((k) => delete seenInput[k]); });

  test("auto: the variable-rate picture is conformed to the export's rate and the render reads the copy; the others are untouched; the original is never changed; the work folder is gone", async () => {
    const result = await runExport(args({ conform: "auto" }, fakeConformer()));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(conformerLog).toEqual([{ input: "vfr.mp4", output: "0.mp4", fps: 30, window: { startSeconds: 0, endSeconds: 2.25 }, timeoutMs: 150_000 }]);
    expect(seenInput).toEqual({ "vfr.mp4": "conformed-vfr.mp4", "cfr.mp4": "original-cfr.mp4", "slow.mp4": "original-slow.mp4" });
    expect(readFileSync(path.join(base, "input", "vfr.mp4"), "utf8")).toBe("original-vfr.mp4");
    expect(result.inputs).toEqual([
      { file: "vfr.mp4", fps: 24.8, variableFrameRate: true, targetFps: 30, conformed: true, resampled: false },
      { file: "cfr.mp4", fps: 30, variableFrameRate: false, targetFps: 30, conformed: false, resampled: false },
      { file: "slow.mp4", fps: 24, variableFrameRate: false, targetFps: 30, conformed: false, resampled: true },
    ]);
    expect(JSON.parse(readFileSync(path.join(base, "output", "result.json"), "utf8")).inputs).toHaveLength(3);
    expect(existsSync(path.join(base, "work"))).toBe(false);
  });

  test("off: nothing is conformed, the variable-rate file is reported as resampled", async () => {
    const result = await runExport(args({ conform: "off" }, fakeConformer()));
    expect(conformerLog).toEqual([]);
    expect(seenInput["vfr.mp4"]).toBe("original-vfr.mp4");
    expect(result).toMatchObject({ ok: true, inputs: [{ file: "vfr.mp4", conformed: false, resampled: true }, { file: "cfr.mp4" }, { file: "slow.mp4", resampled: true }] });
  });

  test("a pre-pass that fails does not fail the export: the render reads the original and result.json says so", async () => {
    const result = await runExport(args({ conform: "auto" }, fakeConformer(true)));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(seenInput["vfr.mp4"]).toBe("original-vfr.mp4");
    expect(result.inputs?.[0]).toEqual({ file: "vfr.mp4", fps: 24.8, variableFrameRate: true, targetFps: 30, conformed: false, resampled: true, conformFailed: true });
  });

  test("with no conformer (a caller that has no ffmpeg) nothing is converted and the inputs are still reported", async () => {
    const result = await runExport(args({ conform: "auto" }));
    expect(result).toMatchObject({ ok: true, inputs: [{ file: "vfr.mp4", variableFrameRate: true, conformed: false }, { file: "cfr.mp4" }, { file: "slow.mp4" }] });
  });

  test("off is the default: nothing is conformed unless asked", async () => {
    const result = await runExport(args({}, fakeConformer()));
    expect(conformerLog).toEqual([]);
    expect(result).toMatchObject({ ok: true, inputs: [{ file: "vfr.mp4", conformed: false, resampled: true }, { file: "cfr.mp4" }, { file: "slow.mp4" }] });
  });

  test("only the stretch the export uses is converted (padded 0.25 s, never past the file), and the copy is moved into the served folder, not copied", async () => {
    let leftInWork: boolean | null = null;
    const watching: Renderer = { ...renderer, selectComposition: async (a) => { leftInWork = existsSync(path.join(base, "work", "conformed", "0.mp4")); return renderer.selectComposition(a); } };
    const result = await runExport({ ...args({ conform: "auto" }, fakeConformer()), renderer: watching });
    expect(result).toMatchObject({ ok: true });
    expect(conformerLog[0].window).toEqual({ startSeconds: 0, endSeconds: 2.25 });
    expect(leftInWork).toBe(false);
    expect(seenInput["vfr.mp4"]).toBe("conformed-vfr.mp4");
  });

  test("a windowed copy starts at zero, so the renderer is told where in the source it starts: offsetSeconds on every source that uses it, on no other", async () => {
    const later = { version: 1, composition: "final", props: { aspect: "16:9", scale: 0.25, title: null, clips: [{ ...clip("vfr.mp4"), trim: { startSeconds: 2, endSeconds: 4 } }, clip("cfr.mp4"), { ...clip("vfr.mp4"), trim: { startSeconds: 6, endSeconds: 7 } }], captionStyle: null, end: null, music: null }, output: { conform: "auto" } };
    type Props = { clips: { source: { file: string; offsetSeconds?: number } }[] };
    const got: { props?: Props } = {};
    const laterPlan = checkSpec(later);
    if (!laterPlan.ok) throw new Error(JSON.stringify(laterPlan));
    const watching: Renderer = { ...renderer, selectComposition: async (a) => { got.props = a.inputProps as Props; return { id: a.id, width: laterPlan.timeline.width, height: laterPlan.timeline.height, fps: laterPlan.timeline.fps, durationInFrames: laterPlan.timeline.durationInFrames, props: a.inputProps }; } };
    const result = await runExport({ ...args({}, fakeConformer()), spec: later, renderer: watching });
    expect(result).toMatchObject({ ok: true });
    expect(conformerLog[0].window).toEqual({ startSeconds: 1.75, endSeconds: 7.25 });
    expect(got.props?.clips.map((c) => [c.source.file, c.source.offsetSeconds])).toEqual([["vfr.mp4", 1.75], ["cfr.mp4", undefined], ["vfr.mp4", 1.75]]);
    /* Nothing conformed, nothing marked. */
    got.props = undefined;
    await runExport({ ...args({}, fakeConformer(true)), spec: later, renderer: watching });
    expect((got as { props?: Props }).props?.clips.map((c) => c.source.offsetSeconds)).toEqual([undefined, undefined, undefined]);
  });

  test("offsetSeconds: checked against the file, left out when zero, and it moves the picture's start in the file earlier by that much, never before the start", () => {
    const src = (extra: Record<string, unknown>) => ({ version: 1, composition: "final", props: { aspect: "16:9", scale: 0.25, title: null, clips: [{ ...clip("a.mp4"), source: { file: "a.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true, ...extra }, trim: { startSeconds: 3, endSeconds: 5 } }], captionStyle: null, end: null, music: null } });
    expect(checkSpec(src({ offsetSeconds: 11 }))).toMatchObject({ ok: false });
    expect(checkSpec(src({ offsetSeconds: -1 }))).toMatchObject({ ok: false });
    const plain = checkSpec(src({ offsetSeconds: 0 }));
    if (!plain.ok) throw new Error(JSON.stringify(plain));
    expect((plain.props as { clips: { source: object }[] }).clips[0].source).not.toHaveProperty("offsetSeconds");
    const shifted = checkSpec(src({ offsetSeconds: 2.5 }));
    if (!shifted.ok) throw new Error(JSON.stringify(shifted));
    const first = (t: typeof plain.timeline) => t.items.find((i) => i.kind === "clip") as { trimBefore: number } | undefined;
    expect(first(plain.timeline)?.trimBefore).toBe(90);
    expect(first(shifted.timeline)?.trimBefore).toBe(15);
    const late = checkSpec(src({ offsetSeconds: 4 }));
    if (!late.ok) throw new Error(JSON.stringify(late));
    expect(first(late.timeline)?.trimBefore).toBe(0);
  });

  test("a file used twice is covered from its earliest point to its latest, and a stretch is clamped to the file", () => {
    const twice = checkSpec({ version: 1, composition: "final", props: { aspect: "16:9", scale: 0.25, title: null, clips: [{ ...clip("vfr.mp4"), trim: { startSeconds: 1, endSeconds: 2 } }, { ...clip("vfr.mp4"), trim: { startSeconds: 7, endSeconds: 9.9 } }], captionStyle: null, end: null, music: null } });
    if (!twice.ok) throw new Error(JSON.stringify(twice));
    expect(usedWindow(twice.timeline, "vfr.mp4", 10)).toEqual({ startSeconds: 0.75, endSeconds: 10 });
    expect(usedWindow(twice.timeline, "vfr.mp4")).toEqual({ startSeconds: 0.75, endSeconds: 10.15 });
    expect(usedWindow(twice.timeline, "other.mp4", 10)).toBeUndefined();
  });

  test("a failed pre-pass leaves no partial copy behind, and the render reads the original", async () => {
    const partial: Conformer = { conform: async (_input, output) => { writeFileSync(output, "half a file"); throw new Error("boom"); } };
    let leftover: boolean | null = null;
    const watching: Renderer = { ...renderer, selectComposition: async (a) => { leftover = existsSync(path.join(base, "work", "conformed", "0.mp4")); return renderer.selectComposition(a); } };
    const result = await runExport({ ...args({ conform: "auto" }, partial), renderer: watching });
    expect(result).toMatchObject({ ok: true, inputs: [{ file: "vfr.mp4", conformFailed: true, conformed: false }, {}, {}] });
    expect(leftover).toBe(false);
    expect(seenInput["vfr.mp4"]).toBe("original-vfr.mp4");
  });

  test("the pre-pass has a total budget: each file gets what is left (at most 150 s), and a file that finds none left is not converted and says so", async () => {
    for (const name of ["vfr2.mp4", "vfr3.mp4"]) { writeFileSync(path.join(base, "input", name), `original-${name}`); FACTS[name] = facts({ fps: 24.8, variableFrameRate: true }); }
    const three = { version: 1, composition: "final", props: { aspect: "16:9", scale: 0.25, title: null, clips: [clip("vfr.mp4"), clip("vfr2.mp4"), clip("vfr3.mp4")], captionStyle: null, end: null, music: null }, output: { conform: "auto" } };
    let now = 0;
    const slow: Conformer = { conform: async (input, output, fps, options) => { conformerLog.push({ input: path.basename(input), output: path.basename(output), fps, window: options?.window, timeoutMs: options?.timeoutMs }); now += 200_000; writeFileSync(output, "conformed"); } };
    const seen: string[] = [];
    const watching: Renderer = { ...renderer, selectComposition: async (a) => { for (const n of ["vfr.mp4", "vfr2.mp4", "vfr3.mp4"]) seen.push(readFileSync(path.join(a.serveUrl, "public", "input", n), "utf8")); return renderer.selectComposition(a); } };
    const result = await runExport({ ...args({}, slow), spec: three, renderer: watching, conformBudgetMs: 300_000, conformClock: () => now });
    delete FACTS["vfr2.mp4"]; delete FACTS["vfr3.mp4"];
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(conformerLog.map((c) => c.timeoutMs)).toEqual([150_000, 100_000]);
    expect(seen).toEqual(["conformed", "conformed", "original-vfr3.mp4"]);
    expect(result.inputs?.map((i) => [i.file, i.conformed, i.conformFailed === true])).toEqual([["vfr.mp4", true, false], ["vfr2.mp4", true, false], ["vfr3.mp4", false, true]]);
  });

  test("a ProRes, 10-bit or alpha source is never flattened: it is left alone, resampled by the render, and reported as skipped", async () => {
    FACTS["vfr.mp4"] = facts({ fps: 24.8, variableFrameRate: true, videoCodec: "prores", pixFmt: "yuv422p10le" });
    const result = await runExport(args({ conform: "auto" }, fakeConformer()));
    FACTS["vfr.mp4"] = facts({ fps: 24.8, variableFrameRate: true });
    expect(conformerLog).toEqual([]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.inputs?.[0]).toEqual({ file: "vfr.mp4", fps: 24.8, variableFrameRate: true, targetFps: 30, conformed: false, resampled: true, skipped: "high-quality source" });
  });
});

const COMPOSITOR = path.join(process.cwd(), "remotion", "node_modules", "@remotion", "compositor-linux-x64-gnu");
test("real ffmpeg (skipped where Remotion is not installed): the fixture clip becomes constant 25 fps, H.264 4:2:0, its length kept", async () => {
  test.skip(!existsSync(path.join(COMPOSITOR, "ffmpeg")), "needs `npm ci` in remotion/");
  const dir = mkdtempSync(path.join(os.tmpdir(), "remotion-conform-real-"));
  try {
    const source = path.join(process.cwd(), "public", "fixtures", "clip.mp4");
    const out = path.join(dir, "conformed.mp4");
    await createFfmpegConformer(path.join(COMPOSITOR, "ffmpeg"), 120_000).conform(source, out, 25);
    const info = JSON.parse(execFileSync(path.join(COMPOSITOR, "ffprobe"), ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", out], { encoding: "utf8" }));
    const video = info.streams.find((x: { codec_type: string }) => x.codec_type === "video");
    expect([video.r_frame_rate, video.avg_frame_rate, video.codec_name, video.pix_fmt]).toEqual(["25/1", "25/1", "h264", "yuv420p"]);
    /* The fixture clip is picture only; sound is kept when a source has it (the command maps 0:a?). */
    expect(info.streams.some((x: { codec_type: string }) => x.codec_type === "audio")).toBe(false);
    expect(Math.abs(Number(info.format.duration) - 10)).toBeLessThan(0.2);
    expect(factsFromFfprobe(info)).toMatchObject({ fps: 25, variableFrameRate: false });
    /* Only a window: 2 s to 4 s of the clip, as a copy that starts at zero (the export carries the position as offsetSeconds). */
    const windowed = path.join(dir, "windowed.mp4");
    await createFfmpegConformer(path.join(COMPOSITOR, "ffmpeg"), 120_000).conform(source, windowed, 25, { window: { startSeconds: 2, endSeconds: 4 } });
    const w = JSON.parse(execFileSync(path.join(COMPOSITOR, "ffprobe"), ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", windowed], { encoding: "utf8" }));
    expect(Number(w.format.start_time)).toBeGreaterThanOrEqual(0);
    expect(Number(w.format.start_time)).toBeLessThan(0.1);
    expect(Math.abs(Number(w.format.duration) - 2)).toBeLessThan(0.2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("high-quality sources: ProRes, DNxHD, any 10 bits or more, any alpha; ordinary 8-bit 4:2:0 is not", () => {
  const q = (videoCodec: string, pixFmt: string) => highQualitySource(facts({ videoCodec, pixFmt }));
  for (const [codec, fmt] of [["prores", "yuv422p10le"], ["dnxhd", "yuv422p"], ["h264", "yuv420p10le"], ["hevc", "p010le"], ["h264", "yuv444p12le"], ["vp9", "yuva420p"], ["png", "rgba"], ["qtrle", "argb"], ["h264", "gbrap"]]) expect(q(codec, fmt), `${codec} ${fmt}`).toBe(true);
  for (const [codec, fmt] of [["h264", "yuv420p"], ["h264", "yuvj420p"], ["vp9", "yuv420p"], ["hevc", "yuv420p"], ["h264", "yuv444p"], ["mpeg4", "yuv420p"]]) expect(q(codec, fmt), `${codec} ${fmt}`).toBe(false);
  expect(highQualitySource(facts())).toBe(false);
  expect(filesToConform([{ file: "p.mov", facts: facts({ variableFrameRate: true, videoCodec: "prores", pixFmt: "yuv422p10le" }) }, { file: "a.mp4", facts: facts({ variableFrameRate: true, videoCodec: "h264", pixFmt: "yuv420p" }) }], "auto")).toEqual(["a.mp4"]);
});

test("the probe reads the picture's codec and pixel format, and cover art in an audio file is not a picture", () => {
  expect(factsFromFfprobe({ format: { duration: "5" }, streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1", avg_frame_rate: "30/1", codec_name: "h264", pix_fmt: "yuv420p" }] })).toMatchObject({ hasVideo: true, videoCodec: "h264", pixFmt: "yuv420p" });
  const cover = factsFromFfprobe({ format: { duration: "180" }, streams: [{ codec_type: "audio" }, { codec_type: "video", width: 600, height: 600, codec_name: "mjpeg", pix_fmt: "yuvj420p", disposition: { attached_pic: 1 } }] });
  expect(cover.hasVideo).toBe(false);
  expect(cover.hasAudio).toBe(true);
  expect(cover.videoCodec).toBeUndefined();
  expect(reportInputs([{ file: "song.mp3", facts: cover }], 30, new Set(), new Set())).toEqual([]);
});

test("the conform ffmpeg call reads only the formats it needs, converts only the window into a copy that starts at zero, and removes a copy that failed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remotion-conform-args-"));
  try {
    const seen: string[][] = [];
    const ok = ((_b: string, args: string[], options: { timeout: number }, done: (e: Error | null) => void) => { seen.push([...args, `timeout=${options.timeout}`]); done(null); }) as never;
    await createFfmpegConformer("/bin/ffmpeg", 1000, ok).conform("/in/a.mp4", "/out/0.mp4", 30, { window: { startSeconds: 2, endSeconds: 5.5 }, timeoutMs: 777 });
    const args = seen[0];
    const at = (flag: string) => args.slice(args.indexOf(flag), args.indexOf(flag) + 2);
    expect(at("-format_whitelist")).toEqual(["-format_whitelist", "mov,mp4,m4a,matroska,webm"]);
    expect(at("-ss")).toEqual(["-ss", "2"]);
    expect(at("-t")).toEqual(["-t", "3.5"]);
    expect(args).not.toContain("-output_ts_offset");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("timeout=777");
    /* No window: the whole file. */
    seen.length = 0;
    await createFfmpegConformer("/bin/ffmpeg", 1000, ok).conform("/in/a.mp4", "/out/0.mp4", 30);
    expect(seen[0]).not.toContain("-ss");
    expect(seen[0]).not.toContain("-output_ts_offset");
    /* A failure removes what was written. */
    const partial = path.join(dir, "partial.mp4");
    writeFileSync(partial, "half");
    const bad = ((_b: string, _a: string[], _o: unknown, done: (e: Error | null) => void) => done(new Error("x"))) as never;
    await expect(createFfmpegConformer("/bin/ffmpeg", 1000, bad).conform("/in/a.mp4", partial, 30)).rejects.toThrow("could not be conformed to a constant frame rate");
    expect(existsSync(partial)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
