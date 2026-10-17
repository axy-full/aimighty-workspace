// Render tests: the real renderer, our compositions, a few small frames at fixed times, on CPU.
// Run through the heavy gate:  ~/ops/heavy.sh nice -n 10 node --test --test-concurrency=1 remotion/test/render.test.mjs
// They need `npm ci` and `npm run bundle` inside remotion/ first, and skip with a message when those are missing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { countNear, decodePng, regionDiff } from "./png.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "build", "cli.mjs");
const compositor = path.join(root, "node_modules", "@remotion", "compositor-linux-x64-gnu");
const ready = existsSync(cli) && existsSync(path.join(compositor, "ffmpeg"));
const skip = ready ? false : "run `npm ci && npm run bundle` in remotion/ first";

const base = mkdtempSync(path.join(os.tmpdir(), "remotion-test-"));
let sampleDir;

/** Run the fixed export command in a fresh session folder; returns the folder, the exit code and result.json. */
function run(name, spec, { files = {}, withSample = true } = {}) {
  const dir = path.join(base, name);
  mkdirSync(path.join(dir, "input"), { recursive: true });
  writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  if (withSample) writeFileSync(path.join(dir, "input", "sample.mp4"), readFileSync(path.join(sampleDir, "sample.mp4")));
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, "input", file), content);
  const result = spawnSync("node", [cli], { cwd: dir, env: { ...process.env, REMOTION_CONCURRENCY: "1" }, encoding: "utf8", timeout: 240_000 });
  const resultFile = path.join(dir, "output", "result.json");
  return { dir, status: result.status, stderr: result.stderr, result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null };
}

const probe = (file) => {
  const out = execFileSync(path.join(compositor, "ffprobe"), ["-hide_banner", "-loglevel", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(out).streams;
};

const SOURCE = { file: "sample.mp4", durationSeconds: 8, width: 480, height: 270, hasAudio: true };
const CUES = [{ startMs: 1000, endMs: 3000, text: "Every great film starts with one idea" }];
const stillOf = (dir, frame) => decodePng(readFileSync(path.join(dir, "output", `still-${frame}.png`)));
const stills = (frames) => ({ video: false, stills: frames });
const bottom = (image) => ({ x0: 0, y0: Math.floor(image.height * 0.6), x1: image.width, y1: image.height });

describe("Remotion compositions (real renderer)", { skip }, () => {
  before(() => {
    // Our own sample clip: the fixture composition plus a sine tone. No outside media.
    sampleDir = path.join(base, "sample");
    mkdirSync(sampleDir, { recursive: true });
    const made = run("sample-video", { version: 1, composition: "fixture-clip", props: { aspect: "16:9", fps: 30, scale: 0.25, durationSeconds: 8, label: "CLIP" } }, { withSample: false });
    assert.equal(made.status, 0, made.stderr);
    execFileSync(path.join(compositor, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-i", path.join(made.dir, "output", "export.mp4"), "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "copy", "-c:a", "aac", "-shortest", path.join(sampleDir, "sample.mp4")]);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  test("title card: theme background, centred text, the right size", () => {
    const { dir, status, stderr, result } = run("title", { version: 1, composition: "title-card", props: { aspect: "16:9", scale: 0.25, card: { title: "Summer launch", subtitle: "Three shots", theme: { background: "#102030", foreground: "#f0e0d0", accent: "#ff6b35" }, durationSeconds: 2 } }, output: stills([30]) });
    assert.equal(status, 0, stderr);
    assert.equal(result.ok, true);
    const image = stillOf(dir, 30);
    assert.deepEqual([image.width, image.height], [480, 270]);
    assert.deepEqual(image.pixel(3, 3), [0x10, 0x20, 0x30]);
    const middle = { x0: 60, y0: 60, x1: 420, y1: 210 };
    assert.ok(countNear(image, middle, [0xf0, 0xe0, 0xd0], 40) > 300, "the title is drawn in the foreground colour");
    assert.ok(countNear(image, middle, [0xff, 0x6b, 0x35], 40) > 20, "the accent bar is drawn");
    // The card fades in: frame 0 is background only.
    const first = run("title-0", { version: 1, composition: "title-card", props: { aspect: "16:9", scale: 0.25, card: { title: "Summer launch", theme: { background: "#102030", foreground: "#f0e0d0", accent: "#ff6b35" }, durationSeconds: 2 } }, output: stills([0]) });
    assert.equal(countNear(stillOf(first.dir, 0), middle, [0xf0, 0xe0, 0xd0], 40), 0);
  });

  test("end card: headline, call-to-action pill in the accent colour", () => {
    const { dir, status, stderr } = run("end", { version: 1, composition: "end-card", props: { aspect: "9:16", scale: 0.25, card: { headline: "See it in cinemas", callToAction: "Book now", line: "example.com", theme: { background: "#101820", foreground: "#f4f1ea", accent: "#ff6b35" }, durationSeconds: 3 } }, output: stills([45]) });
    assert.equal(status, 0, stderr);
    const image = stillOf(dir, 45);
    assert.deepEqual([image.width, image.height], [270, 480]);
    assert.ok(countNear(image, { x0: 0, y0: 0, x1: 270, y1: 480 }, [0xff, 0x6b, 0x35], 24) > 400, "the pill is drawn");
  });

  test("captions: drawn only while a cue is on screen, and clear of the same frame without them", () => {
    const props = (extra) => ({ aspect: "16:9", fps: 30, scale: 0.5, clip: { source: SOURCE, cues: CUES, reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }, ...extra });
    const withCaptions = run("cap", { version: 1, composition: "captions", props: props({ captionStyle: "bold" }), output: stills([60, 150]) });
    const without = run("cap-none", { version: 1, composition: "reframe", props: { aspect: "16:9", fps: 30, scale: 0.5, clip: { source: SOURCE, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } } }, output: stills([60, 150]) });
    assert.equal(withCaptions.status, 0, withCaptions.stderr);
    assert.equal(without.status, 0, without.stderr);
    const inCue = stillOf(withCaptions.dir, 60); // 2.0 s, inside 1.0-3.0 s
    const outOfCue = stillOf(withCaptions.dir, 150); // 5.0 s
    const plain60 = stillOf(without.dir, 60);
    const plain150 = stillOf(without.dir, 150);
    assert.ok(regionDiff(inCue, plain60, bottom(inCue)) > 3, "the caption changes the lower part of the frame");
    assert.ok(regionDiff(outOfCue, plain150, bottom(outOfCue)) < 0.5, "no cue, no caption");
    assert.ok(regionDiff(inCue, plain60, { x0: 0, y0: 0, x1: inCue.width, y1: Math.floor(inCue.height * 0.4) }) < 0.5, "the top of the frame is untouched");
  });

  test("reframe 16:9 to 9:16: the right size, and the focus point moves the crop", () => {
    const spec = (focusX) => ({ version: 1, composition: "reframe", props: { aspect: "9:16", fps: 30, scale: 0.25, clip: { source: SOURCE, cues: [], reframe: { mode: "fill", focusX, focusY: 0.5 } } }, output: stills([100]) });
    const left = run("rf-left", spec(0));
    const right = run("rf-right", spec(1));
    assert.equal(left.status, 0, left.stderr);
    const a = stillOf(left.dir, 100);
    const b = stillOf(right.dir, 100);
    assert.deepEqual([a.width, a.height], [270, 480]);
    assert.ok(regionDiff(a, b, { x0: 0, y0: 0, x1: 270, y1: 480 }) > 3, "different crops of the picture");
    const fit = run("rf-fit", { version: 1, composition: "reframe", props: { aspect: "9:16", fps: 30, scale: 0.25, clip: { source: SOURCE, cues: [], reframe: { mode: "fit", focusX: 0.5, focusY: 0.5 } } }, output: stills([100]) });
    assert.equal(fit.status, 0, fit.stderr);
    const f = stillOf(fit.dir, 100);
    assert.ok(regionDiff(f, a, { x0: 0, y0: 0, x1: 270, y1: 100 }) > 3, "fit shows the blurred backdrop above the picture, not the crop");
  });

  test("cutdown 6 s: exactly 180 frames, with audio, from an 8 s source", () => {
    const { dir, status, stderr, result } = run("cut", { version: 1, composition: "cutdown", props: { aspect: "16:9", fps: 30, scale: 0.25, source: SOURCE, targetSeconds: 6, keep: [], cues: CUES, captionStyle: "clean", reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } } });
    assert.equal(status, 0, stderr);
    assert.equal(result.durationInFrames, 180);
    const streams = probe(path.join(dir, "output", "export.mp4"));
    const video = streams.find((s) => s.codec_type === "video");
    assert.deepEqual([video.width, video.height], [480, 270]);
    assert.ok(Math.abs(Number(video.duration) - 6) < 0.1, `video is ${video.duration} s`);
    assert.ok(streams.some((s) => s.codec_type === "audio"), "the audio is kept");
  });

  test("cutdown captions land in the right piece: a cue at 6.0-7.5 s of the source shows at 4.0-5.5 s of the cut", () => {
    const props = (captionStyle) => ({ aspect: "16:9", fps: 30, scale: 0.5, source: SOURCE, targetSeconds: 6, keep: [], cues: [{ startMs: 6000, endMs: 7500, text: "Near the end" }], captionStyle, reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } });
    const frames = [30, 135]; // 1.0 s (first piece, no cue) and 4.5 s (second piece, cue)
    const on = run("cut-cap-on", { version: 1, composition: "cutdown", props: props("clean"), output: stills(frames) });
    const off = run("cut-cap-off", { version: 1, composition: "cutdown", props: props(null), output: stills(frames) });
    assert.equal(on.status, 0, on.stderr);
    assert.equal(off.status, 0, off.stderr);
    assert.ok(regionDiff(stillOf(on.dir, 135), stillOf(off.dir, 135), bottom(stillOf(on.dir, 135))) > 3, "caption inside the second piece");
    assert.ok(regionDiff(stillOf(on.dir, 30), stillOf(off.dir, 30), bottom(stillOf(on.dir, 30))) < 0.5, "no caption in the first piece");
  });

  test("final: title, a trimmed clip with captions, an end card and music make one MP4 of the summed length", () => {
    const tone = execFileSync(path.join(compositor, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-f", "mp3", "-"], { maxBuffer: 1 << 24 });
    const { dir, status, stderr, result } = run(
      "final",
      {
        version: 1,
        composition: "final",
        props: {
          aspect: "16:9",
          fps: 30,
          scale: 0.25,
          title: { title: "Title", theme: { background: "#000000", foreground: "#ffffff", accent: "#ffd400" }, durationSeconds: 1 },
          clips: [{ source: SOURCE, trim: { startSeconds: 1, endSeconds: 3 }, cues: CUES, reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }],
          captionStyle: "karaoke",
          end: { headline: "The end", theme: { background: "#000000", foreground: "#ffffff", accent: "#ffd400" }, durationSeconds: 1 },
          music: { file: "music.mp3", durationSeconds: 6, volume: 0.3 },
        },
      },
      { files: { "music.mp3": tone } },
    );
    assert.equal(status, 0, stderr);
    assert.equal(result.durationInFrames, 120);
    const streams = probe(path.join(dir, "output", "export.mp4"));
    assert.ok(Math.abs(Number(streams.find((s) => s.codec_type === "video").duration) - 4) < 0.1);
    assert.ok(streams.some((s) => s.codec_type === "audio"));
  });

  test("refusals: a bad spec exits 2, a missing file 3, and a path that climbs out is refused before anything runs", () => {
    const bad = run("bad", { version: 1, composition: "title-card", props: { aspect: "4:3", card: {} } });
    assert.equal(bad.status, 2);
    assert.equal(bad.result.code, "spec_invalid");
    const missing = run("missing", { version: 1, composition: "reframe", props: { aspect: "9:16", clip: { source: { ...SOURCE, file: "nothere.mp4" } } } });
    assert.equal(missing.status, 3);
    const climb = run("climb", { version: 1, composition: "reframe", props: { aspect: "9:16", clip: { source: { ...SOURCE, file: "../sample/sample.mp4" } } } });
    assert.equal(climb.status, 2);
    // ffprobe reads the file: a declared size or length it contradicts is refused, not rendered.
    const wrongSize = run("wrong-size", { version: 1, composition: "reframe", props: { aspect: "9:16", scale: 0.25, clip: { source: { ...SOURCE, width: 1920, height: 1080 } } }, output: stills([0]) });
    assert.equal(wrongSize.status, 3);
    assert.equal(wrongSize.result.code, "input_mismatch");
    assert.match(wrongSize.result.errors[0], /is 480x270, the request says 1920x1080/);
    assert.equal(existsSync(path.join(wrongSize.dir, "output", "still-0.png")), false);
    const wrongLength = run("wrong-length", { version: 1, composition: "reframe", props: { aspect: "9:16", scale: 0.25, clip: { source: { ...SOURCE, durationSeconds: 7 } } }, output: stills([0]) });
    assert.equal(wrongLength.status, 3);
    assert.match(wrongLength.result.errors[0], /8\.00 s, the request says 7 s/);
    const notMedia = run("not-media", { version: 1, composition: "reframe", props: { aspect: "9:16", scale: 0.25, clip: { source: { ...SOURCE, file: "junk.mp4" } } }, output: stills([0]) }, { files: { "junk.mp4": "not a video at all" } });
    assert.equal(notMedia.status, 3);
    assert.match(notMedia.result.errors[0], /could not be read as media/);
    const remote = run("remote", { version: 1, composition: "reframe", props: { aspect: "9:16", clip: { source: { ...SOURCE, file: "https://example.com/a.mp4" } } } });
    assert.equal(remote.status, 2);
  });
});
