import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Particl",
  description: "Particl — the studio's own video generation workspace, on Seedance via BytePlus ModelArk",
  manifest: "/manifest.json",
  // iOS ignores the manifest for home-screen icons — declare one explicitly.
  // Versioned so a browser that has cached the old aimighty mark — or a
  // home screen that installed it — is forced to fetch the new one.
  icons: {
    icon: [{ url: "/favicon.ico?v=2" }, { url: "/icon.png?v=2", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png?v=2" }],
  },
  appleWebApp: { capable: true, title: "Particl", statusBarStyle: "black-translucent" },
};

export const viewport = {
  // Follows the scheme; lib/theme.ts overrides it when a person chooses.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAF8" },
    { media: "(prefers-color-scheme: dark)",  color: "#141416" },
  ],
  viewportFit: "cover" as const,
  // Android: shrink the layout viewport when the keyboard opens instead of
  // covering the fixed shell.
  interactiveWidget: "resizes-content" as const,
};

/**
 * Runs before first paint. A chosen theme goes on <html> here rather than in
 * React, because React arrives after the first frame — and a dark-mode user
 * would see the light page flash on every load. "auto" leaves no attribute,
 * so the CSS media query governs on its own.
 */
const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("aw_theme");var d=document.documentElement;if(p==="light"||p==="dark"){d.dataset.theme=p;}else{delete d.dataset.theme;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script above may have stamped data-theme
    // on <html> before React compared it to the server's version.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
