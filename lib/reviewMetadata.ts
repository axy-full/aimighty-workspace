import type { Metadata } from "next";

/**
 * The metadata of a client review page (app/review/[token]): the studio's
 * title, and nothing of the platform's — a neutral tab icon, no home-screen
 * name or install manifest of Particl's, and a link preview in the studio's
 * name. The root layout's are replaced key by key, so each is set here.
 */
export const NEUTRAL_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23333'/%3E%3C/svg%3E";

export function reviewMetadata(title: string, description: string | null, siteName: string | null): Metadata {
  return {
    title,
    description,
    robots: { index: false, follow: false },
    icons: { icon: [{ url: NEUTRAL_ICON, type: "image/svg+xml" }], apple: [] },
    appleWebApp: { capable: false, title },
    manifest: null,
    openGraph: { type: "website", title, ...(description ? { description } : {}), ...(siteName ? { siteName } : {}) },
    twitter: { card: "summary", title, ...(description ? { description } : {}) },
  };
}
