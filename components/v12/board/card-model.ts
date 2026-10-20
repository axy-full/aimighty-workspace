import { REJECT_REASON_MAX, cleanRejectReason } from "@/components/graphite/board/cards/take/take-model";
import type { JudgeOptions } from "@/components/graphite/board/cards/take/use-judge";

/**
 * The card system's rules (design/particl-prototype-25, README "CARD SYSTEM"; v24 changes B, 5 to 11): one card for every step, with five
 * statuses everywhere, ✓ and ✕ on a card that is ready to judge, and ✕'s reasons ending in "Other". Pure: no React, no storage
 * (tests/unit/v25-card-model.spec.ts).
 *
 *   Not started · Making… · Ready (· vN when there is more than one) · ✓ Sent · ✕ <reason>
 *
 * "Sent" is the word for the review trail's "approved" mark (owner, 19 and 20 Oct 2026: "today's approved is a commit; the commit is Sent"; "Demo: the
 * card says Sent."). The data value stays "approved"; only the words a person reads say Sent.
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
    case "approved": return { text: "✓ Sent", tone: "done", dot: "done" };
    case "rejected": return { text: input.reason?.trim() ? `✕ ${input.reason.trim()}` : "✕", tone: "failed", dot: "failed" };
    case "ready": return { text: input.version && input.version > 1 ? `Ready · v${input.version}` : "Ready", tone: "muted", dot: "done" };
  }
}

/**
 * Whether ✓ and ✕ show on hover: a card that has something to judge (ready, approved or rejected, so a verdict can be changed), that the person
 * does not own (user-owned items have no ✓ / ✕), that an option step has not greyed out (v25: ✓ on one option picks it and greys the rest), and
 * whose ✓ and ✕ would do something (`acts: false` when the card was given nothing to call: a Ready upload, or a take with no picture here, is not
 * judged, and a mark that does nothing is not drawn).
 */
export function canJudge(input: { status: CardStatus; userOwned?: boolean; greyed?: boolean; acts?: boolean }): boolean {
  return input.acts !== false && !input.userOwned && !input.greyed && (input.status === "ready" || input.status === "approved" || input.status === "rejected");
}

/** The reasons ✕ offers: the step's own, always ending in "Other" (once). */
export function withOther(reasons: readonly string[]): string[] {
  return [...reasons.filter((r) => r !== "Other"), "Other"];
}

/**
 * What ✕ records: the reason picked and the optional line, "Look · warmer". "Other" with a line records the line; with no pick, the line alone. ("Other"
 * or no pick with nothing typed comes out as "Other", but `reasonProblem` never lets that be sent: Other needs a line.)
 */
export function rejectReason(pick: string | null, note: string): string {
  const line = note.trim();
  if (pick && pick !== "Other") return line ? `${pick} · ${line}` : pick;
  return line || "Other";
}

/** What the reasons panel says when Other (or no reason at all) is sent without a line (owner, 20 Oct 2026: ""Other" needs a line, one word is enough."). */
export const REASON_NEEDS_LINE = "Other needs a line: one word is enough.";

/** What the reasons panel says when a reason is too long (a chip and a full line can pass the limit). */
export const REASON_TOO_LONG = `Too long: ${REJECT_REASON_MAX} characters at most.`;

/**
 * Why ✕'s reason cannot be sent yet, or null. A chip other than Other sends with or without a line. Other, or no chip, needs a typed line: any word
 * will do, even one or two letters. Whatever is recorded is at most 500 characters. This is the v25 card's and preview's rule only; the take cards keep
 * the trail's own (take-model `rejectReasonProblem`, 3 to 500 characters).
 */
export function reasonProblem(pick: string | null, note: string): string | null {
  if ((!pick || pick === "Other") && !cleanRejectReason(note)) return REASON_NEEDS_LINE;
  return reasonTextProblem(rejectReason(pick, note));
}

/** The same rule on a reason as recorded (what the judge is handed): some words, at most 500 characters. */
export function reasonTextProblem(reason: string): string | null {
  const said = cleanRejectReason(reason);
  if (!said) return REASON_NEEDS_LINE;
  return said.length > REJECT_REASON_MAX ? REASON_TOO_LONG : null;
}

/** The judge's words and rule on the v25 card and preview: ✓'s toast says "sent", and a reason is checked by the rule above. Nothing it writes changes. */
export const V25_JUDGE: JudgeOptions = { approved: "sent", reasonProblem: reasonTextProblem };
