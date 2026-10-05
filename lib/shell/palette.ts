import { BOARD_REGIONS, SETTINGS_SECTIONS, type SettingsSectionId, type ShellSuiteId } from "./ia";

/**
 * ⌘K (design/particl-graphite/README.md § 3.4): exactly what the design lists. Home; the board's regions (Brief, Looks,
 * Storyboard, Shots, Cast, Cut, Deliver) with Ads and Social; Make and its modes; Atomik and its four places (Approvals,
 * Activity, Skills, Memory); the Settings sections; the person's own assets; and "Ask Atomik: …". Until the board lands a region
 * opens today's nearest page (lib/shell/ia.ts › BOARD_REGIONS). Enter runs the top hit. Pure ranking here; the component supplies
 * the assets from live data.
 */
export type MakeMode = "video" | "image" | "audio" | "recent" | "motion" | "swap";
/** Make's modes, in the order the design draws them; Motion transfer and Object swap are modes of Make. */
export const MAKE_MODES: { id: MakeMode; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "image", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "recent", label: "Recent" },
  { id: "motion", label: "Motion transfer" },
  { id: "swap", label: "Object swap" },
];

export type PaletteRun =
  | { type: "home" }
  | { type: "make"; mode: MakeMode | null }
  | { type: "suite"; suite: ShellSuiteId }
  | { type: "page"; suite: ShellSuiteId; page: string }
  | { type: "settings"; section: SettingsSectionId }
  | { type: "asset"; id: string }
  | { type: "ask"; text: string };

export type PaletteRow = { group: string; label: string; hint: string; run: PaletteRun };

/** At most twelve rows, as the master lists (the last is always "Ask Atomik: …" once something is typed). */
export const PALETTE_ROWS = 12;

/** Atomik's four places in the control room (README § 3.4), each on today's page for it. */
const ATOMIK_PLACES: { label: string; page: string }[] = [
  { label: "Approvals", page: "approvals" },
  { label: "Activity", page: "runs" },
  { label: "Skills", page: "saved-skills" },
  { label: "Memory", page: "memory" },
];

export function paletteIndex(input: { assets: { id: string; name: string; kind: string }[] }): PaletteRow[] {
  return [
    { group: "HOME", label: "Home", hint: "What needs you", run: { type: "home" } },
    ...BOARD_REGIONS.map((r): PaletteRow => ({ group: "BOARD", label: r.label, hint: "", run: { type: "page", suite: r.opens.suite, page: r.opens.page } })),
    /* Ads and Social are boards too (templates picked on Home); until their boards ship they open today's first page for each. */
    { group: "BOARD", label: "Ads", hint: "", run: { type: "suite", suite: "business" } },
    { group: "BOARD", label: "Social", hint: "", run: { type: "suite", suite: "viral" } },
    { group: "MAKE", label: "Make", hint: "", run: { type: "make", mode: null } },
    { group: "ATOMIK", label: "Atomik", hint: ATOMIK_PLACES.map((p) => p.label).join(" · "), run: { type: "suite", suite: "atomik" } },
    ...MAKE_MODES.map((m): PaletteRow => ({ group: "MAKE", label: `Make › ${m.label}`, hint: "", run: { type: "make", mode: m.id } })),
    ...ATOMIK_PLACES.map((p): PaletteRow => ({ group: "ATOMIK", label: `Atomik › ${p.label}`, hint: "", run: { type: "page", suite: "atomik", page: p.page } })),
    ...SETTINGS_SECTIONS.map((t): PaletteRow => ({ group: "SETTINGS", label: t.label, hint: "Settings", run: { type: "settings", section: t.id } })),
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
