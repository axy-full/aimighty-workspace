"use client";
import type { CardProps } from "../types";
import type { PlanData } from "./derive";
import { Steps } from "./PlanCard";
import type { PlanModel } from "./model";
import { usePublishedPlanModel } from "./ui";

/** The plan in the Inspector: every step with its price or the words that say why it has none, and how the renders ask. */
export function PlanInspector({ data }: CardProps<PlanData>) {
  const model = usePublishedPlanModel<PlanModel>(data.run.id);
  if (!model) return null;
  return (
    <div className="gx-insp-take" data-testid="insp-plan">
      <div className="gx-insp-title">{model.title}</div>
      {model.modeLine ? <div className="gx-insp-meta">{model.modeLine}</div> : null}
      <Steps model={model} />
    </div>
  );
}
