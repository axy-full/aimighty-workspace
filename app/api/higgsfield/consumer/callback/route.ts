import { cookies } from "next/headers";
import { requireOwner, SESSION_COOKIE, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import {
  consumerCallbackLocation,
  ConsumerOAuthError,
  finishConsumerAuthorization,
} from "@/lib/higgsfield-consumer/oauth";
export const runtime = "nodejs";
export const maxDuration = 30;
function result(code: Parameters<typeof consumerCallbackLocation>[0]) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: consumerCallbackLocation(code),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export const GET = withTenant(async (req: Request) => {
  try {
    const auth = await requireOwner();
    if (auth.response) return result("session_changed");
    const session = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!session) return result("session_changed");
    if (req.url.length > 8192) throw new ConsumerOAuthError("invalid_state");
    await finishConsumerAuthorization(
      { workspaceId: requireTenant().id, userId: auth.user.id },
      session,
      new URL(req.url).searchParams,
    );
    return result("connected");
  } catch (error) {
    try {
      return result(
        error instanceof ConsumerOAuthError ? error.code : "unavailable",
      );
    } catch {
      return Response.json(
        { error: "The connection is not configured." },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    }
  }
});
