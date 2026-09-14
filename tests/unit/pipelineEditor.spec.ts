import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { MODELS } from "../../lib/models";
import {
  buildPipelineSpec,
  effectivePipelineDraft,
  emptyPipelineDraft,
  pipelineMovieProject,
  type PipelineCatalog,
} from "../../lib/pipeline/editor";
import { compilePipeline } from "../../lib/pipeline/compile";
import * as schema from "../../lib/pipeline/schema";
import * as publicView from "../../lib/pipeline/public";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { moviePlan, defaultMovieOptions } from "../../lib/workbench/movie";

const publication = {
  projectId: "production",
  version: 1,
  name: "Film",
  prompts: [{ source: "brief", label: "Brief", preview: "A city at dawn" }],
  assets: [],
};
const catalog: PipelineCatalog = {
  publications: [publication],
  models: MODELS.filter(
    (m) =>
      !m.hidden &&
      !m.stillTask &&
      m.ratios.includes("16:9") &&
      (!m.supportsTasks || m.supportsTasks.includes("generate")),
  ).map((m) => ({ ...m, configured: true })),
  audioModels: {
    speech: [{ id: "speech-model", label: "Voice" }],
    sound: "sound-model",
    music: "music-model",
  },
};
function service() {
  const dependencies = {
    "../models": { MODELS },
    "../generationAdmission": {},
    "../audioAdmission": {},
    "../elevenlabs": {
      SPEECH_MODELS: catalog.audioModels.speech,
      SFX_MODEL: catalog.audioModels.sound,
      MUSIC_MODEL: catalog.audioModels.music,
    },
    "./schema": schema,
    "./public": publicView,
    "./store": {},
  };
  const compiled = ts.transpileModule(
    readFileSync(path.resolve("lib/pipeline/service.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const mod = { exports: {} as typeof import("../../lib/pipeline/service") };
  new Function("require", "module", "exports", compiled)(
    (name: keyof typeof dependencies) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}

test("guided settings displayed to the user are the exact model capabilities saved in the DAG", () => {
  const values = effectivePipelineDraft(
    {
      ...emptyPipelineDraft,
      duration: 100,
      imageResolution: "bogus",
      ratio: "4:5",
    },
    catalog,
  );
  const compiled = compilePipeline(
    buildPipelineSpec(values, publication, catalog),
    {
      projectId: "production",
      version: 1,
      body: { brief: "A city at dawn", assets: [], nodes: [] },
    },
  );
  const api = service();
  const image = compiled.stages.find((s) => s.definition.kind === "image")!;
  const video = compiled.stages.find((s) => s.definition.kind === "video")!;
  expect(
    api.stageRequest(
      image,
      { references: [], inputHash: "bound" },
      "production",
      0,
    ),
  ).toMatchObject({
    model: values.imageModel,
    ratio: values.ratio,
    resolution: values.imageResolution,
    refine: false,
  });
  expect(
    api.stageRequest(
      video,
      {
        references: [
          {
            id: "selected-take",
            source: "generation",
            kind: "image",
            role: "first_frame",
            bindingHash: "hash",
          },
        ],
        inputHash: "bound",
      },
      "production",
      0,
    ),
  ).toMatchObject({
    model: values.videoModel,
    duration: values.duration,
    references: [{ genId: "selected-take", role: "first_frame" }],
  });
  expect(() =>
    api.stageRequest(
      {
        ...video,
        definition: {
          ...video.definition,
          duration: 999,
        } as typeof video.definition,
      },
      { references: [], inputHash: "bound" },
      "production",
      0,
    ),
  ).toThrow(/duration/);
  expect(() =>
    api.stageRequest(
      {
        ...image,
        definition: { ...image.definition, seed: 1 } as typeof image.definition,
      },
      { references: [], inputHash: "bound" },
      "production",
      0,
    ),
  ).toThrow(/fixed seed/);
});

test("speech and music settings map to the existing admission fields without silent clamping", () => {
  const compile = (draft: typeof emptyPipelineDraft) =>
    compilePipeline(buildPipelineSpec(draft, publication, catalog), {
      projectId: "production",
      version: 1,
      body: { brief: "A city at dawn", assets: [], nodes: [] },
    }).stages[0];
  const api = service(),
    inputs = { references: [], inputHash: "bound" };
  const music = compile({
    ...emptyPipelineDraft,
    output: "audio",
    audio: "music",
    audioSeconds: 12.5,
  });
  expect(api.stageRequest(music, inputs, "production", 0)).toMatchObject({
    task: "music",
    modelId: "music-model",
    lengthMs: 12500,
  });
  const speech = compile({
    ...emptyPipelineDraft,
    output: "audio",
    audio: "speech",
    voiceId: "voiceABC123",
  });
  expect(api.stageRequest(speech, inputs, "production", 0)).toMatchObject({
    task: "speech",
    voiceId: "voiceABC123",
    modelId: "speech-model",
  });
  const sound = compile({
    ...emptyPipelineDraft,
    output: "audio",
    audio: "sound",
    audioSeconds: 31,
  });
  expect(() => api.stageRequest(sound, inputs, "production", 0)).toThrow(
    /30 seconds/,
  );
});

test("movie handoff preserves selected IDs, frame timing, trim and soundtrack through the real exporter plan", () => {
  const project = pipelineMovieProject(
    "Film",
    { projectId: "production", bibleVersion: 3 },
    {
      version: 1,
      kind: "timeline-manifest",
      fps: 24,
      aspect: "9:16",
      clips: [
        {
          generationId: "still",
          kind: "image",
          durationFrames: 24,
          sourceInFrame: 0,
        },
        {
          generationId: "motion",
          kind: "video",
          durationFrames: 48,
          sourceInFrame: 12,
        },
      ],
      soundtrack: { generationId: "voice" },
    },
  );
  expect(projectSchema.safeParse(project).success).toBeTruthy();
  const plan = moviePlan(project, defaultMovieOptions);
  expect(plan.totalFrames).toBe(72);
  expect(plan.duration).toBe(3);
  expect(
    plan.clips.map((c) => [
      c.asset.generationId,
      c.startFrame,
      c.sourceIn,
      c.duration,
    ]),
  ).toEqual([
    ["still", 0, 0, 24],
    ["motion", 24, 12, 48],
  ]);
  expect(
    project.assets.find((a) => a.id === project.audioAssetId),
  ).toMatchObject({
    kind: "audio",
    generationId: "voice",
    url: "/api/media/voice?stream=1",
  });
  expect(() =>
    pipelineMovieProject(
      "Film",
      { projectId: "production", bibleVersion: 3 },
      {
        version: 1,
        kind: "timeline-manifest",
        fps: 24,
        aspect: "9:16",
        clips: [
          {
            generationId: "https://foreign.invalid/media",
            kind: "image",
            durationFrames: 24,
            sourceInFrame: 0,
          },
        ],
      },
    ),
  ).toThrow(/identity/);
});
