import { db } from "../db";
import { isSampleDraft, isSampleProject, currentPerson, sampleMarkNow } from "../draftProject";
import { requireTenant } from "../tenant";
import { sampleViewOnly } from "../workbench/team-boards";
import { viewOnlyRefusal } from "../workbench/view-only";

/**
 * The marked sample production is read-only for every viewer except the person it was marked from and the platform owner (owner, 13 Oct; lib/draftProject.ts mayEditSample): nothing is written into it by anyone else, admins included. A route that
 * would write a shot, a take or a library filing into a project asks first; the answer is the one a shared board gives a teammate (403, `view_only`, in the same
 * words). Making one's own board from the sample is not a write into it. Undoing the mark lifts all of it. Background work and Atomik runs (no person) are not asked.
 */
export async function sampleWriteRefusal(projectId: string | null | undefined, person = currentPerson()): Promise<Response | null> {
  if (!person || !projectId || !(await isSampleProject(projectId, undefined, person))) return null;
  const { owner } = await sampleViewOnly(requireTenant());
  return Response.json({ error: viewOnlyRefusal(owner.name), code: "view_only" }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

/** The project a row belongs to, by the one question each kind of row answers to. */
const PROJECT_OF = {
  canvas_items: "SELECT project_id FROM canvas_items WHERE id=?",
  cast_members: "SELECT project_id FROM cast_members WHERE id=?",
  boards: "SELECT project_id FROM boards WHERE id=?",
  elements: "SELECT project_id FROM elements WHERE id=?",
  shots: "SELECT project_id FROM shots WHERE id=?",
  generations: "SELECT project_id FROM generations WHERE id=?",
  runs: "SELECT project_id FROM runs WHERE id=?",
  element_attributes: "SELECT e.project_id AS project_id FROM element_attributes a JOIN elements e ON e.id=a.element_id WHERE a.id=?",
} as const;

/** The same refusal for a write to one row (a card, a cast member, a board, an asset, a shot, a take) that sits in the sample. A row that is not there, or sits elsewhere, is not asked. */
export async function sampleRowRefusal(table: keyof typeof PROJECT_OF, id: string, person = currentPerson()): Promise<Response | null> {
  if (!person || !id || !(await sampleMarkNow())) return null;
  const row = (await db().execute({ sql: PROJECT_OF[table], args: [id] })).rows[0];
  return sampleWriteRefusal(row?.project_id == null ? null : String(row.project_id), person);
}

/** The refusal for a change to the sample's production itself (its name, client, status). */
export async function sampleProductionRefusal(productionId: string, person = currentPerson()): Promise<Response | null> {
  const mark = person ? await sampleMarkNow() : null;
  if (!mark) return null;
  const row = (await db().execute({ sql: "SELECT production_id FROM projects WHERE id=?", args: [mark.projectId] })).rows[0];
  return row?.production_id != null && String(row.production_id) === productionId ? sampleWriteRefusal(mark.projectId, person) : null;
}

/** The refusal for saving a draft that is, or is linked to, the sample: a copy someone opened, or the board the mark was made from. Making one's own copy is not asked. */
export async function sampleDraftRefusal(owner: string, project: { id: string; productionProjectId?: string | null }, actor: string = owner): Promise<Response | null> {
  if (!(await isSampleDraft(owner, project.id, project.productionProjectId, undefined, actor))) return null;
  const mark = await sampleMarkNow();
  return mark ? sampleWriteRefusal(mark.projectId, { id: actor }) : null;
}

/**
 * A change to a board agent's run (stop, undo, decline, skip, a limit, a fix) on the sample: only the run's own person may press it, and for a lift run that is the
 * lifter. Anyone else is refused as view-only, whoever they are. Not asked off the sample, or of a run that is not there (the route's own answer for one stands).
 */
export async function sampleRunRefusal(productionId: string, runId: string, person = currentPerson()): Promise<Response | null> {
  if (!person || !(await isSampleProject(productionId, undefined, person))) return null;
  const row = await db().execute({ sql: "SELECT owner FROM rig_agent_runs WHERE id=? AND production_id=?", args: [runId, productionId] })
    .then((r) => r.rows[0], (error: unknown) => { if (/no such table/i.test(String(error))) return undefined; throw error; });
  if (!row || String(row.owner) === person.id) return null;
  return sampleWriteRefusal(productionId, person);
}
