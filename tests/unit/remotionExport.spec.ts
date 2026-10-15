import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSpec, contradictions, declaredOf, inputFilesOf, runExport, type CompositionInfo, type Renderer } from "../../remotion/node/export";
import { encodingFor } from "../../remotion/node/renderer";
import { factsFromFfprobe, type MediaFacts, type Prober } from "../../remotion/node/probe";
import { toTimeline, validateProps, type CompositionId } from "../../remotion/src/lib";
import { PRORES_MAX_FRAMES } from "../../remotion/src/lib/limits";

/** A renderer that renders nothing: it measures with the same timeline code and writes small stand-in files. */
function fakeRenderer(opts: { failOn?: "prepare" | "select" | "video" | "still"; lie?: boolean } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const seenFiles: string[] = [];
  const renderer: Renderer = {
    async prepare() {
      calls.push({ name: "prepare", args: {} });
      if (opts.failOn === "prepare") throw new Error("no browser");
    },
    async selectComposition(args) {
      calls.push({ name: "select", args });
      if (opts.failOn === "select") throw new Error("could not open the bundle");
      // What the page would see: the bundle, the fonts and the session's input files, served from args.serveUrl.
      for (const rel of ["index.html", "public/fonts/f.woff2"]) if (existsSync(path.join(args.serveUrl, rel))) seenFiles.push(rel);
      const input = path.join(args.serveUrl, "public", "input");
      if (existsSync(input)) for (const name of readdirSync(input)) seenFiles.push(`public/input/${name}`);
      const t = toTimeline(args.id as CompositionId, args.inputProps as never);
      const info: CompositionInfo = { id: args.id, width: t.width + (opts.lie ? 2 : 0), height: t.height, fps: t.fps, durationInFrames: t.durationInFrames, props: args.inputProps };
      return info;
    },
    async renderVideo(args) {
      calls.push({ name: "video", args });
      if (opts.failOn === "video") throw new Error("Chrome crashed");
      args.onProgress?.(args.composition.durationInFrames, args.composition.durationInFrames);
      writeFileSync(args.outputLocation, "mp4");
    },
    async renderStill(args) {
      calls.push({ name: "still", args });
      if (opts.failOn === "still") throw new Error("frame timed out");
      writeFileSync(args.outputLocation, "png");
    },
  };
  return { renderer, calls, seenFiles };
}

/** A prober that reports what the tests say the files are (by default: exactly what SOURCE declares). */
function fakeProber(overrides: Record<string, Partial<MediaFacts> | "unreadable"> = {}) {
  const calls: string[] = [];
  const prober: Prober = {
    async probe(file) {
      const name = path.relative(path.join(base, "input"), file);
      calls.push(name);
      const o = overrides[name];
      if (o === "unreadable") throw new Error("could not be read as media");
      return { durationSeconds: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true, ...o };
    },
  };
  return { prober, calls };
}

let base: string;
test.beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "remotion-export-"));
  mkdirSync(path.join(base, "bundle", "public", "fonts"), { recursive: true });
  writeFileSync(path.join(base, "bundle", "index.html"), "<html></html>");
  writeFileSync(path.join(base, "bundle", "public", "fonts", "f.woff2"), "font");
  mkdirSync(path.join(base, "input", "clips"), { recursive: true });
  writeFileSync(path.join(base, "input", "clips", "a.mp4"), "video");
  writeFileSync(path.join(base, "input", "logo.png"), "logo");
});
test.afterEach(() => rmSync(base, { recursive: true, force: true }));

const args = (spec: unknown, renderer: Renderer, extra: Record<string, unknown> = {}) => ({
  prober: fakeProber().prober,
  spec,
  inputDir: path.join(base, "input"),
  outputDir: path.join(base, "output"),
  bundleDir: path.join(base, "bundle"),
  workDir: path.join(base, "work"),
  renderer,
  ...extra,
});

const SOURCE = { file: "clips/a.mp4", durationSeconds: 10, width: 1920, height: 1080 };
const finalSpec = (output?: unknown) => ({
  version: 1,
  composition: "final",
  props: { aspect: "9:16", scale: 0.25, title: { title: "T", logo: { file: "logo.png" }, durationSeconds: 1 }, clips: [{ source: SOURCE, trim: { startSeconds: 0, endSeconds: 2 } }], end: { headline: "E", durationSeconds: 1 } },
  ...(output ? { output } : {}),
});

test.describe("output formats: H.264 by default, ProRes 422 and 422 HQ, never H.265", () => {
  test("H.264 is the default: export.mp4, video/mp4, and the renderer is told h264", async () => {
    const { renderer, calls } = fakeRenderer();
    const result = await runExport(args(finalSpec(), renderer));
    expect(result).toMatchObject({ ok: true });
    expect(calls.find((c) => c.name === "video")!.args.format).toBe("h264");
    const explicit = fakeRenderer();
    expect(await runExport(args(finalSpec({ video: true, format: "h264" }), explicit.renderer))).toMatchObject({ ok: true, files: [{ name: "export.mp4", format: "h264", mime: "video/mp4" }] });
  });

  for (const [format, profile] of [["prores-422", "standard"], ["prores-422-hq", "hq"]] as const) {
    test(`${format}: export.mov, video/quicktime, the renderer is told ${format}, and Remotion's profile name is ${profile}`, async () => {
      const { renderer, calls } = fakeRenderer();
      const result = await runExport(args(finalSpec({ format }), renderer));
      expect(result).toMatchObject({ ok: true, files: [{ name: "export.mov", kind: "video", format, mime: "video/quicktime" }] });
      expect(existsSync(path.join(base, "output", "export.mov"))).toBe(true);
      expect(existsSync(path.join(base, "output", "export.mp4"))).toBe(false);
      expect(calls.find((c) => c.name === "video")!.args.format).toBe(format);
      expect(encodingFor(format)).toEqual({ codec: "prores", proResProfile: profile, audioCodec: "pcm-16", pixelFormat: "yuv422p10le" });
    });
  }

  test("the encodings: H.264 is CRF 20 with AAC in 4:2:0; ProRes is 10-bit 4:2:2 with 16-bit PCM", () => {
    expect(encodingFor("h264")).toEqual({ codec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", crf: 20, x264Preset: "medium" });
  });

  test("H.265 is refused with a plain reason, whatever it is called; so is any other name; none of them reaches the renderer", async () => {
    for (const name of ["h265", "H.265", "hevc", " HEVC ", "x265", "h265-mp4"]) {
      const { renderer, calls } = fakeRenderer();
      const result = await runExport(args(finalSpec({ format: name }), renderer));
      expect(result).toEqual({ ok: false, code: "spec_invalid", errors: ["spec.output.format: H.265 is not available."] });
      expect(calls).toEqual([]);
    }
    for (const name of ["vp9", "gif", "prores", "prores-4444", "", 5, null, "h264 "]) {
      const { renderer, calls } = fakeRenderer();
      const result = await runExport(args(finalSpec({ format: name }), renderer));
      if (name === "h264 ") { expect(result).toMatchObject({ ok: true }); continue; }
      expect(result).toMatchObject({ ok: false, code: "spec_invalid" });
      expect((result as { errors: string[] }).errors[0]).toMatch(/spec\.output\.format: must be one of h264, prores-422, prores-422-hq/);
      expect(calls).toEqual([]);
    }
  });

  test("a format needs the video: output.video false with a format is refused", async () => {
    const result = await runExport(args(finalSpec({ video: false, stills: [0], format: "prores-422" }), fakeRenderer().renderer));
    expect(result).toEqual({ ok: false, code: "spec_invalid", errors: ["spec.output.format: needs the video (output.video is false)"] });
  });

  test("ProRes is held to 1800 frames (60 s at 30 fps, 30 s at 60 fps), a constant that nothing can raise; H.264 is not held", () => {
    const long = (seconds: number, fps = 30) => ({ version: 1, composition: "final", props: { aspect: "16:9", fps, scale: 0.25, title: null, clips: [{ source: { ...SOURCE, durationSeconds: seconds }, trim: { startSeconds: 0, endSeconds: seconds } }], end: null, music: null }, output: { format: "prores-422" } });
    expect(PRORES_MAX_FRAMES).toBe(1800);
    expect(checkSpec(long(60))).toMatchObject({ ok: true, format: "prores-422" });
    expect(checkSpec(long(30, 60))).toMatchObject({ ok: true, format: "prores-422" });
    expect(checkSpec(long(70))).toEqual({ ok: false, code: "too_long", errors: ["A ProRes export can be at most 1800 frames (60 s at 30 fps, 30 s at 60 fps); this one is 2100 frames (70.0 s at 30 fps). Use H.264 for a longer one."] });
    /* The same length at a higher frame rate is more frames, so it is refused: 45 s at 60 fps is 2700. */
    expect(checkSpec(long(45, 60))).toEqual({ ok: false, code: "too_long", errors: ["A ProRes export can be at most 1800 frames (60 s at 30 fps, 30 s at 60 fps); this one is 2700 frames (45.0 s at 60 fps). Use H.264 for a longer one."] });
    expect(checkSpec(long(60, 25))).toMatchObject({ ok: true });
    expect(checkSpec(long(75, 25))).toMatchObject({ ok: false, code: "too_long" });
    expect(checkSpec({ ...long(70), output: { format: "h264" } })).toMatchObject({ ok: true, format: "h264" });
  });
});

test.describe("the export command with a fake renderer", () => {
  test("renders a video, hands the renderer the validated props, and writes result.json", async () => {
    const { renderer, calls, seenFiles } = fakeRenderer();
    const progress: number[] = [];
    const result = await runExport(args(finalSpec(), renderer, { concurrency: 3, onProgress: (done: number) => progress.push(done) }));
    expect(result).toMatchObject({ ok: true, composition: "final", width: 270, height: 480, fps: 30, durationInFrames: 120, seconds: 4 });
    if (!result.ok) return;
    expect(result.files).toEqual([{ name: "export.mp4", kind: "video", bytes: 3, format: "h264", mime: "video/mp4" }]);
    expect(JSON.parse(readFileSync(path.join(base, "output", "result.json"), "utf8")).durationInFrames).toBe(120);
    const select = calls.find((c) => c.name === "select")!;
    expect((select.args.inputProps as { fps: number }).fps).toBe(30); // the default was filled in
    expect(calls.find((c) => c.name === "video")!.args.concurrency).toBe(3);
    expect(progress).toEqual([120]);
    // The page can see the bundle, the bundled font and the session's files, and nothing else.
    expect(seenFiles.sort()).toEqual(["index.html", "public/fonts/f.woff2", "public/input/clips", "public/input/logo.png"].sort());
    expect(existsSync(path.join(base, "work"))).toBe(false);
  });

  test("stills only, at fixed frames", async () => {
    const { renderer, calls } = fakeRenderer();
    const result = await runExport(args(finalSpec({ video: false, stills: [0, 59, 59, 119] }), renderer));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => f.name)).toEqual(["still-0.png", "still-59.png", "still-119.png"]);
    expect(calls.some((c) => c.name === "video")).toBe(false);
    expect(calls.filter((c) => c.name === "still").map((c) => c.args.frame)).toEqual([0, 59, 119]);
  });

  test("a spec that is not valid never reaches the renderer", async () => {
    for (const spec of [null, [], { version: 2 }, { version: 1, composition: "evil", props: {} }, { version: 1, composition: "title-card", props: { aspect: "16:9", card: {} } }, { ...finalSpec(), extra: true }, finalSpec({ video: false }), finalSpec({ stills: [-1] }), finalSpec({ stills: [120] }), finalSpec({ video: "yes" })]) {
      const { renderer, calls } = fakeRenderer();
      const result = await runExport(args(spec, renderer));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("spec_invalid");
      expect(calls).toEqual([]);
    }
  });

  test("a too long export is refused as too_long", async () => {
    const { renderer, calls } = fakeRenderer();
    const spec = { version: 1, composition: "final", props: { aspect: "16:9", clips: Array.from({ length: 14 }, () => ({ source: SOURCE })) } };
    const result = await runExport(args(spec, renderer, { limits: undefined }));
    expect(result).toMatchObject({ ok: false, code: "too_long" });
    expect(calls).toEqual([]);
  });

  test("a missing input file is named, and nothing runs", async () => {
    const { renderer, calls } = fakeRenderer();
    const spec = finalSpec();
    (spec.props.title.logo as { file: string }).file = "gone.png";
    const result = await runExport(args(spec, renderer));
    expect(result).toEqual({ ok: false, code: "input_missing", errors: ["input/gone.png: not found"] });
    expect(calls).toEqual([]);
  });

  test("a symlink in the input folder that leads out of it counts as missing", async () => {
    writeFileSync(path.join(base, "secret.png"), "secret");
    symlinkSync(path.join(base, "secret.png"), path.join(base, "input", "escape.png"));
    const spec = finalSpec();
    (spec.props.title.logo as { file: string }).file = "escape.png";
    const result = await runExport(args(spec, fakeRenderer().renderer));
    expect(result).toMatchObject({ ok: false, code: "input_missing" });
  });

  test("an empty input file counts as missing", async () => {
    writeFileSync(path.join(base, "input", "logo.png"), "");
    const result = await runExport(args(finalSpec(), fakeRenderer().renderer));
    expect(result).toMatchObject({ ok: false, code: "input_missing" });
  });

  for (const failOn of ["prepare", "select", "video"] as const) {
    test(`a renderer that fails at ${failOn} gives render_failed and leaves no scratch folder`, async () => {
      const result = await runExport(args(finalSpec(), fakeRenderer({ failOn }).renderer));
      expect(result).toMatchObject({ ok: false, code: "render_failed" });
      expect(existsSync(path.join(base, "work"))).toBe(false);
    });
  }

  test("a still that fails gives render_failed", async () => {
    const result = await runExport(args(finalSpec({ video: false, stills: [3] }), fakeRenderer({ failOn: "still" }).renderer));
    expect(result).toMatchObject({ ok: false, code: "render_failed" });
  });

  test("a composition that measures differently from the timeline is refused", async () => {
    const result = await runExport(args(finalSpec(), fakeRenderer({ lie: true }).renderer));
    expect(result).toMatchObject({ ok: false, code: "render_failed" });
    if (!result.ok) expect(result.errors[0]).toContain("measured");
  });

  test("the bundle folder is never written to", async () => {
    await runExport(args(finalSpec(), fakeRenderer().renderer));
    expect(readdirSync(path.join(base, "bundle")).sort()).toEqual(["index.html", "public"]);
    expect(readdirSync(path.join(base, "bundle", "public"))).toEqual(["fonts"]);
  });
});

test.describe("declared values are checked against the files", () => {
  const run = (overrides: Record<string, Partial<MediaFacts> | "unreadable">) => {
    const { renderer, calls } = fakeRenderer();
    const { prober, calls: probed } = fakeProber(overrides);
    return runExport(args(finalSpec(), renderer, { prober })).then((result) => ({ result, calls, probed }));
  };

  test("a file that matches is probed once and rendered", async () => {
    const { result, calls, probed } = await run({});
    expect(result.ok).toBe(true);
    expect(probed).toEqual(["clips/a.mp4"]);
    expect(calls.some((c) => c.name === "video")).toBe(true);
  });

  test("a different length (over 0.1 s), size or audio is refused with the reason, and nothing renders", async () => {
    const cases: [Partial<MediaFacts> | "unreadable", string][] = [
      [{ durationSeconds: 9.8 }, "is 9.80 s, the request says 10 s"],
      [{ durationSeconds: 10.2 }, "is 10.20 s"],
      [{ width: 1280, height: 720 }, "is 1280x720, the request says 1920x1080"],
      [{ width: 1921 }, "is 1921x1080"],

      [{ hasVideo: false }, "has no picture"],
      ["unreadable", "could not be read as media"],
    ];
    for (const [override, reason] of cases) {
      const { result, calls } = await run({ "clips/a.mp4": override });
      expect(result.ok, JSON.stringify(override)).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("input_mismatch");
      expect(result.errors.join(" ")).toContain(reason);
      expect(calls).toEqual([]);
    }
  });

  test("sound: a file with none is refused when the request says it has some; a file with sound the request does not use is muted, not refused", async () => {
    const { result } = await run({ "clips/a.mp4": { hasAudio: false } });
    expect(result).toMatchObject({ ok: false, code: "input_mismatch" });
    if (!result.ok) expect(result.errors.join(" ")).toContain("has no audio, the request says it has");
    const spec = finalSpec();
    ((spec.props as { clips: { source: { hasAudio?: boolean } }[] }).clips[0].source).hasAudio = false;
    const muted = await runExport(args(spec, fakeRenderer().renderer, { prober: fakeProber({ "clips/a.mp4": { hasAudio: true } }).prober }));
    expect(muted.ok).toBe(true);
  });

  test("within 0.1 s is accepted", async () => {
    expect((await run({ "clips/a.mp4": { durationSeconds: 10.09 } })).result.ok).toBe(true);
    expect((await run({ "clips/a.mp4": { durationSeconds: 9.91 } })).result.ok).toBe(true);
  });

  test("music is probed too: it must have audio and its stated length", async () => {
    const spec = finalSpec();
    (spec.props as Record<string, unknown>).music = { file: "m.mp3", durationSeconds: 6 };
    writeFileSync(path.join(base, "input", "m.mp3"), "mp3");
    const ok = await runExport(args(spec, fakeRenderer().renderer, { prober: fakeProber({ "m.mp3": { durationSeconds: 6, hasVideo: false } }).prober }));
    expect(ok.ok).toBe(true);
    const bad = await runExport(args(spec, fakeRenderer().renderer, { prober: fakeProber({ "m.mp3": { durationSeconds: 3, hasVideo: false } }).prober }));
    expect(bad).toMatchObject({ ok: false, code: "input_mismatch" });
    const silent = await runExport(args(spec, fakeRenderer().renderer, { prober: fakeProber({ "m.mp3": { durationSeconds: 6, hasAudio: false } }).prober }));
    expect(silent).toMatchObject({ ok: false, code: "input_mismatch" });
  });

  test("declared facts come from every composition that reads a clip", () => {
    const src = { file: "a.mp4", durationSeconds: 5, width: 640, height: 360, hasAudio: true };
    expect(declaredOf("captions", { clip: { source: src } }).map((d) => d.file)).toEqual(["a.mp4"]);
    expect(declaredOf("reframe", { clip: { source: src } })).toHaveLength(1);
    expect(declaredOf("cutdown", { source: src })).toHaveLength(1);
    expect(declaredOf("final", { clips: [{ source: src }, { source: src }, { source: { ...src, file: "b.mp4" } }] }).map((d) => d.file)).toEqual(["a.mp4", "b.mp4"]);
    expect(declaredOf("title-card", {})).toEqual([]);
  });

  test("all contradictions are listed together", async () => {
    const reasons = await contradictions(
      [{ file: "a.mp4", kind: "video", durationSeconds: 5, width: 640, height: 360, hasAudio: true }],
      path.join(base, "input"),
      { probe: async () => ({ durationSeconds: 9, width: 1, height: 2, hasVideo: true, hasAudio: false }) },
    );
    expect(reasons).toHaveLength(3);
  });
});

test.describe("reading ffprobe's answer", () => {
  test("size, length and streams", () => {
    expect(factsFromFfprobe({ format: { duration: "8.000000" }, streams: [{ codec_type: "video", width: 480, height: 270 }, { codec_type: "audio" }] })).toEqual({ durationSeconds: 8, width: 480, height: 270, hasVideo: true, hasAudio: true });
  });
  test("a rotation tag of 90 or 270 swaps width and height, from either place it can be", () => {
    const base = { format: { duration: "3" } };
    expect(factsFromFfprobe({ ...base, streams: [{ codec_type: "video", width: 1920, height: 1080, tags: { rotate: "90" } }] })).toMatchObject({ width: 1080, height: 1920 });
    expect(factsFromFfprobe({ ...base, streams: [{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }] })).toMatchObject({ width: 1080, height: 1920 });
    expect(factsFromFfprobe({ ...base, streams: [{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }] })).toMatchObject({ width: 1920, height: 1080 });
  });
  test("audio only has no picture; garbage has nothing", () => {
    expect(factsFromFfprobe({ format: { duration: "6.1" }, streams: [{ codec_type: "audio" }] })).toEqual({ durationSeconds: 6.1, width: 0, height: 0, hasVideo: false, hasAudio: true });
    expect(factsFromFfprobe({})).toEqual({ durationSeconds: 0, width: 0, height: 0, hasVideo: false, hasAudio: false });
  });
});

test("the files a timeline needs are listed once each", () => {
  const checked = checkSpec(finalSpec());
  if (!checked.ok) throw new Error(checked.errors.join(";"));
  expect(inputFilesOf(checked.timeline).sort()).toEqual(["clips/a.mp4", "logo.png"]);
  const props = validateProps("final", { aspect: "16:9", clips: [{ source: SOURCE }, { source: SOURCE }], music: { file: "m.mp3", durationSeconds: 3 } });
  if (!props.ok) throw new Error("bad");
  expect(inputFilesOf(toTimeline("final", props.value)).sort()).toEqual(["clips/a.mp4", "m.mp3"]);
});
