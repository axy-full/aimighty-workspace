/**
 * The ⌘K palette's commands (04 "Command palette"), as data. Sources, in
 * order: every page of every suite · "Run this page with Atomik" · every
 * plan title · generate the selected shot · toggle the Inspector · each
 * shot by name · all projects. Shots come from the loaded list, never a
 * fixture. The shell turns an action into navigation or a run.
 */

import { PAGES, getSuite } from "./pages";
import { PLANS } from "./plans";
import type { WorkspacePageId } from "./plan-types";
import type { PageId, SelectableItem, Suite } from "./types";

export type PaletteAction =
  | { type: "go"; suite: Suite; page: PageId }
  | { type: "runPage" }
  | { type: "runPlan"; suite: Suite; page: PageId }
  | { type: "generate" }
  | { type: "toggleInspector" }
  | { type: "shot"; id: string }
  | { type: "home" };

export type PaletteCommand = {
  id: string;
  /** Mono group tag, 70px: STUDIO / AGENT / BUSINESS / VIRAL / ATOMIK / ACTION / SHOT / GO. */
  group: string;
  label: string;
  /** Keycap hint, or "" for none. */
  hint: string;
  action: PaletteAction;
};

export const PALETTE_LIMIT = 8;

export function paletteCommands(input: { shots: SelectableItem[] | null }): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  const suites = Object.keys(PAGES) as Suite[];
  for (const suite of suites) {
    const group = getSuite(suite).short.toUpperCase();
    for (const page of PAGES[suite])
      out.push({ id: `page:${page.id}`, group, label: page.title, hint: "", action: { type: "go", suite, page: page.id } });
  }
  out.push({ id: "run-page", group: "ATOMIK", label: "Run this page with Atomik", hint: "A", action: { type: "runPage" } });
  for (const suite of suites)
    for (const page of PAGES[suite]) {
      const plan = PLANS[page.id as WorkspacePageId];
      if (plan) out.push({ id: `plan:${page.id}`, group: "ATOMIK", label: plan.title, hint: "", action: { type: "runPlan", suite, page: page.id } });
    }
  out.push({ id: "generate", group: "ACTION", label: "Generate selected shot", hint: "G", action: { type: "generate" } });
  out.push({ id: "inspector", group: "ACTION", label: "Toggle inspector", hint: "I", action: { type: "toggleInspector" } });
  for (const shot of input.shots ?? [])
    out.push({ id: `shot:${shot.id}`, group: "SHOT", label: shot.name, hint: "", action: { type: "shot", id: shot.id } });
  out.push({ id: "home", group: "GO", label: "All projects", hint: "", action: { type: "home" } });
  return out;
}

/** Case-insensitive substring on label or group, source order kept, at most eight. */
export function filterPalette(commands: PaletteCommand[], query: string, limit = PALETTE_LIMIT): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  const hits = q ? commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) : commands;
  return hits.slice(0, limit);
}

/** ↑ / ↓ move the highlight within the visible rows, clamped at both ends. */
export function moveHighlight(index: number, step: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + step));
}
