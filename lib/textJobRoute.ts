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
import { aliasModel } from "./modelAliases";
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

/**
 * What a saved choice does for its job: runs as saved, or the model that runs in its place (null: nothing connected can run it).
 * It answers the way the job really runs, not by what the admin's list offers:
 *  - prompt enhancement asks only the writer's own rules (a price in its rate table, a working route; `enhanceModelFor`), and when
 *    not even the stand-in has a route, nothing can run it;
 *  - ideas and shot lists run `resolveModel` (lib/atomik.ts), which reads the saved choice against every language model the
 *    catalogue serves (`served`), not against the priced list the admin picks from: a Claude, OpenAI or Grok model that is served
 *    runs as saved even when it is not priced for the list, and a stand-in is what Auto would pick among all of them.
 * `served` is every language model the catalogue lists (default: the routable list, for callers that have no more).
 */
export type TextEffect = { saved: string; runnable: boolean; runs: string | null };
export function textEffect(job: TextJob, saved: string, routable: readonly string[], served: readonly string[] = routable): TextEffect {
  if (job === "enhance") {
    const runs = enhanceModelFor(saved);
    if (!textRouteWorks(runs)) return { saved, runnable: false, runs: null };
    return { saved, runnable: runs === saved, runs };
  }
  /* The same call resolveModel makes for a job's own Auto: the saved choice is the routed model, tried against everything served. */
  try {
    const runs = selectAtomikModel("auto", served, saved);
    return { saved, runnable: runs === aliasModel(saved), runs };
  } catch {
    return { saved, runnable: false, runs: null };
  }
}
