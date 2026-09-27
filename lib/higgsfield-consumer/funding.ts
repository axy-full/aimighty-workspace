/**
 * Who pays for a NEW website-tool job in this workspace, decided once, before
 * anything is parsed, imported, quoted or sent.
 *
 * - A workspace on its own account (not managed) spends its owner's own
 *   connected account, exactly as it always has.
 * - A managed workspace never spends a connected account of its own. A website
 *   tool is offered to it only through the platform's designated website
 *   account, and only when every one of these holds:
 *     1. no commercial-API route serves the feature (that route is always
 *        preferred: lib/higgsfield-consumer/website-tools.ts);
 *     2. the tool's client quote, reservation and settlement are built;
 *     3. the private credit rate is set, and the tool has a price source (its
 *        own cost form, or a private fixed price);
 *     4. the platform desk has switched the tool on.
 *   Otherwise it refuses exactly as a managed workspace always has
 *   (`particl_quote_unavailable`), with no database or account read.
 * - An offered tool whose designated account cannot take new work right now
 *   refuses with the one neutral "temporarily unavailable" answer.
 */
import { requireTenant } from "@/lib/tenant";
import { websiteAccountCreditUsd } from "@/lib/vendorRates";
import { ConsumerJobError, type ConsumerJob, type ConsumerWorkflow } from "./jobs";
import { platformAccountHealth, websiteToolPriced, WebsiteToolsUnavailableError } from "./platform-account";
import { WEBSITE_BILLING_READY, websiteToolTransport, type WebsiteToolId } from "./website-tools";

/** `tool` is null for the funding an existing job was quoted under (lib/higgsfield-consumer/funding.ts › jobFunding). */
export type ConsumerFunding = { kind: "own_account" } | { kind: "platform_account"; tool: WebsiteToolId | null };
export const OWN_ACCOUNT: ConsumerFunding = Object.freeze({ kind: "own_account" });
export type FundingTarget = { workflow: ConsumerWorkflow; voiceTool?: string | null } | { tool: WebsiteToolId };

/** The offered website tool for a managed workspace, or null — pure, no reads. */
function offeredTool(target: FundingTarget): WebsiteToolId | null {
  const transport = websiteToolTransport(target);
  if (transport.kind !== "website_account") return null;
  const tool = transport.tool;
  return WEBSITE_BILLING_READY.has(tool) && websiteAccountCreditUsd() !== null && websiteToolPriced(tool) ? tool : null;
}

export async function websiteFunding(target: FundingTarget): Promise<ConsumerFunding> {
  if (!requireTenant().usesPlatformKeys) return OWN_ACCOUNT;
  const tool = offeredTool(target);
  if (!tool) throw new ConsumerJobError("particl_quote_unavailable", 409);
  const { designation, reason } = await platformAccountHealth();
  if (!designation || !designation.enabledTools.includes(tool)) throw new ConsumerJobError("particl_quote_unavailable", 409);
  if (reason !== null) throw new WebsiteToolsUnavailableError(reason);
  return { kind: "platform_account", tool };
}

/**
 * The same decision for a READ that serves new work (a catalogue, presets,
 * voices): the designated account when the tool is offered and can serve,
 * otherwise the caller's own connection, as before. Never throws.
 */
export async function readFunding(target: FundingTarget): Promise<ConsumerFunding> {
  try {
    return await websiteFunding(target);
  } catch {
    return OWN_ACCOUNT;
  }
}

/** The funding an existing job was quoted under: its reads use the same grant. */
export function jobFunding(job: Pick<ConsumerJob, "funding">): ConsumerFunding {
  return job.funding === "platform_account" ? { kind: "platform_account", tool: null } : OWN_ACCOUNT;
}
