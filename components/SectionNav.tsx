"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Usage and Production are two questions about the same ledger — "how much
 * credit is left" and "how is the work going" — so they read as two views of
 * one section rather than two unrelated tabs competing for the nav pill.
 */
const VIEWS = [
  { href: "/usage", label: "Usage" },
  { href: "/dashboard", label: "Production" },
];

export default function SectionNav() {
  const path = usePathname();
  return (
    <div className="inline-flex rounded-[10px] bg-chip p-[3px]">
      {VIEWS.map((v) => {
        const active = path === v.href;
        return (
          <Link key={v.href} href={v.href}
            className={`rounded-[8px] px-3.5 py-1.5 text-[14px] font-medium transition-colors ${
              active ? "bg-panel text-ink shadow-[var(--shadow-card)]" : "text-dim"
            }`}>
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}
