"use client";
import { useState } from "react";
import { RULE_SCOPES, RULE_SCOPE_LABELS, type RuleApply, type RuleScope } from "@/lib/platformLayer";
import { useRead, useWrite } from "@/components/graphite/settings/use-settings";
import { Tooltip } from "../../ui";
import { Note, Problem, Sec } from "./parts";

/**
 * Settings › Style rules: house style for every prompt in this workspace, after Particl's own rules. GET /api/rules lists both;
 * an admin writes, edits and removes the workspace's own, and switches Particl's on or off here (the routes are admin-only and
 * work on this workspace alone). "For the writer" shapes how Enhance rewrites a prompt; "In the prompt" is added to what the
 * engine receives.
 */
type Rule = { id: string; text: string; scope: RuleScope; apply: RuleApply; on: boolean; source: "platform" | "workspace" };

export function StyleRules() {
  const write = useWrite();
  const { data, error, read } = useRead<{ rules: Rule[] }>("/api/rules");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [inherited, setInherited] = useState(false);
  const rules = data?.rules ?? [];
  const mine = rules.filter((r) => r.source === "workspace");
  const platform = rules.filter((r) => r.source !== "workspace");
  const act = async (key: string, url: string, method: string, body?: unknown) => {
    setBusy(key); setNote(null); setRemoving(null);
    const { error: refused } = await write(url, method, body);
    setBusy(null);
    if (refused) { setNote(refused); return false; }
    await read();
    return true;
  };
  const at = (r: Rule) => `/api/rules/${encodeURIComponent(r.id)}`;
  const add = async () => { const next = text.trim(); if (next && await act("add", "/api/rules", "POST", { text: next, scope: "all", apply: "prompt" })) setText(""); };
  return (
    <Sec testId="v12-settings-rules">
      {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <div className="v12-ws-empty">Reading…</div> : null}
      {mine.length ? <div className="v12-ws-rule v12-ws-rule-head" aria-hidden="true"><span>Scope</span><span>Rule</span><span>Applies</span><span /></div> : null}
      {mine.map((r) => (
        <div key={r.id} className="v12-ws-rule" data-testid="v12-settings-rule" data-source="workspace">
          <select className="v12-ws-select" aria-label="Scope" value={r.scope} disabled={busy != null} onChange={(e) => void act(r.id, at(r), "PATCH", { scope: e.target.value })}>
            {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
          </select>
          <input className="v12-ws-field" defaultValue={r.text} maxLength={400} aria-label="Rule" disabled={busy != null} placeholder="Type the rule"
            onBlur={(e) => { const next = e.target.value.trim(); if (next && next !== r.text) void act(r.id, at(r), "PATCH", { text: next }); }} />
          <select className="v12-ws-select" aria-label="Applies to" value={r.apply} disabled={busy != null} onChange={(e) => void act(r.id, at(r), "PATCH", { apply: e.target.value })}>
            <option value="writer">For the writer</option><option value="prompt">In the prompt</option>
          </select>
          <Tooltip name={removing === r.id ? "Press again to remove it" : "Remove this rule"} named>
            <button type="button" className={`v12-ws-btn ${removing === r.id ? "v12-ws-btn-danger" : "v12-ws-btn-quiet"}`} disabled={busy != null} aria-label={removing === r.id ? "Remove this rule now" : "Remove this rule"}
              onClick={() => (removing === r.id ? void act(r.id, at(r), "DELETE") : setRemoving(r.id))} data-testid="v12-settings-rule-remove">×</button>
          </Tooltip>
        </div>
      ))}
      {data && !mine.length ? <div className="v12-ws-empty">No rules of your own yet.</div> : null}
      <form className="v12-ws-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="v12-ws-field" value={text} maxLength={400} placeholder="A rule, as one sentence" aria-label="New rule" onChange={(e) => setText(e.target.value)} data-testid="v12-settings-rule-text" />
        <button type="submit" className="v12-ws-btn" disabled={!text.trim() || busy != null} data-testid="v12-settings-rule-add">+ Rule</button>
      </form>
      {platform.length ? <button type="button" className="v12-ws-more" onClick={() => setInherited((v) => !v)} aria-expanded={inherited} data-testid="v12-settings-rules-inherited">{inherited ? "Hide" : "Show"} {platform.length} of Particl’s own</button> : null}
      {inherited ? platform.map((r) => (
        <div key={r.id} className="v12-ws-rule" data-testid="v12-settings-rule" data-source="platform">
          <span className="v12-ws-quiet">{RULE_SCOPE_LABELS[r.scope]}</span>
          <span>{r.text}</span>
          <span className="v12-ws-quiet">{r.apply === "writer" ? "For the writer" : "In the prompt"}</span>
          <button type="button" role="switch" aria-checked={r.on} className="v12-ws-btn" disabled={busy != null} onClick={() => void act(r.id, at(r), "PATCH", { on: !r.on })} data-testid="v12-settings-rule-toggle">{r.on ? "On" : "Off"}</button>
        </div>
      )) : null}
      {note ? <Note ok={false} text={note} /> : null}
      <div className="v12-ws-row-line" style={{ paddingTop: 8 }}>These apply to this workspace only, after Particl’s own rules.</div>
    </Sec>
  );
}
