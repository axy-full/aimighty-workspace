import { STUDIO_RAIL } from "@/lib/board/regions";
import type { MakeTab } from "./make";
import { ALL_SHELL_PAGES, CREW_PAGES, SHELL_SUITES, WORKSPACE_TABS, type CrewPageId, type ShellSuiteId, type WorkspaceTabId } from "./ia";

/**
 * ⌘K (README › Navigation): Generate, suites, every page, Workspace, models,
 * assets, and "Ask Atomik: …". Enter runs the top hit. Pure ranking here; the
 * component supplies models and assets from live data.
 */
export type PaletteRun =
  /** Make, on one of its types (Video, Image, Audio) or quick tools (Motion transfer, Object swap). */
  | { type: "gen"; tool?: Exclude<MakeTab, "recent"> }
  | { type: "suite"; suite: ShellSuiteId }
  | { type: "page"; suite: ShellSuiteId; page: string }
  | { type: "workspace"; tab: WorkspaceTabId }
  | { type: "crew"; page: CrewPageId }
  | { type: "model"; id: string }
  | { type: "asset"; id: string }
  | { type: "ask"; text: string }
  /* The screens' places: README § 1.1. */
  | { type: "home" }
  | { type: "region"; region: string }
  /* The Ads and Social boards. */
  | { type: "board"; kind: "ads" | "social" }
  | { type: "atomik" }
  | { type: "control"; page: ControlPage }
  | { type: "settings"; section: SettingsSection };

export type PaletteRow = { group: string; label: string; hint: string; run: PaletteRun };

/** At most twelve rows, as the master lists (the last is always "Ask Atomik: …" once something is typed). */
export const PALETTE_ROWS = 12;

function rankPalette(rows: PaletteRow[], q: string, limit: number): PaletteRow[] {
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
  return scored.slice(0, limit).map((s) => s.row);
}

/* ── ⌘K in the new interface (README § 3.4; Atomik frames a–e) ─────────────────────────────────── */

/** The control room's four places (stream 8), by the shell's page ids. */
export type ControlPage = "approvals" | "runs" | "saved-skills" | "memory";
/** Settings' five sections (README § 3.5; stream 9's ids). */
export type SettingsSection = "team" | "credits" | "rules" | "connections" | "advanced";

export const CONTROL_PLACES: readonly { page: ControlPage; label: string }[] = [
  { page: "approvals", label: "Approvals" }, { page: "runs", label: "Activity" }, { page: "saved-skills", label: "Skills" }, { page: "memory", label: "Memory" },
];
export const SETTINGS_SECTIONS: readonly { section: SettingsSection; label: string }[] = [
  { section: "team", label: "Team" }, { section: "credits", label: "Plan & credits" }, { section: "rules", label: "Spending rules" },
  { section: "connections", label: "Connections" }, { section: "advanced", label: "Advanced" },
];

/**
 * The new interface's index, in the master's order: Home; the board's rail; Make; Atomik (with the control room's
 * places); Settings' sections; then models and assets from live data. With nothing typed the first twelve show.
 */
export function newPaletteIndex(input: {
  rail: readonly { id: string; label: string }[];
  models: { id: string; name: string; kind: string }[];
  assets: { id: string; name: string; kind: string }[];
}): PaletteRow[] {
  return [
    { group: "Home", label: "Home", hint: "What needs you", run: { type: "home" } },
    ...input.rail.map((r): PaletteRow => ({ group: "Board", label: r.label, hint: "", run: { type: "region", region: r.id } })),
    { group: "Board", label: "Ads", hint: "", run: { type: "board", kind: "ads" } },
    { group: "Board", label: "Social", hint: "", run: { type: "board", kind: "social" } },
    { group: "Make", label: "Video", hint: "Make", run: { type: "gen", tool: "video" } },
    { group: "Make", label: "Image", hint: "Make", run: { type: "gen", tool: "image" } },
    { group: "Make", label: "Audio", hint: "Make", run: { type: "gen", tool: "audio" } },
    { group: "Make", label: "Motion transfer", hint: "One source video and references", run: { type: "gen", tool: "motion" } },
    { group: "Make", label: "Object swap", hint: "One element replaced", run: { type: "gen", tool: "swap" } },
    { group: "Atomik", label: "Atomik", hint: CONTROL_PLACES.map((p) => p.label).join(" · "), run: { type: "atomik" } },
    ...CONTROL_PLACES.map((p): PaletteRow => ({ group: "Atomik", label: p.label, hint: "Control room", run: { type: "control", page: p.page } })),
    ...SETTINGS_SECTIONS.map((s): PaletteRow => ({ group: "Settings", label: s.label, hint: "", run: { type: "settings", section: s.section } })),
    ...input.models.map((m): PaletteRow => ({ group: "Model", label: m.name, hint: m.kind, run: { type: "model", id: m.id } })),
    ...input.assets.map((a): PaletteRow => ({ group: "Asset", label: a.name, hint: a.kind, run: { type: "asset", id: a.id } })),
  ];
}

/**
 * The new interface's hits: the same ranking, at most twelve, with no "Ask Atomik" row (Atomik answers in the card
 * under the list). A "go to <place>" that names a rail entry puts "Go to <place>" first.
 */
export function searchNewPalette(rows: PaletteRow[], query: string, opts: { goTo?: { id: string; label: string } | null; board?: string } = {}): PaletteRow[] {
  const q = query.trim().toLowerCase();
  /* With nothing typed: every place the design lists (Home, the board, Make's types and tools, Atomik, Settings), never models or assets. */
  if (!q) return rows.filter((r) => r.run.type !== "model" && r.run.type !== "asset" && r.run.type !== "control");
  const hits = rankPalette(rows, q, PALETTE_ROWS);
  if (!opts.goTo) return hits;
  const pinned: PaletteRow = { group: "Board", label: `Go to ${opts.goTo.label}`, hint: `On the ${opts.board ?? "Studio"} board`, run: { type: "region", region: opts.goTo.id } };
  return [pinned, ...hits.filter((h) => !(h.run.type === "region" && h.run.region === opts.goTo!.id))].slice(0, PALETTE_ROWS);
}
