import { NextResponse } from "next/server";
import { sourceKey, sourceLocked } from "@/lib/auth";
import { AccountError, sameOriginProblem, takeAccountLimit } from "@/lib/accountDb";
import { readBoundedText } from "@/lib/requestBody";
import { safeNext } from "@/lib/safeNext";
import {
  GOOGLE_COOKIE, GOOGLE_THROTTLE_KEY, STATE_TTL_MS, authorizationUrl, googleConfig, newGoogleRequest, sealGoogleCookie, startIntent, type GoogleRefusal,
} from "@/lib/googleSignIn";

export const dynamic = "force-dynamic";

/* A relative Location: the public origin is whatever the browser used (the listen address behind a proxy is not it). */
const see = (to: string) => new NextResponse(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });
const back = (code: GoogleRefusal) => see(`/login?google=${code}`);

/**
 * Starts "Continue with Google" (lib/googleSignIn.ts): a fresh state, nonce and PKCE verifier, kept in a signed cookie for ten minutes,
 * then Google. A GET (the sign-in page's link) is a plain sign-in with `next`, where to land. A POST is the join sheet's form: it may
 * also carry `invite`, a team invitation's code (a new person needs one), and `accept=1`, the sheet's 18+ and Terms tick (lib/ageConfirm.ts);
 * both are kept only when the form came from Particl's own page (startIntent). Nothing is created and no one is signed in here.
 */
async function start(req: Request, fields: { get(name: string): unknown }, post: boolean) {
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
  const ourOrigin = Boolean(req.headers.get("origin")) && !sameOriginProblem(req);
  const { invite, accept } = startIntent(fields, { post, fetchSite: req.headers.get("sec-fetch-site"), ourOrigin });
  const next = fields.get("next");
  const request = newGoogleRequest();
  const res = see(authorizationUrl(config, request));
  res.cookies.set(GOOGLE_COOKIE, sealGoogleCookie({
    state: request.state, nonce: request.nonce, verifier: request.verifier, invite,
    accept, next: safeNext(typeof next === "string" ? next : null, new URL(config.redirectUri).origin), exp: Date.now() + STATE_TTL_MS,
  }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/google", maxAge: STATE_TTL_MS / 1000 });
  return res;
}

export async function GET(req: Request) {
  return start(req, new URL(req.url).searchParams, false);
}

/* The join sheet's form is url-encoded and a few hundred bytes. Anything else, or anything bigger, is read no further than 4 KB and
 * becomes a plain sign-in: an anonymous POST never buffers a large body on the server. */
export async function POST(req: Request) {
  const urlencoded = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded";
  const text = urlencoded ? await readBoundedText(req, 4096).catch(() => "") : "";
  if (!urlencoded) void req.body?.cancel().catch(() => {});
  return start(req, new URLSearchParams(text), true);
}
