/**
 * Who may call a website tool's route, decided once per request, and the
 * shared account's read budget.
 *
 * - A managed workspace runs website tools only on the platform's designated
 *   account (lib/higgsfield-consumer/funding.ts), priced and charged in its
 *   own Particl credits: any signed-in member may quote, approve and follow
 *   their own jobs. A browser session is required (API tokens are refused),
 *   and anything that can spend also needs a workspace that may render. A
 *   job stays its author's alone (jobs.ts › ownsConsumerJob); a legacy job on
 *   an owner's own account stays that owner's.
 * - A workspace on its own account: its owner only, exactly as before.
 */
import { requireOwner, requireRender, requireSession, type User } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { takeAccountLimit } from "@/lib/accountDb";
import { websiteAccountReadsPerMinute } from "./platform-jobs";
import { readFunding, type FundingTarget } from "./funding";

export type WebsiteToolCaller = { user: User; managed: boolean; response?: never } | { user?: never; managed?: never; response: Response };

export async function websiteToolCaller(): Promise<WebsiteToolCaller> {
  if (!requireTenant().usesPlatformKeys) {
    const owner = await requireOwner();
    return owner.response ? { response: owner.response } : { user: owner.user, managed: false };
  }
  const session = await requireSession();
  return session.response ? { response: session.response } : { user: session.user, managed: true };
}

/** Anything that can spend: on the shared account a quote too, since it is what an approval spends. */
export async function websiteToolSpend(caller: { managed: boolean }, action: "quote" | "submit"): Promise<Response | null> {
  if (action === "quote" && !caller.managed) return null;
  const render = await requireRender();
  return render.response ?? null;
}

/**
 * One budget of account reads per minute across every workspace on the
 * shared account (a quote, a status read, a catalogue or preset refresh). A
 * request past it is refused like any rate limit (429), before it reads.
 */
export async function takeWebsiteAccountRead(caller: { managed: boolean }) {
  if (caller.managed) await takeAccountLimit("hf-website-account:reads", websiteAccountReadsPerMinute(), 60_000);
}

/**
 * What a managed workspace's page is told about a website tool: only whether
 * the platform's website tools can take this work now — never why not (a
 * pause, a disconnected or changed account stays on the platform desk).
 */
export async function websiteToolsAvailability(target: FundingTarget): Promise<{ managed: true; available: boolean }> {
  return { managed: true, available: (await readFunding(target)).kind === "platform_account" };
}

/** The workspace's own four-job limit, in the words its funding calls for. */
export function consumerCapacityMessage(): string {
  return requireTenant().usesPlatformKeys
    ? "Four website-tool jobs are already running in this workspace. Try again when one finishes."
    : "All four connected-account slots are in use. Workspace › Engines lists yours.";
}
