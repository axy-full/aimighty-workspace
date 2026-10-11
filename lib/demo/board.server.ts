import { readDraft, workbenchReady } from "../workbench/records";
import type { SampleBoard } from "./board";
import { sampleCast, sampleCut } from "./content";
import { samplePlan } from "./plan";
import { readProductionRows } from "./recorded.server";
import { readSampleMark } from "./mark.server";
import { SAMPLE_LINE } from "./sample";

/* The sample's board data (lib/demo/board.ts), read for GET /api/demo/sample. Read-only; credits only, from the ledger's own record. */
export async function readSampleBoard(): Promise<SampleBoard | null> {
  const mark = await readSampleMark();
  if (!mark) return null;
  await workbenchReady();
  const [rows, source] = await Promise.all([readProductionRows(mark.projectId), readDraft(mark.draftOwner, mark.draftId)]);
  const approved = new Set(rows.jobs.filter((j) => j.approved).map((j) => j.id));
  const project = source?.project ?? null;
  return {
    sample: { projectId: mark.projectId, name: mark.name, markedAt: mark.markedAt },
    line: SAMPLE_LINE,
    plan: samplePlan(rows.shots, rows.jobs),
    cast: project ? sampleCast(project) : [],
    cut: project ? sampleCut(project, approved) : { shots: [], approved: 0, seconds: 0, approvedSeconds: 0, waiting: 0 },
  };
}
