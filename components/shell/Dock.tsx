"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCK } from "@/lib/nav";

/**
 * The phone's dock (design/particl-v2/README.md §14): `Needs you · Make ·
 * Productions`, at the bottom, over the home indicator. The handoff names
 * it and draws no board for it, so it is built from the shell's own
 * numbers: 56px on `--ground` under a .08 hairline, three equal cells, the
 * label in mono at the phone's 12px floor — ink where you are, muted
 * elsewhere. Every target is 56pt tall (§16: ≥ 44).
 */
export default function Dock() {
  const path = usePathname();
  return (
    <nav aria-label="Sections" className="shell-dock flex md:hidden">
      {DOCK.map((d) => {
        const on = d.match(path);
        return (
          <Link key={d.label} href={d.href} aria-current={on ? "page" : undefined}
            className={`flex min-h-[56px] flex-1 items-center justify-center ui-mono ${on ? "text-ink" : "text-ink-muted"}`}>
            {d.label}
          </Link>
        );
      })}
    </nav>
  );
}
