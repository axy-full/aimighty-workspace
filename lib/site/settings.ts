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
 * - `guestHome`: guests may read the sample production. Since the old homepage was deleted (decision 41), "/"
 *   signed out is always Guest Home; this switch only lets it read the sample.
 * - `guestWorkspace`: the one workspace whose sample production a guest may read. Nothing else is ever read for a
 *   guest; null means there is no sample to show.
 */
export const SITE_ROW = "site";

export type SiteSettings = {
  openSignup: boolean;
  guestHome: boolean;
  guestWorkspace: string | null;
};

export const DEFAULT_SITE: SiteSettings = Object.freeze({ openSignup: false, guestHome: false, guestWorkspace: null }) as SiteSettings;

/** The same well-formed id shape the new-interface switch accepts. */
const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** What is stored, made safe: booleans only when they are exactly true, a workspace id only when it is well formed. */
export function cleanSite(value: unknown): SiteSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const ws = raw.guestWorkspace;
  return {
    openSignup: raw.openSignup === true,
    guestHome: raw.guestHome === true,
    guestWorkspace: typeof ws === "string" && WORKSPACE_ID.test(ws) ? ws : null,
  };
}

/** A change from /admin: only the three fields, each checked; anything else is refused with the reason. */
export function sitePatch(body: unknown): { patch: Partial<SiteSettings> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send the settings to change." };
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !["openSignup", "guestHome", "guestWorkspace"].includes(k));
  if (unknown.length) return { error: `Not a site setting: ${unknown.join(", ")}.` };
  const patch: Partial<SiteSettings> = {};
  for (const key of ["openSignup", "guestHome"] as const) {
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
