import type { ScreenModule } from "./shell/screens";

/**
 * The platform console (`?view=admin`, prototype 14 › "Platform console"): the platform owner's desk, in the new interface's
 * frame. Pure (no React, no fetch), like lib/shell/settings.ts: the shell's address rules and the console's screens read the
 * same ids from here. The routes behind it (app/api/admin/*) answer 403 to everyone but the platform owner; this module
 * only names the places.
 *
 * Addresses: `?view=admin` (Overview), `&section=<id>`, and `&sheet=<workspace id>` on All workspaces for the side sheet
 * (the prototype writes `ws=`; that is the shell's own param for the workspace a take's link was copied in, lib/shell/asset-link.ts).
 * The section ids are the prototype's (`access`, `site`, `engines`, `caps`, `risk` …); the labels are prototype 14's plain ones.
 */
export type PlatformSectionId = "overview" | "access" | "site" | "workspaces" | "engines" | "rules" | "caps" | "plans" | "risk";

export type PlatformSection = {
  id: PlatformSectionId;
  /** The plain label. */
  label: string;
  /** The one grey line under it. */
  line: string;
  /** The small-caps group it sits under, or null for the first item. */
  group: "PEOPLE" | "DEFAULTS" | "HEALTH" | null;
};

export const PLATFORM_SECTIONS: readonly PlatformSection[] = Object.freeze([
  { id: "overview", label: "Overview", line: "How the platform is doing", group: null },
  { id: "access", label: "Who can join", line: "Invitations and requests", group: "PEOPLE" },
  { id: "site", label: "Public site", line: "Sign-up and visitor pages", group: "PEOPLE" },
  { id: "workspaces", label: "All workspaces", line: "Credits, pause and resume", group: "PEOPLE" },
  { id: "engines", label: "AI models", line: "Default engines and text models", group: "DEFAULTS" },
  { id: "rules", label: "Style rules", line: "What the prompt writer is told", group: "DEFAULTS" },
  { id: "caps", label: "Limits", line: "What every new workspace starts with", group: "DEFAULTS" },
  { id: "plans", label: "Plans & prices", line: "What customers can choose", group: "DEFAULTS" },
  { id: "risk", label: "Failed saves", line: "Renders with no stored copy", group: "HEALTH" },
] as const);

export const PLATFORM_SECTION_PARAM = "section";
/** The workspace whose side sheet is open on All workspaces. */
export const PLATFORM_SHEET_PARAM = "sheet";

export const isPlatformSection = (value: unknown): value is PlatformSectionId => PLATFORM_SECTIONS.some((s) => s.id === value);
/** The section an address names; Overview for none or one this build does not have. */
export function readPlatformSection(search: string | URLSearchParams): PlatformSectionId {
  const value = (typeof search === "string" ? new URLSearchParams(search) : search).get(PLATFORM_SECTION_PARAM);
  return isPlatformSection(value) ? value : "overview";
}
export const platformAddress = (section: PlatformSectionId = "overview", sheet?: string | null): string => {
  const q = new URLSearchParams({ view: "admin" });
  if (section !== "overview") q.set(PLATFORM_SECTION_PARAM, section);
  if (sheet && section === "workspaces") q.set(PLATFORM_SHEET_PARAM, sheet);
  return `?${q.toString()}`;
};

/** The providers' own names, for the text-model pickers. */
export const PLATFORM_TEXT_PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({ anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI" });
/** The pickers' group order. */
export const PLATFORM_TEXT_PROVIDER_ORDER: readonly string[] = Object.freeze(["anthropic", "openai", "google", "xai"]);

/** The screen's registry entry (lib/shell/screens.ts). It owns `section` and `sheet`. */
export const PLATFORM_SCREEN: ScreenModule = Object.freeze({
  id: "platform",
  landed: true,
  params: [PLATFORM_SECTION_PARAM, PLATFORM_SHEET_PARAM],
  rows: [],
  fallback: [],
});
