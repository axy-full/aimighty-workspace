/**
 * Atomik steps planned on the workspace owner's connected account.
 *
 * Until 28 September 2026 the planner could propose a step on that account's
 * catalogue, priced in its own credits, and run it through a connected route.
 * Atomik no longer plans, approves, edits or runs anything there: it works
 * with API-key and direct engines only. The steps it made stay (nothing a
 * team makes is erased) and are shown read-only: what was proposed, what ran
 * and what it was quoted at, never an Approve.
 *
 * Pure, and free of imports, so the server and the browser read the same rule.
 */

/** The model id prefix those steps were saved under (`connected:<model>`). */
export const ACCOUNT_MODEL_PREFIX = "connected:";

/** What such a step stored about itself, as far as it can still be shown. */
export type AccountStep = {
  /** The account model's display name, when the step saved one. */
  modelName: string | null;
  /** What it was quoted at, in the connected account's own credits (never Particl credits). */
  credits: number | null;
};

type StepLike = { model?: unknown; params?: unknown };

/** The step's record of the connected account, or null for every other step. */
export function accountStep(step: StepLike | null | undefined): AccountStep | null {
  if (!step) return null;
  const params = step.params && typeof step.params === "object" && !Array.isArray(step.params) ? (step.params as Record<string, unknown>) : null;
  const meta = params?.connected && typeof params.connected === "object" && !Array.isArray(params.connected)
    ? (params.connected as Record<string, unknown>) : null;
  const model = typeof step.model === "string" ? step.model : "";
  if (!meta && !model.startsWith(ACCOUNT_MODEL_PREFIX)) return null;
  const credits = typeof meta?.credits === "number" && Number.isFinite(meta.credits) ? meta.credits : null;
  const modelName = typeof meta?.modelName === "string" && meta.modelName.trim() ? meta.modelName.trim() : null;
  return { modelName, credits };
}

export const isAccountStep = (step: StepLike | null | undefined): boolean => accountStep(step) !== null;

/** Said wherever such a step is shown or refused. */
export const ACCOUNT_STEP_NOTE = "Planned on the connected account, which Atomik no longer uses. Kept read-only.";
