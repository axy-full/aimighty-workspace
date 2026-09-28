/**
 * How a page shows a job on the platform's website tools (a managed
 * workspace): its price in the workspace's own credits and, said before
 * approval, that the price stands whether the run succeeds or fails (owner
 * decision, 27 September). It names no wallet, account or provider. A job on
 * an owner's own account keeps its connected credits and wallet, as before.
 *
 * Pure and browser-safe: the pages' parsers and labels only.
 */
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export type WebsiteCharge = { credits: number; onFailure: "charged" };

/**
 * The platform charge a job view carries, or null for a job on an owner's own
 * account. A view that claims the platform's credits but names a wallet,
 * provider job or any other price is refused: it could not have come from
 * the server (lib/higgsfield-consumer/client-view.ts).
 */
export function websiteCharge(view: unknown): WebsiteCharge | null {
  if (!record(view) || view.creditUnit !== "particl_credits") return null;
  const terms = view.chargeTerms, credits = view.quoteCredits;
  if (typeof credits !== "number" || !Number.isSafeInteger(credits) || credits < 1 || credits > 100_000 ||
      !record(terms) || terms.credits !== credits || terms.onFailure !== "charged" ||
      view.workspaceId !== null || view.workspaceName !== null || (view.providerJobId !== undefined && view.providerJobId !== null))
    throw new Error("The saved job could not be verified. Refresh before continuing.");
  return { credits, onFailure: "charged" };
}

/**
 * Whether a status check can still recover an unconfirmed job from the reply
 * saved when it was sent: a job on an owner's own account carries that reply;
 * a platform job only says one was saved (its contents stay on the server).
 */
export const recoverableJob = (job: { status: string; charge: WebsiteCharge | null; providerReceipt?: unknown; receiptSaved?: boolean }) =>
  job.status === "uncertain" && (job.charge ? job.receiptSaved === true : !!job.providerReceipt);

/** A whole number of the workspace's credits, never shortened. */
export const creditsText = (credits: number) => `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}`;

/** The price a job line shows: the workspace's credits, or an owner's connected credits. */
export const jobPriceText = (job: { quoteCredits: number; charge: WebsiteCharge | null }) =>
  job.charge ? creditsText(job.charge.credits) : `${job.quoteCredits.toLocaleString("en-US")} connected credits`;

/** Said before approval wherever a website-tool run is approved. */
export const chargedEvenIfFails = (credits: number, what: string) =>
  `${creditsText(credits)} ${credits === 1 ? "is" : "are"} charged even if the ${what} fails.`;

/** What a page says when a platform run failed after it was sent: its approved price stands, as quoted. */
export const chargedFailure = (credits: number, what: string) =>
  `The ${what} failed. As quoted, its ${creditsText(credits)} ${credits === 1 ? "is" : "are"} charged.`;

/**
 * Refusals that happened before anything could be sent (the attempt guard
 * may clear), beside each page's own: a changed price, the website tools
 * busy or off, a full account, or the workspace's own credits and limits.
 */
export const WEBSITE_PREFLIGHT_CODES: readonly string[] = ["price_changed", "website_unavailable", "capacity", "reservation_refused", "particl_quote_unavailable"];

/** A managed workspace's answer from a tool's route: only whether the website tools can take this work now. */
export function websiteToolsAnswer(value: unknown): { available: boolean } | null {
  return record(value) && value.managed === true ? { available: value.available === true } : null;
}
