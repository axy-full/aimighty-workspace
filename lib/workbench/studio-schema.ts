import { z } from "zod";
import { validateAudio } from "./audio";
import type { Project } from "./studio";
const asset = z.object({
  id: z.string().max(100),
  name: z.string().max(200),
  kind: z.enum(["image", "video", "audio", "document", "link"]),
  category: z.string().max(100),
  url: z
    .string()
    .max(3000)
    .refine(
      (s) =>
        s.startsWith("/campaign/") ||
        s.startsWith("/api/media/") ||
        s.startsWith("/api/uploads/") ||
        s.startsWith("/api/workbench/media/") ||
        /^https?:\/\//.test(s),
    ),
  description: z.string().max(5000),
  prompt: z.string().max(20000),
  status: z.enum(["Draft", "Selected", "Continuity note"]),
  locked: z.boolean(),
  version: z.number().int().positive(),
  refs: z.array(z.string()).max(100),
  uploadId: z.string().max(100).optional(),
  generationId: z.string().max(100).optional(),
  productionShotId: z.string().max(100).optional(),
  nodeId: z.string().max(100).optional(),
  parentId: z.string().optional(),
  mime: z.string().optional(),
});
const operation = z.object({
  id: z.string().max(100),
  kind: z.enum(["direction", "grade", "transform", "mask", "mix"]),
  enabled: z.boolean(),
  values: z.record(
    z.string().max(100),
    z.union([z.number().finite(), z.string().max(5000), z.boolean()]),
  ),
});
const node = z.object({
  id: z.string(),
  title: z.string().max(300),
  type: z.enum([
    "brief",
    "moodboard",
    "character",
    "element",
    "scene",
    "note",
    "media",
    "generate",
    "merge",
    "grade",
    "transform",
    "audio",
    "switch",
    "review",
    "output",
  ]),
  assetId: z.string().optional(),
  text: z.string().max(30000).optional(),
  x: z.number().min(-10000).max(20000),
  y: z.number().min(-10000).max(20000),
  width: z.number().min(150).max(1200),
  linked: z.array(z.string()).max(100),
  operations: z.array(operation).max(20).optional(),
  bypassed: z.boolean().optional(),
  locked: z.boolean().optional(),
  collapsed: z.boolean().optional(),
  role: z.string().max(100).optional(),
  mode: z.string().max(100).optional(),
  status: z.enum(["draft", "review", "approved"]).optional(),
  activeInput: z.string().max(100).optional(),
  versions: z
    .array(
      z.object({
        id: z.string().max(100),
        label: z.string().max(200),
        assetId: z.string().optional(),
        text: z.string().max(30000).optional(),
        operations: z.array(operation).max(20),
        savedAt: z.string().max(50),
      }),
    )
    .max(30)
    .optional(),
});
const shot = z.object({
  id: z.string(),
  name: z.string().max(300),
  assetId: z.string(),
  duration: z.number().int().min(1).max(216000),
  sourceIn: z.number().int().min(0).max(21600000),
  note: z.string().max(10000),
});
const plan = z.object({
  id: z.string(),
  request: z.string().max(20000),
  model: z.string().max(100),
  depth: z.string().max(100),
  intent: z.string().max(100),
  summary: z.string().max(5000),
  steps: z.array(z.string().max(10000)).max(50),
  applied: z.boolean(),
  refs: z.array(z.string()).max(100),
  role: z.string().max(100).optional(),
});
export const projectSchema = z.object({
  productionProjectId: z.string().max(100).optional(),
  shotMappings: z.record(z.string().max(100), z.string().max(100)).optional(),
  bibleVersion: z.number().int().min(0).optional(),
  id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  brief: z.string().max(30000),
  audience: z.string().max(10000),
  deliverables: z.string().max(10000),
  direction: z.string().max(30000),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]),
  assets: z.array(asset).max(500),
  nodes: z.array(node).max(250),
  shots: z.array(shot).max(250),
  plans: z.array(plan).max(100),
  briefPinned: z.boolean(),
  lookPinned: z.boolean(),
  createdAt: z.string().max(50),
  sharedAssetIds: z.array(z.string()).max(500),
  sharedNodeIds: z.array(z.string()).max(250),
  audioAssetId: z.string().optional(),
  clipAudio: z.boolean().optional(),
  audioClips: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        assetId: z.string().max(100),
        lane: z.enum(["dialogue", "music", "sfx"]),
        startFrame: z.number().int().min(0).max(21600000),
        sourceIn: z.number().int().min(0).max(21600000),
        duration: z.number().int().min(1).max(216000),
        gainDb: z.number().min(-60).max(12),
        pan: z.number().min(-1).max(1),
        fadeIn: z.number().int().min(0).max(216000),
        fadeOut: z.number().int().min(0).max(216000),
        muted: z.boolean(),
        solo: z.boolean(),
      }),
    )
    .max(64)
    .optional(),
  script: z.string().max(100000).optional(),
  sharedNodes: z.array(node).max(250).optional(),
  sharedAssets: z.array(asset).max(500).optional(),
});

export const saveSchema = z
  .object({
    project: projectSchema,
    revision: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    try {
      validateAudio(value.project as Project);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["project", "audioClips"],
        message: (error as Error).message,
      });
    }
  });
