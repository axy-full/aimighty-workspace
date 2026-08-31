import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { db, ready, now, id } from "./db";

/**
 * Small, self-contained auth for a handful of named teammates.
 *
 * No external identity provider: six people, invite-only, passwords hashed with
 * scrypt from node's stdlib. Sessions are server-side rows so they can be
 * revoked; only a SHA-256 of the token is stored, so a database copy does not
 * hand over live sessions.
 */

export const SESSION_COOKIE = "aw_session";
const SESSION_DAYS = 30;
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export type Role = "admin" | "member";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  lastSeen: number | null;
  createdAt: number;
};

/* ── passwords ─────────────────────────────────────────────────────────── */

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltHex, keyHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const key = scryptSync(password, Buffer.from(saltHex, "hex"), KEYLEN, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    const expected = Buffer.from(keyHex, "hex");
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Minimum bar — long enough to matter, not so fussy people write it on a monitor. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That's too long.";
  if (/^\d+$/.test(pw)) return "Don't use only digits.";
  return null;
}

/* ── sessions ──────────────────────────────────────────────────────────── */

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createSession(userId: string): Promise<string> {
  await ready();
  const token = randomBytes(32).toString("base64url");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    args: [hashToken(token), userId, ts, ts + SESSION_DAYS * 86400_000],
  });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await ready();
  await db().execute({ sql: `DELETE FROM sessions WHERE token_hash = ?`, args: [hashToken(token)] });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToUser(r: any): User {
  return {
    id: r.id, email: r.email, name: r.name,
    role: (r.role === "admin" ? "admin" : "member") as Role,
    disabled: Boolean(Number(r.disabled)),
    lastSeen: r.last_seen == null ? null : Number(r.last_seen),
    createdAt: Number(r.created_at),
  };
}

/** The signed-in user for this request, or null. */
export async function currentUser(): Promise<User | null> {
  await ready();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rs = await db().execute({
    sql: `SELECT u.* FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0
          LIMIT 1`,
    args: [hashToken(token), now()],
  });
  if (!rs.rows[0]) return null;

  const user = rowToUser(rs.rows[0]);
  // Cheap presence tracking; only write when it's meaningfully stale.
  if (!user.lastSeen || now() - user.lastSeen > 300_000) {
    await db().execute({ sql: `UPDATE users SET last_seen=? WHERE id=?`, args: [now(), user.id] });
  }
  return user;
}

/** For API routes: the user, or a 401 to return. */
/* ── API tokens ───────────────────────────────────────────────────────────
 * A second way in, for things that aren't a browser: the CLI, and the MCP
 * server that lets Claude drive the workspace. Same rules as sessions — only
 * a SHA-256 is stored, revocation is a row update, and a disabled account
 * takes its tokens with it.
 *
 * A token always acts AS the person who made it, so attribution, the ledger
 * and "spend by member" stay honest no matter what did the asking.
 * ---------------------------------------------------------------------- */

export type TokenScope = "read" | "render";

export type Caller = {
  user: User;
  /** Set when the caller authenticated with a token rather than a session. */
  token?: { id: string; name: string; scope: TokenScope; capUsd: number | null };
};

export function mintTokenSecret(): string {
  // Prefixed so a leaked string is recognisable in logs and greppable in a repo.
  return `aw_${randomBytes(24).toString("hex")}`;
}

export const tokenHash = (t: string) => hashToken(t);

async function callerFromBearer(): Promise<Caller | null> {
  const header = (await headers()).get("authorization");
  const raw = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!raw) return null;

  const rs = await db().execute({
    sql: `SELECT t.id AS tid, t.name AS tname, t.scope, t.cap_usd, t.last_used, u.*
          FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.disabled = 0
          LIMIT 1`,
    args: [hashToken(raw)],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  // Cheap "when was this last used", written only when meaningfully stale.
  const last = Number(row.last_used ?? 0);
  if (now() - last > 300_000) {
    await db().execute({ sql: `UPDATE api_tokens SET last_used=? WHERE id=?`, args: [now(), String(row.tid)] });
  }

  return {
    user: rowToUser(row),
    token: {
      id: String(row.tid),
      name: String(row.tname),
      scope: row.scope === "read" ? "read" : "render",
      capUsd: row.cap_usd == null ? null : Number(row.cap_usd),
    },
  };
}

/** Who is asking — a signed-in browser, or a token. */
export async function currentCaller(): Promise<Caller | null> {
  const user = await currentUser();
  if (user) return { user };
  return callerFromBearer();
}

export async function requireUser(): Promise<
  { user: User; token?: Caller["token"]; response?: never } | { user?: never; token?: never; response: Response }
> {
  const caller = await currentCaller();
  if (!caller) {
    return { response: Response.json({ error: "Not signed in" }, { status: 401 }) };
  }
  return { user: caller.user, token: caller.token };
}

/**
 * For anything that spends money. A read-only token is refused here rather
 * than at the model, so a leaked read token can never bill the account.
 */
export async function requireRender(): Promise<
  { user: User; token?: Caller["token"]; response?: never } | { user?: never; token?: never; response: Response }
> {
  const got = await requireUser();
  if (got.response) return got;
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
  const got = await requireUser();
  if (got.response) return got;
  if (got.user.role !== "admin") {
    return { response: Response.json({ error: "Admins only" }, { status: 403 }) };
  }
  return { user: got.user };
}

/* ── accounts ──────────────────────────────────────────────────────────── */

export async function userCount(): Promise<number> {
  await ready();
  const rs = await db().execute(`SELECT COUNT(*) AS n FROM users`);
  return Number((rs.rows[0] as any).n);
}

export async function findByEmail(email: string) {
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM users WHERE email = ? LIMIT 1`,
    args: [email.trim().toLowerCase()],
  });
  return rs.rows[0] as any ?? null;
}

export async function createUser(
  email: string, name: string, password: string, role: Role
): Promise<User> {
  await ready();
  const uid = id("usr");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)`,
    args: [uid, email.trim().toLowerCase(), name.trim().slice(0, 80), hashPassword(password), role, ts],
  });
  return {
    id: uid, email: email.trim().toLowerCase(), name: name.trim(),
    role, disabled: false, lastSeen: null, createdAt: ts,
  };
}

/**
 * Creates the very first admin, atomically. The INSERT itself carries the
 * "no users exist yet" condition, so two racing setup requests can't both
 * become admin — the loser's insert writes zero rows.
 */
export async function createFirstAdmin(
  email: string, name: string, password: string
): Promise<User | null> {
  await ready();
  const uid = id("usr");
  const ts = now();
  const rs = await db().execute({
    sql: `INSERT INTO users (id,email,name,password_hash,role,created_at)
          SELECT ?,?,?,?,'admin',?
          WHERE NOT EXISTS (SELECT 1 FROM users)`,
    args: [uid, email.trim().toLowerCase(), name.trim().slice(0, 80), hashPassword(password), ts],
  });
  if (Number(rs.rowsAffected) === 0) return null;
  return {
    id: uid, email: email.trim().toLowerCase(), name: name.trim(),
    role: "admin", disabled: false, lastSeen: null, createdAt: ts,
  };
}

/**
 * Locks an account briefly after repeated failures.
 *
 * The increment happens IN SQL — a read-then-write version let N parallel
 * wrong guesses advance the counter by one, quietly defeating the lockout.
 * An expired lock resets the count first, so one typo after a lockout
 * doesn't instantly re-lock.
 */
export async function noteFailure(userId: string): Promise<void> {
  const ts = now();
  await db().execute({
    sql: `UPDATE users SET failed_count=0, locked_until=NULL
          WHERE id=? AND locked_until IS NOT NULL AND locked_until <= ?`,
    args: [userId, ts],
  });
  await db().execute({
    sql: `UPDATE users SET failed_count = failed_count + 1 WHERE id=?`,
    args: [userId],
  });
  await db().execute({
    sql: `UPDATE users SET locked_until=? WHERE id=? AND failed_count >= ? AND locked_until IS NULL`,
    args: [ts + LOCK_MINUTES * 60_000, userId, MAX_FAILED],
  });
}

/**
 * A hash to verify against when the account doesn't exist, so the "wrong
 * email" and "wrong password" paths cost the same scrypt work — response
 * timing must not reveal which emails are real.
 */
export const DUMMY_HASH = hashPassword("dummy-timing-equalizer");

export async function clearFailures(userId: string): Promise<void> {
  await db().execute({
    sql: `UPDATE users SET failed_count=0, locked_until=NULL WHERE id=?`,
    args: [userId],
  });
}

export const LOCK_MESSAGE = `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`;
