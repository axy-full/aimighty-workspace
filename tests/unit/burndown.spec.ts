import { test, expect } from "@playwright/test";
import { burnDown, biggestBurners, projectionLine } from "../../lib/burndown";

const shots = [
  { id: "a", code: "SH010", takes: 6, credits: 172 },
  { id: "b", code: "SH020", takes: 2, credits: 60 },
  { id: "c", code: "SH030", takes: 0, credits: 0 },
];

/** The burn-down (brief 2.2): spent against the cap, and what finishing costs at the rate this production has actually run. */
test("the projection is takes-per-shot and spend-per-shot so far, applied to the shots left", () => {
  const b = burnDown({ spentCredits: 232, capCredits: 400, shotCount: 4, byShot: shots });
  expect(b.spent).toBe(232);
  expect(b.left).toBe(168);
  expect(b.pct).toBe(58);
  expect(b.started).toBe(2);
  expect(b.shots).toBe(4);
  expect(b.perShot).toBe(116);
  expect(b.takesPerShot).toBe(4);
  expect(b.projected).toBe(464);   // 116 a shot × 4 shots
  expect(b.over).toBe(64);         // 64 past the cap
  expect(b.known).toBe(true);
});

test("it says nothing it cannot know, and reads plainly when it can", () => {
  const empty = burnDown({ spentCredits: 0, capCredits: 400, shotCount: 3, byShot: [] });
  expect(empty.known).toBe(false);
  expect(empty.projected).toBeNull();
  expect(projectionLine(empty, (n) => `${n} cr`)).toBe("");
  const b = burnDown({ spentCredits: 232, capCredits: 400, shotCount: 4, byShot: shots });
  expect(projectionLine(b, (n) => `${n} cr`)).toBe("At 4.0 takes a shot so far, finishing costs about 464 cr — 64 cr over the cap.");
  const under = burnDown({ spentCredits: 100, capCredits: 1000, shotCount: 4, byShot: shots });
  expect(projectionLine(under, (n) => `${n} cr`)).toContain("inside the cap by");
  const noCap = burnDown({ spentCredits: 232, capCredits: null, shotCount: 4, byShot: shots });
  expect(projectionLine(noCap, (n) => `${n} cr`)).toContain("2 shots to go");
});

test("the biggest burners come first, with each one's share", () => {
  const top = biggestBurners(shots, 232);
  expect(top.map((s) => s.code)).toEqual(["SH010", "SH020"]);
  expect(top[0].share).toBe(74);
  expect(biggestBurners([], 0)).toEqual([]);
});
