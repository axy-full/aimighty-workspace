"use client";
import { useState } from "react";
import type { FailedSaves as Read } from "@/lib/platformFailedSaves";
import { timeAgo } from "@/lib/format";
import { LOST_LABEL } from "@/lib/atRiskWindow";
import { useToast } from "../ui";
import { adminSend, useAdminRead } from "./api";
import { Head } from "./parts";

const HOUR = 3_600_000;
/** More than an hour since it finished: the heartbeat has had its tries. */
const overAnHour = (since: number): boolean => Date.now() - since > HOUR;

/** Failed saves: renders that finished at the engine but have no stored copy, across every workspace, with Retry save for each. */
export function FailedSaves({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { data, refresh } = useAdminRead<Read>("/api/admin/console/failed-saves", 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  async function retry(workspaceId: string, id: string) {
    setBusy(id);
    const sent = await adminSend<{ saved: boolean }>("/api/admin/console/failed-saves", "POST", { workspaceId, id });
    setBusy(null);
    toast({ text: !sent.ok ? sent.error : sent.json.saved ? "Saved" : "Not saved yet · it will be tried again" });
    refresh(); onChanged();
  }
  return (
    <>
      <Head title="Failed saves" line="Renders that finished but have no stored copy. The heartbeat tries again every few minutes for three days; after that they are listed as lost. Retry save tries now." />
      <div className="v12-pc-table" role="table" aria-label="Failed saves" data-testid="pc-risk">
        <div className="v12-pc-tr v12-pc-th v12-pc-riskcols" role="row">
          <span role="columnheader">Workspace</span><span role="columnheader">Take</span><span role="columnheader">Engine</span><span role="columnheader">Since</span><span role="columnheader">State</span><span role="columnheader">Last error</span><span role="columnheader" aria-label="Retry" />
        </div>
        {(data?.items ?? []).map((r) => (
          <div key={`${r.workspaceId}:${r.id}`} className="v12-pc-tr v12-pc-riskcols" role="row" data-testid="pc-risk-row">
            <span role="cell" className="v12-pc-strong v12-pc-clip">{r.workspaceName}</span>
            <span role="cell" className="v12-pc-mono v12-pc-meta" title={r.id}>{r.id.slice(-8)}</span>
            <span role="cell" className="v12-pc-clip">{r.engine}</span>
            <span role="cell" className="v12-pc-mono" data-tone={r.lost ? undefined : overAnHour(r.since) ? "bad" : undefined}>{timeAgo(r.since)}</span>
            <span role="cell" className="v12-pc-clip" title={r.lost ? LOST_LABEL : "at risk"} data-testid="pc-risk-state">{r.lost ? LOST_LABEL : "at risk"}</span>
            <span role="cell" className="v12-pc-clip v12-pc-meta">{r.lastError ?? "—"}</span>
            <span role="cell" className="v12-pc-end"><button type="button" className="v12-pc-btn" disabled={busy === r.id} onClick={() => void retry(r.workspaceId, r.id)} data-testid="pc-risk-retry">Retry save</button></span>
          </div>
        ))}
        {data && !data.items.length ? <div className="v12-pc-empty" data-testid="pc-risk-empty">Nothing at risk.</div> : null}
      </div>
      {data && data.unreadable > 0 ? <p className="v12-pc-note">{data.unreadable} workspace{data.unreadable === 1 ? "" : "s"} could not be read just now.</p> : null}
    </>
  );
}
