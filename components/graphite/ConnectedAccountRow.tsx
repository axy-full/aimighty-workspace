"use client";
import { useCallback, useEffect, useState } from "react";
import { consumerAuthorizeUrl, connectionOutcome } from "@/lib/shell/workspace-view";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Workspace › Engines: the owner's Higgsfield account — the grant Cast, Business,
 * Viral and Gen's catalogue run on, and the one every "Connect the account in
 * Workspace › Engines" points at. The existing routes do the work: POST
 * /api/higgsfield/consumer/connect returns the account's own sign-in page, its
 * callback returns here with `?higgsfield=<outcome>`, and DELETE on
 * /api/higgsfield/consumer/connection lets go of the grant. Connecting starts
 * no paid job.
 */
type Connection = { connected: boolean; requiresReconnect: boolean };

export function ConnectedAccountRow() {
  const scoped = useScopedFetch();
  const [status, setStatus] = useState<Connection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  /* The callback's outcome, read as the tab opens. The shell's first URL write
     (lib/workspace/state.tsx › writeUrl) keeps only its own params, so a reload
     does not repeat it. */
  const [outcome] = useState(() => {
    try { return connectionOutcome(new URLSearchParams(window.location.search).get("higgsfield")); } catch { return null; }
  });
  const read = useCallback(async () => {
    try {
      const response = await scoped("/api/higgsfield/consumer/connection", { cache: "no-store" });
      const json = await response.json().catch(() => null) as (Connection & { error?: string }) | null;
      if (!response.ok || !json) throw new Error(json?.error ?? "The connection could not be read.");
      setStatus({ connected: json.connected === true, requiresReconnect: json.requiresReconnect === true });
    } catch (caught) { setProblem(caught instanceof Error ? caught.message : "The connection could not be read."); }
  }, [scoped]);
  useEffect(() => { const t = setTimeout(() => void read(), 0); return () => clearTimeout(t); }, [read]);
  const connect = async () => {
    setBusy("connect"); setProblem(null);
    try {
      const response = await scoped("/api/higgsfield/consumer/connect", { method: "POST" });
      const json = await response.json().catch(() => null) as { url?: string; error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The account could not be reached.");
      const url = consumerAuthorizeUrl(json?.url);
      if (!url) throw new Error("The account returned a sign-in address this page will not open.");
      window.location.assign(url);
    } catch (caught) { setProblem(caught instanceof Error ? caught.message : "The account could not be reached."); setBusy(null); }
  };
  const disconnect = async () => {
    setBusy("disconnect"); setProblem(null);
    try {
      const response = await scoped("/api/higgsfield/consumer/connection", { method: "DELETE" });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The account could not be disconnected.");
      await read();
    } catch (caught) { setProblem(caught instanceof Error ? caught.message : "The account could not be disconnected."); }
    finally { setBusy(null); }
  };
  const live = status?.connected && !status.requiresReconnect;
  return (
    <div className="gx-card" data-testid="engine-connected-account">
      <span className="gx-eyebrow">Higgsfield account</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={Boolean(live)}><span className="cw-engine-dot" aria-hidden="true" />
          {status == null ? (problem ? "Not read" : "Checking…") : live ? "Connected" : status.requiresReconnect ? "Reconnect to restore access" : "Not connected"}
        </span>
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" disabled={busy != null || status == null} onClick={() => void connect()} data-testid="connected-account-connect">
          {busy === "connect" ? "Opening sign-in…" : status?.connected || status?.requiresReconnect ? "Reconnect" : "Connect"}
        </button>
        {status?.connected || status?.requiresReconnect ? (
          <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void disconnect()} data-testid="connected-account-disconnect">{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>
        ) : null}
      </div>
      <p className="cw-foot" style={{ padding: 0 }}>Cast, Business, Viral and Gen’s catalogue run on it. You approve its permissions on the account’s own page; connecting spends nothing.</p>
      {outcome ? <p className={outcome.ok ? "cw-notice" : "gx-gen-error"} role={outcome.ok ? "status" : "alert"} data-testid="connected-account-outcome">{outcome.line}</p> : null}
      {problem ? <p className="gx-gen-error" role="alert">{problem}{status == null ? <> <button type="button" className="gx-hbtn" style={{ display: "inline-flex" }} onClick={() => { setProblem(null); void read(); }}>Retry</button></> : null}</p> : null}
    </div>
  );
}
