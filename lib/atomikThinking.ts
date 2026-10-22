import { catalog } from "./catalog";
import { getSetting } from "./settings";
import { PaidTextError } from "./paidText";
import {
  ATOMIK_THINKING, DEFAULT_THINKING, THINKING_UNAVAILABLE, TREATMENT_WRITER_UNAVAILABLE, TreatmentWriterOff,
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
 * How a text job runs `model` (what lib/atomik › resolveModel returned): `ours` when it is Atomik's thinking or the Treatment writer, and then
 * the pick's effort. Every run of Atomik's thinking needs the ceiling its person approved on the quote, whatever the caller sent (`ours`;
 * lib/paidText.ts ceilingRequired). It fails closed: a model that is any setting's (so a setting changed between the two reads still counts),
 * or a read of the setting or the catalogue that throws, is ours. Only a model that is neither the pick nor any setting's (none in the
 * product) is not, and a Treatment writer that is not set up is not.
 */
export async function thinkingRun(turn: TextJobTurn, model: string): Promise<{ ours: boolean; effort?: string }> {
  const anySetting = Object.values(ATOMIK_THINKING).some((t) => t.model === model);
  try {
    const pick = await textJobPick(turn);
    return pick.model === model ? { ours: true, ...(pick.effort ? { effort: pick.effort } : {}) } : { ours: anySetting };
  } catch (error) {
    if (error instanceof TreatmentWriterOff) return { ours: false };
    /* The setting or the catalogue could not be read: fail closed, the run still needs its approved ceiling. */
    return { ours: true };
  }
}
