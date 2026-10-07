import { assetStill, type CastStill } from "./cast-model";
import { cutoutProblem } from "@/lib/workspace/cutout";
import { isReferenceNode } from "@/lib/workbench/ref-kind";
import type { Asset, Project } from "@/lib/workbench/studio";

/*
 * What a Cast card knows about its cut-out (the Cut-out action on a still, README gap screens: Cut-out). Pure: the
 * existing path files a finished cut-out as a new version of the card's source (lib/workspace/cutout.ts › fileCutout):
 * the new asset is `parentId`-linked to the original, which stays in the card's versions. Nothing here prices or sends.
 */

export type CutoutView = {
  /** The card's current source: the cut-out once there is one. */
  current: CastStill | null;
  /** The picture before the cut-out, when the current source is one. */
  before: CastStill | null;
  /** The current source is a cut-out of an earlier picture. */
  done: boolean;
  /** Why the card cannot be cut out now (not a still, no stored file…), or null. */
  problem: string | null;
};

const allAssets = (p: Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>): Asset[] => [...p.assets, ...(p.sharedAssets ?? [])];

export function cutoutView(project: Project, nodeId: string | null, master: boolean): CutoutView | null {
  const node = nodeId ? project.nodes.find((n) => n.id === nodeId) : undefined;
  if (!node || !isReferenceNode(node) || !node.assetId) return null;
  const assets = allAssets(project);
  const current = assets.find((a) => a.id === node.assetId);
  if (!current || current.kind !== "image") return null;
  const parent = current.parentId ? assets.find((a) => a.id === current.parentId) : undefined;
  const done = Boolean(parent) && /^Cut out/i.test(current.description);
  return { current: assetStill(current), before: done ? assetStill(parent) : null, done, problem: cutoutProblem(project, node, master) };
}
