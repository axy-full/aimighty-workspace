import type { AtomikEffortOption } from '../atomik-reasoning';

/**
 * `write` is the Brief's script writer: the director's prompt (the brief) in, a full script out, redrafted from notes until approved.
 * `frames` writes a storyboard frame prompt for every shot of the beat sheet; `sketch` reads one shot's rough drawing (vision) and writes its frame prompt.
 * `cast` writes the film's cast and elements, each with a Soul Cinema prompt.
 * `environment` builds the film's world: the rules every place shares, and each place with a plate prompt.
 * `condense` shortens one Rig shot's render prompt to fit the engine, keeping every visual instruction.
 * `rig` wires one Rig shot: its prompt and notes from the beat, and which of the project's pictures are its inputs.
 */
export type DevelopmentKind = 'idea' | 'screenplay' | 'adfilm' | 'write' | 'frames' | 'sketch' | 'cast' | 'environment' | 'condense' | 'rig';
export type DevelopmentStage = 'draft' | 'critique' | 'refine';
export type DevelopmentRequest = {
  projectId: string; requestId: string; kind: DevelopmentKind; model: string;
  effort: string; instructions?: string; sourceHash?: string;
  maxCredits?: number; maxUsd?: number;
  /** `write` only: redraft the script a finished writer run produced, with `instructions` as the director's notes. */
  fromJobId?: string;
  /** `write` only: redraft the project's script so it plays the director's edited beat sheet. */
  fromBeats?: true;
  /** `sketch` only: the beat-sheet shot and the uploaded drawing (a project asset) the agent reads. */
  shotId?: string; sketchAssetId?: string;
  /** `condense` only: the Rig shot whose render prompt is condensed. */
  nodeId?: string;
};
export type DevelopmentIdea = { title: string; logline: string; treatment: string; visualDirection: string; critique: string };
export type DevelopmentShot = { description: string; framing: string; movement: string; lighting: string; sound: string };
export type DevelopmentScene = {
  id: string; heading: string; sourceStart: number; sourceEnd: number;
  summary: string; beats: string[]; shots: DevelopmentShot[];
  characters: string[]; props: string[]; locations: string[]; productionNotes: string[];
};
/** The writer's draft: a complete script in industry format, with the agent's notes for the review. */
export type DevelopmentScript = { title: string; logline: string; text: string; notes: string[] };
export type DevelopmentResult = {
  summary: string; recommendation: string; ideas: DevelopmentIdea[];
  scenes: DevelopmentScene[]; critique: string[]; assumptions: string[];
  script?: DevelopmentScript;
  /** `frames`: one storyboard prompt per beat-sheet shot. */
  frames?: { shotId: string; prompt: string }[];
  /** `sketch`: what the drawing shows (the director's blocking) and the frame prompt that keeps it. */
  sketch?: { shotId: string; reading: string; prompt: string };
  /** `cast`: the characters and elements, each with its Soul Cinema prompt. */
  cast?: { name: string; kind: 'character' | 'element'; description: string; prompt: string; category?: 'character' | 'environment' | 'prop'; model?: 'soul_cinematic' | 'soul_2' | 'soul_location' | 'soul_cast' }[];
  /** `environment`: the world's shared rules, and each place with notes and a plate prompt. */
  environment?: { world: string; entries: { name: string; notes: string; prompt: string }[] };
  /** `condense`: the shorter render prompt, pinned to the key of the prompt it came from. */
  condensed?: { nodeId: string; key: string; text: string };
  /** `rig`: the shot's prompt, notes, inputs (project asset ids) and first frame, as the agent wired it. */
  rig?: { nodeId: string; prompt: string; notes: string; inputs: string[]; firstFrame: string | null };
};
export type DevelopmentQuote = {
  quoteOnly: true; model: string; effort: string; kind: DevelopmentKind;
  sourceHash: string; estimateCredits: number; estimateUsd?: number;
  chunks: number; calls: number; sourceCharacters: number;
};
export type DevelopmentJob = {
  id: string; requestId: string; projectId: string; productionProjectId: string | null;
  kind: DevelopmentKind; model: string; effort: string; instructions: string;
  /** `write` only: what the draft was written from. */
  source?: 'prompt' | 'draft' | 'beats';
  /** `sketch` only: the shot and the drawing it read. */
  shotId?: string; sketchAssetId?: string;
  nodeId?: string;
  sourceHash: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  completedChunks: number; totalChunks: number; currentStage: DevelopmentStage | 'complete';
  completedSteps: number; totalSteps: number;
  estimateCredits: number; estimateUsd?: number; credits: number | null; costUsd?: number | null;
  result: DevelopmentResult | null; error: string | null; createdAt: number; updatedAt: number;
  resultPage?: { offset: number; totalChunks: number; hasMore: boolean };
};
export type DevelopmentModel = {
  id: string; name: string; efforts: AtomikEffortOption[]; vision: boolean;
  inputPerMillion?: number; outputPerMillion?: number;
};
export type DevelopmentState = { configured: boolean; models: DevelopmentModel[]; jobs: DevelopmentJob[] };

/** Stable input identity; use the same serialized fields in browser and server. */
export function sourceCanonical(project: {
  name: string; brief: string; audience: string; deliverables: string; direction: string;
  script?: string; scriptFormat?: 'screenplay' | 'adfilm'; fps: number; aspect: string;
}, kind: DevelopmentKind): string {
  return JSON.stringify({ kind, name: project.name, brief: project.brief, audience: project.audience,
    deliverables: project.deliverables, direction: project.direction, fps: project.fps,
    aspect: project.aspect, ...(kind === 'idea' ? {} : { script: project.script ?? '', scriptFormat: project.scriptFormat ?? 'screenplay' }) });
}
