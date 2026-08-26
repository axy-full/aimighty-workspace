"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { IconCompose, IconBins, IconLibrary, IconMeter, IconTeam } from "./Icons";

const PAGES = [
  { href: "/",         label: "Compose", Icon: IconCompose, admin: false },
  { href: "/projects", label: "Bins",    Icon: IconBins,    admin: false },
  { href: "/all",      label: "Library", Icon: IconLibrary, admin: false },
  { href: "/usage",    label: "Usage",   Icon: IconMeter,   admin: false },
  { href: "/team",     label: "Team",    Icon: IconTeam,    admin: true  },
];

type Usage = { remainingUsd: number; spentUsd: number; pending: number; succeeded: number };

export default function PageSwitcher({ isAdmin = false }: { isAdmin?: boolean }) {
  const path = usePathname();
  const { data } = useApi<Usage>("/api/usage", 30000);

  return (
    <footer className="app-switcher flex items-center border-t border-line bg-chrome px-3">
      {/* left: transport-style readouts */}
      <div className="hidden min-w-0 flex-1 items-center gap-3 font-mono text-[10px] tracking-wider text-mute md:flex">
        <Cell label="QUEUE">
          <span className={data?.pending ? "text-run" : ""}>
            {data ? String(data.pending).padStart(2, "0") : "--"}
          </span>
        </Cell>
        <span className="h-3 w-px bg-line" />
        <Cell label="CLIPS">{data ? data.succeeded : "--"}</Cell>
      </div>

      {/* centre: the page switcher */}
      <nav className="flex items-center gap-1">
        {PAGES.filter((p) => !p.admin || isAdmin).map(({ href, label, Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link
              key={href} href={href} title={label}
              className={`flex h-[38px] items-center gap-2 rounded-[3px] px-3 transition-colors ${
                active
                  ? "bg-panel3 text-bone shadow-[inset_0_-2px_0_0_var(--color-lift)]"
                  : "text-mute hover:bg-panel2 hover:text-dim"
              }`}
            >
              <Icon className="!h-[17px] !w-[17px]" />
              <span className="ptitle hidden text-[10.5px] tracking-[.1em] sm:block">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* right: money */}
      <div className="hidden min-w-0 flex-1 items-center justify-end gap-3 font-mono text-[10px] tracking-wider text-mute md:flex">
        <Cell label="SPENT">{data ? usd(data.spentUsd, 2) : "--"}</Cell>
        <span className="h-3 w-px bg-line" />
        <Cell label="CREDIT">
          <span className={data && data.remainingUsd < 0 ? "text-lift" : "text-bone"}>
            {data ? usd(data.remainingUsd, 2) : "--"}
          </span>
        </Cell>
      </div>
    </footer>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span>{label}</span>
      <span className="text-dim tabular-nums">{children}</span>
    </span>
  );
}
