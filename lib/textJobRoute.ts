/**
 * What each text job can really run, so the admin's routing offers nothing that silently runs as something else.
 *
 * Three jobs are routed (lib/platformLayer.ts TEXT_JOBS). Each runs only some of the routable, priced models:
 *  - ideas and shot lists go through Atomik, which takes Claude, OpenAI and Grok (lib/atomikModelPolicy.ts `isAtomikModel`); a
 *    Gemini choice reads as Auto there (selectAtomikModel);
 *  - prompt enhancement runs the inline writer (lib/enhance.ts `enhanceModelFor`), which takes only models in its own rate table
 *    with a working route; any other choice runs the deployment's writer list instead.
 * The functions here are the same rules those paths run by, so what the admin shows is what happens.
 */
import { enhanceModelFor, enhanceRunsModel } from "./enhance";
import { isAtomikModel, selectAtomikModel } from "./atomikModelPolicy";
import { textRouteWorks } from "./textRoute";
import { TEXT_JOBS, type TextJob } from "./platformLayer";

/** Whether a job runs this model as chosen, with no substitution. */
export function jobRunsModel(job: TextJob, id: string): boolean {
  return job === "enhance" ? enhanceRunsModel(id) && textRouteWorks(id) : isAtomikModel(id);
}

/** The routable models, per job, filtered to what that job really runs. */
export function textModelsByJob(routable: readonly string[]): Record<TextJob, string[]> {
  return Object.fromEntries(TEXT_JOBS.map((job) => [job, routable.filter((id) => jobRunsModel(job, id))])) as Record<TextJob, string[]>;
}

/** What a saved choice does for its job: runs as saved, or the model that runs in its place (null: nothing connected can run it). */
export type TextEffect = { saved: string; runnable: boolean; runs: string | null };
export function textEffect(job: TextJob, saved: string, routable: readonly string[]): TextEffect {
  const listed = routable.includes(saved) && jobRunsModel(job, saved);
  if (listed) return { saved, runnable: true, runs: saved };
  if (job === "enhance") return { saved, runnable: false, runs: enhanceModelFor(saved) || null };
  /* Atomik reads a choice it cannot run as Auto: the first of its own list that is connected. */
  try { return { saved, runnable: false, runs: selectAtomikModel("auto", routable) }; }
  catch { return { saved, runnable: false, runs: null }; }
}
