/**
 * What a workspace may see of a platform-funded website job.
 *
 * A client sees its own job: status, its input, the exact Particl credits it
 * approves or was charged, and its own collected results. It never sees the
 * shared account's facts: the wallet it runs on (id or name), the account's
 * own credits, provider job ids, receipts or raw provider replies — and so no
 * approval can name them either. The stored job keeps its full shape for
 * recovery and purge checks; only the view is narrowed. A job on its owner's
 * own account is shown exactly as before.
 */
import type { ConsumerJob } from "./jobs";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** A collected original, as the client may see it: the file and its own facts. */
function clientOriginal(value: unknown): unknown {
  if (!record(value)) return value;
  const { providerJobId: _job, credits: _credits, creditUnit: _unit, ...rest } = value;
  void _job; void _credits; void _unit;
  return rest;
}
/** A result manifest, as the client may see it: its originals and the prompt it rendered. */
function clientResult(value: unknown): unknown {
  if (!record(value)) return value;
  const enhanced = record(value.providerResult) && typeof value.providerResult.enhancedPrompt === "string" ? value.providerResult.enhancedPrompt : undefined;
  return {
    ...(value.original !== undefined ? { original: clientOriginal(value.original) } : {}),
    ...(enhanced ? { providerResult: { enhancedPrompt: enhanced } } : {}),
  };
}

type Narrowable = {
  workspaceId?: string | null;
  workspaceName?: string | null;
  quoteCredits?: number | null;
  creditUnit?: string;
  providerJobId?: string | null;
  providerReceipt?: unknown;
  result?: unknown;
  settlement?: unknown;
  clips?: unknown;
};
export function workspaceJobView<V extends Narrowable>(job: Pick<ConsumerJob, "funding" | "particlCredits">, view: V): V {
  if (job.funding !== "platform_account") return view;
  const narrowed: Record<string, unknown> = {
    ...view,
    workspaceId: null,
    workspaceName: null,
    quoteCredits: job.particlCredits,
    creditUnit: "particl_credits",
    providerJobId: null,
    providerReceipt: null,
  };
  if ("result" in view) narrowed.result = clientResult(view.result);
  if ("settlement" in view && record(view.settlement))
    narrowed.settlement = { ...view.settlement, credits: job.particlCredits, creditUnit: "particl_credits" };
  if ("clips" in view && Array.isArray(view.clips))
    narrowed.clips = view.clips.map((clip) => (record(clip) ? { ...clip, providerJobId: null, ...(clip.original !== undefined ? { original: clientOriginal(clip.original) } : {}) } : clip));
  return narrowed as V;
}

/** Raw provider detail a poll may pass back: only for a job on its owner's own account. */
export function providerDetail<T>(job: Pick<ConsumerJob, "funding">, detail: T): T | undefined {
  return job.funding === "platform_account" ? undefined : detail;
}

/** Whether an approval names exactly this job's price. A platform job is
 * approved by its Particl credits alone (the wallet is never named); an
 * own-account job by its owner's wallet and that wallet's exact credits. */
export function approvalMatches(
  job: Pick<ConsumerJob, "funding" | "particlCredits" | "higgsfieldWorkspaceId" | "quoteCredits">,
  approval: { workspaceId?: string | null; credits: number },
): boolean {
  if (job.funding === "platform_account")
    return job.particlCredits !== null && approval.credits === job.particlCredits && (approval.workspaceId == null || approval.workspaceId === "");
  return approval.workspaceId === job.higgsfieldWorkspaceId && approval.credits === job.quoteCredits;
}
