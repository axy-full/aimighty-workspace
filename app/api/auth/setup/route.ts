import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, createSession, createFirstAdmin, passwordProblem, userCount } from "@/lib/auth";
import { accountJson, accountFailure, sameOriginProblem } from "@/lib/accountDb";

export const dynamic = "force-dynamic";

/** First run only: the first account becomes the platform's owner. Closed once one exists. */
export const POST = recoveryRoute(async function POST(req: Request) {
  if (sameOriginProblem(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  if ((await userCount()) > 0) {
    return NextResponse.json({ error: "Setup is already complete. Ask for an invitation." }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = await accountJson(req); } catch (error) { return accountFailure(error); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
  const pwProblem = passwordProblem(password);
  if (pwProblem) return NextResponse.json({ error: pwProblem }, { status: 400 });

  const user = await createFirstAdmin(email, name, password);
  if (!user) return NextResponse.json({ error: "Setup is already complete. Ask for an invitation." }, { status: 403 });
  const token = await createSession(user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86400,
  });
  return NextResponse.json({ ok: true });
});
