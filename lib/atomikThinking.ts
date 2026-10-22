import { catalog } from "./catalog";
import { getSetting } from "./settings";
import { PaidTextError } from "./paidText";
import {
  DEFAULT_THINKING, THINKING_UNAVAILABLE, TREATMENT_WRITER_UNAVAILABLE, TreatmentWriterOff,
  isThinking, offersEffort, selectAtomikThinking, treatmentWriter, type AtomikTurn, type Thinking,
} from "./atomikModelPolicy";

/**
 * Where Atomik's thinking is read at run time (the policy itself is lib/atomikModelPolicy.ts, docs/atomik-model-policy.md).
 *
 * The workspace's setting is `atomikThinking` (High · Medium · Low, default Medium), which only an admin sets (PATCH /api/settings).
 * The per-production setting at the Brief comes with the Brief's own PR; until then every production follows the workspace's.
 */

/** The workspace's Thinking setting; the default (Medium) when it holds no valid value or cannot be read. */
export async function workspaceThinking(): Promise<Thinking> {
  try {
    const value = await getSetting("atomikThinking");
    return isThinking(value) ? value : DEFAULT_THINKING;
  } catch {
    return DEFAULT_THINKING;
  }
}

/** A text job: one of Atomik's turns, or the Treatment's prose, which its own writer writes (lib/atomikModelPolicy › treatmentWriter). */
export type TextJobTurn = AtomikTurn | "treatment";

/**
 * The model and effort a text job runs at: the setting's for an Atomik turn, the Treatment writer's for the Treatment's prose.
 * A model the person (or an older page) sends is not a choice and is never asked here. Refused, before anything is quoted or
 * charged, when that model is not being served; nothing falls back to another paid model.
 */
export async function textJobPick(turn: TextJobTurn): Promise<{ model: string; effort?: string }> {
  const served = (await catalog()).filter((m) => m.type === "language");
  if (turn === "treatment") {
    const writer = treatmentWriter();
    if (!writer) throw new TreatmentWriterOff();
    const entry = served.find((m) => m.id === writer.model);
    if (!entry) throw new TreatmentWriterOff(TREATMENT_WRITER_UNAVAILABLE);
    return { model: writer.model, ...(offersEffort(entry, writer.effort) ? { effort: writer.effort } : {}) };
  }
  const pick = selectAtomikThinking(await workspaceThinking(), turn, served);
  if (!pick) throw new PaidTextError(THINKING_UNAVAILABLE, 503, { nothingBilled: true });
  return { model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) };
}

/**
 * The effort a text job runs its model at: the pick's, when `model` is the model the pick runs (what lib/atomik › resolveModel
 * returned); otherwise none, and the model thinks at its own default.
 */
export async function thinkingEffort(turn: TextJobTurn, model: string): Promise<string | undefined> {
  try {
    const pick = await textJobPick(turn);
    return pick.model === model ? pick.effort : undefined;
  } catch {
    return undefined;
  }
}
