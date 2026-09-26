import type { DevelopmentScene } from "../workbench/development-types";

/**
 * Production › Beats (owner's brief, 23 September): the agent breaks the
 * approved script into scenes, their beats and their shots — a beat sheet the
 * director edits by hand, and the source of every storyboard frame after it.
 */
export type BeatShot = { id: string; description: string; framing: string; movement: string; lighting: string; sound: string; duration?: number };
export type Beat = { id: string; text: string };
export type BeatScene = { id: string; heading: string; summary: string; /** Act One, Two or Three on the beat board; by position when unset. */ act?: 1 | 2 | 3; beats: Beat[]; shots: BeatShot[]; characters: string[]; locations: string[]; props: string[] };
/** `source` "upload": summarised by the agent from an uploaded beat sheet (`sourceName`), not broken down from the script — so a script edit never makes it stale. */
export type BeatSheet = { jobId?: string; scriptSha256: string; updatedAt: string; source?: "script" | "upload"; sourceName?: string; scenes: BeatScene[] };
/** An uploaded beat sheet (a Final Draft beat board exported as PDF), as the text the browser read from it. */
export type BeatSource = { name: string; sha256: string; pages: number; text: string; at: string };
export const BEAT_SOURCE_CHARS = 200_000;

export const BEAT_LIMITS = { scenes: 1000, beats: 40, shots: 40, heading: 300, summary: 4000, beat: 800, description: 800, field: 200, names: 30 } as const;

const id = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const cut = (value: string, max: number) => value.trim().slice(0, max);
const names = (values: string[], max: number) => [...new Set(values.map((v) => cut(v, BEAT_LIMITS.field)).filter(Boolean))].slice(0, max);

export function newShot(): BeatShot { return { id: id("shot"), description: "", framing: "", movement: "", lighting: "", sound: "" }; }
export function newBeat(): Beat { return { id: id("beat"), text: "" }; }
export function newScene(): BeatScene { return { id: id("scene"), heading: "", summary: "", beats: [newBeat()], shots: [newShot()], characters: [], locations: [], props: [] }; }

/** The agent's breakdown, every section of it, as a beat sheet with its own ids. */
export function beatSheetFrom(scenes: DevelopmentScene[], scriptSha256: string, jobId?: string, upload?: string): BeatSheet {
  return {
    ...(jobId ? { jobId } : {}), scriptSha256, updatedAt: new Date().toISOString(), ...(upload !== undefined ? { source: "upload" as const, sourceName: upload.slice(0, 300) } : {}),
    scenes: scenes.slice(0, BEAT_LIMITS.scenes).map((scene) => ({
      id: id("scene"), heading: cut(scene.heading, BEAT_LIMITS.heading), summary: cut(scene.summary, BEAT_LIMITS.summary), ...(scene.act ? { act: scene.act } : {}),
      beats: scene.beats.slice(0, BEAT_LIMITS.beats).map((text) => ({ id: id("beat"), text: cut(text, BEAT_LIMITS.beat) })),
      shots: scene.shots.slice(0, BEAT_LIMITS.shots).map((shot) => ({ id: id("shot"), description: cut(shot.description, BEAT_LIMITS.description), framing: cut(shot.framing, BEAT_LIMITS.field), movement: cut(shot.movement, BEAT_LIMITS.field), lighting: cut(shot.lighting, BEAT_LIMITS.field), sound: cut(shot.sound, BEAT_LIMITS.field) })),
      characters: names(scene.characters, BEAT_LIMITS.names), locations: names(scene.locations, 15), props: names(scene.props, BEAT_LIMITS.names),
    })),
  };
}

/** The beat sheet as the writer reads it when redrafting the script to match the director's edits. */
export function compactBeatSheet(sheet: BeatSheet) {
  return sheet.scenes.map((scene, i) => ({
    scene: i + 1, heading: scene.heading, summary: scene.summary, beats: scene.beats.map((b) => b.text).filter(Boolean),
    shots: scene.shots.map((s) => ({ description: s.description, framing: s.framing, movement: s.movement, lighting: s.lighting, sound: s.sound, ...(s.duration ? { seconds: s.duration } : {}) })),
  }));
}

export function shotCount(sheet: BeatSheet | undefined | null) { return sheet?.scenes.reduce((n, s) => n + s.shots.length, 0) ?? 0; }
export function beatCount(sheet: BeatSheet | undefined | null) { return sheet?.scenes.reduce((n, s) => n + s.beats.length, 0) ?? 0; }

/**
 * A delete on the beat sheet, and what it took out — enough to put it back
 * where it was (⌘Z). Numbers are 1-based, as the board shows them.
 */
export type BeatRemoval =
  | { kind: "scene"; index: number; scene: BeatScene }
  | { kind: "beat"; sceneId: string; sceneNumber: number; index: number; beat: Beat }
  | { kind: "shot"; sceneId: string; sceneNumber: number; index: number; shot: BeatShot };
export type BeatTarget = { kind: "scene"; id: string } | { kind: "beat" | "shot"; sceneId: string; id: string };

/** Takes one scene, beat or shot out of the sheet; null when it is not there. */
export function removeFromSheet(sheet: BeatSheet, target: BeatTarget): { sheet: BeatSheet; removal: BeatRemoval } | null {
  if (target.kind === "scene") {
    const index = sheet.scenes.findIndex((s) => s.id === target.id);
    if (index < 0) return null;
    return { sheet: { ...sheet, scenes: sheet.scenes.filter((_, i) => i !== index) }, removal: { kind: "scene", index, scene: sheet.scenes[index] } };
  }
  const si = sheet.scenes.findIndex((s) => s.id === target.sceneId);
  if (si < 0) return null;
  const scene = sheet.scenes[si];
  const list: { id: string }[] = target.kind === "beat" ? scene.beats : scene.shots;
  const index = list.findIndex((x) => x.id === target.id);
  if (index < 0) return null;
  const nextScene = target.kind === "beat" ? { ...scene, beats: scene.beats.filter((_, i) => i !== index) } : { ...scene, shots: scene.shots.filter((_, i) => i !== index) };
  const next = { ...sheet, scenes: sheet.scenes.map((s, i) => (i === si ? nextScene : s)) };
  const removal: BeatRemoval = target.kind === "beat"
    ? { kind: "beat", sceneId: scene.id, sceneNumber: si + 1, index, beat: scene.beats[index] }
    : { kind: "shot", sceneId: scene.id, sceneNumber: si + 1, index, shot: scene.shots[index] };
  return { sheet: next, removal };
}

function insertAt<T>(list: T[], index: number, item: T): T[] { const at = Math.min(Math.max(0, index), list.length); return [...list.slice(0, at), item, ...list.slice(at)]; }

/**
 * Puts a removed scene, beat or shot back at its place (or the end, if the
 * list has since shrunk). The sheet unchanged when it is already back; null
 * when it cannot go back — its scene is gone, or the list is at its limit.
 */
export function restoreToSheet(sheet: BeatSheet | null | undefined, removal: BeatRemoval): BeatSheet | null {
  if (!sheet) return null;
  if (removal.kind === "scene") {
    if (sheet.scenes.some((s) => s.id === removal.scene.id)) return sheet;
    if (sheet.scenes.length >= BEAT_LIMITS.scenes) return null;
    return { ...sheet, scenes: insertAt(sheet.scenes, removal.index, removal.scene) };
  }
  const si = sheet.scenes.findIndex((s) => s.id === removal.sceneId);
  if (si < 0) return null;
  const scene = sheet.scenes[si];
  let nextScene: BeatScene;
  if (removal.kind === "beat") {
    if (scene.beats.some((b) => b.id === removal.beat.id)) return sheet;
    if (scene.beats.length >= BEAT_LIMITS.beats) return null;
    nextScene = { ...scene, beats: insertAt(scene.beats, removal.index, removal.beat) };
  } else {
    if (scene.shots.some((s) => s.id === removal.shot.id)) return sheet;
    if (scene.shots.length >= BEAT_LIMITS.shots) return null;
    nextScene = { ...scene, shots: insertAt(scene.shots, removal.index, removal.shot) };
  }
  return { ...sheet, scenes: sheet.scenes.map((s, i) => (i === si ? nextScene : s)) };
}

/** Why `restoreToSheet` could not put a removal back, for the toast. */
export function restoreRefusal(sheet: BeatSheet | null | undefined, removal: BeatRemoval): string {
  if (!sheet) return "the beat sheet is gone";
  if (removal.kind === "scene") return `the sheet already has ${BEAT_LIMITS.scenes} scenes`;
  if (!sheet.scenes.some((s) => s.id === removal.sceneId)) return "its scene is gone";
  return removal.kind === "beat" ? `its scene already has ${BEAT_LIMITS.beats} beats` : `its scene already has ${BEAT_LIMITS.shots} shots`;
}

/** How a removal is named in the toast: "Scene 3", "Beat 2 of scene 1", "Shot 1.2". */
export function removalName(removal: BeatRemoval): string {
  if (removal.kind === "scene") return `Scene ${removal.index + 1}`;
  if (removal.kind === "beat") return `Beat ${removal.index + 1} of scene ${removal.sceneNumber}`;
  return `Shot ${removal.sceneNumber}.${removal.index + 1}`;
}

/** Moves one item of a list by a step, clamped. */
export function move<T>(list: T[], index: number, step: -1 | 1): T[] {
  const to = index + step;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
