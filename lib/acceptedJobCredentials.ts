import { platformDb, platformReady } from "./platform";
import { currentTenant, requireTenant, runWithStore } from "./tenant";
import type { VendorKeyName } from "./vendorKeys";

/** Call only around a provider's status, result or cancellation operation after
 * loading the accepted request from this tenant. Never wrap a submit or retry.
 * Funding recorded at admission is authoritative even after workspace policy
 * changes. Pre-meter jobs retain the original workspace-first key lookup.
 * The studio's original workspace never held keys of its own: its jobs were
 * metered as not platform-paid yet ran on the deployment's keys, so they are
 * collected with those keys. */
export async function withAcceptedJobCredentials<T>(
  id: string,
  vendor: VendorKeyName,
  collect: () => Promise<T>,
): Promise<T> {
  const workspace = requireTenant();
  const context = currentTenant()!;
  await platformReady();
  const row = (await platformDb().execute({
    sql: "SELECT paid_by_platform FROM meter_events WHERE workspace_id=? AND id=?",
    args: [workspace.id, id],
  })).rows[0];
  const own = row ? Number(row.paid_by_platform) === 0 && !workspace.legacy : Boolean(workspace.keys[vendor]);
  const key = own ? workspace.keys[vendor] : null;
  if (own && !key)
    throw new Error("The original connection is unavailable. The accepted request remains tracked; no new request was sent.");
  return runWithStore({
    ...context,
    acceptedCredential: key ? { workspaceId: workspace.id, vendor, value: key } : undefined,
  }, collect);
}
