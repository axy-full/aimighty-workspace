import { test, expect } from "@playwright/test";
import { changedLine, changedThings, changedWhen } from "../../lib/workbench/changed-since";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

test("the time reads in plain words", () => {
  expect(changedWhen(NOW, NOW)).toBe("just now");
  expect(changedWhen(NOW + 5_000, NOW), "a clock a little ahead").toBe("just now");
  expect(changedWhen(NOW - 2 * 60_000, NOW)).toBe("2 min ago");
  expect(changedWhen(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
  expect(changedWhen(NOW - 30 * 3_600_000, NOW)).toBe("yesterday");
  expect(changedWhen(NOW - 72 * 3_600_000, NOW)).toBe("3 days ago");
});

test("the changed things are named, then counted", () => {
  expect(changedThings(["Shot 3"])).toBe("Shot 3");
  expect(changedThings(["Shot 3", "Shot 4"])).toBe("Shot 3 and Shot 4");
  expect(changedThings(["Shot 3", "Shot 4", "Note"])).toBe("Shot 3 and 2 more");
  expect(changedThings([])).toBe("this board");
});

test("the bar names who, when and what is kept; another window of the same person has no name to give", () => {
  expect(changedLine({ by: "Ana", at: NOW - 120_000, things: ["Shot 3"] }, NOW)).toBe("Ana changed this board 2 min ago · your change to Shot 3 is kept until you choose");
  expect(changedLine({ by: null, at: NOW, things: ["Shot 3"] }, NOW)).toBe("This board changed in another window just now · your change to Shot 3 is kept until you choose");
});
