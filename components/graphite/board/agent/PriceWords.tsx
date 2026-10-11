"use client";
import { priceWords, type PriceValue } from "@/lib/shell/price-words";

/** A price's words inline ("up to 4 cr"), in one unbreakable run; the dollars sit on the control that carries it. */
export function PriceWords({ value }: { value: PriceValue | null }) {
  const words = priceWords(value);
  return words ? <span style={{ whiteSpace: "nowrap" }}>{words}</span> : null;
}
