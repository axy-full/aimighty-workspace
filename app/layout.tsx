import type { Metadata } from "next";
import { Outfit, Kode_Mono, Geist } from "next/font/google";
import "./globals.css";

/* The brand's two faces. Outfit sets the wordmark and every big title;
   Kode Mono sets the STUDIO tag and the small uppercase labels. latin-ext
   carries the dotless ı the wordmark is built on. */
const outfit = Outfit({
  subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"],
  variable: "--font-outfit", display: "swap",
});
const kode = Kode_Mono({
  subsets: ["latin"], weight: ["500", "700"], variable: "--font-kode-mono", display: "swap",
});
/* The interface face. 300 carries lead copy and prompts, 400 body, 500
   labels — the system asks for all three, and the weights are what make a
   monochrome interface read as more than one voice. */
const geist = Geist({
  subsets: ["latin"], weight: ["300", "400", "500", "600"],
  variable: "--font-geist", display: "swap",
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
  // Follows the scheme; lib/theme.ts overrides it when a person chooses.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ECEDEF" },
    { media: "(prefers-color-scheme: dark)",  color: "#1D1F24" },
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
    <html lang="en" suppressHydrationWarning className={`${outfit.variable} ${kode.variable} ${geist.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
