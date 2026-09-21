import { withTenant } from "@/lib/auth";
import { NO_STORE, cleanContext, cleanGoal, crewCaller, crewFailure, crewProject } from "@/lib/crew/http";
import { creditsApply } from "@/lib/credits";
import { quoteRound } from "@/lib/crew/round";
import { CrewError, createSession, listMembers, listMessages, listSessions, readSession } from "@/lib/crew/store";
import { xaiConnected, xaiModel, xaiRate } from "@/lib/crew/xai";
import { currentTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** GET ?projectId= — every room this project has run. */
export const GET = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const project = await crewProject(caller.userId, new URL(req.url).searchParams.get("projectId"));
    return Response.json({ sessions: await listSessions(caller.userId, project.id) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

/**
 * POST { projectId, goal, context } → session. Free: a room costs nothing
 * until a round runs.
 *
 * With `quoteOnly`, nothing is created: it answers what the next round would
 * cost at most, so Run round can wear its price before a room exists
 * (`sessionId` adds the transcript that room's next round would read).
 */
export const POST = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const body = await req.json().catch(() => ({}));
    const project = await crewProject(caller.userId, body.projectId);
    const goal = cleanGoal(body.goal), context = cleanContext(body.context);
    if (body.quoteOnly === true) {
      if (!xaiConnected()) throw new CrewError("Add key in Workspace › Engines.", 503);
      const rate = await xaiRate();
      if (!rate) throw new CrewError("This engine cannot be priced right now, so the room will not run.", 503);
      const active = (await listMembers(caller.userId, project.id)).filter((m) => m.active);
      if (!active.length) throw new CrewError("Seat at least one member.", 400);
      const existing = typeof body.sessionId === "string" ? await readSession(caller.userId, body.sessionId) : null;
      const transcriptChars = existing ? (await listMessages(existing.id)).reduce((n, m) => n + m.text.length + m.name.length + 8, 0) : 0;
      const session = { id: "", projectId: project.id, goal, context, model: xaiModel(), roundsRun: existing?.roundsRun ?? 0, spendCr: null, spendUsd: 0, createdBy: caller.userId, createdAt: 0 };
      const quote = quoteRound({ session, project, active, transcriptChars, rate });
      return Response.json({ model: quote.model, calls: quote.calls, members: active.length, estimateCredits: quote.estimateCredits, ...(creditsApply(currentTenant()?.workspace) ? {} : { estimateUsd: quote.ceilingUsd }) }, { headers: NO_STORE });
    }
    const session = await createSession(caller.userId, { projectId: project.id, goal, context, model: xaiModel() });
    return Response.json({ session }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
