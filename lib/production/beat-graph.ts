import type { BeatScene, BeatSheet } from "./beats";

/**
 * Production › Beats as a graph (owner, 24 September): the beat sheet laid
 * out like a node graph. Three act lanes run top to bottom; scenes sit left
 * to right in story order across them, so the lanes read as one timeline;
 * each scene's beats hang beneath it. Edges: the story spine (scene to the
 * next scene) and scene to its beats. Pure, so a unit test checks it.
 */
export type Act = 1 | 2 | 3;
export const GRAPH = { sceneW: 248, sceneH: 128, beatW: 224, beatH: 56, gapX: 56, gapY: 12, laneHead: 40, lanePad: 24, beatsShown: 6 } as const;

/** A scene's act: its own, else by position — the first quarter is Act One, the last quarter Act Three. */
export function actOf(scene: Pick<BeatScene, "act">, index: number, count: number): Act {
  return scene.act ?? (index < Math.ceil(count / 4) ? 1 : count >= 3 && index >= count - Math.floor(count / 4) ? 3 : 2);
}

export type GraphLane = { act: Act; y: number; h: number };
export type GraphScene = { id: string; index: number; act: Act; x: number; y: number };
export type GraphBeat = { id: string; sceneId: string; index: number; x: number; y: number; more?: number };
export type GraphEdge = { id: string; from: string; to: string; kind: "story" | "beat" };
export type BeatGraph = { lanes: GraphLane[]; scenes: GraphScene[]; beats: GraphBeat[]; edges: GraphEdge[]; width: number; height: number };

export function beatGraphLayout(sheet: Pick<BeatSheet, "scenes">): BeatGraph {
  const count = sheet.scenes.length;
  const acts = sheet.scenes.map((scene, i) => actOf(scene, i, count));
  const shown = (scene: BeatScene) => Math.min(scene.beats.length, GRAPH.beatsShown) + (scene.beats.length > GRAPH.beatsShown ? 1 : 0);
  const lanes: GraphLane[] = [];
  let y = 0;
  for (const act of [1, 2, 3] as const) {
    const inLane = sheet.scenes.filter((_, i) => acts[i] === act);
    const deepest = Math.max(0, ...inLane.map(shown));
    const h = GRAPH.laneHead + GRAPH.sceneH + (deepest ? GRAPH.gapY * 2 + deepest * (GRAPH.beatH + GRAPH.gapY) : 0) + GRAPH.lanePad;
    lanes.push({ act, y, h });
    y += h;
  }
  const scenes: GraphScene[] = [], beats: GraphBeat[] = [], edges: GraphEdge[] = [];
  sheet.scenes.forEach((scene, index) => {
    const lane = lanes[acts[index] - 1];
    const x = GRAPH.lanePad + index * (GRAPH.sceneW + GRAPH.gapX);
    const top = lane.y + GRAPH.laneHead;
    scenes.push({ id: scene.id, index, act: acts[index], x, y: top });
    const bx = x + (GRAPH.sceneW - GRAPH.beatW) / 2;
    scene.beats.slice(0, GRAPH.beatsShown).forEach((beat, bi) => {
      beats.push({ id: beat.id, sceneId: scene.id, index: bi, x: bx, y: top + GRAPH.sceneH + GRAPH.gapY * 2 + bi * (GRAPH.beatH + GRAPH.gapY) });
      edges.push({ id: `${scene.id}>${beat.id}`, from: scene.id, to: beat.id, kind: "beat" });
    });
    if (scene.beats.length > GRAPH.beatsShown) {
      beats.push({ id: `${scene.id}-more`, sceneId: scene.id, index: GRAPH.beatsShown, x: bx, y: top + GRAPH.sceneH + GRAPH.gapY * 2 + GRAPH.beatsShown * (GRAPH.beatH + GRAPH.gapY), more: scene.beats.length - GRAPH.beatsShown });
    }
    const next = sheet.scenes[index + 1];
    if (next) edges.push({ id: `${scene.id}>${next.id}`, from: scene.id, to: next.id, kind: "story" });
  });
  return { lanes, scenes, beats, edges, width: GRAPH.lanePad * 2 + Math.max(1, count) * (GRAPH.sceneW + GRAPH.gapX) - GRAPH.gapX, height: y };
}

/**
 * Where a scene dragged on the graph lands: the lane under the pointer is its
 * act; its place in the story is before the first other scene whose centre is
 * right of the drop. Returns the new scene order, with the moved scene's act
 * set explicitly (every other scene keeps the act it showed, so none jumps lanes).
 */
export function dropScene(sheet: Pick<BeatSheet, "scenes">, graph: BeatGraph, id: string, at: { x: number; y: number }): BeatScene[] {
  const count = sheet.scenes.length;
  const from = sheet.scenes.findIndex((s) => s.id === id);
  if (from < 0) return sheet.scenes;
  const lane = graph.lanes.find((l) => at.y >= l.y && at.y < l.y + l.h) ?? (at.y < 0 ? graph.lanes[0] : graph.lanes[graph.lanes.length - 1]);
  const pinned = sheet.scenes.map((scene, i) => ({ ...scene, act: scene.act ?? actOf(scene, i, count) }));
  const moved = { ...pinned[from], act: lane.act };
  const rest = pinned.filter((_, i) => i !== from);
  const others = graph.scenes.filter((s) => s.id !== id);
  const to = others.findIndex((s) => s.x + GRAPH.sceneW / 2 > at.x);
  const index = to < 0 ? rest.length : to;
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}
