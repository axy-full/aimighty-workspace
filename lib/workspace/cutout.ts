import { STILL_TOOLS } from "../stillTools";
import type { GenerationBodyInput } from "../workbench/generation-request";
import { mediaReferenceIdentity } from "../workbench/media-reference-input";
import { isReferenceNode, refKindOf } from "../workbench/ref-kind";
import type { Asset, CanvasNode, NodeVersion, Project } from "../workbench/studio";
import { pendingGenerationKey } from "../workbench/pending-generation";

/*
 * The cut-out on the Rig (Luma's master reference: the real product, kept as a
 * transparent master, so a generated scene can sit behind it). An Element
 * card's picture is lifted off its background by Particl's own still
 * background-removal engine (the "Cut out" still tool, lib/stillTools.ts). It
 * is an explicit, priced action — the approximate price is shown and approved
 * first, like any render — never automatic on import. The result is a new
 * version of the card's source, a transparent PNG; the original stays, as
 * the version before it and saved on the card.
 */

/** The still tool that does it. */
export const CUTOUT_MODEL = STILL_TOOLS.find((t) => t.id === "cutout")!.modelId;

export const CUTOUT_COPY = {
  notReference: "Only a reference card can be cut out.",
  kind: "Cut-outs are for a person, a product or a prop, not a place.",
  master: "This card is a locked master, so its source stays as it is. Cut a picture out before locking it; an admin can unlock it to change it.",
  noSource: "Attach a picture to this card first.",
  notStill: "Only a still can be cut out.",
  unstored: "Upload this picture before cutting it out.",
  moved: "The card's source changed while the cut-out ran, so it was not applied. The cut-out is in the production's library.",
  gone: "That card is no longer on the canvas.",
} as const;

type Sources = Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>;
const assetIn = (project: Sources, id: string | undefined) => (id ? (project.assets.find((a) => a.id === id) ?? project.sharedAssets?.find((a) => a.id === id)) : undefined);

/** Why this card cannot be cut out now, or null. `masterLocked`: it is a locked master. */
export function cutoutProblem(project: Sources, node: CanvasNode | undefined, masterLocked: boolean): string | null {
  if (!node) return CUTOUT_COPY.gone;
  if (!isReferenceNode(node)) return CUTOUT_COPY.notReference;
  const kind = refKindOf(node, project);
  if (kind !== "element" && kind !== "cast") return CUTOUT_COPY.kind;
  if (masterLocked) return CUTOUT_COPY.master;
  const asset = assetIn(project, node.assetId);
  if (!asset) return CUTOUT_COPY.noSource;
  if (asset.kind !== "image") return CUTOUT_COPY.notStill;
  return mediaReferenceIdentity(asset) ? null : CUTOUT_COPY.unstored;
}

/**
 * The request the cut-out sends to POST /api/generate (and prices first with
 * POST /api/generate/quote): the one still, no words, filed under the
 * production and no shot. Null when the card cannot be cut out.
 */
export function cutoutRequest(project: Project, node: CanvasNode): GenerationBodyInput | null {
  const productionProjectId = project.productionProjectId;
  const asset = assetIn(project, node.assetId);
  const identity = asset ? mediaReferenceIdentity(asset) : null;
  if (!productionProjectId || !asset || asset.kind !== "image" || !identity) return null;
  return {
    prompt: "",
    kind: "image",
    model: { id: CUTOUT_MODEL },
    mapping: { shotId: "", productionProjectId },
    ratio: "adaptive",
    resolution: "adaptive",
    duration: 0,
    references: [{ ...identity, role: "reference_image" }],
  };
}

/** Where a cut-out's claimed request waits while it is sent (lib/workbench/pending-generation): one per card. */
export const cutoutClaimKey = (scope: string, draftId: string, nodeId: string) => pendingGenerationKey(scope, draftId, `cutout:${nodeId}`);
/** Where a running cut-out is remembered until it is filed on its card, so leaving the page never loses it. */
export const cutoutRunKey = (scope: string, draftId: string, nodeId: string) => `particl:rig-cutout:${JSON.stringify([scope, draftId, nodeId])}`;
export type CutoutRun = { jobId: string; sourceAssetId: string; credits: number };

export function readCutoutRun(value: string | null): CutoutRun | null {
  if (!value) return null;
  try {
    const run = JSON.parse(value) as CutoutRun;
    return typeof run?.jobId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(run.jobId) && typeof run.sourceAssetId === "string" && Number.isFinite(run.credits) ? run : null;
  } catch { return null; }
}

/** The cut-out's asset: the next version of the source, filed as a transparent PNG made from it. */
export function cutoutAsset(source: Asset, jobId: string): Asset {
  return {
    id: jobId,
    generationId: jobId,
    name: `${source.name} · cut out`.slice(0, 200),
    kind: "image",
    category: source.category,
    url: `/api/media/${encodeURIComponent(jobId)}`,
    description: "Cut out: the background removed, transparent behind the subject.",
    prompt: "",
    status: "Draft",
    locked: false,
    version: source.version + 1,
    refs: [source.id],
    parentId: source.id,
    mime: "image/png",
  };
}

/**
 * A finished cut-out filed on its card: the new version becomes the card's
 * source, and the original is kept, saved on the card, so it stays on the
 * canvas for everyone and can be seen in the card's versions. Refused (the
 * reason) when the card is gone or shows another source now. Filing the same
 * cut-out twice changes nothing.
 */
export function fileCutout(project: Project, nodeId: string, sourceAssetId: string, jobId: string, savedAt: string): Project | string {
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node) return CUTOUT_COPY.gone;
  const filed = assetIn(project, jobId);
  if (node.assetId === jobId && filed) return project;
  if (node.assetId !== sourceAssetId) return CUTOUT_COPY.moved;
  const source = assetIn(project, sourceAssetId);
  if (!source) return CUTOUT_COPY.moved;
  const asset = filed ?? cutoutAsset(source, jobId);
  const original: NodeVersion = { id: `original-${source.id}`.slice(0, 100), label: `Original · ${source.name}`.slice(0, 200), assetId: source.id, operations: [], savedAt };
  const versions = (node.versions ?? []).some((v) => v.assetId === source.id) ? node.versions ?? [] : [...(node.versions ?? []), original].slice(-30);
  return {
    ...project,
    assets: filed ? project.assets : [...project.assets, asset],
    nodes: project.nodes.map((n) => (n.id === nodeId ? { ...n, assetId: asset.id, versions } : n)),
  };
}
