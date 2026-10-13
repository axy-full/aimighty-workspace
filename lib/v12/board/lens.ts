/**
 * The board's four lenses (owner, 13 Oct: "one board, four lenses"): Canvas, List, Strip and Rig show the SAME content of the current stage, arranged differently.
 * Which one a stage opens in, and which one a person chose for it, is decided here. Pure apart from the device's own storage.
 *
 *  - Defaults: Script opens in List; Storyboard, Shots, Cast and Elements open in Canvas; Cut opens in Canvas until Strip is built (the owner: switch to Strip then);
 *    every other stage opens in Canvas.
 *  - A person's own switch is remembered per board and per stage, on this device (`particl:board-lens:{scope}:{projectId}`), and nothing else resets it: moving between
 *    stages, gliding to a card or arriving by a link never changes what was chosen.
 */
import type { Flavor } from "./kinds";

export type Lens = "canvas" | "list" | "rig";
const LENSES: readonly Lens[] = ["canvas", "list", "rig"];
export const isLens = (value: unknown): value is Lens => typeof value === "string" && (LENSES as readonly string[]).includes(value);

/** The stage's natural lens. Film's and Pre-vis's Script is a beat sheet, so it opens as one. (Cut: Canvas until Strip is built.) */
export function defaultLens(stageId: string | null | undefined, flavor: Flavor): Lens {
  if (stageId === "script" && (flavor === "film" || flavor === "previs")) return "list";
  return "canvas";
}

/** The lens a stage shows: the person's own choice for it, else its default. */
export function lensFor(stageId: string | null | undefined, flavor: Flavor, chosen: Readonly<Record<string, Lens>>): Lens {
  return (stageId ? chosen[stageId] : undefined) ?? defaultLens(stageId, flavor);
}

export const lensKey = (scope: string, projectId: string) => `particl:board-lens:${scope}:${projectId}`;

/** What this device remembers for a board: the lens chosen for each stage. Anything unreadable is nothing. */
export function readLenses(scope: string, projectId: string): Record<string, Lens> {
  try {
    const value = JSON.parse(localStorage.getItem(lensKey(scope, projectId)) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, Lens] => isLens(entry[1])).slice(0, 64));
  } catch { return {}; }
}

/** Remembers one stage's lens for the board; the next visit, and the next stage change, read it back. */
export function saveLens(scope: string, projectId: string, stageId: string, lens: Lens): Record<string, Lens> {
  const next = { ...readLenses(scope, projectId), [stageId]: lens };
  try { localStorage.setItem(lensKey(scope, projectId), JSON.stringify(next)); } catch { /* the choice lasts until the page is left */ }
  return next;
}
