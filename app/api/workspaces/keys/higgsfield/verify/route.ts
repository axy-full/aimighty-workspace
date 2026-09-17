import { requireOwner, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { takeAccountLimit, AccountError } from "@/lib/accountDb";
import { verifyHiggsfieldConnection } from "@/lib/higgsfieldVerification";

export const dynamic = "force-dynamic";
export const maxDuration = 45;
const headers = { "Cache-Control": "private, no-store" };
export const POST = withTenant(
  async () => {
    const owner = await requireOwner();
    if (owner.response) return owner.response;
    const workspace = requireTenant();
    // A customer's owner may inspect only their own provider account. The
    // legacy studio owner may verify the deployment's Secret configuration.
    if (!workspace.legacy && !workspace.keys.higgsfield)
      return Response.json(
        { error: "Connect your own Higgsfield account to verify it." },
        { status: 403, headers },
      );
    try {
      await takeAccountLimit(
        `higgsfield-verify:${workspace.id}:${owner.user.id}`,
        5,
        5 * 60_000,
      );
    } catch (error) {
      if (error instanceof AccountError)
        return Response.json(
          { error: error.message },
          { status: error.status, headers },
        );
      return Response.json(
        { error: "Connection verification is temporarily unavailable." },
        { status: 503, headers },
      );
    }
    return Response.json(await verifyHiggsfieldConnection(), { headers });
  },
  { requireRequestScope: true },
);
