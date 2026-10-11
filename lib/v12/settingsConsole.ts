/**
 * Workspace settings, the new interface's console (prototype v14, README § V14.2), as data. Pure: no React, no fetch
 * (tests/unit/v12-settings-console.spec.ts). The screen is components/v12/settings/console; each section reads routes that
 * already serve it, and these turn their answers into the words the screen shows. No figure is typed here.
 */

export type ConsoleSection = "overview" | "people" | "billing" | "usage" | "defaults" | "rules" | "limits" | "workspace" | "profile" | "notifications";

export type ConsoleNavItem = { id: ConsoleSection; label: string; line: string };
export type ConsoleNavGroup = { label: string; items: ConsoleNavItem[] };

const ADMIN: ConsoleNavItem[] = [
  { id: "overview", label: "Overview", line: "Credits, spend and what’s running" },
  { id: "people", label: "People", line: "Invite teammates and set roles" },
  { id: "billing", label: "Credits & billing", line: "Plan, top-ups and history" },
  { id: "usage", label: "Usage", line: "Where the credits went" },
  { id: "defaults", label: "Defaults", line: "How new work starts" },
  { id: "rules", label: "Style rules", line: "House style for your prompts" },
  { id: "limits", label: "Limits", line: "Keep spend in check" },
  { id: "workspace", label: "Workspace", line: "Name, logo, danger zone" },
];
/** A member reads only these (the server enforces it: every admin read and write is an admin's). */
const MEMBER: ConsoleNavItem[] = [
  { id: "usage", label: "Your usage", line: "Your credits this month" },
  { id: "billing", label: "Plan", line: "What the workspace is on · read only" },
];
const ACCOUNT: ConsoleNavItem[] = [
  { id: "profile", label: "Profile", line: "Name and email" },
  { id: "notifications", label: "Notifications", line: "Ready, approvals, credits low" },
];

export const navFor = (admin: boolean): ConsoleNavGroup[] => [
  { label: "Your workspace", items: admin ? ADMIN : MEMBER },
  { label: "Your account", items: ACCOUNT },
];

const ALL: ConsoleSection[] = [...ADMIN, ...ACCOUNT].map((i) => i.id);
const MEMBER_OK: ConsoleSection[] = [...MEMBER, ...ACCOUNT].map((i) => i.id);

/** The section an address asks for, as this person may have it: a member asking for an admin's lands on Profile, an admin on Overview. */
export function sectionFor(raw: string | null | undefined, admin: boolean): ConsoleSection {
  const wanted = (ALL as string[]).includes(String(raw)) ? (raw as ConsoleSection) : null;
  if (admin) return wanted ?? "overview";
  return wanted && MEMBER_OK.includes(wanted) ? wanted : "profile";
}

export const TITLES: Record<ConsoleSection, { title: string; memberTitle?: string; sub: (ws: string) => string; memberSub?: string }> = {
  overview: { title: "Overview", sub: (ws) => `Credits, spend and what’s running in ${ws}.` },
  people: { title: "People", sub: (ws) => `Who is in ${ws}, and what they can do.` },
  billing: { title: "Credits & billing", memberTitle: "Plan", sub: (ws) => `Plan, top-ups and history for ${ws}.`, memberSub: "What this workspace is on. Admins change it." },
  usage: { title: "Usage", memberTitle: "Your usage", sub: () => "Where the credits went, by board and by person.", memberSub: "Where your credits went." },
  defaults: { title: "Defaults", sub: () => "How new work starts in this workspace. Anyone can change these per take." },
  rules: { title: "Style rules", sub: () => "House style for every prompt in this workspace." },
  limits: { title: "Limits", sub: () => "Keep spend in check. Caps apply to new boards from now." },
  workspace: { title: "Workspace", sub: () => "Name, logo and the things you cannot undo." },
  profile: { title: "Profile", sub: () => "You, across every workspace you belong to." },
  notifications: { title: "Notifications", sub: () => "What Particl tells you about." },
};

export const isAccountSection = (s: ConsoleSection): boolean => s === "profile" || s === "notifications";

/** "Today", "Yesterday", "3 d ago", or "Never": when someone was last seen. */
export function lastActive(at: number | null | undefined, now: number): string {
  if (!at) return "Never";
  const day = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} d ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** An invitation needs a name; the form asks for the address only, so the name is what comes before the @, tidied. */
export function nameFromEmail(email: string): string {
  const local = email.trim().split("@")[0] ?? "";
  const words = local.replace(/[._+-]+/g, " ").replace(/\d+/g, " ").split(/\s+/).filter(Boolean);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return (name || "Teammate").slice(0, 80);
}

/** "3 of 5 seats used", or "3 people" where the plan sets no limit. */
export function seatsLine(seats: { used: number; ceiling: number | null } | null | undefined, people: number): string {
  if (!seats) return `${people} ${people === 1 ? "person" : "people"}`;
  return seats.ceiling == null ? `${seats.used} ${seats.used === 1 ? "person" : "people"}` : `${seats.used} of ${seats.ceiling} seats used`;
}

/** The two months the Usage section lets you pick: this month and last (UTC, as the ledger counts them). */
export function monthChoices(now: number): { key: string; label: string }[] {
  const d = new Date(now);
  const at = (back: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
  const key = (x: Date) => x.toISOString().slice(0, 7);
  return [{ key: key(at(0)), label: "This month" }, { key: key(at(1)), label: "Last month" }];
}

/** Delete workspace asks for the name; the server checks it again (lib/deletion.ts). The button reads this only. */
export const deleteTypedOk = (typed: string, name: string): boolean => typed.trim() === name.trim() && name.trim().length > 0;

/** The shapes a new board can start in (lib/settingValues.ts ASPECT_OPTIONS: the server refuses any other). */
export { ASPECT_OPTIONS as ASPECTS } from "@/lib/settingValues";

type RateCellLike = { option: string; credits: number };
type RateRowLike = { engine: string; label: string; audio: boolean; cells: RateCellLike[] };
type RateGroupLike = { kind: "video" | "image"; axis: string; seconds: number | null; rows: RateRowLike[] };

/**
 * The engines Defaults offers for one kind, with today's price, from the rate card the server builds from the engine registry
 * (GET /api/billing `rates`: only engines this workspace's credits actually pay for, never a figure typed here). Each engine once,
 * at its usual size (1080p for a clip, 1K for a still, else its last listed), silent.
 */
export function enginePicks(groups: readonly RateGroupLike[] | null | undefined, kind: "video" | "image"): { id: string; label: string; credits: number; at: string }[] {
  const seen = new Set<string>();
  const out: { id: string; label: string; credits: number; at: string }[] = [];
  for (const group of groups ?? []) {
    if (group.kind !== kind) continue;
    for (const row of group.rows) {
      if (row.audio || seen.has(row.engine) || !row.cells.length) continue;
      seen.add(row.engine);
      const cell = row.cells.find((c) => c.option === (kind === "video" ? "1080p" : "1K")) ?? row.cells[row.cells.length - 1];
      out.push({ id: row.engine, label: row.label, credits: cell.credits, at: [cell.option, group.seconds ? `${group.seconds} s` : null].filter(Boolean).join(" · ") });
    }
  }
  return out;
}
