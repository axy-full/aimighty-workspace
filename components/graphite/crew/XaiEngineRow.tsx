"use client";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Workspace › Engines › xAI · Grok (CREW_ADDENDUM.md › Key management).
 * Connect is the existing key form (the key is stored encrypted with the
 * workspace's other engine keys and never returned to the browser); Verify
 * lists the account's models and spends nothing.
 */
type Status = { connected: boolean; priced: boolean; model: string };
type Verified = { ok: boolean; listed: boolean; model: string; models: string[]; reason?: string };

export function XaiEngineRow() {
  const scoped = useScopedFetch();
  /* The key is stored by the owner-only keys route; anyone may Verify. */
  const owner = useSession().role === "owner";
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [key, setKey] = useState("");
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
      setResult(!json ? "xAI could not be reached." : !json.ok ? json.reason ?? "The key was refused." : json.listed ? `Verified · ${json.model} is available on this key (${json.models.length} models listed).` : `The key works, but ${json.model} is not in its model list. Check XAI_MODEL.`);
    } catch { setResult("xAI could not be reached."); }
    finally { setBusy(false); }
  };
  /* Sealed by the existing keys route (owner only); the value is never echoed back. */
  const connect = async () => {
    setBusy(true); setResult(null);
    try {
      const response = await scoped("/api/workspaces/keys", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "xai", value: key.trim() }) });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) { setResult(json?.error ?? "The key could not be saved."); return; }
      setKey(""); setEntering(false); setResult("Key saved. Press Verify to check it.");
      setStatus((await scoped("/api/crew/status", { cache: "no-store" }).then((r) => r.json()).catch(() => null)) ?? status);
    } catch { setResult("The key could not be saved."); }
    finally { setBusy(false); }
  };
  return (
    <div className="gx-card" data-testid="engine-xai">
      <span className="gx-eyebrow">xAI · Grok</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={status?.connected ?? false}><span className="cw-engine-dot" aria-hidden="true" />
          {status == null ? "Checking…" : status.connected ? `Connected · ${status.model}${status.priced ? "" : " · no price listed, rounds will not run"}` : "No key connected"}
        </span>
        <span className="gx-spacer" />
        {owner ? <button type="button" className="gx-hbtn" aria-expanded={entering} onClick={() => setEntering((v) => !v)}>{status?.connected ? "Replace key" : "Connect"}</button> : null}
        <button type="button" className="gx-hbtn" disabled={busy || !status?.connected} onClick={() => void verify()}>{busy ? "Verifying…" : "Verify"}</button>
      </div>
      {owner && entering ? (
        <div className="cw-engine-row">
          <input className="gx-field" type="password" autoComplete="off" spellCheck={false} aria-label="xAI API key" placeholder="xai-…" value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: "1 1 220px", width: "auto" }} />
          <button type="button" className="gx-hbtn" disabled={busy || key.trim().length < 8} onClick={() => void connect()}>Save key</button>
        </div>
      ) : null}
      <p className="cw-foot" style={{ padding: 0 }}>Crew seats one Grok agent per member. Verify lists models only; it costs nothing.{owner ? "" : " The key is the owner’s to change."}</p>
      {result ? <p className="cw-notice" role="status">{result}</p> : null}
    </div>
  );
}
