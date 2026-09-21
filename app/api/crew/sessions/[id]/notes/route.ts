import { withTenant } from "@/lib/auth";
import { NO_STORE, crewCaller, crewFailure } from "@/lib/crew/http";
import { NOTE_MAX } from "@/lib/crew/room";
import { CrewError, addMessage, readSession } from "@/lib/crew/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { text } — a human interjection. Members read it next round. Free. */
export const POST = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const session = await readSession(caller.userId, (await params).id);
    if (!session) throw new CrewError("That room is not in this workspace.", 404);
    const text = String((await req.json().catch(() => ({}))).text ?? "").trim().slice(0, NOTE_MAX);
    if (!text) throw new CrewError("Write the note first.", 400);
    const message = await addMessage({ sessionId: session.id, round: session.roundsRun, phase: "note", memberId: null, toMemberId: null, name: "You", department: "Producer’s desk", color: "#C9A15A", text, tokensIn: 0, tokensOut: 0 });
    return Response.json({ message: { ...message, to: null } }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
