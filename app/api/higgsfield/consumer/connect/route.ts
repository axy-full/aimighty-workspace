import { cookies } from "next/headers";
import { requireOwner, SESSION_COOKIE, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import {
  backfillConsumerSubject,
  beginConsumerAuthorization,
  ConsumerOAuthError,
} from "@/lib/higgsfield-consumer/oauth";
import { isDesignatedIdentity, PLATFORM_ACCOUNT_LOCKED } from "@/lib/higgsfield-consumer/platform-account";
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
      // A new sign-in could replace the designated platform connection's
      // account; it is released on the platform desk first.
      if (await isDesignatedIdentity(identity))
        return Response.json({ error: PLATFORM_ACCOUNT_LOCKED, code: "platform_account_locked" }, { status: 409, headers });
      await takeAccountLimit(
        `higgsfield-consumer-connect:${identity.workspaceId}:${identity.userId}`,
        5,
        300_000,
      );
      // A reconnect keeps the running jobs only if Particl knows which
      // account the current grant belongs to; learn it before replacing it.
      await backfillConsumerSubject(identity);
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
            : "The connected account is temporarily unavailable.",
          code:
            error instanceof ConsumerOAuthError ? error.code : "unavailable",
        },
        { status: known ? error.status : 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
