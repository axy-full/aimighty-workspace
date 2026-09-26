import { RigBuildError, addInput, setFirstFrame } from "@/lib/production/rig-build";
import type { DevelopmentResult } from "@/lib/workbench/development-types";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import { shotPatch } from "@/lib/workspace/shots";

/**
 * Production › Rig › "Let the agent wire this shot". A finished `rig` run is
 * applied to its shot once: the shot records the run it took its wiring from
 * (`wiredJobId`, saved with the draft like Cast's and Environment's
 * `agentJobId`), so a new tab, another device or a teammate never lays an old
 * wiring over the director's own prompt, notes and inputs again.
 */
export type RigWiring = NonNullable<DevelopmentResult["rig"]>;

/**
 * The runs this tab saw queued or running. A shot that has never recorded a
 * wiring may already carry one applied before shots recorded it, so its run
 * is laid on unasked only when this tab watched it finish; otherwise it is
 * offered.
 */
const watched = new Set<string>();
export function watchWiring(jobId: string) { watched.add(jobId); }
export function watchedWiring(jobId: string) { return watched.has(jobId); }

/** `applied`: nothing to do; `apply`: lay it on the shot now; `offer`: ask first. */
export function wiringDecision(node: Pick<CanvasNode, "wiredJobId"> | undefined, jobId: string, watchedHere: boolean): "applied" | "apply" | "offer" {
  if (!node || node.wiredJobId === jobId) return "applied";
  /* A shot that took an earlier recorded wiring takes the newer run, as the other stages do. */
  return watchedHere || node.wiredJobId ? "apply" : "offer";
}

/** The run recorded on the shot without applying it: the director keeps what the shot has. */
export function keepWiring(project: Project, shotId: string, jobId: string): Project {
  return { ...project, nodes: project.nodes.map((n) => (n.id === shotId ? { ...n, wiredJobId: jobId } : n)) };
}

/** The shot with the agent's prompt, notes, inputs and first frame, and the run recorded. Inputs it cannot take are skipped. */
export function wireShot(project: Project, shotId: string, jobId: string, wired: RigWiring): { project: Project; inputs: number } {
  let next = shotPatch(project, shotId, { prompt: wired.prompt, note: wired.notes.slice(0, 5000) });
  let inputs = 0;
  for (const id of wired.inputs) {
    const asset = next.assets.find((a) => a.id === id);
    const shot = next.nodes.find((n) => n.id === shotId);
    if (!asset || !shot || shot.linked.some((l) => next.nodes.find((m) => m.id === l)?.assetId === id)) continue;
    try { next = addInput(next, shotId, asset); inputs++; }
    catch (cause) { if (!(cause instanceof RigBuildError)) throw cause; }
  }
  if (wired.firstFrame) {
    try { next = setFirstFrame(next, shotId, wired.firstFrame); }
    catch (cause) { if (!(cause instanceof RigBuildError)) throw cause; }
  }
  return { project: keepWiring(next, shotId, jobId), inputs };
}
