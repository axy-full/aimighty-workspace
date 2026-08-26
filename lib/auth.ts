import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { cookies } from "next/headers";
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
export async function requireUser(): Promise<
  { user: User; response?: never } | { user?: never; response: Response }
> {
  const user = await currentUser();
  if (!user) {
    return { response: Response.json({ error: "Not signed in" }, { status: 401 }) };
  }
  return { user };
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

/** Locks an account briefly after repeated failures. */
export async function noteFailure(userId: string, failed: number): Promise<void> {
  const next = failed + 1;
  await db().execute({
    sql: `UPDATE users SET failed_count=?, locked_until=? WHERE id=?`,
    args: [next, next >= MAX_FAILED ? now() + LOCK_MINUTES * 60_000 : null, userId],
  });
}

export async function clearFailures(userId: string): Promise<void> {
  await db().execute({
    sql: `UPDATE users SET failed_count=0, locked_until=NULL WHERE id=?`,
    args: [userId],
  });
}

export const LOCK_MESSAGE = `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`;
