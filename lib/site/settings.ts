/**
 * The site-wide switches for signed-out visitors, as data (pure: no React, no database; safe in a route, a page and
 * a test alike).
 *
 * They live in ONE row of the platform database's existing key/value table (`platform_layer`, key `site`): no
 * migration, no environment variable. Only the platform owner changes them, from /admin
 * (lib/site/settings.server.ts › writeSite). Every field is off by default, and a row that can't be read is off.
 *
 * - `openSignup`: anyone may create an account without an invitation link. Off, the server refuses a self-serve
 *   sign-up whatever the environment is configured for (lead decision 36).
 * - `guestHome`: a signed-out visitor at "/" sees Home in its guest state instead of today's site (decision 35).
 * - `visitorPages`: with `guestHome` also on, "/?guest=1" shows the new interface's visitor pages
 *   (components/v12/visitor, prototype 12). Off by default (owner, 10 Oct): nothing visitor-facing changes until the
 *   owner turns it on; off, "/?guest=1" is today's Guest Home.
 * - `guestWorkspace`: the one workspace whose sample production a guest may read. Nothing else is ever read for a
 *   guest; null means there is no sample to show.
 * - `newInterfaceEveryone`: the new interface (lib/newInterface.ts) for every workspace. ON by default (owner, 11 October 2026); off
 *   puts everyone back on today's screens with no deploy. A workspace can also be kept on today's screens by itself: one row per
 *   workspace (`newInterfaceOffKey`) in the same table, so any number can be listed and two writes never race on one row; the
 *   owner's Site block and the test helpers write them.
 */
export const SITE_ROW = "site";
/** The row that keeps one workspace on today's screens (lib/newInterface.server.ts): present means off for that workspace. */
export const newInterfaceOffKey = (workspaceId: string) => `ni_off:${workspaceId}`;

export type SiteSettings = {
  openSignup: boolean;
  guestHome: boolean;
  visitorPages: boolean;
  guestWorkspace: string | null;
  /** On unless the owner turned it off (a stored `false`). */
  newInterfaceEveryone: boolean;
};

export const DEFAULT_SITE: SiteSettings = Object.freeze({ openSignup: false, guestHome: false, visitorPages: false, guestWorkspace: null, newInterfaceEveryone: true }) as SiteSettings;

/** A well-formed workspace id. */
const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** What is stored, made safe: booleans only when they are exactly true, a workspace id only when it is well formed. */
export function cleanSite(value: unknown): SiteSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const ws = raw.guestWorkspace;
  return {
    openSignup: raw.openSignup === true,
    guestHome: raw.guestHome === true,
    visitorPages: raw.visitorPages === true,
    guestWorkspace: typeof ws === "string" && WORKSPACE_ID.test(ws) ? ws : null,
    newInterfaceEveryone: raw.newInterfaceEveryone !== false,
  };
}

/** A change from /admin: the site's own fields, and one workspace to keep on (add) or return to (remove) today's screens. */
export type SitePatch = Partial<SiteSettings> & { newInterfaceOffAdd?: string; newInterfaceOffRemove?: string };
export function sitePatch(body: unknown): { patch: SitePatch } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send the settings to change." };
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !["openSignup", "guestHome", "visitorPages", "guestWorkspace", "newInterfaceEveryone", "newInterfaceOffAdd", "newInterfaceOffRemove"].includes(k));
  if (unknown.length) return { error: `Not a site setting: ${unknown.join(", ")}.` };
  const patch: SitePatch = {};
  for (const key of ["openSignup", "guestHome", "visitorPages", "newInterfaceEveryone"] as const) {
    if (key in raw) {
      if (typeof raw[key] !== "boolean") return { error: `${key} must be true or false.` };
      patch[key] = raw[key] as boolean;
    }
  }
  if ("guestWorkspace" in raw) {
    const ws = raw.guestWorkspace;
    if (ws !== null && (typeof ws !== "string" || !WORKSPACE_ID.test(ws))) return { error: "guestWorkspace must be a workspace id or null." };
    patch.guestWorkspace = ws as string | null;
  }
  for (const key of ["newInterfaceOffAdd", "newInterfaceOffRemove"] as const) {
    if (key in raw) {
      if (typeof raw[key] !== "string" || !WORKSPACE_ID.test(raw[key] as string)) return { error: `${key} must be a workspace id.` };
      patch[key] = raw[key] as string;
    }
  }
  if (!Object.keys(patch).length) return { error: "Nothing to change." };
  return { patch };
}

/** The refusal a self-serve sign-up meets while sign-up is by invitation only. */
export const INVITE_ONLY = "Sign-up needs an invitation link.";

/**
 * That refusal as the routes answer it: 403 with `inviteOnly`, so a page shows the Request access form instead of
 * an error (lead decision 41: a self-serve sign-up verified after open sign-up closed is refused that way).
 */
export function inviteOnlyRefusal(): Response {
  return Response.json({ error: INVITE_ONLY, inviteOnly: true }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
