import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/sessionCookie";

/**
 * The public site lives at /site (app/(marketing)/site) and is served at the
 * product's own paths. Four of those paths are also the app's, so they show
 * the site only to a visitor: no session cookie, no app parameters in the
 * query. A member at / still gets the app.
 * /studio, /business and /viral have no app page of their own and always
 * show the site.
 */
const VISITOR_ONLY: Record<string, string> = {
  "/": "/site",
  "/atomik": "/site/atomik",
  "/workspace": "/site/workspace",
  "/pricing": "/site/pricing",
};
const ALWAYS: Record<string, string> = {
  "/studio": "/site/studio",
  "/business": "/site/business",
  "/viral": "/site/viral",
};
/* Any of these in the query is an app link (a project, a page, a view). */
const APP_PARAMS = ["project", "suite", "page", "stage", "sel", "new", "atomik", "view", "make", "tab", "sp", "cp", "plan", "cadence"];

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  /* /site is an implementation detail; its canonical address is the path above. */
  if (pathname === "/site" || pathname.startsWith("/site/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(5) || "/";
    return NextResponse.redirect(url, 308);
  }

  const always = ALWAYS[pathname];
  if (always) return rewrite(request, always);

  const target = VISITOR_ONLY[pathname];
  if (!target) return NextResponse.next();
  const member = request.cookies.has(SESSION_COOKIE);
  const appLink = APP_PARAMS.some((key) => searchParams.has(key));
  if (member || appLink) return NextResponse.next();
  return rewrite(request, target);
}

function rewrite(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/", "/atomik", "/workspace", "/pricing", "/studio", "/business", "/viral", "/site", "/site/:path*"],
};
