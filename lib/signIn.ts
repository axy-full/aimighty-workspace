/**
 * Where somebody signs in, carrying where they were: `/login?next=<path and
 * query>`, or a bare /login from the front page. A plain module, so the
 * server (lib/shell/bootstrap.server.ts) and the browser (lib/session.tsx)
 * build the same link. /login resolves `next` against its own origin before
 * following it (components/WelcomeSignIn.tsx › safeNext).
 */
export function signInHrefFor(path: string | null, query = ""): string {
  const search = query.replace(/^\?/, "");
  const here = path ? `${path}${search ? `?${search}` : ""}` : "";
  return here && here !== "/" ? `/login?next=${encodeURIComponent(here)}` : "/login";
}

/**
 * Where a shell entry (/suites) sends a request it cannot serve: a visitor signs in and comes back to exactly this URL.
 * (An account with no workspace is not sent anywhere: the shell says so itself, components/graphite/NoWorkspace.tsx.)
 */
export function shellEntryRedirect(pathname: string, query: string): string {
  return signInHrefFor(pathname, query.replace(/^\?/, ""));
}
