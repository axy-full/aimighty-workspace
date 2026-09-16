import { z } from "zod";
import { validateBins } from "./editorial";
import { validateColor } from "./color";
import { validateAudio } from "./audio";
import type { Project } from "./studio";
import { MAX_SCRIPT_CHARS, MAX_SCRIPT_PAGES } from "./screenplay";
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
  developmentSource: z.object({ jobId:z.string().max(100), sourceHash:z.string().regex(/^[a-f0-9]{64}$/), sceneId:z.string().max(100), sourceAssetId:z.string().max(100).optional(), sourceStart:z.number().int().min(0).max(MAX_SCRIPT_CHARS), sourceEnd:z.number().int().min(1).max(MAX_SCRIPT_CHARS) }).optional(),
  scriptScene: z
    .object({
      id: z.string().max(100),
      sourceKey: z.string().max(64),
      sourceAssetId: z.string().max(100).optional(),
      pageStart: z.number().int().min(1).max(MAX_SCRIPT_PAGES).optional(),
      pageEnd: z.number().int().min(1).max(MAX_SCRIPT_PAGES).optional(),
    })
    .optional(),
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
  effort: z.string().max(40).optional(),
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
  bins: z.array(z.object({id:z.string().min(1).max(100),name:z.string().trim().min(1).max(80),assetIds:z.array(z.string().max(100)).max(500)})).max(50).optional(),
  assets: z.array(asset).max(500),
  nodes: z.array(node).max(250),
  shots: z.array(shot).max(250),
  plans: z.array(plan).max(100),
  briefPinned: z.boolean(),
  lookPinned: z.boolean(),
  createdAt: z.string().max(50),
  sharedAssetIds: z.array(z.string()).max(500),
  sharedNodeIds: z.array(z.string()).max(250),
  colorGrade: z
    .object({
      lutAssetId: z.string().min(1).max(100).optional(),
      mix: z.number().min(0).max(1),
      brightness: z.number().min(0).max(2),
      contrast: z.number().min(0).max(2),
      saturation: z.number().min(0).max(2),
      bypassed: z.boolean(),
    })
    .optional(),
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
  script: z.string().max(MAX_SCRIPT_CHARS).optional(),
  scriptFormat: z.enum(["screenplay", "adfilm"]).optional(),
  scriptSource: z
    .object({
      assetId: z.string().max(100),
      filename: z.string().max(200),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      pages: z
        .array(
          z.object({
            page: z.number().int().min(1).max(MAX_SCRIPT_PAGES),
            start: z.number().int().min(0).max(MAX_SCRIPT_CHARS),
            end: z.number().int().min(0).max(MAX_SCRIPT_CHARS),
          }),
        )
        .max(MAX_SCRIPT_PAGES),
      importedAt: z.string().max(50),
      edited: z.boolean(),
      ocr: z.object({
        engine: z.literal("tesseract-7.0.0"),
        language: z.literal("eng"),
        requestedPages: z.array(z.number().int().min(1).max(MAX_SCRIPT_PAGES)).min(1).max(MAX_SCRIPT_PAGES),
        pages: z.array(z.object({
          page: z.number().int().min(1).max(MAX_SCRIPT_PAGES),
          confidence: z.number().min(0).max(100),
          reviewed: z.literal(true),
          corrected: z.boolean(),
        })).min(1).max(MAX_SCRIPT_PAGES),
      }).optional(),
      acknowledgedEmptyPages: z
        .array(z.number().int().min(1).max(MAX_SCRIPT_PAGES))
        .max(MAX_SCRIPT_PAGES),
    })
    .optional(),
  developmentApplications: z.array(z.string().max(240)).max(1000).optional(),
  scriptReviews: z
    .record(
      z.string().max(100),
      z.object({
        sourceKey: z.string().max(64),
        intent: z.string().max(5000),
        beats: z.array(z.string().max(5000)).max(100),
      }),
    )
    .refine((value) => Object.keys(value).length <= 500)
    .optional(),
  sharedNodes: z.array(node).max(250).optional(),
  sharedAssets: z.array(asset).max(500).optional(),
});

export const saveSchema = z
  .object({
    project: projectSchema,
    revision: z.number().int().min(0),
  })
  .superRefine(({ project }, context) => {
    try {validateBins(project as Project);} catch(error) {context.addIssue({code:"custom",path:["project","bins"],message:(error as Error).message});}

    try {
      validateAudio(project as Project);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["project", "audioClips"],
        message: (error as Error).message,
      });
    }
    try {
      validateColor(project as Project);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["project", "colorGrade"],
        message: (error as Error).message,
      });
    }
    const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
    const source = project.scriptSource;
    if (source) {
      const asset = assets.get(source.assetId);
      if (!asset || asset.kind !== "document" || !asset.uploadId)
        context.addIssue({
          code: "custom",
          message: "Keep the uploaded screenplay source in the asset library.",
          path: ["project", "scriptSource"],
        });
      if (source.ocr) {
        const requested = source.ocr.requestedPages, recognized = source.ocr.pages.map(page => page.page);
        if (new Set(requested).size !== requested.length || new Set(recognized).size !== recognized.length || requested.length !== recognized.length || requested.some(page => page > source.pages.length || !recognized.includes(page)))
          context.addIssue({ code: "custom", path: ["project", "scriptSource", "ocr"], message: "Complete and review every requested OCR page before saving." });
      }
      let end = 0;
      source.pages.forEach((page, index) => {
        if (
          page.page !== index + 1 ||
          page.start !== end ||
          page.end <= page.start
        )
          context.addIssue({
            code: "custom",
            message: "Invalid screenplay page boundaries.",
            path: ["project", "scriptSource", "pages", index],
          });
        end = page.end;
      });
      if (
        source.pages.length &&
        !source.edited &&
        end !== (project.script || "").length
      )
        context.addIssue({
          code: "custom",
          message:
            "The screenplay page mapping no longer matches its source text.",
          path: ["project", "scriptSource"],
        });
    }
    for (const node of project.nodes)
      if (
        (node.scriptScene?.sourceAssetId && !assets.has(node.scriptScene.sourceAssetId)) ||
        (node.developmentSource?.sourceAssetId && !assets.has(node.developmentSource.sourceAssetId))
      )
        context.addIssue({
          code: "custom",
          message: "Keep the original source for each screenplay node.",
          path: ["project", "nodes"],
        });
  });
