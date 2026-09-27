import type { DevelopmentScene } from "../workbench/development-types";
import { stableId } from "../workbench/stable-id";

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

/**
 * The agent's breakdown, every section of it, as a beat sheet with its own ids —
 * ids made from the run (or the source) and the position, so two windows taking
 * the same breakdown make the same sheet, which a merge holds once.
 */
export function beatSheetFrom(scenes: DevelopmentScene[], scriptSha256: string, jobId?: string, upload?: string): BeatSheet {
  const source = jobId ?? `${scriptSha256}:${upload ?? ""}`;
  return {
    ...(jobId ? { jobId } : {}), scriptSha256, updatedAt: new Date().toISOString(), ...(upload !== undefined ? { source: "upload" as const, sourceName: upload.slice(0, 300) } : {}),
    scenes: scenes.slice(0, BEAT_LIMITS.scenes).map((scene, si) => ({
      id: stableId("scene", source, si), heading: cut(scene.heading, BEAT_LIMITS.heading), summary: cut(scene.summary, BEAT_LIMITS.summary), ...(scene.act ? { act: scene.act } : {}),
      beats: scene.beats.slice(0, BEAT_LIMITS.beats).map((text, bi) => ({ id: stableId("beat", source, si, bi), text: cut(text, BEAT_LIMITS.beat) })),
      shots: scene.shots.slice(0, BEAT_LIMITS.shots).map((shot, hi) => ({ id: stableId("shot", source, si, hi), description: cut(shot.description, BEAT_LIMITS.description), framing: cut(shot.framing, BEAT_LIMITS.field), movement: cut(shot.movement, BEAT_LIMITS.field), lighting: cut(shot.lighting, BEAT_LIMITS.field), sound: cut(shot.sound, BEAT_LIMITS.field) })),
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

/** Moves one item of a list by a step, clamped. */
export function move<T>(list: T[], index: number, step: -1 | 1): T[] {
  const to = index + step;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
