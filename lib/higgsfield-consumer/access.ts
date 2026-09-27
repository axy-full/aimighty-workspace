/**
 * The one place a website-tool service gets a grant (design W2).
 *
 * - New work (a quote, a read it relies on) uses the caller's own connection
 *   in this workspace, or — for platform funding — the platform's designated
 *   account, only while it can serve new work.
 * - An existing job is read with exactly the grant it was quoted or admitted
 *   under. An own-account job: its owner's connection in this workspace, at its
 *   pinned generation (as always). A platform job still being quoted: the
 *   designation at the quote's generation. An admitted platform job: ONLY the
 *   connection, account and generation its platform registry row pinned —
 *   never the current tenant, never whatever is designated now — and only
 *   when that row names this very job (same meter id, grant, provider job).
 *
 * The result carries a bearer token: server-only, never serialized.
 */
import { requireTenant } from "@/lib/tenant";
import { ConsumerOAuthError, getConsumerAccess, type ConsumerAccess } from "./oauth";
import { PLATFORM_CONNECTED_OWNER, type ConsumerJob } from "./jobs";
import { platformAccountAccess, WebsiteToolsUnavailableError } from "./platform-account";
import { websiteJobPin } from "./platform-jobs";
import type { ConsumerFunding } from "./funding";

export type ResolvedAccess = ConsumerAccess & {
  /** What a new job records as its connection: the caller, or the platform. */
  connectedOwnerId: string;
  funding: ConsumerFunding["kind"];
};

async function own(userId: string, expectedGeneration?: string): Promise<ResolvedAccess> {
  const access = await getConsumerAccess(requireTenant().id, userId, expectedGeneration === undefined ? {} : { expectedGeneration });
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  return { ...access, connectedOwnerId: userId, funding: "own_account" };
}

async function designated(expectedGeneration?: string): Promise<ResolvedAccess> {
  const access = await platformAccountAccess(expectedGeneration === undefined ? {} : { expectedGeneration });
  return { accessToken: access.accessToken, generation: access.generation, connectedOwnerId: PLATFORM_CONNECTED_OWNER, funding: "platform_account" };
}

export async function accessForNewWork(userId: string, funding: ConsumerFunding, expectedGeneration?: string): Promise<ResolvedAccess> {
  return funding.kind === "own_account" ? own(userId, expectedGeneration) : designated(expectedGeneration);
}

export async function accessForJob(job: ConsumerJob): Promise<ResolvedAccess> {
  if (job.funding !== "platform_account") return own(job.connectedOwnerId, job.connectionGeneration);
  if (job.connectedOwnerId !== PLATFORM_CONNECTED_OWNER || !job.meterId) throw new WebsiteToolsUnavailableError("unavailable");
  // Not admitted yet: new spend, so only a designation that can serve now, at the quote's grant.
  if (job.status === "quoted") return designated(job.connectionGeneration);
  const pin = await websiteJobPin(requireTenant().id, job.id);
  if (
    !pin ||
    pin.meterId !== job.meterId ||
    pin.userId !== job.userId ||
    pin.workflow !== job.workflow ||
    pin.generation !== job.connectionGeneration ||
    (job.providerJobId !== null && pin.providerJobId !== job.providerJobId)
  )
    throw new WebsiteToolsUnavailableError("unavailable");
  let access: ConsumerAccess | null;
  try {
    access = await getConsumerAccess(pin.host.workspaceId, pin.host.userId, { expectedGeneration: pin.generation, expectedSubjectHash: pin.subjectHash });
  } catch (error) {
    throw new WebsiteToolsUnavailableError(error instanceof ConsumerOAuthError && error.code === "connection_busy" ? "busy" : "unavailable");
  }
  if (!access) throw new WebsiteToolsUnavailableError("disconnected");
  return { ...access, connectedOwnerId: PLATFORM_CONNECTED_OWNER, funding: "platform_account" };
}

/** Cache scope for account reads: this workspace, the connection it reads with, and its grant. */
export const consumerCacheScope = (userId: string, access: Pick<ResolvedAccess, "funding" | "generation">) =>
  `${requireTenant().id}:${access.funding === "platform_account" ? PLATFORM_CONNECTED_OWNER : userId}:${access.generation}`;
