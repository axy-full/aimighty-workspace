"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCompose, IconLibrary, IconMeter } from "./Icons";

const PAGES = [
  { href: "/",      label: "Compose", Icon: IconCompose },
  { href: "/all",   label: "Library", Icon: IconLibrary },
  { href: "/usage", label: "Usage",   Icon: IconMeter },
];

/** Phone-width page switcher — the rail's stand-in below 860px. */
export default function PageSwitcher() {
  const path = usePathname();

  return (
    <nav className="app-switcher items-stretch justify-around px-2">
      {PAGES.map(({ href, label, Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href} href={href} title={label}
            className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-[9px] transition-colors ${
              active ? "text-bone" : "text-mute"
            }`}
          >
            <Icon className={`!h-[17px] !w-[17px] ${active ? "text-lift" : ""}`} />
            <span className="text-[10px] font-medium">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
