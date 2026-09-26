"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseReach } from "@/lib/higgsfield-consumer/reach";
import { useSession } from "@/lib/session";
import { useShell } from "@/lib/shell/state";
import {
  CLIENTS, STATUS_LABEL, ceilingShare, mcpEndpoint, mcpTools, parseTokens, reachRows, reachSummary, readCeiling, setupSteps, tokenFacts,
  type ApiToken, type ClientId, type ReachOpen, type ReachRow, type ReachState, type TokenUnit,
} from "@/lib/shell/tools-connections";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Atomik › Tools & connections. Two tabs:
 *  - What Atomik can do: Particl's built-in reach, then the connected
 *    account's, each with its live status (owner only; a free tools/list read).
 *  - Claude & ChatGPT: Particl's own MCP server — make or revoke a token,
 *    copy the setup for a client, see the tools it gets.
 * Nothing here generates or spends.
 */
type Tab = "reach" | "connect";

const noop = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "";

/* One reach result per workspace scope for a minute, so moving between pages
   does not spend the owner's discovery allowance (six a minute). */
const REUSE_MS = 60_000;
let remembered: { scope: string; at: number; state: ReachState } | null = null;

export function ToolsView() {
  const [tab, setTab] = useState<Tab>("reach");
  return (
    <div className="sk tc gx-enter" data-testid="tools-view">
      <div className="gx-seg tc-tabs" role="tablist" aria-label="Tools and connections">
        <button type="button" role="tab" id="tc-tab-reach" aria-controls="tc-panel" className="gx-seg-btn" aria-selected={tab === "reach"} onClick={() => setTab("reach")} data-testid="tools-tab-reach"><span>What Atomik can do</span></button>
        <button type="button" role="tab" id="tc-tab-connect" aria-controls="tc-panel" className="gx-seg-btn" aria-selected={tab === "connect"} onClick={() => setTab("connect")} data-testid="tools-tab-connect"><span>Claude &amp; ChatGPT</span></button>
      </div>
      <div id="tc-panel" role="tabpanel" aria-labelledby={tab === "reach" ? "tc-tab-reach" : "tc-tab-connect"} className="tc-panel">
        {tab === "reach" ? <Reach /> : <Connect />}
      </div>
    </div>
  );
}

/* ── What Atomik can do ─────────────────────────────────────────────── */

function Reach() {
  const session = useSession();
  const shell = useShell();
  const scoped = useScopedFetch();
  const scope = session.requestScope ?? "";
  const owner = session.owner === true;
  const fresh = remembered && remembered.scope === scope && Date.now() - remembered.at < REUSE_MS ? remembered.state : null;
  const [state, setState] = useState<ReachState>(() => (!owner ? { kind: "owner-only" } : fresh ?? { kind: "checking" }));
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const check = useCallback(async () => {
    if (!owner) return;
    setState({ kind: "checking" });
    let next: ReachState;
    try {
      const response = await scoped("/api/higgsfield/consumer/capabilities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: "reach" }) });
      const json = await response.json().catch(() => null) as { reach?: unknown; checkedAt?: unknown; code?: unknown; error?: unknown } | null;
      const checks = response.ok ? parseReach(json?.reach) : null;
      if (checks) next = { kind: "checked", checks, checkedAt: typeof json?.checkedAt === "number" ? json.checkedAt : Date.now() };
      else if (json?.code === "not_connected" || json?.code === "reconnect_required") next = { kind: "connect", reconnect: json.code === "reconnect_required" };
      else if (response.status === 403) next = { kind: "owner-only" };
      else if (response.status === 429) next = { kind: "error", message: "Checked too often. Try again in a minute." };
      else next = { kind: "error", message: typeof json?.error === "string" && json.error.length < 160 ? json.error : "The connected account could not be checked." };
    } catch {
      next = { kind: "error", message: "The connected account could not be checked." };
    }
    if (next.kind !== "error") remembered = { scope, at: Date.now(), state: next };
    if (live.current) setState(next);
  }, [owner, scoped, scope]);

  useEffect(() => {
    if (!owner || fresh) return;
    const timer = setTimeout(() => void check(), 0);
    return () => clearTimeout(timer);
    // One automatic check per mount; "Check again" re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = reachRows(state);
  const open = (target: ReachOpen) => ("gen" in target ? shell.goGen() : shell.goSuite(target.suite, target.page));
  const checkedAt = state.kind === "checked" ? new Date(state.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <>
      <section className="tc-card" aria-labelledby="tc-built-in" data-testid="reach-particl">
        <div className="tc-head"><h2 className="tc-title" id="tc-built-in">Built into Particl</h2></div>
        {rows.filter((r) => r.group === "particl").map((row) => <ReachLine key={row.id} row={row} onOpen={open} />)}
      </section>
      <section className="tc-card" aria-labelledby="tc-connected" data-testid="reach-connected" aria-busy={state.kind === "checking"}>
        <div className="tc-head">
          <h2 className="tc-title" id="tc-connected">Connected account</h2>
          <span className="tc-summary" role="status" data-testid="reach-summary">{reachSummary(state)}{checkedAt ? ` · checked ${checkedAt}` : ""}</span>
          <span className="gx-spacer" />
          {owner && state.kind !== "connect" ? (
            <button type="button" className="gx-hbtn" disabled={state.kind === "checking"} onClick={() => void check()} data-testid="reach-check">{state.kind === "checking" ? "Checking…" : state.kind === "error" ? "Try again" : "Check again"}</button>
          ) : null}
          {owner && state.kind === "connect" ? (
            <button type="button" className="gx-primary" onClick={() => shell.goWorkspace("engines")} data-testid="reach-engines">Open Engines</button>
          ) : null}
        </div>
        {rows.filter((r) => r.group === "connected").map((row) => <ReachLine key={row.id} row={row} onOpen={open} />)}
      </section>
    </>
  );
}

function ReachLine({ row, onOpen }: { row: ReachRow; onOpen: (target: ReachOpen) => void }) {
  const usable = row.status === "built-in" || row.status === "available";
  return (
    <div className="tc-row" data-testid="reach-row" data-id={row.id} data-status={row.status}>
      <span className="tc-dot" data-status={row.status} aria-hidden="true" />
      <span className="tc-text">
        <span className="tc-name">{row.label}</span>
        <span className="cw-dim">{row.line}</span>
      </span>
      <span className="tc-side">
        <span className="tc-pill" data-status={row.status} data-testid="reach-status">{STATUS_LABEL[row.status]}</span>
        {row.open && usable ? <button type="button" className="gx-hbtn" onClick={() => onOpen(row.open!)} aria-label={`Open ${row.open.label} for ${row.label}`}>Open</button> : null}
      </span>
    </div>
  );
}

/* ── Claude & ChatGPT ───────────────────────────────────────────────── */

function Connect() {
  const origin = useSyncExternalStore(noop, readOrigin, serverOrigin);
  const [token, setToken] = useState("");
  const [client, setClient] = useState<ClientId>("claude-code");
  const tools = mcpTools();
  const steps = origin ? setupSteps(client, origin, token) : [];
  return (
    <>
      <h2 className="tc-lead">Use Particl from Claude or ChatGPT</h2>
      <Tokens onFresh={setToken} />
      <section className="tc-card" aria-labelledby="tc-setup" data-testid="connect-setup">
        <div className="tc-head">
          <h3 className="tc-title" id="tc-setup"><span className="tc-n">2</span>Add it to your assistant</h3>
        </div>
        <div className="tc-clients" role="radiogroup" aria-label="Assistant">
          {CLIENTS.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={client === c.id} className="gx-hbtn tc-client" onClick={() => setClient(c.id)} data-testid={`client-${c.id}`}>{c.label}</button>
          ))}
        </div>
        {steps.map((step, i) => <Copyable key={`${client}-${i}`} label={`${i + 1}. ${step.label}`} text={step.code} testId="setup-step" />)}
        {token ? <p className="gx-gen-note" data-testid="setup-filled">Your new token is filled in above.</p> : null}
      </section>
      <section className="tc-card" aria-labelledby="tc-tools" data-testid="connect-tools">
        <div className="tc-head">
          <h3 className="tc-title" id="tc-tools"><span className="tc-n">3</span>What it can do</h3>
          <span className="tc-summary">{tools.length} tools · acts as you</span>
        </div>
        {origin ? <Copyable label="Server" text={mcpEndpoint(origin)} testId="mcp-endpoint" inline /> : null}
        {tools.map((t) => (
          <div className="tc-row" key={t.name} data-testid="mcp-tool">
            <span className="tc-dot" data-status="built-in" aria-hidden="true" />
            <span className="tc-text"><span className="tc-name tc-mono">{t.name}</span><span className="cw-dim">{t.line}</span></span>
            <span className="tc-side"><span className="tc-pill" data-status={t.token === "any" ? "built-in" : "owner-only"}>{t.token === "any" ? "Any token" : "Generate token"}</span></span>
          </div>
        ))}
      </section>
    </>
  );
}

/* Tokens: list, make, revoke. Revoking disables the token (revoked_at); nothing is erased. */
function Tokens({ onFresh }: { onFresh: (token: string) => void }) {
  const scoped = useScopedFetch();
  const { toast } = useWorkspace();
  const [data, setData] = useState<{ unit: TokenUnit; tokens: ApiToken[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"render" | "read">("render");
  const [ceiling, setCeiling] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const response = await scoped("/api/tokens", { cache: "no-store" });
      const json = await response.json().catch(() => null);
      const parsed = response.ok ? parseTokens(json) : null;
      if (!parsed) throw new Error((json as { error?: string } | null)?.error ?? "Your tokens could not be read.");
      if (live.current) { setData(parsed); setLoadError(null); }
    } catch (caught) {
      if (live.current) setLoadError(caught instanceof Error ? caught.message : "Your tokens could not be read.");
    }
  }, [scoped]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  const unit: TokenUnit = data?.unit ?? "credits";
  const create = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setProblem("Name it for what will use it."); return; }
    const cap = scope === "render" ? readCeiling(ceiling, unit) : { value: null };
    if ("error" in cap) { setProblem(cap.error); return; }
    setBusy(true); setProblem(null);
    try {
      const response = await scoped("/api/tokens", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, scope, ...(cap.value == null ? {} : unit === "credits" ? { capCredits: cap.value } : { capUsd: cap.value }) }),
      });
      const json = await response.json().catch(() => null) as { name?: string; token?: string; error?: string } | null;
      if (!response.ok || typeof json?.token !== "string") throw new Error(json?.error ?? "The token could not be made.");
      if (!live.current) return;
      setFresh({ name: json.name ?? trimmed, token: json.token });
      setCopied(false);
      onFresh(json.token);
      setName(""); setCeiling("");
      void load();
    } catch (caught) {
      if (live.current) setProblem(caught instanceof Error ? caught.message : "The token could not be made.");
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const revoke = async (t: ApiToken) => {
    setRevoking(t.id); setRowError(null);
    try {
      const response = await scoped(`/api/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The token could not be revoked.");
      if (!live.current) return;
      setData((current) => (current ? { ...current, tokens: current.tokens.filter((x) => x.id !== t.id) } : current));
      setConfirming(null);
      toast(`“${t.name}” revoked. Anything using it stops on its next call.`);
    } catch (caught) {
      if (live.current) setRowError({ id: t.id, text: caught instanceof Error ? caught.message : "The token could not be revoked." });
    } finally {
      if (live.current) setRevoking(null);
    }
  };
  const copyFresh = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh.token); setCopied(true); }
    catch { setCopied(false); toast("Select the token and copy it."); }
  };

  const tokens = data?.tokens ?? [];
  const suffix = unit === "credits" ? "cr / month" : "$ / month";
  return (
    <section className="tc-card" aria-labelledby="tc-tokens" data-testid="connect-tokens">
      <div className="tc-head">
        <h3 className="tc-title" id="tc-tokens"><span className="tc-n">1</span>Make a token</h3>
        <span className="tc-summary">Acts as you · revoke any time</span>
      </div>
      {fresh ? (
        <div className="tc-fresh" role="status" data-testid="token-fresh">
          <span className="tc-name">Copy “{fresh.name}” now — it is shown once</span>
          <code className="tc-secret" data-testid="token-secret">{fresh.token}</code>
          <span className="wsx-actions">
            <button type="button" className="gx-primary" onClick={() => void copyFresh()} data-testid="token-copy">{copied ? "Copied" : "Copy token"}</button>
            <button type="button" className="gx-hbtn" onClick={() => setFresh(null)}>Done</button>
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div className="tc-row tc-row--note" role="alert" data-testid="tokens-error">
          <span className="tc-dot" data-status="error" aria-hidden="true" />
          <span className="tc-text"><span className="tc-name">{loadError}</span></span>
          <span className="tc-side"><button type="button" className="gx-hbtn" onClick={() => { setLoadError(null); void load(); }}>Retry</button></span>
        </div>
      ) : !data ? (
        <p className="gx-empty tc-pad" aria-busy="true" data-testid="tokens-loading">Reading your tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="gx-empty tc-pad" data-testid="tokens-empty">No tokens yet.</p>
      ) : tokens.map((t) => {
        const share = ceilingShare(t, unit);
        return (
          <div className="tc-row" key={t.id} data-testid="token-row">
            <span className="tc-dot" data-status={t.scope === "read" ? "built-in" : "available"} aria-hidden="true" />
            <span className="tc-text">
              <span className="tc-name">{t.name}</span>
              <span className="cw-dim" data-testid="token-facts">{tokenFacts(t, unit)}</span>
              {share != null ? <span className="tc-meter" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} data-full={share >= 1} /></span> : null}
              {rowError?.id === t.id ? <span className="gx-gen-error" role="alert">{rowError.text}</span> : null}
            </span>
            <span className="tc-side">
              {confirming === t.id ? (
                <>
                  <button type="button" className="gx-hbtn gx-hbtn--danger" disabled={revoking === t.id} onClick={() => void revoke(t)} data-testid="token-revoke-confirm">{revoking === t.id ? "Revoking…" : "Revoke now"}</button>
                  <button type="button" className="gx-hbtn" disabled={revoking === t.id} onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <button type="button" className="gx-hbtn" onClick={() => { setConfirming(t.id); setRowError(null); }} aria-label={`Revoke ${t.name}`} data-testid="token-revoke">Revoke</button>
              )}
            </span>
          </div>
        );
      })}
      <form className="tc-form" onSubmit={(e) => { e.preventDefault(); void create(); }} data-testid="token-form">
        <input className="gx-field tc-field-name" aria-label="Token name" placeholder="What will use it?" maxLength={60} value={name} onChange={(e) => { setName(e.target.value); setProblem(null); }} data-testid="token-name" />
        <div className="gx-seg tc-scope" role="radiogroup" aria-label="What it can do">
          <button type="button" role="radio" className="gx-seg-btn" aria-checked={scope === "render"} onClick={() => setScope("render")} data-testid="token-scope-render"><span>Can generate</span></button>
          <button type="button" role="radio" className="gx-seg-btn" aria-checked={scope === "read"} onClick={() => setScope("read")} data-testid="token-scope-read"><span>Read-only</span></button>
        </div>
        {scope === "render" ? (
          <label className="tc-ceiling">
            <input className="gx-field" inputMode="numeric" aria-label={`Monthly ceiling, ${suffix}`} placeholder="No ceiling" value={ceiling} onChange={(e) => { setCeiling(e.target.value); setProblem(null); }} data-testid="token-ceiling" />
            <span className="cw-dim">{suffix}</span>
          </label>
        ) : null}
        <button type="submit" className="gx-primary" disabled={busy || !name.trim()} data-testid="token-create">{busy ? "Making…" : "Make token"}</button>
      </form>
      {problem ? <p className="gx-gen-error" role="alert" data-testid="token-problem">{problem}</p> : null}
    </section>
  );
}

function Copyable({ label, text, testId, inline }: { label: string; text: string; testId: string; inline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  return (
    <div className={`tc-copy${inline ? " tc-copy--inline" : ""}`} data-testid={testId}>
      <span className="tc-copy-label cw-dim">{label}</span>
      <div className="tc-copy-body">
        <pre className="tc-code" tabIndex={0}>{text}</pre>
        <button type="button" className="gx-hbtn tc-copy-btn" onClick={() => void copy()} aria-label={`Copy ${label.replace(/^\d+\.\s*/, "")}`}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}
