import type { AtomikEffortOption } from '../atomik-reasoning';

/** `write` is the Brief's script writer: the director's prompt (the brief) in, a full script out, redrafted from notes until approved. */
export type DevelopmentKind = 'idea' | 'screenplay' | 'adfilm' | 'write';
export type DevelopmentStage = 'draft' | 'critique' | 'refine';
export type DevelopmentRequest = {
  projectId: string; requestId: string; kind: DevelopmentKind; model: string;
  effort: string; instructions?: string; sourceHash?: string;
  maxCredits?: number; maxUsd?: number;
  /** `write` only: redraft the script a finished writer run produced, with `instructions` as the director's notes. */
  fromJobId?: string;
  /** `write` only: redraft the project's script so it plays the director's edited beat sheet. */
  fromBeats?: true;
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
