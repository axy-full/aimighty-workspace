/**
 * The public pages' old addresses, and where each went (308, query kept; proxy.ts does it).
 * /business and /viral have no other life, so they move for everyone. /workspace is also the
 * app's old route (lib/shell/old-routes.ts), so it moves for a visitor only and a member's
 * /workspace still lands in the app.
 */
export const MOVED_PAGES: Readonly<Record<string, { to: string; visitorOnly: boolean }>> = Object.freeze({
  "/business": { to: "/ads", visitorOnly: false },
  "/viral": { to: "/social", visitorOnly: false },
  "/workspace": { to: "/settings", visitorOnly: true },
});
