import { getWorkspace, platformDb, platformReady } from "../platform";
import { currentTenant, runInTenant, type TenantUser } from "../tenant";
import type { AdmissionActor } from "../admissionTypes";
import { PipelineError } from "./schema";

/** Restore the saved owner from authoritative membership immediately before an
 * executor admission. API handlers must still scope their run lookup to the
 * authenticated owner; this helper is also callable by an authenticated worker. */
export async function withPipelineActor<T>(
  workspaceId: string,
  actorId: string,
  work: (actor: AdmissionActor) => Promise<T>,
): Promise<T> {
  const current = currentTenant();
  if (current?.token)
    throw new PipelineError(
      "Production pipelines require a signed-in member. API tokens are not supported yet.",
      403,
      "pipeline_actor",
    );
  if (
    (current?.workspace && current.workspace.id !== workspaceId) ||
    (current?.user && current.user.id !== actorId)
  )
    throw new PipelineError(
      "This pipeline belongs to another account or workspace.",
      403,
      "pipeline_actor",
    );
  await platformReady();
  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.deletedAt)
    throw new PipelineError(
      "This pipeline's workspace is no longer available.",
      403,
      "pipeline_actor",
    );
  if (workspace.suspendedAt)
    throw new PipelineError(
      "This workspace is suspended. Production is paused.",
      423,
      "pipeline_actor",
    );
  // Never SELECT a password, sealed key, session, or reset credential into worker state.
  const row = (
    await platformDb().execute({
      sql: `SELECT a.id,a.email,a.name,a.created_at,a.last_seen,m.role
      FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=? AND m.account_id=? AND m.disabled=0
        AND a.disabled=0 AND a.deleted_at IS NULL AND w.deleted_at IS NULL AND w.suspended_at IS NULL`,
      args: [workspaceId, actorId],
    })
  ).rows[0];
  if (!row || !["owner", "admin", "member"].includes(String(row.role)))
    throw new PipelineError(
      "The member who approved this pipeline no longer has active workspace access.",
      403,
      "pipeline_actor",
    );
  const user: TenantUser = {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role === "member" ? "member" : "admin",
    owner: row.role === "owner",
    disabled: false,
    createdAt: Number(row.created_at),
    lastSeen: row.last_seen == null ? null : Number(row.last_seen),
  };
  return runInTenant(workspace, () => work({ user }), { user });
}
