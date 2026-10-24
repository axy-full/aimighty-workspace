"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * The crew's managed engine: whether it is reachable and priced. Verification proves the key without starting a round. No engine, vendor or
 * effort is named (Amendment (iii) §E, Crew included; owner, 24 Oct 2026): /api/crew/status sends neither.
 */
type Status = { connected: boolean; priced: boolean };
type Verified = { ok: boolean; listed: boolean; reason?: string };

const UNREACHABLE = "The crew’s engine could not be reached.";

export function XaiEngineRow() {
  const scoped = useScopedFetch();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    scoped("/api/crew/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((json) => { if (live) setStatus(json ?? { connected: false, priced: false }); }).catch(() => { if (live) setStatus({ connected: false, priced: false }); });
    return () => { live = false; };
  }, [scoped]);
  const verify = async () => {
    setBusy(true); setResult(null);
    try {
      const response = await scoped("/api/crew/status", { method: "POST" });
      const json = await response.json().catch(() => null) as Verified | null;
      setResult(!json ? UNREACHABLE : !json.ok ? json.reason ?? "The key was refused." : json.listed ? "Verified · available." : "The key works, but the crew’s engine isn’t offered on it. Contact Particl support.");
    } catch { setResult(UNREACHABLE); }
    finally { setBusy(false); }
  };
  return (
    <div className="gx-card" data-testid="engine-xai">
      <span className="gx-eyebrow">Crew engine</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={status?.connected ?? false}><span className="cw-engine-dot" aria-hidden="true" />
          {status == null ? "Checking…" : status.connected ? `Connected${status.priced ? "" : " · no price listed, rounds will not run"}` : "Temporarily unavailable"}
        </span>
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" disabled={busy || !status?.connected} onClick={() => void verify()}>{busy ? "Verifying…" : "Verify"}</button>
      </div>
      <p className="cw-foot" style={{ padding: 0 }}>Crew seats one agent per member, managed by Particl. Verify checks availability without starting a round.</p>
      {result ? <p className="cw-notice" role="status">{result}</p> : null}
    </div>
  );
}
