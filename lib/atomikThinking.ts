import { catalog, type CatalogModel } from "./catalog";
import { THINKING } from "./copy";
import { getSetting } from "./settings";
import { PaidTextError } from "./paidText";
import {
  DEFAULT_THINKING, THINKING_UNAVAILABLE, TREATMENT_WRITER_UNAVAILABLE, TreatmentWriterOff,
  THINKING_SETTINGS, isThinking, offersEffort, selectAtomikThinking, thinkingService, treatmentWriter, type AtomikTurn, type Thinking,
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

/**
 * A text job: one of Atomik's turns, or prose the Treatment writer writes (lib/atomikModelPolicy › treatmentWriter): the Treatment's,
 * and the breakdown of a brief or script (owner, 25 Oct 2026; lib/reading/breakdown.ts).
 */
export type TextJobTurn = AtomikTurn | "treatment" | "breakdown";

/**
 * The model and effort a text job runs at: the setting's for an Atomik turn, the Treatment writer's for the Treatment's prose.
 * A model the person (or an older page) sends is not a choice and is never asked here. Refused, before anything is quoted or
 * charged, when that model is not being served; nothing falls back to another paid model.
 */
export async function textJobPick(turn: TextJobTurn): Promise<{ model: string; effort?: string }> {
  const served = (await catalog()).filter((m) => m.type === "language");
  if (turn === "treatment" || turn === "breakdown") {
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
 * How a text job runs `model` (what lib/atomik › resolveModel returned): always `ours`, since these routes only ever run Atomik's thinking or
 * the Treatment writer, so every run needs the ceiling its person approved on the quote (owner, 23 Oct 2026; lib/paidText.ts
 * ceilingRequired). The effort is the pick's when `model` is what the pick runs; otherwise none is sent.
 */
export async function thinkingRun(turn: TextJobTurn, model: string): Promise<{ ours: true; effort?: string }> {
  try {
    const pick = await textJobPick(turn);
    return { ours: true, ...(pick.model === model && pick.effort ? { effort: pick.effort } : {}) };
  } catch {
    return { ours: true };
  }
}

/** A setting's name and whether it is served, as the platform owner's health detail reads it. */
export type ThinkingHealth = { line: string; settings: { name: string; state: string }[] };

/**
 * Whether each Thinking setting is served, by name only (owner, 24 Oct 2026): "Thinking: High · Medium · Low served", or each in turn
 * ("Thinking: High not set · Medium served · Low served"). Served means what a turn would get (lib/atomikModelPolicy › thinkingService):
 * the slot names a verified Claude id and the catalogue runs it or a permitted cheaper fallback. Never a model id, an effort or a rate.
 * `served` stands in for the catalogue; a catalogue that cannot be read serves nothing, as it would for a turn. For GET /api/health,
 * the platform owner's briefing alone.
 */
export async function thinkingHealth(served?: readonly CatalogModel[]): Promise<ThinkingHealth> {
  const models = served ?? (await catalog().catch(() => [] as CatalogModel[]));
  const service = thinkingService(models.filter((m) => m.type === "language"));
  const words = { served: THINKING.served, unset: THINKING.notSet, unserved: THINKING.notServed } as const;
  const settings = THINKING_SETTINGS.map((setting) => ({ name: THINKING[setting], state: words[service[setting]] }));
  const same = settings.every(({ state }) => state === settings[0].state);
  const line = same ? `${settings.map(({ name }) => name).join(" · ")} ${settings[0].state}` : settings.map(({ name, state }) => `${name} ${state}`).join(" · ");
  return { line: `${THINKING.label}: ${line}`, settings };
}
