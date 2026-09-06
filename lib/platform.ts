import { createClient, type Client } from "@libsql/client";
import { signupCredits } from "./creditTerms";
import { gatewayMintConfigured, mintGatewayKey } from "./vercelKeys";
import { randomBytes, createHash } from "node:crypto";
import { seal, open } from "./keyring";
import { provisionTenantDatabase } from "./provision";
import { runInTenant, type TenantWorkspace, type WorkspaceRole } from "./tenant";

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
    _client = createClient({
      url: process.env.PLATFORM_DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? "file:.data/ark.db",
      authToken: process.env.PLATFORM_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

export const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL ?? "axy@akshaypanchal.com").trim().toLowerCase();
export const isSuperAdmin = (email: string | null | undefined) =>
  Boolean(email) && String(email).trim().toLowerCase() === SUPER_ADMIN_EMAIL;

const SCHEMA = [
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
     created_by    TEXT,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS credit_grants_ws ON credit_grants(workspace_id)`,
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
  };
}

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
      for (const stmt of SCHEMA) await p.execute(stmt);
      /* Columns added after the table first shipped reach an existing
         database only by ALTER; a duplicate is the one error to ignore. */
      for (const col of [`allowance_usd REAL`, `gateway_key_id TEXT`]) {
        try { await p.execute(`ALTER TABLE workspaces ADD COLUMN ${col}`); }
        catch (e) { if (!/duplicate column/i.test(String((e as Error).message))) throw e; }
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
  const legacyDb = createClient({
    url: process.env.TURSO_DATABASE_URL ?? "file:.data/ark.db",
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
  const rs = await platformDb().execute(`SELECT * FROM workspaces ORDER BY created_at`);
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
          WHERE m.account_id = ? AND m.disabled = 0 ORDER BY w.created_at`,
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

/**
 * A new workspace: its own database, provisioned and bootstrapped, with
 * the creator as owner and mirrored into it so their renders carry a name.
 *
 * Its engines come with it. On the platform's keys by default (with the
 * allowance), and — when the deployment can mint one — a Vercel AI Gateway
 * key of its own, so its text spend sits under its own name and budget in
 * Vercel's books. Minting is best effort: a workspace is never refused
 * because Vercel was slow.
 */
export async function createWorkspace(input: { name: string; owner: { id: string; email: string; name: string } }): Promise<TenantWorkspace> {
  await platformReady();
  const p = platformDb();
  const base = slugify(input.name);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const taken = await p.execute({ sql: `SELECT 1 FROM workspaces WHERE slug = ?`, args: [slug] });
    if (!taken.rows.length) break;
    slug = `${base}-${i}`;
  }
  const db = await provisionTenantDatabase(slug);
  const id = newId("ws");
  const ts = now();
  const platformKeys = platformKeysByDefault();
  await p.execute({
    sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, db_name, legacy, uses_platform_keys, owner_id, created_at, updated_at)
          VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
    args: [id, slug, input.name.trim().slice(0, 80), db.url, db.token ? seal(db.token) : null, db.name, platformKeys ? 1 : 0, input.owner.id, ts, ts],
  });
  await p.execute({
    sql: `INSERT INTO memberships (workspace_id, account_id, role, created_at) VALUES (?,?,'owner',?)`,
    args: [id, input.owner.id, ts],
  });
  /* Something to spend on day one. */
  if (platformKeys && signupCredits() > 0) {
    await p.execute({
      sql: `INSERT INTO credit_grants (id, workspace_id, credits, note, created_by, created_at) VALUES (?,?,?,?,?,?)`,
      args: [newId("cg"), id, signupCredits(), "Welcome credits", input.owner.id, ts],
    });
  }
  if (gatewayMintConfigured()) {
    try {
      const minted = await mintGatewayKey(`particl · ${slug}`);
      await p.execute({
        sql: `UPDATE workspaces SET keys_enc = ?, gateway_key_id = ?, updated_at = ? WHERE id = ?`,
        args: [seal(JSON.stringify({ gateway: minted.key })), minted.id, now(), id],
      });
    } catch (e) {
      console.warn(`[workspace ${slug}] no gateway key minted: ${(e as Error).message}`);
    }
  }
  const ws = (await getWorkspace(id))!;
  await mirrorUser(ws, { id: input.owner.id, email: input.owner.email, name: input.owner.name }, "owner", false);
  return ws;
}

/** Whose keys a workspace's engines run on. */
export async function setWorkspaceMode(id: string, usesPlatformKeys: boolean): Promise<void> {
  await platformDb().execute({
    sql: `UPDATE workspaces SET uses_platform_keys = ?, updated_at = ? WHERE id = ? AND legacy = 0`,
    args: [usesPlatformKeys ? 1 : 0, now(), id],
  });
}

/** Dollars a month on the platform's keys; null returns it to the deployment's default. */
export async function setWorkspaceAllowance(id: string, usd: number | null): Promise<void> {
  await platformDb().execute({
    sql: `UPDATE workspaces SET allowance_usd = ?, updated_at = ? WHERE id = ? AND legacy = 0`,
    args: [usd, now(), id],
  });
}

/** Credits added to a workspace, by management. Negative takes them away. */
export async function grantCredits(workspaceId: string, credits: number, note: string, by: string | null): Promise<void> {
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO credit_grants (id, workspace_id, credits, note, created_by, created_at) VALUES (?,?,?,?,?,?)`,
    args: [newId("cg"), workspaceId, credits, note.slice(0, 200), by, now()],
  });
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

/* ── sessions ─────────────────────────────────────────────────────────── */

const SESSION_DAYS = 30;
export async function createPlatformSession(accountId: string, workspaceId: string | null): Promise<string> {
  await platformReady();
  const token = randomBytes(32).toString("base64url");
  const ts = now();
  await platformDb().execute({
    sql: `INSERT INTO p_sessions (token_hash, account_id, workspace_id, created_at, expires_at) VALUES (?,?,?,?,?)`,
    args: [hashToken(token), accountId, workspaceId, ts, ts + SESSION_DAYS * 86400_000],
  });
  return token;
}
export async function destroyPlatformSession(token: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `DELETE FROM p_sessions WHERE token_hash = ?`, args: [hashToken(token)] });
}
export async function destroyAccountSessions(accountId: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `DELETE FROM p_sessions WHERE account_id = ?`, args: [accountId] });
}
export async function switchSessionWorkspace(token: string, workspaceId: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `UPDATE p_sessions SET workspace_id = ? WHERE token_hash = ?`, args: [workspaceId, hashToken(token)] });
}
/** The account behind a session token and the workspace it is in, or null. */
export async function sessionLookup(token: string): Promise<{ account: any; workspaceId: string | null } | null> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT a.*, s.workspace_id AS s_ws FROM p_sessions s JOIN accounts a ON a.id = s.account_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0 AND a.deleted_at IS NULL LIMIT 1`,
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
