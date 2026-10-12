import { isSampleProject, currentPerson } from "../draftProject";
import { requireTenant } from "../tenant";
import { sampleViewOnly } from "../workbench/team-boards";
import { viewOnlyRefusal } from "../workbench/view-only";

/**
 * The marked sample production is read-only for every viewer, the workspace's owner and admins included (owner, 12 Oct): nothing is written into it. A route that
 * would write a shot, a take or a library filing into a project asks first; the answer is the one a shared board gives a teammate (403, `view_only`, in the same
 * words). Making one's own board from the sample is not a write into it. Undoing the mark lifts all of it. Background work and Atomik runs (no person) are not asked.
 */
export async function sampleWriteRefusal(projectId: string | null | undefined, person = currentPerson()): Promise<Response | null> {
  if (!person || !projectId || !(await isSampleProject(projectId))) return null;
  const { owner } = await sampleViewOnly(requireTenant());
  return Response.json({ error: viewOnlyRefusal(owner.name), code: "view_only" }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
