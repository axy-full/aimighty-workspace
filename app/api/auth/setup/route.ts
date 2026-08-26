import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE, createSession, createFirstAdmin, passwordProblem, userCount,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Creates the very first (admin) account. Closed forever once one exists. */
export async function POST(req: Request) {
  if ((await userCount()) > 0) {
    return NextResponse.json(
      { error: "Setup is already complete. Ask an admin for an invite." },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
  }
  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

  // Atomic: the insert itself requires the users table to be empty, so a
  // concurrent setup race produces exactly one admin.
  const user = await createFirstAdmin(email, name, password);
  if (!user) {
    return NextResponse.json(
      { error: "Setup is already complete. Ask an admin for an invite." },
      { status: 403 }
    );
  }
  const token = await createSession(user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 30 * 86400,
  });

  return NextResponse.json({ ok: true });
}
