"use client";
import { useCallback, useEffect, useState } from "react";
import { appConfirm } from "@/components/dialog";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { RULE_SCOPES, RULE_SCOPE_LABELS, type EffectiveRule, type RuleApply, type RuleScope } from "@/lib/platformLayer";

/**
 * The rule library (brief 2.5) on Workspace › General: what the prompt writer
 * adds to every prompt in scope. The team's own rules come first; the
 * platform's are inherited, folded away behind their count, and each can be
 * switched off here — the platform layer is overridable by every workspace
 * (SOW §3.3). Changing a rule is an admin's; everyone may read them.
 */
const APPLY_LABEL: Record<RuleApply, string> = { writer: "for the writer", prompt: "in the prompt" };

export function RulesCard() {
  const scoped = useScopedFetch();
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  const [rules, setRules] = useState<EffectiveRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<RuleScope>("all");
  const [apply, setApply] = useState<RuleApply>("prompt");
  const [showInherited, setShowInherited] = useState(false);

  const send = useCallback(async (path: string, init?: { method: string; body?: unknown }) => {
    setBusy(true); setError(null);
    try {
      const response = await scoped(path, init
        ? { method: init.method, headers: { "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }
        : { cache: "no-store" });
      const json = await response.json().catch(() => null) as { rules?: EffectiveRule[]; error?: string } | null;
      if (!response.ok || !json?.rules) throw new Error(json?.error ?? "The rules could not be read.");
      setRules(json.rules);
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The rules could not be read."); return false; }
    finally { setBusy(false); }
  }, [scoped]);
  useEffect(() => { const t = setTimeout(() => void send("/api/rules"), 0); return () => clearTimeout(t); }, [send]);

  const add = async () => {
    if (!text.trim()) return;
    if (await send("/api/rules", { method: "POST", body: { text: text.trim(), scope, apply } })) setText("");
  };
  const patch = (rule: EffectiveRule, body: Record<string, unknown>) => void send(`/api/rules/${encodeURIComponent(rule.id)}`, { method: "PATCH", body });
  const remove = async (rule: EffectiveRule) => {
    if (await appConfirm("Remove this rule?", rule.text, { confirmLabel: "Remove" })) await send(`/api/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
  };

  const mine = (rules ?? []).filter((r) => r.source === "workspace");
  const inherited = (rules ?? []).filter((r) => r.source !== "workspace");
  const off = inherited.filter((r) => !r.on).length;

  const row = (rule: EffectiveRule) => {
    const own = rule.source === "workspace";
    const editable = own && admin;
    return (
      /* The switch sits beside a read-only rule, and wraps under an editable one on a phone. */
      <div key={rule.id} className="wsx-row" style={{ display: "flex", flexWrap: "wrap", columnGap: 12, rowGap: 8, opacity: rule.on ? 1 : 0.62 }} data-testid="ws-rule" data-source={rule.source}>
        <span style={{ flex: `1 1 ${editable ? 280 : 180}px`, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {editable ? (
            <input className="gx-field" defaultValue={rule.text} aria-label="Rule" disabled={busy} maxLength={400}
              onBlur={(e) => { const next = e.target.value.trim(); if (next && next !== rule.text) patch(rule, { text: next }); }} />
          ) : <span style={{ overflowWrap: "anywhere" }}>{rule.text}</span>}
          {editable ? (
            <span className="wsx-actions">
              <select className="gx-select" style={{ width: "auto", flex: "1 1 140px" }} value={rule.scope} aria-label="Scope" disabled={busy} onChange={(e) => patch(rule, { scope: e.target.value })}>
                {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
              </select>
              <select className="gx-select" style={{ width: "auto", flex: "1 1 140px" }} value={rule.apply} aria-label="Applies" disabled={busy} onChange={(e) => patch(rule, { apply: e.target.value })}>
                <option value="prompt">{APPLY_LABEL.prompt}</option><option value="writer">{APPLY_LABEL.writer}</option>
              </select>
            </span>
          ) : <span className="cw-dim">{own ? "Workspace" : "Platform"} · {RULE_SCOPE_LABELS[rule.scope]} · {APPLY_LABEL[rule.apply]}</span>}
        </span>
        <span className="wsx-actions" style={{ justifyContent: "flex-end", marginLeft: "auto" }}>
          <button type="button" role="switch" aria-checked={rule.on} aria-label={`${rule.on ? "Switch off" : "Switch on"}: ${rule.text}`} className="gx-toggle" disabled={!admin || busy}
            onClick={() => patch(rule, { on: !rule.on })}><span className="gx-toggle-dot" aria-hidden="true" />{rule.on ? "On" : "Off"}</button>
          {editable ? <button type="button" className="gx-hbtn" disabled={busy} onClick={() => void remove(rule)}>Remove</button> : null}
        </span>
      </div>
    );
  };

  return (
    <div className="wsx-card" data-testid="ws-rules">
      <span className="gx-eyebrow">Rules</span>
      <span className="cw-dim">Added to every prompt in scope.</span>
      {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
      {!rules && !error ? <span className="cw-dim" role="status">Reading…</span> : null}
      {mine.map(row)}
      {admin && rules ? (
        <div className="wsx-actions">
          <input className="gx-field" style={{ flex: "1 1 240px", width: "auto" }} value={text} maxLength={400} aria-label="New rule" placeholder="One sentence, e.g. no logos in the first frame"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
          <select className="gx-select" style={{ width: "auto", flex: "1 1 140px" }} value={scope} aria-label="New rule scope" onChange={(e) => setScope(e.target.value as RuleScope)}>
            {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
          </select>
          <select className="gx-select" style={{ width: "auto", flex: "1 1 140px" }} value={apply} aria-label="New rule applies" onChange={(e) => setApply(e.target.value as RuleApply)}>
            <option value="prompt">{APPLY_LABEL.prompt}</option><option value="writer">{APPLY_LABEL.writer}</option>
          </select>
          <button type="button" className="gx-hbtn" disabled={busy || !text.trim()} onClick={() => void add()} data-testid="ws-rule-add">Add rule</button>
        </div>
      ) : null}
      {!admin && rules ? <span className="gx-reason">Rules are an admin’s to change.</span> : null}
      {inherited.length ? (
        <button type="button" className="gx-hbtn" style={{ alignSelf: "flex-start" }} aria-expanded={showInherited} aria-controls="ws-rules-inherited" onClick={() => setShowInherited((v) => !v)}>
          {showInherited ? "Hide" : "Show"} {inherited.length} inherited{off ? ` · ${off} off` : ""}
        </button>
      ) : null}
      {showInherited ? <div id="ws-rules-inherited" style={{ display: "flex", flexDirection: "column" }}>{inherited.map(row)}</div> : null}
    </div>
  );
}
