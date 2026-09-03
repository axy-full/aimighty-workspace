"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconProjects, IconGenerate, IconStudio, IconMeter, IconGear, IconAudio, IconImage,
} from "./Icons";

/**
 * The whole navigation, floating over the work as one pill. It replaced a
 * 214px rail: on a laptop the rail spent its width on things that belong to
 * a screen (the project list is now the Projects tab, spend is in the top
 * bar, the account is in Settings), and on a phone it simply wasn't there.
 */
/* Order follows the work, not the filesystem: you come here to make a shot,
   so Generate leads — and it is the landing page. Projects is where the made
   things live, Studio is where the vocabulary they're made from is kept, and
   the rest is housekeeping. */
const TABS = [
  { href: "/",         label: "Video",    Icon: IconGenerate },
  { href: "/images",   label: "Images",   Icon: IconImage },
  { href: "/audio",    label: "Audio",    Icon: IconAudio },
  { href: "/projects", label: "Projects", Icon: IconProjects },
  { href: "/studio",   label: "Studio",   Icon: IconStudio },
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
