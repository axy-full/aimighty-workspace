import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Particl",
  description: "Particl — the studio's own video generation workspace, on Seedance via BytePlus ModelArk",
  manifest: "/manifest.json",
  // iOS ignores the manifest for home-screen icons — declare one explicitly.
  icons: { apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Particl", statusBarStyle: "black-translucent" },
};

export const viewport = {
  themeColor: "#0B0C0E",
  viewportFit: "cover" as const,
  // Android: shrink the layout viewport when the keyboard opens instead of
  // covering the fixed shell.
  interactiveWidget: "resizes-content" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
