import type { ShotTakes, ShotVersion } from "@/components/graphite/board/cards/take/take-model";
import { REJECT_CHIPS, judgeable } from "@/components/graphite/board/cards/take/take-model";
import type { CardStatus } from "./card-model";

/**
 * A shot's takes as the v25 card reads them (PR 5: "the five statuses read from takes"). Pure: no React, no fetch (tests/unit/v25-shot-card.spec.ts).
 *
 *   Making…   a take is rendering or held for credits
 *   Ready     a finished take no one has judged (picked, uploaded and review all read Ready; "picked" is the review trail's own word for it)
 *   Approved  the review trail's approved mark (✓ is today's approve: one approved version a shot)
 *   ✕ reason  the review trail's changes mark; its reason is the take's note
 *   Not started  no take yet, or the shown one failed (a failed take's Retry is its own card's, not a verdict)
 *
 * ✓ and ✕ act on the version the board shows for the shot, and only when it can be judged (finished, with its picture here to look at).
 */
export type ShotCardState = {
  status: CardStatus;
  /** "Ready · v3": the shown version's number, only when the shot has more than one. */
  version?: number;
  shown: ShotVersion | null;
  /** The version ✓ and ✕ act on, or null when there is nothing to judge. */
  judge: ShotVersion | null;
};

export function shotCardState(row: Pick<ShotTakes, "shown" | "versions">): ShotCardState {
  const shown = row.shown;
  if (!shown) return { status: "none", shown: null, judge: null };
  const judge = judgeable(shown) ? shown : null;
  const version = row.versions.length > 1 ? shown.version : undefined;
  switch (shown.status) {
    case "rendering": case "held": return { status: "making", shown, judge: null };
    case "approved": return { status: "approved", version, shown, judge };
    case "changes": return { status: "rejected", version, shown, judge };
    case "review": case "picked": case "uploaded": return { status: "ready", version, shown, judge };
    default: return { status: "none", shown, judge: null };
  }
}

/** The picture a shot's card draws: its shown take when that is a still, else its storyboard frame when that is one; null draws the card without one. */
export function shotCardPicture(row: Pick<ShotTakes, "shown" | "frame">): { src: string } | null {
  const shown = row.shown;
  if (shown?.media === "image" && shown.url) return { src: shown.url };
  if (row.frame?.kind === "image" && row.frame.url) return { src: row.frame.url };
  return null;
}

/** ✕'s reasons on Shots: the five chips the board's reject panel has always had, word for word ("Other" is added by the card). */
export const SHOT_REASONS: readonly string[] = REJECT_CHIPS;

/** What a rejected card shows after "✕": the take's latest note, which is the reason it was sent back with. Empty when there is none yet. */
export function rejectedReason(notes: readonly { text: string }[] | undefined): string {
  const last = notes && notes.length ? notes[notes.length - 1].text : "";
  return last.replace(/\s+/g, " ").trim();
}
