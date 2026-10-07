"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { creditRate, creditsText, creditsUsd } from "@/lib/shell/price-words";
import { APPROVAL_OPTIONS, AT_CAP_OPTIONS, CAP_WARN_OPTIONS, settingProblem } from "@/lib/settingValues";
import type { ApprovalRule } from "@/lib/approvalRule";
import { Btn, Fold, Note, Problem, Row, Section } from "../parts";
import { useRead, useWrite } from "../use-settings";
import { useSpendingRules } from "./spending";
import type { SettingsFold } from "@/lib/shell/settings";
import { BudgetSection } from "./BudgetSection";
import { atItsCap, capInput, productionLine, ruleValue, type ProductionBudget } from "./spending-words";

/**
 * Settings › Spending rules (README § 3.5, § 4 "Ask / Auto", "Spending rules"): the one place the workspace's
 * rules for who may press a paid step are read in full and changed (DECISIONS 1). The control room's Approvals
 * shows the same lines read-only, from `useSpendingRules()`, with a link here.
 *
 *  - Who may approve: the cost approval rule and its cap (limits are by role: members up to the cap, an admin
 *    above it), the platform line, and the workspace's warning and at-cap rules for a production's budget.
 *    A change saves itself through PATCH /api/settings (an admin's, with the route's own checks) and a toast
 *    with Undo; a member reads the same lines and "Only an admin changes these."
 *  - Spend without asking: Ask. Auto is chosen per Board run today; making it a workspace setting is money work
 *    for the owner, so there is no switch here (DECISIONS 1).
 *
 * Nothing here spends, approves or prices. People only: Atomik and outside agents never change these.
 */
export function RulesSection({ open = null }: { open?: SettingsFold | null } = {}) {
  const rules = useSpendingRules();
  /* `&open=budget` opens Budget and cap's panel (the design's `&edit=rules` frame). */
  const openAtStart = open === "budget";
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const [editing, setEditing] = useState<"rule" | "budget" | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const pressing = useRef(false);
  const rate = creditRate(session.rates.creditUsd);
  const inCredits = session.rates.unit !== "usd";

  /* One save at a time; the route checks the values again, and the toast's Undo writes the old ones back. */
  const save = async (values: Record<string, string>, before: Record<string, string>, said: string) => {
    if (pressing.current) return;
    for (const [key, value] of Object.entries(values)) {
      const problem = settingProblem(key, value);
      if (problem) { setNote({ ok: false, text: problem }); return; }
    }
    pressing.current = true; setBusy(true); setNote(null);
    const { error } = await write("/api/settings", "PATCH", values);
    pressing.current = false; setBusy(false);
    if (error) { setNote({ ok: false, text: error }); return; }
    rules.retry();
    toast(said, {
      label: "Undo", kind: "undo",
      run: () => { void write("/api/settings", "PATCH", before).then(({ error: refused }) => { if (refused) toast(refused); else { rules.retry(); toast("Put back."); } }); },
    });
  };

  const ruleBefore = (): Record<string, string> => ({ approvalRule: rules.rule ?? "anyone", ...(rules.shotCap != null ? { shotCapCredits: String(rules.shotCap) } : {}) });
  const chooseRule = (next: ApprovalRule) => {
    if (next === rules.rule) return;
    void save({ approvalRule: next }, ruleBefore(), `Spending rule: ${APPROVAL_OPTIONS.find(([v]) => v === next)?.[1] ?? next}.`);
  };
  const setShotCap = () => {
    const n = capInput(cap ?? String(rules.shotCap ?? ""));
    if (n === null) { setNote({ ok: false, text: "The cap is a whole number of credits, 1 or more." }); return; }
    void save({ shotCapCredits: String(n) }, ruleBefore(), `Members may take up to ${creditsText(n)} a shot.`).then(() => setCap(null));
  };
  const budgetBefore = (): Record<string, string> => ({ capWarnPct: String(rules.capWarnPct ?? 80), atCap: rules.atCap ?? "producer" });

  const canChange = rules.canChange;
  const loaded = rules.loaded;
  const ruleValueText = loaded ? ruleValue(rules, creditsText) : rules.error ? "—" : "Reading…";

  return (
    <>
      <BudgetSection rules={rules} openAtStart={openAtStart} />
      <Section label="Who may approve" meta="people only · Atomik never approves" testId="settings-approve">
        {rules.error ? <Problem text={rules.error} onRetry={rules.retry} testId="settings-rules-error" /> : null}
        <Row name="Rule" line={loaded ? rules.ruleLine ?? undefined : undefined} value={ruleValueText} valueTitle={loaded && rules.rule === "cap" && rules.shotCap != null ? creditsUsd(rules.shotCap, rate) : null} testId="settings-rule">
          {canChange && loaded ? <Btn pressed={editing === "rule"} onClick={() => setEditing(editing === "rule" ? null : "rule")} testId="settings-rule-change">Change</Btn> : null}
        </Row>
        {editing === "rule" && canChange ? (
          <div className="gs-edit" data-testid="settings-rule-edit">
            <div className="gs-choice gs-choice-wrap" role="radiogroup" aria-label="Who may approve">
              {APPROVAL_OPTIONS.map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={rules.rule === id} className="gs-btn" disabled={busy}
                  onClick={() => chooseRule(id)} data-testid={`settings-rule-${id}`}>{label}</button>
              ))}
            </div>
            {rules.rule === "cap" ? (
              <form className="gs-capform" onSubmit={(e) => { e.preventDefault(); setShotCap(); }}>
                <label className="gs-label"><span className="gs-eyebrow">A shot may take, before an admin presses (cr)</span>
                  <input className="gs-field" inputMode="numeric" value={cap ?? String(rules.shotCap ?? "")} onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))} data-testid="settings-shot-cap" />
                </label>
                <button type="submit" className="gs-btn" data-hot disabled={busy || cap === null || cap === String(rules.shotCap ?? "")} data-testid="settings-shot-cap-set">Set cap</button>
              </form>
            ) : null}
            <p className="gs-row-line">Limits are by role, not by person: every member follows the rule, and an admin may press above it.</p>
          </div>
        ) : null}
        <Row name="Platform line" line={rules.platformLineText ?? undefined} value={rules.platformLine != null ? creditsText(rules.platformLine) : "—"}
          valueTitle={rules.platformLine != null ? creditsUsd(rules.platformLine, rate) : null} testId="settings-platform-line" />
        <Row name="At a production’s budget" line={loaded ? rules.budgetLine ?? undefined : undefined} testId="settings-budget">
          {canChange && loaded ? <Btn pressed={editing === "budget"} onClick={() => setEditing(editing === "budget" ? null : "budget")} testId="settings-budget-change">Change</Btn> : null}
        </Row>
        {editing === "budget" && canChange ? (
          <div className="gs-edit" data-testid="settings-budget-edit">
            <span className="gs-eyebrow">Ask at</span>
            <div className="gs-choice gs-choice-wrap" role="radiogroup" aria-label="Ask at">
              {[...CAP_WARN_OPTIONS, ...(rules.capWarnPct != null && !CAP_WARN_OPTIONS.some(([v]) => v === String(rules.capWarnPct)) ? [[String(rules.capWarnPct), `${rules.capWarnPct}% of the cap`] as const] : [])].map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={String(rules.capWarnPct) === id} className="gs-btn" disabled={busy}
                  onClick={() => { if (String(rules.capWarnPct) !== id) void save({ capWarnPct: id }, budgetBefore(), `Auto drafts ask at ${id}% of a production’s budget.`); }} data-testid={`settings-warn-${id}`}>{label}</button>
              ))}
            </div>
            <span className="gs-eyebrow">At a production’s cap</span>
            <div className="gs-choice gs-choice-wrap" role="radiogroup" aria-label="At a production’s cap">
              {AT_CAP_OPTIONS.map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={rules.atCap === id} className="gs-btn" disabled={busy}
                  onClick={() => { if (rules.atCap !== id) void save({ atCap: id }, budgetBefore(), `At a production’s cap: ${label.toLowerCase()}.`); }} data-testid={`settings-atcap-${id}`}>{label}</button>
              ))}
            </div>
          </div>
        ) : null}
        {!canChange && loaded ? <Row name="Only an admin changes these." testId="settings-rules-readonly" /> : null}
        {note ? <Note ok={note.ok} text={note.text} testId="settings-rules-note" /> : null}
      </Section>

      <Section label="Spend without asking" meta="Ask" testId="settings-auto">
        <Row name="Every paid step waits for a person." line={rules.autoLine ?? undefined} value="Ask" accent testId="settings-mode" />
      </Section>

      {inCredits ? <Productions canChange={canChange} budget={rules.budget} /> : null}
    </>
  );
}

/** Each production's own cap, as Atomik › Budget had it: a number of credits, and the unlock past it. An admin's, on the same route. */
function Productions({ canChange, budget: rulesBudget }: { canChange: boolean; budget: number | null }) {
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const [shown, setShown] = useState(false);
  const { data, error, read } = useRead<{ unit?: string; projects: ProductionBudget[] }>(shown ? "/api/projects" : null);
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const rate = creditRate(session.rates.creditUsd);
  const rows = data?.projects ?? [];

  const patch = async (p: ProductionBudget, body: Record<string, unknown>, before: Record<string, unknown>, said: string) => {
    if (busy) return;
    setBusy(p.id); setNote(null);
    const { error: refused } = await write(`/api/projects/${encodeURIComponent(p.id)}`, "PATCH", body);
    setBusy(null);
    /* A refusal (say "The cap changed …: look again") reads the list again, so the row shows what the server holds. */
    if (refused) { setNote({ ok: false, text: refused }); void read(); return; }
    setEdit(null);
    void read();
    toast(said, { label: "Undo", kind: "undo", run: () => { void write(`/api/projects/${encodeURIComponent(p.id)}`, "PATCH", before).then(({ error: no }) => { if (no) toast(no); void read(); }); } });
  };
  /* A new budget (Budget and cap above) changes every production that follows it: read the list again. */
  const firstBudget = useRef(rulesBudget);
  useEffect(() => {
    if (firstBudget.current === rulesBudget) return;
    firstBudget.current = rulesBudget;
    if (shown) void read();
  }, [rulesBudget, shown, read]);
  const setCap = (p: ProductionBudget) => {
    const raw = (edit?.value ?? "").trim();
    const n = raw === "" ? null : capInput(raw, true);
    if (raw !== "" && n === null) { setNote({ ok: false, text: "A cap is a whole number of credits, or none." }); return; }
    void patch(p, { capCredits: n }, { capCredits: p.ownCapCredits ?? (p.capFrom === "workspace" ? null : p.capCredits) ?? null },
      n === null ? `${p.name}: no cap of its own${p.capFrom === "workspace" || rulesBudget != null ? "; it follows the workspace budget" : ""}.` : `${p.name}: capped at ${creditsText(n)}.`);
  };

  return (
    <Fold label="Each production" meta="a cap in credits, set by an admin" open={shown} onToggle={() => setShown((v) => !v)} testId="settings-fold-productions">
      {error ? <Problem text={error} onRetry={() => void read()} /> : !data ? <Row name="Reading productions…" /> : null}
      {rows.map((p) => {
        const line = productionLine(p, creditsText);
        const editing = edit?.id === p.id;
        const own = p.ownCapCredits !== undefined ? p.ownCapCredits : p.capCredits;
        return (
          <div key={p.id} data-testid="settings-production">
            <Row name={p.name} line={line.sub} value={line.value} valueTitle={p.capCredits != null ? creditsUsd(p.capCredits, rate) : null}>
              {canChange ? <Btn disabled={busy != null} pressed={editing} onClick={() => setEdit(editing ? null : { id: p.id, value: own == null ? "" : String(own) })} testId="settings-production-change">{own == null && p.capFrom === "workspace" ? "Set own cap" : "Change"}</Btn> : null}
              {/* Unlock wherever the gate can refuse at the cap, its own or the workspace budget; Lock again takes it back. */}
              {canChange && atItsCap(p) && !p.capUnlocked ? (
                <Btn hot disabled={busy != null} onClick={() => void patch(p, { capUnlocked: true, forCap: p.capCredits }, { capUnlocked: false }, `${p.name} is unlocked past its cap of ${creditsText(p.capCredits!)}.`)} testId="settings-production-unlock">Unlock</Btn>
              ) : null}
              {canChange && p.capUnlocked ? (
                <Btn disabled={busy != null} onClick={() => void patch(p, { capUnlocked: false }, { capUnlocked: true, forCap: p.capCredits }, `${p.name} is locked at its cap again.`)} testId="settings-production-lock">Lock again</Btn>
              ) : null}
            </Row>
            {editing ? (
              <form className="gs-capform" onSubmit={(e) => { e.preventDefault(); setCap(p); }} data-testid="settings-production-edit">
                <label className="gs-label"><span className="gs-eyebrow">{rulesBudget != null ? "Own cap (cr), empty to follow the workspace budget" : "Cap (cr), empty for none"}</span>
                  <input className="gs-field" inputMode="numeric" value={edit.value} onChange={(e) => setEdit({ id: p.id, value: e.target.value.replace(/[^0-9]/g, "") })} data-testid="settings-production-cap" />
                </label>
                <button type="submit" className="gs-btn" data-hot disabled={busy != null} data-testid="settings-production-save">Save cap</button>
              </form>
            ) : null}
          </div>
        );
      })}
      {data && !rows.length ? <Row name="No productions yet." /> : null}
      {!canChange && data ? <Row name="An admin changes a production’s cap." /> : null}
      {note ? <Note ok={note.ok} text={note.text} testId="settings-productions-note" /> : null}
    </Fold>
  );
}
