import { planOf } from "@/lib/platform";
import { requireTenant } from "@/lib/tenant";
import type { InitialSharing } from "./records";

/**
 * How a new board starts, by the workspace's plan (owner, 13 Oct 2026): a Business workspace's boards start "shared · can edit" with the team, every other
 * workspace's start private. The legacy plans (Invite, Studio, Agency, Production), the individual plans and no plan at all are private. Stamped by the server
 * at the board's first save and by nothing else: it is the board's own sharing from then on (the owner changes it with the team-share action, never a save),
 * so a workspace that later changes plan changes no board. Business is only an admin-set label until checkout exists (lib/platform.ts › planOf).
 */
export async function defaultSharing(): Promise<InitialSharing> {
  const group = (await planOf(requireTenant()))?.group;
  return group === "business" ? { teamShared: true, teamEdit: true } : { teamShared: false, teamEdit: false };
}
