import { test, expect } from "@playwright/test";
import { beatGraphLayout, dropScene, GRAPH } from "../../lib/production/beat-graph";
import type { BeatScene } from "../../lib/production/beats";

const scene = (id: string, beats: number, act?: 1 | 2 | 3): BeatScene => ({
  id, heading: id.toUpperCase(), summary: "", ...(act ? { act } : {}), beats: Array.from({ length: beats }, (_, i) => ({ id: `${id}-b${i}`, text: `beat ${i}` })),
  shots: [], characters: [], locations: [], props: [],
});

test("scenes run left to right in story order across three act lanes, beats hang beneath, the spine links each scene to the next", () => {
  const sheet = { scenes: [scene("a", 2), scene("b", 1), scene("c", 0), scene("d", 3)] };
  const g = beatGraphLayout(sheet);
  expect(g.lanes.map((l) => l.act)).toEqual([1, 2, 3]);
  /* 4 scenes: the first is Act One, the last Act Three, the middle two Act Two. */
  expect(g.scenes.map((s) => s.act)).toEqual([1, 2, 2, 3]);
  expect(g.scenes.map((s) => s.x)).toEqual([0, 1, 2, 3].map((i) => GRAPH.lanePad + i * (GRAPH.sceneW + GRAPH.gapX)));
  for (const s of g.scenes) { const lane = g.lanes[s.act - 1]; expect(s.y).toBeGreaterThanOrEqual(lane.y); expect(s.y + GRAPH.sceneH).toBeLessThanOrEqual(lane.y + lane.h); }
  expect(g.beats.filter((b) => b.sceneId === "a")).toHaveLength(2);
  expect(g.edges.filter((e) => e.kind === "story").map((e) => e.id)).toEqual(["a>b", "b>c", "c>d"]);
  expect(g.edges.filter((e) => e.kind === "beat")).toHaveLength(6);
  /* Lanes stack without overlap and the graph holds them all. */
  expect(g.lanes[1].y).toBe(g.lanes[0].y + g.lanes[0].h);
  expect(g.height).toBe(g.lanes[2].y + g.lanes[2].h);
});

test("a long scene shows six beats and a “more” node", () => {
  const g = beatGraphLayout({ scenes: [scene("a", 9, 2)] });
  const beats = g.beats.filter((b) => b.sceneId === "a");
  expect(beats).toHaveLength(7);
  expect(beats.at(-1)).toMatchObject({ id: "a-more", more: 3 });
});

test("dropping a scene sets its act from the lane and its place from the x; the others keep the act they showed", () => {
  const sheet = { scenes: [scene("a", 1), scene("b", 1), scene("c", 1), scene("d", 1)] };
  const g = beatGraphLayout(sheet);
  /* d (Act Three, last) dropped in the Act One lane, left of b's centre: after a, before b. */
  const at = { x: g.scenes[1].x + 10, y: g.lanes[0].y + 60 };
  const next = dropScene(sheet, g, "d", at);
  expect(next.map((s) => s.id)).toEqual(["a", "d", "b", "c"]);
  expect(next.map((s) => s.act)).toEqual([1, 1, 2, 2]);
  /* Dropped past the end in Act Two: last, Act Two. */
  expect(dropScene(sheet, g, "a", { x: 99_999, y: g.lanes[1].y + 60 }).map((s) => [s.id, s.act])).toEqual([["b", 2], ["c", 2], ["d", 3], ["a", 2]]);
  expect(dropScene(sheet, g, "zzz", at)).toBe(sheet.scenes);
});
