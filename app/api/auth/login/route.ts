import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE, LOCK_MESSAGE, DUMMY_HASH, createSession, findByEmail,
  verifyPassword, noteFailure, clearFailures, noteSourceFailure, sourceLocked, sourceKey,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });

  /* Throttling hangs on where the attempt came from, not on the account:
     locking the account would let anyone who knows an address lock its
     owner out for as long as they cared to keep typing. */
  const source = sourceKey(req);
  if (await sourceLocked(source, email)) return NextResponse.json({ error: LOCK_MESSAGE }, { status: 429 });

  const row = await findByEmail(email);
  const generic = { error: "Wrong email or password" };
  if (!row || Number(row.disabled)) {
    verifyPassword(password, DUMMY_HASH);
    await noteSourceFailure(source, email);
    return NextResponse.json(generic, { status: 401 });
  }
  if (!verifyPassword(password, String(row.password_hash))) {
    await noteFailure(String(row.id), source, email);
    return NextResponse.json(generic, { status: 401 });
  }

  await clearFailures(String(row.id), source, email);
  const token = await createSession(String(row.id));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86400,
  });
  return NextResponse.json({ ok: true, name: row.name });
}
