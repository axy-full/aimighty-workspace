/**
 * The price on a button that spends (CLAUDE.md rule 14, design README section 5).
 *
 * Every control that can spend credits carries `data-spend` and shows its price as "N cr", "up to N cr",
 * "about N cr, at most 3N cr" or "free". `spendAttrs()` and `<SpendButton>` (components/graphite/SpendButton.tsx)
 * are how a button opts in; tests/unit/spend-buttons.spec.ts and tests/spend-buttons-workbench.spec.ts check
 * every paid call site and every rendered page. How to add one: docs/ui-checks.md.
 *
 * Prices are the server's: pass what the quote returned. Nothing here converts dollars or invents a figure,
 * and a missing price is `null`: the control then renders disabled with `data-spend="unpriced"`.
 */

import { priceWords, type PriceValue } from "@/lib/shell/price-words";

export type SpendPrice =
  /** A price the server quoted: "43 cr". */
  | { cr: number; upTo?: false; atMost?: undefined }
  /** A ceiling: "up to 69 cr". */
  | { cr?: undefined; upTo: number; atMost?: undefined }
  /** An estimate with a ceiling, as Cinema Studio quotes: "about 40 cr, at most 120 cr". */
  | { cr: number; atMost: number; upTo?: undefined }
  | "free"
  | null
  | undefined;

const figure = (n: number) => Math.round(n).toLocaleString("en-US");
const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The text a person reads for a price, or null when there is no price yet. */
export function priceLabel(price: SpendPrice): string | null {
  if (price === "free") return "free";
  if (!price) return null;
  if (ok(price.upTo)) return price.upTo === 0 ? "free" : `up to ${figure(price.upTo)} cr`;
  if (ok(price.cr) && ok(price.atMost)) return `about ${figure(price.cr)} cr, at most ${figure(price.atMost)} cr`;
  if (ok(price.cr)) return price.cr === 0 ? "free" : `${figure(price.cr)} cr`;
  return null;
}

/** What a button's text must contain to count as showing a price: a credit figure, "up to"/"about" with one, or "free". */
export const CREDIT_FIGURE = /(?:^|[\s·(,])(?:up to |about )?<?\d[\d,]*(?:\.\d+)?\s*cr\b|\bfree\b/i;

export function hasCreditFigure(text: string | null | undefined): boolean {
  return !!text && CREDIT_FIGURE.test(text);
}

/**
 * For a control that first quotes and then spends on the next press ("Review cost", then "Upscale · 23 cr"): the marker only
 * once the text it shows carries a credit figure, so the press that sends is the one that wears the price. No figure, no marker.
 */
export function spendAttrsText(text: string | null | undefined): Partial<SpendAttrs> {
  const price = hasCreditFigure(text) ? text!.match(/(?:up to |about )?<?\d[\d,]*(?:\.\d+)?\s*cr\b(?:, at most \d[\d,]*(?:\.\d+)? cr\b)?|\bfree\b/i)?.[0] : null;
  return price ? { "data-spend": "priced", "data-spend-price": price } : {};
}

export type SpendAttrs = {
  "data-spend": "priced" | "unpriced";
  "data-spend-price"?: string;
  disabled?: true;
};

/**
 * The attributes a control that spends carries. Spread them on any button:
 *
 *   <button type="button" {...spendAttrs(price)} onClick={make}>Make · {priceLabel(price)}</button>
 *
 * With no price the control is disabled until there is one.
 */
export function spendAttrs(price: SpendPrice): SpendAttrs {
  const text = priceLabel(price);
  return text === null ? { "data-spend": "unpriced", disabled: true } : { "data-spend": "priced", "data-spend-price": text };
}

/**
 * `spendAttrs` for a price the screen already holds as a PriceValue (lib/shell/price-words.ts: "43 cr", "up to 69 cr", "free"):
 * the marker carries the very words the person reads, and no price at all leaves the control disabled and "unpriced".
 *
 *   <button type="button" {...spendAttrsOf(price)} onClick={ask}>Ask · <Price value={price} /></button>
 */
export function spendAttrsOf(value: PriceValue | null | undefined): SpendAttrs {
  const words = priceWords(value);
  return words === null ? { "data-spend": "unpriced", disabled: true } : { "data-spend": "priced", "data-spend-price": words };
}
