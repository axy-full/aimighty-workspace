"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "@/lib/session";
import { creditRate, creditsText, creditsUsd } from "@/lib/shell/price-words";
import { useWorkspace } from "@/lib/workspace/state";
import { Row, Section } from "../parts";
import { useWrite } from "../use-settings";
import { budgetHelp, budgetLine, capHelp, capRow, digits, fieldPatch } from "./budget-words";
import type { SpendingLines, SpendingRules } from "./spending-words";

/**
 * Settings › Spending rules › Budget and cap (design Gaps B: `?view=workspace&ws=rules&edit=rules`, and `&role=member`).
 *
 *  - The budget per production (`productionBudgetCredits`: a production with no cap of its own follows it, and paid
 *    work stops to ask at `capWarnPct` of it) and the per-shot cap before an admin (the cost approval rule's cap).
 *  - An admin edits both; a field saves itself when it is left or Enter is pressed (PATCH /api/settings, the route's
 *    own admin-and-person check; the setting keeps who changed it last), never a figure still being typed. "Undo
 *    changes" puts back what was there when the panel opened; "Done" saves what is waiting and closes it.
 *  - A member reads the same figures, and "Ask an admin" tells the owner and admins (POST /api/workbench/ask-admin).
 *  - The platform line is fixed and shown read-only.
 * Roles are owner, admin and member only; limits are by role, never by person. Atomik and outside agents never change
 * these: the routes take a signed-in person only.
 */
type Rules = SpendingRules & SpendingLines & { budget: number | null; retry: () => void };
type Field = "budget" | "cap";

export function BudgetSection({ rules, openAtStart }: { rules: Rules; openAtStart: boolean }) {
  const session = useSession();
  const rate = creditRate(session.rates.creditUsd);
  const [open, setOpen] = useState(openAtStart);
  const canChange = rules.canChange;
  const loaded = rules.loaded;
  const cap = capRow(rules, creditsText);
  return (
    <Section label="Budget and cap" meta={canChange ? "admins only" : "only an admin can change these"} testId="settings-budget-cap"
      action={loaded ? (
        <button type="button" className={canChange ? "gs-primary" : "gs-btn"} onClick={() => setOpen(true)} data-testid="settings-budget-open">{canChange ? "Edit" : "View"}</button>
      ) : null}>
      <Row name="Budget per production" line={loaded ? budgetLine({ budget: rules.budget, warnPct: rules.capWarnPct }, creditsText) : undefined}
        value={loaded ? (rules.budget != null ? creditsText(rules.budget) : "none") : "Reading…"} valueTitle={rules.budget != null ? creditsUsd(rules.budget, rate) : null} testId="settings-budget-value" />
      <Row name="Before an admin" line={loaded ? cap.line : undefined} value={loaded ? cap.value : "Reading…"}
        valueTitle={rules.rule === "cap" && rules.shotCap != null ? creditsUsd(rules.shotCap, rate) : null} testId="settings-cap-value" />
      {open && loaded ? <BudgetPanel rules={rules} onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

function BudgetPanel({ rules, onClose }: { rules: Rules; onClose: () => void }) {
  const write = useWrite();
  const { toast } = useWorkspace();
  const canChange = rules.canChange;
  /* What was there when the panel opened: Undo changes writes it back. */
  const [before] = useState(() => ({
    productionBudgetCredits: rules.budget == null ? "" : String(rules.budget),
    approvalRule: rules.rule ?? "anyone",
    ...(rules.shotCap != null ? { shotCapCredits: String(rules.shotCap) } : {}),
  }));
  const [text, setText] = useState<Record<Field, string>>(() => ({
    budget: rules.budget == null ? "" : String(rules.budget),
    cap: rules.rule === "cap" && rules.shotCap != null ? String(rules.shotCap) : "",
  }));
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "problem"; text: string }>({ kind: "idle", text: "" });
  const [changed, setChanged] = useState(false);
  const [asking, setAsking] = useState(false);
  /* What was typed and not saved yet, by field: it saves when the field is left, on Enter, or on Done. */
  const pending = useRef<Partial<Record<Field, string>>>({});
  const panel = useRef<HTMLDivElement>(null);

  const save = useCallback(async (field: Field, value: string) => {
    const result = fieldPatch(field, value, rules.rule);
    if ("problem" in result) { setState({ kind: "problem", text: result.problem }); return; }
    setState({ kind: "saving", text: "Saving…" });
    const { error } = await write("/api/settings", "PATCH", result.patch);
    if (error) { setState({ kind: "problem", text: error }); return; }
    setChanged(true);
    setState({ kind: "saved", text: "Saved · last changed by you" });
    rules.retry();
  }, [rules, write]);

  const type = (field: Field, raw: string) => {
    const value = digits(raw);
    setText((t) => ({ ...t, [field]: value }));
    pending.current[field] = value;
    if (state.kind !== "saving") setState({ kind: "idle", text: "" });
  };
  /* One field's typed figure, saved once: when it is left, on Enter, or on Done. */
  const commit = useCallback(async (field: Field) => {
    if (!(field in pending.current)) return;
    const value = pending.current[field]!;
    delete pending.current[field];
    await save(field, value);
  }, [save]);
  /* Whatever is still waiting to save goes now (Done, Escape). */
  const flush = useCallback(async () => {
    for (const field of Object.keys(pending.current) as Field[]) await commit(field);
  }, [commit]);
  const done = useCallback(() => { void flush().then(onClose); }, [flush, onClose]);
  const doneRef = useRef(done);
  useEffect(() => { doneRef.current = done; }, [done]);
  /* Once, when it opens: focus its first field; Escape is Done (or Close). Saves still waiting go before it closes. */
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input:not([disabled]), button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") doneRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);

  const undo = async () => {
    pending.current = {};
    setState({ kind: "saving", text: "Putting it back…" });
    const { error } = await write("/api/settings", "PATCH", before);
    if (error) { setState({ kind: "problem", text: error }); return; }
    setText({ budget: before.productionBudgetCredits, cap: before.approvalRule === "cap" && before.shotCapCredits ? before.shotCapCredits : "" });
    setChanged(false);
    setState({ kind: "saved", text: "Put back as it was." });
    rules.retry();
  };
  const ask = async () => {
    if (asking) return;
    setAsking(true);
    const { json, error } = await write<{ line: string }>("/api/workbench/ask-admin", "POST", { about: "rules" });
    setAsking(false);
    toast(error ?? json?.line ?? "Asked.");
  };

  const shown = {
    budget: text.budget === "" ? null : Number(text.budget),
    cap: text.cap === "" ? null : Number(text.cap),
  };
  const view = { budget: shown.budget, warnPct: rules.capWarnPct, rule: canChange ? (rules.rule === "producer" ? "producer" as const : shown.cap != null ? "cap" as const : "anyone" as const) : rules.rule, shotCap: shown.cap };
  return createPortal(
    <div className="gs-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) done(); }} data-testid="settings-budget-panel-back">
      <div className="gs-sheet" role="dialog" aria-modal="true" aria-labelledby="gs-budget-title" ref={panel} data-testid="settings-budget-panel">
        <h3 className="gs-sheet-title" id="gs-budget-title">Budget and cap</h3>
        <p className="gs-sheet-line">{canChange ? "Admins only. A field saves when you leave it or press Enter." : "Only an admin can change these. Ask the owner or an admin."}</p>
        <label className="gs-label"><span className="gs-eyebrow">Budget per production</span>
          <span className="gs-unit">
            <input className="gs-field" inputMode="numeric" value={text.budget} placeholder="none" readOnly={!canChange} aria-readonly={!canChange || undefined}
              onChange={(e) => type("budget", e.target.value)} onBlur={() => void commit("budget")}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit("budget"); } }} data-testid="settings-budget-field" />
            <span className="gs-unit-word">cr</span>
          </span>
          <span className="gs-row-line">{budgetHelp(view, creditsText)}</span>
        </label>
        <label className="gs-label"><span className="gs-eyebrow">Before an admin</span>
          <span className="gs-unit">
            <input className="gs-field" inputMode="numeric" value={text.cap} placeholder="off" readOnly={!canChange || rules.rule === "producer"} aria-readonly={!canChange || rules.rule === "producer" || undefined}
              onChange={(e) => type("cap", e.target.value)} onBlur={() => void commit("cap")}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit("cap"); } }} data-testid="settings-cap-field" />
            <span className="gs-unit-word">cr a shot</span>
          </span>
          <span className="gs-row-line">{capHelp(view)}</span>
        </label>
        <label className="gs-label"><span className="gs-eyebrow">Platform line</span>
          <span className="gs-unit">
            <input className="gs-field" value={rules.platformLine != null ? String(rules.platformLine) : ""} disabled aria-readonly data-testid="settings-line-field" />
            <span className="gs-unit-word">cr a job</span>
          </span>
          <span className="gs-row-line">{rules.platformLineText ? `${rules.platformLineText} Fixed.` : "Fixed."}</span>
        </label>
        <div className="gs-sheet-foot">
          <span className="gs-sheet-state" role="status" data-tone={state.kind} data-testid="settings-budget-state">{state.text}</span>
          {canChange ? (
            <>
              <button type="button" className="gs-btn" disabled={!changed || state.kind === "saving"} onClick={() => void undo()} data-testid="settings-budget-undo">Undo changes</button>
              <button type="button" className="gs-primary" onClick={done} data-testid="settings-budget-done">Done</button>
            </>
          ) : (
            <>
              <button type="button" className="gs-btn" onClick={onClose} data-testid="settings-budget-close">Close</button>
              <button type="button" className="gs-primary" disabled={asking} onClick={() => void ask()} data-testid="settings-budget-ask">{asking ? "Asking…" : "Ask an admin"}</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
