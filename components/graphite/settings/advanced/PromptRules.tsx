"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { RULE_SCOPES, RULE_SCOPE_LABELS, type RuleApply, type RuleScope } from "@/lib/platformLayer";
import { Btn, Note, Problem, Row } from "../parts";
import { useRead, useWrite } from "../use-settings";

/**
 * Prompt rules (GET /api/rules, lib/platformLayer.ts EffectiveRule): sentences added to every prompt in scope. Everyone
 * reads them; only an admin changes them (the routes answer anyone else 403). The platform's own rules switch off or
 * on; the team's edit in full. A removed rule is archived (lib/rules.ts deleteRule), never erased: the second press confirms.
 */
type Rule = { id: string; text: string; scope: RuleScope; apply: RuleApply; on: boolean; source: "platform" | "workspace" };

export function PromptRules() {
  const session = useSession();
  const admin = session.role === "admin" || session.role === "owner";
  const write = useWrite();
  const { data, error, read } = useRead<{ rules: Rule[] }>("/api/rules");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [inherited, setInherited] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const rules = data?.rules ?? [];
  const mine = rules.filter((r) => r.source === "workspace");
  const platform = rules.filter((r) => r.source !== "workspace");
  const off = platform.filter((r) => !r.on).length;
  const act = async (key: string, url: string, method: string, body?: unknown) => {
    setBusy(key); setNote(null); setRemoving(null);
    const { error: refused } = await write(url, method, body);
    setBusy(null);
    if (refused) { setNote(refused); return false; }
    await read();
    return true;
  };
  const at = (r: Rule) => `/api/rules/${encodeURIComponent(r.id)}`;
  const row = (r: Rule) => {
    const own = r.source === "workspace";
    return (
      <div key={r.id} className="gs-rule" data-testid="settings-rule-row" data-source={r.source} data-on={r.on || undefined}>
        <button type="button" role="switch" className="gs-btn" aria-checked={r.on} aria-label={r.on ? "Switch this rule off" : "Switch this rule on"} disabled={!admin || busy != null}
          onClick={() => void act(r.id, at(r), "PATCH", { on: !r.on })} data-testid="settings-rule-toggle">{r.on ? "On" : "Off"}</button>
        {own && admin ? (
          <>
            <input className="gs-field gs-rule-text" defaultValue={r.text} maxLength={400} aria-label="Rule" disabled={busy != null}
              onBlur={(e) => { const next = e.target.value.trim(); if (next && next !== r.text) void act(r.id, at(r), "PATCH", { text: next }); }} />
            <select className="gs-sel" value={r.scope} aria-label="Scope" disabled={busy != null} onChange={(e) => void act(r.id, at(r), "PATCH", { scope: e.target.value })}>
              {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
            </select>
            <select className="gs-sel" value={r.apply} aria-label="Applies to" disabled={busy != null} onChange={(e) => void act(r.id, at(r), "PATCH", { apply: e.target.value })}>
              <option value="writer">for the writer</option><option value="prompt">in the prompt</option>
            </select>
            <Btn danger disabled={busy != null} onClick={() => (removing === r.id ? void act(r.id, at(r), "DELETE") : setRemoving(r.id))} testId="settings-rule-remove">{removing === r.id ? "Remove it" : "Remove"}</Btn>
          </>
        ) : (
          <span className="gs-rule-words">{r.text} <span className="gs-row-line">· {RULE_SCOPE_LABELS[r.scope]} · {r.apply === "writer" ? "for the writer" : "in the prompt"}</span></span>
        )}
      </div>
    );
  };
  const add = async () => {
    const next = text.trim();
    if (next && await act("add", "/api/rules", "POST", { text: next, scope: "all", apply: "prompt" })) setText("");
  };
  return (
    <div className="gs-rules-block" data-testid="settings-prompt-rules">
      <Row name="Prompt rules" line="Added to every prompt in scope." testId="settings-prompt-rules-head">
        {platform.length ? <Btn pressed={inherited} onClick={() => setInherited((v) => !v)} testId="settings-rules-inherited">{inherited ? "Hide" : "Show"} {platform.length} inherited{off ? ` · ${off} off` : ""}</Btn> : null}
      </Row>
      {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <Row name="Reading…" /> : null}
      {mine.map(row)}
      {admin ? (
        <form className="gs-capform" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="gs-field gs-rule-text" value={text} maxLength={400} placeholder="A rule, as one sentence" aria-label="New rule" onChange={(e) => setText(e.target.value)} data-testid="settings-rule-text" />
          <button type="submit" className="gs-btn" disabled={!text.trim() || busy != null} data-testid="settings-rule-add">Add rule</button>
        </form>
      ) : null}
      {inherited ? platform.map(row) : null}
      {note ? <Note ok={false} text={note} /> : null}
    </div>
  );
}
