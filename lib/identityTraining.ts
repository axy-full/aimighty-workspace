/**
 * Training a face from the New asset sheet (the legacy LoRA trainer behind
 * /api/identities). Pure, so the sheet and the train route share it.
 *
 * A paid action shows its price first, in the unit the workspace pays in,
 * and the request carries that price back so the server can refuse a run
 * that would cost more than the person approved.
 */

/** The training terms GET /api/identities answers with. */
export type TrainTerms = {
  configured: boolean;
  minPhotos: number;
  /** The vendor's dollars, for a workspace on its own keys; null in credits. */
  trainCostUsd: number | null;
  /** The charge in credits, for a credit workspace; null in dollars. */
  trainCredits?: number | null;
};

/** The training price in the workspace's unit, or null while it is not known. */
export function trainPrice(terms: TrainTerms | null | undefined, inCredits: boolean): number | null {
  const value = inCredits ? terms?.trainCredits : terms?.trainCostUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The photos a face can train on: uploaded stills only. The trainer reads
 * uploads; a take picked as a reference is a generation, not an upload, so
 * counting it would offer a training that is refused for too few photos.
 */
export function trainingPhotos(refs: { kind: string; uploadId?: string | null }[]): string[] {
  return [...new Set(refs.flatMap((r) => (r.kind === "image" && r.uploadId ? [r.uploadId] : [])))];
}

/** What the train request carries: the approved price, in its own unit. */
export function trainApproval(price: number, inCredits: boolean): { maxCredits: number } | { maxUsd: number } {
  return inCredits ? { maxCredits: Math.max(0, Math.ceil(price - 1e-9)) } : { maxUsd: price };
}

/** Why a train request must be refused on price, or null when the approval covers it. */
export function trainApprovalProblem(
  body: { maxCredits?: unknown; maxUsd?: unknown },
  charge: { credits: number; usd: number },
): string | null {
  const changed = "The training price changed. Review the new price before training.";
  const { maxCredits, maxUsd } = body;
  if (maxCredits != null && (typeof maxCredits !== "number" || !Number.isInteger(maxCredits) || maxCredits < 0 || charge.credits > maxCredits)) return changed;
  if (maxUsd != null && (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0 || charge.usd > maxUsd + 1e-9)) return changed;
  return null;
}
