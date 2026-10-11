import { NextResponse } from "next/server";
import { sourceKey, sourceLocked } from "@/lib/auth";
import { AccountError, takeAccountLimit } from "@/lib/accountDb";
import { safeNext } from "@/lib/safeNext";
import {
  GOOGLE_COOKIE, GOOGLE_THROTTLE_KEY, STATE_TTL_MS, authorizationUrl, cleanInviteCode, googleConfig, newGoogleRequest, sealGoogleCookie, type GoogleRefusal,
} from "@/lib/googleSignIn";

export const dynamic = "force-dynamic";

/* A relative Location: the public origin is whatever the browser used (the listen address behind a proxy is not it). */
const see = (to: string) => new NextResponse(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });
const back = (code: GoogleRefusal) => see(`/login?google=${code}`);

/**
 * Starts "Continue with Google" (lib/googleSignIn.ts): a fresh state, nonce and PKCE verifier, kept in a signed cookie for ten minutes,
 * then Google. `invite` is a team invitation's code (a new person needs one), `accept=1` is the content policy and terms accepted on the
 * page the button is on, `next` where to land. Nothing is created and no one is signed in here.
 */
export async function GET(req: Request) {
  const config = googleConfig();
  if (!config) return back("off");
  const source = sourceKey(req);
  try {
    await takeAccountLimit(`google-start:${source}`, 30, 10 * 60_000);
  } catch (error) {
    if (error instanceof AccountError) return back("limited");
    throw error;
  }
  if (await sourceLocked(source, GOOGLE_THROTTLE_KEY)) return back("limited");
  const query = new URL(req.url).searchParams;
  const request = newGoogleRequest();
  const res = see(authorizationUrl(config, request));
  res.cookies.set(GOOGLE_COOKIE, sealGoogleCookie({
    state: request.state, nonce: request.nonce, verifier: request.verifier, invite: cleanInviteCode(query.get("invite")),
    accept: query.get("accept") === "1", next: safeNext(query.get("next"), new URL(config.redirectUri).origin), exp: Date.now() + STATE_TTL_MS,
  }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/google", maxAge: STATE_TTL_MS / 1000 });
  return res;
}
