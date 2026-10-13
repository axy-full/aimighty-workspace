import { NextResponse, type NextRequest } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { releaseClaim } from "@/lib/atomik";
import { STEP_GONE, stepClaimedBy } from "@/lib/atomikAccess";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Take a claimed step back to proposed when nothing was sent (a price that moved, a quote that failed), so it can be approved again. Only the person who claimed it,
 * and only while nothing was sent: its render key is fenced first, so a delayed render can never land afterwards. Frees no money (nothing was spent) and reads nothing
 * of the chat: the answer is `{released}`, or the step is gone.
 */
export const POST = withTenant(async function POST(_req: NextRequest, ctx: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  if ((await stepClaimedBy(id)) !== got.user.id) return NextResponse.json({ error: STEP_GONE }, { status: 404 });
  return NextResponse.json({ released: await releaseClaim(id, got.user.id) });
});
