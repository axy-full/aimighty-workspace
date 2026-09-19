import { inngest, queueSender, EVENTS } from '../inngest';
import { engineMock } from '../mock';
import { getWorkspace } from '../platform';
import { requireTenant, runInTenant } from '../tenant';
import { db } from '../db';
import { runDevelopmentPhase, validateDevelopmentEvent, type DevelopmentEventData } from '../worker-handlers';

const DEVELOPMENT_EVENT = EVENTS.development;
/** The event contains identifiers only; scripts and credentials stay in tenant storage. */
export async function enqueueDevelopmentJob(id: string, owner: string): Promise<boolean> {
  if (engineMock()) return false;
  const send = queueSender();
  if (!send) return false;
  try {
    const next = (await db().execute({ sql: "SELECT step_index,status FROM workbench_development_steps WHERE job_id=? AND status<>'succeeded' ORDER BY step_index LIMIT 1", args: [id] })).rows[0];
    if (!next || next.status !== 'queued') return false;
    await send({ id: 'development-' + id + '-phase-' + String(next.step_index), name: DEVELOPMENT_EVENT,
      data: { jobId: id, owner, workspaceId: requireTenant().id } });
    return true;
  } catch {
    // A possibly delivered event and the local fallback share durable phase
    // claims. Neither can replay another worker's provider call.
    return false;
  }
}
export const developmentWorker = inngest.createFunction({
  id: 'workbench-development', name: 'Develop ideas and break down full scripts',
  triggers: [{ event: DEVELOPMENT_EVENT }],
  concurrency: [{ limit: 4 }, { limit: 2, key: 'event.data.workspaceId' }], retries: 2,
}, async ({ event, step }) => {
  const data: DevelopmentEventData = { jobId: String(event.data.jobId ?? ''), owner: String(event.data.owner ?? ''), workspaceId: String(event.data.workspaceId ?? '') };
  validateDevelopmentEvent(data);
  // At most 1m source characters, split into <=7000-character scene pieces and
  // <=8 segments/chunk. Extremely short scenes can produce more chunks, so use
  // the persisted state to terminate instead of silently imposing a script cap.
  for (let phase = 0; phase < 200; phase++) {
    const result = await step.run('phase-' + phase, async () => {
      const result = await runDevelopmentPhase(data);
      // Throw before Inngest memoizes this phase. A retry re-enters only
      // terminal settlement and cannot purchase another provider attempt.
      if (result.settlementPending) throw new Error('The saved result is awaiting ledger settlement. Retry only settlement.');
      return result;
    });
    if (result.done) return { jobId: data.jobId, complete: true };
    if (result.waiting) {
      // This invocation does not own the active paid attempt. Exit safely; the
      // owner or authenticated resume finishes subsequent unstarted phases.
      return { jobId: data.jobId, waitingForExistingClaim: true };
    }
  }
  // Inngest limits steps per run. Continue exceptionally long scripts in a
  // new event keyed by the next never-started phase, with the same reservation.
  await step.run('continue-next-batch', async () => {
    const workspace = await getWorkspace(data.workspaceId);
    if (!workspace || workspace.deletedAt || workspace.suspendedAt) throw new Error('The workspace is unavailable for development work.');
    const queued = await runInTenant(workspace, () => enqueueDevelopmentJob(data.jobId, data.owner));
    if (!queued) throw new Error('The next development batch could not be dispatched. Resume the saved job.');
  });
  return { jobId: data.jobId, continued: true };
});
