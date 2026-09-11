"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCK } from "@/lib/nav";
import { useProject } from "@/lib/projectContext";

/**
 * The phone's dock (design/particl-v2-mobile/README.md; board M1): `Make ·
 * PRODS · Rig · Library` at the bottom, over the home indicator — four
 * equal cells, 56px, on `--ground` under a .08 hairline, `0 6px` plus the
 * safe area; a 22px line icon (1.6 stroke, round caps) over a 12px mono
 * label at .04em; ink where you are, muted elsewhere. Usage and Settings
 * stay behind the avatar. Every target is 56pt tall (≥ 44).
 */
const ICON: Record<string, React.ReactNode> = {
  Make: <path d="M7 4.5v13l10-6.5z" strokeLinejoin="round" />,
  Productions: <><rect x="3" y="4" width="16" height="5" rx="1.5" /><rect x="3" y="13" width="16" height="5" rx="1.5" /></>,
  Rig: <><circle cx="6" cy="7" r="2.5" /><circle cx="16" cy="15" r="2.5" /><path d="M8.5 7h4a3 3 0 0 1 3 3v2.5" /></>,
  Library: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="12" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="12" width="7" height="7" rx="1.5" /><rect x="12" y="12" width="7" height="7" rx="1.5" /></>,
};

export default function Dock() {
  const path = usePathname();
  const { current } = useProject();
  return (
    <nav aria-label="Sections" className="shell-dock grid grid-cols-4 md:hidden">
      {DOCK.map((d) => {
        const on = d.match(path);
        return (
          <Link key={d.label} href={d.href({ production: current?.id ?? null })} aria-current={on ? "page" : undefined} aria-label={d.label}
            className={`flex h-[56px] flex-col items-center justify-center gap-[5px] ${on ? "text-ink" : "text-ink-muted"}`}>
            <svg viewBox="0 0 22 22" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">{ICON[d.label]}</svg>
            <span className="ui-mono !tracking-[.04em]">{d.short}</span>
          </Link>
        );
      })}
    </nav>
  );
}
