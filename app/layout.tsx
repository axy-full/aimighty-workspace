import type { Metadata } from "next";
import { Saira, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const saira = Saira({
  variable: "--font-saira", subsets: ["latin"],
  weight: ["600", "700", "800", "900"], display: "swap",
});
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], display: "swap" });
const jetbrains  = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "aimighty workspace",
  description: "Internal video generation workspace — Seedance on BytePlus ModelArk",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "aimighty", statusBarStyle: "black-translucent" },
};

export const viewport = { themeColor: "#0B0A09" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${saira.variable} ${interTight.variable} ${jetbrains.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
