import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import {
  ConsumerOAuthError,
  getConsumerAccessToken,
} from "@/lib/higgsfield-consumer/oauth";
import { ConsumerDiscoveryError } from "@/lib/higgsfield-consumer/mcp";
import { discoverAtomikReach, discoverConsumerCapabilities } from "@/lib/higgsfield-consumer/discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Owner review only: this endpoint never calls any discovered tool.
 * `{ "view": "reach" }` returns only Atomik's per-capability flags
 * (Atomik › Tools & connections) instead of the whole catalogue. */
export const POST = withTenant(
  async (req: Request) => {
    const owner = await requireOwner();
    if (owner.response) return owner.response;
    const workspace = requireTenant();
    const body = (await req.json().catch(() => null)) as { view?: unknown } | null;
    const reach = body?.view === "reach";
    try {
      await takeAccountLimit(
        `higgsfield-consumer-discovery:${workspace.id}:${owner.user.id}`,
        6,
        60_000,
      );
      const token = await getConsumerAccessToken(workspace.id, owner.user.id);
      if (!token)
        return Response.json(
          {
            status: "unavailable",
            code: "not_connected",
            error: reach
              ? "Connect the owner’s account in Workspace › Engines."
              : "Connect your account before discovering tools.",
          },
          { status: 409, headers },
        );
      return Response.json(
        reach
          ? await discoverAtomikReach(token, req.signal)
          : await discoverConsumerCapabilities(token, req.signal),
        { headers },
      );
    } catch (error) {
      if (error instanceof ConsumerDiscoveryError)
        return Response.json(
          { status: "unavailable", code: error.code, error: error.message },
          { status: error.status, headers },
        );
      if (error instanceof ConsumerOAuthError)
        return Response.json(
          {
            status: "unavailable",
            code: error.code,
            error:
              "The connected account is unavailable. Reconnect or try again later.",
          },
          { status: error.status, headers },
        );
      if (error instanceof AccountError && error.status === 429)
        return Response.json(
          {
            status: "unavailable",
            code: "rate_limited",
            error: "Too many discovery requests. Try again later.",
          },
          { status: 429, headers },
        );
      return Response.json(
        {
          status: "unavailable",
          code: "unavailable",
          error: "Tool discovery is temporarily unavailable.",
        },
        { status: 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
