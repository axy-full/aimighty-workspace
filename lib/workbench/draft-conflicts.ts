import type { MergeConflict } from "./merge";
import type { Project } from "./studio";

/**
 * What a catch-up found when another window's saved change and this window's unsaved one touched the same single value (lib/workbench/merge.ts › conflicts):
 * said in the person's words, and, if they choose the saved version, taken from it, field by field, leaving the rest of their unsaved work as it is.
 */

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const SEGMENT = /^\[([A-Za-z]+)=([\s\S]*)\]$/;

/** The record or value at `path` in `root`, or undefined. A segment is a key, or `[id=value]` for a record of a list. */
export function valueAt(root: unknown, path: readonly string[]): unknown {
  let at: unknown = root;
  for (const segment of path) {
    const keyed = SEGMENT.exec(segment);
    if (keyed) {
      if (!Array.isArray(at)) return undefined;
      at = at.find((item) => isRow(item) && String(item[keyed[1]]) === keyed[2]);
    } else {
      if (!isRow(at)) return undefined;
      at = at[segment];
    }
  }
  return at;
}

/** `root` with the value at `path` replaced (copies along the way; the same root when the path does not exist in it). */
export function setAt<T>(root: T, path: readonly string[], value: unknown): T {
  if (!path.length) return value as T;
  const [segment, ...rest] = path;
  const keyed = SEGMENT.exec(segment);
  if (keyed) {
    if (!Array.isArray(root)) return root;
    const index = root.findIndex((item) => isRow(item) && String(item[keyed[1]]) === keyed[2]);
    if (index < 0) return root;
    const next = setAt(root[index], rest, value);
    return next === root[index] ? root : ([...root.slice(0, index), next, ...root.slice(index + 1)] as unknown as T);
  }
  if (!isRow(root)) return root;
  const next = rest.length ? setAt(root[segment], rest, value) : value;
  return next === root[segment] ? root : ({ ...root, [segment]: next } as T);
}

/** This window's project with the saved version's value at each place both changed: the other window's change stands there, everything else of this window's stays. */
export function takeTheirs(project: Project, theirs: Project, conflicts: readonly MergeConflict[]): Project {
  let out = project;
  for (const { path } of conflicts) {
    const there = valueAt(theirs, path);
    if (there !== undefined) out = setAt(out, path, there);
  }
  return out;
}

const WORDS: Record<string, string> = { name: "the board's name", description: "the description", brief: "the brief", script: "the script", direction: "the direction", assets: "the media", nodes: "the cards", boardStages: "the stages" };
const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** What a conflict is about, for the bar: the card's or file's title when it is inside one, else the field in plain words. */
export function conflictThing(project: Project, conflict: MergeConflict): string {
  const [top, record] = conflict.path;
  const ONE: Record<string, string> = { nodes: "a card", assets: "a file", boardStages: "a stage" };
  if (top && ONE[top] && record && SEGMENT.test(record)) {
    const item = valueAt(project, [top, record]);
    const title = isRow(item) ? [item.title, item.name, item.label].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "" : "";
    /* A stage's own name is the thing that changed (and either window's new name would read oddly as a title). */
    if (top === "boardStages" && conflict.path[2] === "label") return "a stage name";
    return title ? title.trim().slice(0, 60) : ONE[top];
  }
  return WORDS[top] ?? humanize(top ?? "the board");
}

/** The things the conflicts are about, once each, at most three then "N more". */
export function conflictThings(project: Project, conflicts: readonly MergeConflict[]): string[] {
  const seen = [...new Set(conflicts.map((c) => conflictThing(project, c)))];
  return seen.length <= 3 ? seen : [...seen.slice(0, 3), `${seen.length - 3} more`];
}
