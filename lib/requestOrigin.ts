/**
 * The origin check every state-changing route makes against cross-site
 * request forgery, in one place.
 *
 * A browser stamps `Origin` on a cross-site POST and a page cannot forge it.
 * The rule, unchanged: a request whose `Origin` differs from the origin it
 * was expected to come from is refused. A request with no `Origin` at all (a
 * non-browser API caller) is let through, as it always was; the literal
 * `null` (a sandboxed frame, a file: page) matches nothing and is refused.
 *
 * What changes is only where the expected origin comes from on a self-hosted
 * standalone server behind a reverse proxy (TLS ended at the proxy). There
 * Next builds `req.url` from its own listen address (http(s)://localhost:3000),
 * never the public host, so "the request's own origin" is meaningless and
 * every browser post was refused. Such a deployment says so on the server,
 * `SELFHOST_BEHIND_PROXY=1`, and names its public origin in `APP_ORIGIN`; the
 * expected origin is then that fixed, configured value and nothing else (the
 * listen address no longer passes). Nothing the client sends (Host,
 * X-Forwarded-Host, X-Forwarded-Proto) ever decides what is expected.
 *
 * Vercel is untouched: it never sets the flag, and the flag is ignored
 * wherever `VERCEL` is set, so a stray value there cannot change anything.
 * There, as everywhere else without the flag, the expected origin is
 * `new URL(req.url).origin`, exactly as before.
 */

type Env = Record<string, string | undefined>;

/** The configured public origin behind a proxy, normalised (scheme, host, port); null when not opted in or not usable. */
export function proxiedPublicOrigin(env: Env = process.env): string | null {
  if (env.SELFHOST_BEHIND_PROXY !== "1" || env.VERCEL) return null;
  const raw = env.APP_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    /* Only http(s): any other scheme has the opaque origin "null", which a sandboxed frame would match. */
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The origin a browser request to this server must carry. */
export function expectedOrigin(req: Request, env: Env = process.env): string {
  return proxiedPublicOrigin(env) ?? new URL(req.url).origin;
}

/** True when the request carries an `Origin` that is not the expected one. A missing `Origin` is not a problem (API callers). */
export function crossOriginProblem(req: Request, env: Env = process.env): boolean {
  const origin = req.headers.get("origin");
  return Boolean(origin && origin !== expectedOrigin(req, env));
}
