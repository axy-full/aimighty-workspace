"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { runway, runwayLine, type DaySpend } from "@/lib/runway";

/**
 * The workspace's runway (brief 2.2), wherever its balance is shown: the
 * pace it has actually run at over the last seven days, and how many days
 * the balance lasts at that pace. Given the daily series by a page that
 * already has it, or fetched for one that does not.
 */
export default function Runway({ byDay, className = "" }: { byDay?: DaySpend[]; className?: string }) {
  const { credits } = useSession();
  const { data } = useApi<{ byDay: DaySpend[] }>(credits && !byDay ? "/api/analytics?days=8" : null, 60_000);
  /* Read once when the line first shows: a runway is a figure, not a clock. */
  const [now] = useState(() => Date.now());
  const series = byDay ?? data?.byDay ?? [];
  if (!credits) return null;
  const line = runwayLine(runway(credits.balance, series, now), (n) => `${n.toLocaleString("en-US")} cr`);
  if (!line) return null;
  return <span className={`runway ${className}`}>{line}</span>;
}
