import { newProject, type Asset, type Project } from "../workbench/studio";
import type { PipelineSpec } from "./schema";

export type PublicationChoice = {
  projectId: string;
  version: number;
  name: string;
  prompts: {
    source: string;
    nodeId?: string;
    label: string;
    preview: string;
  }[];
  assets: { id: string; name: string; kind: string }[];
};
export type ModelChoice = {
  id: string;
  label: string;
  kind: string;
  resolutions: string[];
  ratios: string[];
  durations: number[];
  supportsAudio: boolean;
  configured: boolean;
};
export type PipelineCatalog = {
  publications: PublicationChoice[];
  models: ModelChoice[];
  audioModels: {
    speech: { id: string; label: string }[];
    sound: string;
    music: string;
  };
};
export type PipelineDraft = {
  publication: string;
  name: string;
  output: "image" | "video" | "audio";
  prompt: string;
  imageModel: string;
  videoModel: string;
  imageResolution: string;
  videoResolution: string;
  ratio: string;
  duration: number;
  variants: number;
  reference: string;
  audio: "none" | "speech" | "sound" | "music";
  audioPrompt: string;
  voiceId: string;
  speechModel: string;
  audioSeconds: number;
};
export const emptyPipelineDraft: PipelineDraft = {
  publication: "",
  name: "",
  output: "video",
  prompt: "",
  imageModel: "",
  videoModel: "",
  imageResolution: "",
  videoResolution: "",
  ratio: "16:9",
  duration: 5,
  variants: 2,
  reference: "",
  audio: "none",
  audioPrompt: "",
  voiceId: "",
  speechModel: "",
  audioSeconds: 10,
};
export const publicationKey = (p: PublicationChoice) =>
  `${p.projectId}:${p.version}`;
const promptKey = (p: PublicationChoice["prompts"][number]) =>
  p.source === "node" ? `node:${p.nodeId}` : p.source;
export { promptKey };
export function effectivePipelineDraft(
  draft: PipelineDraft,
  catalog: PipelineCatalog,
): PipelineDraft {
  const choose = (kind: string, id: string) =>
    catalog.models.find(
      (m) => m.id === id && m.kind === kind && m.configured,
    ) ?? catalog.models.find((m) => m.kind === kind && m.configured);
  const image = choose("image", draft.imageModel),
    video = choose("video", draft.videoModel);
  const ratios = ["16:9", "9:16", "1:1", "4:5"].filter(
    (r) =>
      (!image || image.ratios.includes(r)) &&
      (draft.output !== "video" || !video || video.ratios.includes(r)),
  );
  return {
    ...draft,
    imageModel: image?.id ?? "",
    videoModel: video?.id ?? "",
    imageResolution: image?.resolutions.includes(draft.imageResolution)
      ? draft.imageResolution
      : (image?.resolutions[0] ?? ""),
    videoResolution: video?.resolutions.includes(draft.videoResolution)
      ? draft.videoResolution
      : (video?.resolutions[0] ?? ""),
    ratio: ratios.includes(draft.ratio) ? draft.ratio : (ratios[0] ?? "16:9"),
    duration:
      draft.output === "video" &&
      video &&
      !video.durations.includes(draft.duration)
        ? video.durations[0]
        : draft.duration,
  };
}
export function buildPipelineSpec(
  draft: PipelineDraft,
  publication: PublicationChoice,
  catalog: PipelineCatalog,
): unknown {
  const prompt =
    publication.prompts.find((p) => promptKey(p) === draft.prompt) ??
    publication.prompts[0];
  if (!prompt)
    throw new Error("Publish a brief, script, or node with text first.");
  const textSource = (p: typeof prompt) =>
    p.source === "node"
      ? { source: "node", nodeId: p.nodeId }
      : { source: p.source };
  const model = (kind: string, id: string) =>
    catalog.models.find((m) => m.kind === kind && m.id === id) ??
    catalog.models.find((m) => m.kind === kind && m.configured);
  const image = model("image", draft.imageModel),
    video = model("video", draft.videoModel);
  const stages: Record<string, unknown>[] = [];
  if (draft.output !== "audio") {
    if (!image)
      throw new Error("Connect an image engine in Workspace settings.");
    stages.push({
      id: "images",
      label: "Keyframe options",
      kind: "image",
      model: image.id,
      prompt: textSource(prompt),
      units: draft.variants,
      ratio: draft.ratio,
      resolution: draft.imageResolution || image.resolutions[0],
      inputs: draft.reference
        ? [
            {
              source: "asset",
              assetId: draft.reference,
              role: "reference_image",
            },
          ]
        : [],
    });
    stages.push({
      id: "selected",
      label: "Choose a keyframe",
      kind: "review",
      candidates: Array.from({ length: draft.variants }, (_, unit) => ({
        stageId: "images",
        unit,
      })),
    });
    if (draft.output === "video") {
      if (!video)
        throw new Error("Connect a video engine in Workspace settings.");
      stages.push({
        id: "motion",
        label: "Motion",
        kind: "video",
        model: video.id,
        prompt: textSource(prompt),
        units: 1,
        ratio: draft.ratio,
        resolution: draft.videoResolution || video.resolutions[0],
        duration: draft.duration,
        inputs: [
          {
            source: "stage",
            stageId: "selected",
            unit: 0,
            role: "first_frame",
          },
        ],
      });
    }
  }
  const audioTask =
    draft.output === "audio" && draft.audio === "none" ? "sound" : draft.audio;
  if (audioTask !== "none") {
    const audioPrompt =
      publication.prompts.find((p) => promptKey(p) === draft.audioPrompt) ??
      prompt;
    const audioModel =
      audioTask === "speech"
        ? draft.speechModel || catalog.audioModels.speech[0]?.id
        : catalog.audioModels[audioTask];
    stages.push({
      id: "audio",
      label:
        audioTask === "speech"
          ? "Voice"
          : audioTask === "music"
            ? "Music"
            : "Sound",
      kind: "audio",
      model: audioModel,
      prompt: textSource(audioPrompt),
      task: audioTask,
      ...(audioTask === "speech"
        ? { voiceId: draft.voiceId }
        : { durationSeconds: draft.audioSeconds }),
    });
  }
  if (draft.output !== "audio")
    stages.push({
      id: "edit",
      label: "Delivery edit",
      kind: "assembly",
      fps: 24,
      aspect: draft.ratio,
      clips: [
        {
          stageId: draft.output === "video" ? "motion" : "selected",
          unit: 0,
          durationFrames: Math.round(draft.duration * 24),
          sourceInFrame: 0,
        },
      ],
      ...(audioTask !== "none"
        ? { soundtrack: { stageId: "audio", unit: 0 } }
        : {}),
    });
  return {
    schemaVersion: 1,
    name: draft.name.trim() || `${publication.name} pipeline`,
    context: {
      projectId: publication.projectId,
      bibleVersion: publication.version,
    },
    stages,
  };
}

/** Handoff maps exact frame counts and IDs; the movie renderer independently
 * validates media duration, download size, browser codecs, and current scope. */
export function pipelineMovieProject(
  name: string,
  context: PipelineSpec["context"],
  raw: unknown,
): Project {
  const manifest = raw as {
    version?: number;
    kind?: string;
    fps?: number;
    aspect?: string;
    clips?: {
      generationId: string;
      kind: "image" | "video";
      durationFrames: number;
      sourceInFrame: number;
    }[];
    soundtrack?: { generationId: string } | null;
  };
  if (
    manifest?.version !== 1 ||
    manifest.kind !== "timeline-manifest" ||
    ![24, 25, 30].includes(manifest.fps ?? 0) ||
    !["16:9", "9:16", "1:1", "4:5"].includes(manifest.aspect ?? "") ||
    !Array.isArray(manifest.clips) ||
    !manifest.clips.length
  )
    throw new Error("This timeline is not ready for movie export.");
  const project = newProject(name);
  project.productionProjectId = context.projectId;
  project.bibleVersion = context.bibleVersion;
  project.fps = manifest.fps!;
  project.aspect = manifest.aspect!;
  function asset(id: string, kind: Asset["kind"]): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
      throw new Error("Invalid timeline media identity.");
    if (!project.assets.some((a) => a.id === id))
      project.assets.push({
        id,
        name: kind === "audio" ? "Soundtrack" : "Pipeline take",
        kind,
        category: "Pipeline",
        url: `/api/media/${encodeURIComponent(id)}?stream=1`,
        generationId: id,
        description: "Pipeline output",
        prompt: "",
        status: "Selected",
        locked: true,
        version: 1,
        refs: [],
      });
    return id;
  }
  project.shots = manifest.clips.map((clip, i) => {
    if (
      !["image", "video"].includes(clip.kind) ||
      !Number.isInteger(clip.durationFrames) ||
      clip.durationFrames < 1 ||
      !Number.isInteger(clip.sourceInFrame) ||
      clip.sourceInFrame < 0
    )
      throw new Error("Invalid timeline timing.");
    return {
      id: `pipeline-shot-${i}`,
      name: `Shot ${i + 1}`,
      assetId: asset(clip.generationId, clip.kind),
      duration: clip.durationFrames,
      sourceIn: clip.sourceInFrame,
      note: "",
    };
  });
  if (manifest.soundtrack)
    project.audioAssetId = asset(manifest.soundtrack.generationId, "audio");
  return project;
}
