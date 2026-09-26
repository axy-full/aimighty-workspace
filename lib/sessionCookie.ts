/**
 * The session cookie's name, on its own. lib/auth.ts owns sessions and
 * re-exports this; it lives apart so proxy.ts can tell a member from a
 * visitor without bundling the database into the proxy.
 */
export const SESSION_COOKIE = "aw_session";
