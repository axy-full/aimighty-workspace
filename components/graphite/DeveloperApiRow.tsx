"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { DeveloperProbe } from "@/lib/higgsfield-consumer/developer-api";

/**
 * Workspace › Engines: the connected account's developer API — the REST
 * gateway behind the CLI's setup-item and DTC flows. Verify asks it one free
 * read with the account's own grant and says plainly whether that grant is
 * accepted; nothing is trained, generated or spent.
 */
export function DeveloperApiRow() {
  const scoped = useScopedFetch();
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    scoped("/api/higgsfield/consumer/connection", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((json: { connected?: boolean; requiresReconnect?: boolean } | null) => {
      if (live) setConnected(json?.connected === true && json.requiresReconnect !== true);
    }).catch(() => { if (live) setConnected(false); });
    return () => { live = false; };
  }, [scoped]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const verify = async () => {
    setBusy(true); setResult(null);
    try {
      const response = await scoped("/api/higgsfield/consumer/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "developer-probe" }) });
      const json = await response.json().catch(() => null) as ({ probe?: DeveloperProbe; error?: string } | null);
      if (!response.ok || !json?.probe) { setResult(json?.error ?? "The developer API could not be checked."); return; }
      setResult(json.probe.reachable
        ? `Reachable with this account's grant${json.probe.balance != null ? ` · balance ${json.probe.balance.toLocaleString("en-US")}${json.probe.unit ? ` ${json.probe.unit}` : ""}` : ""}. Setup items and DTC ads can be built on it.`
        : json.probe.reason);
    } catch { setResult("The developer API could not be checked."); }
    finally { setBusy(false); }
  };
  return (
    <div className="gx-card" data-testid="engine-developer-api">
      <span className="gx-eyebrow">Connected account · developer API</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={connected === true}><span className="cw-engine-dot" aria-hidden="true" />{connected == null ? "Checking…" : connected ? "Same grant as the connected account" : "Connect the account first"}</span>
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" disabled={busy || connected !== true} onClick={() => void verify()} data-testid="developer-api-verify">{busy ? "Verifying…" : "Verify"}</button>
      </div>
      <p className="cw-foot" style={{ padding: 0 }}>The REST gateway the Higgsfield CLI uses for products, avatars, ad references, brand kits and the DTC Ads Engine. Verify is one free read; it never spends.</p>
      {result ? <p className="cw-notice" role="status" data-testid="developer-api-result">{result}</p> : null}
    </div>
  );
}
