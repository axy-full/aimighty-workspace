/**
 * The desk's readouts (SOW surfaces board 12h), as pure text so a unit
 * test can read them without a browser. Nothing here knows a price: every
 * figure arrives from the platform's own routes.
 *
 * The lines the board draws — the sub-bar, the "starts with" line, dollars,
 * a margin, the month, the grant budget's room — are lib/adminView's, the
 * rule of record the routes and tests/unit/adminView.spec.ts read; this
 * module only re-exports them so the desk prints exactly what the tests
 * assert (the month is the cycle's UTC month, never the viewer's clock).
 * What stays here has no twin in the lib.
 */
export { subBarLine, defaultsLine, fmtUsd, fmtPct, monthLabel, grantBudgetRoom } from "@/lib/adminView";

/** `Send 3 codes`; `Send a code` for one; `Nobody waiting` for none. */
export function sendLabel(n: number): string {
  return n === 0 ? "Nobody waiting" : n === 1 ? "Send a code" : `Send ${n} codes`;
}

/** A price multiplier as the board prints it — `1.5×`. */
export function multiplierText(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "—";
  return `${m.toFixed(1)}×`;
}

/** Room left under a vendor's ceiling: the mono readout, and whether it is close enough to read in ink (used ≥ 70%). */
export function roomText(room: number | null | undefined): { text: string; near: boolean } {
  if (room == null || !Number.isFinite(room)) return { text: "—", near: false };
  const used = 1 - room;
  return { text: `${Math.round(room * 100)}% room`, near: used >= 0.7 - 1e-9 };
}
