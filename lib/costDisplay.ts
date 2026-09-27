/** Presentation only: provider accounting and request ceilings keep their original unit. */
export function creditEquivalentValue(amount: number | null | undefined, perCredit: number | null | undefined): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || typeof perCredit !== "number" || !Number.isFinite(perCredit) || perCredit <= 0) return null;
  return amount / perCredit;
}

/** Own-key costs use the workspace's supplied conversion rate, never a guessed rate. */
export function creditEquivalent(amount: number | null | undefined, perCredit: number | null | undefined): string {
  const value = creditEquivalentValue(amount, perCredit);
  if (value === null) return "— cr eq.";
  const number = value > 0 && value < 0.0001 ? "<0.0001" : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return `${number} cr eq.`;
}

/** A numeric cap entered in credit equivalents is saved in its existing accounting unit. */
export function creditEquivalentToAmount(value: number, perCredit: number | null | undefined): number | null {
  if (!Number.isFinite(value) || typeof perCredit !== "number" || !Number.isFinite(perCredit) || perCredit <= 0) return null;
  return value * perCredit;
}
