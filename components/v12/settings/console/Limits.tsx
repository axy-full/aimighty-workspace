"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { useRead, useWrite } from "@/components/graphite/settings/use-settings";
import { Note, Problem, Sec } from "./parts";

/**
 * Settings › Limits: keep spend in check. The spend cap per board (credits; blank is none) and where the warning starts, as a
 * share of that cap. One Save writes what changed (PATCH /api/settings, an admin's; each change leaves a line in the
 * workspace's history) and Reset puts both back to Particl's own. Caps apply to new work from now: a board's own cap still wins.
 * Limits are by role and by board, never by person. The house, which pays in dollars, has no credit cap to set.
 */
type Settings = { settings: Record<string, string>; defaults: Record<string, string> };

export function Limits() {
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const { data, error, read } = useRead<Settings>("/api/settings");
  const inCredits = session.rates.unit === "cr" && Boolean(session.credits);
  const saved = { budget: data?.settings.productionBudgetCredits ?? "", warn: data?.settings.capWarnPct ?? data?.defaults.capWarnPct ?? "80" };
  const [draft, setDraft] = useState<{ budget: string; warn: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const now = draft ?? saved;
  const dirty = Boolean(draft) && (now.budget !== saved.budget || now.warn !== saved.warn);

  const problem = (): string | null => {
    if (now.budget.trim() !== "" && !/^\d{1,7}$/.test(now.budget.trim())) return "The cap is a whole number of credits, or blank for none.";
    if (now.budget.trim() !== "" && Number(now.budget) < 1) return "The cap is a whole number of credits, 1 or more.";
    const w = Number(now.warn);
    if (!Number.isInteger(w) || w < 1 || w > 100) return "The warning is a whole percentage from 1 to 100.";
    return null;
  };
  const submit = async (next: { budget: string; warn: string }, said: string) => {
    const wrong = problem();
    if (wrong && next === now) { setNote({ ok: false, text: wrong }); return; }
    setBusy(true); setNote(null);
    const patch: Record<string, string> = {};
    if (next.budget !== saved.budget) patch.productionBudgetCredits = next.budget.trim();
    if (next.warn !== saved.warn) patch.capWarnPct = next.warn.trim();
    if (!Object.keys(patch).length) { setBusy(false); return; }
    const before = { productionBudgetCredits: saved.budget, capWarnPct: saved.warn };
    const { error: refused } = await write("/api/settings", "PATCH", patch);
    setBusy(false);
    if (refused) { setNote({ ok: false, text: refused }); return; }
    await read();
    /* What was typed while it saved is kept: only a draft still equal to what was sent is settled. */
    setDraft((typed) => (typed && (typed.budget !== now.budget || typed.warn !== now.warn) ? typed : next));
    toast(said, { label: "Undo", kind: "undo", run: () => { void write("/api/settings", "PATCH", before).then(async () => { await read(); setDraft(null); }); } });
  };

  if (!inCredits) return <Sec><div className="v12-ws-empty" data-testid="v12-settings-limits-house">This workspace is billed in dollars at the engines’ cost, so it has no credit caps to set.</div></Sec>;
  return (
    <Sec testId="v12-settings-limits">
      {error ? <Problem text={error} onRetry={() => void read()} /> : null}
      <div className="v12-ws-limit">
        <label htmlFor="v12-limit-board">Spend cap per board</label>
        <span className="v12-ws-num"><input id="v12-limit-board" type="text" inputMode="numeric" value={now.budget} placeholder="None" disabled={busy || !data} onChange={(e) => { setNote(null); setDraft({ ...now, budget: e.target.value.replace(/[^\d]/g, "") }); }} data-testid="v12-settings-limit-board" /><span>cr</span></span>
        <span className="v12-ws-row-line">A board stops to ask at its cap. Blank means no cap.</span>
      </div>
      <div className="v12-ws-limit">
        <label htmlFor="v12-limit-warn">Warn at</label>
        <span className="v12-ws-num"><input id="v12-limit-warn" type="text" inputMode="numeric" value={now.warn} disabled={busy || !data} onChange={(e) => { setNote(null); setDraft({ ...now, warn: e.target.value.replace(/[^\d]/g, "") }); }} data-testid="v12-settings-limit-warn" /><span>% of cap</span></span>
        <span className="v12-ws-row-line">Paid work on a board stops to ask at this share of its cap.</span>
      </div>
      <div className="v12-ws-form">
        <button type="button" className="v12-ws-btn v12-ws-btn-primary" disabled={busy || !dirty} onClick={() => void submit(now, "Limits saved.")} data-testid="v12-settings-limits-save">Save</button>
        <button type="button" className="v12-ws-btn" disabled={busy || !data} onClick={() => void submit({ budget: "", warn: data?.defaults.capWarnPct ?? "80" }, "Limits are back to Particl’s own.")} data-testid="v12-settings-limits-reset">Reset to defaults</button>
      </div>
      {note ? <Note ok={note.ok} text={note.text} testId="v12-settings-limits-note" /> : null}
    </Sec>
  );
}
