import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import {
  getConsumerAccess,
  getConsumerConnection,
  removeConsumerConnection,
} from "@/lib/higgsfield-consumer/oauth";
import { probeDeveloperApi } from "@/lib/higgsfield-consumer/developer-api";
import { takeAccountLimit } from "@/lib/accountDb";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
/**
 * One free read against the account's developer API with the grant this app
 * holds, so the owner can see whether setup items and DTC ads can be built on
 * it. Owner only, twelve a minute, never spends.
 */
export const POST = withTenant(async (req: Request) => {
  const auth = await requireOwner();
  if (auth.response) return auth.response;
  const identity = { workspaceId: requireTenant().id, userId: auth.user.id };
  const scope = workbenchScopeProblem(req, identity.workspaceId, identity.userId, true);
  if (scope) return Response.json({ error: scope }, { status: 409, headers });
  const body = await req.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== "developer-probe") return Response.json({ error: "Review the request." }, { status: 400, headers });
  try {
    await takeAccountLimit(`hf-consumer-connection:${identity.workspaceId}:${identity.userId}:developer-probe`, 12, 60_000);
    const access = await getConsumerAccess(identity.workspaceId, identity.userId);
    if (!access) return Response.json({ probe: { reachable: false, status: null, reason: "Connect the account first." } }, { headers });
    return Response.json({ probe: await probeDeveloperApi(access.accessToken) }, { headers });
  } catch {
    return Response.json({ error: "The connected account is temporarily unavailable." }, { status: 503, headers });
  }
});
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
