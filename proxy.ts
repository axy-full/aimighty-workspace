import { NextResponse, type NextRequest } from "next/server";
import { MOVED_PAGES } from "@/lib/marketing/moved";
import { SESSION_COOKIE } from "@/lib/sessionCookie";

/**
 * The public site lives at /site (app/(marketing)/site) and is served at the
 * product's own paths. Four of those paths are also the app's, so they show
 * the site only to a visitor: no session cookie, no app parameters in the
 * query. A member at / still gets the app.
 * /studio, /ads and /social have no app page of their own and always show
 * the site.
 *
 * The site's pages were once /business, /viral and /workspace. Those move for
 * good, 308 with the query kept (lib/marketing/moved.ts).
 */
const VISITOR_ONLY: Record<string, string> = {
  "/": "/site",
  "/atomik": "/site/atomik",
  "/settings": "/site/settings",
  "/pricing": "/site/pricing",
};
const ALWAYS: Record<string, string> = {
  "/studio": "/site/studio",
  "/ads": "/site/ads",
  "/social": "/site/social",
};
/* Any of these in the query is an app link (a project, a page, a view). */
const APP_PARAMS = ["project", "suite", "page", "stage", "sel", "new", "atomik", "view", "make", "tab", "sp", "cp", "plan", "cadence"];

/** No session and no app parameter in the query: someone the public site is for. */
function isVisitor(request: NextRequest) {
  const member = request.cookies.has(SESSION_COOKIE);
  const appLink = APP_PARAMS.some((key) => request.nextUrl.searchParams.has(key));
  return !member && !appLink;
}

function moved(request: NextRequest, pathname: string, status: 307 | 308 = 308) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.redirect(url, status);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /* /site is an implementation detail; its canonical address is the path above (an old one goes straight to its new). */
  if (pathname === "/site" || pathname.startsWith("/site/")) {
    /* `/site//x` would otherwise redirect to `//x`, a host-relative address. */
    const path = pathname.slice(5).replace(/^\/{2,}/, "/") || "/";
    return moved(request, MOVED_PAGES[path]?.to ?? path);
  }

  const old = MOVED_PAGES[pathname];
  /* Temporary (307) where the same address is the app's for a member: a cached 308 would send a member who signs in to the site. */
  if (old && (!old.visitorOnly || isVisitor(request))) return moved(request, old.to, old.visitorOnly ? 307 : 308);

  const always = ALWAYS[pathname];
  if (always) return rewrite(request, always);

  const target = VISITOR_ONLY[pathname];
  if (!target) return NextResponse.next();
  if (!isVisitor(request)) return NextResponse.next();
  return rewrite(request, target);
}

function rewrite(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/", "/atomik", "/settings", "/workspace", "/pricing", "/studio", "/ads", "/social", "/business", "/viral", "/site", "/site/:path*"],
};
