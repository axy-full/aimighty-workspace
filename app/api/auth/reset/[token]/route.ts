import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db, ready, now } from "@/lib/db";
import { SESSION_COOKIE, createSession, hashPassword, passwordProblem, tokenHash, clearFailures } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/* eslint-disable @typescript-eslint/no-explicit-any */
async function lookup(token: string): Promise<{ row: any; user: any; problem: string | null }> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM password_resets WHERE token_hash = ? LIMIT 1`, args: [tokenHash(token)] });
  const row = rs.rows[0] as any;
  if (!row) return { row: null, user: null, problem: "That link isn't valid." };
  if (row.used_at) return { row, user: null, problem: "That link has already been used. Ask for a new one." };
  if (Number(row.expires_at) < now()) return { row, user: null, problem: "That link has expired. Ask for a new one." };
  const us = await db().execute({ sql: `SELECT id, email, name, disabled FROM users WHERE id = ? LIMIT 1`, args: [row.user_id] });
  const user = us.rows[0] as any;
  if (!user || Number(user.disabled)) return { row, user: null, problem: "That account can't be reset. Contact management." };
  return { row, user, problem: null };
}

const mask = (email: string) => {
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 1)}•••@${domain ?? ""}`;
};

/** Is this link still good? The page asks before showing the form. */
export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const { user, problem } = await lookup(token);
  if (problem) return NextResponse.json({ error: problem }, { status: 410 });
  return NextResponse.json({ ok: true, email: mask(String(user.email)) });
}

/**
 * Set the new password. The link is spent, every other session on the
 * account is ended (whoever asked for the reset is now the only one
 * signed in), the lockout is cleared, and this browser is signed in.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

  const { user, problem } = await lookup(token);
  if (problem) return NextResponse.json({ error: problem }, { status: 410 });

  const ts = now();
  // Spend the link first; a race between two submits can only succeed once.
  const spent = await db().execute({
    sql: `UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
    args: [ts, tokenHash(token)],
  });
  if (Number(spent.rowsAffected ?? 0) !== 1) return NextResponse.json({ error: "That link has already been used." }, { status: 410 });

  await db().execute({ sql: `UPDATE users SET password_hash = ?, locked_until = NULL, failed_count = 0 WHERE id = ?`, args: [hashPassword(password), user.id] });
  await db().execute({ sql: `DELETE FROM sessions WHERE user_id = ?`, args: [user.id] });
  await clearFailures(String(user.id));

  const session = await createSession(String(user.id));
  (await cookies()).set(SESSION_COOKIE, session, {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 30 * 86400,
  });
  return NextResponse.json({ ok: true, name: user.name });
}
