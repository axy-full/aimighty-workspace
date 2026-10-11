import { requireUser, withTenant } from "@/lib/auth";
import { workspaceQueuePositions } from "@/lib/v12/queuePosition.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v12/queue-positions: where each of this workspace's waiting takes stands in its line, for a render card's
 * "In queue · position N" (lib/v12/queuePosition.ts). Read-only, signed in, for the workspace in scope: its own held
 * takes and its own rows in the shared pool's line. The reply is `{ positions: { [take id]: place } }`: numbers and this
 * workspace's own take ids, nothing of any other workspace.
 */
export const GET = withTenant(async () => {
  const got = await requireUser();
  if (got.response) return got.response;
  const positions = await workspaceQueuePositions();
  return Response.json({ positions: Object.fromEntries(positions) }, { headers: { "Cache-Control": "private, no-store" } });
});
