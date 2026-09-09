import type { ChoiceKey } from "./impact";

/**
 * What happens to the takes that already exist (brief 3, surface 1b).
 *
 * The design's fifth rule: **nothing re-renders silently.** An edit to a
 * shared element opens this first, and the panel exists to make one decision
 * legible — what becomes of the work already made.
 *
 * Three answers, and the middle one is the default because it is the one that
 * protects what a client has already seen without spending on what they have
 * not. Each carries its consequence, because a price with no consequence
 * attached is a number rather than a question.
 *
 * Pure. The counts and the money come from the quote engine.
 */

export const CHOICE_KEYS: ChoiceKey[] = ["all", "approved", "none"];

export function isChoiceKey(v: unknown): v is ChoiceKey {
  return typeof v === "string" && (CHOICE_KEYS as string[]).includes(v);
}

/** The headline. Says what was changed and how far it reaches, in that order. */
export function headline(kindWord: string, shots: number): string {
  if (!shots) return `You changed a ${kindWord} nothing has been rendered with yet.`;
  return `You changed a ${kindWord} ${shots} shot${shots === 1 ? "" : "s"} ${shots === 1 ? "is" : "are"} using.`;
}

/** The line under it. The reassurance is the point, not the politeness. */
export const REASSURANCE = "Nothing has been re-rendered yet. Choose what happens to the takes that already exist.";

/** "6 approved · 8 draft", dropping whichever is nothing. */
export function splitLine(approved: number, draft: number): string {
  return [approved ? `${approved} approved` : "", draft ? `${draft} draft` : ""].filter(Boolean).join(" · ");
}

/** What the button says. The third choice is not a re-render, so it does not read like one. */
export function primaryLabel(key: ChoiceKey, label: string): string {
  return key === "none" ? "Keep existing takes" : label;
}

/**
 * The mono line under the button, restating the consequence in numbers.
 *
 * The reference puts the dollar equivalent here. The brief says the product
 * speaks credits everywhere but the top-up screen, so it says what the choice
 * leaves behind instead — which is the part a producer is actually weighing.
 */
export function footnote(
  key: ChoiceKey, o: { credits: number; approved: number; draft: number; version: string },
): string {
  const cr = `${credits(o.credits)} CR`;
  if (key === "all") {
    return o.approved
      ? `${cr} · ${o.approved} APPROVAL${o.approved === 1 ? "" : "S"} TO REDO`
      : `${cr} · NOTHING TO RE-APPROVE`;
  }
  if (key === "approved") {
    return o.draft
      ? `${cr} · ${o.draft} DRAFT${o.draft === 1 ? "" : "S"} LEFT ON ${o.version.toUpperCase()}`
      : `${cr} · NO DRAFTS TO LEAVE BEHIND`;
  }
  const n = o.approved + o.draft;
  return n
    ? `NOTHING RE-RENDERS · ${n} SHOT${n === 1 ? "" : "S"} STAY ON ${o.version.toUpperCase()}`
    : "NOTHING RE-RENDERS";
}

const credits = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * What a choice does to the takes that already exist.
 *
 * An approved take made with the old version no longer shows what the shot
 * is, so re-rendering it sends it back to draft to be approved again. The
 * decision is a person's; this only says which takes it reaches.
 */
export function takesReturnedToDraft(key: ChoiceKey): "all-approved" | "none" {
  return key === "none" ? "none" : "all-approved";
}

/** Whether this choice spends anything at all. */
export const spends = (key: ChoiceKey): boolean => key !== "none";
