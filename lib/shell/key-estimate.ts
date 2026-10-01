/**
 * The estimate on a key-route composer's button (Viral, Business › Image
 * ads): POST /api/generate/quote for exactly the body that will be sent
 * (lib/shell/use-key-take.ts). Pure, so the words are the same everywhere.
 */
export type KeyEstimate = { key: string; credits: number | null; expiresAt: number; error: string | null };

/** An estimate is one for exactly this input, still inside its lifetime. */
export function estimateLive(estimate: { key: string; expiresAt: number } | null, key: string, now: number): boolean {
  return Boolean(estimate && estimate.key === key && estimate.expiresAt > now);
}

/** Why the button carries no figure yet; null when it does. Never a guessed price. */
export function estimateReason(estimate: KeyEstimate | null, key: string, now: number): string | null {
  if (!estimate || estimate.key !== key) return "Getting the estimate…";
  if (estimate.error) return estimate.error;
  if (estimate.credits == null) return "No estimate for this input. Nothing was sent.";
  if (estimate.expiresAt <= now) return "Getting a fresh estimate…";
  return null;
}

/** A price in the words every quote in Particl uses: an estimate, never a promise. */
export const aboutCredits = (n: number) => `about ${n.toLocaleString("en-US")} cr`;
