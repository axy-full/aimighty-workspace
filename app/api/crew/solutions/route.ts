import { withTenant } from "@/lib/auth";
import { NO_STORE, crewCaller, crewFailure } from "@/lib/crew/http";
import { CrewError, addSolution, readMessage, removeSolution } from "@/lib/crew/store";

export const dynamic = "force-dynamic";

/** POST { messageId } — pin any transcript message as a solution. */
export const POST = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const message = await readMessage(caller.userId, String((await req.json().catch(() => ({}))).messageId ?? ""));
    if (!message) throw new CrewError("That message is not in this room.", 404);
    return Response.json({ solution: await addSolution({ sessionId: message.sessionId, round: message.round, text: message.text.slice(0, 600), source: "pin" }) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

export const DELETE = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    await removeSolution(caller.userId, String(new URL(req.url).searchParams.get("id") ?? ""));
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
