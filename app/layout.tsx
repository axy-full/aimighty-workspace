import type { Metadata } from "next";
import DeviceProbe from "@/components/switchover/DeviceProbe";
import PreviewLayer from "@/components/PreviewLayer";
import DragLayer from "@/components/DragLayer";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, siteOrigin } from "@/lib/site";
import "./fonts.css";
import "./globals.css";
import "./four-suites.css";
import "./preview.css";

/* Keep the approved wordmark fonts (Outfit, Kode Mono), bundled in public/fonts
   and declared in app/fonts.css. Graphite interface typography is defined by the
   shared system-font tokens in globals.css. */

/* Absolute URLs for link previews (Slack, X, iMessage) are built on this. Next
   falls back to localhost in development; the fallback here only keeps a
   relative image legal when no origin is configured at all. */
const origin = siteOrigin() ?? `http://localhost:${process.env.PORT || 3000}`;

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website", siteName: SITE_NAME, title: SITE_TITLE, description: SITE_DESCRIPTION,
    images: [{ url: "/icon.png?v=3", width: 1024, height: 1024, alt: SITE_NAME }],
  },
  twitter: { card: "summary", title: SITE_TITLE, description: SITE_DESCRIPTION, images: ["/icon.png?v=3"] },
  manifest: "/manifest.json",
  // iOS ignores the manifest for home-screen icons — declare one explicitly.
  // Versioned so a browser or home screen that cached an older mark is
  // forced to fetch this one: v3 is the trail. These are the only icons: the
  // old ring-of-dots app/icon.png and app/favicon.ico, which Next served at
  // the same URLs and put first in <head>, are gone.
  icons: {
    icon: [
      { url: "/favicon.svg?v=3", type: "image/svg+xml" },
      { url: "/favicon.ico?v=3" },
      { url: "/icon.png?v=3", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png?v=3" }],
  },
  appleWebApp: { capable: true, title: "Particl Production Studio", statusBarStyle: "black-translucent" },
};

export const viewport = {
  /* particl is dark, so the browser chrome is too — one value, not a pair
     keyed on a system preference the app no longer follows (§4). all three suites share the same dark ground. */
  themeColor: "#000000",
  viewportFit: "cover" as const,
  // Android: shrink the layout viewport when the keyboard opens instead of
  // covering the fixed shell.
  interactiveWidget: "resizes-content" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* No pre-paint theme script and no suppressHydrationWarning: there is
       one ground now, so there is nothing to stamp on <html> before the
       first frame and nothing for the server and the browser to disagree
       about. The flash this used to prevent cannot happen — the page has
       been dark since the stylesheet loaded. */
    <html lang="en">
      <head>
        {/* The wordmark's Latin files, fetched with the page so it does not swap in late. */}
        <link rel="preload" href="/fonts/outfit-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/kode-mono-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="" />
        {/* The switch-over gate's one decision, taken while the document parses.
            It belongs to the root layout because this is the only place React
            renders exactly once per document: a page segment is re-rendered by a
            client-side navigation, and a <script> created during a client render
            is never executed — React logs an error saying so, which the dev
            overlay counts as an issue. See components/switchover/DeviceProbe.tsx
            and docs/workspace-switchover.md. */}
        <DeviceProbe />
      </head>
      <body className="font-sans antialiased">{children}<PreviewLayer /><DragLayer /></body>
    </html>
  );
}
