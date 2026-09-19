import type { Generation } from "@/lib/jobs";
import type { PipelineCatalog } from "@/lib/pipeline/editor";
import type { PublicPipelineRun } from "@/lib/pipeline/public";
import type { PipelineSpec } from "@/lib/pipeline/schema";

export const ATOMIK_PAGES = [
  "runs",
  "generate",
  "recipes",
  "approvals",
  "budget",
  "models",
] as const;
export type AtomikPage = (typeof ATOMIK_PAGES)[number];
export type AtomikCatalog = PipelineCatalog & { runs: PublicPipelineRun[] };
export type RecordedTake = Pick<
  Generation,
  | "id"
  | "projectId"
  | "status"
  | "costUsd"
  | "refineCostUsd"
  | "creditsBilled"
  | "provider"
>;
export const atomikPage = (value: string | null): AtomikPage =>
  ATOMIK_PAGES.find((page) => page === value) ?? "runs";

/** Fail closed when a catalogue response contains another production's data. */
export function projectCatalog(
  catalog: AtomikCatalog,
  productionId: string,
): AtomikCatalog {
  return {
    ...catalog,
    runs: catalog.runs.filter((run) => run.context.projectId === productionId),
    publications: catalog.publications.filter(
      (publication) => publication.projectId === productionId,
    ),
  };
}
/** Recipes contain only the saved plan. No attempt, approval or provider output is reused. */
export function recipeFromRun(run: PublicPipelineRun): PipelineSpec {
  return {
    schemaVersion: 1,
    name: run.name,
    context: { ...run.context },
    stages: run.stages.map((stage) => structuredClone(stage.definition)),
  };
}
export function savedRecipes(runs: PublicPipelineRun[]): PublicPipelineRun[] {
  const unique = new Map<string, PublicPipelineRun>();
  for (const run of runs) {
    const key = `${run.pipelineId}:${run.pipelineVersion}`;
    const previous = unique.get(key);
    if (!previous || run.updatedAt > previous.updatedAt) unique.set(key, run);
  }
  return [...unique.values()];
}
export function needsApproval(run: PublicPipelineRun) {
  return ["draft", "awaiting_approval", "needs_review", "blocked"].includes(
    run.state,
  );
}
export function stageStatus(
  run: PublicPipelineRun,
  stageId: string,
  now = Date.now(),
): string {
  const stage = run.stages.find((item) => item.definition.id === stageId);
  if (!stage) return "Unavailable";
  if (stage.definition.kind === "review")
    return run.selections.some((selection) => selection.stageId === stageId)
      ? "Selected"
      : "Checkpoint";
  if (stage.definition.kind === "assembly")
    return run.assemblies[stageId] ? "Ready" : "Waiting for inputs";
  if (
    !["succeeded", "cancelled"].includes(run.state) &&
    run.quotes.some(
      (quote) =>
        quote.stageId === stageId &&
        quote.approvedAt === null &&
        quote.baseRevision === run.revision &&
        quote.expiresAt > now,
    )
  )
    return "Awaiting approval";
  const latest = new Map<number, PublicPipelineRun["attempts"][number]>();
  for (const attempt of run.attempts.filter(
    (item) => item.stageId === stageId,
  )) {
    const previous = latest.get(attempt.unit);
    if (!previous || attempt.number > previous.number)
      latest.set(attempt.unit, attempt);
  }
  const attempts = [...latest.values()];
  if (attempts.some((attempt) => attempt.state === "uncertain"))
    return "Needs recovery";
  if (
    attempts.some((attempt) =>
      ["running", "queued", "submitting"].includes(attempt.state),
    )
  )
    return "Running";
  if (attempts.some((attempt) => ["failed", "refused"].includes(attempt.state)))
    return "Needs attention";
  if (
    attempts.length === stage.definition.units &&
    attempts.every((attempt) => attempt.state === "succeeded")
  )
    return "Complete";
  return run.state === "cancelled" ? "Cancelled" : "Awaiting quote";
}
export function stageCost(
  run: PublicPipelineRun,
  stageId: string,
  takes: RecordedTake[],
  credits: boolean,
) {
  const quote = [...run.quotes]
    .reverse()
    .find((item) => item.stageId === stageId);
  const attempts = run.attempts.filter((item) => item.stageId === stageId);
  const ids = [
    ...new Set(
      attempts.flatMap((attempt) =>
        attempt.generationId ? [attempt.generationId] : [],
      ),
    ),
  ];
  const byId = new Map(
    takes
      .filter((take) => take.projectId === run.context.projectId)
      .map((take) => [take.id, take]),
  );
  let actual = 0;
  let settled = ids.length > 0;
  for (const id of ids) {
    const take = byId.get(id);
    const amount = take
      ? credits
        ? take.creditsBilled
        : take.costUsd == null
          ? null
          : take.costUsd + (take.refineCostUsd ?? 0)
      : null;
    if (
      !take ||
      !["succeeded", "failed", "cancelled"].includes(take.status) ||
      amount == null ||
      !Number.isFinite(amount)
    )
      settled = false;
    else actual += amount;
  }
  return {
    estimate: quote
      ? quote.currency === "cr"
        ? quote.estimatedCredits
        : quote.price
      : null,
    estimateUnit: quote?.currency ?? null,
    actual: settled ? actual : null,
  };
}
