import { securityAuditStatement } from "./securityAudit";
import { platformDb, platformReady, getWorkspace } from "./platform";
import type { TenantWorkspace } from "./tenant";
import { mintTokenSecret, tokenHash } from "./auth";
import { id as newId, now } from "./db";

/**
 * Client review links (brief 2.6).
 *
 * A link opens one production's Approved takes, read only, with no login.
 * The token is stored hashed, carries an expiry, and can be revoked from
 * the production; nothing about it grants a session, and what it opens is
 * fixed when it is minted. It lives in the platform database because the
 * link has to say which workspace it belongs to before one is known.
 */
export type Share = { id: string; workspaceId: string; projectId: string; label: string; createdBy: string; createdAt: number; expiresAt: number; revokedAt: number | null };

export const SHARE_DAYS = 30;
export const MAX_SHARE_DAYS = 180;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const rowToShare = (r: any): Share => ({
  id: String(r.id), workspaceId: String(r.workspace_id), projectId: String(r.project_id),
  label: String(r.label ?? ""), createdBy: String(r.created_by ?? ""),
  createdAt: Number(r.created_at ?? 0), expiresAt: Number(r.expires_at ?? 0),
  revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
});

export const shareLive = (s: Share, at = Date.now()): boolean => !s.revokedAt && s.expiresAt > at;

export async function mintShare(input: { workspaceId: string; projectId: string; label?: string; days?: number; by: string; actorId?: string }): Promise<{ share: Share; token: string }> {
  await platformReady();
  const token = mintTokenSecret();
  const days = Math.max(1, Math.min(MAX_SHARE_DAYS, Math.round(input.days ?? SHARE_DAYS)));
  const sid = newId("shr"); const ts = now();
  await platformDb().batch([{
    sql: `INSERT INTO p_shares (id, token_hash, workspace_id, project_id, label, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [sid, tokenHash(token), input.workspaceId, input.projectId, (input.label ?? "").slice(0, 80), input.by, ts, ts + days * 86_400_000],
  }, securityAuditStatement({workspaceId:input.workspaceId,actorId:input.actorId??null,action:"review_link.created",targetType:"review_link",targetId:sid,details:{expiresAt:ts+days*86_400_000}})], "write");
  const rs = await platformDb().execute({ sql: `SELECT * FROM p_shares WHERE id = ?`, args: [sid] });
  return { share: rowToShare(rs.rows[0]), token };
}

export async function listShares(workspaceId: string, projectId: string): Promise<Share[]> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM p_shares WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC`, args: [workspaceId, projectId] });
  return rs.rows.map(rowToShare);
}

export async function revokeShare(workspaceId: string, shareId: string, actorId: string | null = null): Promise<boolean> {
  await platformReady();
  const [rs] = await platformDb().batch([{ sql: `UPDATE p_shares SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`, args: [now(), shareId, workspaceId] }, securityAuditStatement({workspaceId,actorId,action:"review_link.revoked",targetType:"review_link",targetId:shareId},true)], "write");
  return (rs.rowsAffected ?? 0) > 0;
}

/** The workspace and production a link opens, or nothing when it is unknown, spent or revoked. */
export async function resolveShare(token: string): Promise<{ share: Share; workspace: TenantWorkspace } | null> {
  if (!token || token.length < 20) return null;
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM p_shares WHERE token_hash = ? LIMIT 1`, args: [tokenHash(token)] });
  if (!rs.rows.length) return null;
  const share = rowToShare(rs.rows[0]);
  if (!shareLive(share)) return null;
  const workspace = await getWorkspace(share.workspaceId);
  // A deleted workspace's access ends at once, links included.
  return workspace && !workspace.deletedAt ? { share, workspace } : null;
}
