import { billCredits } from "@/lib/creditTerms";
import { requireSuperAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { takeAccountLimit, AccountError } from "@/lib/accountDb";
import { verifyHiggsfieldConnection } from "@/lib/higgsfieldVerification";

export const dynamic = "force-dynamic";
export const maxDuration = 45;
const headers = { "Cache-Control": "private, no-store" };
export const POST = withTenant(
  async () => {
    const owner = await requireSuperAdmin();
    if (owner.response) return owner.response;
    const workspace = requireTenant();
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
    const result = await verifyHiggsfieldConnection();
    return Response.json({ ...result, estimates: Object.fromEntries(Object.entries(result.estimates).map(([resolution, estimate]) => {
      const { usd, ...status } = estimate;
      return [resolution, { ...status, ...(usd == null ? {} : { credits: billCredits(usd, "higgsfield-ai/soul/character") }) }];
    })) }, { headers });
  },
  { requireRequestScope: true },
);
