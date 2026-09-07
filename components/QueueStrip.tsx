"use client";

import { useApi } from "@/lib/useApi";
import { useMoney } from "@/lib/price";
import { queueCounts, estimateForRow, failureKind, failureCopy } from "@/lib/jobState";
import type { Gen } from "@/components/GenCard";

/**
 * The queue strip (brief 1.5): what is rendering, queued, held and failed
 * on this wall, each job tappable with its credits and its shot, and where
 * the workspace stands against its concurrency limit. Nothing here that
 * the wall does not already know; it is the wall's live rows, read out.
 */
export default function QueueStrip({ gens, onOpen }: { gens: Gen[]; onOpen: (id: string) => void }) {
  const money = useMoney();
  const counts = queueCounts(gens);
  const live = counts.rendering + counts.queued + counts.held + counts.failed;
  const { data: lim } = useApi<{ limits: { concurrency: number }; standing: { running: number } }>(counts.rendering + counts.queued > 0 ? "/api/limits" : null, 10_000);
  if (!live) return null;
  const active = gens.filter((g) => ["running", "queued", "held", "failed", "cancelled"].includes(g.status)).slice(0, 12);
  const label = (g: Gen) => {
    const where = g.shotCode ? `${g.shotCode} v${g.version ?? 1}` : g.title || "unfiled";
    const usd = estimateForRow(g);
    const price = usd == null ? "" : ` · ${money.price(usd, g.model)}`;
    const state = g.status === "running" || g.status === "queued" ? "rendering"
      : g.status === "held" ? ((g.params as { held?: { why?: string } }).held?.why === "slots" ? "queued" : "held")
      : failureCopy(failureKind(g.error, g.params)).why.replace(/\.$/, "").toLowerCase();
    return `${where}${price} · ${state}`;
  };
  return (
    <div className="queue-strip" role="status" aria-label="Queue">
      <span className="queue-counts">
        {counts.rendering > 0 && <span className="queue-n is-live">{counts.rendering} rendering</span>}
        {counts.queued > 0 && <span className="queue-n">{counts.queued} queued</span>}
        {counts.held > 0 && <span className="queue-n is-held">{counts.held} held</span>}
        {counts.failed > 0 && <span className="queue-n is-failed">{counts.failed} failed</span>}
        {lim && <span className="queue-n is-mute">{lim.standing.running} of {lim.limits.concurrency} slots</span>}
      </span>
      <span className="queue-jobs">
        {active.map((g) => (
          <button key={g.id} type="button" className={`queue-job is-${g.status === "running" || g.status === "queued" ? "live" : g.status}`} onClick={() => onOpen(g.id)} title={g.error ?? undefined}>
            {label(g)}
          </button>
        ))}
      </span>
    </div>
  );
}
