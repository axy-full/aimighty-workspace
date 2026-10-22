/**
 * What each text job can really run, so the admin's routing offers nothing that silently runs as something else.
 *
 * Three jobs are routed (lib/platformLayer.ts TEXT_JOBS). Each runs only some of the routable, priced models:
 *  - ideas and shot lists go through Atomik, which since 22 Oct 2026 runs the workspace's Thinking setting whatever the routing
 *    says (lib/atomikModelPolicy.ts `thinkingFor`): the routing can only name one of the setting's models;
 *  - prompt enhancement runs the inline writer (lib/enhance.ts `enhanceModelFor`), which takes only models in its own rate table
 *    with a working route; any other choice runs the deployment's writer list instead.
 * The functions here are the same rules those paths run by, so what the admin shows is what happens.
 */
import { enhanceModelFor, enhanceRunsModel } from "./enhance";
import { ATOMIK_THINKING, DEFAULT_THINKING, thinkingFor } from "./atomikModelPolicy";
import { textRouteWorks } from "./textRoute";
import { TEXT_JOBS, type TextJob } from "./platformLayer";

/** Whether a job runs this model as chosen, with no substitution. */
export function jobRunsModel(job: TextJob, id: string): boolean {
  return job === "enhance" ? enhanceRunsModel(id) && textRouteWorks(id) : Object.values(ATOMIK_THINKING).some((t) => t.model === id);
}

/** The routable models, per job, filtered to what that job really runs. */
export function textModelsByJob(routable: readonly string[]): Record<TextJob, string[]> {
  return Object.fromEntries(TEXT_JOBS.map((job) => [job, routable.filter((id) => jobRunsModel(job, id))])) as Record<TextJob, string[]>;
}

/**
 * What a saved choice does for its job: runs as saved, or the model that runs in its place (null: nothing connected can run it).
 * It answers the way the job really runs, not by what the admin's list offers:
 *  - prompt enhancement asks only the writer's own rules (a price in its rate table, a working route; `enhanceModelFor`), and when
 *    not even the stand-in has a route, nothing can run it;
 *  - ideas and shot lists run `resolveModel` (lib/atomik.ts), which no longer reads the saved choice: they run the Thinking
 *    setting's model for a Writing turn, shown here at the default setting (Medium), when the catalogue serves it (`served`).
 * `served` is every language model the catalogue lists (default: the routable list, for callers that have no more).
 */
export type TextEffect = { saved: string; runnable: boolean; runs: string | null };
export function textEffect(job: TextJob, saved: string, routable: readonly string[], served: readonly string[] = routable): TextEffect {
  if (job === "enhance") {
    const runs = enhanceModelFor(saved);
    if (!textRouteWorks(runs)) return { saved, runnable: false, runs: null };
    return { saved, runnable: runs === saved, runs };
  }
  /* What resolveModel runs at the default setting: the routing's choice is not asked. */
  const runs = thinkingFor(DEFAULT_THINKING, "writing").model;
  return served.includes(runs) ? { saved, runnable: runs === saved, runs } : { saved, runnable: false, runs: null };
}
