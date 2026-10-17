import { cycleBounds } from "./cycle";

/**
 * A workspace's own spend settings (v30 Phase A, PR A4; docs/plans/v30-data-model.md § 4.6). Pure: no database.
 *
 *   - **Monthly spend limit**, in whole credits, or none. Its period is the calendar month in UTC, the same month the
 *     house cap and a token's monthly ceiling turn on (lib/cycle.ts, anchor day 1; owner, 17 Oct, item 17).
 *   - **Paused**: none, or when, by whom and why (`admin`: a person paused it; `limit`: the server, on reaching the
 *     limit).
 *   - **Ask before every take**: on or off; off unless a workspace turns it on (owner, 17 Oct, item 3).
 *
 * From the owner's update two (17 Oct, item 5): the house keeps its cap in dollars as today, so this credit limit is
 * refused there; only the workspace's owner raises the limit (or removes it); and a limit pause lifts when the next
 * calendar month starts, UTC (`pauseLifted`). All three are stored state only.
 *
 * STORED ONLY. Nothing in today's quote, admission, reservation, metering or Ask/Auto reads these, and a test keeps it
 * so (tests/unit/spendSettings.spec.ts). They are the workspace admin's own choice, in credits, and are not the
 * platform owner's walls: not `workspaces.allowance_usd` (lib/allowance.ts, the platform's monthly dollar ceiling on
 * its keys), not `workspaces.suspended_at` (lib/platform.ts), not a production's budget pause (lib/budgetPause.ts),
 * and not today's Ask/Auto (lib/atomik.ts AgentMode, lib/workbench/rig-agent-limits.ts).
 */

/** The deployment switch: on only when exactly "1", and then only for a workspace on the new interface. */
export const SPEND_SETTINGS_FLAG = "V30_SPEND_LIMIT";
export const spendSettingsSwitchOn = (env: Record<string, string | undefined> = process.env): boolean => env[SPEND_SETTINGS_FLAG] === "1";

/**
 * Where each one is kept: keys in the workspace's own `settings` table (one database per workspace). They are not in
 * lib/settings.ts DEFAULTS, so the general settings route neither sends nor accepts them; lib/settings.ts lists them
 * in INTERNAL_SETTING_KEYS so that a stored value is never sent by it either. Only lib/spendSettings.server.ts writes
 * them, with an audit line in the same batch.
 */
export const SPEND_SETTING_KEYS = {
  limit: "monthlySpendLimitCredits",
  pause: "spendPause",
  ask: "askBeforeEveryTake",
} as const;
export const SPEND_SETTING_STORE_KEYS: readonly string[] = Object.values(SPEND_SETTING_KEYS);

/** What the house workspace is told: its cap is the platform owner's, in dollars (lib/allowance.ts), not this credit limit. */
export const HOUSE_LIMIT_REFUSAL = "The house workspace's cap is in dollars and is set by the platform owner.";

/** A limit is a whole number of credits in this range. */
export const SPEND_LIMIT_MIN_CREDITS = 1;
export const SPEND_LIMIT_MAX_CREDITS = 10_000_000;

/** Who or what paused: a person (`admin`) or the server on reaching the limit (`limit`). The only reasons ever written. */
export type SpendPauseReason = "admin" | "limit";
/** As read: also `unreadable`, a stored value this writer never makes, read as paused (fail closed). */
export type SpendPause = { at: number; by: string | null; reason: SpendPauseReason | "unreadable" };
export type WrittenPause = { at: number; by: string | null; reason: SpendPauseReason };
export type SpendSettings = {
  /** Whole credits a month; null is no limit. */
  monthlyLimitCredits: number | null;
  /** Null is running. */
  pause: SpendPause | null;
  askBeforeEveryTake: boolean;
};

export const SPEND_SETTINGS_DEFAULT: Readonly<SpendSettings> = Object.freeze({ monthlyLimitCredits: null, pause: null, askBeforeEveryTake: false });

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export function validLimit(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= SPEND_LIMIT_MIN_CREDITS && n <= SPEND_LIMIT_MAX_CREDITS;
}

/** The stored limit: digits only, in range; anything else (blank included) is no limit. */
export function storedLimit(raw: string | undefined): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,8}$/.test(text)) return null;
  const n = Number(text);
  return validLimit(n) ? n : null;
}

/**
 * The stored pause: blank is running. A value that is not blank but is not a pause this writer makes FAILS CLOSED:
 * it reads as paused, reason `unreadable`, so a damaged row can never read as running. An admin's resume clears it.
 */
export const UNREADABLE_PAUSE: Readonly<SpendPause> = Object.freeze({ at: 0, by: null, reason: "unreadable" });
export function storedPause(raw: string | undefined): SpendPause | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ...UNREADABLE_PAUSE };
    if (!Number.isSafeInteger(v.at) || (v.at as number) < 0) return { ...UNREADABLE_PAUSE };
    if (v.reason !== "admin" && v.reason !== "limit") return { ...UNREADABLE_PAUSE };
    if (v.by !== null && !(typeof v.by === "string" && ID.test(v.by))) return { ...UNREADABLE_PAUSE };
    return { at: v.at as number, by: v.by as string | null, reason: v.reason };
  } catch {
    return { ...UNREADABLE_PAUSE };
  }
}

export const storedAsk = (raw: string | undefined): boolean => raw === "on";

/**
 * A pause the server made on reaching the limit lasts until the month turns (owner, 17 Oct, update two, item 5): one
 * recorded in an earlier calendar month (UTC) than `at` reads as running from the first moment of the new month. A
 * person's pause, and an unreadable row, never lift by themselves; nor does a "limit" pause naming a person, which the
 * writer never makes (its limit pause is always `by: null`). Read-only: lifting writes nothing and leaves no resume
 * line. Stored state only: nothing that spends reads it.
 */
export function pauseLifted(pause: SpendPause | null, at: number): boolean {
  return pause?.reason === "limit" && pause.by === null && pause.at < spendLimitPeriod(at).start;
}

/** The settings as stored at `at`, each key read on its own; a key never written reads as its default. */
export function spendSettingsFrom(stored: Record<string, string | undefined>, at: number): SpendSettings {
  const pause = storedPause(stored[SPEND_SETTING_KEYS.pause]);
  return {
    monthlyLimitCredits: storedLimit(stored[SPEND_SETTING_KEYS.limit]),
    pause: pauseLifted(pause, at) ? null : pause,
    askBeforeEveryTake: storedAsk(stored[SPEND_SETTING_KEYS.ask]),
  };
}

/**
 * Whether a change of limit RAISES it, which only the workspace's owner may do (owner, update two, item 5): a higher
 * number, or no limit where there was one. A first limit (none before) and a lower one are any admin's.
 */
export function raisesLimit(from: number | null, to: number | null): boolean {
  if (to === null) return from !== null;
  return from !== null && to > from;
}

export const limitValue = (n: number | null): string => (n == null ? "" : String(n));
export const pauseValue = (p: WrittenPause | null): string => (p == null ? "" : JSON.stringify({ at: p.at, by: p.by, reason: p.reason }));
export const askValue = (on: boolean): string => (on ? "on" : "off");

/** The settings as a member who is not an admin is sent them: the pause without the account id of whoever paused. */
export type MemberSpendPause = Omit<SpendPause, "by">;
export function forMember<T extends SpendSettings>(settings: T): Omit<T, "pause"> & { pause: MemberSpendPause | null } {
  return { ...settings, pause: settings.pause ? { at: settings.pause.at, reason: settings.pause.reason } : null };
}

/** The month a limit counts in: the calendar month in UTC that `at` falls in, `[start, end)`. */
export function spendLimitPeriod(at: number): { start: number; end: number } {
  return cycleBounds(1, at);
}

/** What a person may ask to change. `paused: true` pauses (reason `admin`); `paused: false` resumes, whatever paused it. */
export type SpendSettingsPatch = { monthlyLimitCredits?: number | null; paused?: boolean; askBeforeEveryTake?: boolean };

const PATCH_KEYS = ["monthlyLimitCredits", "paused", "askBeforeEveryTake"] as const;

/** Reads a change as sent. Strict: an unknown key (a workspace id among them) or a malformed value refuses the whole change. */
export function parseSpendPatch(body: unknown): { patch: SpendSettingsPatch; error?: never } | { patch?: never; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send the settings to change." };
  const entries = Object.entries(body as Record<string, unknown>);
  if (!entries.length) return { error: "Nothing to change." };
  const patch: SpendSettingsPatch = {};
  for (const [key, value] of entries) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return { error: "Not a spend setting." };
    if (key === "monthlyLimitCredits") {
      if (value !== null && !validLimit(value)) return { error: `A monthly limit is a whole number of credits from ${SPEND_LIMIT_MIN_CREDITS} to ${SPEND_LIMIT_MAX_CREDITS.toLocaleString("en-US")}, or none.` };
      patch.monthlyLimitCredits = value as number | null;
    } else {
      if (typeof value !== "boolean") return { error: key === "paused" ? "Paused is on or off." : "Ask before every take is on or off." };
      patch[key as "paused" | "askBeforeEveryTake"] = value;
    }
  }
  return { patch };
}
