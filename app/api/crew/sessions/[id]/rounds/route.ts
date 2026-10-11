import { withTenant } from "@/lib/auth";
import { creditsApply } from "@/lib/credits";
import { NO_STORE, crewCaller, crewFailure, crewProject } from "@/lib/crew/http";
import { ROUNDS_MAX } from "@/lib/crew/room";
import { quoteRound, roomRate, runRound, type RoundEvent } from "@/lib/crew/round";
import { CrewError, claimRound, listMembers, listMessages, readSession, releaseRound } from "@/lib/crew/store";
import { xaiConnected } from "@/lib/crew/xai";
import { currentTenant } from "@/lib/tenant";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

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
 *
 * The run also names the round it approves (`round`: the rounds run + 1).
 * That number is its key: claimRound takes only that round, so a round is
 * billed at most once however often it is sent (a second press after a lost
 * reply, or the lost request arriving late). This route is not one that
 * POST /api/generate/check can answer: it files no job and binds no
 * Idempotency-Key, so the room itself (rounds run, running) is its record.
 */
export const POST = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req, true);
  if (caller.response) return caller.response;
  /* The sample workspace spends nothing: answered before the round is claimed or reserved. A quote still answers. */
  if ((await req.clone().json().catch(() => ({})))?.quoteOnly !== true) { const off = await sampleWorkspaceOff(); if (off) return off; }
  try {
    const session = await readSession(caller.userId, (await params).id);
    if (!session) throw new CrewError("That room is not in this workspace.", 404);
    if (session.needsReview) throw new CrewError("This round needs an engine outcome review. It will not be sent again.", 409);
    const body = await req.json().catch(() => ({}));
    if (currentTenant()?.workspace?.suspendedAt) throw new CrewError("This workspace is suspended. Rendering is paused.", 403);
    if (!xaiConnected()) throw new CrewError("Crew's managed engine is unavailable.", 503);
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
    if (typeof body.round !== "number" || !Number.isInteger(body.round) || body.round < 1) throw new CrewError("Reload the room before running a round.", 409);
    if (body.round !== session.roundsRun + 1) throw new CrewError(body.round <= session.roundsRun ? `Round ${body.round} has already run. Read the room again before running another.` : "Reload the room before running a round.", 409);
    if (quote.estimateCredits > body.maxCredits) throw new CrewError("The round's price changed. Review the new price before running.", 409);
    if (!(await claimRound(caller.userId, session.id, body.round))) {
      const now = await readSession(caller.userId, session.id);
      throw new CrewError(now && now.roundsRun >= body.round ? `Round ${body.round} has already run. Read the room again before running another.` : "This room is already running a round.", 409);
    }

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
          emit({ event: "error", data: { error: status && error instanceof Error ? error.message : "The round stopped. Check the room’s outcome before trying again." } });
          if (!status) console.error("crew round:", error);
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return crewFailure(error); }
});
