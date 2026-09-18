import { inngest, inngestConfigured, EVENTS } from '../inngest';
import { requireTenant } from '../tenant';
import { withRecoveryJob } from '../recovery';
import { pendingAstraRenders, reconcileAstraRender, runAstraRender, deferAstraRenderDispatch } from './render-jobs';
/** Duplicate event delivery is safe: only the permanent queued->starting claim can purchase compute. */
export async function enqueueAstraRender(jobId: string) { if (!inngestConfigured())
    return false; try {
    await inngest.send({ id: `astra-${jobId}`, name: EVENTS.astraRender, data: { jobId, workspaceId: requireTenant().id } });
    return true;
}
catch {
    return false;
} }
export async function recoverAstraRenders(options: {
    limit?: number;
    deadlineAt?: number;
} = {}, dependencies: {
    enqueue?: typeof enqueueAstraRender;
    run?: typeof runAstraRender;
    reconcile?: typeof reconcileAstraRender;
    defer?: typeof deferAstraRenderDispatch;
} = {}) {
    const jobs = await pendingAstraRenders(options.limit ?? 4);
    const deadlineAt = options.deadlineAt ?? Date.now() + 250_000;
    let attempted = 0, failed = 0, deferred = 0;
    for (const job of jobs) {
        if (Date.now() >= deadlineAt) {
            deferred++;
            continue;
        }
        attempted++;
        try {
            await withRecoveryJob(requireTenant().id, job.id, async () => {
                if (job.status !== 'queued' || !job.funded) {
                    await (dependencies.reconcile ?? reconcileAstraRender)(job.id);
                    return;
                }
                if (await (dependencies.enqueue ?? enqueueAstraRender)(job.id)) return;
                // The render has a 180-second VM ceiling. Leave time for input
                // resolution, artifact storage and its independent stop call.
                if (deadlineAt - Date.now() >= 210_000) {
                    await (dependencies.run ?? runAstraRender)(job.id);
                    return;
                }
                if (!await (dependencies.defer ?? deferAstraRenderDispatch)(job.id)) deferred++;
            });
        }
        catch {
            failed++;
        }
    }
    return { attempted, failed, deferred };
}
