import type { Metadata } from "next";
import "@/components/graphite/shell.css";
import "@/components/marketing/marketing.css";

export const metadata: Metadata = {
  title: { default: "particl studio", template: "%s · particl studio" },
  description: "The studio's own room for making shots. One board per production, every price shown, and a person approves the spend.",
  openGraph: { images: ["/campaign/hero.webp"] },
};
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };

/* Rendered per request: the header depends on whether the visitor has a
   session, and prices follow the platform layer the moment an admin edits it. */
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <div className="gx mk">{children}</div>;
}
