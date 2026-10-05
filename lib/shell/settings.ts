import type { ScreenModule } from "./screens";
import type { Row } from "./screen-rows";

/**
 * Settings behind the avatar (design/particl-graphite/README.md § 1, § 3.5): five sections at
 * `?view=workspace&tab=<id>` (the design file writes `ws=<id>`; `ws` is the workspace a link was
 * copied in here, lib/shell/asset-link.ts, so the shell's spelling is `tab`), and `open=<fold>` for
 * the fold a link unfolds (`&open=models`).
 *
 * Pure (no React, no fetch), like lib/shell/make.ts: the shell's redirects and params
 * (lib/shell/screens.ts, lib/shell/ia.ts, lib/shell/state.tsx) and the Settings screen
 * (components/graphite/settings/) read the same ids from here.
 */

export type SettingsSectionId = "team" | "credits" | "rules" | "connections" | "advanced";

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string }[] = Object.freeze([
  { id: "team", label: "Team" },
  { id: "credits", label: "Plan & credits" },
  { id: "rules", label: "Spending rules" },
  { id: "connections", label: "Connections" },
  { id: "advanced", label: "Advanced" },
]);

/** The sections this build draws. The rest still open the page that holds them today (SETTINGS_INTERIM). */
export const SETTINGS_BUILT: readonly SettingsSectionId[] = Object.freeze(["team", "credits"]);

export const isSettingsSection = (value: unknown): value is SettingsSectionId => SETTINGS_SECTIONS.some((s) => s.id === value);
export const isBuiltSection = (value: unknown): value is SettingsSectionId => isSettingsSection(value) && SETTINGS_BUILT.includes(value);
export const sectionLabel = (id: SettingsSectionId): string => SETTINGS_SECTIONS.find((s) => s.id === id)!.label;

/** The fold a link unfolds: `?view=workspace&tab=team&open=security`. */
export const SETTINGS_OPEN_PARAM = "open";
export type SettingsFold = "security" | "packs" | "history" | "usage" | "statements" | "rates" | "models" | "tools" | "workspace";
export const SETTINGS_FOLDS: readonly SettingsFold[] = Object.freeze(["security", "packs", "history", "usage", "statements", "rates", "models", "tools", "workspace"]);
export const isSettingsFold = (value: unknown): value is SettingsFold => SETTINGS_FOLDS.includes(value as SettingsFold);

/** The fold an address asks for, or null (missing, or not a fold Settings has). */
export function readSettingsOpen(search: string | URLSearchParams): SettingsFold | null {
  const value = (typeof search === "string" ? new URLSearchParams(search) : search).get(SETTINGS_OPEN_PARAM);
  return isSettingsFold(value) ? value : null;
}

/**
 * Where a section not drawn yet opens: the page that holds it today, the same places the
 * avatar menu opened before Settings (D0 PR 3a). A section leaves this list in the PR that draws it.
 */
export type SettingsTarget =
  | { kind: "section"; section: SettingsSectionId; open?: SettingsFold }
  | { kind: "workspace"; tab: "engines" | "general" }
  | { kind: "suite"; suite: "atomik"; page: "budget" | "skills" | "models" };
export const SETTINGS_INTERIM: Readonly<Partial<Record<SettingsSectionId, SettingsTarget>>> = Object.freeze({
  rules: { kind: "suite", suite: "atomik", page: "budget" },
  connections: { kind: "suite", suite: "atomik", page: "skills" },
  advanced: { kind: "workspace", tab: "engines" },
});
/** Where pressing a section (the segment, the avatar menu) goes in this build. */
export function sectionTarget(id: SettingsSectionId, open?: SettingsFold): SettingsTarget {
  return isBuiltSection(id) ? { kind: "section", section: id, ...(open ? { open } : {}) } : SETTINGS_INTERIM[id]!;
}

/**
 * Workspace's seven tabs (README § 1.2) and the section each now lives in: Team (people, security),
 * Plan & credits (credits, usage), Advanced (engines, general). Dashboard became Activity, in
 * Atomik's control room (stream 8).
 */
export const OLD_TAB_TO_SECTION: Readonly<Record<"general" | "people" | "credits" | "usage" | "dashboard" | "engines" | "security", { section: SettingsSectionId; open?: SettingsFold } | { activity: true }>> = Object.freeze({
  people: { section: "team" },
  security: { section: "team", open: "security" },
  credits: { section: "credits" },
  usage: { section: "credits", open: "usage" },
  engines: { section: "advanced", open: "models" },
  general: { section: "advanced", open: "workspace" },
  dashboard: { activity: true },
});

const ws = (tab: string, open?: string) => `?view=workspace&tab=${tab}${open ? `&open=${open}` : ""}`;
const interimHref = (t: SettingsTarget): string =>
  t.kind === "suite" ? `?suite=${t.suite}&page=${t.page}` : t.kind === "workspace" ? ws(t.tab) : ws(t.section, t.open);

/**
 * The shell's rows (lib/shell/screens.ts): with the switch on, an old tab opens its section, and a
 * section not drawn yet opens today's page; with it off, every section opens today's page.
 * `from` matches as a subset of the address, `to` replaces those params, the rest ride along.
 */
const ON_ROWS: Row[] = [
  ...(["people", "security", "credits", "usage"] as const).flatMap((tab): Row[] => {
    const at = OLD_TAB_TO_SECTION[tab] as { section: SettingsSectionId; open?: SettingsFold };
    return isBuiltSection(at.section) && tab !== at.section ? [{ from: ws(tab), to: ws(at.section, at.open) }] : [];
  }),
  ...SETTINGS_SECTIONS.flatMap(({ id }): Row[] => (isBuiltSection(id) ? [] : [{ from: ws(id), to: interimHref(SETTINGS_INTERIM[id]!) }])),
  ...(isBuiltSection("advanced") ? [] : [{ from: ws("advanced", "models"), to: "?suite=atomik&page=models" }]),
  /* Atomik's Budget, Models and Tools pages are Settings sections once those sections are drawn (README § 1.2). */
  ...([["budget", "rules"], ["models", "advanced", "models"], ["skills", "connections"]] as const).flatMap(([page, section, open]): Row[] =>
    isBuiltSection(section) ? [{ from: `?suite=atomik&page=${page}`, to: ws(section, open) }] : []),
];
const OFF_ROWS: Row[] = [
  { from: ws("team"), to: ws("people") },
  { from: ws("team", "security"), to: ws("security") },
  { from: ws("credits", "usage"), to: ws("usage") },
  ...SETTINGS_SECTIONS.flatMap(({ id }): Row[] => (SETTINGS_INTERIM[id] ? [{ from: ws(id), to: interimHref(SETTINGS_INTERIM[id]!) }] : [])),
  { from: ws("advanced", "models"), to: "?suite=atomik&page=models" },
];

export const SETTINGS_SCREEN: ScreenModule = Object.freeze({
  id: "settings",
  landed: true,
  params: [SETTINGS_OPEN_PARAM],
  rows: ON_ROWS,
  fallback: OFF_ROWS,
});

/** The shell's row rule (lib/shell/screen-rows.ts), kept under this name for the Settings specs. */
export { applyRows } from "./screen-rows";
