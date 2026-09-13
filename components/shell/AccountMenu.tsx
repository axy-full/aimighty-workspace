"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSession, useSignInHref, clearPrivateLocal } from "@/lib/session";
import { creditsNumber } from "@/lib/price";
import { useApi } from "@/lib/useApi";
import Mono from "@/components/ui/Mono";

/**
 * The account menu (design/particl-v2/README.md §4; board 4a): a 32px
 * avatar — `--card`, 1px `--border-mid`, the initials in mono; inverted to
 * ink on ground while the menu is open — and beneath it, at `right 20px,
 * top 60px`, a 220px `--card` panel with a 1px `--border-mid` edge, radius
 * 12 and 6px of padding: the name (Outfit 500 14px) over `ROLE · WORKSPACE`
 * in mono; a hairline; Usage with this month's credits (`612 CR · SEPT`),
 * Settings with `⌘,`, Switch workspace ▸; a hairline; Sign out. Rows are
 * `10px 12px`, radius 8, Outfit 500 13.5px `--ink-body`; the row of the
 * screen you are on is filled `--selected` in ink; hovered rows fill .08.
 *
 * Usage and Settings live here and nowhere else in the shell (§1).
 */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEPT", "OCT", "NOV", "DEC"];

type UsageMonths = { months?: { month: string; credits: number }[] };

export default function AccountMenu() {
  const { signedIn, name, role, workspace, workspaces, superAdmin } = useSession();
  const signIn = useSignInHref();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: usage } = useApi<UsageMonths>(open && signedIn ? "/api/usage" : null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key); };
  }, [open]);

  if (!signedIn) {
    return (
      <Link href={signIn} className="flex h-[36px] items-center rounded-pill border border-border-mid px-[12px] text-[13px] font-medium leading-none text-ink">
        Sign in
      </Link>
    );
  }

  const initials = (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const spent = usage?.months?.find((m) => m.month === thisMonth)?.credits ?? 0;
  const monthWord = MONTHS[now.getUTCMonth()];

  const row = (on: boolean) =>
    `flex items-center justify-between rounded-ctl px-[12px] py-[10px] text-[13.5px] font-medium leading-none ${
      on ? "bg-selected text-ink" : "text-ink-body hover:bg-[rgba(245,246,248,.08)]"}`;

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearPrivateLocal();
    router.push("/login");
    router.refresh();
  };
  const switchTo = async (id: string) => {
    if (id === workspace?.id) { setOpen(false); return; }
    const r = await fetch("/api/workspaces/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    if (r.ok) { clearPrivateLocal(); setOpen(false); router.push("/"); router.refresh(); }
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setOpen((o) => !o); setSwitching(false); }} aria-haspopup="menu" aria-expanded={open} aria-label="Account"
        className={`flex h-[32px] w-[32px] items-center justify-center rounded-full ${
          open ? "bg-ink text-ground" : "border border-border-mid bg-card text-ink"}`}>
        <span className="ui-mono">{initials}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[44px] z-[5] flex w-[220px] flex-col rounded-card border border-border-mid bg-card p-[6px]">
          {switching ? (
            <>
              <button type="button" onClick={() => setSwitching(false)} className={row(false)}>
                <span className="flex items-center gap-[8px]"><span className="ui-mono tracking-normal text-ink-muted">◂</span>Workspaces</span>
              </button>
              <span className="my-[4px] h-px bg-border" />
              {workspaces.map((w) => (
                <button key={w.id} type="button" role="menuitem" onClick={() => switchTo(w.id)} className={row(w.id === workspace?.id)}>
                  {w.name}<Mono cost>{w.role}</Mono>
                </button>
              ))}
            </>
          ) : (
            <>
              <span className="flex flex-col gap-[3px] px-[12px] pb-[8px] pt-[10px]">
                <span className="text-[14px] font-medium leading-none text-ink">{name}</span>
                <Mono>{role ?? "member"} · {workspace?.name ?? "—"}</Mono>
              </span>
              <span className="my-[4px] h-px bg-border" />
              <Link href="/usage" role="menuitem" onClick={() => setOpen(false)} className={row(path.startsWith("/usage"))}>
                Usage<Mono cost>{creditsNumber(spent)} cr · {monthWord}</Mono>
              </Link>
              <Link href="/settings" role="menuitem" onClick={() => setOpen(false)} className={row(path.startsWith("/settings") || path.startsWith("/team"))}>
                Settings<Mono cost>⌘,</Mono>
              </Link>
              {/* The platform's desk (SOW surfaces board 12h): only its owner has one. */}
              {superAdmin && (
                <Link href="/admin" role="menuitem" onClick={() => setOpen(false)} className={row(path.startsWith("/admin"))}>
                  Platform
                </Link>
              )}
              <button type="button" role="menuitem" onClick={() => setSwitching(true)} className={row(false)}>
                Switch workspace<span className="ui-mono tracking-normal text-ink-muted">▸</span>
              </button>
              <span className="my-[4px] h-px bg-border" />
              <button type="button" role="menuitem" onClick={signOut} className={row(false)}>Sign out</button>
            </>
          )}
        </div>
      )}
      {/* `⌘,` opens Settings from anywhere (§4). */}
      <SettingsShortcut go={() => router.push("/settings")} />
    </div>
  );
}

function SettingsShortcut({ go }: { go: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "," ) { e.preventDefault(); go(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go]);
  return null;
}
