"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { creditsNumber, useMoney } from "@/lib/price";
import { usd } from "@/lib/format";
import { Lockup } from "@/components/ui/Mark";
import AtomikButton from "./AtomikButton";
import AccountMenu from "./AccountMenu";

/**
 * The shell header (design/particl-v2/README.md §3, §4; board 4a): 56px,
 * `0 20px`, items 22px apart, a .08 hairline beneath. The lockup; the four
 * nav items — Outfit 500 14px `--ink-body`, `0 12px`, the current one in
 * ink with `inset 0 -2px 0 ink`; then, from the right: the balance in mono
 * (`BALANCE 1,240 CR`, the figure in ink), the Atomik button, the avatar.
 * On a phone (9c): `0 16px`, 10px apart, the smaller lockup, and the nav
 * goes to the dock (§14).
 *
 * The balance is the workspace's credit balance from the session, refreshed
 * from /api/usage/summary so a render that just billed shows here without
 * a reload. A workspace still billed in dollars (the studio's own, at cost)
 * shows what it has left in dollars — the same readout, its own unit.
 */
type Summary = { credits?: { balance: number } | null; remainingUsd?: number };

export default function Header() {
  const path = usePathname();
  const { signedIn, credits } = useSession();
  const { current } = useProject();
  const { inCredits } = useMoney();
  const { data: summary } = useApi<Summary>(signedIn ? "/api/usage/summary" : null, 30_000);
  const creditBalance = summary?.credits?.balance ?? credits?.balance ?? null;
  const balance = !signedIn ? null
    : inCredits && creditBalance !== null ? `${creditsNumber(creditBalance)} cr`
    : summary?.remainingUsd !== undefined ? usd(summary.remainingUsd, 2)
    : null;

  return (
    <header className="relative flex h-[56px] flex-none items-center gap-[22px] border-b border-border bg-ground px-[20px] text-ink max-md:gap-[10px] max-md:px-[16px]">
      <Link href="/" aria-label="particl" className="max-md:hidden"><Lockup /></Link>
      <Link href="/" aria-label="particl" className="md:hidden"><Lockup mobile /></Link>
      <nav aria-label="Sections" className="flex h-[56px] items-center gap-[2px] max-md:hidden">
        {NAV.map((item) => {
          const on = item.match(path);
          return (
            <Link key={item.label} href={item.href({ production: current?.id ?? null })} aria-current={on ? "page" : undefined}
              className={`flex h-[56px] items-center px-[12px] text-[14px] font-medium leading-none ${
                on ? "text-ink shadow-[inset_0_-2px_0_var(--ink)]" : "text-ink-body"}`}>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <span className="ml-auto flex items-center gap-[12px]">
        {balance !== null && (
          <span className="ui-mono text-ink-muted">Balance <span className="text-ink">{balance}</span></span>
        )}
        <span className="max-md:hidden"><AtomikButton /></span>
        <AccountMenu />
      </span>
    </header>
  );
}
