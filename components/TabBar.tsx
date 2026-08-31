"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconProjects, IconGenerate, IconMeter, IconGear,
} from "./Icons";

/**
 * The whole navigation, floating over the work as one pill. It replaced a
 * 214px rail: on a laptop the rail spent its width on things that belong to
 * a screen (the project list is now the Projects tab, spend is in the top
 * bar, the account is in Settings), and on a phone it simply wasn't there.
 */
const TABS = [
  { href: "/",         label: "Projects", Icon: IconProjects },
  { href: "/generate", label: "Generate", Icon: IconGenerate },
  { href: "/usage",    label: "Usage",    Icon: IconMeter },
  { href: "/settings", label: "Settings", Icon: IconGear },
];

export default function TabBar() {
  const path = usePathname();

  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map(({ href, label, Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link key={href} href={href} className="tab" data-active={active} aria-current={active ? "page" : undefined}>
            <Icon className="!h-[21px] !w-[21px]" />
            <span className="font-medium">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
