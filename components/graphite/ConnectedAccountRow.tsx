"use client";
import { useCallback, useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Workspace › Engines › Connected account: the one place in Suites that
 * connects, reconnects and disconnects the account every connected surface
 * points at, and shows which of the owner's jobs hold the workspace's four
 * connected-account slots. Connecting spends nothing; a slot is set aside in
 * the ledger only (nothing is sent, deleted or resubmitted).
 */
type CapacityJob = { id: string; draftId: string; projectName: string | null; workflow: string; status: string; createdAt: number; releasable: boolean };
type Capacity = { limit: number; active: number; mine: CapacityJob[] };
type Connection = { connected: boolean; requiresReconnect: boolean; capacity?: Capacity | null };
const WORKFLOW: Record<string, string> = {
  "marketing-video": "Marketing video", generation: "Generate", genjutsu: "Transform", "marketing-template": "Ad template", "voice-tool": "Voice tool", shorts: "Shorts",
};
const STATUS: Record<string, string> = { dispatching: "sending", accepted: "running", uncertain: "unconfirmed" };
const OUTCOME_PARAM = "higgsfield";
const since = (ms: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};

export function ConnectedAccountRow({ owner }: { owner: boolean }) {
  const scoped = useScopedFetch();
  const [state, setState] = useState<Connection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"connect" | "disconnect" | null>(null);
  const read = useCallback(async () => {
    try {
      const response = await scoped("/api/higgsfield/consumer/connection", { cache: "no-store" });
      const json = await response.json().catch(() => null) as (Connection & { error?: string }) | null;
      if (!response.ok || !json) throw new Error(json?.error ?? "The connection could not be read.");
      setState(json); setProblem(null);
    } catch (error) { setProblem(error instanceof Error ? error.message : "The connection could not be read."); }
  }, [scoped]);
  useEffect(() => {
    if (!owner) return;
    const t = setTimeout(() => void read(), 0);
    return () => clearTimeout(t);
  }, [read, owner]);
  /* The sign-in callback lands here with its outcome in the fragment (the
     shell keeps the fragment when it rewrites the query). It is read and
     removed in the same tick, so a remounted effect cannot lose it. */
  useEffect(() => {
    const t = setTimeout(() => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const outcome = fragment.get(OUTCOME_PARAM);
      if (!outcome) return;
      fragment.delete(OUTCOME_PARAM);
      const rest = fragment.toString();
      window.history.replaceState(null, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
      setNote(outcome === "connected" ? "Account connected." : "The connection was not completed. Sign in to the same Particl workspace and try again.");
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const mine = state?.capacity?.mine ?? [];
  const running = mine.length;
  const act = async (kind: "connect" | "disconnect") => {
    // Jobs already running are collected under the grant they started on:
    // say so once before a sign-in or disconnect that could replace it.
    if (running && confirm !== kind) { setConfirm(kind); return; }
    setConfirm(null); setBusy(kind); setNote(null); setProblem(null);
    try {
      const response = await scoped(`/api/higgsfield/consumer/${kind === "connect" ? "connect" : "connection"}`, { method: kind === "connect" ? "POST" : "DELETE" });
      const json = await response.json().catch(() => null) as { url?: string; error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The connection could not be changed.");
      if (kind === "connect") {
        const url = new URL(String(json?.url));
        if (url.origin !== "https://clerk.higgsfield.ai" || url.pathname !== "/oauth/authorize" || url.username || url.password) throw new Error("The account returned an unexpected sign-in address.");
        window.location.assign(url.href);
        return;
      }
      setNote("Account disconnected."); await read();
    } catch (error) { setProblem(error instanceof Error ? error.message : "The connection could not be changed."); }
    finally { setBusy(null); }
  };
  const setAside = async (id: string) => {
    setBusy(id); setProblem(null);
    try {
      const response = await scoped("/api/higgsfield/consumer/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set-aside", id }) });
      const json = await response.json().catch(() => null) as { capacity?: Capacity; error?: string } | null;
      if (!response.ok || !json?.capacity) throw new Error(json?.error ?? "The job could not be set aside.");
      setState((s) => (s ? { ...s, capacity: json.capacity } : s));
    } catch (error) { setProblem(error instanceof Error ? error.message : "The job could not be set aside."); }
    finally { setBusy(null); }
  };

  const connected = state?.connected === true && !state.requiresReconnect;
  const label = !owner ? "Owner only" : state == null ? (problem ? "Status unavailable" : "Checking…") : connected ? "Connected" : state.requiresReconnect ? "Reconnect required" : "Not connected";
  const capacity = state?.capacity;
  return (
    <div className="gx-card" data-testid="engine-connected-account">
      <span className="gx-eyebrow">Connected account</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={connected}><span className="cw-engine-dot" aria-hidden="true" />{label}</span>
        <span className="gx-spacer" />
        {owner && state ? (
          <>
            <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void act("connect")} data-testid="connected-account-connect">
              {busy === "connect" ? "Opening sign-in…" : confirm === "connect" ? "Reconnect anyway" : state.connected || state.requiresReconnect ? "Reconnect" : "Connect"}
            </button>
            {state.connected || state.requiresReconnect ? (
              <button type="button" className="gx-hbtn gx-hbtn--danger" disabled={busy != null} onClick={() => void act("disconnect")} data-testid="connected-account-disconnect">
                {busy === "disconnect" ? "Disconnecting…" : confirm === "disconnect" ? "Disconnect anyway" : "Disconnect"}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {confirm ? <p className="cw-notice" role="alert" data-testid="connected-account-warning">{running} of your jobs {running === 1 ? "is" : "are"} still running. Sign back in with the same account to keep collecting {running === 1 ? "it" : "them"}.</p> : null}
      {capacity ? (
        <div data-testid="connected-account-capacity">
          <span className="cw-dim">{capacity.active} of {capacity.limit} job slots in use</span>
          {mine.map((job) => (
            <div className="wsx-row" key={job.id} data-testid="connected-account-job">
              <span className="cw-engine" data-ok={job.status === "accepted"}><span className="cw-engine-dot" aria-hidden="true" /></span>
              <span style={{ minWidth: 0 }}><span className="wsx-name">{WORKFLOW[job.workflow] ?? "Job"} · {job.projectName ?? "Untitled project"}</span><span className="cw-dim">{STATUS[job.status] ?? job.status} · {since(job.createdAt)}</span></span>
              <span className="wsx-actions">
                {owner && job.releasable ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void setAside(job.id)}>{busy === job.id ? "Setting aside…" : "Set aside"}</button> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {!owner ? <p className="cw-foot" style={{ padding: 0 }}>The workspace owner connects the account.</p> : null}
      {problem ? <p className="gx-gen-error" role="alert">{problem}</p> : null}
      {note ? <p className="cw-notice" role="status" data-testid="connected-account-note">{note}</p> : null}
    </div>
  );
}
