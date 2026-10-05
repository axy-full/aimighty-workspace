import { test, expect } from "@playwright/test";
import { guestBoard, planHeading } from "../../lib/guest/board";
import type { SampleBoard } from "../../lib/demo/board";

/**
 * The sample board as a guest reads it (lead decision 39, corrections b, d and e; design README § 3.7, frames 2 and P2):
 * the plan's arithmetic, the shots and their review state, the cast line, the cut and the delivery checks, from stream 12's
 * reader's shape. Pure.
 */
const board = (over: Partial<SampleBoard> = {}): Pick<SampleBoard, "plan" | "cast" | "cut"> => ({
  plan: { steps: [
    { title: "Shot 1", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43, kind: "take" },
    { title: "Shot 2", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43, kind: "take" },
    { title: "Shot 3", meta: "Kling 3.0 Standard · 5 s · 480p", credits: 7, kind: "take" },
  ], unpriced: [], recorded: { settled: 93, quoted: 0 } },
  cast: [{ id: "c1", name: "Lead", kind: "character", line: "Lead · ivory suit, short dark bob" }],
  cut: {
    shots: [1, 2, 3].map((index) => ({ index, id: `cut-${index}`, name: `Shot ${index}`, seconds: 5, assetId: `a${index}`, generationId: `g${index}`, approved: index < 3 })),
    approved: 2, seconds: 15, approvedSeconds: 10, waiting: 1,
  },
  ...over,
});
const input = (b = board()) => ({ brief: "  A short film.  ", aspect: "16:9", fps: 24, board: b });

test("the plan is exactly the shot lines at their recorded prices, the total, and twice the total as the most fixes", () => {
  const g = guestBoard(input());
  expect(g.plan?.heading).toBe("Make 3 shots · 93 cr");
  expect(g.plan?.steps.map((s) => [s.title, s.credits])).toEqual([["Shot 1", 43], ["Shot 2", 43], ["Shot 3", 7]]);
  expect(g.plan).toMatchObject({ total: 93, fixesMost: 186 });
  expect(planHeading(1, 1200)).toBe("Make 1 shot · 1,200 cr");
});

test("a shot with no recorded price is left off and named, never guessed", () => {
  const b = board();
  b.plan = { steps: b.plan.steps.slice(0, 2), unpriced: ["Shot 3"], recorded: { settled: 86, quoted: 0 } };
  const g = guestBoard(input(b));
  expect(g.plan).toMatchObject({ heading: "Make 2 shots · 86 cr", total: 86, fixesMost: 172, unpriced: ["Shot 3"] });
  expect(guestBoard(input(board({ plan: { steps: [], unpriced: ["Shot 1"], recorded: { settled: 0, quoted: 0 } } }))).plan).toBeNull();
});

test("the shots run on from 0:00, and the one that waits is the review", () => {
  const g = guestBoard(input());
  expect(g.shots.map((s) => [s.name, s.start, s.seconds, s.approved])).toEqual([["Shot 1", "0:00", 5, true], ["Shot 2", "0:05", 5, true], ["Shot 3", "0:10", 5, false]]);
  expect(g.review).toEqual({ name: "Shot 3", meta: "Kling 3.0 Standard · 5 s · 480p" });
  expect(g.frame).toBe("16:9 · 24 fps · 15 s");
  expect(g.brief).toBe("A short film.");
});

test("the cut says what is approved and what waits; delivery checks read pending until the cut is complete", () => {
  const g = guestBoard(input());
  expect(g.cut.line).toBe("2 approved takes · 0:10 · Shot 3 waits for review");
  expect(g.deliver).toEqual([{ label: "Aspect", value: "16:9", pending: true }, { label: "Frame rate", value: "24 fps", pending: true }, { label: "Duration", value: "0:15", pending: true }]);
  const done = board();
  done.cut = { ...done.cut, shots: done.cut.shots.map((s) => ({ ...s, approved: true })), approved: 3, approvedSeconds: 15, waiting: 0 };
  const all = guestBoard(input(done));
  expect(all.review).toBeNull();
  expect(all.cut.line).toBe("3 approved takes · 0:15");
  expect(all.deliver.every((d) => !d.pending)).toBe(true);
});

test("the cast is the owner's own words, one line each", () => {
  expect(guestBoard(input()).cast).toEqual(["Lead · ivory suit, short dark bob"]);
  expect(guestBoard(input(board({ cast: [] }))).cast).toEqual([]);
});

test("nothing but words, credits and seconds leaves it: no id, vendor figure, balance or SH-style shot id", () => {
  const text = JSON.stringify(guestBoard(input()));
  expect(text).not.toMatch(/"id"|assetId|generationId|usd|cost|balance|consent|\bSH\d/i);
  expect(text).not.toMatch(/cut-\d|a\d"/);
});

test("an empty cut is a board with no shots, not a crash", () => {
  const empty = guestBoard(input(board({ plan: { steps: [], unpriced: [], recorded: { settled: 0, quoted: 0 } }, cast: [], cut: { shots: [], approved: 0, seconds: 0, approvedSeconds: 0, waiting: 0 } })));
  expect(empty).toMatchObject({ plan: null, shots: [], cast: [], review: null });
  expect(empty.cut.line).toBe("");
});
