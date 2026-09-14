import type { Client } from "@libsql/client";
import { acquireOperationLease, checkpointOperation, finishOperation, type OperationResult } from "./operationLease";

export const RECONCILIATION_OPERATION = "workspace-reconciliation";
export type ReconciliationDependencies = {
  client: Client;
  visit: (workspaceId: string, deadlineAt: number) => Promise<{ failed: boolean; completed: number; deferred?: boolean }>;
  cleanup: () => Promise<{ failed: number }>;
  clock?: () => number;
  maxWorkspaces?: number;
  budgetMs?: number;
};

/** Cursor checkpoints survive process death. A broken tenant cannot starve
 * later tenants, and overlapping HTTP invocations cannot both run a sweep. */
export async function reconcileWorkspaces(deps: ReconciliationDependencies) {
  const clock = deps.clock ?? Date.now;
  const start = clock();
  const deadlineAt = start + (deps.budgetMs ?? 140_000);
  const limit = Math.max(1, Math.min(100, deps.maxWorkspaces ?? 25));
  const lease = await acquireOperationLease(deps.client, RECONCILIATION_OPERATION, 330_000, start);
  if (!lease) return { ok: true, skipped: "already_running" as const };
  const result: OperationResult = { attempted: 0, failed: 0, completed: 0, deferred: false };
  let cycleComplete = false;
  let stopped = false;
  try {
    const rows = (await deps.client.execute({
      sql: `SELECT id FROM workspaces WHERE deleted_at IS NULL AND id>? ORDER BY id LIMIT ?`,
      args: [lease.cursor, limit + 1],
    })).rows;
    for (const row of rows.slice(0, limit)) {
      if (clock() >= deadlineAt) { stopped = true; result.deferred = true; break; }
      const workspaceId = String(row.id);
      let failed = false;
      let deferred = false;
      result.attempted++;
      try {
        const visited = await deps.visit(workspaceId, deadlineAt);
        failed = visited.failed;
        deferred = Boolean(visited.deferred);
        result.deferred ||= deferred;
        result.completed += visited.completed;
      } catch { failed = true; }
      if (failed) result.failed++;
      await checkpointOperation(deps.client, lease, workspaceId, failed, clock(), deferred);
    }
    cycleComplete = !stopped && rows.length <= limit;
    result.deferred ||= !cycleComplete;
    if (clock() < deadlineAt) {
      try { result.failed += (await deps.cleanup()).failed; }
      catch { result.failed++; }
    } else { result.deferred = true; }
  } catch {
    result.failed++;
    result.deferred = true;
  }
  await finishOperation(deps.client, lease, result, cycleComplete, clock());
  return { ok: result.failed === 0, ...result, cycleComplete };
}
