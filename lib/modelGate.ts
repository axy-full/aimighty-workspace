import { GATED_MODELS, findModel, type ModelDef } from "./models";
import { engineEnabled } from "./engineGate";
import { GATED_VENDOR_RATES } from "./vendorRates";
import { recordOpenGated } from "./gatedOpen";

/**
 * Models that carry their own kill switch (`gate` in lib/models.ts: Kling 4.0 today). The standing rule for every new engine (owner, 15 Oct 2026): ON for the house workspace and
 * for the workspaces listed in the site setting, OFF for customer workspaces until launch, each with its own switch. lib/engineGate.ts says who; this says which models.
 *
 * A gated model is in GATED_MODELS (lib/models.ts), not MODELS: every past take and price resolves (`getModel`, `findModel`), but no list that walks MODELS can offer it. The two lists that serve a
 * workspace's composer add it only when its switch is open for that workspace (`openGatedModels`, below), and admission refuses it otherwise (`modelGateClosed`), for a quote and a submit alike.
 */
export const GATE_CLOSED = "There is no such model here.";

/**
 * A gated model runs only on a confirmed endpoint, fields and rate (`confirmed` on its row in GATED_VENDOR_RATES, lib/vendorRates.ts). Until the lead has read them from the vendor's own
 * page the row is `confirmed: false`, and the model can be neither listed nor asked for, whatever its switch says: a placeholder is never a price a workspace is charged.
 */
export const isConfirmed = (modelId: string): boolean => GATED_VENDOR_RATES[modelId]?.confirmed === true;
export const unavailableYet = (modelId: string): string => `${findModel(modelId)?.label ?? "This model"} isn't available yet.`;

/** The gates (environment switches) that are open for this workspace, among the gates models carry. */
export async function openGates(workspace?: { id: string } | null): Promise<Set<string>> {
  const out = new Set<string>();
  for (const gate of new Set(GATED_MODELS.flatMap((m) => (m.gate && isConfirmed(m.id) ? [m.gate] : [])))) {
    if (await (workspace === undefined ? engineEnabled(gate) : engineEnabled(gate, workspace))) out.add(gate);
  }
  return out;
}

/** The gated models open for this workspace, for a list that adds them to the offered ones. */
export async function openGatedModels(workspace?: { id: string } | null): Promise<ModelDef[]> {
  const open = await openGates(workspace);
  const models = GATED_MODELS.filter((m) => m.gate && isConfirmed(m.id) && open.has(m.gate) && m.retired !== true);
  /* Asked for the request in scope: the price path (lib/gatedOpen.ts) quotes these and no others. */
  if (workspace === undefined) recordOpenGated(models.map((m) => m.id));
  return models;
}

/** The ids of the gated models open for this workspace, for the rate table handed to its browser. */
export async function openGatedModelIds(workspace?: { id: string } | null): Promise<string[]> {
  return (await openGatedModels(workspace)).map((m) => m.id);
}

/** What admission says when a new job names a gated model whose switch is closed for this workspace; null when the model may be asked for. */
export async function modelGateClosed(modelId: string | null | undefined, workspace?: { id: string } | null): Promise<string | null> {
  const model = findModel(modelId);
  const gate = model?.gate;
  if (!model || !gate) return null;
  /* Ask the gate for the request in scope (it records which gated models may be quoted), so a price asked for after this is right. */
  if (workspace === undefined) await openGatedModels();
  /* Unconfirmed: refused in its own words, switch or no switch, for the house too. */
  if (!isConfirmed(model.id)) return unavailableYet(model.id);
  return (await (workspace === undefined ? engineEnabled(gate) : engineEnabled(gate, workspace))) ? null : GATE_CLOSED;
}
