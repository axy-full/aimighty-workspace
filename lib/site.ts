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
