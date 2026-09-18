import { cookies } from "next/headers";
import { requireOwner, SESSION_COOKIE, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import {
  beginConsumerAuthorization,
  ConsumerOAuthError,
} from "@/lib/higgsfield-consumer/oauth";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
export const POST = withTenant(
  async () => {
    const auth = await requireOwner();
    if (auth.response) return auth.response;
    try {
      const session = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!session) throw new ConsumerOAuthError("session_changed");
      const identity = {
        workspaceId: requireTenant().id,
        userId: auth.user.id,
      };
      await takeAccountLimit(
        `higgsfield-consumer-connect:${identity.workspaceId}:${identity.userId}`,
        5,
        300_000,
      );
      return Response.json(
        await beginConsumerAuthorization(identity, session),
        { headers },
      );
    } catch (error) {
      const known =
        error instanceof ConsumerOAuthError || error instanceof AccountError;
      return Response.json(
        {
          error: known
            ? error.message
            : "The Higgsfield connection is temporarily unavailable.",
          code:
            error instanceof ConsumerOAuthError ? error.code : "unavailable",
        },
        { status: known ? error.status : 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
