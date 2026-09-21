import { withTenant } from "@/lib/auth";
import { crewCaller, crewFailure, crewProject } from "@/lib/crew/http";
import { minutesMarkdown } from "@/lib/crew/room";
import { CrewError, listMembers, listMessages, listSolutions, readSession } from "@/lib/crew/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET — the room's minutes as Markdown: goal, roster, transcript, solutions. Free. */
export const GET = withTenant(async (req: Request, { params }: Ctx) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const session = await readSession(caller.userId, (await params).id);
    if (!session) throw new CrewError("That room is not in this workspace.", 404);
    const [project, members, messages, solutions] = await Promise.all([
      crewProject(caller.userId, session.projectId), listMembers(caller.userId, session.projectId), listMessages(session.id), listSolutions(session.id),
    ]);
    const names = new Map(messages.filter((m) => m.memberId).map((m) => [m.memberId!, m.name]));
    const markdown = minutesMarkdown({
      project: project.name, goal: session.goal, model: session.model, createdAt: session.createdAt, roundsRun: session.roundsRun, spendCr: session.spendCr,
      roster: members, messages: messages.map((m) => ({ round: m.round, phase: m.phase, name: m.name, to: m.toMemberId ? names.get(m.toMemberId) ?? null : null, text: m.text })),
      solutions,
    });
    const file = `crew-minutes-${session.id}.md`;
    return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "private, no-store" } });
  } catch (error) { return crewFailure(error); }
});
