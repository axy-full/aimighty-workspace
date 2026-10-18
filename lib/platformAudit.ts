import { randomUUID, createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";

/**
 * The platform owner's audit lines: one row for each change made from the platform console (credits granted, a workspace
 * paused or resumed, an invitation made, re-sent or revoked, a public-site switch, a platform-layer part saved).
 *
 * It sits in the platform database beside `security_audit` and keeps the same promises: append-only (a trigger refuses any
 * UPDATE or DELETE), written in the SAME batch as the change it records (so there is never a change without its line, nor a
 * line without its change), and explicit fields only. A line holds ids, a word for what happened and a few checked numbers or
 * booleans, never a prompt, a name, an address, a free-text note, a link or a credential. It is the owner's: no workspace's
 * security history reads it (lib/securityAudit.ts › readWorkspaceSecurityHistory reads its own table).
 */
export const PLATFORM_AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS platform_audit (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
    action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
    workspace_id TEXT, details TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS platform_audit_recent ON platform_audit(created_at DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS platform_audit_workspace ON platform_audit(workspace_id,created_at DESC,id DESC)`,
  `CREATE TRIGGER IF NOT EXISTS platform_audit_no_update BEFORE UPDATE ON platform_audit
    BEGIN SELECT RAISE(ABORT,'Platform history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS platform_audit_no_delete BEFORE DELETE ON platform_audit
    BEGIN SELECT RAISE(ABORT,'Platform history is append-only'); END`,
];

export const PLATFORM_AUDIT_ACTIONS = [
  "credits.granted",
  "workspace.paused", "workspace.resumed",
  "invite.created", "invite.resent", "invite.revoked",
  "site.changed",
  "layer.saved", "layer.reset",
  "save.retried",
  /* The house workspace's monthly engine cap: the platform owner set it, or the month reached the warning line (lib/houseCap.ts). */
  "housecap.set", "housecap.warned",
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];
const TARGETS = ["workspace", "invite", "site", "layer", "take"] as const;
type Target = (typeof TARGETS)[number];

/** The only fields a line may carry, and what each may hold. */
export type PlatformAuditDetails = {
  /** Credits added (negative: taken away) and whether they count as free; never the note. */
  credits?: number;
  kind?: "manual";
  /** A public-site switch and the value it was set to. */
  openSignup?: boolean; visitorPages?: boolean; guestHome?: boolean;
  /** The sample's workspace was set or cleared (the id is the line's target). */
  guestWorkspace?: "set" | "cleared";
  /** How many workspaces now see the new interface by list. */
  newInterfaceWorkspaces?: number;
  /** Which platform-layer part was saved or reset. */
  part?: "setup" | "starter" | "rules" | "caps" | "models" | "plans";
  /** A failed save was tried again, and how it went. */
  saved?: boolean;
  /** The house workspace's monthly engine cap in dollars (null: the owner removed their own figure, so the default applies), and the percent of it spent when the warning was written. */
  capUsd?: number | null; atPct?: number;
  /** An invitation was sent again: false on the line written before the send (the attempt), true on the one after it went. */
  sent?: boolean;
};
export type PlatformAuditInput = {
  actorId: string;
  action: PlatformAuditAction;
  targetType: Target;
  targetId: string | null;
  workspaceId?: string | null;
  details?: PlatformAuditDetails;
};

function identifier(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new Error("Invalid platform history identifier");
  return value;
}

/** What an invitation is called in a line: not its code (the code is the link), not its address. Twelve hex characters of the code's hash. */
export function inviteRef(code: string): string {
  return `inv_${createHash("sha256").update(code).digest("hex").slice(0, 12)}`;
}

const PARTS = ["setup", "starter", "rules", "caps", "models", "plans"];

/** A once-only line's window: none of the same action and workspace dated from `since` (and before `until`, when given). */
export type PlatformAuditOnce = { since: number; until?: number };

/**
 * The row as a statement, to ride in the same batch (or transaction) as the change it records. `changedOnly` writes it only when the
 * statement before it changed a row. `once` (an instant, or a window) writes it only when no line of the same action and workspace is
 * dated in that window (a once-a-month marker). `at` is the line's date: now, unless the line records something that happened at a
 * known instant (a reservation's own time, so the marker sits in the month the spend belongs to).
 */
export function platformAuditStatement(input: PlatformAuditInput, changedOnly = false, once?: number | PlatformAuditOnce, at = Date.now()): InStatement {
  if (!(PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(input.action) || !(TARGETS as readonly string[]).includes(input.targetType))
    throw new Error("Invalid platform history action");
  const details: PlatformAuditDetails = input.details ?? {};
  for (const [key, value] of Object.entries(details)) {
    const valid = key === "credits" ? typeof value === "number" && Number.isFinite(value)
      : key === "kind" ? value === "manual"
      : key === "openSignup" || key === "visitorPages" || key === "guestHome" || key === "saved" || key === "sent" ? typeof value === "boolean"
      : key === "guestWorkspace" ? value === "set" || value === "cleared"
      : key === "newInterfaceWorkspaces" ? typeof value === "number" && Number.isInteger(value) && value >= 0
      : key === "capUsd" ? value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)
      : key === "atPct" ? typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
      : key === "part" ? PARTS.includes(String(value))
      : false;
    if (!valid) throw new Error("Invalid platform history detail");
  }
  const workspaceId = identifier(input.workspaceId ?? null);
  const window = typeof once === "number" ? { since: once } : once;
  if (!Number.isFinite(at) || (window && (!Number.isFinite(window.since) || (window.until != null && !Number.isFinite(window.until)))))
    throw new Error("Invalid platform history date");
  const conditions = [changedOnly ? "changes()>0" : null,
    window ? `NOT EXISTS (SELECT 1 FROM platform_audit WHERE action=? AND workspace_id IS ? AND created_at>=?${window.until != null ? " AND created_at<?" : ""})` : null].filter(Boolean);
  return {
    sql: `INSERT INTO platform_audit(id,actor_id,action,target_type,target_id,workspace_id,details,created_at)
      SELECT ?,?,?,?,?,?,?,? ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
    args: [randomUUID(), identifier(input.actorId), input.action, input.targetType, identifier(input.targetId), workspaceId, JSON.stringify(details), at,
      ...(window ? [input.action, workspaceId, window.since, ...(window.until != null ? [window.until] : [])] : [])],
  };
}

export type PlatformAuditLine = {
  id: string; actorId: string; action: PlatformAuditAction; targetType: Target; targetId: string | null;
  workspaceId: string | null; details: PlatformAuditDetails; createdAt: number;
};

/** The newest lines first, optionally one workspace's. The platform owner's console is the only reader. */
export async function readPlatformAudit(client: Client, opts: { workspaceId?: string; limit?: number } = {}): Promise<PlatformAuditLine[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));
  const rs = await client.execute({
    sql: `SELECT * FROM platform_audit ${opts.workspaceId ? "WHERE workspace_id=?" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
    args: opts.workspaceId ? [opts.workspaceId, limit] : [limit],
  });
  return rs.rows.map((row) => ({
    id: String(row.id), actorId: String(row.actor_id), action: String(row.action) as PlatformAuditAction, targetType: String(row.target_type) as Target,
    targetId: row.target_id == null ? null : String(row.target_id), workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
    details: JSON.parse(String(row.details)) as PlatformAuditDetails, createdAt: Number(row.created_at),
  }));
}
