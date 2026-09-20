import { MODELS, type ModelDef } from "../models";
import { generationRequestBody, type GenerationReference } from "../workbench/generation-request";
import { mediaReferenceIdentity } from "../workbench/media-reference-input";
import { generationReferenceIds } from "../workbench/node-graph";
import { EMPTY_MOLECULR, type MoleculrBrief } from "../workbench/moleculr";
import type { Asset, CanvasNode, Project } from "../workbench/studio";

/**
 * The /api/generate request a Marketing Studio variant sends.
 *
 * Marketing Studio never posts a generation itself: `configureMoleculr`
 * (Studio.tsx) binds the variant's references and hands the node to
 * GenerationDialog, which sends `generationRequestBody` and then writes the
 * settings it accepted back onto the variant (`variant.generation`, from
 * GenerationDialog's `acceptedSettings`). This module rebuilds that same body
 * from the saved draft, so the Moleculr plan can never send one the dialog
 * would not have sent.
 *
 * It follows the Rig's contract (lib/workspace/rig-requests.ts): a variant is
 * included only when every field of the body is already on the draft. A
 * variant whose engine, ratio, resolution or duration was never accepted, or
 * whose node has no production mapping, or whose references are not yet saved
 * as uploads or generations, is LEFT OUT rather than completed with a guess —
 * those are the dialog's choices, and only the dialog may make them.
 */

export type NamedVariantBody = { name: string; body: Record<string, unknown> };

/** One variant: either the body it would send, or why it cannot be priced yet. */
export type VariantRequest =
  | { name: string; body: Record<string, unknown>; gap?: undefined }
  | { name: string; body?: undefined; gap: string };

/**
 * The references the dialog would have resolved: the node's bound assets, each
 * already saved. `configureMoleculr` drops the node's own output when the
 * variant cites a reference video, so this does too.
 */
function variantReferences(
  project: Project,
  node: CanvasNode,
  referenceVideoAssetId: string | undefined,
): GenerationReference[] | null {
  const ids = generationReferenceIds(node, project).filter(
    (id) => !referenceVideoAssetId || id !== node.assetId || id === referenceVideoAssetId,
  );
  const assets = ids
    .map((id) => [...project.assets, ...(project.sharedAssets ?? [])].find((asset) => asset.id === id))
    .filter((asset): asset is Asset => !!asset && ["image", "video"].includes(asset.kind));
  if (assets.length !== ids.length) return null;
  const references: GenerationReference[] = [];
  for (const asset of assets) {
    const identity = mediaReferenceIdentity(asset);
    /* An asset that is not yet an upload or a generation would have to be
       uploaded first — a side effect the dialog performs on Generate. */
    if (!identity) return null;
    references.push({ ...identity, role: asset.kind === "video" ? "reference_video" : "reference_image" });
  }
  return references;
}

/**
 * Every campaign variant on the saved draft, in the order Marketing Studio
 * lists them, each with its body or with the one thing it still needs.
 */
export function marketingVariantRequests(
  project: Project | null,
  models: readonly ModelDef[] = MODELS,
): VariantRequest[] {
  if (!project) return [];
  const brief: MoleculrBrief = project.moleculr ?? EMPTY_MOLECULR;
  const productionProjectId = project.productionProjectId;
  return brief.variants.map((variant): VariantRequest => {
    const node = project.nodes.find((item) => item.id === variant.nodeId);
    const name = variant.hook || node?.title || variant.nodeId;
    const refuse = (gap: string): VariantRequest => ({ name, gap });
    if (!productionProjectId) return refuse("this project has no production yet");
    if (!node || !node.text?.trim()) return refuse("its shot is missing from the graph");
    const settings = variant.generation;
    const model = settings?.modelId ? models.find((item) => item.id === settings.modelId) ?? null : null;
    if (!settings || !model || model.kind !== variant.kind)
      return refuse("no engine accepted yet — configure its generation in Marketing Studio once");
    if (!settings.ratio || !model.ratios.includes(settings.ratio)) return refuse("its ratio is not one this engine accepts");
    if (!settings.resolution || !model.resolutions.includes(settings.resolution))
      return refuse("no resolution accepted yet — configure its generation in Marketing Studio once");
    /* A video engine renders for a listed number of seconds; a marketing image engine has none. */
    const duration = settings.duration;
    if (!model.marketing && (duration === undefined || !model.durations.includes(duration)))
      return refuse("its length is not one this engine accepts");
    if (model.marketing && !settings.marketing) return refuse("its image options were not accepted yet");
    if (model.soulIdentity && !settings.soulIdentityId) return refuse("its identity was not accepted yet");
    const shotId = project.shotMappings?.[variant.nodeId];
    if (!shotId) return refuse("not mapped to a production shot yet");
    const references = variantReferences(project, node, variant.referenceVideo?.assetId);
    if (!references) return refuse("its references are not saved to this project yet");
    return {
      name,
      body: generationRequestBody({
        prompt: node.text,
        kind: model.kind,
        model,
        mapping: { shotId, productionProjectId },
        ratio: settings.ratio,
        resolution: settings.resolution,
        duration: duration ?? 0,
        references,
        marketing: settings.marketing,
        firstFrameAssetId: settings.firstFrameAssetId ?? "",
        ...(model.soulIdentity && settings.soulIdentityId
          ? {
              soul: {
                soulIdentityId: settings.soulIdentityId,
                soulStrength: settings.soulStrength ?? 1,
                workbenchProjectId: project.id,
              },
            }
          : {}),
      }),
    };
  });
}

/** The bodies the Moleculr plan prices, or an empty list when none is complete. */
export function marketingPlanRequests(
  project: Project | null,
  models: readonly ModelDef[] = MODELS,
): NamedVariantBody[] {
  return marketingVariantRequests(project, models).flatMap((item) =>
    item.body ? [{ name: item.name, body: item.body }] : [],
  );
}

/** "Hook: reason" for each variant the plan leaves out, for the page to show. */
export function marketingRequestGaps(
  project: Project | null,
  models: readonly ModelDef[] = MODELS,
): string[] {
  return marketingVariantRequests(project, models).flatMap((item) =>
    item.gap ? [`${item.name}: ${item.gap}.`] : [],
  );
}
