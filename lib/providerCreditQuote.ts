/** Consumer subscriptions use provider credits, never a USD conversion or
 * Particl's credit ledger. These amounts are the approved quote, not an invoice. */
export type ProviderCreditQuote = {
  provider: "higgsfield";
  unit: "higgsfield_credits";
  credits: number;
  basis: "approved_quote";
};

export function providerCreditQuote(value: unknown): ProviderCreditQuote | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as Partial<ProviderCreditQuote>;
  return quote.provider === "higgsfield" && quote.unit === "higgsfield_credits" &&
    quote.basis === "approved_quote" && typeof quote.credits === "number" &&
    Number.isFinite(quote.credits) && quote.credits >= 0
    ? quote as ProviderCreditQuote : null;
}

export function formatProviderCreditQuote(quote: ProviderCreditQuote): string {
  return `${quote.credits.toLocaleString("en-US", { maximumFractionDigits: 8 })} Higgsfield cr (quoted)`;
}

export function sumWithProviderCreditQuotes<T extends { providerCreditQuote?: ProviderCreditQuote | null }>(
  list: T[], base: (list: T[]) => string,
): string {
  const standard: T[] = [];
  let credits = 0, count = 0;
  for (const item of list) {
    const quote = providerCreditQuote(item.providerCreditQuote);
    if (quote) { credits += quote.credits; count++; }
    else standard.push(item);
  }
  const parts = standard.length || !count ? [base(standard)] : [];
  if (count) parts.push(formatProviderCreditQuote({ provider: "higgsfield", unit: "higgsfield_credits", basis: "approved_quote", credits }));
  return parts.join(" + ");
}
