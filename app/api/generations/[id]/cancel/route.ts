import { requireRender, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { getGeneration } from "@/lib/jobs";
import { cancelGenjutsuVideo } from "@/lib/genjutsuVideo";
import { QueuedCancelError, cancelQueuedVideo, servedHere } from "@/lib/queuedCancel";
import { HiggsfieldHttpError } from "@/lib/higgsfield";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * Request queued cancellation. A connected-account (Higgsfield) video asks its provider and answers `requested`: acceptance alone
 * does not refund a take. A Seedance (BytePlus) or Kling and Topaz (fal) video is cancelled only while its provider still has it
 * queued, and its credits are released at no charge only once the provider confirms (lib/queuedCancel.ts).
 */
export const POST = withTenant(async function POST(req: Request, { params }: Context) {
  const got = await requireRender();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return Response.json({ error: "Not found." }, { status: 404 });
  const generation = await getGeneration(id);
  if (!generation) return Response.json({ error: "Not found." }, { status: 404 });
  if (got.user.role !== "admin" && generation.createdBy !== got.user.id)
    return Response.json({ error: "Only this take’s creator or a workspace administrator can cancel it." }, { status: 403 });
  try {
    const result = servedHere({ provider: generation.provider, kind: generation.kind }) ? await cancelQueuedVideo(id) : await cancelGenjutsuVideo(id);
    return Response.json(result, { status: result.status === "requested" ? 202 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof QueuedCancelError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    if (error instanceof HiggsfieldHttpError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Cancellation could not be confirmed. Refresh this existing take before trying again." }, { status: 503 });
  }
});
