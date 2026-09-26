import { withTenant } from "@/lib/auth";
import { creditsApply } from "@/lib/credits";
import { NO_STORE, crewCaller, crewFailure, crewProject } from "@/lib/crew/http";
import { ROUNDS_MAX } from "@/lib/crew/room";
import { quoteRound, roomRate, runRound, type RoundEvent } from "@/lib/crew/round";
import { CrewError, claimRound, listMembers, listMessages, readSession, releaseRound } from "@/lib/crew/store";
import { xaiConnected } from "@/lib/crew/xai";
import { currentTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — run one round, streamed as server-sent events: `phase`, `thinking`,
 * `message`, `failed`, `solutions`, `done`.
 *
 * Paid, so it keeps the house rule: `{ quoteOnly: true }` answers with the
 * round's ceiling in credits and spends nothing; the run must carry that
 * figure back as `maxCredits`, and a ceiling that has grown past it refuses.
 * The ceiling is reserved before the first request; what settles is the
 * tokens the provider reported, and a round that did not converge settles
 * at zero.
 */
export const POST = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req, true);
  if (caller.response) return caller.response;
  try {
    const session = await readSession(caller.userId, (await params).id);
    if (!session) throw new CrewError("That room is not in this workspace.", 404);
    const body = await req.json().catch(() => ({}));
    if (currentTenant()?.workspace?.suspendedAt) throw new CrewError("This workspace is suspended. Rendering is paused.", 403);
    if (!xaiConnected()) throw new CrewError("Add key in Workspace › Engines.", 503);
    if (!session.goal.trim()) throw new CrewError("Write the goal.", 400);
    if (session.roundsRun >= ROUNDS_MAX) throw new CrewError(`This room has run its ${ROUNDS_MAX} rounds. Start a new session.`, 409);
    const project = await crewProject(caller.userId, session.projectId);
    const active = (await listMembers(caller.userId, session.projectId)).filter((m) => m.active);
    if (!active.length) throw new CrewError("Seat at least one member.", 400);
    const rate = await roomRate(session.model);
    const transcriptChars = (await listMessages(session.id)).reduce((n, m) => n + m.text.length + m.name.length + 8, 0);
    const quote = quoteRound({ session, project, active, transcriptChars, rate });
    const credits = creditsApply(currentTenant()?.workspace);

    if (body.quoteOnly === true)
      return Response.json({ model: quote.model, calls: quote.calls, members: active.length, estimateCredits: quote.estimateCredits, ...(credits ? {} : { estimateUsd: quote.ceilingUsd }) }, { headers: NO_STORE });

    if (typeof body.maxCredits !== "number" || !Number.isInteger(body.maxCredits) || body.maxCredits < 0) throw new CrewError("Review the round's price before running it.", 409);
    if (quote.estimateCredits > body.maxCredits) throw new CrewError("The round's price changed. Review the new price before running.", 409);
    if (!(await claimRound(caller.userId, session.id))) throw new CrewError("This room is already running a round.", 409);

    const encoder = new TextEncoder();
    const userId = caller.userId;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: RoundEvent | { event: "error"; data: { error: string } }) => {
          try { controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)); } catch { /* the reader left; the round still settles */ }
        };
        try {
          const settled = await runRound({ session, project, active, rate, ceilingUsd: quote.ceilingUsd, userId, emit });
          await releaseRound(userId, session.id, settled.billed ? { spendUsd: settled.spendUsd, spendCr: settled.spendCr } : undefined);
        } catch (error) {
          await releaseRound(userId, session.id).catch(() => {});
          const status = typeof (error as { status?: unknown })?.status === "number";
          emit({ event: "error", data: { error: status && error instanceof Error ? error.message : "The round stopped. Nothing was charged." } });
          if (!status) console.error("crew round:", error);
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return crewFailure(error); }
});
