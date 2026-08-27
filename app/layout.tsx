import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "aimighty workspace",
  description: "Internal video generation workspace — Seedance on BytePlus ModelArk",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "aimighty", statusBarStyle: "black-translucent" },
};

export const viewport = { themeColor: "#0B0C0E" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
