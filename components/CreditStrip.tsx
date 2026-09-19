"use client";

import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";

/**
 * A vendor's credit, on the page that spends it. Reads the same cheap
 * summary the title bar polls, so it costs nothing extra; tapping it opens
 * the full ledger on Usage.
 */
type Vendor = {
  id: string; label: string; spent: number; added: number; remaining: number;
  unit: "usd" | "credits"; remainingCredits?: number; addedCredits?: number; spentCredits?: number;
};
type Summary = { vendors?: Vendor[] };

const SHORT: Record<string, string> = {
  byteplus: "Video account", google: "Image account", fal: "Render account", elevenlabs: "Audio account",
};

export default function CreditStrip({ vendor, className = "" }: { vendor: string; className?: string }) {
  const { data } = useApi<Summary>("/api/usage/summary", 20000);
  const v = data?.vendors?.find((x) => x.id === vendor);
  if (!v) return null;
  const credits = v.unit === "credits";
  const left = credits ? (v.remainingCredits ?? 0) : v.remaining;
  const added = credits ? (v.addedCredits ?? 0) : v.added;
  const spent = credits ? (v.spentCredits ?? 0) : v.spent;
  const fmt = (n: number) => (credits ? `${Math.round(n).toLocaleString()} cr` : usd(n, 2));
  const empty = added === 0 && spent === 0;
  const over = left < 0;
  return (
    <Link href="/usage" className={`credit-strip ${over ? "is-over" : ""} ${className}`}
      title={`${SHORT[vendor] ?? v.label}: ${fmt(added)} added, ${fmt(spent)} spent. Tap for the ledger.`}>
      <span className="credit-strip-label">{SHORT[vendor] ?? v.label}</span>
      <b>{empty ? "—" : `${fmt(left)} left`}</b>
      <span className="credit-strip-sub">{empty ? "nothing recorded" : `${fmt(spent)} of ${fmt(added)} spent`}</span>
    </Link>
  );
}
