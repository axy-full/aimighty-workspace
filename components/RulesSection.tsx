"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { RULE_SCOPES, RULE_SCOPE_LABELS, type EffectiveRule } from "@/lib/platformLayer";

/**
 * The rule library, in Studio (brief 2.5): what the compiler adds to every
 * prompt in scope. Platform rules are inherited and can be switched off
 * here; the team's own are written here. Every rule shows its source.
 */
export default function RulesSection({ signedIn }: { signedIn: boolean }) {
  const { data, refresh } = useApi<{ rules: EffectiveRule[] }>(signedIn ? "/api/rules" : null, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const rules = data?.rules ?? [];

  async function send(path: string, method: string, body?: unknown) {
    setBusy(path);
    try {
      const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      refresh();
    } catch (e) { await appAlert("Not saved", (e as Error).message); }
    finally { setBusy(null); }
  }

  async function add() {
    const text = await appPrompt("A rule, as one sentence", "", "Our brand never shows logos in the first frame.");
    if (!text?.trim()) return;
    await send("/api/rules", "POST", { text: text.trim(), scope: "all", apply: "prompt" });
  }

  return (
    <div className="st-sec" id="rules">
      <div className="st-sec-head">
        <span className="st-h">Rules</span>
        <span className="st-sub">Added to every prompt in scope. Platform rules are inherited; switch one off here if the team disagrees.</span>
      </div>
      {!signedIn ? <p className="rail-help">Sign in to read the rules.</p> : !data ? <p className="rail-help">Opening…</p> : (
        <div className="flex flex-col gap-1.5">
          {rules.map((r) => {
            const own = r.source === "workspace";
            return (
              <div key={r.id} className={`grid items-center gap-2 rounded-[7px] border border-line px-2.5 py-1.5 md:grid-cols-[auto_84px_150px_120px_1fr_auto] ${r.on ? "" : "opacity-60"}`}>
                <input type="checkbox" checked={r.on} aria-label={r.on ? "Switch off" : "Switch on"} disabled={busy != null}
                  onChange={(e) => send(`/api/rules/${encodeURIComponent(r.id)}`, "PATCH", { on: e.target.checked })} />
                <span className="mono-s" title={own ? "Written here" : "Inherited from the platform"}>{own ? "WORKSPACE" : "PLATFORM"}</span>
                {own ? (
                  <select className="ctl !h-8 !text-[13px]" value={r.scope} aria-label="Scope" disabled={busy != null}
                    onChange={(e) => send(`/api/rules/${encodeURIComponent(r.id)}`, "PATCH", { scope: e.target.value })}>
                    {RULE_SCOPES.map((s) => <option key={s} value={s}>{RULE_SCOPE_LABELS[s]}</option>)}
                  </select>
                ) : <span className="text-[12.5px] text-mute">{RULE_SCOPE_LABELS[r.scope]}</span>}
                {own ? (
                  <select className="ctl !h-8 !text-[13px]" value={r.apply} aria-label="Applies to" disabled={busy != null}
                    onChange={(e) => send(`/api/rules/${encodeURIComponent(r.id)}`, "PATCH", { apply: e.target.value })}>
                    <option value="writer">for the writer</option><option value="prompt">in the prompt</option>
                  </select>
                ) : <span className="text-[12.5px] text-mute">{r.apply === "writer" ? "for the writer" : "in the prompt"}</span>}
                {own ? (
                  <input className="ctl !h-8 !text-[13px]" defaultValue={r.text} aria-label="Rule" disabled={busy != null}
                    onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== r.text) void send(`/api/rules/${encodeURIComponent(r.id)}`, "PATCH", { text: e.target.value }); }} />
                ) : <span className="text-[13px] text-ink">{r.text}</span>}
                {own ? (
                  <button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy != null}
                    onClick={async () => { if (await appConfirm("Remove this rule?", r.text)) void send(`/api/rules/${encodeURIComponent(r.id)}`, "DELETE"); }}>Remove</button>
                ) : <span />}
              </div>
            );
          })}
          <div><button type="button" className="chip !py-0.5 !text-[11.5px]" disabled={busy != null} onClick={add}>+ Rule</button></div>
        </div>
      )}
    </div>
  );
}
