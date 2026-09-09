import { test, expect } from "@playwright/test";
import { stripFor, stripIndex, neighbour } from "../../lib/filmstrip";

const g = (id: string, shotId: string | null, version: number, createdAt = 0) =>
  ({ id, shotId, version, createdAt, kind: "video", storedUrl: "u" });

/* A wall is newest-first, and mixes shots. */
const wall = [
  g("c", "SH010", 3), g("z", "SH020", 2), g("b", "SH010", 2), g("y", "SH020", 1), g("a", "SH010", 1),
];

test("the strip is this shot's takes, oldest version first", () => {
  /* Newest-first is right for a wall — the last thing you made is the thing
     you want. It is wrong for a strip, where the point is seeing how a shot
     developed. */
  expect(stripFor(wall, wall[0]).map((x) => x.id)).toEqual(["a", "b", "c"]);
});

test("a take from another shot does not appear", () => {
  expect(stripFor(wall, wall[1]).map((x) => x.id)).toEqual(["y", "z"]);
});

test("one take is not a filmstrip", () => {
  const lonely = [g("only", "SH030", 1)];
  expect(stripFor(lonely, lonely[0])).toEqual([]);
});

test("a take with no shot has no siblings to show", () => {
  const loose = g("loose", null, 1);
  expect(stripFor([...wall, loose], loose)).toEqual([]);
});

test("takes sharing a version number still land in a stable order", () => {
  /* A retry can produce the same version twice; without a tie-break the
     strip would reshuffle between renders. */
  const tied = [g("late", "S", 2, 200), g("early", "S", 2, 100)];
  expect(stripFor(tied, tied[0]).map((x) => x.id)).toEqual(["early", "late"]);
});

test("the current take knows where it is in its own strip", () => {
  const strip = stripFor(wall, wall[0]);
  expect(stripIndex(strip, wall[0])).toBe(2);       // "c" is v3, last
  expect(stripIndex(strip, null)).toBe(-1);
});

test("arrows walk the strip when there is one", () => {
  const strip = stripFor(wall, wall[2]);            // current is "b", v2
  expect(neighbour(wall, strip, wall[2], -1)?.id).toBe("a");
  expect(neighbour(wall, strip, wall[2], 1)?.id).toBe("c");
});

test("arrows stop at the ends rather than wrapping", () => {
  const strip = stripFor(wall, wall[4]);            // "a", v1, first
  expect(neighbour(wall, strip, wall[4], -1)).toBeNull();
  expect(neighbour(wall, strip, strip[2], 1)).toBeNull();
});

test("with no strip, arrows walk the list the player was opened with", () => {
  /* The behaviour that shipped: unchanged where there is nothing on screen
     to walk instead. */
  const loose = g("loose", null, 1);
  const all = [...wall, loose];
  expect(neighbour(all, [], loose, -1)?.id).toBe("a");
  expect(neighbour(all, [], loose, 1)).toBeNull();
});

test("audio takes are not in the strip, and are not counted in it", () => {
  /* The audio desk files tracks against shots ("SH010 · A1"), and a strip is
     of frames. They used to render as black cells all labelled v1 AND be
     counted in "3 here", so the strip claimed takes it could not show. */
  const withAudio = [
    g("v1", "SH010", 1), g("v2", "SH010", 2),
    { id: "a1", shotId: "SH010", version: 1, createdAt: 5, kind: "audio", storedUrl: "u" },
  ];
  expect(stripFor(withAudio, withAudio[0]).map((x) => x.id)).toEqual(["v1", "v2"]);
});

test("a take with nothing to show is not in the strip", () => {
  const noPicture = [
    g("v1", "SH010", 1),
    { id: "v2", shotId: "SH010", version: 2, createdAt: 1, kind: "video", storedUrl: null },
  ];
  expect(stripFor(noPicture, noPicture[0])).toEqual([]);   // one showable take is not a strip
});

test("opening an audio take shows no strip at all", () => {
  const audio = { id: "a1", shotId: "SH010", version: 1, createdAt: 0, kind: "audio", storedUrl: "u" };
  expect(stripFor([audio, g("v1", "SH010", 1)], audio)).toEqual([]);
});
