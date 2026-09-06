"use client";

/**
 * A price, in whatever this workspace pays in.
 *
 * A workspace on the platform's keys buys credits and every price it sees
 * is in credits; the studio's own workspace and one on its own keys pay
 * their vendors in dollars and see dollars. The conversion is the credit
 * terms the session carries, so a $0.42 shot reads "4.2 cr" on one side of
 * the platform and "$0.42" on the other, from the same number.
 */
import { useSession } from "@/lib/session";
import { usd } from "@/lib/format";

/** Credits as a number for a sentence: one decimal under ten, whole above. */
export function creditsNumber(n: number): string {
  if (n > 0 && n < 0.05) return "<0.1";
  const v = Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return v.toLocaleString("en-US");
}

export const fmtCredits = (n: number): string => `${creditsNumber(n)} cr`;

export function usePrice(): (usdAmount: number, dp?: number) => string {
  const { credits } = useSession();
  if (!credits) return (n: number, dp = 2) => usd(n, dp);
  const { creditUsd, markup } = credits;
  return (n: number) => fmtCredits((n * markup) / creditUsd);
}
