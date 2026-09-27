import type { MetadataRoute } from "next";
import { PRIVATE_PATHS, siteOrigin } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PATHS] },
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
