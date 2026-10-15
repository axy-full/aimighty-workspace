/**
 * The closed list of reasons a take is sent back for (owner, 14 Oct 2026; docs/plans/step-0-data.md item 2), as codes, so a later step can learn from them: rejects by reason, per
 * engine. Each code has its one label for the screen (one vocabulary): the five chips the board's reject panel already shows map one to one, and nothing is merged or renamed.
 *
 * Codes and timings only: analytics read the codes, never the person's own words, which stay in the take's notes (rule 17).
 */
export const REJECT_REASONS = ["off_brief", "framing", "motion", "drift", "artifacts", "audio", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** The one label each reason has on a screen. The first five are today's chips, word for word. */
export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  off_brief: "Off the brief",
  framing: "Wrong framing",
  motion: "Motion looks wrong",
  drift: "Look or face drifted",
  artifacts: "Artifacts",
  audio: "Sound or lip-sync is wrong",
  other: "Other",
};

/** A drifted look can say what drifted: the checks the Verify judge already scores (lib/workbench/verify.ts). Optional. */
export const DRIFT_DETAILS = ["identity", "wardrobe", "environment", "props"] as const;
export type DriftDetail = (typeof DRIFT_DETAILS)[number];

export const isRejectReason = (value: unknown): value is RejectReason => typeof value === "string" && (REJECT_REASONS as readonly string[]).includes(value);
export const isDriftDetail = (value: unknown): value is DriftDetail => typeof value === "string" && (DRIFT_DETAILS as readonly string[]).includes(value);

/** What a request may say about why: reason codes and a drift detail, checked. `reasons` absent or empty is no reason (they are optional on the server). */
export type ReasonInput = { reasons: RejectReason[]; drift: DriftDetail | null };

export function cleanReasons(reasons: unknown, drift: unknown): { ok: true; value: ReasonInput } | { ok: false; error: string } {
  const list = reasons === undefined || reasons === null ? [] : reasons;
  if (!Array.isArray(list) || list.length > REJECT_REASONS.length) return { ok: false, error: "Reasons are a short list of codes." };
  if (!list.every(isRejectReason)) return { ok: false, error: "Unknown reason." };
  const codes = REJECT_REASONS.filter((code) => list.includes(code));
  if (drift !== undefined && drift !== null) {
    if (!isDriftDetail(drift)) return { ok: false, error: "Unknown drift detail." };
    if (!codes.includes("drift")) return { ok: false, error: "A drift detail goes with the drift reason." };
  }
  return { ok: true, value: { reasons: codes, drift: (drift ?? null) as DriftDetail | null } };
}
