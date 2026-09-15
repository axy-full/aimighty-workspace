"use client";

import { ModelPicker, type ThinkingModel } from "./ModelPicker";

export type PlannerModel = ThinkingModel & {
  owner: string; description: string; band: string; price: string;
};

export default function ModelMenu({ value, models, onPick, disabled }: {
  value: string;
  models: { featured: PlannerModel[]; rest: PlannerModel[] };
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  return <ModelPicker value={value} models={[...models.featured, ...models.rest]} onPick={onPick} disabled={disabled} compact />;
}
