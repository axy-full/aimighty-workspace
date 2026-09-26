/**
 * The values a workspace setting may hold, for the ones the server reads as a
 * fixed vocabulary. One list serves the settings route (which refuses anything
 * else) and every screen that offers the choice, so a screen can never save a
 * value the gate does not understand.
 *
 * `approvalRule` is read by lib/approvalRule.ts (`cleanRule`), `atCap` and
 * `capWarnPct` by lib/caps.ts, `editOutputFormat` by lib/generationAdmission.ts.
 */
import type { ApprovalRule } from "./approvalRule";

export const APPROVAL_OPTIONS: readonly (readonly [ApprovalRule, string])[] = [
  ["anyone", "Members render freely"],
  ["cap", "An admin presses past the per-shot cap"],
  ["producer", "A producer signs off on every take"],
];

/** The container an edit or extension comes back in; no other delivery reads it. */
export const EDIT_FORMAT_OPTIONS: readonly (readonly [string, string])[] = [
  ["mp4", "MP4"],
  ["mov", "MOV"],
];

export const AT_CAP_OPTIONS: readonly (readonly [string, string])[] = [
  ["producer", "Producer unlocks"],
  ["stop", "Stop rendering"],
  ["warn", "Warn only"],
];

export const CAP_WARN_OPTIONS: readonly (readonly [string, string])[] = [50, 70, 80, 90].map((n) => [String(n), `${n}% of the cap`] as const);

const allowed = (options: readonly (readonly [string, string])[], value: unknown) => options.some(([v]) => v === String(value));

/** Why a value cannot be stored under this key, or null when it can. */
export function settingProblem(key: string, value: unknown): string | null {
  switch (key) {
    case "approvalRule": return allowed(APPROVAL_OPTIONS, value) ? null : "Choose anyone, cap or producer.";
    case "editOutputFormat": return allowed(EDIT_FORMAT_OPTIONS, value) ? null : "Choose mp4 or mov.";
    case "atCap": return allowed(AT_CAP_OPTIONS, value) ? null : "Choose producer, stop or warn.";
    case "capWarnPct": {
      const n = Number(value);
      return String(value).trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 100 ? null : "The warning is a whole percentage from 1 to 100.";
    }
    default: return null;
  }
}
