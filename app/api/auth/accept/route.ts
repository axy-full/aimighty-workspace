import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db, ready, now } from "@/lib/db";
import {
  SESSION_COOKIE, createSession, createUser, findByEmail, passwordProblem, type Role,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Redeems an invite code and creates that person's account. */
export async function POST(req: Request) {
  await ready();
  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim();
  const password = String(body.password ?? "");

  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

  const rs = await db().execute({
    sql: `SELECT * FROM invites WHERE code = ? LIMIT 1`, args: [code],
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const invite = rs.rows[0] as any;

  if (!invite) return NextResponse.json({ error: "That invite link isn't valid." }, { status: 404 });
  if (invite.used_at) {
    return NextResponse.json({ error: "That invite has already been used." }, { status: 409 });
  }
  if (Number(invite.expires_at) < now()) {
    return NextResponse.json({ error: "That invite has expired. Ask for a new one." }, { status: 410 });
  }
  if (await findByEmail(invite.email)) {
    return NextResponse.json({ error: "An account already exists for that email." }, { status: 409 });
  }

  const user = await createUser(invite.email, invite.name, password, invite.role as Role);
  await db().execute({
    sql: `UPDATE invites SET used_at = ? WHERE code = ?`, args: [now(), code],
  });

  const token = await createSession(user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 30 * 86400,
  });

  return NextResponse.json({ ok: true });
}
