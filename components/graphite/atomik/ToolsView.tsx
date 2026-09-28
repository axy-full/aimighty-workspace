"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useShell } from "@/lib/shell/state";
import {
  CLIENTS, DEFAULT_CEILING, PARTICL_REACH, STATUS_LABEL, ceilingShare, mcpEndpoint, mcpTools, parseTokens, readCeiling, setupGuide, tokenBody, tokenFacts,
  type ApiToken, type ClientId, type ReachOpen, type ReachRow, type TokenUnit, type ToolsTab,
} from "@/lib/shell/tools-connections";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Atomik › Tools & connections (it replaced Atomik › Skills). Two tabs:
 *  - What Atomik can do: Particl's own reach, each row with an Open that goes
 *    where it runs.
 *  - Claude & ChatGPT: Particl's own MCP server — make or revoke a token,
 *    copy the setup for a client, see the tools it gets.
 * The connected Higgsfield account's rows and the skill packs (which taught an
 * assistant to use that account through a sign-in) went with the Higgsfield
 * sign-in (lib/higgsfield-consumer/retired.ts). Nothing here generates or
 * spends. A new token's secret lives only in this component's state: shown
 * once, filled into the setup, never stored.
 */
const noop = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "";

/* The tab is kept while the page is left. */
let lastTab: ToolsTab = "reach";

const TABS: { id: ToolsTab; label: string }[] = [
  { id: "reach", label: "What Atomik can do" },
  { id: "connect", label: "Claude & ChatGPT" },
];

export function ToolsView() {
  const [tab, setTabState] = useState<ToolsTab>(lastTab);
  const setTab = useCallback((next: ToolsTab) => { lastTab = next; setTabState(next); }, []);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  /* Arrow keys move between the two tabs, as a tab list should. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    const to = e.key === "ArrowRight" ? (at + 1) % TABS.length : e.key === "ArrowLeft" ? (at + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to].id);
    tabs.current[to]?.focus();
  };
  return (
    <div className="sk tc gx-enter" data-testid="tools-view">
      <div className="gx-seg tc-tabs" role="tablist" aria-label="Tools and connections" onKeyDown={onKey}>
        {TABS.map((t, i) => (
          <button key={t.id} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab" id={`tc-tab-${t.id}`} aria-controls={`tc-panel-${t.id}`} className="gx-seg-btn"
            aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} data-testid={`tools-tab-${t.id}`}>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div id={`tc-panel-${tab}`} role="tabpanel" aria-labelledby={`tc-tab-${tab}`} className="tc-panel">
        {tab === "reach" ? <Reach onTab={setTab} /> : <Connect />}
      </div>
    </div>
  );
}

/* ── What Atomik can do ─────────────────────────────────────────────── */

/* Particl's own reach: built in, nothing to check. */
const ROWS: ReachRow[] = PARTICL_REACH.map((row) => ({ ...row, group: "particl", status: "built-in" }));

function Reach({ onTab }: { onTab: (tab: ToolsTab) => void }) {
  const shell = useShell();
  const open = (target: ReachOpen) => ("gen" in target ? shell.goGen() : "tab" in target ? onTab(target.tab) : shell.goSuite(target.suite, target.page));
  return (
    <>
      <p className="tc-intro">What Atomik reaches today, and where each one runs. Open goes straight there.</p>
      <section className="tc-card" aria-labelledby="tc-built-in" data-testid="reach-particl">
        <div className="tc-head"><h2 className="tc-title" id="tc-built-in">Built into Particl</h2></div>
        {ROWS.map((row) => <ReachLine key={row.id} row={row} onOpen={open} />)}
      </section>
    </>
  );
}

function ReachLine({ row, onOpen }: { row: ReachRow; onOpen: (target: ReachOpen) => void }) {
  return (
    <div className="tc-row" data-testid="reach-row" data-id={row.id} data-status={row.status}>
      <span className="tc-dot" data-status={row.status} aria-hidden="true" />
      <span className="tc-text">
        <span className="tc-name">{row.label}</span>
        <span className="cw-dim">{row.line}</span>
      </span>
      <span className="tc-side">
        <span className="tc-pill" data-status={row.status} data-testid="reach-status">{STATUS_LABEL[row.status]}</span>
        {row.open ? <button type="button" className="gx-hbtn" onClick={() => onOpen(row.open!)} aria-label={`Open ${row.open.label}: ${row.label}`} data-testid="reach-open">{row.open.label}</button> : null}
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
  const guide = origin ? setupGuide(client, origin, token) : null;
  return (
    <>
      <div className="tc-lead-block">
        <h2 className="tc-lead">Use Particl from Claude or ChatGPT</h2>
        <p className="tc-intro">Your assistant works in this workspace as you: it starts takes, waits for them and fetches the files, each one priced and filed like any other take. Make a token, add it to your assistant, then ask in plain words.</p>
      </div>
      <Tokens onFresh={setToken} />
      <section className="tc-card" aria-labelledby="tc-setup" data-testid="connect-setup">
        <div className="tc-head">
          <h3 className="tc-title" id="tc-setup"><span className="tc-n" aria-hidden="true">2</span>Add it to your assistant</h3>
        </div>
        <div className="gx-chips tc-clients" role="group" aria-label="Assistant">
          {CLIENTS.map((c) => (
            <button key={c.id} type="button" className="gx-chip" aria-pressed={client === c.id} onClick={() => setClient(c.id)} data-testid={`client-${c.id}`}>{c.label}</button>
          ))}
        </div>
        {guide ? <p className="tc-note" data-testid="setup-note">{guide.note}</p> : null}
        {guide?.steps.map((step, i) => <Copyable key={`${client}-${i}`} label={`${i + 1}. ${step.label}`} text={step.code} testId="setup-step" />)}
        <p className="tc-note" data-testid="setup-token-note">{token ? "Your new token is filled in above." : "Make a token in step 1 and it is filled in above."}</p>
      </section>
      <section className="tc-card" aria-labelledby="tc-tools" data-testid="connect-tools">
        <div className="tc-head">
          <h3 className="tc-title" id="tc-tools"><span className="tc-n" aria-hidden="true">3</span>What it can do</h3>
          <span className="tc-summary">{tools.length} tools · a read-only token gets the reading ones</span>
        </div>
        {origin ? <Copyable label="Server" text={mcpEndpoint(origin)} testId="mcp-endpoint" /> : null}
        {tools.map((t) => (
          <div className="tc-row" key={t.name} data-testid="mcp-tool">
            <span className="tc-dot" data-status="built-in" aria-hidden="true" />
            <span className="tc-text"><span className="tc-name tc-mono">{t.name}</span><span className="cw-dim">{t.line}</span></span>
            <span className="tc-side"><span className="tc-pill" data-status={t.token === "any" ? "built-in" : "spends"}>{t.token === "any" ? "Any token" : "Can generate"}</span></span>
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
  const [ceiling, setCeiling] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ id: string; name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const live = useRef(true);
  const loads = useRef(0);
  const freshBox = useRef<HTMLDivElement | null>(null);
  const copyButton = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  /* The secret is shown once: bring it into view and put focus on its Copy, wherever the form was scrolled to. */
  useEffect(() => {
    if (!fresh) return;
    freshBox.current?.scrollIntoView({ block: "nearest" });
    copyButton.current?.focus({ preventScroll: true });
  }, [fresh]);

  const load = useCallback(async () => {
    const mine = ++loads.current;
    try {
      const response = await scoped("/api/tokens", { cache: "no-store" });
      const json = await response.json().catch(() => null);
      const parsed = response.ok ? parseTokens(json) : null;
      if (!parsed) throw new Error((json as { error?: string } | null)?.error ?? "Your tokens could not be read. Try again.");
      /* Only the newest read lands: a slow first read never overwrites the list after a make or a revoke. */
      if (live.current && mine === loads.current) { setData(parsed); setLoadError(null); }
    } catch (caught) {
      if (live.current && mine === loads.current) setLoadError(caught instanceof Error ? caught.message : "Your tokens could not be read. Try again.");
    }
  }, [scoped]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  const unit: TokenUnit | null = data?.unit ?? null;
  /* The ceiling starts at a figure once the unit is known: no limit has to be chosen, not fallen into. */
  const typed = ceiling ?? (unit ? DEFAULT_CEILING[unit] : "");
  const read = unit && scope === "render" ? readCeiling(typed, unit) : null;
  const unbounded = read != null && !("error" in read) && read.blank;

  const create = async () => {
    if (busy || !unit) return;
    const trimmed = name.trim();
    if (!trimmed) { setProblem("Name it for what will use it, like “Claude on my laptop”."); return; }
    if (read && "error" in read) { setProblem(read.error); return; }
    setBusy(true); setProblem(null);
    try {
      const response = await scoped("/api/tokens", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenBody(trimmed, scope, unit, read && !("error" in read) ? read.value : null)),
      });
      const json = await response.json().catch(() => null) as { id?: string; name?: string; token?: string; error?: string } | null;
      if (!response.ok || typeof json?.token !== "string") throw new Error(json?.error ?? "The token could not be made. Try again.");
      if (!live.current) return;
      setFresh({ id: typeof json.id === "string" ? json.id : "", name: json.name ?? trimmed, token: json.token });
      setCopied(false);
      onFresh(json.token);
      setName(""); setCeiling(null);
      void load();
    } catch (caught) {
      if (live.current) setProblem(caught instanceof Error ? caught.message : "The token could not be made. Try again.");
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const revoke = async (t: ApiToken) => {
    if (revoking) return;
    setRevoking(t.id); setRowError(null);
    try {
      const response = await scoped(`/api/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The token could not be revoked. Try again.");
      if (!live.current) return;
      /* Gone from the list at once; then a fresh read, so a token made a moment ago is not lost to an older read. */
      setData((current) => (current ? { ...current, tokens: current.tokens.filter((x) => x.id !== t.id) } : current));
      void load();
      setConfirming(null);
      /* A revoked secret is useless: it leaves the screen and the setup steps. */
      if (fresh?.id === t.id) { setFresh(null); onFresh(""); }
      heading.current?.focus();
      toast(`“${t.name}” revoked. Anything using it is refused from its next call.`);
    } catch (caught) {
      if (live.current) setRowError({ id: t.id, text: caught instanceof Error ? caught.message : "The token could not be revoked. Try again." });
    } finally {
      if (live.current) setRevoking(null);
    }
  };
  const copyFresh = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh.token); setCopied(true); }
    catch { setCopied(false); toast("Copy didn’t work here. Select the token and copy it."); }
  };

  const tokens = data?.tokens ?? [];
  const suffix = unit === "usd" ? "$ a month" : "cr a month";
  return (
    <section className="tc-card" aria-labelledby="tc-tokens" data-testid="connect-tokens">
      <div className="tc-head">
        <h3 className="tc-title" id="tc-tokens" tabIndex={-1} ref={heading}><span className="tc-n" aria-hidden="true">1</span>Make a token</h3>
        <span className="tc-summary">Acts as you · revoke any time</span>
      </div>
      {fresh ? (
        <div className="tc-fresh" role="status" ref={freshBox} data-testid="token-fresh">
          <span className="tc-name">Copy “{fresh.name}” now. It is shown once; step 2 has it filled in.</span>
          <code className="tc-secret" data-testid="token-secret">{fresh.token}</code>
          <span className="wsx-actions">
            <button type="button" className="gx-primary" ref={copyButton} onClick={() => void copyFresh()} data-testid="token-copy">{copied ? "Copied" : "Copy token"}</button>
            <button type="button" className="gx-hbtn" onClick={() => setFresh(null)} data-testid="token-done">Done</button>
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div className="tc-row tc-row--note" role="alert" data-testid="tokens-error">
          <span className="tc-dot" data-status="error" aria-hidden="true" />
          <span className="tc-text"><span className="tc-name">{loadError}</span></span>
          <span className="tc-side"><button type="button" className="gx-hbtn" onClick={() => { setLoadError(null); void load(); }} data-testid="tokens-retry">Try again</button></span>
        </div>
      ) : !data ? (
        <p className="gx-empty tc-pad" aria-busy="true" data-testid="tokens-loading">Reading your tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="gx-empty tc-pad" data-testid="tokens-empty">No tokens yet. Make one below; it appears here with what it spent this month.</p>
      ) : tokens.map((t) => {
        const share = ceilingShare(t, data.unit);
        return (
          <div className="tc-row" key={t.id} data-testid="token-row" data-id={t.id}>
            <span className="tc-dot" data-status={t.scope === "read" ? "built-in" : "available"} aria-hidden="true" />
            <span className="tc-text">
              <span className="tc-name">{t.name}</span>
              <span className="cw-dim" data-testid="token-facts">{tokenFacts(t, data.unit)}</span>
              {share != null ? <span className="tc-meter" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} data-full={share >= 1} /></span> : null}
              {rowError?.id === t.id ? <span className="gx-gen-error" role="alert">{rowError.text}</span> : null}
            </span>
            <span className="tc-side">
              {confirming === t.id ? (
                <>
                  <button type="button" className="gx-hbtn tc-danger" disabled={revoking === t.id} onClick={() => void revoke(t)} data-testid="token-revoke-confirm">{revoking === t.id ? "Revoking…" : "Revoke now"}</button>
                  <button type="button" className="gx-hbtn" disabled={revoking === t.id} onClick={() => setConfirming(null)} data-testid="token-keep">Keep</button>
                </>
              ) : (
                <button type="button" className="gx-hbtn" disabled={revoking != null} onClick={() => { setConfirming(t.id); setRowError(null); }} aria-label={`Revoke ${t.name}`} data-testid="token-revoke">Revoke</button>
              )}
            </span>
          </div>
        );
      })}
      <form className="tc-form" onSubmit={(e) => { e.preventDefault(); void create(); }} data-testid="token-form">
        <input className="gx-field tc-field-name" aria-label="Token name" placeholder="What will use it?" maxLength={60} value={name} onChange={(e) => { setName(e.target.value); setProblem(null); }} data-testid="token-name" />
        <div className="gx-seg tc-scope" role="group" aria-label="What it can do">
          <button type="button" className="gx-seg-btn" aria-pressed={scope === "render"} onClick={() => { setScope("render"); setProblem(null); }} data-testid="token-scope-render"><span>Can generate</span></button>
          <button type="button" className="gx-seg-btn" aria-pressed={scope === "read"} onClick={() => { setScope("read"); setProblem(null); }} data-testid="token-scope-read"><span>Read-only</span></button>
        </div>
        {scope === "render" ? (
          <label className="tc-ceiling">
            <input className="gx-field" inputMode="numeric" aria-label={unit === "usd" ? "Monthly ceiling in dollars" : "Monthly ceiling in credits"} aria-describedby={unbounded ? "tc-unbounded" : undefined} placeholder={unit ? "No ceiling" : "Reading…"} value={typed} disabled={!unit} onChange={(e) => { setCeiling(e.target.value); setProblem(null); }} data-testid="token-ceiling" />
            <span className="cw-dim">{suffix}</span>
          </label>
        ) : null}
        <button type="submit" className="gx-primary" disabled={busy || !unit || !name.trim()} data-testid="token-create">{busy ? "Making…" : unbounded ? "Make token without a ceiling" : "Make token"}</button>
      </form>
      {scope === "render" && unbounded ? <p className="tc-note tc-warn" id="tc-unbounded" data-testid="token-unbounded">No ceiling: it can spend until the workspace’s {unit === "usd" ? "engine balance" : "credits"} run out.</p> : null}
      {scope === "read" ? <p className="tc-note" data-testid="token-read-note">Read-only: it can list and fetch takes, and every paid call is refused.</p> : null}
      {problem ? <p className="gx-gen-error tc-problem" role="alert" data-testid="token-problem">{problem}</p> : null}
    </section>
  );
}

function Copyable({ label, text, testId }: { label: string; text: string; testId: string }) {
  const { toast } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      toast("Copy didn’t work here. Select the text and copy it.");
    }
  };
  const name = label.replace(/^\d+\.\s*/, "");
  return (
    <div className="tc-copy" data-testid={testId}>
      <span className="tc-copy-label">{label}</span>
      <div className="tc-copy-body">
        <pre className="tc-code" tabIndex={0}>{text}</pre>
        <button type="button" className="gx-hbtn tc-copy-btn" onClick={() => void copy()} aria-label={`Copy: ${name}`}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

/** The Inspector's page body here: what the page is, and that nothing on it spends. */
export function ToolsInspector() {
  return (
    <div className="tc-insp" data-inspector-body="tools">
      <span className="tc-insp-title">Tools &amp; connections</span>
      <span className="tc-insp-sub">Atomik Supercomputer</span>
      <p className="tc-insp-note">Nothing on this page spends. A token spends only when your assistant starts a take, and stops at its monthly ceiling; revoking one disables it, and nothing is erased.</p>
    </div>
  );
}
