"use client";
import { cinemaPriceDollars } from "@/lib/cinemaHold";
import { Price, useCreditUsd, usePriceTitle } from "../Price";
import type { MakePrice } from "./use-make";

/**
 * A Make price's hover, in dollars: an exact one's, or Cinema Studio's for both its figures, at the price of a credit
 * (lib/cinemaHold.ts › cinemaPriceDollars). Null for "free" or an unknown rate.
 */
export function useMakePriceTitle(price: MakePrice | null | undefined): string | null {
  const exactTitle = usePriceTitle(price?.value ?? null);
  const creditUsd = useCreditUsd();
  if (price?.value) return exactTitle;
  return price?.about && typeof price.credits === "number" ? cinemaPriceDollars(price.credits, creditUsd) : null;
}

/** A price as Make shows it: through Price, or Cinema Studio's own approximate words (dollars on hover). */
export function MakePriceText({ price, testId }: { price: MakePrice | null; testId?: string }) {
  const title = useMakePriceTitle(price);
  if (!price) return null;
  if (price.value) return <Price value={price.value} testId={testId} />;
  return price.about ? <span className="gx-price" data-price="about" data-testid={testId} title={title ?? undefined} style={{ whiteSpace: "nowrap" }}>{price.about}</span> : null;
}
