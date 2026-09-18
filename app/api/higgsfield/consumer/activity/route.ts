import { requireSession, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { getConsumerCreditActivity } from "@/lib/higgsfield-consumer/activity";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Own-account reporting remains available after a role change or disconnect.
 * No query argument may select another user, tenant or provider account. */
export const GET = withTenant(
  async (req: Request) => {
    const caller = await requireSession();
    if (caller.response) return caller.response;
    const workspace = requireTenant();
    const problem = workbenchScopeProblem(
      req,
      workspace.id,
      caller.user.id,
      true,
    );
    if (problem)
      return Response.json({ error: problem }, { status: 409, headers });
    try {
      await takeAccountLimit(
        `higgsfield-consumer-activity:${workspace.id}:${caller.user.id}`,
        60,
        60_000,
      );
      return Response.json(await getConsumerCreditActivity(caller.user.id), {
        headers,
      });
    } catch (error) {
      if (error instanceof AccountError && error.status === 429)
        return Response.json(
          { error: "Too many activity requests. Try again shortly." },
          { status: 429, headers },
        );
      return Response.json(
        {
          error: "Your Higgsfield credit activity is temporarily unavailable.",
        },
        { status: 503, headers },
      );
    }
  },
  { requireRequestScope: true },
);
