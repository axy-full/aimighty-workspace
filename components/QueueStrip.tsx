"use client";

import { useApi } from "@/lib/useApi";
import { useMoney } from "@/lib/price";
import { queueCounts, failureKind, failureCopy, inTraining, type TrainingRow } from "@/lib/jobState";
import { estimateVideo, estimateImage } from "@/lib/rateTable";
import { estimateTokens, costUsd } from "@/lib/models";
import type { Gen } from "@/components/GenCard";
import Link from "next/link";
import { useSession } from "@/lib/session";

/**
 * The queue strip (brief 1.5): what is rendering, queued, held and failed
 * on this wall, each job tappable with its credits and its shot, and where
 * the workspace stands against its concurrency limit. Nothing here that
 * the wall does not already know; it is the wall's live rows, read out.
 */
export default function QueueStrip({ gens, onOpen }: { gens: Gen[]; onOpen: (id: string) => void }) {
  const money = useMoney();
  const { signedIn, rates } = useSession();
  const counts = queueCounts(gens);
  /* LEGACY (four-suites PR F): these rows are the older LoRA identity trainer
     behind /api/identities. Cast & Elements now runs on the identity system
     (/api/soul/identities); this strip only reads what is still in flight so
     an accepted training is never orphaned. The live read is deliberately
     unsynced: it only asks our own rows what is in flight. */
  const { data: ids } = useApi<{ identities: TrainingRow[] }>(signedIn ? "/api/identities?live=1" : null, 15_000);
  const trainings = inTraining(ids?.identities ?? []);
  /* A training row carries whichever unit its workspace pays in — credits
     from the ledger, or the vendor's dollars for a workspace on its own keys.
     The browser no longer converts between them, because converting is what
     needed the margin to be here. */
  const priceOf = (t: { costUsd: number | null; creditsBilled?: number | null }) =>
    t.creditsBilled != null ? ` · ${money.price(t.creditsBilled)}`
      : t.costUsd != null ? ` · ${money.price(t.costUsd)}`
      : "";
  const live = counts.rendering + counts.queued + counts.held + counts.failed + trainings.length;
  const { data: lim } = useApi<{ limits: { concurrency: number }; standing: { running: number } }>(counts.rendering + counts.queued > 0 ? "/api/limits" : null, 10_000);
  if (!live) return null;
  const active = gens.filter((g) => ["running", "queued", "held", "failed", "cancelled"].includes(g.status)).slice(0, 12);
  const label = (g: Gen) => {
    const where = g.shotCode ? `${g.shotCode} v${g.version ?? 1}` : g.title || "unfiled";
    /* A render in flight has no ledger figure yet, so it is estimated — off
       the session's table, in this workspace's unit. It used to estimate in
       the vendor's dollars, which is what dragged those rates into the wall's
       own bundle. */
    const p = (g.params ?? {}) as Record<string, unknown>;
    const held = (p.held as { estUsd?: number } | undefined)?.estUsd;
    const amount = held != null && rates.unit === "usd" ? held
      : g.kind === "audio" ? null
      : g.kind === "image"
        ? estimateImage(rates, g.model, String(p.resolution ?? "1K"), Array.isArray(p.references) ? (p.references as unknown[]).length : 0)
        : estimateVideo(rates, g.model, String(p.resolution ?? "1080p"), Number(p.duration ?? 0),
            estimateTokens(String(p.resolution ?? "1080p"), String(p.ratio ?? "16:9"), Number(p.duration ?? 0), 0),
            costUsd, { audio: Boolean(p.generateAudio), task: p.task as string | undefined, fps60: Boolean(p.fps60), hasVideoInput: Boolean(p.hasVideoInput) });
    const price = amount == null ? "" : ` · ${money.price(amount)}`;
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
        {trainings.length > 0 && <span className="queue-n is-live">{trainings.length} training</span>}
        {lim && <span className="queue-n is-mute">{lim.standing.running} of {lim.limits.concurrency} slots</span>}
      </span>
      <span className="queue-jobs">
        {/* A training is the Studio's work, not the wall's: its chip opens the Studio. */}
        {trainings.map((t) => (
          <Link key={t.id} href="/studio" className="queue-job is-live" title="Training an identity — it joins the cast when it finishes">
            {`@${t.name}${priceOf(t)} · training`}
          </Link>
        ))}
        {active.map((g) => (
          <button key={g.id} type="button" className={`queue-job is-${g.status === "running" || g.status === "queued" ? "live" : g.status}`} onClick={() => onOpen(g.id)} title={g.error ?? undefined}>
            {label(g)}
          </button>
        ))}
      </span>
    </div>
  );
}
