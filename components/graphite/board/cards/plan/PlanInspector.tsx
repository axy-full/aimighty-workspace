"use client";
import { readOnlyOf } from "../doc/DocCards";
import type { CardProps } from "../types";
import type { PlanData } from "./derive";
import { Steps } from "./PlanCard";
import { usePlan } from "./use-plan";

/** The plan in the Inspector: every step with its price or the words that say why it has none, and how the renders ask. */
export function PlanInspector({ data, ctx }: CardProps<PlanData>) {
  const plan = usePlan(ctx, data.run, readOnlyOf(ctx));
  const model = plan.model;
  if (!model) return null;
  return (
    <div className="gx-insp-take" data-testid="insp-plan">
      <div className="gx-insp-title">{model.title}</div>
      {model.modeLine ? <div className="gx-insp-meta">{model.modeLine}</div> : null}
      <Steps model={model} />
    </div>
  );
}
