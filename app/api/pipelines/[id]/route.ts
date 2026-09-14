import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { withTenant, requireSession } from "@/lib/auth";
import { pipelineStore } from "@/lib/pipeline/store";
import { publicRun, quotePipelineStage } from "@/lib/pipeline/service";
import { advancePipelineRun } from "@/lib/pipeline/executor";
import { requireTenant } from "@/lib/tenant";
import { withPipelineActor } from "@/lib/pipeline/actor";
import { PipelineError } from "@/lib/pipeline/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  if (error instanceof PipelineError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers },
    );
  console.error(JSON.stringify({ event: "pipeline.action_failed" }));
  return Response.json(
    {
      error: "The run could not be updated. Reload to recover its saved state.",
    },
    { status: 503, headers },
  );
}
export const GET = withTenant(async (_req: Request, ctx: Context) => {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  try {
    return Response.json(
      {
        run: publicRun(
          await (
            await pipelineStore()
          ).getRun(auth.user.id, (await ctx.params).id),
        ),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
});
export const POST = withTenant(
  async (req: Request, ctx: Context) => {
    const auth = await requireSession();
    if (auth.response) return auth.response;
    try {
      const raw = await req.text();
      if (raw.length > 4096)
        throw new PipelineError("This action is too large.", 413);
      const body = JSON.parse(raw),
        store = await pipelineStore(),
        id = (await ctx.params).id;
      let run = await store.getRun(auth.user.id, id);
      if (body.action === "quote") {
        await quotePipelineStage(
          store,
          { user: auth.user },
          id,
          body.revision,
          String(body.stageId),
          body.units,
        );
        run = await store.getRun(auth.user.id, id);
      } else if (body.action === "approve") {
        run = await store.approveQuote(
          auth.user.id,
          id,
          body.revision,
          String(body.quoteId),
          String(body.fingerprint),
        );
      } else if (
        body.action === "pause" ||
        body.action === "resume" ||
        body.action === "cancel"
      ) {
        run = await store.setState(
          auth.user.id,
          id,
          body.revision,
          body.action === "pause"
            ? "paused"
            : body.action === "resume"
              ? "running"
              : "cancelled",
        );
      } else if (body.action === "select") {
        if (
          !body.candidate ||
          typeof body.candidate.stageId !== "string" ||
          !Number.isInteger(body.candidate.unit)
        )
          throw new PipelineError("Choose a completed take.");
        run = await store.select(
          auth.user.id,
          id,
          body.revision,
          String(body.stageId),
          body.candidate,
          String(body.generationId),
        );
      } else if (body.action === "recover") {
        // Recovery cannot quote or approve any new request. It only wakes saved intent.
        await store.scheduleWake(id);
      } else throw new PipelineError("Unknown pipeline action.");
      if (["approve", "resume", "select", "recover"].includes(body.action)) {
        const workspaceId = requireTenant().id;
        after(
          await reserveRecoveryContinuation(
            "pipeline-continuation",
            async () => {
              await withPipelineActor(workspaceId, auth.user.id, (actor) =>
                advancePipelineRun(store, id, {
                  actor,
                  defer: async (work) => {
                    after(
                      await reserveRecoveryContinuation(
                        "pipeline-render",
                        work,
                      ),
                    );
                  },
                }),
              );
            },
          ),
        );
      }
      return Response.json({ run: publicRun(run) }, { headers });
    } catch (error) {
      return failure(error);
    }
  },
  { requireRequestScope: true },
);
