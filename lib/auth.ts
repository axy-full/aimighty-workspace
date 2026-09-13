import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { db, ready, now } from "./db";
import {
  platformDb, platformReady, sessionLookup, createPlatformSession, destroyPlatformSession,
  findAccountByEmail, accountCount, createAccount, getWorkspace, legacyWorkspace,
  workspacesFor, mirrorUser, newId,
  isSuperAdmin as platformIsSuperAdmin, SUPER_ADMIN_EMAIL as PLATFORM_SUPER_ADMIN_EMAIL,
} from "./platform";
import {
  currentTenant, runWithStore, runInTenant, NoTenantError,
  type TenantStore, type TenantUser, type TenantToken, type TenantWorkspace, type WorkspaceRole,
} from "./tenant";

/**
 * Who is asking, and for which workspace.
 *
 * Accounts and sessions are the platform's; what an account may do is a
 * membership in a workspace — owner, admin or member. A request is
 * answered inside exactly one workspace: the one its session is in, or the
 * one its API token was minted for. withTenant() resolves that once per
 * request and runs the handler inside it; db() refuses to run outside.
 *
 * Passwords are scrypt from node's stdlib. Sessions and tokens are stored
 * as SHA-256 hashes, so a database copy hands over neither.
 */

export const SESSION_COOKIE = "aw_session";
export const SUPER_ADMIN_EMAIL = PLATFORM_SUPER_ADMIN_EMAIL;
export const isSuperAdmin = platformIsSuperAdmin;

export type Role = "admin" | "member";
export type User = TenantUser;

/* ── passwords ─────────────────────────────────────────────────────────── */

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [algo, n, r, p, saltHex, keyHex] = String(stored).split("$");
    if (algo !== "scrypt" || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, "hex");
    const key = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch { return false; }
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That's too long.";
  if (/^\d+$/.test(pw)) return "Don't use only digits.";
  return null;
}

/* ── sessions ──────────────────────────────────────────────────────────── */

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** A session for an account, opened in a workspace (its first, when none is given). */
export async function createSession(accountId: string, workspaceId?: string | null): Promise<string> {
  let ws = workspaceId ?? null;
  if (!ws) {
    const mine = await workspacesFor(accountId);
    ws = mine[0]?.workspace.id ?? null;
  }
  await import("./teamInvitations").then(m=>m.repairPendingMemberships(accountId)).catch(()=>{});
  return createPlatformSession(accountId, ws);
}

export async function destroySession(token: string): Promise<void> {
  await destroyPlatformSession(token);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const roleOf = (r: WorkspaceRole): Role => (r === "member" ? "member" : "admin");

function userFrom(account: any, role: WorkspaceRole): TenantUser {
  return {
    id: String(account.id), email: String(account.email), name: String(account.name),
    role: roleOf(role), owner: role === "owner",
    disabled: Boolean(Number(account.disabled ?? 0)),
    lastSeen: account.last_seen == null ? null : Number(account.last_seen),
    createdAt: Number(account.created_at ?? 0),
  };
}

export type Context = {
  user: TenantUser;
  workspace: TenantWorkspace | null;
  role: WorkspaceRole | null;
  workspaces: { id: string; slug: string; name: string; role: WorkspaceRole }[];
};

/**
 * The signed-in account and the workspace its session is in. Used by the
 * layout (which renders outside any route) and by the route wrapper.
 */
export async function currentContext(): Promise<Context | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const found = await sessionLookup(token);
  if (!found) return null;
  const mine = await workspacesFor(String(found.account.id));
  const workspaces = mine.map((m) => ({ id: m.workspace.id, slug: m.workspace.slug, name: m.workspace.name, role: m.role }));
  let pick = mine.find((m) => m.workspace.id === found.workspaceId) ?? mine[0] ?? null;
  if (!pick) return { user: userFrom(found.account, "member"), workspace: null, role: null, workspaces };
  // A session pointing at a workspace the account has since left falls back to its first.
  if (found.workspaceId !== pick.workspace.id) pick = mine[0];
  return { user: userFrom(found.account, pick.role), workspace: pick.workspace, role: pick.role, workspaces };
}

/** The signed-in user for this request, or null. */
export async function currentUser(): Promise<User | null> {
  const store = currentTenant();
  if (store?.user) return store.user;
  const ctx = await currentContext();
  return ctx?.user ?? null;
}

/* ── API tokens ────────────────────────────────────────────────────────── */

export type TokenScope = "read" | "render";
export type Caller = { user: User; token?: TenantToken };

/**
 * A token names its workspace: `pk_<workspace>_<secret>`. The studio's
 * original tokens (`aw_…`) belong to its original workspace. Either way a
 * token can only ever open the workspace it was minted in.
 */
export function mintTokenSecret(): string {
  const ws = currentTenant()?.workspace;
  const prefix = ws && !ws.legacy ? `pk_${ws.id.replace(/^ws_/, "")}_` : "aw_";
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

export const tokenHash = (t: string) => hashToken(t);

async function workspaceForToken(raw: string): Promise<TenantWorkspace | null> {
  const m = raw.match(/^pk_([a-z0-9]+)_/);
  if (m) return getWorkspace(`ws_${m[1]}`);
  if (raw.startsWith("aw_")) return legacyWorkspace();
  return null;
}

async function callerFromBearer(): Promise<TenantStore | null> {
  const header = (await headers()).get("authorization");
  const raw = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return raw ? callerFromToken(raw) : null;
}

/** Authoritative account membership is checked even when a tenant mirror is stale. */
export async function callerFromToken(raw: string): Promise<TenantStore | null> {
  const ws = await workspaceForToken(raw);
  if (!ws || ws.deletedAt) return null;
  return runInTenant(ws, async () => {
    await ready();
    const rs = await db().execute({
      sql: `SELECT t.id AS tid, t.name AS tname, t.scope, t.cap_usd, t.last_used, u.*
            FROM api_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.disabled = 0 AND u.deleted_at IS NULL
            LIMIT 1`,
      args: [hashToken(raw)],
    });
    const row = rs.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const membership = (await platformDb().execute({
      sql: `SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.workspace_id=? AND m.account_id=? AND m.disabled=0 AND a.disabled=0 AND a.deleted_at IS NULL AND w.deleted_at IS NULL`,
      args:[ws.id,String(row.id)],
    })).rows[0];
    if(!membership)return null;
    const role = String(membership.role) as WorkspaceRole;
    const last = Number(row.last_used ?? 0);
    if (now() - last > 300_000) {
      await db().execute({ sql: `UPDATE api_tokens SET last_used=? WHERE id=?`, args: [now(), String(row.tid)] });
    }
    // The membership decides standing; the mirror row is only a name.
    const user: TenantUser = {
      id: String(row.id), email: String(row.email), name: String(row.name),
      role: roleOf(role), owner: role === "owner", disabled: false,
      lastSeen: null, createdAt: Number(row.created_at ?? 0),
    };
    return {
      workspace: ws, user,
      token: {
        id: String(row.tid), name: String(row.tname),
        scope: row.scope === "read" ? "read" : "render",
        capUsd: row.cap_usd == null ? null : Number(row.cap_usd),
      },
    };
  });
}

/** Resolve the request's store: session first, then token, else nobody. */
async function resolveStore(): Promise<TenantStore> {
  const ctx = await currentContext();
  if (ctx?.workspace) return { workspace: ctx.workspace, user: ctx.user, workspaces: ctx.workspaces };
  if (ctx) return { workspace: null, user: ctx.user, workspaces: ctx.workspaces };
  const bearer = await callerFromBearer();
  return bearer ?? { workspace: null, user: null };
}

/**
 * Every data route runs inside this. It decides the workspace once, runs
 * the handler with it in scope, and turns "no workspace" into a 401 — so a
 * handler that reaches for data before checking who is asking still
 * cannot get any.
 */
export function withTenant<Req extends Request = Request, Ctx = unknown>(handler: (req: Req, ctx: Ctx) => Promise<Response>, options: { readOnlyPostTransport?: boolean } = {}) {
  return async (req: Req, ctx: Ctx): Promise<Response> => {
    let store: TenantStore;
    try { store = await resolveStore(); }
    catch (e) {
      console.error("session resolution failed:", (e as Error).message);
      return Response.json({ error: "Sign-in isn't available right now." }, { status: 503 });
    }
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      if(store.token?.scope==='read'&&!(req.method==='POST'&&options.readOnlyPostTransport))return Response.json({error:'This token is read-only.'},{status:403});
      const origin=req.headers.get('origin');
      if(!store.token&&origin&&origin!==new URL(req.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});
    }
    try {
      return await runWithStore(store, () => handler(req, ctx));
    } catch (e) {
      if (e instanceof NoTenantError) {
        return Response.json({ error: store.user ? "Pick a workspace first." : "Not signed in" }, { status: 401 });
      }
      throw e;
    }
  };
}

/** Who is asking — a signed-in browser, or a token. */
export async function currentCaller(): Promise<Caller | null> {
  const store = currentTenant();
  if (store?.user) return { user: store.user, token: store.token };
  const ctx = await currentContext();
  return ctx ? { user: ctx.user } : null;
}

export async function requireUser(): Promise<
  { user: User; token?: TenantToken; response?: never } | { user?: never; token?: never; response: Response }
> {
  const store = currentTenant();
  if (store?.user && store.workspace && !store.workspace.deletedAt) return { user: store.user, token: store.token };
  if (store?.user && !store.workspace) {
    return { response: Response.json({ error: "Pick a workspace first." }, { status: 401 }) };
  }
  return { response: Response.json({ error: "Not signed in" }, { status: 401 }) };
}

/**
 * For anything only a signed-in person may do: a token caller is refused.
 *
 * `currentUser()` answers for a BEARER caller too — `callerFromBearer` puts a
 * user in the store — so "is there a user?" is not the same question as "is
 * this a session?", and the token routes were asking the first while meaning
 * the second. A read-only token could therefore mint a render-scoped one,
 * which is the whole read-only guarantee undone: /connect hands that
 * credential to third parties precisely because it "cannot bill".
 */
export async function requireSession(): Promise<
  { user: User; response?: never } | { user?: never; response: Response }
> {
  const got = await requireUser();
  if (got.response) return { response: got.response };
  if (got.token) {
    return {
      response: Response.json(
        { error: "This action requires a signed-in browser session. API tokens cannot manage accounts or workspace access." },
        { status: 403 },
      ),
    };
  }
  return { user: got.user };
}

/** For anything that spends money: a read-only token is refused here. */
export async function requireRender(): Promise<
  { user: User; token?: TenantToken; response?: never } | { user?: never; token?: never; response: Response }
> {
  const got = await requireUser();
  if (got.response) return got;
  const ws = currentTenant()?.workspace;
  if (ws?.suspendedAt) {
    return {
      response: Response.json(
        { error: `This workspace is suspended${ws.suspendedReason ? ` — ${ws.suspendedReason}` : ""}. Rendering is paused; contact the platform.` },
        { status: 423 }
      ),
    };
  }
  if (got.token && got.token.scope !== "render") {
    return {
      response: Response.json(
        { error: `The token "${got.token.name}" is read-only — it can list and fetch renders, but not start one.` },
        { status: 403 }
      ),
    };
  }
  return got;
}

/** Month-to-date spend charged to one token, for its optional ceiling. */
export async function tokenSpendThisMonth(tokenId: string): Promise<number> {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  const rs = await db().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend
          FROM generations WHERE token_id = ? AND created_at >= ?`,
    args: [tokenId, start.getTime()],
  });
  return Number((rs.rows[0] as Record<string, unknown>)?.spend ?? 0);
}

export async function requireAdmin(): Promise<
  { user: User; response?: never } | { user?: never; response: Response }
> {
  const got = await requireSession();
  if (got.response) return got;
  if (got.user.role !== "admin") {
    return { response: Response.json({ error: "Admins only" }, { status: 403 }) };
  }
  return { user: got.user };
}

/** The workspace's owner alone: keys, the export, standing. */
export async function requireOwner(): Promise<
  { user: User; response?: never } | { user?: never; response: Response }
> {
  const got = await requireSession();
  if (got.response) return got;
  if (!got.user.owner) {
    return { response: Response.json({ error: "The workspace owner only." }, { status: 403 }) };
  }
  return { user: got.user };
}

/**
 * The platform's owner: the configured super-admin address, or whoever
 * owns the studio's original workspace — the deployment is theirs.
 */
export async function isPlatformOwner(user: { id: string; email: string } | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (isSuperAdmin(user.email)) return true;
  const legacy = await legacyWorkspace();
  return Boolean(legacy && legacy.ownerId === user.id);
}

/** The platform's owner — the one account that administers sign-ups. */
export async function requireSuperAdmin(): Promise<
  { user: User; response?: never } | { user?: never; response: Response }
> {
  const store = currentTenant();
  if(store?.token)return {response:Response.json({error:"Platform administration requires a signed-in browser session."},{status:403})};
  const user = store?.user ?? (await currentContext())?.user ?? null;
  if (!user) return { response: Response.json({ error: "Not signed in" }, { status: 401 }) };
  if (!(await isPlatformOwner(user))) return { response: Response.json({ error: "The platform owner only." }, { status: 403 }) };
  return { user };
}

/* ── accounts ──────────────────────────────────────────────────────────── */

export async function userCount(): Promise<number> {
  return accountCount();
}

/** The account behind an email, as a row (id, email, name, password_hash, disabled …). */
export async function findByEmail(email: string) {
  return findAccountByEmail(email);
}

export async function createUser(email: string, name: string, password: string): Promise<{ id: string; email: string; name: string }> {
  return createAccount(email, name, hashPassword(password));
}

/**
 * First run: the first account becomes the platform owner and gets the
 * studio's original workspace — the primary database — as its own.
 * Atomic on the account count, so two racing setups make one owner.
 */
export async function createFirstAdmin(email: string, name: string, password: string): Promise<User | null> {
  await platformReady();
  if ((await accountCount()) > 0) return null;
  const account = await createAccount(email, name, hashPassword(password));
  let ws = await legacyWorkspace();
  if (!ws) {
    const ts = now();
    await platformDb().execute({
      sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at)
            VALUES ('ws_legacy', 'aimighty', ?, '(primary)', NULL, 1, 1, ?, ?, ?)`,
      args: [process.env.LEGACY_WORKSPACE_NAME ?? "Aimighty", account.id, ts, ts],
    });
    ws = (await legacyWorkspace())!;
  }
  await platformDb().execute({
    sql: `INSERT OR REPLACE INTO memberships (workspace_id, account_id, role, disabled, created_at) VALUES (?,?,'owner',0,?)`,
    args: [ws.id, account.id, now()],
  });
  await mirrorUser(ws, account, "owner", false);
  return { id: account.id, email: account.email, name: account.name, role: "admin", owner: true, disabled: false, lastSeen: null, createdAt: now() };
}

/* ── login throttling (platform-wide) ──────────────────────────────────── */

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export async function noteFailure(accountId: string, source: string, email: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `UPDATE accounts SET failed_count = failed_count + 1 WHERE id=?`, args: [accountId] });
  await noteSourceFailure(source, email);
}

/**
 * Count a wrong guess against where it came from — also when the address
 * does not exist, so probing for valid emails is throttled exactly as hard
 * as guessing passwords for a real one.
 */
export async function noteSourceFailure(source: string, email: string): Promise<void> {
  await platformReady();
  const ts = now();
  const key = email.trim().toLowerCase();
  await platformDb().execute({
    sql: `INSERT INTO login_attempts (ip_hash, email, count, locked_until, updated_at)
          VALUES (?,?,1,NULL,?)
          ON CONFLICT(ip_hash, email) DO UPDATE SET
            count = CASE WHEN login_attempts.locked_until IS NOT NULL
                          AND login_attempts.locked_until <= excluded.updated_at
                         THEN 1 ELSE login_attempts.count + 1 END,
            locked_until = CASE WHEN login_attempts.locked_until IS NOT NULL
                                 AND login_attempts.locked_until <= excluded.updated_at
                                THEN NULL ELSE login_attempts.locked_until END,
            updated_at = excluded.updated_at`,
    args: [source, key, ts],
  });
  await platformDb().execute({
    sql: `UPDATE login_attempts SET locked_until=? WHERE ip_hash=? AND email=? AND count >= ? AND locked_until IS NULL`,
    args: [ts + LOCK_MINUTES * 60_000, source, key, MAX_FAILED],
  });
}

export async function sourceLocked(source: string, email: string): Promise<boolean> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT locked_until FROM login_attempts WHERE ip_hash=? AND email=?`,
    args: [source, email.trim().toLowerCase()],
  });
  const until = (rs.rows[0] as Record<string, unknown> | undefined)?.locked_until;
  return until != null && Number(until) > now();
}

/** A hash to verify against when the account doesn't exist — same scrypt cost either way. */
export const DUMMY_HASH = hashPassword("dummy-timing-equalizer");

export async function clearFailures(accountId: string, source?: string, email?: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: `UPDATE accounts SET failed_count=0, locked_until=NULL WHERE id=?`, args: [accountId] });
  if (source && email) {
    await platformDb().execute({ sql: `DELETE FROM login_attempts WHERE ip_hash=? AND email=?`, args: [source, email.trim().toLowerCase()] });
  }
}

/** A one-way, salted label for where a request came from. */
export function sourceKey(req: { headers: Headers }): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? req.headers.get("x-real-ip") ?? "";
  const salt = process.env.SESSION_SECRET ?? process.env.TURSO_AUTH_TOKEN ?? "particl";
  return createHash("sha256").update(`${salt}:login:${ip}`).digest("hex").slice(0, 32);
}

export const LOCK_MESSAGE = `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`;
export { newId as platformId };
