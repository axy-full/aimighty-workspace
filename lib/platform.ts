import { fenceDatabase } from "./recoveryDatabaseClient";
import { columnInstaller } from "./schemaInitialization";
import { ACCOUNT_SECURITY_SCHEMA } from "./accountSecuritySchema";
import { SECURITY_AUDIT_SCHEMA, securityAuditStatement } from "./securityAudit";
import { createClient, type Client } from "@libsql/client";
import { isPaidKind, type GrantKind } from "./creditTerms";
import { asPlanId, planById, DEFAULT_PLANS, type PlanId, type PlanDef } from "./plans";
import { randomBytes, createHash } from "node:crypto";
import { seal, open } from "./keyring";
import { runInTenant, type TenantWorkspace, type WorkspaceRole } from "./tenant";
import { mergeLayer, LAYER_KEYS, type PlatformLayer, type LayerKey } from "./platformLayer";
import { prepareLocalDatabaseDirectory } from "./localDatabase";
import { createPlatformDatabaseClient } from "./localDatabaseClient";

/**
 * The platform: what spans workspaces.
 *
 * Accounts (one per person, one password), workspaces (one database
 * each), memberships (owner · admin · member), sessions (which account, in
 * which workspace), and the two kinds of invitation — a sign-up invite,
 * which lets a stranger create an account and a workspace of their own,
 * and a workspace invite, which brings someone onto an existing team.
 *
 * It lives in the primary database by default — the same Turso database
 * the studio always had — and can be moved to its own with
 * PLATFORM_DATABASE_URL. Nothing a workspace makes is ever stored here;
 * what a workspace brought (its vendor keys, its database token) is
 * stored sealed.
 */

let _client: Client | null = null;
export function platformDb(): Client {
  if (!_client) {
    const url = process.env.PLATFORM_DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? "file:.data/ark.db";
    _client = fenceDatabase(createPlatformDatabaseClient({
      url,
      authToken: process.env.PLATFORM_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
    }));
  }
  return _client;
}

export const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL ?? "axy@akshaypanchal.com").trim().toLowerCase();
export const isSuperAdmin = (email: string | null | undefined) =>
  Boolean(email) && String(email).trim().toLowerCase() === SUPER_ADMIN_EMAIL;

const SCHEMA = [
  ...SECURITY_AUDIT_SCHEMA,
  ...ACCOUNT_SECURITY_SCHEMA,
  `CREATE TABLE IF NOT EXISTS accounts (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     name          TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     disabled      INTEGER NOT NULL DEFAULT 0,
     failed_count  INTEGER NOT NULL DEFAULT 0,
     locked_until  INTEGER,
     last_seen     INTEGER,
     created_at    INTEGER NOT NULL,
     deleted_at    INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     id                 TEXT PRIMARY KEY,
     slug               TEXT NOT NULL UNIQUE,
     name               TEXT NOT NULL,
     db_url             TEXT NOT NULL,
     db_token_enc       TEXT,
     db_name            TEXT,
     legacy             INTEGER NOT NULL DEFAULT 0,
     uses_platform_keys INTEGER NOT NULL DEFAULT 0,
     keys_enc           TEXT,
     allowance_usd      REAL,
     gateway_key_id     TEXT,
     owner_id           TEXT NOT NULL,
     plan_id            TEXT,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER NOT NULL
   )`,
  /* Credits added to a workspace: the welcome grant, and whatever
     management adds. The balance is these minus the spend read off the
     workspace's own tables (lib/credits.ts). */
  `CREATE TABLE IF NOT EXISTS credit_grants (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT NOT NULL,
     credits       REAL NOT NULL,
     note          TEXT,
     kind          TEXT NOT NULL DEFAULT 'manual',
     created_by    TEXT,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS credit_grants_ws ON credit_grants(workspace_id)`,
  `CREATE TABLE IF NOT EXISTS topup_requests (
     id             TEXT PRIMARY KEY,
     bonus_credits  REAL NOT NULL DEFAULT 0,
     workspace_id   TEXT NOT NULL,
     pack_id        TEXT NOT NULL,
     label          TEXT,
     credits        REAL NOT NULL,
     usd            REAL NOT NULL,
     status         TEXT NOT NULL DEFAULT 'requested',
     note           TEXT,
     requested_by   TEXT,
     created_at     INTEGER NOT NULL,
     decided_at     INTEGER,
     decided_by     TEXT,
     decision_note  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS topup_requests_ws ON topup_requests(workspace_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS topup_requests_status ON topup_requests(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS platform_assets (
     key                 TEXT PRIMARY KEY,
     path                TEXT NOT NULL,
     bytes               INTEGER NOT NULL DEFAULT 0,
     mime                TEXT NOT NULL DEFAULT 'video/mp4',
     source_workspace_id TEXT,
     source_gen_id       TEXT,
     model               TEXT,
     cost_usd            REAL,
     created_by          TEXT,
     created_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reports (
     id            TEXT PRIMARY KEY,
     ip_hash       TEXT,
     url           TEXT NOT NULL,
     reason        TEXT NOT NULL,
     details       TEXT,
     email         TEXT,
     account_id    TEXT,
     workspace_id  TEXT,
     created_at    INTEGER NOT NULL,
     handled_at    INTEGER,
     handled_by    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS reports_open ON reports(handled_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS platform_layer (
     key         TEXT PRIMARY KEY,
     value       TEXT NOT NULL,
     updated_at  INTEGER NOT NULL,
     updated_by  TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS meter_events (
     id               TEXT PRIMARY KEY,
     workspace_id     TEXT NOT NULL,
     project_id       TEXT,
     shot_id          TEXT,
     kind             TEXT NOT NULL,
     engine           TEXT NOT NULL,
     model            TEXT NOT NULL,
     status           TEXT NOT NULL,
     engine_cost_usd  REAL,
     billed_credits   REAL,
     paid_by_platform INTEGER NOT NULL DEFAULT 0,
     duration_ms      INTEGER,
     created_by       TEXT,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS meter_events_ws ON meter_events(workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS memberships (
     workspace_id TEXT NOT NULL,
     account_id   TEXT NOT NULL,
     role         TEXT NOT NULL DEFAULT 'member',
     disabled     INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, account_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id)`,
  `CREATE TABLE IF NOT EXISTS p_sessions (
     token_hash   TEXT PRIMARY KEY,
     account_id   TEXT NOT NULL,
     workspace_id TEXT,
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_psessions_account ON p_sessions(account_id)`,
  /* A client review link (brief 2.6): a production's Approved takes, read
     only, no login. It lives here because the link is resolved before any
     workspace is known — the token says which one. Expiring and revocable,
     and it never carries a session: what it opens is fixed at minting. */
  `CREATE TABLE IF NOT EXISTS p_shares (
     id           TEXT PRIMARY KEY,
     token_hash   TEXT NOT NULL UNIQUE,
     workspace_id TEXT NOT NULL,
     project_id   TEXT NOT NULL,
     label        TEXT NOT NULL DEFAULT '',
     created_by   TEXT NOT NULL DEFAULT '',
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL,
     revoked_at   INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shares_project ON p_shares(workspace_id, project_id)`,
  `CREATE TABLE IF NOT EXISTS signup_invites (
     code       TEXT PRIMARY KEY,
     email      TEXT NOT NULL,
     name       TEXT NOT NULL DEFAULT '',
     note       TEXT NOT NULL DEFAULT '',
     created_by TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER,
     sent_at    INTEGER,
     send_count INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS workspace_invites (
     code         TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     email        TEXT NOT NULL,
     name         TEXT NOT NULL DEFAULT '',
     role         TEXT NOT NULL DEFAULT 'member',
     created_by   TEXT,
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL,
     used_at      INTEGER,
     sent_at      INTEGER,
     send_count   INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_wsinvites_ws ON workspace_invites(workspace_id)`,
  /* Shared with the original schema — created here too so a separate
     platform database has them. */
  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip_hash TEXT NOT NULL, email TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (ip_hash, email)
   )`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, ip_hash TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS access_requests (
     id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
     ip_hash TEXT NOT NULL DEFAULT '', mailed INTEGER NOT NULL DEFAULT 0, handled_at INTEGER, created_at INTEGER NOT NULL
   )`,
];

export const now = () => Date.now();
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToWorkspace(r: any): TenantWorkspace {
  let keys: Record<string, string> = {};
  if (r.keys_enc) { try { keys = JSON.parse(open(String(r.keys_enc))); } catch { keys = {}; } }
  let dbToken: string | null = null;
  if (r.db_token_enc) { try { dbToken = open(String(r.db_token_enc)); } catch { dbToken = null; } }
  const legacy = Number(r.legacy ?? 0) === 1;
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name),
    legacy,
    /* The legacy workspace's database is the primary one; its URL and token
       are the environment's, never copied into a row. */
    dbUrl: legacy ? (process.env.TURSO_DATABASE_URL ?? "file:.data/ark.db") : String(r.db_url),
    dbToken: legacy ? (process.env.TURSO_AUTH_TOKEN ?? null) : dbToken,
    keys,
    usesPlatformKeys: Number(r.uses_platform_keys ?? 0) === 1,
    allowanceUsd: r.allowance_usd == null ? null : Number(r.allowance_usd),
    gatewayKeyId: r.gateway_key_id ? String(r.gateway_key_id) : null,
    ownerId: String(r.owner_id), createdAt: Number(r.created_at ?? 0),
    requiresMfa: Number(r.requires_mfa ?? 0) === 1,
    suspendedAt: r.suspended_at == null ? null : Number(r.suspended_at),
    suspendedReason: r.suspended_reason ? String(r.suspended_reason) : null,
    flaggedAt: r.flagged_at == null ? null : Number(r.flagged_at),
    flagNote: r.flag_note ? String(r.flag_note) : null,
    concurrency: r.concurrency == null ? null : Number(r.concurrency),
    rendersPerHour: r.renders_per_hour == null ? null : Number(r.renders_per_hour),
    storageQuotaBytes: r.storage_quota_bytes == null ? null : Number(r.storage_quota_bytes),
    /* NULL is "on no plan", which is every workspace until somebody is put
       on one — and it is also what a workspace created by older code lands
       on during a rolling deploy, so the safe value and the correct value
       are the same value. Not defaulted to `invite`: Invite carries a
       1-production and 3-member ceiling, and applying that to workspaces
       already past it would lock people out of their own work. */
    planId: asPlanId(r.plan_id),
    internalTest: Number(r.internal_test ?? 0) === 1,
    deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
  };
}

/** A workspace's own limits; null puts a number back to the platform's default. */
export async function setWorkspaceLimits(id: string, l: { concurrency?: number | null; rendersPerHour?: number | null; storageGb?: number | null }): Promise<void> {
  await platformReady();
  const sets: string[] = []; const args: (number | null | string)[] = [];
  const num = (v: number | null | undefined, lo: number, hi: number) => (v == null || !Number.isFinite(v) ? null : Math.max(lo, Math.min(hi, v)));
  if (l.concurrency !== undefined) { sets.push("concurrency = ?"); args.push(num(l.concurrency, 1, 100) == null ? null : Math.round(num(l.concurrency, 1, 100)!)); }
  if (l.rendersPerHour !== undefined) { sets.push("renders_per_hour = ?"); args.push(num(l.rendersPerHour, 1, 10_000) == null ? null : Math.round(num(l.rendersPerHour, 1, 10_000)!)); }
  if (l.storageGb !== undefined) { const g = num(l.storageGb, 0.1, 100_000); sets.push("storage_quota_bytes = ?"); args.push(g == null ? null : Math.round(g * 1e9)); }
  if (!sets.length) return;
  sets.push("updated_at = ?"); args.push(now()); args.push(id);
  await platformDb().execute({ sql: `UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`, args });
}

/** Pause a workspace's rendering, with a reason it will be shown — or lift it. */
export async function setWorkspaceSuspended(id: string, suspended: boolean, reason: string | null): Promise<void> {
  await platformReady();
  await platformDb().execute({
    sql: `UPDATE workspaces SET suspended_at = ?, suspended_reason = ?, updated_at = ? WHERE id = ?`,
    args: [suspended ? now() : null, suspended ? (reason ?? "").slice(0, 300) || null : null, now(), id],
  });
}

/** Mark a workspace for review — a content-policy flag with a note — or clear it. */
export async function setWorkspaceFlag(id: string, flagged: boolean, note: string | null): Promise<void> {
  await platformReady();
  await platformDb().execute({
    sql: `UPDATE workspaces SET flagged_at = ?, flag_note = ?, updated_at = ? WHERE id = ?`,
    args: [flagged ? now() : null, flagged ? (note ?? "").slice(0, 300) || null : null, now(), id],
  });
}

/**
 * The grant-kind migration, as statements rather than inline SQL, so
 * `tests/unit/grantMigration.spec.ts` can run THESE against a populated
 * database instead of a copy of them that could drift.
 *
 * Classified by the note, because on a row written before there were kinds
 * the note is all there is. The welcome grant writes a fixed string; a top-up
 * writes "<Label> pack · N credits". Anything else was an admin, which is
 * what the column's default already says, so there is no third statement.
 */
export const GRANT_KIND_COLUMN = `kind TEXT NOT NULL DEFAULT 'manual'`;
export const GRANT_KIND_BACKFILL = [
  `UPDATE credit_grants SET kind = 'welcome' WHERE note = 'Welcome credits'`,
  `UPDATE credit_grants SET kind = 'purchase' WHERE note LIKE '% pack · %'`,
];

/**
 * §7A's bonus credits, frozen on the request beside the size and the price.
 *
 * No backfill: every request written before this existed was for a pack that
 * had no bonus, and the default says so. Zero is the truth for all of them,
 * which is the cheapest migration there is.
 */
export const TOPUP_BONUS_COLUMN = `bonus_credits REAL NOT NULL DEFAULT 0`;

let _ready: Promise<void> | null = null;
/**
 * Create the platform tables, and — once — turn the studio's own database
 * into the first workspace: every existing user becomes an account with a
 * membership there, the owner being the super admin.
 */
export function platformReady(): Promise<void> {
  if (!_ready) {
    _ready = (async () => {
      const p = platformDb();
      await p.batch(SCHEMA, "write");
      const addColumn = await columnInstaller(p);
      /* Columns added after the table first shipped reach an existing
         database only by ALTER; a duplicate is the one error to ignore. */
      for (const col of [`allowance_usd REAL`, `gateway_key_id TEXT`, `suspended_at INTEGER`, `suspended_reason TEXT`, `flagged_at INTEGER`, `flag_note TEXT`, `concurrency INTEGER`, `renders_per_hour INTEGER`, `storage_quota_bytes INTEGER`, `deleted_at INTEGER`, `purged_at INTEGER`, `internal_test INTEGER`, `plan_id TEXT`, `requires_mfa INTEGER NOT NULL DEFAULT 0`]) {
        await addColumn("workspaces", col);
      }
      for (const col of [`accepted_policy_at INTEGER`]) {
        await addColumn("accounts", col);
      }
      // Existing grants are classified once, atomically with the new column.
      // Already-migrated databases skip the data scan on cold starts.
      await addColumn("credit_grants", GRANT_KIND_COLUMN, GRANT_KIND_BACKFILL);
      await addColumn("topup_requests", TOPUP_BONUS_COLUMN);
      /* Reporting content is open to anybody — a victim must not need an
         account — so the counting has to be by something an anonymous caller
         still has. Salted and truncated, the same shape access_requests
         already uses: this exists to count, not to identify. */
      for (const col of [`ip_hash TEXT`]) {
        await addColumn("reports", col);
      }
      const count = await p.execute(`SELECT COUNT(*) AS n FROM workspaces`);
      if (Number((count.rows[0] as any)?.n ?? 0) === 0) await importLegacy();
    })().catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

/** The original workspace, from the original users table. */
async function importLegacy(): Promise<void> {
  const p = platformDb();
  const url = process.env.TURSO_DATABASE_URL ?? "file:.data/ark.db";
  prepareLocalDatabaseDirectory(url);
  const legacyDb = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  let users: any[] = [];
  try {
    const rs = await legacyDb.execute(`SELECT id, email, name, password_hash, role, disabled, created_at, last_seen FROM users WHERE deleted_at IS NULL`);
    users = rs.rows as any[];
  } catch { users = []; /* a brand-new deployment: no users yet */ }
  if (users.length === 0) return; // nothing to inherit; setup creates the first owner
  const ts = now();
  const owner = users.find((u) => isSuperAdmin(String(u.email))) ?? users.find((u) => u.role === "admin") ?? users[0];
  const wsId = "ws_legacy";
  await p.execute({
    sql: `INSERT OR IGNORE INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at)
          VALUES (?,?,?,?,?,1,1,?,?,?)`,
    args: [wsId, "aimighty", process.env.LEGACY_WORKSPACE_NAME ?? "Aimighty", "(primary)", null, String(owner.id), ts, ts],
  });
  for (const u of users) {
    await p.execute({
      sql: `INSERT OR IGNORE INTO accounts (id, email, name, password_hash, disabled, created_at, last_seen) VALUES (?,?,?,?,?,?,?)`,
      args: [String(u.id), String(u.email).toLowerCase(), String(u.name), String(u.password_hash), Number(u.disabled ?? 0), Number(u.created_at ?? ts), u.last_seen == null ? null : Number(u.last_seen)],
    });
    const role: WorkspaceRole = String(u.id) === String(owner.id) ? "owner" : u.role === "admin" ? "admin" : "member";
    await p.execute({
      sql: `INSERT OR IGNORE INTO memberships (workspace_id, account_id, role, disabled, created_at) VALUES (?,?,?,?,?)`,
      args: [wsId, String(u.id), role, Number(u.disabled ?? 0), ts],
    });
  }
}

/* ── accounts ─────────────────────────────────────────────────────────── */

export async function findAccountByEmail(email: string): Promise<any | null> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL LIMIT 1`, args: [email.trim().toLowerCase()] });
  return rs.rows[0] ?? null;
}
export async function getAccount(id: string): Promise<any | null> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM accounts WHERE id = ? LIMIT 1`, args: [id] });
  return rs.rows[0] ?? null;
}
export async function accountCount(): Promise<number> {
  await platformReady();
  const rs = await platformDb().execute(`SELECT COUNT(*) AS n FROM accounts WHERE deleted_at IS NULL`);
  return Number((rs.rows[0] as any)?.n ?? 0);
}
export async function createAccount(email: string, name: string, passwordHash: string): Promise<{ id: string; email: string; name: string }> {
  await platformReady();
  const id = newId("usr");
  await platformDb().execute({
    sql: `INSERT INTO accounts (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)`,
    args: [id, email.trim().toLowerCase(), name.trim().slice(0, 80), passwordHash, now()],
  });
  return { id, email: email.trim().toLowerCase(), name: name.trim().slice(0, 80) };
}

/* ── workspaces & memberships ─────────────────────────────────────────── */

export async function getWorkspace(id: string): Promise<TenantWorkspace | null> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM workspaces WHERE id = ? LIMIT 1`, args: [id] });
  return rs.rows[0] ? rowToWorkspace(rs.rows[0]) : null;
}
export async function legacyWorkspace(): Promise<TenantWorkspace | null> {
  await platformReady();
  const rs = await platformDb().execute(`SELECT * FROM workspaces WHERE legacy = 1 LIMIT 1`);
  return rs.rows[0] ? rowToWorkspace(rs.rows[0]) : null;
}
export async function listWorkspaces(): Promise<TenantWorkspace[]> {
  await platformReady();
  const rs = await platformDb().execute(`SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at`);
  return rs.rows.map(rowToWorkspace);
}
export async function membershipRole(workspaceId: string, accountId: string): Promise<WorkspaceRole | null> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT role FROM memberships WHERE workspace_id = ? AND account_id = ? AND disabled = 0 LIMIT 1`,
    args: [workspaceId, accountId],
  });
  const r = (rs.rows[0] as any)?.role;
  return r === "owner" || r === "admin" || r === "member" ? r : null;
}
export async function workspacesFor(accountId: string): Promise<{ workspace: TenantWorkspace; role: WorkspaceRole }[]> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT w.*, m.role AS m_role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.account_id = ? AND m.disabled = 0 AND w.deleted_at IS NULL ORDER BY w.created_at`,
    args: [accountId],
  });
  return rs.rows.map((r: any) => ({ workspace: rowToWorkspace(r), role: r.m_role }));
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";

/**
 * Does a workspace that signs up run on the platform's keys? Yes unless the
 * deployment says otherwise — a new workspace should render on day one,
 * within its allowance, rather than open onto five empty key fields.
 */
export function platformKeysByDefault(): boolean {
  return process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES !== "0";
}

/** Existing callers use the same durable, zero-grant customer provisioning path. */
export async function createWorkspace(input: { name: string; owner: { id: string; email: string; name: string } }): Promise<TenantWorkspace> {
  const {requestWorkspace,resumeWorkspace}=await import('./workspaceProvisioning');
  const requestId=await requestWorkspace(input);
  const result=await resumeWorkspace(requestId,input.owner.id);
  if(result.workspace)return result.workspace;
  throw new Error(result.provisioning.error??'Workspace setup is pending. Resume this request from the workspace chooser.');
}

/** Whose keys a workspace's engines run on. */
export async function setWorkspaceMode(id: string, usesPlatformKeys: boolean, actorId: string | null = null): Promise<void> {
  await platformReady();
  await platformDb().batch([{
    sql: `UPDATE workspaces SET uses_platform_keys = ?, updated_at = ? WHERE id = ? AND legacy = 0`,
    args: [usesPlatformKeys ? 1 : 0, now(), id],
  }, securityAuditStatement({ workspaceId:id, actorId, action:"workspace.mode_changed", targetType:"workspace", targetId:id, details:{mode:usesPlatformKeys?"platform":"own"}}, true)], "write");
}

/** Dollars a month on the platform's keys; null returns it to the deployment's default. */
export async function setWorkspaceAllowance(id: string, usd: number | null): Promise<void> {
  await platformDb().execute({
    sql: `UPDATE workspaces SET allowance_usd = ?, updated_at = ? WHERE id = ? AND legacy = 0`,
    args: [usd, now(), id],
  });
}

/** Credits added to a workspace, by management. Negative takes them away. */
/**
 * Add credits to a workspace, saying where they came from.
 *
 * `kind` has no default. Every caller has to decide whether money arrived for
 * these credits, because that is the question the platform's own margin
 * figure is answered from, and a default would let the next caller not think
 * about it — which is exactly how the welcome grant came to read as revenue.
 */
export async function grantCredits(workspaceId: string, credits: number, note: string, by: string | null, kind: GrantKind): Promise<void> {
  await grantCreditsBatch([{workspaceId,credits,note,by,kind}]);
}

/**
 * Several grants, or none.
 *
 * A pack that carries bonus credits is TWO rows — what was bought and what
 * was given — because they are different kinds and the platform's revenue
 * figure reads the difference. Two separate INSERTs would have a gap in the
 * middle: the request is already marked approved by the time either runs, so
 * a failure between them leaves a paying customer short of the bonus with
 * nothing left that will retry it. One batch, or neither row.
 */
export async function grantCreditsBatch(
  rows: { workspaceId: string; credits: number; note: string; by: string | null; kind: GrantKind }[],
): Promise<void> {
  if (!rows.length) return;
  const {billingTransaction,syncBillingLedger}=await import('./billingLedger');
  await billingTransaction(async(tx,ts)=>{
    const workspaces=[...new Set(rows.map(r=>r.workspaceId))];
    // Bootstrap before inserting so a first paid pack cannot be mistaken for
    // an old, non-expiring grant. Its clock starts when management grants it.
    for(const workspaceId of workspaces)await syncBillingLedger(tx,workspaceId,ts);
    for(const r of rows)await tx.execute({
      sql: `INSERT INTO credit_grants (id, workspace_id, credits, note, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?)`,
      args: [newId("cg"), r.workspaceId, r.credits, r.note.slice(0, 200), r.kind, r.by, ts],
    });
    for(const workspaceId of workspaces)await syncBillingLedger(tx,workspaceId,ts);
  });
}

export type GrantSplit = { paid: number; free: number };

/**
 * Bought credits and given credits, per workspace, in one query.
 *
 * One query rather than one per workspace because the admin console asks for
 * every workspace at once and is polled; a per-workspace call there is a
 * table scan a minute per workspace.
 */
export async function grantsByKind(): Promise<Map<string, GrantSplit>> {
  await platformReady();
  const rs = await platformDb().execute(
    `SELECT workspace_id, kind, COALESCE(SUM(credits), 0) AS n FROM credit_grants GROUP BY workspace_id, kind`,
  );
  const out = new Map<string, GrantSplit>();
  for (const row of rs.rows as unknown as Record<string, unknown>[]) {
    const id = String(row.workspace_id);
    const at = out.get(id) ?? { paid: 0, free: 0 };
    /* A negative grant is management taking credits back. It comes off the
       side it was added to, which for an adjustment is the free side — so a
       clawback cannot make a workspace look better funded than it is. */
    if (isPaidKind(String(row.kind))) at.paid += Number(row.n ?? 0);
    else at.free += Number(row.n ?? 0);
    out.set(id, at);
  }
  return out;
}

export async function creditsGranted(workspaceId: string): Promise<number> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT COALESCE(SUM(credits),0) AS n FROM credit_grants WHERE workspace_id = ?`, args: [workspaceId] });
  return Number((rs.rows[0] as any)?.n ?? 0);
}

export async function addMember(ws: TenantWorkspace, account: { id: string; email: string; name: string }, role: WorkspaceRole): Promise<void> {
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO memberships (workspace_id, account_id, role, disabled, created_at) VALUES (?,?,?,0,?)
          ON CONFLICT(workspace_id, account_id) DO UPDATE SET role = excluded.role, disabled = 0`,
    args: [ws.id, account.id, role, now()],
  });
  await mirrorUser(ws, account, role, false);
}

/**
 * The workspace's database keeps a `users` table of its members — names
 * for the ledger, ids for filing — and never a password. Auth is the
 * platform's; this row only says who someone is inside this workspace.
 */
export async function mirrorUser(ws: TenantWorkspace, account: { id: string; email: string; name: string }, role: WorkspaceRole, disabled: boolean): Promise<void> {
  const { db, ready } = await import("./db");
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: `INSERT INTO users (id, email, name, password_hash, role, disabled, created_at)
            VALUES (?,?,?,'!',?,?,?)
            ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, role = excluded.role, disabled = excluded.disabled, deleted_at = NULL`,
      args: [account.id, account.email, account.name, role === "member" ? "member" : "admin", disabled ? 1 : 0, now()],
    });
  });
}

/* ── the workspace's keys ─────────────────────────────────────────────── */

export async function setWorkspaceKeys(id: string, keys: Record<string, string>): Promise<void> {
  await platformReady();
  const clean = Object.fromEntries(Object.entries(keys).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, v.trim()]));
  await platformDb().execute({
    sql: `UPDATE workspaces SET keys_enc = ?, updated_at = ? WHERE id = ?`,
    args: [Object.keys(clean).length ? seal(JSON.stringify(clean)) : null, now(), id],
  });
}

/** Read the current sealed set inside the transaction so two vendor edits cannot lose each other. */
export async function updateWorkspaceVendorKey(id: string, name: string, value: string | null, actorId: string): Promise<void> {
  const { accountTransaction, AccountError } = await import("./accountDb");
  await accountTransaction(async (tx) => {
    const row = (await tx.execute({sql:"SELECT keys_enc FROM workspaces WHERE id=? AND legacy=0 AND deleted_at IS NULL",args:[id]})).rows[0];
    if (!row) throw new AccountError("Workspace keys are unavailable.", 404);
    const keys: Record<string,string> = row.keys_enc ? JSON.parse(open(String(row.keys_enc))) : {};
    if (value === null) delete keys[name]; else keys[name] = value;
    await tx.execute({sql:"UPDATE workspaces SET keys_enc=?,updated_at=? WHERE id=?",args:[Object.keys(keys).length ? seal(JSON.stringify(keys)) : null, now(), id]});
    await tx.execute(securityAuditStatement({workspaceId:id,actorId,action:value===null?"vendor_key.removed":"vendor_key.updated",targetType:"vendor",targetId:name}));
  });
}

/* ── sessions ─────────────────────────────────────────────────────────── */

export async function createPlatformSession(accountId: string, workspaceId: string | null): Promise<string> {
  const { accountTransaction } = await import("./accountDb");
  const { insertAccountSession } = await import("./accountSecurity");
  return accountTransaction(tx => insertAccountSession(tx, { accountId, workspaceId }));
}
export async function destroyPlatformSession(token: string): Promise<void> {
  const { accountTransaction } = await import("./accountDb");
  await accountTransaction(async (tx) => {
    const row=(await tx.execute({sql:"SELECT account_id,workspace_id FROM p_sessions WHERE token_hash=?",args:[hashToken(token)]})).rows[0];
    if (!row) return;
    await tx.execute({sql:"DELETE FROM p_sessions WHERE token_hash=?",args:[hashToken(token)]});
    await tx.execute(securityAuditStatement({workspaceId:row.workspace_id==null?null:String(row.workspace_id),actorId:String(row.account_id),action:"session.revoked",targetType:"account",targetId:String(row.account_id)},true));
  });
}
export async function destroyAccountSessions(accountId: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `DELETE FROM p_sessions WHERE account_id = ?`, args: [accountId] });
}
export async function switchSessionWorkspace(token: string, workspaceId: string): Promise<void> {
  await platformReady();
  const row=(await platformDb().execute({sql:"SELECT account_id FROM p_sessions WHERE token_hash=?",args:[hashToken(token)]})).rows[0];
  if(!row) return;
  await platformDb().batch([
    {sql:"UPDATE p_sessions SET workspace_id=? WHERE token_hash=?",args:[workspaceId,hashToken(token)]},
    securityAuditStatement({workspaceId,actorId:String(row.account_id),action:"session.workspace_changed",targetType:"workspace",targetId:workspaceId},true),
  ], "write");
}
/** The account behind a session token and the workspace it is in, or null. */
export async function sessionLookup(token: string): Promise<{ account: any; workspaceId: string | null } | null> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT a.*, s.workspace_id AS s_ws, (asec.enabled_at IS NOT NULL) AS mfa_enabled FROM p_sessions s JOIN accounts a ON a.id = s.account_id
          LEFT JOIN account_security asec ON asec.account_id=a.id
          LEFT JOIN session_security ss ON ss.token_hash=s.token_hash
          WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0 AND a.deleted_at IS NULL
          AND (asec.enabled_at IS NULL OR (ss.factor_at IS NOT NULL AND ss.epoch=asec.epoch)) LIMIT 1`,
    args: [hashToken(token), now()],
  });
  const r = rs.rows[0] as any;
  if (!r) return null;
  if (!r.last_seen || now() - Number(r.last_seen) > 300_000) {
    await platformDb().execute({ sql: `UPDATE accounts SET last_seen = ? WHERE id = ?`, args: [now(), r.id] });
  }
  return { account: r, workspaceId: r.s_ws ?? null };
}

/** The owner and admins of a workspace: who hears when its renders are held. */
export async function workspaceAdmins(workspaceId: string): Promise<{ id: string; email: string; name: string }[]> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT a.id, a.email, a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.disabled = 0 AND m.role IN ('owner','admin')`,
    args: [workspaceId],
  });
  return rs.rows.map((r) => {
    const row = r as unknown as { id: string; email: string; name: string };
    return { id: String(row.id), email: String(row.email ?? ""), name: String(row.name ?? "") };
  });
}

/** What has been added to a workspace, latest first: the top-up screen's history. */
export async function listGrants(workspaceId: string, limit = 20): Promise<{ id: string; credits: number; note: string; createdAt: number }[]> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT id, credits, note, created_at FROM credit_grants WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [workspaceId, limit],
  });
  return rs.rows.map((r) => {
    const row = r as unknown as { id: string; credits: number; note: string | null; created_at: number };
    return { id: String(row.id), credits: Number(row.credits), note: String(row.note ?? ""), createdAt: Number(row.created_at) };
  });
}

/* ── the platform layer ───────────────────────────────────────────────── */

let _layer: { at: number; value: PlatformLayer; stored: LayerKey[] } | null = null;

/** The layer as it stands: the defaults with whatever the desk has overridden. Cached briefly. */
export async function getPlatformLayer(): Promise<PlatformLayer> {
  return (await platformLayerState()).value;
}

export async function platformLayerState(): Promise<{ value: PlatformLayer; stored: LayerKey[] }> {
  if (_layer && Date.now() - _layer.at < 10_000) return _layer;
  await platformReady();
  const rs = await platformDb().execute(`SELECT key, value FROM platform_layer`);
  const stored: Partial<Record<LayerKey, unknown>> = {};
  for (const r of rs.rows as unknown as { key: string; value: string }[]) {
    if (!(LAYER_KEYS as string[]).includes(r.key)) continue;
    try { stored[r.key as LayerKey] = JSON.parse(r.value); } catch { /* an unreadable row loses to the default */ }
  }
  _layer = { at: Date.now(), value: mergeLayer(stored), stored: Object.keys(stored) as LayerKey[] };
  return _layer;
}

/** Override one part of the layer; what is stored is the cleaned value, so the record can never hold junk. */
export async function setPlatformLayer(key: LayerKey, value: unknown, by: string | null): Promise<PlatformLayer> {
  await platformReady();
  const cleaned = mergeLayer({ [key]: value })[key];
  await platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [key, JSON.stringify(cleaned), now(), by],
  });
  _layer = null;
  return getPlatformLayer();
}

export async function resetPlatformLayer(key: LayerKey): Promise<PlatformLayer> {
  await platformReady();
  await platformDb().execute({ sql: `DELETE FROM platform_layer WHERE key = ?`, args: [key] });
  _layer = null;
  return getPlatformLayer();
}

/** Mark a workspace as the platform's own internal test workspace — the one place a real engine call may be made for the platform's sake (brief 1.4). */
/**
 * Put a workspace on a plan, or take it off one.
 *
 * Nothing about credits moves here. A plan's included credits are granted per
 * cycle, and that grant does not exist yet — it waits on the draw order,
 * which is still undecided. Recording WHICH plan is the part that can be
 * true today, and it is what the console has had no way to say.
 */
/**
 * The plan a workspace is on, resolved against the platform layer.
 *
 * Null for a workspace on none — which is every workspace until somebody is
 * put on one — and null rather than a default, because "no plan" and "the
 * cheapest plan" are different states and only one of them carries ceilings.
 */
export async function planOf(ws: { id?: string; planId?: PlanId | null } | null | undefined): Promise<PlanDef | null> {
  if (!ws) return null;
  const { paidPlanEntitlement, effectivePlanId } = await import("./billingLedger");
  const paid = ws.id ? await paidPlanEntitlement(ws.id) : null;
  // Billing never writes plan_id: pre-existing paid labels remain explicit admin entitlements.
  // A lapsed subscriber without that override returns to Invite; existing work is never removed.
  const id = effectivePlanId(paid, ws.planId);
  if (!id) return null;
  const layer = await getPlatformLayer().catch(() => null);
  return planById(layer?.plans ?? DEFAULT_PLANS, id);
}

/** How many people can still open this workspace. Disabled seats do not count. */
export async function memberCount(workspaceId: string): Promise<number> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND disabled = 0`,
    args: [workspaceId],
  });
  return Number((rs.rows[0] as { n?: number })?.n ?? 0);
}

export async function setWorkspacePlan(id: string, plan: PlanId | null): Promise<void> {
  await platformReady();
  await platformDb().execute({
    sql: `UPDATE workspaces SET plan_id = ?, updated_at = ? WHERE id = ?`,
    args: [plan, now(), id],
  });
}

export async function setWorkspaceInternalTest(id: string, on: boolean): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `UPDATE workspaces SET internal_test = ?, updated_at = ? WHERE id = ?`, args: [on ? 1 : 0, now(), id] });
}

export type PlatformAsset = { key: string; path: string; bytes: number; mime: string; sourceWorkspaceId: string | null; sourceGenId: string | null; model: string | null; costUsd: number | null; createdAt: number };

export async function listPlatformAssets(prefix: string): Promise<PlatformAsset[]> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM platform_assets WHERE key LIKE ? ORDER BY key`, args: [`${prefix}%`] });
  return (rs.rows as unknown as Record<string, unknown>[]).map((r) => ({
    key: String(r.key), path: String(r.path), bytes: Number(r.bytes ?? 0), mime: String(r.mime ?? "video/mp4"),
    sourceWorkspaceId: r.source_workspace_id == null ? null : String(r.source_workspace_id), sourceGenId: r.source_gen_id == null ? null : String(r.source_gen_id),
    model: r.model == null ? null : String(r.model), costUsd: r.cost_usd == null ? null : Number(r.cost_usd), createdAt: Number(r.created_at),
  }));
}

export async function putPlatformAsset(a: { key: string; path: string; bytes: number; mime: string; sourceWorkspaceId: string; sourceGenId: string; model: string; costUsd: number | null; by: string }): Promise<void> {
  await platformReady();
  const ts = now();
  await platformDb().execute({
    sql: `INSERT INTO platform_assets (key, path, bytes, mime, source_workspace_id, source_gen_id, model, cost_usd, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, mime = excluded.mime, source_workspace_id = excluded.source_workspace_id,
            source_gen_id = excluded.source_gen_id, model = excluded.model, cost_usd = excluded.cost_usd, created_by = excluded.created_by, updated_at = excluded.updated_at`,
    args: [a.key, a.path, a.bytes, a.mime, a.sourceWorkspaceId, a.sourceGenId, a.model, a.costUsd, a.by, ts, ts],
  });
}
