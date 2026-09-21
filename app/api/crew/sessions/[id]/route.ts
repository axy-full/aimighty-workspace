import { withTenant } from "@/lib/auth";
import { NO_STORE, cleanContext, cleanGoal, crewCaller, crewFailure } from "@/lib/crew/http";
import { CrewError, listMembers, listMessages, listSolutions, readSession, updateSessionBrief } from "@/lib/crew/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** A room as it stands: the session, its transcript, its solutions and the project's roster. */
export const GET = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const session = await readSession(caller.userId, (await params).id);
    if (!session) throw new CrewError("That room is not in this workspace.", 404);
    const [messages, solutions, members] = await Promise.all([listMessages(session.id), listSolutions(session.id), listMembers(caller.userId, session.projectId)]);
    const names = new Map(messages.filter((m) => m.memberId).map((m) => [m.memberId!, m.name]));
    return Response.json({ session, members, solutions, messages: messages.map((m) => ({ ...m, to: m.toMemberId ? names.get(m.toMemberId) ?? members.find((x) => x.id === m.toMemberId)?.name ?? null : null })) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

/** The goal and what the room reads can change between rounds. */
export const PATCH = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const id = (await params).id;
    if (!(await readSession(caller.userId, id))) throw new CrewError("That room is not in this workspace.", 404);
    const body = await req.json().catch(() => ({}));
    await updateSessionBrief(caller.userId, id, { ...(body.goal !== undefined ? { goal: cleanGoal(body.goal) } : {}), ...(body.context !== undefined ? { context: cleanContext(body.context) } : {}) });
    return Response.json({ session: await readSession(caller.userId, id) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
