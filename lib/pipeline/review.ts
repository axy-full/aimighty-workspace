/**
 * A review stage's candidates (components/pipeline/PipelineRun): which take
 * each one offers, and whether it is the one chosen. Pure.
 */
type Attempt = { stageId: string; unit: number; state: string; generationId?: string | null };
type Selection = { stageId: string; generationId?: string | null };

/** The newest succeeded take for a candidate, or undefined while it has none. */
export function candidateAttempt<A extends Attempt>(attempts: A[], candidate: { stageId: string; unit: number }): A | undefined {
  return [...attempts].reverse().find((a) => a.stageId === candidate.stageId && a.unit === candidate.unit && a.state === "succeeded");
}

/**
 * Whether a candidate's take is the stage's selection. Both have to exist:
 * "nothing chosen yet" and "no finished take yet" are two absences, not a
 * match, and reading them as one showed every candidate as Selected.
 */
export function isSelectedCandidate(selections: Selection[], stageId: string, attempt: { generationId?: string | null } | undefined): boolean {
  const chosen = selections.find((s) => s.stageId === stageId)?.generationId;
  return Boolean(attempt?.generationId && chosen && chosen === attempt.generationId);
}
