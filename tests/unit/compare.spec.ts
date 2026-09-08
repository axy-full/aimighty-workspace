import { test, expect } from "@playwright/test";
import { compareSet, canCompare, compareColumns, COMPARE_MAX } from "../../lib/compare";

/** Compare (brief 2.1): two to four playable takes of one shot, newest first. */
test("a comparison holds only playable takes, newest first, at most four", () => {
  const takes = [
    { id: "a", version: 1, storedUrl: "/a" }, { id: "b", version: 2, storedUrl: null },
    { id: "c", version: 3, storedUrl: "/c" }, { id: "d", version: 4, storedUrl: "/d", status: "running" },
    { id: "e", version: 5, storedUrl: "/e" }, { id: "f", version: 6, storedUrl: "/f" },
    { id: "g", version: 7, storedUrl: "/g" }, { id: "h", version: 8, storedUrl: "/h" },
  ];
  const set = compareSet(takes);
  expect(set.length).toBe(COMPARE_MAX);
  expect(set.map((t) => t.id)).toEqual(["h", "g", "f", "e"]);
  expect(compareSet(takes, 2).map((t) => t.id)).toEqual(["h", "g"]);
  expect(canCompare(takes)).toBe(true);
  expect(canCompare([{ id: "a", storedUrl: "/a" }])).toBe(false);
  expect(canCompare([{ id: "a", storedUrl: null }, { id: "b", storedUrl: null }])).toBe(false);
  expect(compareColumns(4)).toBe(4);
  expect(compareColumns(3)).toBe(3);
  expect(compareColumns(9)).toBe(4);
  expect(compareColumns(0)).toBe(1);
});
