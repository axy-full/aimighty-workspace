/**
 * The public face of the deployment: where it lives, what it says about
 * itself, and which pages a stranger may land on. Read by the root metadata,
 * robots.txt and the sitemap, so the three cannot disagree.
 */

type Env = Record<string, string | undefined>;

/**
 * APP_ORIGIN, normalised to scheme://host[:port] (no path, no trailing slash);
 * null when unset or not an http(s) URL. The one reading of APP_ORIGIN that
 * links, link previews and the proxy origin check (lib/requestOrigin.ts) share.
 */
export function configuredOrigin(env: Env = process.env): string | null {
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

/** The origin links and link previews are built on: APP_ORIGIN, else the production deployment's. */
export function siteOrigin(env: Env = process.env): string | null {
  const forced = configuredOrigin(env);
  if (forced) return forced;
  const production = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return production ? `https://${production.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}` : null;
}

/**
 * The origin of a link handed back to the person who asked for it (a review
 * link, a share link, the API description): APP_ORIGIN, else the request's own
 * origin. Behind a proxy the request's own origin is the server's listen
 * address, so a self-hosted deployment sets APP_ORIGIN; on Vercel the request's
 * own origin is the host Vercel routed, as it always was. Request headers
 * (Host, X-Forwarded-*) are never read.
 */
export function linkOrigin(req: Request, env: Env = process.env): string {
  return configuredOrigin(env) ?? new URL(req.url).origin;
}

/**
 * The origin of a link sent by email (password reset, invitation, sign-up
 * verification, the top-up desk), where a wrong host hands a one-time secret
 * to whoever owns it. Never built from request headers:
 * - APP_ORIGIN when it is set (production sets it);
 * - on Vercel without it, the request's own origin: Vercel only routes this
 *   project's own domains to the function, so it is one of ours;
 * - outside production (next dev, tests), the request's own origin;
 * - otherwise (a self-hosted production server without APP_ORIGIN) null, and
 *   the caller sends nothing rather than a link to its listen address.
 */
export function mailLinkOrigin(req: Request, env: Env = process.env): string | null {
  const forced = configuredOrigin(env);
  if (forced) return forced;
  if (env.VERCEL || env.NODE_ENV !== "production") return new URL(req.url).origin;
  return null;
}

/**
 * mailLinkOrigin for mail sent with no request in hand (the "renders are being
 * held" notice): APP_ORIGIN; on Vercel without it, the production deployment's
 * domain (VERCEL_PROJECT_PRODUCTION_URL, which Vercel sets); otherwise null, and
 * the caller sends nothing rather than a link with no host.
 */
export function backgroundMailOrigin(env: Env = process.env): string | null {
  const forced = configuredOrigin(env);
  if (forced) return forced;
  return env.VERCEL ? siteOrigin(env) : null;
}

export const SITE_NAME = "Particl";
export const SITE_TITLE = "Particl Studio";
export const SITE_DESCRIPTION = "A production studio for generated film: brief, shots, takes and delivery.";

/** The pages anyone may open without an account, for the sitemap. */
export const PUBLIC_PATHS = ["/", "/welcome", "/login", "/signup", "/pricing", "/terms", "/privacy", "/policy", "/report"] as const;

/** Never crawled: the API, one-time links, and account and platform screens. */
export const PRIVATE_PATHS = ["/api/", "/invite/", "/reset/", "/account/", "/admin", "/setup"] as const;

/**
 * A client's review page is NOT in robots.txt, on purpose. Its link preview
 * (lib/reviewMetadata.ts) is fetched by bots that honour robots.txt, and a
 * crawler that may not fetch a page never reads its noindex either, so a
 * leaked link could still be listed by URL alone. It is kept out of every
 * index by its own noindex meta and by this header (next.config.ts).
 */
export const NOINDEX_PATHS = ["/review/:path*"] as const;
export const NOINDEX_HEADER = { key: "X-Robots-Tag", value: "noindex, nofollow" } as const;

/**
 * Server metadata for a public page whose body is a client component: what a
 * crawler or a link preview reads before any script runs. The preview card is
 * restated because a page's `openGraph` replaces the root's whole.
 */
export function publicPageMetadata(title: string, description: string) {
  const full = `${title} · ${SITE_NAME}`;
  return {
    title: full,
    description,
    openGraph: {
      type: "website" as const, siteName: SITE_NAME, title: full, description,
      images: [{ url: "/icon.png?v=3", width: 1024, height: 1024, alt: SITE_NAME }],
    },
    twitter: { card: "summary" as const, title: full, description, images: ["/icon.png?v=3"] },
  };
}
