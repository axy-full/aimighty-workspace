import { withTenant } from "@/lib/auth";
import { NO_STORE, crewCaller, crewFailure, crewProject } from "@/lib/crew/http";
import { CREW_EFFORTS, STANCE_MAX } from "@/lib/crew/room";
import { CrewError, addMember, listMembers, removeMember, updateMember, type MemberPatch } from "@/lib/crew/store";

export const dynamic = "force-dynamic";

/** The project's roster. GET seats the default five the first time a room is opened. */
export const GET = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const project = await crewProject(caller.userId, new URL(req.url).searchParams.get("projectId"));
    return Response.json({ members: await listMembers(caller.userId, project.id) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

export const POST = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const body = await req.json().catch(() => ({}));
    const project = await crewProject(caller.userId, body.projectId);
    const member = await addMember(caller.userId, project.id, String(body.presetId ?? ""));
    return Response.json({ member, members: await listMembers(caller.userId, project.id) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

export const PATCH = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const body = await req.json().catch(() => ({}));
    const patch: MemberPatch = {};
    const text = (value: unknown, max: number, what: string) => {
      const clean = String(value ?? "").trim();
      if (!clean) throw new CrewError(`${what} cannot be empty.`, 400);
      return clean.slice(0, max);
    };
    if (body.name !== undefined) patch.name = text(body.name, 60, "The name");
    if (body.department !== undefined) patch.department = text(body.department, 80, "The role");
    if (body.stance !== undefined) patch.stance = text(body.stance, STANCE_MAX, "The stance");
    if (body.effort !== undefined) { if (!CREW_EFFORTS.includes(body.effort)) throw new CrewError("Choose low, medium or high effort.", 400); patch.effort = body.effort; }
    if (body.active !== undefined) patch.active = body.active === true;
    if (body.isChair === true) patch.isChair = true;
    const member = await updateMember(caller.userId, String(body.id ?? ""), patch);
    return Response.json({ member, members: await listMembers(caller.userId, member.projectId) }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

export const DELETE = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    await removeMember(caller.userId, String(new URL(req.url).searchParams.get("id") ?? ""));
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
