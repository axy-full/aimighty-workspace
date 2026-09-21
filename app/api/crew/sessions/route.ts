import { withTenant } from "@/lib/auth";
import { NO_STORE, cleanContext, cleanGoal, crewCaller, crewFailure, crewProject } from "@/lib/crew/http";
import { createSession, listSessions } from "@/lib/crew/store";
import { xaiModel } from "@/lib/crew/xai";

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

/** POST { projectId, goal, context } → session. Free: a room costs nothing until a round runs. */
export const POST = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const body = await req.json().catch(() => ({}));
    const project = await crewProject(caller.userId, body.projectId);
    const session = await createSession(caller.userId, { projectId: project.id, goal: cleanGoal(body.goal), context: cleanContext(body.context), model: xaiModel() });
    return Response.json({ session }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
