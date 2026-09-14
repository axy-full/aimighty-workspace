import type { PipelineRun } from "./store";

/** No prepared/compiled admission bodies or private storage locations leave
 * the server. Authenticated media has its own scoped route. */
export function publicRun(run: PipelineRun) {
  return {
    id: run.id,
    owner: run.owner,
    pipelineId: run.pipelineId,
    pipelineVersion: run.pipelineVersion,
    revision: run.revision,
    state: run.state,
    name: run.compiled.spec.name,
    context: run.compiled.spec.context,
    maximumUnits: run.compiled.maximumUnits,
    stages: run.compiled.stages.map(
      ({ definition, dependencies, outputKind, prompt }) => ({
        definition,
        dependencies,
        outputKind,
        prompt,
      }),
    ),
    attempts: run.attempts.map(({ prepared, ...attempt }) => ({
      ...attempt,
      kind: prepared.kind,
      estimatedCredits: prepared.quote.estimatedCredits,
      price: prepared.quote.price,
      currency: prepared.quote.unit,
      model: String(prepared.request.model ?? prepared.request.modelId ?? ""),
      url:
        attempt.generationId && attempt.state === "succeeded"
          ? `/api/media/${encodeURIComponent(attempt.generationId)}?stream=1`
          : null,
    })),
    quotes: run.quotes.map(({ units, ...quote }) => ({
      ...quote,
      units: units.map((u) => ({ unit: u.unit, number: u.number })),
    })),
    selections: run.selections,
    assemblies: run.assemblies,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
export type PublicPipelineRun = ReturnType<typeof publicRun>;
