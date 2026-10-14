/**
 * The card system's rules (design/particl-prototype-25, README "CARD SYSTEM"; v24 changes B, 5 to 11): one card for every step, with five
 * statuses everywhere, ✓ and ✕ on a card that is ready to judge, and ✕'s reasons ending in "Other". Pure: no React, no storage
 * (tests/unit/v25-card-model.spec.ts).
 *
 *   Not started · Making… · Ready (· vN when there is more than one) · ✓ Approved · ✕ <reason>
 */
export type CardStatus = "none" | "making" | "ready" | "approved" | "rejected";

/** How a status line is drawn: the dot's colour and the text's, by tone. */
export type StatusTone = "muted" | "accent" | "done" | "failed";

export type StatusLine = { text: string; tone: StatusTone; dot: StatusTone };

/**
 * The one status line under a card's title. `own` is the line of an item the person owns (a brand kit, a reference ad, a source clip): it has no
 * status of its own, so the card says what it is, in the muted tone. A rejected card without a reason says only "✕".
 */
export function statusLine(input: { status: CardStatus; version?: number; reason?: string; own?: string }): StatusLine {
  if (input.own !== undefined) return { text: input.own, tone: "muted", dot: "muted" };
  switch (input.status) {
    case "none": return { text: "Not started", tone: "muted", dot: "muted" };
    case "making": return { text: "Making…", tone: "muted", dot: "accent" };
    case "approved": return { text: "✓ Approved", tone: "done", dot: "done" };
    case "rejected": return { text: input.reason?.trim() ? `✕ ${input.reason.trim()}` : "✕", tone: "failed", dot: "failed" };
    case "ready": return { text: input.version && input.version > 1 ? `Ready · v${input.version}` : "Ready", tone: "muted", dot: "done" };
  }
}

/**
 * Whether ✓ and ✕ show on hover: a card that has something to judge (ready, approved or rejected, so a verdict can be changed), that the person
 * does not own (user-owned items have no ✓ / ✕), and that an option step has not greyed out (v25: ✓ on one option picks it and greys the rest).
 */
export function canJudge(input: { status: CardStatus; userOwned?: boolean; greyed?: boolean }): boolean {
  return !input.userOwned && !input.greyed && (input.status === "ready" || input.status === "approved" || input.status === "rejected");
}

/** The reasons ✕ offers: the step's own, always ending in "Other" (once). */
export function withOther(reasons: readonly string[]): string[] {
  return [...reasons.filter((r) => r !== "Other"), "Other"];
}

/**
 * What ✕ records: the reason picked and the optional line, "Look · warmer". "Other" with a line records the line; "Other" with nothing records "Other";
 * with no pick, the line alone, or "Other".
 */
export function rejectReason(pick: string | null, note: string): string {
  const line = note.trim();
  if (pick && pick !== "Other") return line ? `${pick} · ${line}` : pick;
  return line || "Other";
}
