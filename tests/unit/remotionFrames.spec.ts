import { test, expect } from "@playwright/test";
import {
  CUTDOWN_TARGETS,
  activeCueAt,
  captionAt,
  cueWords,
  fitFontSize,
  msToFrame,
  normaliseCues,
  paginateCue,
  planCutdown,
  planSegmentsMs,
  remapCues,
  reframeLayout,
  type Cue,
} from "../../remotion/src/lib";

const FPS = [24, 25, 30, 60];
const SOURCES = [31, 33.37, 45.5, 120, 600];

test.describe("cutdown frame maths", () => {
  for (const fps of FPS) {
    for (const target of CUTDOWN_TARGETS) {
      for (const seconds of SOURCES) {
        test(`${target} s cut of a ${seconds} s source at ${fps} fps adds up to the frame`, () => {
          const plan = planCutdown({ sourceSeconds: seconds, targetSeconds: target, fps });
          const sourceFrames = Math.floor(seconds * fps);
          expect(plan.totalFrames).toBe(target * fps);
          expect(plan.underTarget).toBe(false);
          let out = 0;
          let previousEnd = 0;
          for (const [i, segment] of plan.segments.entries()) {
            expect(segment.outStartFrame).toBe(out);
            expect(segment.durationInFrames).toBeGreaterThan(0);
            expect(segment.srcStartFrame).toBeGreaterThanOrEqual(previousEnd);
            previousEnd = segment.srcStartFrame + segment.durationInFrames;
            expect(previousEnd).toBeLessThanOrEqual(sourceFrames);
            out += segment.durationInFrames;
            if (i === 0) expect(segment.srcStartFrame).toBe(0);
          }
          // The ending is kept: the last piece stops on the source's last frame.
          expect(previousEnd).toBe(sourceFrames);
          expect(out).toBe(plan.totalFrames);
        });
      }
    }
  }

  test("a source no longer than the target is used whole and flagged short", () => {
    const short = planCutdown({ sourceSeconds: 4, targetSeconds: 6, fps: 30 });
    expect(short.segments).toEqual([{ srcStartFrame: 0, durationInFrames: 120, outStartFrame: 0 }]);
    expect(short.underTarget).toBe(true);
    const exact = planCutdown({ sourceSeconds: 6, targetSeconds: 6, fps: 30 });
    expect(exact.underTarget).toBe(false);
    expect(exact.totalFrames).toBe(180);
  });

  test("marked moments longer than the target are trimmed from the tail, in proportion", () => {
    const plan = planCutdown({
      sourceSeconds: 60,
      targetSeconds: 6,
      fps: 30,
      keep: [
        { startSeconds: 5, endSeconds: 9 },
        { startSeconds: 20, endSeconds: 28 },
      ],
    });
    expect(plan.totalFrames).toBe(180);
    expect(plan.segments[0].srcStartFrame).toBe(150);
    expect(plan.segments[1].srcStartFrame).toBe(600);
    // 4 s and 8 s share 6 s as 2 s and 4 s.
    expect(plan.segments.map((s) => s.durationInFrames)).toEqual([60, 120]);
  });

  test("marked moments shorter than the target grow into the source, forward first", () => {
    const plan = planCutdown({ sourceSeconds: 60, targetSeconds: 15, fps: 30, keep: [{ startSeconds: 10, endSeconds: 12 }] });
    expect(plan.totalFrames).toBe(450);
    expect(plan.segments).toEqual([{ srcStartFrame: 300, durationInFrames: 450, outStartFrame: 0 }]);
  });

  test("growing stops at the end of the source and then goes backward; pieces never overlap", () => {
    const plan = planCutdown({ sourceSeconds: 20, targetSeconds: 15, fps: 30, keep: [{ startSeconds: 17, endSeconds: 19 }] });
    expect(plan.totalFrames).toBe(450);
    const [only] = plan.segments;
    expect(only.srcStartFrame + only.durationInFrames).toBe(600);
    const two = planCutdown({
      sourceSeconds: 20,
      targetSeconds: 15,
      fps: 30,
      keep: [
        { startSeconds: 2, endSeconds: 4 },
        { startSeconds: 6, endSeconds: 8 },
      ],
    });
    expect(two.totalFrames).toBe(450);
    for (let i = 1; i < two.segments.length; i += 1) {
      expect(two.segments[i].srcStartFrame).toBeGreaterThanOrEqual(two.segments[i - 1].srcStartFrame + two.segments[i - 1].durationInFrames);
    }
  });

  test("marked moments outside the source are ignored", () => {
    const plan = planCutdown({ sourceSeconds: 40, targetSeconds: 6, fps: 30, keep: [{ startSeconds: 100, endSeconds: 110 }] });
    expect(plan.totalFrames).toBe(180);
    expect(plan.segments).toHaveLength(2);
  });

  test("segments in milliseconds line up with frames", () => {
    const plan = planCutdown({ sourceSeconds: 40, targetSeconds: 6, fps: 30 });
    const ms = planSegmentsMs(plan);
    expect(ms[0]).toEqual({ srcStartMs: 0, srcEndMs: 3000, outStartMs: 0 });
    expect(ms[1].outStartMs).toBe(3000);
    expect(ms[1].srcEndMs).toBe(40_000);
  });
});

test.describe("caption timing", () => {
  const cue = (startMs: number, endMs: number, text: string, extra: Partial<Cue> = {}): Cue => ({ startMs, endMs, text, ...extra });

  test("normalise sorts, clamps to the video and stops a cue where the next begins", () => {
    const out = normaliseCues([cue(3000, 5000, "second"), cue(0, 3500, "first"), cue(9000, 12_000, "late"), cue(20_000, 21_000, "gone"), cue(1000, 1050, "")], 10_000);
    expect(out.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
      ["first", 0, 3000],
      ["second", 3000, 5000],
      ["late", 9000, 10_000],
    ]);
  });

  test("a cue shorter than 100 ms after trimming is dropped", () => {
    expect(normaliseCues([cue(0, 2000, "a"), cue(1950, 4000, "b")], 5000).map((c) => c.text)).toEqual(["a", "b"]);
    expect(normaliseCues([cue(0, 2000, "a"), cue(1950, 4000, "b")], 5000)[0].endMs).toBe(1950);
    expect(normaliseCues([cue(1990, 2000, "x"), cue(2000, 4000, "y")], 5000).map((c) => c.text)).toEqual(["y"]);
  });

  test("a cue is on screen from its start up to, not including, its end", () => {
    const cues = [cue(1000, 2000, "a"), cue(2000, 3000, "b")];
    expect(activeCueAt(cues, 999)).toBeNull();
    expect(activeCueAt(cues, 1000)?.text).toBe("a");
    expect(activeCueAt(cues, 1999)?.text).toBe("a");
    expect(activeCueAt(cues, 2000)?.text).toBe("b");
    expect(activeCueAt(cues, 3000)).toBeNull();
  });

  test("without word timing, a cue's time is shared out by letters and covers it exactly", () => {
    const words = cueWords(cue(1000, 3000, "aa bbbb cc"));
    expect(words.map((w) => w.text)).toEqual(["aa", "bbbb", "cc"]);
    expect(words[0].startMs).toBe(1000);
    expect(words[2].endMs).toBe(3000);
    for (let i = 1; i < words.length; i += 1) expect(words[i].startMs).toBe(words[i - 1].endMs);
  });

  test("pages tile the cue, hold every word once and respect the line length", () => {
    const text = "Every great film starts with one idea and then the work begins";
    const c = cue(1000, 9000, text);
    const pages = paginateCue(c, 20);
    expect(pages[0].startMs).toBe(1000);
    expect(pages[pages.length - 1].endMs).toBe(9000);
    for (let i = 1; i < pages.length; i += 1) expect(pages[i].startMs).toBe(pages[i - 1].endMs);
    expect(pages.flatMap((p) => p.words.map((w) => w.text)).join(" ")).toBe(text);
    for (const page of pages) expect(page.words.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(20);
  });

  test("a word longer than the line gets a page of its own", () => {
    const pages = paginateCue(cue(0, 3000, "tiny extraordinarily tiny"), 10);
    expect(pages.map((p) => p.words.map((w) => w.text).join(" "))).toEqual(["tiny", "extraordinarily", "tiny"]);
  });

  test("captionAt names the spoken word, using word timing when given", () => {
    const c = cue(0, 3000, "one two three", {
      words: [
        { startMs: 0, endMs: 1000, text: "one" },
        { startMs: 1000, endMs: 2000, text: "two" },
        { startMs: 2000, endMs: 3000, text: "three" },
      ],
    });
    expect(captionAt([c], 500, 40)).toEqual({ words: ["one", "two", "three"], activeWord: 0, pageStartMs: 0 });
    expect(captionAt([c], 1500, 40)?.activeWord).toBe(1);
    expect(captionAt([c], 2999, 40)?.activeWord).toBe(2);
    expect(captionAt([c], 3000, 40)).toBeNull();
  });

  test("frames: a cue starting at 1.2 s at 30 fps starts on frame 36", () => {
    expect(msToFrame(1200, 30)).toBe(36);
    expect(msToFrame(1234, 24)).toBe(30);
  });

  test("remapping through a cutdown shifts cues and splits one that spans a cut", () => {
    const cues = [cue(500, 6500, "one two three four", { words: [
      { startMs: 500, endMs: 1500, text: "one" },
      { startMs: 1500, endMs: 3500, text: "two" },
      { startMs: 3500, endMs: 5500, text: "three" },
      { startMs: 5500, endMs: 6500, text: "four" },
    ] })];
    const mapped = remapCues(cues, [
      { srcStartMs: 0, srcEndMs: 2000, outStartMs: 0 },
      { srcStartMs: 5000, srcEndMs: 7000, outStartMs: 2000 },
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ startMs: 500, endMs: 2000, text: "one two" });
    expect(mapped[1]).toMatchObject({ startMs: 2000, endMs: 3500, text: "three four" });
    expect(mapped[1].words?.[0]).toMatchObject({ text: "three", startMs: 2000, endMs: 2500 });
  });

  test("remapping drops a cue that falls in the part that was cut away", () => {
    const mapped = remapCues([cue(3000, 4000, "gone"), cue(0, 1000, "kept")], [{ srcStartMs: 0, srcEndMs: 2000, outStartMs: 0 }]);
    expect(mapped.map((c) => c.text)).toEqual(["kept"]);
  });
});

test.describe("reframe", () => {
  const fill = (focusX = 0.5, focusY = 0.5) => ({ mode: "fill" as const, focusX, focusY });

  test("16:9 into 9:16 fills the tall frame and crops the sides, centred on the focus", () => {
    const layout = reframeLayout({ srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, reframe: fill() });
    expect(layout.video.height).toBe(1920);
    expect(layout.video.width).toBeCloseTo(3413.33, 1);
    expect(layout.video.x).toBeCloseTo(-1166.67, 1);
    expect(layout.video.y).toBe(0);
    expect(layout.backdrop).toBeNull();
  });

  test("the crop follows the focus point and never leaves the picture", () => {
    const left = reframeLayout({ srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, reframe: fill(0) });
    const right = reframeLayout({ srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, reframe: fill(1) });
    expect(left.video.x).toBe(0);
    expect(right.video.x).toBeCloseTo(1080 - left.video.width, 1);
  });

  test("9:16 into 16:9 crops top and bottom", () => {
    const layout = reframeLayout({ srcW: 1080, srcH: 1920, outW: 1920, outH: 1080, reframe: fill(0.5, 0.3) });
    expect(layout.video.width).toBe(1920);
    expect(layout.video.height).toBeCloseTo(3413.33, 1);
    expect(layout.video.y).toBeGreaterThanOrEqual(1080 - layout.video.height);
    expect(layout.video.y).toBeLessThanOrEqual(0);
  });

  test("the same shape in and out is the identity, fill or fit", () => {
    for (const mode of ["fill", "fit"] as const) {
      const layout = reframeLayout({ srcW: 1280, srcH: 720, outW: 1920, outH: 1080, reframe: { mode, focusX: 0.2, focusY: 0.9 } });
      expect(layout.video).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
      expect(layout.backdrop).toBeNull();
    }
  });

  test("fit shows the whole picture, bars filled by a backdrop that covers the frame", () => {
    const layout = reframeLayout({ srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, reframe: { mode: "fit", focusX: 0.5, focusY: 0.5 } });
    expect(layout.video).toEqual({ x: 0, y: 656.25, width: 1080, height: 607.5 });
    expect(layout.backdrop?.height).toBe(1920);
    expect(layout.backdrop?.width).toBeGreaterThanOrEqual(1080);
  });
});

test("text fits: long text gets a smaller size, never outside the bounds", () => {
  const small = fitFontSize({ text: "x".repeat(140), widthPx: 1500, maxPx: 150, minPx: 44, lines: 2 });
  const big = fitFontSize({ text: "Hi", widthPx: 1500, maxPx: 150, minPx: 44, lines: 2 });
  expect(small).toBeLessThan(big);
  expect(big).toBe(150);
  expect(small).toBeGreaterThanOrEqual(44);
});
