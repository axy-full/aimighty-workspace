import type { TenantWorkspace } from "./tenant";

/**
 * The house workspace: the studio's own, the first workspace on this
 * deployment.
 *
 * Every other workspace pays for its work in Particl credits. The house does
 * not. It runs on the platform's engines, which are the studio's own
 * accounts, so:
 *
 * - it is never given credits: no welcome grant, no grant from the desk, no
 *   top-up, no monthly allowance;
 * - nothing it runs is charged in credits, and no credit wall stops it;
 * - what its jobs cost is still metered, at the engines' cost, for the
 *   studio's own reporting (its own Usage page and the platform desk) and
 *   for no other workspace.
 *
 * One rule, named here, read wherever a workspace's billing is decided
 * (lib/credits.ts, lib/platformSpend.ts, lib/allowance.ts, the grant writers
 * in lib/platform.ts and lib/topups.ts, the desk). It names the workspace by
 * its id. The `legacy` flag says where a workspace's database lives
 * (lib/platform.ts), never how it pays; and the exemption belongs to the
 * workspace, not to a person, so any other workspace the studio's people
 * belong to pays in credits like the rest.
 */
export const HOUSE_WORKSPACE_ID = "ws_legacy";

export function isHouseWorkspace(ws: Pick<TenantWorkspace, "id"> | null | undefined): boolean {
  return ws?.id === HOUSE_WORKSPACE_ID;
}

/** What a request to give the house credits, or to cap it, is told. */
export const HOUSE_NOT_BILLED = "The house workspace runs on the platform's engines and is never billed in credits, so it takes no credits or allowance.";
