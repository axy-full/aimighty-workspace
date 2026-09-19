import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import {
  getConsumerConnection,
  removeConsumerConnection,
} from "@/lib/higgsfield-consumer/oauth";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
export const GET = withTenant(async (req: Request) => {
  const auth = await requireOwner();
  if (auth.response) return auth.response;
  const identity = { workspaceId: requireTenant().id, userId: auth.user.id };
  const scope = workbenchScopeProblem(
    req,
    identity.workspaceId,
    identity.userId,
    true,
  );
  if (scope) return Response.json({ error: scope }, { status: 409, headers });
  try {
    return Response.json(await getConsumerConnection(identity), { headers });
  } catch {
    return Response.json(
      { error: "The connected account is temporarily unavailable." },
      { status: 503, headers },
    );
  }
});
export const DELETE = withTenant(
  async () => {
    const auth = await requireOwner();
    if (auth.response) return auth.response;
    try {
      await removeConsumerConnection({
        workspaceId: requireTenant().id,
        userId: auth.user.id,
      });
      return Response.json(
        { connected: false, requiresReconnect: false },
        { headers },
      );
    } catch {
      return Response.json(
        { error: "The connection could not be removed. Try again." },
        { status: 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
