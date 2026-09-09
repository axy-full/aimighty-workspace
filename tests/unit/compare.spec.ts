import { test, expect } from "@playwright/test";
import { compareSet, canCompare, compareColumns, COMPARE_MAX, compareCandidates, toggleCompare, canToggle, wipeAvailable, clampWipe, wipeFromPointer } from "../../lib/compare";

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

/* ── Choosing which takes are weighed (SOW §10 4.3) ────────────────────── */

const six = [
  { id: "a", version: 6, storedUrl: "u" }, { id: "b", version: 5, storedUrl: "u" },
  { id: "c", version: 4, storedUrl: "u" }, { id: "d", version: 3, storedUrl: "u" },
  { id: "e", version: 2, storedUrl: "u" }, { id: "f", version: 1, storedUrl: "u" },
];

test("every playable take is a candidate, newest first — none is hidden", () => {
  /* compareSet answers "what does it open on" and silently drops the rest.
     On a six-take shot that hid two takes with nothing saying so, and made
     "A/B wipe for two" impossible to ask for. */
  expect(compareCandidates(six).map((t) => t.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(compareSet(six).length).toBe(4);
  expect(compareCandidates(six).length).toBe(6);
});

test("a take with nothing to play is not a candidate", () => {
  const mixed = [...six, { id: "g", version: 7, storedUrl: null }, { id: "h", version: 8, storedUrl: "u", status: "failed" }];
  const ids = compareCandidates(mixed).map((t) => t.id);
  expect(ids).not.toContain("g");
  expect(ids).not.toContain("h");
});

test("a comparison holds at most four: adding a fifth is refused, not shuffled", () => {
  /* Dropping someone's oldest pick to make room is the kind of help that
     loses the take they were looking at. */
  const four = ["a", "b", "c", "d"];
  expect(toggleCompare(four, "e")).toEqual(four);
  expect(canToggle(four, "e")).toBe(false);
});

test("a comparison holds at least two: the second cannot be dropped", () => {
  expect(toggleCompare(["a", "b"], "a")).toEqual(["a", "b"]);
  expect(canToggle(["a", "b"], "a")).toBe(false);
});

test("inside the bounds, toggling adds and removes", () => {
  expect(toggleCompare(["a", "b", "c"], "d")).toEqual(["a", "b", "c", "d"]);
  expect(toggleCompare(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  expect(canToggle(["a", "b", "c"], "d")).toBe(true);
  expect(canToggle(["a", "b", "c"], "b")).toBe(true);
});

test("toggling never mutates the list it was given", () => {
  const before = ["a", "b", "c"];
  toggleCompare(before, "d");
  expect(before).toEqual(["a", "b", "c"]);
});

test("choosing exactly two is reachable, which is what A/B needs", () => {
  let sel = compareSet(six).map((t) => t.id);      // opens on four
  sel = toggleCompare(sel, sel[3]);
  sel = toggleCompare(sel, sel[2]);
  expect(sel.length).toBe(2);
  expect(canToggle(sel, sel[0])).toBe(false);      // and stops there
});

/* ── A/B wipe (SOW §10 4.3: "side by side, or A/B wipe for two") ───────── */

test("a wipe is offered at exactly two takes and nowhere else", () => {
  /* Not an arbitrary limit: a wipe puts one take UNDER another and reveals
     across a seam, which has meaning for a pair and none for three. */
  expect(wipeAvailable(2)).toBe(true);
  for (const n of [0, 1, 3, 4]) expect(wipeAvailable(n), `${n} takes`).toBe(false);
});

test("the seam stays inside the frame", () => {
  expect(clampWipe(-40)).toBe(0);
  expect(clampWipe(140)).toBe(100);
  expect(clampWipe(50)).toBe(50);
});

test("a seam is a whole percent, and nonsense lands in the middle", () => {
  expect(clampWipe(33.4)).toBe(33);
  // Neither NaN nor Infinity is a position on a frame, so both land in the
  // middle rather than being clamped to an edge that would look deliberate.
  expect(clampWipe(Number.NaN)).toBe(50);
  expect(clampWipe(Number.POSITIVE_INFINITY)).toBe(50);
});

test("the seam follows the pointer across the frame it is dragged over", () => {
  expect(wipeFromPointer(100, 100, 400)).toBe(0);      // at the left edge
  expect(wipeFromPointer(300, 100, 400)).toBe(50);     // halfway
  expect(wipeFromPointer(500, 100, 400)).toBe(100);    // at the right edge
  expect(wipeFromPointer(700, 100, 400)).toBe(100);    // past it, still inside
});

test("a frame with no width yet does not produce NaN", () => {
  /* Zero-width boxes happen during layout, and a NaN would reach a
     clip-path and blank the take. */
  expect(wipeFromPointer(300, 0, 0)).toBe(50);
});

test("a comparison is of video, so the stills wall gets no Compare button", () => {
  /* compareSet filtered on url and status but never on kind, so any shot
     with two finished stills showed a Compare button on /images — and the
     grid then put PNG urls inside <video> elements: black boxes under a
     transport reporting no duration. canCompare is the gate on that button. */
  const stills = [
    { id: "s1", version: 1, storedUrl: "u", kind: "image" },
    { id: "s2", version: 2, storedUrl: "u", kind: "image" },
  ];
  expect(compareSet(stills)).toEqual([]);
  expect(canCompare(stills)).toBe(false);
});

test("a row from before the kind column is treated as video", () => {
  const old = [{ id: "a", version: 1, storedUrl: "u" }, { id: "b", version: 2, storedUrl: "u" }];
  expect(canCompare(old)).toBe(true);
});

test("audio takes are not comparable either", () => {
  const tracks = [
    { id: "a1", version: 1, storedUrl: "u", kind: "audio" },
    { id: "a2", version: 2, storedUrl: "u", kind: "audio" },
  ];
  expect(canCompare(tracks)).toBe(false);
});
