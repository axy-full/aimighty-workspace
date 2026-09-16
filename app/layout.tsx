import type { Metadata } from "next";
import { Outfit, Kode_Mono } from "next/font/google";
import "./globals.css";

/* Keep the approved wordmark fonts. Graphite interface typography is defined
   by the shared system-font tokens in globals.css. */
const outfit = Outfit({
  subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"],
  variable: "--font-outfit", display: "swap",
});
const kode = Kode_Mono({
  subsets: ["latin"], weight: ["400", "500"], variable: "--font-kode-mono", display: "swap",
});

export const metadata: Metadata = {
  title: "Particl",
  description: "particl studio — the studio's own room for making shots, and for knowing what they cost",
  manifest: "/manifest.json",
  // iOS ignores the manifest for home-screen icons — declare one explicitly.
  // Versioned so a browser or home screen that cached an older mark is
  // forced to fetch this one: v3 is the trail.
  icons: {
    icon: [
      { url: "/favicon.svg?v=3", type: "image/svg+xml" },
      { url: "/favicon.ico?v=3" },
      { url: "/icon.png?v=3", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png?v=3" }],
  },
  appleWebApp: { capable: true, title: "Particl", statusBarStyle: "black-translucent" },
};

export const viewport = {
  /* particl is dark, so the browser chrome is too — one value, not a pair
     keyed on a system preference the app no longer follows (§4). atomik's
     routes override this with the paper ground in their own layout. */
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
    <html lang="en" className={`${outfit.variable} ${kode.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
