"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { runChip } from "@/lib/workspace/atomik-view";
import { getSuite, pageDef } from "@/lib/workspace/pages";
import { EMPTY_FACTS, specFor } from "@/lib/workspace/spec-cards";
import { useSpecFacts } from "@/lib/workspace/spec-store";
import type { InspectorBodyProps } from "../inspector/registry";
import { Button, Kicker } from "../ui";

/**
 * The Inspector on a spec page: a SPECIFICATION table of five facts counted
 * from the page's data, then the page's Atomik plan and a button that runs it
 * on the shell's Atomik host — the same engine, gate and panel every other
 * surface uses. A plan with no backend, or missing what it needs, is disabled
 * and says why; a paid plan stops at the panel's gate with the live quote.
 */
export function SpecInspector({ state }: InspectorBodyProps) {
  const page = state.page;
  const spec = specFor(page);
  const def = pageDef(page);
  const atomik = useAtomik();
  const plan = atomik.plan(page);
  const facts = useSpecFacts(page) ?? { ...EMPTY_FACTS, planPrice: plan?.priceLabel ?? null };
  if (!spec) return null;

  const run = atomik.runFor(page);
  const runnable = atomik.runnable(page);
  const chip = runChip(run);
  /* Pausing, and opening a waiting gate, stay possible whatever the page holds now. */
  const disabled = !runnable.ok && chip.tone === "idle";
  const reason = runnable.ok ? null : runnable.reason;

  return (
    <div data-inspector-body="page" data-testid="spec-inspector">
      <Kicker>Output</Kicker>
      <div className="pxw-preview" style={{ marginTop: 10 }} aria-hidden="true" />
      <div className="pxw-inspector-subject">{def.title}</div>
      <div className="pxw-inspector-sub">{getSuite(state.suite).name}</div>

      <Kicker className="pxw-insp-kicker">Specification</Kicker>
      <dl className="pxw-facts" data-testid="spec-facts">
        {spec.facts(facts).map(([name, value], i) => (
          <div className="pxw-fact" key={name}>
            <dt>{name}</dt>
            <dd style={{ color: i === 0 ? "var(--pxw-primary)" : "var(--pxw-body)" }}>{value}</dd>
          </div>
        ))}
      </dl>

      {plan ? (
        <div className="pxw-insp-plan" data-testid="spec-plan">
          <Kicker className="pxw-insp-kicker">Atomik plan</Kicker>
          <div className="pxw-insp-plan-title">{plan.title}</div>
          <p className="pxw-insp-plan-line">{plan.line}</p>
          <div className="pxw-insp-plan-price">{plan.priceLabel}</div>
          <Button
            variant={chip.tone === "waiting" ? "amber" : "primary"}
            className="pxw-insp-run"
            disabled={disabled || Boolean(run?.quoting)}
            aria-describedby={reason && disabled ? "pxw-plan-reason" : undefined}
            onClick={() => (chip.tone === "waiting" ? void atomik.approve() : atomik.start(page))}
          >
            <span>{chip.label}</span>
          </Button>
          {/* "Approve 18 cr" approves (never starts); the gate always has a way out. */}
          {chip.tone === "waiting" ? (
            <Button variant="control" className="pxw-insp-run" disabled={run?.approved} onClick={atomik.decline} data-testid="spec-plan-decline">
              <span>Not now</span>
            </Button>
          ) : null}
          {reason && disabled ? (
            <p className="pxw-insp-reason" id="pxw-plan-reason" data-testid="spec-plan-reason">{reason}</p>
          ) : null}
          {run?.error ? <p className="pxw-insp-error" role="alert">{run.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
