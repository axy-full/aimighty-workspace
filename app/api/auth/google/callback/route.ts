import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { recoveryRoute } from "@/lib/recovery";
import { SESSION_COOKIE, sourceKey } from "@/lib/auth";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { GOOGLE_COOKIE, GoogleRefused, completeGoogleCallback, googleConfig, type GoogleRefusal } from "@/lib/googleSignIn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Where Google sends the person back (lib/googleSignIn.ts): the state is checked and spent, the code is exchanged, the ID token is read,
 * and only then, on a verified email, is anyone signed in (an existing account) or joined (a new person with a matching invitation).
 * A refusal lands on the sign-in page with one short notice; the state cookie is cleared either way.
 */
export const GET = recoveryRoute(async function GET(req: Request) {
  const jar = await cookies();
  const raw = jar.get(GOOGLE_COOKIE)?.value;
  const go = (path: string) => {
    const res = new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
    res.cookies.set(GOOGLE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/google", maxAge: 0 });
    return res;
  };
  const refused = (code: GoogleRefusal) => go(`/login?google=${code}`);
  const config = googleConfig();
  if (!config) return refused("off");
  const source = sourceKey(req);
  try {
    await takeAccountLimit(`google-callback:${source}`, 30, 10 * 60_000);
  } catch (error) {
    if (error instanceof AccountError) return refused("limited");
    throw error;
  }
  const query = new URL(req.url).searchParams;
  try {
    const done = await completeGoogleCallback({ query: { code: query.get("code"), state: query.get("state"), error: query.get("error") }, cookie: raw, source }, { config });
    const res = go(done.next);
    res.cookies.set(SESSION_COOKIE, done.session, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86400 });
    return res;
  } catch (error) {
    if (error instanceof GoogleRefused) return refused(error.code);
    console.error("[google] sign-in failed");
    return refused("unavailable");
  }
});
