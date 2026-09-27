import type { MetadataRoute } from "next";
import { PUBLIC_PATHS, siteOrigin } from "@/lib/site";

/** The public pages only. With no origin configured there is nothing absolute to list. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  if (!origin) return [];
  return PUBLIC_PATHS.map((path) => ({ url: `${origin}${path === "/" ? "" : path}` }));
}
