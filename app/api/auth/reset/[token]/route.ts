import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, createSession, hashPassword, passwordProblem, tokenHash, clearFailures } from "@/lib/auth";
import { platformDb, platformReady, destroyAccountSessions, now } from "@/lib/platform";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/* eslint-disable @typescript-eslint/no-explicit-any */
async function lookup(token: string): Promise<{ row: any; user: any; problem: string | null }> {
  await platformReady();
  const p = platformDb();
  const rs = await p.execute({ sql: `SELECT * FROM password_resets WHERE token_hash = ? LIMIT 1`, args: [tokenHash(token)] });
  const row = rs.rows[0] as any;
  if (!row) return { row: null, user: null, problem: "That link isn't valid." };
  if (row.used_at) return { row, user: null, problem: "That link has already been used. Ask for a new one." };
  if (Number(row.expires_at) < now()) return { row, user: null, problem: "That link has expired. Ask for a new one." };
  const us = await p.execute({ sql: `SELECT id, email, name, disabled FROM accounts WHERE id = ? AND deleted_at IS NULL LIMIT 1`, args: [row.user_id] });
  const user = us.rows[0] as any;
  if (!user || Number(user.disabled)) return { row, user: null, problem: "That account can't be reset. Contact management." };
  return { row, user, problem: null };
}
const mask = (email: string) => { const [l, d] = email.split("@"); return `${(l ?? "").slice(0, 1)}•••@${d ?? ""}`; };

export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const { user, problem } = await lookup(token);
  if (problem) return NextResponse.json({ error: problem }, { status: 410 });
  return NextResponse.json({ ok: true, email: mask(String(user.email)) });
}

/** Set the new password: the link is spent, every session ends, this browser signs in. */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });
  const { user, problem } = await lookup(token);
  if (problem) return NextResponse.json({ error: problem }, { status: 410 });
  const p = platformDb();
  const spent = await p.execute({ sql: `UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`, args: [now(), tokenHash(token)] });
  if (Number(spent.rowsAffected ?? 0) !== 1) return NextResponse.json({ error: "That link has already been used." }, { status: 410 });
  await p.execute({ sql: `UPDATE accounts SET password_hash = ?, locked_until = NULL, failed_count = 0 WHERE id = ?`, args: [hashPassword(password), user.id] });
  await destroyAccountSessions(String(user.id));
  await clearFailures(String(user.id));
  const session = await createSession(String(user.id));
  (await cookies()).set(SESSION_COOKIE, session, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86400,
  });
  return NextResponse.json({ ok: true, name: user.name });
}
