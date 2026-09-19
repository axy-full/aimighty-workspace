import { z } from "zod";
import { requireOwner, requireRender, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { ConnectedStepError, approveConnectedBatch, approveConnectedStep, pollConnectedStep, neutralReason } from "@/lib/higgsfield-consumer/planner-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * An Atomik step on the owner's connected account (slice A2).
 *
 * `approve` spends: the exact connected credits and wallet the card showed,
 * checked against the step's durable quote, then one claim and one submit
 * through the Generate page's service. `approve-batch` is ONE approval for the
 * exact summed credits of a batch's waiting steps (this step among them),
 * then one durable claim per item and one paid batch call. `status` is one leased read that
 * settles the step when the original is collected and filed.
 */
type Ctx = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "private, no-store" };
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), credits: z.number().int().positive().max(1_000_000), workspaceId: z.uuid() }).strict(),
  z.object({ action: z.literal("approve-batch"), stepIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(2).max(4), credits: z.number().int().positive().max(1_000_000), workspaceId: z.uuid() }).strict(),
  z.object({ action: z.literal("status") }).strict(),
]);

export const POST = withTenant(async (req: Request, ctx: Ctx) => {
  const owner = await requireOwner();
  if (owner.response) return owner.response;
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return Response.json({ error: "That step is gone." }, { status: 404, headers });
  try {
    const parsed = body.safeParse(JSON.parse(await readBoundedText(req, 4000)));
    if (!parsed.success) return Response.json({ error: "Review the approval." }, { status: 400, headers });
    const input = parsed.data;
    await takeAccountLimit(`atomik-connected:${requireTenant().id}:${owner.user.id}:${input.action === "approve-batch" ? "approve" : input.action}`, input.action === "status" ? 30 : 6, 60_000);
    if (input.action === "status") return Response.json(await pollConnectedStep(owner.user.id, id), { headers });
    const render = await requireRender();
    if (render.response) return render.response;
    if (input.action === "approve-batch") {
      if (!input.stepIds.includes(id)) return Response.json({ error: "Approve the batch this step belongs to." }, { status: 400, headers });
      return Response.json(await approveConnectedBatch(owner.user.id, input.stepIds, input), { headers });
    }
    return Response.json(await approveConnectedStep(owner.user.id, id, input), { headers });
  } catch (error) {
    if (error instanceof ConnectedStepError)
      return Response.json({ code: error.code, error: error.message, step: error.step ?? null }, { status: error.status, headers });
    if (error instanceof AccountError && error.status === 429)
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers });
    if (error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof SyntaxError) return Response.json({ error: "Send a valid approval." }, { status: 400, headers });
    const status = Number((error as { status?: number })?.status);
    if ((error as { code?: string })?.code === "capacity")
      return Response.json({ code: "capacity", error: "Four connected-account jobs are already active. Try again when one finishes." }, { status: 429, headers });
    return Response.json(
      { code: (error as { code?: string })?.code ?? "unavailable", error: neutralReason(error instanceof Error ? error.message : "The connected account could not complete this request.") },
      { status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 503, headers },
    );
  }
});
