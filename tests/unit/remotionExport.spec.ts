import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSpec, inputFilesOf, runExport, type CompositionInfo, type Renderer } from "../../remotion/node/export";
import { toTimeline, validateProps, type CompositionId } from "../../remotion/src/lib";

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

test.describe("the export command with a fake renderer", () => {
  test("renders a video, hands the renderer the validated props, and writes result.json", async () => {
    const { renderer, calls, seenFiles } = fakeRenderer();
    const progress: number[] = [];
    const result = await runExport(args(finalSpec(), renderer, { concurrency: 3, onProgress: (done: number) => progress.push(done) }));
    expect(result).toMatchObject({ ok: true, composition: "final", width: 270, height: 480, fps: 30, durationInFrames: 120, seconds: 4 });
    if (!result.ok) return;
    expect(result.files).toEqual([{ name: "export.mp4", kind: "video", bytes: 3 }]);
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

test("the files a timeline needs are listed once each", () => {
  const checked = checkSpec(finalSpec());
  if (!checked.ok) throw new Error(checked.errors.join(";"));
  expect(inputFilesOf(checked.timeline).sort()).toEqual(["clips/a.mp4", "logo.png"]);
  const props = validateProps("final", { aspect: "16:9", clips: [{ source: SOURCE }, { source: SOURCE }], music: { file: "m.mp3", durationSeconds: 3 } });
  if (!props.ok) throw new Error("bad");
  expect(inputFilesOf(toTimeline("final", props.value)).sort()).toEqual(["clips/a.mp4", "m.mp3"]);
});
