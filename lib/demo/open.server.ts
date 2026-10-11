import { createHash } from "node:crypto";
import { db } from "../db";
import { requireTenant } from "../tenant";
import { readDraft, saveDraft, workbenchReady, workbenchTransaction } from "../workbench/records";
import type { Project } from "../workbench/studio";
import { SAMPLE_DRAFT_PREFIX } from "./sample";
import { readSampleMark, SampleError } from "./mark.server";

/**
 * Each person opens the sample as a draft of their own, copied from the owner's finished one: same workspace, same
 * rows, same media. One copy per workspace, person, production and mark, so a second press (a double click, a retried
 * request) opens what the first one made, and a fresh mark gives fresh copies. The copy is a draft; it writes no
 * take and no ledger row.
 */
export function sampleDraftId(workspaceId: string, viewer: string, productionId: string, markedAt: number): string {
  return SAMPLE_DRAFT_PREFIX + createHash("sha256").update(JSON.stringify([workspaceId, viewer, productionId, markedAt])).digest("hex").slice(0, 24);
}

export async function openSampleDraft(viewer: string): Promise<{ project: Project; revision: number; created: boolean }> {
  await workbenchReady();
  const mark = await readSampleMark();
  if (!mark) throw new SampleError("There is no sample production in this workspace.", 404);
  const draftId = sampleDraftId(requireTenant().id, viewer, mark.projectId, mark.markedAt);
  const existing = await readDraft(viewer, draftId);
  if (existing) return { ...existing, created: false };
  const source = await readDraft(mark.draftOwner, mark.draftId);
  if (!source || source.project.productionProjectId !== mark.projectId) throw new SampleError("The sample production is not saved any more.", 409);
  const copy: Project = { ...source.project, id: draftId, productionProjectId: mark.projectId };
  delete copy.shotMappings;
  const mappings = (await db().execute({ sql: `SELECT node_id, shot_id FROM workbench_shots WHERE owner = ? AND draft_id = ?`, args: [mark.draftOwner, mark.draftId] })).rows;
  /* Each node keeps the production's own shot, mapped before the copy's first save so the save carries the mapping. */
  await workbenchTransaction(async (tx) => {
    for (const row of mappings)
      await tx.execute({
        sql: `INSERT INTO workbench_shots(owner,draft_id,node_id,project_id,shot_id) VALUES (?,?,?,?,?) ON CONFLICT(owner,draft_id,node_id) DO NOTHING`,
        args: [viewer, draftId, String(row.node_id), mark.projectId, String(row.shot_id)],
      });
  });
  try {
    const saved = await saveDraft(viewer, copy, 0);
    return { project: { ...copy, productionProjectId: saved.productionProjectId, shotMappings: saved.shotMappings }, revision: saved.revision, created: true };
  } catch (error) {
    /* Another press of the same person saved it first: open that copy rather than fail or make a second. */
    const again = await readDraft(viewer, draftId);
    if (again) return { ...again, created: false };
    throw error;
  }
}
