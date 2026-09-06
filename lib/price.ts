"use client";

/**
 * A price, in whatever this workspace pays in.
 *
 * A workspace on the platform's keys buys credits and every price it sees
 * is in whole credits at the engine's margin, rounded up — the same rule
 * the metering layer bills by. The studio's own workspace and one on its
 * own keys pay their vendors in dollars and see dollars. Batches multiply
 * before they round: pass the total, not the unit.
 */
import { useSession } from "@/lib/session";
import { usd } from "@/lib/format";
import { billCreditsWith, marginFor } from "@/lib/creditTerms";

/** Credits as a number for a sentence: whole above ten, one decimal under. */
export function creditsNumber(n: number): string {
  if (n > 0 && n < 0.05) return "<0.1";
  const v = Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return v.toLocaleString("en-US");
}

export const fmtCredits = (n: number): string => `${creditsNumber(n)} cr`;

export function usePrice(): (usdAmount: number, engine?: string | null) => string {
  const { credits } = useSession();
  if (!credits) return (n: number) => (n > 0 && n < 0.005 ? "<1¢" : usd(n, 2));
  const { creditUsd: perCredit, margins } = credits;
  return (n: number, engine?: string | null) => `${billCreditsWith(n, marginFor(engine, margins), perCredit).toLocaleString("en-US")} cr`;
}
