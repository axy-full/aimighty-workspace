"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The phone's nav: five tabs on particl, four on atomik, each a 22px line
 * glyph over a mono label. Sticky at the bottom, over the home indicator.
 * Hidden at desktop widths by the stylesheet; absent on focused flows
 * (the shot builder), which carry their own action bar instead.
 */
const PARTICL = [
  { href: "/", label: "GENERATE", match: (p: string) => p === "/" || p.startsWith("/images") || p.startsWith("/audio") || p.startsWith("/generate"), d: "M8 5.5v13l10-6.5z" },
  { href: "/projects", label: "PRODUCTIONS", match: (p: string) => p.startsWith("/projects") || p.startsWith("/all") || p.startsWith("/canvas"), d: "M4 6.5h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1zm0 7h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z" },
  { href: "/studio", label: "STUDIO", match: (p: string) => p.startsWith("/studio"), d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" },
  { href: "/usage", label: "USAGE", match: (p: string) => p.startsWith("/usage"), d: "M4 20V12M9.5 20V6M15 20v-9M20.5 20v-5" },
  { href: "/settings", label: "SETTINGS", match: (p: string) => p.startsWith("/settings") || p.startsWith("/team") || p.startsWith("/admin"), d: "M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4" },
];
const ATOMIK = [
  { href: "/atomik/ideas", label: "IDEAS", match: (p: string) => p === "/atomik" || p.startsWith("/atomik/ideas") || p.startsWith("/atomik/agent"), d: "M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm0-5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" },
  { href: "/atomik/treatment", label: "TREATMENT", match: (p: string) => p.startsWith("/atomik/treatment"), d: "M5 7h14M5 12h14M5 17h9" },
  { href: "/atomik/breakdown", label: "BREAKDOWN", match: (p: string) => p.startsWith("/atomik/breakdown"), d: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
  { href: "/atomik/shots", label: "SHOT LIST", match: (p: string) => p.startsWith("/atomik/shots"), d: "M4 7l2 2 3-3M4 13l2 2 3-3M4 19l2 2 3-3M12 8h8M12 14h8M12 20h8" },
];

export default function TabBar() {
  const path = usePathname();
  // Focused flows carry their own action bar.
  if (path.startsWith("/studio/shot")) return null;
  const tabs = path.startsWith("/atomik") ? ATOMIK : PARTICL;
  return (
    <nav className="tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={`tabbar-tab ${t.match(path) ? "is-on" : ""}`}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.d} /></svg>
          <span>{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}

/** Video · Images · Audio, sticky under the header on the three Make screens. */
export function MakeTabs() {
  const path = usePathname();
  const on = path === "/" || path.startsWith("/images") || path.startsWith("/audio") || path.startsWith("/generate");
  if (!on) return null;
  const tabs = [["/", "Video"], ["/images", "Images"], ["/audio", "Audio"]] as const;
  const active = (h: string) => (h === "/" ? path === "/" || path.startsWith("/generate") : path.startsWith(h));
  return (
    <div className="maketabs">
      <div className="seg is-fill">
        {tabs.map(([h, l]) => <Link key={h} href={h} className={`seg-opt ${active(h) ? "is-on" : ""}`}>{l}</Link>)}
      </div>
    </div>
  );
}
