import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import {
  backfillConsumerSubject,
  getConsumerAccess,
  getConsumerConnection,
  removeConsumerConnection,
} from "@/lib/higgsfield-consumer/oauth";
import { probeDeveloperApi } from "@/lib/higgsfield-consumer/developer-api";
import { consumerCapacity, setAsideConsumerJob } from "@/lib/higgsfield-consumer/jobs";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
/**
 * `developer-probe`: one free read against the account's developer API with the
 * grant this app holds, so the owner can see whether setup items and DTC ads
 * can be built on it. Owner only, twelve a minute, never spends.
 *
 * `set-aside`: the owner sets one of their own unsettled connected jobs aside
 * so it stops holding one of the workspace's four slots. Ledger only: nothing
 * is sent, deleted or resubmitted, and the job stays listed and recoverable.
 */
export const POST = withTenant(async (req: Request) => {
  const auth = await requireOwner();
  if (auth.response) return auth.response;
  const identity = { workspaceId: requireTenant().id, userId: auth.user.id };
  const scope = workbenchScopeProblem(req, identity.workspaceId, identity.userId, true);
  if (scope) return Response.json({ error: scope }, { status: 409, headers });
  const body = await req.json().catch(() => null) as { action?: unknown; id?: unknown } | null;
  if (body?.action === "set-aside") {
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return Response.json({ error: "Review the request." }, { status: 400, headers });
    try {
      await takeAccountLimit(`hf-consumer-connection:${identity.workspaceId}:${identity.userId}:set-aside`, 12, 60_000);
      if (!(await setAsideConsumerJob({ userId: identity.userId, id: body.id })))
        return Response.json({ error: "This job is settled, already set aside, or too recent to set aside." }, { status: 409, headers });
      return Response.json({ capacity: await consumerCapacity(identity.userId) }, { headers });
    } catch (error) {
      if (error instanceof AccountError && error.status === 429) return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
      return Response.json({ error: "The job could not be set aside. Try again." }, { status: 503, headers });
    }
  }
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
    // The owner's view of the four shared slots rides along, so a reconnect,
    // disconnect or blocked job can say which jobs are still running.
    const [read, capacity] = await Promise.all([getConsumerConnection(identity), consumerCapacity(identity.userId).catch(() => null)]);
    let connection = read;
    // A grant that never recorded its account learns it here, with one free
    // read, before the owner can reconnect or disconnect (a few a minute).
    if (connection.connected && connection.subjectKnown === false) {
      const allowed = await takeAccountLimit(`hf-consumer-connection:${identity.workspaceId}:${identity.userId}:subject`, 4, 60_000).then(() => true, () => false);
      if (allowed && (await backfillConsumerSubject(identity))) connection = await getConsumerConnection(identity);
    }
    return Response.json({ ...connection, capacity }, { headers });
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
