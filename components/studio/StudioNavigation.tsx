"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clapperboard, ScanLine, Building2 } from "lucide-react";
import { Mark } from "@/components/ui/Mark";
import WorkspaceMenu, { type WorkbenchAccount } from "@/components/workbench/WorkspaceMenu";
import { clearPrivateLocal } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import "./studio-navigation.css";

type Section = "studio" | "gen" | "workspace";
const SECTIONS = [
  { id: "studio", label: "Studio", href: "/workbench", icon: Clapperboard },
  { id: "gen", label: "Gen", href: "/generate", icon: ScanLine },
  { id: "workspace", label: "Workspace", href: "/settings", icon: Building2 },
] as const;

function sectionFor(path: string): Section {
  if (path === "/generate" || path.startsWith("/make/")) return "gen";
  return /^\/(settings|team|billing|usage|statements)(\/|$)/.test(path) ? "workspace" : "studio";
}

async function changeAccount(scopedFetch: ReturnType<typeof useScopedFetch>, action: "switch" | "logout", id?: string) {
  await withPageLeaveGuard(async () => {
  const response = await scopedFetch(action === "switch" ? "/api/workspaces/switch" : "/api/auth/logout", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action === "switch" ? { id } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Your account could not be changed. Please try again.");
  }
  clearPrivateLocal();
  window.location.assign(action === "switch" ? "/workbench" : "/login");
  });
}

export default function StudioNavigation({ initialAccount, active, compact = false, onNavigate, onSwitch, onSignOut, requestScope, children }: {
  initialAccount: WorkbenchAccount | null;
  children?: ReactNode;
  active?: Section;
  compact?: boolean;
  onNavigate?: (path: string) => Promise<void>;
  onSwitch?: (id: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
  requestScope?: string | null;
}) {
  const scopedFetch = useScopedFetch(requestScope);
  const path = usePathname();
  const router = useRouter();
  const current = active ?? sectionFor(path);
  const [error, setError] = useState("");
  const navigate = onNavigate ?? (async (href: string) => { await withPageLeaveGuard(() => { router.push(href); }); });
  function follow(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setError("");
    void onNavigate(href).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not open this section."));
  }
  return (
    <div className={`studio-navigation${compact ? " studio-navigation-compact" : ""}`}>
      {!compact && <Link className="studio-navigation-brand" href="/workbench" aria-label="Particl home" onClick={e => follow(e, "/workbench")}>
        <Mark width={30} height={22} />
        <Image src="/brand/particl-wordmark-on-dark@4x.png" alt="particl" width={103} height={31} priority />
      </Link>}
      <nav className="studio-sections" aria-label="Studio sections">
        {SECTIONS.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={current === id ? "page" : undefined} onClick={e => follow(e, href)}>
          <Icon size={15} strokeWidth={1.6} /><span>{label}</span>
        </Link>)}
      </nav>
      {children}
      <WorkspaceMenu initial={initialAccount} onNavigate={navigate} onSwitch={onSwitch ?? (id => changeAccount(scopedFetch, "switch", id))} onSignOut={onSignOut ?? (() => changeAccount(scopedFetch, "logout"))} />
      {error && <p className="studio-navigation-error" role="alert">{error}</p>}
    </div>
  );
}

export function StudioDock() {
  const current = sectionFor(usePathname());
  return <nav className="studio-section-dock" aria-label="Studio sections">
    {SECTIONS.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={current === id ? "page" : undefined}><Icon size={21} strokeWidth={1.6} /><span>{label}</span></Link>)}
  </nav>;
}
