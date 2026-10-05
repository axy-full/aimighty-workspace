import type { SampleCastLine, SampleCut } from "./content";
import type { SamplePlan } from "./plan";
import type { SampleMark } from "./sample";

/**
 * What a board needs to show the sample (the shape of GET /api/demo/sample). Credits only: no vendor dollars exist in
 * it. `plan.steps` is the input of stream 4's `samplePlanModel(steps, line)`; `BoardSource.sample` carries this.
 */
export type SampleBoard = {
  sample: Pick<SampleMark, "projectId" | "name" | "markedAt">;
  /** What every paid control on the sample says. */
  line: string;
  plan: SamplePlan;
  cast: SampleCastLine[];
  cut: SampleCut;
};
