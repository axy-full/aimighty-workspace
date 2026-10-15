import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSpec, runExport, type Renderer } from "../../remotion/node/export";
import { subtitleCuesOf, subtitleText, toSrt, toVtt, wrapLines, type Cue, type CompositionId, type Timeline } from "../../remotion/src/lib";
import type { Prober } from "../../remotion/node/probe";

/* Sidecar SRT and VTT from the same cue data as the burned-in captions: pure text, placed on the finished video's clock. */

const SOURCE = { file: "clips/a.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true };
const cue = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });
const REFRAME = { mode: "fill", focusX: 0.5, focusY: 0.5 };
const clip = (cues: Cue[], trim = { startSeconds: 0, endSeconds: 4 }) => ({ source: SOURCE, trim, cues, reframe: REFRAME });
const timelineOf = (id: CompositionId, props: unknown): Timeline => {
  const checked = checkSpec({ version: 1, composition: id, props, output: { subtitles: ["srt"] } });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return checked.timeline;
};
const finalProps = (extra: Record<string, unknown> = {}) => ({ aspect: "16:9", scale: 0.25, title: { title: "T", durationSeconds: 1 }, captionStyle: null, end: null, music: null, clips: [clip([cue(500, 2500, "Hello there")]), clip([cue(1000, 3000, "Second clip")])], ...extra });

test("SubRip: a counter, HH:MM:SS,mmm --> HH:MM:SS,mmm, the text, a blank line between cues", () => {
  expect(toSrt([cue(0, 1500, "One"), cue(3_661_007, 3_662_000, "Two")])).toBe("1\n00:00:00,000 --> 00:00:01,500\nOne\n\n2\n01:01:01,007 --> 01:01:02,000\nTwo\n");
  expect(toSrt([])).toBe("");
});

test("WebVTT: the WEBVTT header, dots in the stamps, and markup characters as entities", () => {
  expect(toVtt([cue(0, 1500, "Tom & <Jerry>")])).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nTom &amp; &lt;Jerry&gt;\n");
  expect(toSrt([cue(0, 1500, "Tom & <Jerry>")])).toContain("Tom & <Jerry>");
  expect(subtitleText("srt", [cue(0, 1000, "x")])).toBe(toSrt([cue(0, 1000, "x")]));
  expect(subtitleText("vtt", [cue(0, 1000, "x")])).toBe(toVtt([cue(0, 1000, "x")]));
});

test("long text is wrapped at 42 characters on spaces; a long word stays whole; newlines and runs of spaces collapse", () => {
  expect(wrapLines("Every great film starts with one idea and a small team")).toEqual(["Every great film starts with one idea and", "a small team"]);
  expect(wrapLines("a".repeat(50))).toEqual(["a".repeat(50)]);
  expect(wrapLines("one\n\ntwo   three")).toEqual(["one two three"]);
});

test("the cues sit on the finished video's clock: a clip's local cues plus where the clip starts, whether or not captions are burned in", () => {
  const t = timelineOf("final", finalProps());
  const cues = subtitleCuesOf(t);
  /* title 1 s, then clip 1 (4 s) from 1 s, clip 2 from 5 s */
  expect(cues).toEqual([cue(1500, 3500, "Hello there"), cue(6000, 8000, "Second clip")]);
  const clips = t.items.filter((item) => item.kind === "clip");
  expect(clips.every((item) => item.kind === "clip" && item.cues.length === 0)).toBe(true);
  expect(clips.every((item) => item.kind === "clip" && item.subtitleCues.length === 1)).toBe(true);
  const burned = timelineOf("final", finalProps({ captionStyle: "bold" }));
  expect(subtitleCuesOf(burned)).toEqual(cues);
  expect(burned.items.filter((item) => item.kind === "clip").every((item) => item.kind === "clip" && item.cues.length === 1)).toBe(true);
});

test("a trim moves the cues with it, and a cue that was cut away is not in the file", () => {
  const t = timelineOf("final", finalProps({ title: null, clips: [clip([cue(500, 1500, "Cut away"), cue(3000, 5000, "Kept")], { startSeconds: 2, endSeconds: 6 })] }));
  expect(subtitleCuesOf(t)).toEqual([cue(1000, 3000, "Kept")]);
});

test("a cutdown's source-time cues land in the cut, and the reframe composition carries its cues too", () => {
  const cut = timelineOf("cutdown", { aspect: "16:9", scale: 0.25, source: SOURCE, targetSeconds: 6, keep: [{ startSeconds: 2, endSeconds: 5 }], cues: [cue(2500, 4000, "Inside the keep"), cue(9000, 9900, "Late")], captionStyle: null, reframe: REFRAME });
  expect(subtitleCuesOf(cut).map((c) => c.text)).toContain("Inside the keep");
  const reframe = timelineOf("reframe", { aspect: "9:16", scale: 0.25, clip: clip([cue(500, 2500, "Hello there")]) });
  expect(subtitleCuesOf(reframe)).toEqual([cue(500, 2500, "Hello there")]);
});

test("the spec: subtitles is a list of srt and/or vtt (any case, once each); anything else is refused; no cues is refused; a card has none", () => {
  const spec = (subtitles: unknown, props: unknown = finalProps(), composition = "final") => checkSpec({ version: 1, composition, props, output: { video: false, subtitles } });
  expect(spec(["srt", "VTT", "srt"])).toMatchObject({ ok: true, subtitles: ["srt", "vtt"], video: false });
  for (const bad of [[], ["ass"], ["srt", "vtt", "ttml"], "srt", null, [3]]) {
    expect(spec(bad)).toMatchObject({ ok: false, code: "spec_invalid" });
    expect((spec(bad) as { errors: string[] }).errors[0]).toBe("spec.output.subtitles: must be a list of srt and/or vtt");
  }
  expect(spec(["srt"], finalProps({ clips: [clip([])] }))).toEqual({ ok: false, code: "spec_invalid", errors: ["spec.output.subtitles: the export has no caption text (no cues) to write"] });
  expect(spec(["srt"], { aspect: "16:9", scale: 0.25, card: { title: "Hi", durationSeconds: 1 } }, "title-card")).toMatchObject({ ok: false });
  expect(checkSpec({ version: 1, composition: "final", props: finalProps(), output: { video: false } })).toEqual({ ok: false, code: "spec_invalid", errors: ["spec.output: asks for nothing"] });
});

test.describe("the export command writes the files", () => {
  let base: string;
  test.beforeEach(() => { base = mkdtempSync(path.join(os.tmpdir(), "remotion-subtitles-")); });
  test.afterEach(() => rmSync(base, { recursive: true, force: true }));
  const refusing: Renderer & { calls: string[] } = { calls: [], prepare: async () => { refusing.calls.push("prepare"); }, selectComposition: async () => { refusing.calls.push("select"); throw new Error("no"); }, renderVideo: async () => { refusing.calls.push("video"); }, renderStill: async () => { refusing.calls.push("still"); } };
  const prober: Prober = { probe: async () => { throw new Error("not asked"); } };
  const args = (output: unknown, renderer: Renderer = refusing) => ({ prober, spec: { version: 1, composition: "final", props: finalProps(), output }, inputDir: path.join(base, "input"), outputDir: path.join(base, "output"), bundleDir: path.join(base, "bundle"), workDir: path.join(base, "work"), renderer });

  test("subtitles alone: no input file, no probe, no renderer, no work folder; the files and result.json are written", async () => {
    refusing.calls.length = 0;
    const result = await runExport(args({ video: false, subtitles: ["srt", "vtt"] }));
    expect(result).toMatchObject({ ok: true, composition: "final", durationInFrames: 270 });
    if (!result.ok) return;
    expect(result.files.map((f) => [f.name, f.kind, f.format, f.mime])).toEqual([["subtitles.srt", "subtitle", "srt", "application/x-subrip"], ["subtitles.vtt", "subtitle", "vtt", "text/vtt"]]);
    expect(readFileSync(path.join(base, "output", "subtitles.srt"), "utf8")).toBe("1\n00:00:01,500 --> 00:00:03,500\nHello there\n\n2\n00:00:06,000 --> 00:00:08,000\nSecond clip\n");
    expect(readFileSync(path.join(base, "output", "subtitles.vtt"), "utf8")).toMatch(/^WEBVTT\n\n1\n00:00:01\.500 --> 00:00:03\.500\nHello there\n/);
    expect(JSON.parse(readFileSync(path.join(base, "output", "result.json"), "utf8")).files).toHaveLength(2);
    expect(refusing.calls).toEqual([]);
    expect(existsSync(path.join(base, "work"))).toBe(false);
    expect(readdirSync(path.join(base, "output")).sort()).toEqual(["result.json", "subtitles.srt", "subtitles.vtt"]);
  });

  test("with a video the subtitles come with it, after the video and stills, from the same timeline", async () => {
    mkdirSync(path.join(base, "input", "clips"), { recursive: true });
    mkdirSync(path.join(base, "bundle"), { recursive: true });
    writeFileSync(path.join(base, "bundle", "index.html"), "<html></html>");
    writeFileSync(path.join(base, "input", "clips", "a.mp4"), "video");
    const probing: Prober = { probe: async () => ({ durationSeconds: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true }) };
    const planned = checkSpec(args({}).spec);
    if (!planned.ok) throw new Error(JSON.stringify(planned));
    const timeline = planned.timeline;
    const renderer: Renderer = {
      prepare: async () => {},
      selectComposition: async ({ id, inputProps }) => ({ id, width: timeline.width, height: timeline.height, fps: timeline.fps, durationInFrames: timeline.durationInFrames, props: inputProps }),
      renderVideo: async ({ outputLocation }) => writeFileSync(outputLocation, "mp4"),
      renderStill: async ({ outputLocation }) => writeFileSync(outputLocation, "png"),
    };
    const result = await runExport({ ...args({ video: true, stills: [0], subtitles: ["vtt"] }, renderer), prober: probing });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.files.map((f) => f.name)).toEqual(["export.mp4", "still-0.png", "subtitles.vtt"]);
  });
});
