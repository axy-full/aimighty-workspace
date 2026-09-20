import { creditRateLine } from "@/lib/creditTerms";
import type { Unit } from "@/lib/rateTable";

/** Numbers group Western-style regardless of the browser's locale. */
export function formatCount(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

export function formatCredits(balance: number) {
  return `${formatCount(balance)} cr`;
}

/**
 * What the header shows in the credits slot, for all three states the product
 * actually has. The slot never disappears: spending happens on every screen,
 * so the balance (or the reason there is none) belongs in the header at every
 * level — 05-mobile, "Header".
 *
 *  - a balance, in credits: the figure, mono, grouped en-US ("2,250 cr").
 *    Zero is a balance, not an unknown, and reads "0 cr".
 *  - no balance yet: a neutral "— cr" placeholder. `creditStateFor` is read
 *    behind a `.catch(() => null)` on both the page and /api/me, so a
 *    transient billing read leaves the balance genuinely unknown for a
 *    moment; the slot says so instead of vanishing.
 *  - a workspace billed in dollars (on its own keys, or legacy): it has no
 *    credit balance at all. lib/price.ts is explicit that a balance says what
 *    somebody HAS and is never what they pay in, so nothing is invented here:
 *    the slot holds a neutral dash and its label explains why.
 *
 * The title carries the rate — "Workspace credits · 1 credit = $0.10" — because
 * the balance is where most people meet the unit, and a figure in a unit nobody
 * has defined is not information. `perCredit` is the rate the rate table
 * carried over the wire (lib/rateTable.ts `creditUsd`), never a number typed
 * here: a deployment on a different CREDIT_USD moves this line with it, and a
 * browser that has no table yet gets no rate and says nothing about one.
 */
export type CreditsLabel = { text: string; known: boolean; title: string };

/** "Workspace credits", plus the rate when the table carried one. */
export function creditsTitle(base: string, perCredit?: number | null): string {
  const rate = creditRateLine(perCredit);
  return rate ? `${base} · ${rate}` : base;
}

export function creditsLabel(
  balance: number | null | undefined, unit: Unit = "cr", perCredit?: number | null,
): CreditsLabel {
  if (unit === "usd")
    return { text: "—", known: false, title: "This workspace is billed in dollars, so it has no credit balance." };
  if (typeof balance === "number" && Number.isFinite(balance))
    return { text: formatCredits(balance), known: true, title: creditsTitle("Workspace credits", perCredit) };
  return { text: "— cr", known: false, title: "Credit balance unavailable just now." };
}

/** Up to two initials from a name; "P" when there is nothing to read. */
export function initialsOf(name: string | null | undefined) {
  const words = (name ?? "").split(/\s+/).filter(Boolean);
  const letters = words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 2).map((w) => w[0]).join("");
  return letters.toUpperCase() || "P";
}

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Project avatar gradients from the design, picked deterministically by id. */
export const AVATAR_GRADIENTS = [
  "linear-gradient(160deg,#E9A83D,#C2761B)",
  "linear-gradient(160deg,#6E8DA6,#3E566B)",
  "linear-gradient(160deg,#9B84C8,#5E4A85)",
] as const;

export function avatarGradient(id: string) {
  return AVATAR_GRADIENTS[hash(id) % AVATAR_GRADIENTS.length];
}

/** Flat colour bands standing in for a project still until real media is wired. */
const MEDIA_BANDS: [string, string][] = [
  ["#9DB9CE", "#C79E68"],
  ["#B9C6CF", "#7E858F"],
  ["#D9D2C4", "#8E7B63"],
  ["#2E3B45", "#4E6470"],
  ["#231F2E", "#3C3350"],
];

export function mediaBands(id: string) {
  return MEDIA_BANDS[hash(id + ":media") % MEDIA_BANDS.length];
}

export function shortDate(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
