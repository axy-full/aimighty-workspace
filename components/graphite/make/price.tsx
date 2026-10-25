"use client";
import { useSession } from "@/lib/session";
import { aboutWords, makePriceTitle, makePriceWords, shownValue } from "@/lib/shell/make-price";
import { creditRate, modeOf } from "@/lib/shell/price-words";
import { Price } from "../Price";
import type { MakePrice } from "./use-make";

/**
 * A Make price's hover: an exact one's, or Cinema Studio's for both its figures (lib/shell/make-price.ts › makePriceTitle), in the unit
 * this workspace pays in. Null for "free" or an unknown rate.
 */
export function useMakePriceTitle(price: MakePrice | null | undefined): string | null {
  const { rates } = useSession();
  return makePriceTitle(price, modeOf(rates), creditRate(rates.creditUsd));
}

/** A Make price's words as drawn, for the marker a button carries. */
export function useMakePriceWords(price: MakePrice | null | undefined): string | null {
  const { rates } = useSession();
  return makePriceWords(price, modeOf(rates));
}

/**
 * A price as Make shows it: through Price, or Cinema Studio's own approximate words (dollars on hover). The figure carries the house's
 * dollars where Make has them (lib/shell/make-price.ts › shownValue), so the house reads the engine's dollars, never "—" for a known one.
 */
export function MakePriceText({ price, testId }: { price: MakePrice | null; testId?: string }) {
  const { rates } = useSession();
  const mode = modeOf(rates);
  if (!price) return null;
  const value = shownValue(price);
  if (value) return <Price value={value} testId={testId} />;
  const about = aboutWords(price, mode);
  const title = makePriceTitle(price, mode, creditRate(rates.creditUsd));
  return about ? <span className="gx-price" data-price="about" data-testid={testId} title={title ?? undefined} style={{ whiteSpace: "nowrap" }}>{about}</span> : null;
}
