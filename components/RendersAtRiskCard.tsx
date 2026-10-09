"use client";

import { useApi } from "@/lib/useApi";
import { ageText, atRiskLine, type AtRiskDesk } from "@/lib/rendersAtRiskText";

/**
 * The platform owner's desk: paid renders with no stored copy an hour on
 * (lib/rendersAtRisk.ts). One line, the count and the oldest, then the list.
 * The cron keeps trying to save each one; the owner is emailed once per new
 * render and daily while any remain. Only the platform owner can read the route.
 */
export function RendersAtRiskCard() {
  const { data, error, refresh } = useApi<AtRiskDesk>("/api/admin/renders-at-risk", 60_000);
  return (
    <section className="scard" data-testid="renders-at-risk-card">
      <div className="scard-h">
        <span>Renders at risk</span>
        <span>Paid renders with no copy in our storage an hour after they finished. They play only from the provider&rsquo;s expiring link until a save sticks.</span>
      </div>
      {!data && error ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="rail-help !text-[12px]">Renders at risk could not be read.</span>
          <button type="button" className="btn-secondary min-h-[44px]" onClick={() => void refresh()}>Try again</button>
        </div>
      ) : !data ? (
        <span className="rail-help !text-[12px]">Reading renders at risk…</span>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className={`font-medium ${data.count ? "text-lift" : ""}`} data-testid="renders-at-risk-line">{atRiskLine(data, data.at)}</span>
          {data.renders.map((r) => (
            <span key={`${r.workspaceId}:${r.generationId}`} className="rail-help !text-[12px] break-all">
              {r.workspace} · {r.generationId} · {r.provider} {r.model} · {ageText(data.at - r.since)}
              {r.billed ? "" : " · provider finished, not billed yet"}
              {r.lastError ? ` · last save error: ${r.lastError}` : ""}
            </span>
          ))}
          {data.count > data.renders.length && <span className="rail-help !text-[12px]">…and {data.count - data.renders.length} more.</span>}
        </div>
      )}
    </section>
  );
}
