import { DRAFT_RESOLUTION } from "@/lib/draftFinal";
import { generationRequestBody, type GenerationReference } from "@/lib/workbench/generation-request";
import { mediaReferenceIdentity } from "@/lib/workbench/media-reference-input";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import type { Project } from "@/lib/workbench/studio";
import { shotEngine } from "@/lib/workspace/engines";
import { shotReferenceAssets, shotReferenceRole } from "@/lib/workspace/rig";
import { shotRequestInput } from "@/lib/workspace/rig-requests";
import { rigShots } from "@/lib/workspace/shots";

/*
 * The plan's prices before the run prices them (lead decision 27; README § 3.1 e). Atomik's run prices a render
 * only when its turn comes, from the shot as the board has it (lib/workbench/rig-agent-runs.ts priceRenderOnce).
 * To show every step, its total and the balance after on the plan card, each render the plan names is quoted now,
 * on exactly that request: the Rig's own shot body, sent as a draft where the engine has one. The run prices it
 * again before anything is sent, and a price that moved is asked again: these are estimates, never approvals.
 */

/**
 * Which shot card each of the plan's renders is about. The run view names a render by its card's title (not its
 * id), so a step is matched only when exactly one shot card on the board has that title; otherwise it waits for
 * the run's own price.
 */
export function stepShots(run: Pick<RigAgentRunView, "paid">, project: Pick<Project, "nodes">): Map<number, string> {
  const byTitle = new Map<string, string[]>();
  for (const node of project.nodes) {
    if (node.type !== "scene" && node.type !== "generate") continue;
    byTitle.set(node.title, [...(byTitle.get(node.title) ?? []), node.id]);
  }
  const out = new Map<number, string>();
  for (const step of run.paid) {
    if (step.tool !== "render") continue;
    const ids = byTitle.get(step.title);
    if (ids?.length === 1) out.set(step.seq, ids[0]);
  }
  return out;
}

export type StepRequest = { body: Record<string, unknown>; meta: string; still: boolean };

/**
 * The request a render step will be priced at, and its engine line ("Seedance 2.5 · 5 s · 480p draft"); null when
 * the shot can't be priced yet (no engine, no prompt, a reference not saved, no production).
 */
export function stepRequest(project: Project, nodeId: string): StepRequest | null {
  const node = project.nodes.find((n) => n.id === nodeId);
  const shot = node ? rigShots(project).find((s) => s.id === nodeId) : undefined;
  const model = shot ? shotEngine(shot.engine) : null;
  if (!node || !shot || !model || !project.productionProjectId) return null;
  const references: GenerationReference[] = [];
  for (const asset of shotReferenceAssets(project, node)) {
    const identity = mediaReferenceIdentity(asset);
    if (!identity) return null;
    references.push({ ...identity, role: shotReferenceRole(node)(asset) });
  }
  const input = shotRequestInput(project, node, shot, { shotId: project.shotMappings?.[nodeId] ?? "", productionProjectId: project.productionProjectId }, references);
  if (!input) return null;
  const drafting = model.kind === "video" && Boolean(model.supportsDraft);
  const body = generationRequestBody({ ...input, ...(drafting ? { draft: true, resolution: DRAFT_RESOLUTION } : {}) });
  const parts = model.kind === "video"
    ? [model.label, `${input.duration} s`, drafting ? `${DRAFT_RESOLUTION} draft` : input.resolution]
    : [model.label, input.resolution];
  return { body, meta: parts.filter(Boolean).join(" · "), still: model.kind === "image" };
}
