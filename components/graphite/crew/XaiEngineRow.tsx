"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";

/** Managed Grok availability. Verification reads model names without starting a round. */
type Status = { connected: boolean; priced: boolean; model: string };
type Verified = { ok: boolean; listed: boolean; model: string; models: string[]; reason?: string };

export function XaiEngineRow() {
  const scoped = useScopedFetch();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    scoped("/api/crew/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((json) => { if (live) setStatus(json ?? { connected: false, priced: false, model: "" }); }).catch(() => { if (live) setStatus({ connected: false, priced: false, model: "" }); });
    return () => { live = false; };
  }, [scoped]);
  const verify = async () => {
    setBusy(true); setResult(null);
    try {
      const response = await scoped("/api/crew/status", { method: "POST" });
      const json = await response.json().catch(() => null) as Verified | null;
      setResult(!json ? "xAI could not be reached." : !json.ok ? json.reason ?? "The key was refused." : json.listed ? `Verified · ${json.model} is available (${json.models.length} models listed).` : `The key works, but ${json.model} is not in its model list. Contact Particl support.`);
    } catch { setResult("xAI could not be reached."); }
    finally { setBusy(false); }
  };
  return (
    <div className="gx-card" data-testid="engine-xai">
      <span className="gx-eyebrow">xAI · Grok</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={status?.connected ?? false}><span className="cw-engine-dot" aria-hidden="true" />
          {status == null ? "Checking…" : status.connected ? `Connected · ${status.model}${status.priced ? "" : " · no price listed, rounds will not run"}` : "Temporarily unavailable"}
        </span>
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" disabled={busy || !status?.connected} onClick={() => void verify()}>{busy ? "Verifying…" : "Verify"}</button>
      </div>
      <p className="cw-foot" style={{ padding: 0 }}>Crew seats one Grok agent per member, managed by Particl. Verify checks availability without starting a round.</p>
      {result ? <p className="cw-notice" role="status">{result}</p> : null}
    </div>
  );
}
