import { dispatchMode, EVENTS } from "../dispatch";
import { queueSender } from "../inngest";
import { requireTenant } from "../tenant";
import { exportsEnabled } from "./switch";

/**
 * Hand a queued export to the app's own worker route. Only in native mode: Inngest registers no export function
 * (lib/workers.ts), so in any other mode the caller runs the export itself. Duplicate delivery is safe: the
 * queued -> rendering claim in lib/exports/jobs.ts is one conditional update, and the worker slot is keyed on the job.
 */
export async function enqueueExport(jobId: string): Promise<boolean> {
  if (!exportsEnabled() || dispatchMode() !== "native") return false;
  const send = queueSender();
  if (!send) return false;
  try {
    await send({ id: `export-${jobId}`, name: EVENTS.exportRender, data: { jobId, workspaceId: requireTenant().id } });
    return true;
  } catch {
    return false;
  }
}
