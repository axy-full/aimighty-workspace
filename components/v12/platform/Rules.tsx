"use client";
import { useRef, useState } from "react";
import type { LayerKey, PlatformRule } from "@/lib/platformLayer";
import { RULE_SCOPES, RULE_SCOPE_LABELS, type RuleApply, type RuleScope } from "@/lib/ruleScopes";
import { IconButton, Segment, useToast } from "../ui";
import { adminSend, useAdminRead } from "./api";
import { Head, Switch } from "./parts";

type Layer = { layer: { rules: PlatformRule[] }; stored: LayerKey[] };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const newId = () => `rule-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/**
 * Style rules: what the prompt writer is told and what is added to a prompt, in order (lib/platformLayer.ts). Each change
 * saves as it is made, through the platform layer's own route (key `rules`); the server keeps only rules with words, in
 * order, at most forty. Removing one says so with an Undo.
 */
export function Rules() {
  const toast = useToast();
  const { data, refresh } = useAdminRead<Layer>("/api/admin/platform-layer", 0);
  const [edited, setRules] = useState<PlatformRule[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const focusNew = useRef<string | null>(null);
  /* What is on screen: the list being edited once an edit starts, until then the server's; every save sends the whole list. */
  const rules = edited ?? data?.layer.rules ?? null;

  async function save(next: PlatformRule[], said?: string) {
    setRules(next);
    const sent = await adminSend("/api/admin/platform-layer", "PATCH", { key: "rules", value: next.filter((r) => r.text.trim()) });
    if (!sent.ok) toast({ text: sent.error }); else if (said) toast({ text: said });
    refresh();
  }
  const change = (id: string, patch: Partial<PlatformRule>, saveNow = true) => {
    const next = (rules ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r));
    if (saveNow) void save(next); else setRules(next);
  };
  const move = (from: number, to: number) => {
    if (!rules || from === to || to < 0 || to >= rules.length) return;
    const next = [...rules]; const [r] = next.splice(from, 1); next.splice(to, 0, r);
    void save(next);
  };
  const remove = (r: PlatformRule) => {
    const before = rules ?? [];
    void save(before.filter((x) => x.id !== r.id));
    toast({ text: "Rule removed", action: { label: "Undo", run: () => void save(before) } });
  };
  const reset = async () => {
    const sent = await adminSend<{ layer: { rules: PlatformRule[] } }>("/api/admin/platform-layer", "PATCH", { key: "rules", reset: true });
    if (sent.ok) { setRules(sent.json.layer.rules); toast({ text: "Rules back to the defaults" }); } else toast({ text: sent.error });
    refresh();
  };

  return (
    <>
      <Head title="Style rules" line="House style, applied to every prompt on the platform.">
        {data?.stored.includes("rules") ? <button type="button" className="v12-pc-quiet" onClick={() => void reset()} data-testid="pc-rules-reset">Reset to defaults</button> : null}
      </Head>
      <div className="v12-pc-table" role="table" aria-label="Style rules" data-testid="pc-rules">
        <div className="v12-pc-tr v12-pc-th v12-pc-rulecols" role="row">
          <span role="columnheader" aria-label="Order" /><span role="columnheader">Scope</span><span role="columnheader">Where it applies</span><span role="columnheader">Rule</span><span role="columnheader" aria-label="On" /><span role="columnheader" aria-label="Remove" />
        </div>
        {(rules ?? []).map((r, i) => (
          <div key={r.id} role="row" className="v12-pc-tr v12-pc-rulecols" data-testid="pc-rule" data-over={over === r.id || undefined} data-off={!r.on || undefined}
            draggable={armed === r.id}
            onDragStart={(e) => { dragging.current = r.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }}
            onDragOver={(e) => { if (dragging.current && dragging.current !== r.id) { e.preventDefault(); setOver(r.id); } }}
            onDragLeave={() => setOver((o) => (o === r.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); const from = (rules ?? []).findIndex((x) => x.id === dragging.current); setOver(null); dragging.current = null; setArmed(null); move(from, i); }}
            onDragEnd={() => { dragging.current = null; setArmed(null); setOver(null); }}>
            <span role="cell">
              <IconButton tooltip={{ name: "Move rule", line: "Drag, or press ↑ ↓ here." }} size="sm" className="v12-pc-grip"
                onPointerDown={() => setArmed(r.id)} onPointerUp={() => setArmed(null)}
                onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); move(i, i - 1); } else if (e.key === "ArrowDown") { e.preventDefault(); move(i, i + 1); } }} data-testid="pc-rule-grip">
                <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden fill="currentColor"><circle cx="3.5" cy="3" r="1.2" /><circle cx="8.5" cy="3" r="1.2" /><circle cx="3.5" cy="7" r="1.2" /><circle cx="8.5" cy="7" r="1.2" /><circle cx="3.5" cy="11" r="1.2" /><circle cx="8.5" cy="11" r="1.2" /></svg>
              </IconButton>
            </span>
            <span role="cell">
              <button type="button" className="v12-pc-chip" data-scope={r.scope} onClick={() => change(r.id, { scope: RULE_SCOPES[(RULE_SCOPES.indexOf(r.scope) + 1) % RULE_SCOPES.length] as RuleScope })} title="Click to change where it applies" data-testid="pc-rule-scope">{cap(RULE_SCOPE_LABELS[r.scope])}</button>
            </span>
            <span role="cell">
              <Segment<RuleApply> label="Where it applies" size="sm" value={r.apply} onChange={(apply) => change(r.id, { apply })} options={[{ id: "writer", label: "For the writer" }, { id: "prompt", label: "In the prompt" }]} />
            </span>
            <span role="cell">
              <textarea className="v12-pc-ruletext" aria-label="Rule" rows={1} value={r.text} maxLength={400} placeholder="Write the rule" data-testid="pc-rule-text"
                ref={(el) => { if (el && focusNew.current === r.id) { focusNew.current = null; el.focus(); } }}
                onChange={(e) => change(r.id, { text: e.target.value.replace(/\n/g, " ") }, false)} onBlur={() => { if (r.text.trim()) void save(rules ?? []); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />
            </span>
            <span role="cell"><Switch on={r.on} label={`Rule ${i + 1} on`} onChange={(on) => change(r.id, { on })} /></span>
            <span role="cell" className="v12-pc-end">
              <IconButton tooltip={{ name: "Remove rule", line: "Undo is on the toast." }} size="sm" onClick={() => remove(r)} data-testid="pc-rule-remove">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </IconButton>
            </span>
          </div>
        ))}
      </div>
      <button type="button" className="v12-pc-btn v12-pc-addrule" onClick={() => { const id = newId(); focusNew.current = id; setRules([...(rules ?? []), { id, text: "", scope: "all", apply: "writer", on: true }]); }} data-testid="pc-rule-add">+ Rule</button>
      <p className="v12-pc-foot">Rules run top to bottom. “For the writer” shapes how Particl rewrites a prompt; “In the prompt” is added to what the engine receives.</p>
    </>
  );
}
