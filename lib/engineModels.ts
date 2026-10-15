import { engineEnabled } from "./engineGate";
import { MODELS, findModel, type ModelDef } from "./models";

/**
 * Models that sit behind an engine switch of their own (`ModelDef.engineSwitch`), where the owner's rule applies to a model row as it does to a tool
 * (15 Oct 2026): ON for the house workspace and the workspaces the platform owner lists, OFF for customers, each with its own kill switch
 * (lib/engineGate.ts). Such a row is `hidden` in the static registry, so no static menu offers it; the lists a workspace reads add the ones it may have,
 * and admission refuses the rest.
 */
export async function gatedModelOn(model: Pick<ModelDef, "engineSwitch"> | undefined | null): Promise<boolean> {
  return model?.engineSwitch ? engineEnabled(model.engineSwitch) : true;
}

/** The gated models this workspace may use right now (switch on, and the house or a listed workspace). */
export async function gatedModelsHere(): Promise<ModelDef[]> {
  const out: ModelDef[] = [];
  for (const model of MODELS) if (model.engineSwitch && (await gatedModelOn(model))) out.push(model);
  return out;
}

/** What admission says to a gated model that is not on here; null when the model may be asked for. Same words as an id that is not there, so it reveals nothing. */
export async function gatedModelRefusal(modelId: string | null | undefined): Promise<string | null> {
  const model = findModel(modelId);
  return model?.engineSwitch && !(await gatedModelOn(model)) ? `Unknown model: ${modelId}` : null;
}
