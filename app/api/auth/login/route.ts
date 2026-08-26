import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE, LOCK_MESSAGE, DUMMY_HASH, createSession, findByEmail,
  verifyPassword, noteFailure, clearFailures,
} from "@/lib/auth";
import { now } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const row = await findByEmail(email);

  // Same message whether the account is missing or the password is wrong —
  // don't reveal which emails exist. The dummy verify keeps the timing the
  // same too: a fast "no such user" branch would leak just as loudly.
  const generic = { error: "Wrong email or password" };
  if (!row || Number(row.disabled)) {
    verifyPassword(password, DUMMY_HASH);
    return NextResponse.json(generic, { status: 401 });
  }

  if (row.locked_until && Number(row.locked_until) > now()) {
    return NextResponse.json({ error: LOCK_MESSAGE }, { status: 429 });
  }

  if (!verifyPassword(password, row.password_hash)) {
    await noteFailure(row.id);
    return NextResponse.json(generic, { status: 401 });
  }

  await clearFailures(row.id);
  const token = await createSession(row.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 86400,
  });

  return NextResponse.json({ ok: true, name: row.name, role: row.role });
}
