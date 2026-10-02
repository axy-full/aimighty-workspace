"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACCOUNT_RETIRED, CONNECTION_ENDPOINT, HISTORY_KEPT } from "@/lib/shell/connected-capability";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Workspace › Engines › Higgsfield account, for the owner only. The sign-in
 * is retired (lib/higgsfield-consumer/retired.ts): nothing connects or
 * reconnects here. While Particl still holds the owner's grant, or any of the
 * owner's jobs still holds one of the workspace's four slots, the row says so,
 * lists those jobs (a stuck one can be set aside in the ledger only: nothing
 * is sent, deleted or resubmitted) and offers Disconnect, which clears the
 * stored tokens and asks Higgsfield to revoke Particl's access. Jobs already
 * running are still collected until then. With no grant and nothing running
 * the row shows nothing, unless a sign-in started before the retirement just
 * returned here (`?higgsfield=`). A member never sees it.
 */
type CapacityJob = { id: string; draftId: string; projectName: string | null; workflow: string; status: string; createdAt: number; releasable: boolean };
type Capacity = { limit: number; active: number; mine: CapacityJob[] };
type Connection = { connected: boolean; requiresReconnect: boolean; capacity?: Capacity | null };
type Problem = { text: string; retry: boolean };
const WORKFLOW: Record<string, string> = {
  "marketing-video": "Marketing video", generation: "Generate", genjutsu: "Transform", "marketing-template": "Ad template", "voice-tool": "Voice tool", shorts: "Shorts",
};
const STATUS: Record<string, string> = { dispatching: "sending", accepted: "running", uncertain: "unconfirmed" };
const since = (ms: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};
const UNREADABLE = "The Higgsfield account’s status could not be read.";

export function ConnectedAccountRow({ owner }: { owner: boolean }) {
  const scoped = useScopedFetch();
  const [state, setState] = useState<Connection | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const readVersion = useRef(0);
  const invalidateRead = useCallback(() => { readVersion.current++; }, []);
  /* A sign-in started before the retirement returns here with `?higgsfield=`; the row then says why. The
     shell's first URL write (lib/workspace/state.tsx › writeUrl) keeps only its own params, so a reload does not repeat it. */
  const [returned] = useState(() => {
    try { return Boolean(new URLSearchParams(window.location.search).get("higgsfield")); } catch { return false; }
  });
  const read = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const response = await scoped(CONNECTION_ENDPOINT, { cache: "no-store" });
      const json = await response.json().catch(() => null) as (Connection & { error?: string }) | null;
      if (!response.ok || !json) throw new Error(json?.error ?? UNREADABLE);
      if (version !== readVersion.current) return;
      setState(json); setProblem(null);
    } catch (error) { if (version === readVersion.current) setProblem({ text: error instanceof Error && error.message ? error.message : UNREADABLE, retry: true }); }
  }, [scoped]);
  useEffect(() => {
    if (!owner) return;
    const t = setTimeout(() => void read(), 0);
    return () => { clearTimeout(t); invalidateRead(); };
  }, [read, owner, invalidateRead]);
  const mine = state?.capacity?.mine ?? [];
  const running = mine.length;
  /* Particl still holds a grant (a reconnect-required one included): Disconnect revokes it. */
  const holds = state?.connected === true || state?.requiresReconnect === true;
  const disconnect = async () => {
    // Jobs still running are collected under this grant: say so once before it goes.
    if (running && !confirm) { setConfirm(true); return; }
    setConfirm(false); setBusy("disconnect"); setNote(null); setProblem(null);
    try {
      const response = await scoped(CONNECTION_ENDPOINT, { method: "DELETE" });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The account could not be disconnected. Try again.");
      invalidateRead();
      setState(null);
      setNote("Account disconnected. Particl no longer holds access to it.");
      await read();
    } catch (error) { setProblem({ text: error instanceof Error && error.message ? error.message : "The account could not be disconnected. Try again.", retry: false }); }
    finally { setBusy(null); }
  };
  const setAside = async (id: string) => {
    setBusy(id); setProblem(null);
    try {
      const response = await scoped(CONNECTION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set-aside", id }) });
      const json = await response.json().catch(() => null) as { capacity?: Capacity; error?: string } | null;
      if (!response.ok || !json?.capacity) throw new Error(json?.error ?? "The job could not be set aside.");
      setState((s) => (s ? { ...s, capacity: json.capacity } : s));
    } catch (error) { setProblem({ text: error instanceof Error && error.message ? error.message : "The job could not be set aside.", retry: false }); }
    finally { setBusy(null); }
  };

  if (!owner || !(returned || problem || note || (state && (holds || running)))) return null;
  const capacity = state?.capacity;
  return (
    <div className="gx-card" data-testid="engine-connected-account">
      <span className="gx-eyebrow">Higgsfield account</span>
      <div className="cw-engine-row">
        <span className="cw-engine" data-ok={false}><span className="cw-engine-dot" aria-hidden="true" />{state == null && problem?.retry ? "Status unavailable" : "Sign-in retired"}</span>
        <span className="gx-spacer" />
        {state && holds ? (
          <button type="button" className="gx-hbtn gx-hbtn--danger" disabled={busy != null} onClick={() => void disconnect()} data-testid="connected-account-disconnect">
            {busy === "disconnect" ? "Disconnecting…" : confirm ? "Disconnect anyway" : "Disconnect"}
          </button>
        ) : null}
      </div>
      <p className="cw-foot" style={{ padding: 0 }} data-testid="connected-account-retired">
        {ACCOUNT_RETIRED}. {HISTORY_KEPT}{state && holds ? " Jobs already running are still collected; disconnect once none are left." : ""}
      </p>
      {confirm ? <p className="cw-notice" role="alert" data-testid="connected-account-warning">{running} of your jobs {running === 1 ? "is" : "are"} still running and can’t be collected after a disconnect.</p> : null}
      {capacity && running ? (
        <div data-testid="connected-account-capacity">
          <span className="cw-dim">{capacity.active} of {capacity.limit} job slots in use</span>
          {mine.map((job) => (
            <div className="wsx-row" key={job.id} data-testid="connected-account-job">
              <span className="cw-engine" data-ok={job.status === "accepted"}><span className="cw-engine-dot" aria-hidden="true" /></span>
              <span style={{ minWidth: 0 }}><span className="wsx-name">{WORKFLOW[job.workflow] ?? "Job"} · {job.projectName ?? "Untitled project"}</span><span className="cw-dim">{STATUS[job.status] ?? job.status} · {since(job.createdAt)}</span></span>
              <span className="wsx-actions">
                {job.releasable ? <button type="button" className="gx-hbtn" disabled={busy != null} onClick={() => void setAside(job.id)}>{busy === job.id ? "Setting aside…" : "Set aside"}</button> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {problem ? (
        <div className="gx-retry" role="alert">
          <span className="gx-gen-error">{problem.text}</span>
          {problem.retry ? <button type="button" className="gx-hbtn" onClick={() => void read()} data-testid="connected-account-retry">Try again</button> : null}
        </div>
      ) : null}
      {note ? <p className="cw-notice" role="status" data-testid="connected-account-note">{note}</p> : null}
    </div>
  );
}
