"use client";
import type { CSSProperties } from "react";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { creditRate } from "@/lib/shell/price-words";
import { priceDisplay, type PriceDisplay, type Quote } from "@/lib/v12/quote";
import type { UnpricedId } from "@/lib/v12/unpriced";

/**
 * A price in the new interface: "N cr", "up to N cr" or "free", with its dollar value on hover at the public price of a
 * credit. The house workspace, which pays in dollars, sees dollars, worded as today's screens word them (lib/price.ts).
 *
 * The figure is always the server's, from `useQuote` (lib/v12/useQuote.ts) or a figure the server already gave
 * (`knownQuote`). While it loads the price reads "…", and when it fails "—" with the reason on hover: never a number.
 *
 * An action with no quote path says so in code: `<Price quote={null} reason="lipSync" />` reads "quoted", and the reason
 * must be an entry of lib/v12/unpriced.ts, which lists every such action and why (docs/redesign-plan.md, decision 4).
 *
 * One unbreakable run: a narrow row moves the price whole onto the next line and never cuts it.
 */
export type PriceProps = { className?: string; style?: CSSProperties; testId?: string } & (
  | { quote: Quote; reason?: undefined }
  | { quote: null; reason: UnpricedId }
);

export function Price(props: PriceProps) {
  const { rates } = useSession();
  const money = useMoney();
  const display = priceDisplay(props.quote, props.reason, { creditUsd: creditRate(rates.creditUsd), dollars: money.price });
  return <PriceView display={display} className={props.className} style={props.style} testId={props.testId} />;
}

/** The drawing alone, with no hooks: what Price renders for a display (tests read it as data). */
export function PriceView({ display, className, style, testId }: { display: PriceDisplay | null; className?: string; style?: CSSProperties; testId?: string }) {
  if (!display) return null;
  return (
    <span
      className={className ? `v12-price ${className}` : "v12-price"}
      title={display.title ?? undefined}
      aria-label={display.state === "loading" ? "Reading the price" : display.state === "error" ? `No price: ${display.title ?? ""}`.trim() : undefined}
      aria-busy={display.state === "loading" ? true : undefined}
      data-price-state={display.state}
      data-price={display.kind}
      data-testid={testId}
      style={{ ...ONE_RUN, ...style }}
    >
      {display.text}
    </span>
  );
}

const ONE_RUN: CSSProperties = { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
