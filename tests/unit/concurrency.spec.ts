import { test, expect } from "@playwright/test";
import { peakOf, peakByEngine, peakOverall, type Span } from "../../lib/concurrency";

const s = (engine: string, startedAt: number, endedAt: number | null): Span => ({ engine, startedAt, endedAt });
const NOW = 1_000_000;

/**
 * Peak concurrency per engine (SOW §7) — derived from the intervals the
 * meter already records, not sampled.
 */
test("the peak is the most that overlapped, and it says when", () => {
  //  a  0 ▓▓▓▓▓▓▓▓ 80
  //  b     20 ▓▓▓▓ 60
  //  c            70 ▓▓▓▓▓ 120     <- b has already ended
  const out = peakOf([s("e", 0, 80), s("e", 20, 60), s("e", 70, 120)], NOW);
  expect(out.peak, "a+b, then a+c — never three").toBe(2);
  expect(out.at, "the first instant it reached two").toBe(20);

  // Three genuinely at once, to prove the sweep is not capped at two.
  const three = peakOf([s("e", 0, 80), s("e", 20, 60), s("e", 30, 120)], NOW);
  expect(three.peak).toBe(3);
  expect(three.at).toBe(30);
});

test("a job ending as another begins is not two at once", () => {
  /* Half-open intervals, `[start, end)` — the same shape cycleBounds uses.
     Counting the shared instant twice would inflate every peak on a queue
     that runs jobs back to back, which is exactly what a busy queue does. */
  expect(peakOf([s("e", 0, 50), s("e", 50, 100)], NOW).peak).toBe(1);
  // ...but a single millisecond of genuine overlap is two.
  expect(peakOf([s("e", 0, 51), s("e", 50, 100)], NOW).peak).toBe(2);
});

test("a job still running counts up to now, and never closes", () => {
  const out = peakOf([s("e", 0, null), s("e", 10, 20)], NOW);
  expect(out.peak).toBe(2);
  // Alone, an open job is still one — not zero, and not a crash.
  expect(peakOf([s("e", 0, null)], NOW).peak).toBe(1);
});

test("a job that recorded no duration is counted once, not lost", () => {
  /* The meter writes `updated_at === created_at` when a render fails before
     it starts. A zero-length interval overlaps nothing and would vanish from
     the count entirely, quietly understating a queue full of fast failures. */
  expect(peakOf([s("e", 100, 100)], NOW).peak).toBe(1);
  expect(peakOf([s("e", 100, 100), s("e", 100, 100)], NOW).peak).toBe(2);
  // An end before its start is the same case, not a negative interval.
  expect(peakOf([s("e", 100, 40)], NOW).peak).toBe(1);
});

test("nothing at all is zero, not one and not a crash", () => {
  expect(peakOf([], NOW)).toEqual({ peak: 0, at: 0 });
  expect(peakByEngine([], NOW)).toEqual([]);
});

test("each engine is answered on its own, because each has its own provider", () => {
  const out = peakByEngine([
    s("fal", 0, 100), s("fal", 10, 100), s("fal", 20, 100),
    s("byteplus", 0, 100), s("byteplus", 200, 300),
  ], NOW);
  expect(out.map((p) => [p.engine, p.peak, p.jobs])).toEqual([["fal", 3, 3], ["byteplus", 1, 2]]);
});

test("the platform's own peak is not the sum of the engines'", () => {
  /* fal peaks at 2 and byteplus at 2, but never at the same moment, so the
     platform never ran 4. Adding the per-engine peaks would report a number
     that never happened — and it is the number somebody would quote. */
  const spans = [
    s("fal", 0, 100), s("fal", 10, 100),
    s("byteplus", 500, 600), s("byteplus", 510, 600),
  ];
  expect(peakByEngine(spans, NOW).map((p) => p.peak)).toEqual([2, 2]);
  expect(peakOverall(spans, NOW).peak).toBe(2);
});

test("an engine with no name is still reported, not dropped", () => {
  expect(peakByEngine([s("", 0, 10)], NOW)[0].engine).toBe("unknown");
});

test("nonsense timestamps are skipped rather than poisoning the sweep", () => {
  const out = peakOf([s("e", Number.NaN, 10), s("e", 0, 100), s("e", 5, 50)], NOW);
  expect(out.peak, "the two real ones still count").toBe(2);
});

test("order in does not change the answer", () => {
  const spans = [s("e", 70, 120), s("e", 0, 80), s("e", 20, 60)];
  const shuffled = [spans[1], spans[2], spans[0]];
  expect(peakOf(spans, NOW)).toEqual(peakOf(shuffled, NOW));
});
