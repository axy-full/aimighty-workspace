import { test, expect } from "@playwright/test";
import { DEFAULT_LIMITS, ExportTooLong, frameSize, isSafeInputPath, toTimeline, validateProps, type PropsById } from "../../remotion/src/lib";

const SOURCE = { file: "clips/a.mp4", durationSeconds: 10, width: 1920, height: 1080 };
const clip = (extra: Record<string, unknown> = {}) => ({ source: SOURCE, ...extra });

function good<K extends keyof PropsById>(id: K, props: unknown): PropsById[K] {
  const result = validateProps(id, props);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

test.describe("input paths", () => {
  test("only plain relative paths to known file types", () => {
    for (const file of ["a.mp4", "clips/a.mov", "logo.PNG", "deep/er/x.webp"]) {
      expect(isSafeInputPath(file, ["mp4", "mov", "png", "webp"])).toBe(true);
    }
    for (const file of ["", "/etc/passwd.mp4", "../a.mp4", "a/../b.mp4", "a//b.mp4", "./a.mp4", "a\\b.mp4", "https://x.test/a.mp4", "file:///a.mp4", "data:video/mp4;base64,AAAA", "a.mp4?x=1", "a.mp4#t=1", "%2e%2e/a.mp4", "a.exe", "noext", "a.mp4\u0000", "x".repeat(250) + ".mp4"]) {
      expect(isSafeInputPath(file, ["mp4", "mov"])).toBe(false);
    }
    expect(isSafeInputPath(42, ["mp4"])).toBe(false);
  });
});

test.describe("validation", () => {
  test("defaults fill in: 30 fps, full size, no theme needed", () => {
    const props = good("title-card", { aspect: "16:9", card: { title: "  Hello   world " } });
    expect(props.fps).toBe(30);
    expect(props.scale).toBe(1);
    expect(props.card.title).toBe("Hello world");
    expect(props.card.durationSeconds).toBe(2.5);
    expect(props.card.theme).toEqual({ background: "#000000", foreground: "#ffffff", accent: "#ffd400" });
  });

  test("unknown keys are refused at every level", () => {
    const result = validateProps("title-card", { aspect: "16:9", extra: 1, card: { title: "x", html: "<b>" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("props.extra: is not allowed");
      expect(result.errors.join("\n")).toContain("props.card.html: is not allowed");
    }
  });

  test("the aspect, fps, scale, colours and durations are checked", () => {
    const bad = validateProps("title-card", { aspect: "4:3", fps: 29.97, scale: 0.01, card: { title: "x", theme: { background: "red" }, durationSeconds: 99 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.errors.join("\n");
      for (const part of ["aspect", "fps", "scale", "theme.background", "durationSeconds"]) expect(text).toContain(part);
    }
  });

  test("files must be plain relative paths of the right kind, for sources, logos and music", () => {
    const bad = validateProps("final", {
      aspect: "16:9",
      clips: [{ source: { ...SOURCE, file: "http://example.com/a.mp4" } }, clip({ trim: { startSeconds: 4, endSeconds: 2 } })],
      title: { title: "x", logo: { file: "../logo.png" } },
      end: { headline: "x", logo: { file: "logo.mp4" } },
      music: { file: "/m.mp3", durationSeconds: 10 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.errors.join("\n");
      expect(text).toContain("clips[0].source.file");
      expect(text).toContain("clips[1].trim");
      expect(text).toContain("title.logo.file");
      expect(text).toContain("end.logo.file");
      expect(text).toContain("music.file");
    }
  });

  test("clip counts, cue counts and text lengths are bounded", () => {
    expect(validateProps("final", { aspect: "16:9", clips: [] }).ok).toBe(false);
    expect(validateProps("final", { aspect: "16:9", clips: Array.from({ length: DEFAULT_LIMITS.maxClips + 1 }, () => clip()) }).ok).toBe(false);
    expect(validateProps("final", { aspect: "16:9", clips: Array.from({ length: DEFAULT_LIMITS.maxClips }, () => clip()) }).ok).toBe(true);
    expect(validateProps("title-card", { aspect: "16:9", card: { title: "x".repeat(DEFAULT_LIMITS.maxTextChars + 1) } }).ok).toBe(false);
    const cues = Array.from({ length: DEFAULT_LIMITS.maxCues + 1 }, (_, i) => ({ startMs: i * 10, endMs: i * 10 + 5, text: "a" }));
    expect(validateProps("captions", { aspect: "16:9", clip: clip({ cues }), captionStyle: "bold" }).ok).toBe(false);
  });

  test("cues need start before end, text and a legal word list", () => {
    const bad = validateProps("captions", {
      aspect: "16:9",
      clip: clip({ cues: [{ startMs: 500, endMs: 100, text: "a" }, { startMs: 0, endMs: 100, text: "" }, { startMs: 0, endMs: 900, text: "ok", words: "no" }] }),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThanOrEqual(3);
  });

  test("a control character in text is refused", () => {
    expect(validateProps("title-card", { aspect: "16:9", card: { title: "bad\u0007title" } }).ok).toBe(false);
  });

  test("cutdown targets are 6, 15 or 30 only", () => {
    expect(validateProps("cutdown", { aspect: "16:9", source: SOURCE, targetSeconds: 6 }).ok).toBe(true);
    expect(validateProps("cutdown", { aspect: "16:9", source: SOURCE, targetSeconds: 10 }).ok).toBe(false);
  });

  test("the fixture's label is plain text with a default", () => {
    expect(good("fixture-clip", { aspect: "9:16" }).label).toBe("SAMPLE");
  });

  test("a non-object is refused, not thrown", () => {
    for (const value of [null, "x", 3, []]) expect(validateProps("title-card", value).ok).toBe(false);
  });
});

test.describe("durations and sizes", () => {
  test("sizes: 1920x1080 and 1080x1920 at full scale, even numbers when scaled", () => {
    expect(frameSize("16:9", 1)).toEqual({ width: 1920, height: 1080 });
    expect(frameSize("9:16", 1)).toEqual({ width: 1080, height: 1920 });
    expect(frameSize("16:9", 0.25)).toEqual({ width: 480, height: 270 });
    expect(frameSize("9:16", 0.333)).toEqual({ width: 360, height: 640 });
  });

  test("title and end cards last what they say, in whole frames", () => {
    const title = toTimeline("title-card", good("title-card", { aspect: "16:9", card: { title: "x" } }));
    expect(title.durationInFrames).toBe(75);
    expect(title.items).toHaveLength(1);
    const end = toTimeline("end-card", good("end-card", { aspect: "9:16", fps: 24, card: { headline: "x", durationSeconds: 4 } }));
    expect(end.durationInFrames).toBe(96);
    expect([end.width, end.height]).toEqual([1080, 1920]);
  });

  test("a clip uses the whole file by default and a trim when given, never past the end", () => {
    const whole = toTimeline("reframe", good("reframe", { aspect: "9:16", clip: clip() }));
    expect(whole.durationInFrames).toBe(300);
    const trimmed = toTimeline("reframe", good("reframe", { aspect: "9:16", clip: clip({ trim: { startSeconds: 2, endSeconds: 5.5 } }) }));
    expect(trimmed.durationInFrames).toBe(105);
    const [item] = trimmed.items;
    expect(item.kind === "clip" && item.trimBefore).toBe(60);
    const past = toTimeline("reframe", good("reframe", { aspect: "9:16", clip: clip({ trim: { startSeconds: 9, endSeconds: 10 } }) }));
    expect(past.durationInFrames).toBe(30);
  });

  test("captions: cues move into the clip's own time and drop outside the trim", () => {
    const cues = [
      { startMs: 500, endMs: 1500, text: "before" },
      { startMs: 2500, endMs: 4000, text: "inside" },
      { startMs: 9000, endMs: 9900, text: "after" },
    ];
    const timeline = toTimeline("captions", good("captions", { aspect: "16:9", captionStyle: "bold", clip: clip({ trim: { startSeconds: 2, endSeconds: 6 }, cues }) }));
    const [item] = timeline.items;
    if (item.kind !== "clip") throw new Error("expected a clip");
    expect(item.cues.map((c) => [c.text, c.startMs, c.endMs])).toEqual([["inside", 500, 2000]]);
    expect(item.captionStyle).toBe("bold");
  });

  test("the reframe composition draws no captions even when cues are passed", () => {
    const timeline = toTimeline("reframe", good("reframe", { aspect: "9:16", clip: clip({ cues: [{ startMs: 0, endMs: 900, text: "x" }] }) }));
    const [item] = timeline.items;
    expect(item.kind === "clip" && item.cues).toEqual([]);
  });

  for (const target of [6, 15, 30] as const) {
    test(`cutdown ${target} s is exactly ${target * 30} frames, laid end to end`, () => {
      const timeline = toTimeline("cutdown", good("cutdown", { aspect: "16:9", source: { ...SOURCE, durationSeconds: 95 }, targetSeconds: target }));
      expect(timeline.durationInFrames).toBe(target * 30);
      let at = 0;
      for (const item of timeline.items) {
        expect(item.from).toBe(at);
        at += item.durationInFrames;
      }
      expect(at).toBe(target * 30);
    });
  }

  test("cutdown cues are carried into the piece they fall in, in that piece's own time", () => {
    const timeline = toTimeline("cutdown", good("cutdown", {
      aspect: "16:9",
      source: { ...SOURCE, durationSeconds: 40 },
      targetSeconds: 6,
      captionStyle: "clean",
      cues: [{ startMs: 500, endMs: 2500, text: "hook" }, { startMs: 38_000, endMs: 39_000, text: "ending" }, { startMs: 15_000, endMs: 16_000, text: "cut away" }],
    }));
    const texts = timeline.items.map((item) => (item.kind === "clip" ? item.cues.map((c) => c.text) : []));
    expect(texts).toEqual([["hook"], ["ending"]]);
    const last = timeline.items[1];
    if (last.kind !== "clip") throw new Error("expected a clip");
    // The ending piece is the last 3 s of the source (37 s on); "ending" starts at 38 s, so 1 s into it.
    expect([last.cues[0].startMs, last.cues[0].endMs]).toEqual([1000, 2000]);
  });

  test("final adds title, clips and end card, and carries the music's length", () => {
    const timeline = toTimeline("final", good("final", {
      aspect: "16:9",
      title: { title: "x", durationSeconds: 2 },
      clips: [clip({ trim: { startSeconds: 0, endSeconds: 4 } }), clip({ trim: { startSeconds: 4, endSeconds: 9 } })],
      end: { headline: "y", durationSeconds: 3 },
      music: { file: "m.mp3", durationSeconds: 8, volume: 0.5 },
    }));
    expect(timeline.items.map((i) => [i.kind, i.from, i.durationInFrames])).toEqual([["title", 0, 60], ["clip", 60, 120], ["clip", 180, 150], ["end", 330, 90]]);
    expect(timeline.durationInFrames).toBe(420);
    expect(timeline.music).toEqual({ file: "m.mp3", volume: 0.5, durationInFrames: 240 });
  });

  test("music longer than the video is cut at the video's end", () => {
    const timeline = toTimeline("final", good("final", { aspect: "16:9", clips: [clip({ trim: { startSeconds: 0, endSeconds: 2 } })], music: { file: "m.mp3", durationSeconds: 100 } }));
    expect(timeline.music?.durationInFrames).toBe(60);
  });

  test("the length limit is enforced and says so", () => {
    const props = good("final", { aspect: "16:9", clips: Array.from({ length: 13 }, () => clip({ trim: { startSeconds: 0, endSeconds: 10 } })) });
    expect(() => toTimeline("final", props)).toThrow(ExportTooLong);
    expect(() => toTimeline("final", props, { ...DEFAULT_LIMITS, maxSeconds: 130 })).not.toThrow();
  });

  test("the fixture is a plain picture of the stated length", () => {
    const timeline = toTimeline("fixture-clip", good("fixture-clip", { aspect: "16:9", scale: 0.25, durationSeconds: 8 }));
    expect([timeline.width, timeline.height, timeline.durationInFrames]).toEqual([480, 270, 240]);
    expect(timeline.fixture).toEqual({ label: "SAMPLE" });
  });
});

test("nothing in the browser code or the export command can reach the network", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name) && name !== "bundle.mjs") files.push(full);
    }
  };
  walk(path.join(process.cwd(), "remotion", "src"));
  walk(path.join(process.cwd(), "remotion", "node"));
  expect(files.length).toBeGreaterThan(10);
  const banned = [/https?:\/\//i, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /@import/, /node:https?/, /node:net/, /node:dns/, /\bnavigator\.sendBeacon/, /<link\b/i];
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    for (const pattern of banned) expect(body, `${path.relative(process.cwd(), file)} must not match ${pattern}`).not.toMatch(pattern);
  }
});
