"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Generate" },
  { href: "/projects", label: "Projects" },
  { href: "/all", label: "All gens" },
  { href: "/usage", label: "Usage" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-ink/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1400px] items-center gap-6 px-5 py-3 md:px-8">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <span className="grid h-6 w-6 place-items-center rounded bg-accent font-mono text-[13px] font-bold text-black">
            ▲
          </span>
          <span className="font-mono text-[13px] tracking-tight text-fg">ark<span className="text-muted">/video</span></span>
        </Link>

        <nav className="flex items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors ${
                  active ? "bg-panel2 text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <span className="ml-auto hidden font-mono text-[11px] text-muted sm:block">
          internal · seedance
        </span>
      </div>
    </header>
  );
}
