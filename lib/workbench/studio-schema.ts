import { astraNativeSchema, astraNativeProposalSchema, validateAstraNativeBindings } from '../astra-blender/native';
import { astraSceneSchema } from '../astra-blender/scene';
import { astraProposalSchema, validateAstraBindings } from '../astra-blender/proposal';
import { z } from "zod";
import {brandKitSchema, productProfileSchema, productSourceSchema, creativeSchema} from "./moleculr-creative";
import {posterDocumentSchema} from "./moleculr-poster";
import {referenceAdSchema, referenceAdBindingSchema} from "./reference-ad";
import {referenceAdAnalysisSchema} from "./reference-ad-analysis";
import { suiteAgentPlanSchema } from "./suite-agent-plan";
import { MARKETING_BRIEF_LIMITS } from "./marketing-brief";
import { validateBins } from "./editorial";
import { validateMoleculrBindings } from "./moleculr-bindings";
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
  soulIdentityId: z.string().min(1).max(100).optional(),
  productionShotId: z.string().max(100).optional(),
  nodeId: z.string().max(100).optional(),
  parentId: z.string().optional(),
  mime: z.string().optional(),
  seconds: z.number().finite().positive().max(86400).optional(),
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
  firstFrameId: z.string().max(100).optional(),
  condensed: z.object({ key: z.string().regex(/^[a-f0-9]{16}$/), text: z.string().max(10000) }).strict().optional(),
  boardShotId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/).optional(),
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
  /* Rig shot fields (optional; absent on every older draft). Shape only here:
     the catalogue clamp lives in lib/workspace so a catalogue change can never
     make an existing draft unsaveable. */
  look: z.string().max(300).optional(),
  engine: z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/:-]+$/).optional(),
  durationS: z.number().int().min(1).max(60).optional(),
  ratio: z.string().regex(/^(?:adaptive|auto|\d{1,2}(?:\.\d{1,2})?:\d{1,2})$/).optional(),
  resolution: z.string().regex(/^[0-9A-Za-z]{1,12}$/).optional(),
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
  astraNative: astraNativeProposalSchema.optional(),
  astraBlender: astraProposalSchema.optional(),
  referenceAdAnalysis: referenceAdAnalysisSchema.optional(),
  suiteAgent: suiteAgentPlanSchema.optional(),
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
export const marketingBriefSchema = z.object({
  objective: z.string().max(MARKETING_BRIEF_LIMITS.objective),
  offer: z.string().max(MARKETING_BRIEF_LIMITS.offer),
  audience: z.string().max(MARKETING_BRIEF_LIMITS.audience),
  channels: z.array(z.string().trim().min(1).max(MARKETING_BRIEF_LIMITS.channel)).max(MARKETING_BRIEF_LIMITS.channels),
  tone: z.string().max(MARKETING_BRIEF_LIMITS.tone),
  constraints: z.string().max(MARKETING_BRIEF_LIMITS.constraints),
}).strict();
export const moleculrSchema = z.object({
  referenceAd:referenceAdSchema.optional(),
  brandKit:brandKitSchema.optional(),productDescription:z.string().max(4000).optional(),productBrand:z.string().max(200).optional(),productSource:productSourceSchema.optional(),
  products:z.array(productProfileSchema).max(24).refine(items=>new Set(items.map(item=>item.id)).size===items.length).optional(),activeProductId:z.string().min(1).max(100).optional(),creative:creativeSchema.optional(),poster:posterDocumentSchema.optional(),
  marketing:z.object({quality:z.enum(["low","medium","high"]),enhancePrompt:z.boolean(),presetId:z.string().uuid().optional(),presetName:z.string().max(300).optional()}).strict().optional(),
  productName:z.string().max(200),productUrl:z.string().max(2000),
  productAssetIds:z.array(z.string().max(100)).max(5),castAssetIds:z.array(z.string().max(100)).max(6),
  format:z.enum(['ugc-review','tutorial','unboxing','try-on','cgi','cinematic-demo','poster','marketplace','motion']),
  hooks:z.array(z.string().max(500)).max(12),notes:z.string().max(6000),
  variants:z.array(z.object({id:z.string().max(100),nodeId:z.string().max(100),hook:z.string().max(500),castAssetId:z.string().max(100).optional(),kind:z.enum(["image","video"]).optional(),productId:z.string().max(100).optional(),templateId:z.string().max(100).optional(),createdAt:z.string().datetime().optional(),referenceVideo:referenceAdBindingSchema.optional(),generation:z.object({modelId:z.string().max(200).optional(),resolution:z.string().max(30).optional(),firstFrameAssetId:z.string().max(100).optional(),soulIdentityId:z.string().max(100).optional(),soulStrength:z.number().min(0).max(1).optional(),ratio:z.string().max(20).optional(),duration:z.number().int().min(1).max(60).optional(),marketing:z.object({quality:z.enum(["low","medium","high"]),enhancePrompt:z.boolean(),presetId:z.string().uuid().optional()}).strict().optional()}).strict().optional()}).strict()).max(100),
}).strict();
export const productionSchema = z.object({
  scriptApproval: z.object({
    at: z.string().datetime(), source: z.enum(['agent', 'hand']),
    jobId: z.string().regex(/^wb_development_[a-f0-9-]+$/).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  beats: z.object({
    jobId: z.string().regex(/^wb_development_[a-f0-9-]+$/).optional(), scriptSha256: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: z.string().datetime(),
    scenes: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), heading: z.string().max(300), summary: z.string().max(4000),
      beats: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), text: z.string().max(800) }).strict()).max(40),
      shots: z.array(z.object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), description: z.string().max(800), framing: z.string().max(200), movement: z.string().max(200),
        lighting: z.string().max(200), sound: z.string().max(200), duration: z.number().min(0.5).max(600).optional(),
      }).strict()).max(40),
      characters: z.array(z.string().max(200)).max(30), locations: z.array(z.string().max(200)).max(15), props: z.array(z.string().max(200)).max(30),
    }).strict()).max(200),
  }).strict().optional(),
  boards: z.object({
    style: z.enum(['live', 'color-sketch', 'bw-sketch']), model: z.enum(['gemini-3.1-flash-image', 'gemini-3-pro-image']),
    frames: z.record(z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), z.object({
      prompt: z.string().max(8000),
      sketch: z.object({ assetId: z.string().max(100), name: z.string().max(200) }).strict().optional(),
      reading: z.string().max(4000).optional(), readingJobId: z.string().regex(/^wb_development_[a-f0-9-]+$/).optional(),
      takes: z.array(z.object({ genId: z.string().max(100), style: z.enum(['live', 'color-sketch', 'bw-sketch']), at: z.string().datetime() }).strict()).max(20),
      selected: z.string().max(100).optional(),
      pending: z.array(z.object({ jobId: z.string().max(100), style: z.enum(['live', 'color-sketch', 'bw-sketch']), at: z.string().datetime() }).strict()).max(5).optional(),
    }).strict()).refine((value) => Object.keys(value).length <= 2000),
    promptsJobId: z.string().regex(/^wb_development_[a-f0-9-]+$/).optional(),
  }).strict().optional(),
  cast: z.object({
    entries: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), name: z.string().max(120), kind: z.enum(['character', 'element']),
      description: z.string().max(2000), prompt: z.string().max(5000), soulId: z.string().max(200).optional(), referenceAssetId: z.string().max(100).optional(),
      takes: z.array(z.object({ genId: z.string().max(100), at: z.string().datetime() }).strict()).max(20), selected: z.string().max(100).optional(),
      job: z.object({ id: z.string().uuid(), status: z.enum(['quoted', 'submitted']) }).strict().optional(),
    }).strict()).max(100),
    agentJobId: z.string().regex(/^wb_development_[a-f0-9-]+$/).optional(),
  }).strict().optional(),
}).strict();
export const projectSchema = z.object({
  production: productionSchema.optional(),
  astraNative: astraNativeSchema.optional(),
  astraBlender: astraSceneSchema.optional(),
  moleculr:moleculrSchema.optional(),
  marketingBrief: marketingBriefSchema.optional(),
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
    try { if (project.astraNative) validateAstraNativeBindings(project.astraNative, [...project.assets, ...(project.sharedAssets ?? [])]); } catch(error) {context.addIssue({code:"custom",path:["project","astraNative"],message:(error as Error).message});}
    try { if (project.astraBlender) validateAstraBindings(project.astraBlender, [...project.assets, ...(project.sharedAssets ?? [])]); } catch(error) {context.addIssue({code:"custom",path:["project","astraBlender"],message:(error as Error).message});}
    try {validateMoleculrBindings(project as Project);} catch(error) {context.addIssue({code:"custom",path:["project","moleculr"],message:(error as Error).message});}
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
