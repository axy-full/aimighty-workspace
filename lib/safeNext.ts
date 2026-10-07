/**
 * Where sign-in may send a person afterwards: the `next` of `/login?next=<address>`, which arrives from the URL and is
 * therefore attacker-controlled. Only a path on THIS origin is kept; anything else is "/".
 *
 * The obvious check (starts with "/" and not "//") is not enough. Browsers read a backslash as a slash and the URL parser
 * strips control characters before it resolves, so the test is a resolution. And a resolved path can itself start with
 * "//" (`/.//host` and `/a/..//host` both do), which the router would then read as another origin: those are refused too.
 *
 * `origin` is the page's own (window.location.origin); null on the server, where the shape check alone applies.
 */
export function safeNext(raw: string | null | undefined, origin: string | null): string {
  if (!raw) return "/";
  if (/[\u0000-\u001F\u007F\\]/.test(raw) || raw !== raw.trim()) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (origin === null) return /^\/[^/]/.test(raw) || raw === "/" ? raw : "/";
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (resolved.origin !== new URL(origin).origin) return "/";
  const path = resolved.pathname + resolved.search + resolved.hash;
  /* A leading "//" or "/\" after resolution would be read as a host by the router. */
  return /^\/[^/\\]/.test(path) || path === "/" ? path : "/";
}
