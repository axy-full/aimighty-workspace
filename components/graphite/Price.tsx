"use client";
import { useSession } from "@/lib/session";
import { creditRate, priceTitle, priceView, type PriceValue } from "@/lib/shell/price-words";

/**
 * A price, as Particl shows one (lib/shell/price-words.ts): "43 cr", "up to 69 cr" or "free",
 * with its dollar value on hover at the server's credit rate. It is one unbreakable run, so a
 * narrow row moves it whole onto the next line and never cuts it (a price is never ellipsized).
 *
 * The figure is the server's, passed in; nothing here asks for one or works one out. Something
 * that is not a price (null, NaN, negative) draws nothing. What it draws is `priceView`, which the
 * unit tests hold to the rules.
 *
 * A control whose label carries a price ("Make · 43 cr") puts the same dollars on the whole
 * control: `title={usePriceTitle(value) ?? undefined}`.
 */
export function Price({ value, className, testId }: {
  value: PriceValue | null | undefined;
  className?: string;
  testId?: string;
}) {
  const view = priceView(value, useCreditUsd());
  if (!view) return null;
  return (
    <span className={className ? `gx-price ${className}` : "gx-price"} title={view.title ?? undefined}
      data-price={view.kind} data-testid={testId} style={ONE_RUN}>
      {view.text}
    </span>
  );
}

const ONE_RUN = { whiteSpace: "nowrap" } as const;

/** What one credit costs, from the server (`rates.creditUsd` in the session), or null while it isn't known. */
export function useCreditUsd(): number | null {
  return creditRate(useSession().rates.creditUsd);
}

/** A price's hover ("$4.30", "up to $6.90"), for a control that carries it; null for "free" or an unknown rate. */
export function usePriceTitle(value: PriceValue | null | undefined): string | null {
  return priceTitle(value, useCreditUsd());
}
