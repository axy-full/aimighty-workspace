"use client";
import { useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { DeveloperProbe } from "@/lib/higgsfield-consumer/developer-api";

/**
 * Workspace › Engines: the connected account's developer API. Verify asks it
 * one free read with the account's own grant and says plainly whether that
 * grant is accepted; nothing is trained, generated or spent. Nothing in
 * Particl builds on it yet, so it promises nothing beyond the answer.
 * `connected` is the account row's own reading (null while it reads), so a
 * disconnect above turns Verify off here at once.
 */
export function DeveloperApiRow({ connected }: { connected: boolean | null }) {
  const scoped = useScopedFetch();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const verify = async () => {
    setBusy(true); setResult(null);
    try {
      const response = await scoped("/api/higgsfield/consumer/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "developer-probe" }) });
      const json = await response.json().catch(() => null) as ({ probe?: DeveloperProbe; error?: string } | null);
      if (!response.ok || !json?.probe) { setResult(json?.error ?? "The developer API could not be checked."); return; }
      setResult(json.probe.reachable
        ? `Reachable with this account's grant${json.probe.balance != null ? ` · balance ${json.probe.balance.toLocaleString("en-US")}${json.probe.unit ? ` ${json.probe.unit}` : ""}` : ""}.`
        : json.probe.reason);
    } catch { setResult("The developer API could not be checked."); }
    finally { setBusy(false); }
  };
  return (
    <div className="gx-card" data-testid="engine-developer-api">
      <span className="gx-eyebrow">Connected account · developer API</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={connected === true}><span className="cw-engine-dot" aria-hidden="true" />{connected == null ? "Checking…" : connected ? "Same grant as the connected account" : "Connect the Higgsfield account above first"}</span>
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" disabled={busy || connected !== true} onClick={() => void verify()} data-testid="developer-api-verify">{busy ? "Verifying…" : "Verify"}</button>
      </div>
      <p className="cw-foot" style={{ padding: 0 }}>Verify is one free read; it never spends.</p>
      {result && connected ? <p className="cw-notice" role="status" data-testid="developer-api-result">{result}</p> : null}
    </div>
  );
}
