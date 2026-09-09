"use client";

import { useApi } from "@/lib/useApi";
import { fmtCredits } from "@/lib/price";
import { Waiting, Trouble, Empty } from "@/components/ParticlMark";
import {
  frameLine, durationLine, seedLine, producedBy, repeatNote, canRepeatExactly, NOT_RECORDED,
} from "@/lib/provenanceCard";
import type { Provenance } from "@/lib/provenance";

type Take = {
  id: string; shotId: string | null; shotCode: string; shotTitle: string;
  version: number; model: string; state: string; by: string; at: number; kind: string;
};

/**
 * Exactly what produced a finished take (brief 3, surface 1c).
 *
 * The card's one promise is "make another from exactly this", and that makes
 * exactness its only real requirement. So where something was not recorded it
 * says so, in the same weight as everything else: a take made before this
 * record existed has no seed and no rule ids, and dressing that up as zero or
 * none would make the promise a lie in the one place it must not be.
 */
export default function ProvenanceCard({ takeId }: { takeId: string }) {
  const { data, error } = useApi<{ take: Take; provenance: Provenance | null }>(
    `/api/rig/provenance/${encodeURIComponent(takeId)}`);

  if (error) return <Trouble label="This take didn't load" />;
  if (!data) return <Waiting />;

  const { take } = data;
  const rec = data.provenance?.recorded ?? null;
  const rows = producedBy(rec);
  const setup = rec ? Object.entries(rec.setup).filter(([, v]) => v) : [];
  const frame = rec ? frameLine(rec.conditions) : null;

  return (
    <div className="prv">
      <header className="prv-head">
        <span className="prv-title">
          {take.shotCode ? `${take.shotCode} v${take.version}` : `v${take.version}`}
        </span>
        <span className="prv-meta">
          {[take.state ? take.state.toUpperCase() : "DRAFT", stamp(take.at)].filter(Boolean).join(" · ")}
        </span>
      </header>

      <div className="prv-body">
        <div className="prv-frame">
          <span className="prv-frame-chip">{take.shotCode || "UNFILED"}{take.shotTitle ? ` · ${take.shotTitle}` : ""}</span>
        </div>

        {!rec ? (
          <Empty
            compact
            title="Nothing was recorded for this take"
            line="It was made before the record existed. What produced it is not knowable now, and guessing would be worse than saying so."
          />
        ) : null}

        {rec ? (
          <>
            <span className="prv-label">PRODUCED BY</span>
            <div className="prv-rows">
              {rows.map((r, i) => (
                <div key={`${r.kind}:${i}`} className="prv-row">
                  <span className={`prv-icon${r.visual ? " is-visual" : ""}`} />
                  <span className="prv-kind">{r.kind}</span>
                  <span className="prv-value">{r.value}</span>
                  {r.meta ? <span className="prv-vmeta">{r.meta}</span> : null}
                </div>
              ))}
              {rec.ports.length ? (
                <div className="prv-row">
                  <span className="prv-icon" />
                  <span className="prv-kind">PORTS</span>
                  <span className="prv-value">{rec.ports.length} bound</span>
                </div>
              ) : null}
            </div>

            {setup.length ? (
              <>
                <span className="prv-label">SETUP · {setup.length} VALUE{setup.length === 1 ? "" : "S"} CARRIED IN</span>
                <div className="prv-chips">
                  {setup.map(([k, v]) => <span key={k} className="prv-chip">{v}</span>)}
                </div>
              </>
            ) : null}

            <span className="prv-label">EXACT CONDITIONS</span>
            <div className="prv-facts">
              <span><i>Frame</i>{frame?.file ?? NOT_RECORDED}</span>
              {frame?.billed ? <span><i>Metered at</i>{frame.billed}</span> : null}
              <span><i>Duration</i>{durationLine(rec.conditions.durationSeconds)}</span>
              <span><i>Seed</i>{seedLine(rec.conditions.seed)}</span>
              <span><i>Engine</i>{rec.model}</span>
              <span><i>Made by</i>{rec.by} · {stamp(rec.at)}</span>
            </div>
          </>
        ) : null}
      </div>

      <div className="prv-foot">
        <button className="prv-primary" disabled={!rec}>
          <span>Make another from {canRepeatExactly(rec) ? "exactly this" : "this"}</span>
          <span className="prv-primary-cost">{fmtCredits(0)}</span>
        </button>
        <span className="prv-note">{repeatNote(rec)}</span>
      </div>
    </div>
  );
}

function stamp(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return ""; }
}
