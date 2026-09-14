import { z } from "zod";
import type { AdmissionQuote, PreparedAdmission } from "../admissionTypes";

export const PIPELINE_LIMITS = {
  stages: 32,
  units: 64,
  inputs: 12,
  sourceBytes: 1_000_000,
  attemptsPerUnit: 20,
} as const;
export const pipelineId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const label = z.string().trim().min(1).max(120);
const model = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_./:-]+$/);
export const mediaKind = z.enum(["image", "video", "audio"]);
export const inputRole = z.enum([
  "first_frame",
  "last_frame",
  "reference_image",
  "reference_video",
]);
export const outputRef = z
  .object({
    stageId: pipelineId,
    unit: z.number().int().min(0).max(7).default(0),
  })
  .strict();
const promptSource = z.discriminatedUnion("source", [
  z.object({ source: z.literal("node"), nodeId: pipelineId }).strict(),
  z.object({ source: z.enum(["brief", "script", "direction"]) }).strict(),
]);
export const pipelineInput = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("asset"),
      assetId: pipelineId,
      role: inputRole,
    })
    .strict(),
  z
    .object({ source: z.literal("stage"), ...outputRef.shape, role: inputRole })
    .strict(),
]);
const visual = {
  id: pipelineId,
  label,
  model,
  prompt: promptSource,
  inputs: z.array(pipelineInput).max(PIPELINE_LIMITS.inputs).default([]),
  ratio: z
    .enum([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "4:5",
      "5:4",
      "21:9",
    ])
    .default("16:9"),
  resolution: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9]+$/),
  seed: z.number().int().min(0).max(2_147_483_647).nullable().default(null),
};
const imageStage = z
  .object({
    ...visual,
    kind: z.literal("image"),
    units: z.number().int().min(1).max(8).default(1),
  })
  .strict();
const videoStage = z
  .object({
    ...visual,
    kind: z.literal("video"),
    units: z.number().int().min(1).max(4).default(1),
    duration: z.number().min(1).max(30),
    generateAudio: z.boolean().default(false),
  })
  .strict();
const audioStage = z
  .object({
    id: pipelineId,
    label,
    kind: z.literal("audio"),
    model,
    prompt: promptSource,
    units: z.literal(1).default(1),
    task: z.enum(["speech", "sound", "music"]),
    voiceId: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9_-]*$/)
      .optional(),
    durationSeconds: z.number().min(0.5).max(180).optional(),
    settings: z
      .object({
        stability: z.number().min(0).max(1).optional(),
        similarity_boost: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        speed: z.number().min(0.7).max(1.2).optional(),
        use_speaker_boost: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
const reviewStage = z
  .object({
    id: pipelineId,
    label,
    kind: z.literal("review"),
    candidates: z.array(outputRef).min(1).max(PIPELINE_LIMITS.units),
  })
  .strict();
const assemblyStage = z
  .object({
    id: pipelineId,
    label,
    kind: z.literal("assembly"),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
    aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]),
    clips: z
      .array(
        z
          .object({
            ...outputRef.shape,
            durationFrames: z.number().int().min(1).max(5400),
            sourceInFrame: z.number().int().min(0).max(5400).default(0),
            fit: z.literal("contain").default("contain"),
          })
          .strict(),
      )
      .min(1)
      .max(PIPELINE_LIMITS.units),
    soundtrack: outputRef.optional(),
  })
  .strict();
export const pipelineStage = z.discriminatedUnion("kind", [
  imageStage,
  videoStage,
  audioStage,
  reviewStage,
  assemblyStage,
]);
export const pipelineSpec = z
  .object({
    schemaVersion: z.literal(1),
    name: label,
    context: z
      .object({
        projectId: pipelineId,
        bibleVersion: z.number().int().positive(),
      })
      .strict(),
    stages: z.array(pipelineStage).min(1).max(PIPELINE_LIMITS.stages),
  })
  .strict();

export type PipelineSpec = z.infer<typeof pipelineSpec>;
export type PipelineStage = z.infer<typeof pipelineStage>;
export type PipelineMediaStage = Extract<
  PipelineStage,
  { kind: "image" | "video" | "audio" }
>;
export type OutputRef = z.infer<typeof outputRef>;
export type MediaKind = z.infer<typeof mediaKind>;
export type MediaSource = {
  kind: MediaKind;
  source: "upload" | "generation";
  id: string;
  assetId?: string;
  version?: number;
  sha256?: string;
  durationS?: number | null;
};
export type CompiledInput = { role: z.infer<typeof inputRole> } & (
  | { source: "asset"; media: MediaSource }
  | { source: "stage"; stageId: string; unit: number }
);
export type CompiledStage = {
  definition: PipelineStage;
  dependencies: string[];
  outputKind: MediaKind | "assembly";
  prompt?: string;
  inputs: CompiledInput[];
};
export type CompiledPipeline = {
  schemaVersion: 1;
  spec: PipelineSpec;
  contextHash: string;
  fingerprint: string;
  order: string[];
  stages: CompiledStage[];
  maximumUnits: number;
};
export type PipelineRunState =
  | "draft"
  | "awaiting_approval"
  | "running"
  | "paused"
  | "needs_review"
  | "blocked"
  | "succeeded"
  | "cancelled";
export type PipelineAttemptState =
  | "queued"
  | "submitting"
  | "running"
  | "uncertain"
  | "succeeded"
  | "failed"
  | "refused";
export type StageQuote = AdmissionQuote;
export type PreparedStageAdmission = PreparedAdmission;
export type PipelineAttempt = {
  id: string;
  runId: string;
  stageId: string;
  unit: number;
  number: number;
  requestKey: string;
  prepared: PreparedStageAdmission;
  state: PipelineAttemptState;
  generationId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
export type PipelineSelection = {
  stageId: string;
  candidate: OutputRef;
  generationId: string;
  kind: MediaKind;
  selectedBy: string;
  selectedAt: number;
};
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "pipeline_invalid",
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
