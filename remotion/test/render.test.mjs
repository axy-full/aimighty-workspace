// Render tests: the real renderer, our compositions, a few small frames at fixed times, on CPU.
// Run through the heavy gate:  ~/ops/heavy.sh nice -n 10 node --test --test-concurrency=1 remotion/test/render.test.mjs
// They need `npm ci` and `npm run bundle` inside remotion/ first, and skip with a message when those are missing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  for (const [format, profile] of [["prores-422", "2"], ["prores-422-hq", "3"]]) {
    test(`${format}: a real .mov of the right codec, profile ${profile}, 10-bit 4:2:2`, () => {
      const card = { title: "Mezzanine", theme: { background: "#102030", foreground: "#f0e0d0", accent: "#ff6b35" }, durationSeconds: 1 };
      const { dir, status, stderr, result } = run(`mezzanine-${format}`, { version: 1, composition: "title-card", props: { aspect: "16:9", scale: 0.25, card }, output: { video: true, format } });
      assert.equal(status, 0, stderr);
      assert.deepEqual(result.files.map((f) => [f.name, f.format, f.mime]), [["export.mov", format, "video/quicktime"]]);
      const info = execFileSync(path.join(compositor, "ffprobe"), ["-hide_banner", "-loglevel", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,width,height", "-of", "json", path.join(dir, "output", "export.mov")], { encoding: "utf8" });
      const stream = JSON.parse(info).streams[0];
      assert.equal(stream.codec_name, "prores");
      assert.equal(String(stream.profile), profile, info);
      assert.equal(stream.pix_fmt, "yuv422p10le");
      assert.deepEqual([stream.width, stream.height], [480, 270]);
    });
  }

  test("narrated assembly: while a voice line plays, the music and the clip's own sound drop to the duck share, and come back after", () => {
    const sine = (freq, seconds) => execFileSync(path.join(compositor, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-f", "mp3", "-"], { maxBuffer: 1 << 24 });
    const clip = { source: SOURCE, trim: { startSeconds: 0, endSeconds: 6 }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } };
    const { dir, status, stderr, result } = run(
      "narrated",
      { version: 1, composition: "final", props: { aspect: "16:9", fps: 30, scale: 0.25, title: null, end: null, clips: [clip], captionStyle: null, music: { file: "bed.mp3", durationSeconds: 9, volume: 0.5 }, voiceover: [{ file: "voice.mp3", durationSeconds: 2, startSeconds: 2.5, volume: 1 }], duck: 0.3 } },
      { files: { "bed.mp3": sine(220, 9), "voice.mp3": sine(880, 2) } },
    );
    assert.equal(status, 0, stderr);
    assert.equal(result.durationInFrames, 180);
    const pcm = execFileSync(path.join(compositor, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, "output", "export.mp4"), "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", "-f", "wav", "-"], { maxBuffer: 1 << 26 });
    /* A WAV: skip to the "data" chunk, then 16-bit little-endian samples. */
    const dataAt = pcm.indexOf("data") + 8;
    const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset + dataAt, pcm.byteOffset + dataAt + Math.floor((pcm.length - dataAt) / 2) * 2));
    /* The amplitude of one tone in a window of the finished audio (Goertzel). */
    const level = (freq, fromSeconds, toSeconds) => {
      const part = samples.subarray(Math.round(fromSeconds * 8000), Math.round(toSeconds * 8000));
      const w = (2 * Math.PI * freq) / 8000;
      let s1 = 0, s2 = 0;
      for (const x of part) { const s0 = x + 2 * Math.cos(w) * s1 - s2; s2 = s1; s1 = s0; }
      return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / part.length;
    };
    const musicBefore = level(220, 0.3, 1.6), musicDuring = level(220, 2.9, 4.0), musicAfter = level(220, 4.9, 5.4);
    const clipBefore = level(440, 0.3, 1.6), clipDuring = level(440, 2.9, 4.0);
    assert.ok(musicBefore > 50, `the music is there before the voice (${musicBefore})`);
    assert.ok(Math.abs(musicDuring / musicBefore - 0.3) < 0.08, `music during the voice is about 0.3 of before: ${musicDuring / musicBefore}`);
    assert.ok(clipBefore > 50 && Math.abs(clipDuring / clipBefore - 0.3) < 0.08, `the clip's sound ducks too: ${clipDuring / clipBefore}`);
    assert.ok(level(880, 2.9, 4.0) > 100, "the voice is heard, undimmed");
    assert.ok(level(880, 0.3, 1.6) < 20 && level(880, 5.0, 5.8) < 20, "and only where it is placed");
    assert.ok(musicAfter / musicBefore > 0.85, `the music is back after the voice: ${musicAfter / musicBefore}`);
  });

  test("H.265 is refused before anything renders, whatever it is called", () => {
    const card = { title: "Mezzanine", theme: { background: "#102030", foreground: "#f0e0d0", accent: "#ff6b35" }, durationSeconds: 1 };
    const refused = run("h265-refused", { version: 1, composition: "title-card", props: { aspect: "16:9", scale: 0.25, card }, output: { video: true, format: "h265" } });
    assert.equal(refused.status, 2);
    assert.deepEqual(refused.result.errors, ["spec.output.format: H.265 is not available."]);
  });

  test("a windowed constant-rate copy plus offsetSeconds: the same source second renders the same picture from the copy as from the original, and a frame 0.3 s away does not", async () => {
    const copy = path.join(base, "windowed.mp4");
    /* The conform pre-pass's own ffmpeg flags (node/conform.ts): only 1.7 s to 5.2 s of the source, starting at zero (the export tells the renderer where with `offsetSeconds`). */
    execFileSync(path.join(compositor, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-format_whitelist", "mov,mp4,m4a,matroska,webm", "-ss", "1.7", "-t", "3.5", "-i", path.join(sampleDir, "sample.mp4"), "-map", "0:v:0", "-r", "30", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", copy]);
    const { selectComposition, renderStill } = await import(path.join(root, "node_modules", "@remotion", "renderer", "dist", "index.js"));
    const common = { browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || undefined, chromeMode: "headless-shell", chromiumOptions: { gl: "swangle" }, logLevel: "error" };
    const still = async (name, file, startSeconds, offsetSeconds = 0) => {
      const serve = path.join(base, `serve-${name}`);
      cpSync(path.join(root, "build", "bundle"), serve, { recursive: true });
      mkdirSync(path.join(serve, "public", "input"), { recursive: true });
      cpSync(file, path.join(serve, "public", "input", "sample.mp4"));
      const props = { aspect: "16:9", fps: 30, scale: 0.25, title: null, end: null, music: null, captionStyle: null, clips: [{ source: { ...SOURCE, hasAudio: false, ...(offsetSeconds ? { offsetSeconds } : {}) }, trim: { startSeconds, endSeconds: startSeconds + 1.5 }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }] };
      const comp = await selectComposition({ serveUrl: serve, id: "final", inputProps: props, ...common });
      const output = path.join(base, `${name}.png`);
      await renderStill({ serveUrl: serve, composition: comp, inputProps: props, frame: 15, output, imageFormat: "png", overwrite: true, ...common });
      return decodePng(readFileSync(output));
    };
    const original = await still("orig", path.join(sampleDir, "sample.mp4"), 2.5);
    const windowed = await still("win", copy, 2.5, 1.7);
    const earlier = await still("early", path.join(sampleDir, "sample.mp4"), 2.2);
    const whole = { x0: 0, y0: 0, x1: original.width, y1: original.height };
    const aligned = regionDiff(original, windowed, whole);
    const misaligned = regionDiff(original, earlier, whole);
    /* The copy is a re-encode (CRF 14), so it is not bit-identical; a frame 0.3 s away differs about four times as much (measured: 4.7 against 19.2). */
    assert.ok(aligned < 8, `the copy renders the same second (mean difference ${aligned})`);
    assert.ok(misaligned > aligned * 3, `and a frame 0.3 s away differs far more (${misaligned} against ${aligned})`);
  });

  test("sound stays in sync through the windowed copy: a tone that changes at a known second changes at the same moment of the render from the original and from the copy", async () => {
    const C = (name) => path.join(compositor, name);
    /* Our own source: the sample picture with a 440 Hz tone until 4.0 s and an 880 Hz tone after it, as 16-bit mono WAV bytes. */
    const rate = 8000, seconds = 8;
    const pcm = Buffer.alloc(rate * seconds * 2);
    for (let i = 0; i < rate * seconds; i++) pcm.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * (i / rate < 4 ? 440 : 880) * i) / rate)), i * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const wav = path.join(base, "tones.wav");
    writeFileSync(wav, Buffer.concat([header, pcm]));
    const source = path.join(base, "tone-source.mp4");
    execFileSync(C("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(sampleDir, "sample.mp4"), "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", source]);
    /* The conform pre-pass's own flags: only 3 s to 6 s, starting at zero (Remotion renders no sound from a copy that keeps the source's clock). */
    const windowed = path.join(base, "tone-windowed.mp4");
    execFileSync(C("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-format_whitelist", "mov,mp4,m4a,matroska,webm", "-ss", "3", "-t", "3", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-r", "30", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", windowed]);
    const { selectComposition, renderMedia } = await import(path.join(root, "node_modules", "@remotion", "renderer", "dist", "index.js"));
    const common = { browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || undefined, chromeMode: "headless-shell", chromiumOptions: { gl: "swangle" }, logLevel: "error" };
    /* Source seconds 3.5 to 5.5 of the clip, with its sound: the tone changes 0.5 s in. */
    const render = async (name, file, offsetSeconds = 0) => {
      const serve = path.join(base, `serve-${name}`);
      cpSync(path.join(root, "build", "bundle"), serve, { recursive: true });
      mkdirSync(path.join(serve, "public", "input"), { recursive: true });
      cpSync(file, path.join(serve, "public", "input", "sample.mp4"));
      const props = { aspect: "16:9", fps: 30, scale: 0.25, title: null, end: null, music: null, captionStyle: null, clips: [{ source: { ...SOURCE, hasAudio: true, ...(offsetSeconds ? { offsetSeconds } : {}) }, trim: { startSeconds: 3.5, endSeconds: 5.5 }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }] };
      const comp = await selectComposition({ serveUrl: serve, id: "final", inputProps: props, ...common });
      const output = path.join(base, `${name}.mp4`);
      await renderMedia({ serveUrl: serve, composition: comp, inputProps: props, outputLocation: output, codec: "h264", audioCodec: "aac", overwrite: true, concurrency: 1, ...common });
      const out = execFileSync(C("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-i", output, "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", "-f", "wav", "-"], { maxBuffer: 1 << 26 });
      const at = out.indexOf("data") + 8;
      return new Int16Array(out.buffer.slice(out.byteOffset + at, out.byteOffset + at + Math.floor((out.length - at) / 2) * 2));
    };
    const tone = (samples, freq, from, to) => {
      const part = samples.subarray(Math.round(from * 8000), Math.round(to * 8000));
      const w = (2 * Math.PI * freq) / 8000;
      let s1 = 0, s2 = 0;
      for (const x of part) { const s0 = x + 2 * Math.cos(w) * s1 - s2; s2 = s1; s1 = s0; }
      return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / part.length;
    };
    /* When the tone changes: the first 50 ms step in which 880 Hz is stronger than 440 Hz. */
    const changeAt = (samples) => { for (let t = 0.1; t < 1.8; t += 0.05) if (tone(samples, 880, t, t + 0.05) > tone(samples, 440, t, t + 0.05)) return t; return null; };
    const original = await render("tone-orig", source);
    const copy = await render("tone-win", windowed, 3);
    const a = changeAt(original), b = changeAt(copy);
    assert.ok(a !== null && Math.abs(a - 0.5) < 0.12, `the tone changes about 0.5 s in, from the original (${a})`);
    assert.ok(b !== null && Math.abs(b - 0.5) < 0.12, `and from the windowed copy (${b})`);
    assert.ok(Math.abs(a - b) < 0.1, `within 0.1 s of each other: ${a} against ${b}`);
    assert.ok(tone(copy, 440, 0.1, 0.4) > 3 * tone(copy, 880, 0.1, 0.4) && tone(copy, 880, 0.7, 1.0) > 3 * tone(copy, 440, 0.7, 1.0), "the right tone before and after");
  });

  for (const cover of ["treatment", "pitch"]) {
    test(`film deck, ${cover} cover: the real browser prints the deck page to a three-page slide PDF`, () => {
      /* On the build droplet the Remotion-downloaded shell (Chromium 149) hangs on --print-to-pdf (its network service crashes); Playwright's headless shell (REMOTION_BROWSER_EXECUTABLE set to the chrome-headless-shell inside Playwright's chromium_headless_shell folder) prints the same page. Whether the worker image's own shell prints is checked on its first real deploy. */
      /* The page is lib/pdf/html.ts's own output for a small film board (three pages: cover, the idea, the brief), saved as a fixture. */
      const html = readFileSync(path.join(root, "test", "pdf-check", `film-${cover}.html`));
      /* The worker image keeps the typeface beside its command; here it is the bundle's own public folder. */
      process.env.REMOTION_FONTS_DIR ??= path.join(root, "public", "fonts");
      const spec = { version: 1, composition: "pdf", pdf: { pages: 3, trimMm: { width: 338.667, height: 190.5 }, bleedMm: 0, images: [] } };
      const { dir, status, stderr, result } = run(`film-deck-${cover}`, spec, { withSample: false, files: { "deck.html": html } });
      assert.equal(status, 0, stderr);
      assert.equal(result?.ok, true);
      const pdf = readFileSync(path.join(dir, "output", "deck.pdf"));
      const text = pdf.toString("latin1");
      assert.equal(text.slice(0, 5), "%PDF-");
      assert.equal((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length, 3, "three pages, one for each section of the deck");
      const box = text.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
      assert.ok(box && Math.abs(Number(box[1]) - (338.667 * 72) / 25.4) < 2 && Math.abs(Number(box[2]) - (190.5 * 72) / 25.4) < 2, `a 16:9 slide, not ${box?.[1]} x ${box?.[2]}`);
    });
  }

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
