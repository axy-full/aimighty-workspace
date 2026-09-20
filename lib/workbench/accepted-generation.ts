import type { MoleculrGenerationOptions } from "./moleculr";
import type { Project } from "./studio";

/** What GenerationDialog reports back when a request was accepted. */
export type AcceptedGeneration = { prompt: string; options: MoleculrGenerationOptions };

/**
 * The draft after a generation was accepted for one node: the node's mode and
 * the prompt that was actually sent, and the campaign variant that cites it,
 * which records the settings so the same request can be rebuilt.
 *
 * Lifted verbatim out of Studio's GenerationDialog `onQueued` so every surface
 * that mounts the dialog — Studio's Rig and the Marketing Studio flow — writes
 * one rule rather than a copy of it. A locked node is never rewritten.
 */
export function applyAcceptedGeneration(
  project: Project,
  nodeId: string,
  kind: "image" | "video" | "audio" | undefined,
  accepted: AcceptedGeneration | undefined,
): Project {
  return {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === nodeId && !node.locked
        ? {
            ...node,
            ...(kind ? { mode: kind === "audio" ? "Audio" : kind === "video" ? "Video" : "Image" } : {}),
            ...(accepted ? { text: accepted.prompt } : {}),
          }
        : node,
    ),
    ...(accepted && project.moleculr
      ? {
          moleculr: {
            ...project.moleculr,
            variants: project.moleculr.variants.map((variant) =>
              variant.nodeId === nodeId
                ? { ...variant, ...(kind === "image" || kind === "video" ? { kind } : {}), generation: accepted.options }
                : variant,
            ),
          },
        }
      : {}),
  };
}
