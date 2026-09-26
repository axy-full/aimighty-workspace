import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";

/** Applied in each owning database: its mutation and receipt commit together. */
export const SECURITY_AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS security_audit (
    id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT,
    action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
    details TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS security_audit_workspace ON security_audit(workspace_id,created_at DESC,id DESC)`,
  `CREATE TRIGGER IF NOT EXISTS security_audit_no_update BEFORE UPDATE ON security_audit
    BEGIN SELECT RAISE(ABORT,'Security history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS security_audit_no_delete BEFORE DELETE ON security_audit
    BEGIN SELECT RAISE(ABORT,'Security history is append-only'); END`,
];

const actions = [
  "session.created", "session.revoked", "session.workspace_changed",
  "account.password_reset", "account.mfa_enabled", "account.mfa_replaced", "account.mfa_disabled", "account.recovery_codes_rotated", "account.recovery_code_used", "account.sessions_revoked", "member.updated", "member.removed",
  "vendor_key.updated", "vendor_key.removed", "workspace.mode_changed", "workspace.mfa_required", "workspace.mfa_optional", "workspace.restored",
  "api_token.created", "api_token.revoked", "review_link.created", "review_link.revoked",
] as const;
export type SecurityAction = (typeof actions)[number];
type Target = "account" | "member" | "workspace" | "vendor" | "api_token" | "review_link";
type Details = {
  role?: "admin" | "member";
  disabled?: boolean;
  unlocked?: boolean;
  mode?: "platform" | "own";
  scope?: "read" | "render";
  expiresAt?: number;
};
export type SecurityAuditInput = {
  workspaceId: string | null;
  actorId: string | null;
  action: SecurityAction;
  targetType: Target;
  targetId: string | null;
  details?: Details;
};

function identifier(value: string | null) {
  if (value !== null && !/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    throw new Error("Invalid security history identifier");
  return value;
}

/** Explicit fields only. Never accept prompts, names, emails, URLs or credentials. */
export function securityAuditStatement(input: SecurityAuditInput, changedOnly = false): InStatement {
  if (!(actions as readonly string[]).includes(input.action) ||
      !["account", "member", "workspace", "vendor", "api_token", "review_link"].includes(input.targetType))
    throw new Error("Invalid security history action");
  const details = input.details ?? {};
  for (const [key, value] of Object.entries(details)) {
    const valid = key === "role" ? ["admin", "member"].includes(String(value))
      : key === "mode" ? ["platform", "own"].includes(String(value))
      : key === "scope" ? ["read", "render"].includes(String(value))
      : key === "disabled" || key === "unlocked" ? typeof value === "boolean"
      : key === "expiresAt" ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      : false;
    if (!valid) throw new Error("Invalid security history detail");
  }
  return {
    sql: `INSERT INTO security_audit(id,workspace_id,actor_id,action,target_type,target_id,details,created_at)
      SELECT ?,?,?,?,?,?,?,? ${changedOnly ? "WHERE changes()>0" : ""}`,
    args: [randomUUID(), identifier(input.workspaceId), identifier(input.actorId), input.action,
      input.targetType, identifier(input.targetId), JSON.stringify(details), Date.now()],
  };
}

export type SecurityEvent = {
  id: string; workspaceId: string; actorId: string | null;
  action: SecurityAction; targetType: Target; targetId: string | null;
  details: Details; createdAt: number;
};
export type AuditCursor = { at: number; id: string };

export function parseAuditCursor(raw: string | null): AuditCursor | null {
  if (!raw) return null;
  const match = /^(\d{1,16}):([a-f0-9-]{36})$/.exec(raw);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid history cursor");
  return { at: Number(match[1]), id: match[2] };
}

/** Merge the platform and selected tenant's atomic receipts into one stable page. */
export async function readWorkspaceSecurityHistory(
  clients: Client[], workspaceId: string, limit: number, before: AuditCursor | null,
) {
  identifier(workspaceId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid history page size");
  const pages = await Promise.all([...new Set(clients)].map(async (client) => {
    const result = await client.execute({
      sql: `SELECT * FROM security_audit WHERE workspace_id=?
        ${before ? "AND (created_at<? OR (created_at=? AND id<?))" : ""}
        ORDER BY created_at DESC,id DESC LIMIT ?`,
      args: [workspaceId, ...(before ? [before.at, before.at, before.id] : []), limit + 1],
    });
    return result.rows.map((row): SecurityEvent => ({
      id: String(row.id), workspaceId: String(row.workspace_id),
      actorId: row.actor_id == null ? null : String(row.actor_id),
      action: String(row.action) as SecurityAction, targetType: String(row.target_type) as Target,
      targetId: row.target_id == null ? null : String(row.target_id),
      details: JSON.parse(String(row.details)), createdAt: Number(row.created_at),
    }));
  }));
  const merged = [...new Map(pages.flat().map((event) => [event.id, event])).values()]
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const events = merged.slice(0, limit), last = events.at(-1);
  return { events, nextCursor: merged.length > limit && last ? `${last.createdAt}:${last.id}` : null };
}
