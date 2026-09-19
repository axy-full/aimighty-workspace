import { generationRequestBody, type GenerationBodyInput, type GenerationReference } from "../workbench/generation-request";
import { mediaReferenceIdentity } from "../workbench/media-reference-input";
import { generationBrief } from "../workbench/node-graph";
import type { CanvasNode, Project } from "../workbench/studio";
import { shotEngine } from "./engines";
import { referenceRole, shotReferenceAssets } from "./rig";
import type { RigShot } from "./shots";

/**
 * The /api/generate request a Rig shot sends — GenerationDialog's body
 * (lib/workbench/generation-request.ts) filled from the shot: the node's
 * generation brief as the prompt, the shot's engine, ratio, resolution and
 * duration, its production mapping, and its bound references with their
 * default roles. The Rig's Generate and the Atomik Rig plan both use it, so
 * a plan can never send a body the page would not.
 */

export type ShotRequestSource = Pick<RigShot, "id" | "engine" | "ratio" | "resolution" | "durationS">;

export function shotRequestInput(
  project: Project,
  node: CanvasNode,
  shot: ShotRequestSource,
  mapping: { shotId: string; productionProjectId: string },
  references: GenerationReference[],
): GenerationBodyInput | null {
  const model = shotEngine(shot.engine);
  if (!model) return null;
  return {
    prompt: generationBrief(node, project),
    kind: model.kind,
    model,
    mapping,
    ratio: shot.ratio,
    resolution: shot.resolution,
    duration: shot.durationS ?? 5,
    references,
    firstFrameAssetId: "",
  };
}

export type NamedShotBody = { name: string; body: Record<string, unknown> };

/**
 * Bodies for every ready shot that can be priced without a side effect:
 * it already has a production mapping and every bound reference is already
 * saved (an upload or a generation). Shots that still need either are left
 * out — the Rig maps and uploads them on their first Generate — so a plan
 * built from this list never guesses a mapping or a reference.
 */
export function rigPlanRequests(project: Project, shots: readonly RigShot[]): NamedShotBody[] {
  const out: NamedShotBody[] = [];
  for (const shot of shots) {
    if (shot.status !== "ready") continue;
    const node = project.nodes.find((n) => n.id === shot.id);
    const shotId = project.shotMappings?.[shot.id];
    if (!node || !shotId || !project.productionProjectId) continue;
    const refs = shotReferenceAssets(project, node);
    const references = refs.flatMap((asset) => {
      const identity = mediaReferenceIdentity(asset);
      return identity ? [{ ...identity, role: referenceRole(asset) }] : [];
    });
    if (references.length !== refs.length) continue;
    const input = shotRequestInput(project, node, shot, { shotId, productionProjectId: project.productionProjectId }, references);
    if (input) out.push({ name: shot.name, body: generationRequestBody(input) });
  }
  return out;
}
