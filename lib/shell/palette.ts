import { ALL_SHELL_PAGES, HEADER_SEGMENT, WORKSPACE_TABS, type ShellSuiteId, type WorkspaceTabId } from "./ia";

/**
 * ⌘K (README › Navigation): Generate, suites, every page, Workspace, models,
 * assets, and "Ask Atomik: …". Enter runs the top hit. Pure ranking here; the
 * component supplies models and assets from live data.
 */
export type PaletteRun =
  | { type: "gen" }
  | { type: "suite"; suite: ShellSuiteId }
  | { type: "page"; suite: ShellSuiteId; page: string }
  | { type: "workspace"; tab: WorkspaceTabId }
  | { type: "model"; id: string }
  | { type: "asset"; id: string }
  | { type: "ask"; text: string };

export type PaletteRow = { group: string; label: string; hint: string; run: PaletteRun };

export const PALETTE_ROWS = 9;

export function paletteIndex(input: { models: { id: string; name: string; kind: string }[]; assets: { id: string; name: string; kind: string }[] }): PaletteRow[] {
  return [
    { group: "CREATE", label: "Generate", hint: "G", run: { type: "gen" } },
    ...HEADER_SEGMENT.filter((s) => s.id !== "gen").map((s): PaletteRow => ({ group: "SUITE", label: s.label, hint: s.title, run: { type: "suite", suite: s.id as ShellSuiteId } })),
    ...ALL_SHELL_PAGES.map(({ suite, page }): PaletteRow => ({ group: suite.label.toUpperCase(), label: `${page.n} ${page.title}`, hint: page.hint, run: { type: "page", suite: suite.id, page: page.id } })),
    ...WORKSPACE_TABS.map((t): PaletteRow => ({ group: "WORKSPACE", label: t.label, hint: "Workspace", run: { type: "workspace", tab: t.id } })),
    ...input.models.map((m): PaletteRow => ({ group: "MODEL", label: m.name, hint: m.kind, run: { type: "model", id: m.id } })),
    ...input.assets.map((a): PaletteRow => ({ group: "ASSET", label: a.name, hint: a.kind, run: { type: "asset", id: a.id } })),
  ];
}

/** Every word of the query must appear; label matches rank above group/hint matches, prefixes first. */
export function searchPalette(rows: PaletteRow[], query: string, limit = PALETTE_ROWS): PaletteRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice(0, limit);
  const words = q.split(/\s+/);
  const scored: { row: PaletteRow; score: number; i: number }[] = [];
  rows.forEach((row, i) => {
    const label = row.label.toLowerCase();
    const hay = `${label} ${row.group.toLowerCase()} ${row.hint.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    const bare = label.replace(/^\d+\s+/, "");
    const score = bare.startsWith(q) || label.startsWith(q) ? 0 : label.includes(q) ? 1 : words.every((w) => label.includes(w)) ? 2 : 3;
    scored.push({ row, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  const hits = scored.slice(0, limit - 1).map((s) => s.row);
  /* Whatever was typed can always be handed to the agent. */
  return [...hits, { group: "ATOMIK", label: `Ask Atomik: ${query.trim()}`, hint: "↵", run: { type: "ask", text: query.trim() } }];
}
