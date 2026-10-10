import type { Generation } from "../../lib/jobs";
import type { TakeFailure } from "../../lib/providerOutcome";
import type { CanvasNode, Project } from "../../lib/workbench/studio";
import { libraryEntries, type LibraryEntry } from "../../lib/workspace/library";

/* Neutral fixtures for stream 5's board tests: no names from the design's samples. */

export const SEEDANCE = "dreamina-seedance-2-5-260628";
export const KLING = "fal-ai/kling-video/v3/standard";

let seq = 0;
export function gen(over: Partial<Generation> = {}): Generation {
  seq += 1;
  const id = over.id ?? `g${seq}`;
  return {
    id, projectId: "p1", projectName: "Project", arkTaskId: null, kind: "video",
    reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null, approvedBy: null, approvedAt: null,
    model: SEEDANCE, prompt: "A wide shot of the plate", title: null, params: { duration: 5, resolution: "1080p" },
    status: "succeeded", sourceUrl: null, storedUrl: `/stored/${id}.mp4`, totalTokens: null, costUsd: null, creditsBilled: 43,
    refineCostUsd: null, refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null,
    createdBy: "u1", authorName: "Person One", shotId: null, shotCode: null, shotScene: null, shotTitle: null,
    version: 1, durationMs: null, durationS: 5, provider: "ark", attempts: 1, task: "generate", sourceGenId: null,
    createdAt: 1_000_000, updatedAt: 1_000_000,
    ...over,
  };
}

export const entries = (generations: Generation[]): LibraryEntry[] => libraryEntries({ uploads: [], generations } as never);

export function shotNode(id: string, boardShotId?: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, title: `Card ${id}`, type: "scene", x: 0, y: 0, width: 344, linked: [], ...(boardShotId ? { boardShotId } : {}), ...extra } as CanvasNode;
}

/** Three shots from a beat sheet, mapped to production shots s1…s3. */
export function project(over: Partial<Project> = {}): Project {
  return {
    id: "draft1", name: "Project", description: "", brief: "", audience: "", deliverables: "", direction: "", fps: 24, aspect: "16:9",
    assets: [], shots: [], plans: [], briefPinned: false, lookPinned: false, createdAt: "2026-10-05T00:00:00Z",
    sharedAssetIds: [], sharedNodeIds: [],
    nodes: [shotNode("n1", "b1"), shotNode("n2", "b2"), shotNode("n3", "b3"), { id: "note", title: "A note", type: "note", x: 0, y: 0, width: 200, linked: [] } as CanvasNode],
    shotMappings: { n1: "s1", n2: "s2", n3: "s3" },
    production: {
      beats: {
        scriptSha256: "x", updatedAt: "2026-10-05T00:00:00Z",
        scenes: [{
          id: "sc1", heading: "EXT. PLACE", summary: "", beats: [], characters: ["Lead"], locations: ["Plate"], props: [],
          shots: [
            { id: "b1", description: "Wide", framing: "Extreme wide", movement: "Locked off", lighting: "", sound: "", duration: 4 },
            { id: "b2", description: "Push", framing: "Medium", movement: "Slow push", lighting: "", sound: "", duration: 6 },
            { id: "b3", description: "Close", framing: "Close-up", movement: "Held", lighting: "", sound: "", duration: 5 },
          ],
        }],
      },
    },
    ...over,
  } as Project;
}

export const unbilled = (): TakeFailure => ({ provider: null, stage: null, code: "x", kind: "provider_error", message: "The engine returned no frames", billing: null, payer: "platform", charge: { credits: 0, settled: true } } as TakeFailure);
export const charged = (credits: number): TakeFailure => ({ provider: null, stage: null, code: "x", kind: "provider_error", message: "The engine returned no frames", billing: null, payer: "platform", charge: { credits, settled: true } } as TakeFailure);
