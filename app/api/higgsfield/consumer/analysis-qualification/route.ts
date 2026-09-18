import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import {
  ConsumerOAuthError,
  getConsumerAccessToken,
} from "@/lib/higgsfield-consumer/oauth";
import {
  ConsumerDiscoveryError,
  readConsumerAnalysisQualification,
} from "@/lib/higgsfield-consumer/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 45;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** No body/query arguments can select a tool or model. These two fixed metadata
 * reads neither quote nor submit scoring, upload media or change a workspace. */
export const POST = withTenant(
  async (req: Request) => {
    const owner = await requireOwner();
    if (owner.response) return owner.response;
    const workspace = requireTenant();
    try {
      await takeAccountLimit(
        `higgsfield-consumer-analysis-qualification:${workspace.id}:${owner.user.id}`,
        3,
        60_000,
      );
      const token = await getConsumerAccessToken(workspace.id, owner.user.id);
      if (!token)
        return Response.json(
          {
            code: "not_connected",
            error:
              "Connect your Higgsfield account before checking analysis model definitions.",
          },
          { status: 409, headers },
        );
      return Response.json(
        await readConsumerAnalysisQualification(token, { signal: req.signal }),
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
              "The Higgsfield connection is unavailable. Reconnect or try again later.",
          },
          { status: error.status, headers },
        );
      if (error instanceof AccountError && error.status === 429)
        return Response.json(
          {
            code: "rate_limited",
            error: "Too many analysis qualification requests. Try again later.",
          },
          { status: 429, headers },
        );
      return Response.json(
        {
          code: "unavailable",
          error:
            "Higgsfield analysis model definitions are temporarily unavailable.",
        },
        { status: 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
