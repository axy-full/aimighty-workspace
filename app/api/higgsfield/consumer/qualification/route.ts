import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import {
  ConsumerOAuthError,
  getConsumerAccessToken,
} from "@/lib/higgsfield-consumer/oauth";
import {
  ConsumerDiscoveryError,
  readConsumerQualification,
} from "@/lib/higgsfield-consumer/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Intentionally ignores the request body: neither tool names nor arguments
 * can be selected by a client. This exposes only nine reviewed read-only checks,
 * including generate_video with immutable get_cost:true (never a submission). */
export const POST = withTenant(
  async (req: Request) => {
    const owner = await requireOwner();
    if (owner.response) return owner.response;
    const workspace = requireTenant();
    try {
      await takeAccountLimit(
        `higgsfield-consumer-qualification:${workspace.id}:${owner.user.id}`,
        3,
        60_000,
      );
      const token = await getConsumerAccessToken(workspace.id, owner.user.id);
      if (!token)
        return Response.json(
          {
            code: "not_connected",
            error:
              "Connect your account before checking its read-only contracts.",
          },
          { status: 409, headers },
        );
      return Response.json(
        await readConsumerQualification(token, { signal: req.signal }),
        { headers },
      );
    } catch (error) {
      if (error instanceof ConsumerDiscoveryError)
        return Response.json(
          { code: error.code, error: error.message },
          { status: error.status, headers },
        );
      if (error instanceof ConsumerOAuthError)
        return Response.json(
          {
            code: error.code,
            error:
              "The connected account is unavailable. Reconnect or try again later.",
          },
          { status: error.status, headers },
        );
      if (error instanceof AccountError && error.status === 429)
        return Response.json(
          {
            code: "rate_limited",
            error: "Too many qualification requests. Try again later.",
          },
          { status: 429, headers },
        );
      return Response.json(
        {
          code: "unavailable",
          error:
            "Read-only account qualification is temporarily unavailable.",
        },
        { status: 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
