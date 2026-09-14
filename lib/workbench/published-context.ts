import type { Asset, CanvasNode, Project } from "./studio";

/** Freeze the selected context together with every source needed to understand it. */
export function publishedContext(project: Project) {
  const selectedAssets =
    project.sharedAssets ??
    project.assets.filter((asset) => project.sharedAssetIds.includes(asset.id));
  const selectedNodes =
    project.sharedNodes ??
    project.nodes.filter((node) => project.sharedNodeIds.includes(node.id));
  // Previously shared versions stay frozen unless the author explicitly selected a replacement.
  const assetsById = new Map(
    [...project.assets, ...selectedAssets].map((asset) => [asset.id, asset]),
  );
  const nodesById = new Map(
    [...project.nodes, ...selectedNodes].map((node) => [node.id, node]),
  );
  const assets: Asset[] = [],
    nodes: CanvasNode[] = [];
  const includedAssets = new Set<string>(),
    activeAssets = new Set<string>(),
    includedNodes = new Set<string>();
  function includeAsset(id: string) {
    if (activeAssets.has(id))
      throw new Error(
        `A source reference cycle includes ${assetsById.get(id)?.name || id}. Repair it before publishing.`,
      );
    if (includedAssets.has(id)) return;
    const asset = assetsById.get(id);
    if (!asset)
      throw new Error(
        `A source or parent reference is missing (${id}). Restore its binding before publishing.`,
      );
    activeAssets.add(id);
    for (const reference of [
      ...asset.refs,
      ...(asset.parentId ? [asset.parentId] : []),
    ])
      includeAsset(reference);
    activeAssets.delete(id);
    includedAssets.add(id);
    assets.push(structuredClone(asset));
  }
  function includeNode(id: string) {
    if (includedNodes.has(id)) return;
    const node = nodesById.get(id);
    if (!node)
      throw new Error(
        `A linked node is missing (${id}). Restore its binding before publishing.`,
      );
    includedNodes.add(id);
    for (const linked of node.linked) includeNode(linked);
    if (node.assetId) includeAsset(node.assetId);
    if (node.scriptScene?.sourceAssetId) includeAsset(node.scriptScene.sourceAssetId);
    for (const version of node.versions ?? [])
      if (version.assetId) includeAsset(version.assetId);
    nodes.push(structuredClone(node));
  }
  selectedAssets.forEach((asset) => includeAsset(asset.id));
  selectedNodes.forEach((node) => includeNode(node.id));
  if (project.scriptSource) includeAsset(project.scriptSource.assetId);
  if (assets.length > 500 || nodes.length > 250)
    throw new Error(
      "The shared context exceeds the production asset or node limit.",
    );
  return {
    brief: project.brief,
    script: project.script || "",
    scriptSource: project.scriptSource,
    scriptReviews: project.scriptReviews,
    direction: project.direction,
    assets,
    nodes,
  };
}
