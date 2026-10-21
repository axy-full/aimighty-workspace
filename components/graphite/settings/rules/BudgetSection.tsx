"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "@/lib/session";
import { creditRate, creditsText, creditsUsd } from "@/lib/shell/price-words";
import { useWorkspace } from "@/lib/workspace/state";
import { Row, Section } from "../parts";
import { useWrite } from "../use-settings";
import { NOT_ENFORCED, budgetHelp, budgetLine, budgetPatch, digits } from "./budget-words";
import type { SpendingLines, SpendingRules } from "./spending-words";

/**
 * Settings › Spending rules › Budget and cap (design Gaps B: `?view=workspace&ws=rules&edit=rules`, and `&role=member`).
 *
 *  - The budget per production (`productionBudgetCredits`: a production with no cap of its own follows it, and the
 *    producer is warned at `capWarnPct` of it). The per-shot cap field went with the cost approval rule on
 *    21 Oct 2026 (owner: "every member approves their own spend with their own tap on the quote").
 *  - An admin edits it; the field saves itself when it is left or Enter is pressed (PATCH /api/settings, the route's
 *    own admin-and-person check; the setting keeps who changed it last), never a figure still being typed. "Undo
 *    changes" puts back what was there when the panel opened; "Done" saves what is waiting and closes it.
 *  - A member reads the same figure, and "Ask an admin" tells the owner and admins (POST /api/workbench/ask-admin).
 *  - No platform per-job line: it was retired on 20 October 2026 (owner), so none is shown.
 * Roles are owner, admin and member only; limits are by role, never by person. Atomik and outside agents never change
 * these: the routes take a signed-in person only.
 */
type Rules = SpendingRules & SpendingLines & { budget: number | null; retry: () => void };

export function BudgetSection({ rules, openAtStart }: { rules: Rules; openAtStart: boolean }) {
  const session = useSession();
  const rate = creditRate(session.rates.creditUsd);
  /* The house workspace is not billed in credits: nothing enforces a budget there, so none is offered. */
  const inCredits = session.rates.unit !== "usd";
  const [open, setOpen] = useState(openAtStart);
  const canChange = rules.canChange;
  const loaded = rules.loaded;
  return (
    <Section label="Budget and cap" meta={canChange ? "admins only" : "only an admin can change these"} testId="settings-budget-cap"
      action={loaded ? (
        <button type="button" className={canChange ? "gs-primary" : "gs-btn"} onClick={() => setOpen(true)} data-testid="settings-budget-open">{canChange ? "Edit" : "View"}</button>
      ) : null}>
      {inCredits ? (
        <Row name="Budget per production" line={loaded ? budgetLine({ budget: rules.budget, warnPct: rules.capWarnPct }, creditsText) : undefined}
          value={loaded ? (rules.budget != null ? creditsText(rules.budget) : "none") : "Reading…"} valueTitle={rules.budget != null ? creditsUsd(rules.budget, rate) : null} testId="settings-budget-value" />
      ) : <Row name="Budget per production" line={NOT_ENFORCED} value="—" testId="settings-budget-value" />}
      {open && loaded ? <BudgetPanel rules={rules} inCredits={inCredits} onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

function BudgetPanel({ rules, inCredits, onClose }: { rules: Rules; inCredits: boolean; onClose: () => void }) {
  const write = useWrite();
  const { toast } = useWorkspace();
  const canChange = rules.canChange;
  /* What was there when the panel opened: Undo changes writes it back. */
  const [before] = useState(() => ({ productionBudgetCredits: rules.budget == null ? "" : String(rules.budget) }));
  const [text, setText] = useState(() => (rules.budget == null ? "" : String(rules.budget)));
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "problem"; text: string }>({ kind: "idle", text: "" });
  const [changed, setChanged] = useState(false);
  const [asking, setAsking] = useState(false);
  /* What was typed and not saved yet: it saves when the field is left, on Enter, or on Done. */
  const pending = useRef<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const save = useCallback(async (value: string) => {
    const result = budgetPatch(value);
    if ("problem" in result) { setState({ kind: "problem", text: result.problem }); return; }
    setState({ kind: "saving", text: "Saving…" });
    const { error } = await write("/api/settings", "PATCH", result.patch);
    if (error) { setState({ kind: "problem", text: error }); return; }
    setChanged(true);
    setState({ kind: "saved", text: "Saved · last changed by you" });
    rules.retry();
  }, [rules, write]);

  const type = (raw: string) => {
    const value = digits(raw);
    setText(value);
    pending.current = value;
    if (state.kind !== "saving") setState({ kind: "idle", text: "" });
  };
  /* The typed figure, saved once: when the field is left, on Enter, or on Done (and Escape). */
  const commit = useCallback(async () => {
    if (pending.current === null) return;
    const value = pending.current;
    pending.current = null;
    await save(value);
  }, [save]);
  const done = useCallback(() => { void commit().then(onClose); }, [commit, onClose]);
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
    pending.current = null;
    setState({ kind: "saving", text: "Putting it back…" });
    const { error } = await write("/api/settings", "PATCH", before);
    if (error) { setState({ kind: "problem", text: error }); return; }
    setText(before.productionBudgetCredits);
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

  const view = { budget: text === "" ? null : Number(text), warnPct: rules.capWarnPct };
  return createPortal(
    <div className="gs-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) done(); }} data-testid="settings-budget-panel-back">
      <div className="gs-sheet" role="dialog" aria-modal="true" aria-labelledby="gs-budget-title" ref={panel} data-testid="settings-budget-panel">
        <h3 className="gs-sheet-title" id="gs-budget-title">Budget and cap</h3>
        <p className="gs-sheet-line">{canChange ? "Admins only. The field saves when you leave it or press Enter." : "Only an admin can change these. Ask the owner or an admin."}</p>
        <label className="gs-label"><span className="gs-eyebrow">Budget per production</span>
          <span className="gs-unit">
            <input className="gs-field" inputMode="numeric" value={text} placeholder="none" readOnly={!canChange || !inCredits} aria-readonly={!canChange || !inCredits || undefined}
              onChange={(e) => type(e.target.value)} onBlur={() => void commit()}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } }} data-testid="settings-budget-field" />
            <span className="gs-unit-word">cr</span>
          </span>
          <span className="gs-row-line">{inCredits ? budgetHelp(view, creditsText) : NOT_ENFORCED}</span>
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
