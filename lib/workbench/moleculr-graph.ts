import { PROJECT_LIMITS, limitText } from "./project-limits";
import type { Asset, CanvasNode, Project } from "./studio";
import { resolveReferenceAd } from "./reference-ad";

const SOURCE_TYPES = new Set<CanvasNode["type"]>([
  "media",
  "moodboard",
  "character",
  "element",
]);
const MIN_POSITION = -10_000;
const MAX_POSITION = 20_000;
const POSITION_RANGE = MAX_POSITION - MIN_POSITION;

function boundedPosition(value: number) {
  return (
    MIN_POSITION +
    ((((value - MIN_POSITION) % POSITION_RANGE) + POSITION_RANGE) %
      POSITION_RANGE)
  );
}

/** Persist original inputs; one reference video requires an explicit video binding. */
export function bindMoleculrReferences(
  project: Project,
  node: CanvasNode,
  refs: Asset[],
  createId: () => string,
  referenceVideoAssetId?: string,
): { node: CanvasNode; sources: CanvasNode[] } {
  if (node.locked)
    throw new Error(
      "Unlock this variant in Rig before changing its references.",
    );
  if (
    ![node.x, node.y].every(
      (value) =>
        Number.isFinite(value) &&
        value >= MIN_POSITION &&
        value <= MAX_POSITION,
    )
  )
    throw new Error(
      "Move this variant inside the canvas bounds before configuring it.",
    );

  // The caller's objects supply IDs only; canonical originals belong to this draft.
  if (referenceVideoAssetId && (!['Video', 'Image to video'].includes(node.mode ?? '') || !refs.some(asset => asset.id === referenceVideoAssetId) || !resolveReferenceAd(project, { assetId: referenceVideoAssetId })))
    throw new Error('The reference ad needs its stored original and a video generation node.');
  const assets = new Map(
    project.assets
      .filter((asset) => asset.kind === "image" || asset.id === referenceVideoAssetId)
      .map((asset) => [asset.id, asset]),
  );
  const selected = [...new Set(refs.map((asset) => asset.id))]
    .map((id) => assets.get(id))
    .filter((asset): asset is Asset => !!asset);
  if (selected.length > 100)
    throw new Error("A variant can bind up to 100 media references.");

  const bindings = selected.map((asset) => ({
    asset,
    source: project.nodes.find(
      (source) =>
        source.id !== node.id &&
        source.assetId === asset.id &&
        SOURCE_TYPES.has(source.type) &&
        !source.locked &&
        !source.bypassed &&
        source.linked.length === 0 &&
        !source.operations?.length,
    ),
  }));
  const additions = bindings.filter((binding) => !binding.source).length;
  const newVariant = project.nodes.some((existing) => existing.id === node.id)
    ? 0
    : 1;
  if (project.nodes.length + additions + newVariant > PROJECT_LIMITS.nodes)
    throw new Error(
      `This variant and its reference nodes exceed the ${limitText(PROJECT_LIMITS.nodes)}-node project limit. Remove unused nodes or start another project.`,
    );

  const usedIds = new Set([...project.nodes.map((item) => item.id), node.id]);
  const sources: CanvasNode[] = [];
  const linked = bindings.map(({ asset, source }, index) => {
    if (source) return source.id;
    const id = createId();
    if (!id || usedIds.has(id))
      throw new Error("Could not create a unique reference node. Try again.");
    usedIds.add(id);
    sources.push({
      id,
      title: asset.name.slice(0, 300),
      type: "media",
      assetId: asset.id,
      x: boundedPosition(node.x - 340),
      y: boundedPosition(node.y + index * 320),
      width: 280,
      linked: [],
    });
    return id;
  });
  return { node: { ...node, linked }, sources };
}
