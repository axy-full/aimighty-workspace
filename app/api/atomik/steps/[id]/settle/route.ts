import { NextResponse, type NextRequest } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { getStep, reconcileRunningSteps } from "@/lib/atomik";
import { STEP_GONE, stepClaimedBy, stepIsMine } from "@/lib/atomikAccess";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Settle a claimed step from what the render's own request record says (lib/atomik.ts › reconcileRunningSteps): done with its take, failed, or still running when no
 * record is there yet. Nothing is written from the caller's words: no genId or status is read from the request, so a step cannot be marked done without a render, nor
 * pointed at someone else's take, and a second call changes nothing. For the person who claimed the step (an admin who approved another member's) and its own person.
 * The answer is the step's status and nothing of its chat.
 */
export const POST = withTenant(async function POST(_req: NextRequest, ctx: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  if ((await stepClaimedBy(id)) !== got.user.id && (await stepIsMine(id, got.user)) !== true) return NextResponse.json({ error: STEP_GONE }, { status: 404 });
  const step = await getStep(id);
  if (!step) return NextResponse.json({ error: STEP_GONE }, { status: 404 });
  await reconcileRunningSteps(step.chatId);
  const after = await getStep(id);
  return NextResponse.json({ status: after?.status ?? step.status });
});
