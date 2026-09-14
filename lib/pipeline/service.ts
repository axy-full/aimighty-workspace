import type {
  AdmissionActor,
  PreparedAdmission,
  PrepareAdmissionResult,
} from "../admissionTypes";
import { prepareGeneration } from "../generationAdmission";
import { prepareAudio } from "../audioAdmission";
import { MODELS } from "../models";
import { SPEECH_MODELS, SFX_MODEL, MUSIC_MODEL } from "../elevenlabs";
import { PipelineError, type CompiledStage } from "./schema";
import {
  latestAttempt,
  stageOf,
  type PipelineStore,
  type ResolvedStageInputs,
} from "./store";

type Prepare = (
  input: Record<string, unknown>,
  actor: AdmissionActor,
) => Promise<PrepareAdmissionResult>;
/** Construct requests exclusively from the immutable compiled publication and
 * current resolved output identities. A browser cannot submit a prepared body. */
export function stageRequest(
  stage: CompiledStage,
  inputs: ResolvedStageInputs,
  projectId: string,
  unit: number,
): Record<string, unknown> {
  const d = stage.definition;
  if (!("units" in d))
    throw new PipelineError("This stage has no generation request.");
  if (d.kind === "audio") {
    const allowed =
      d.task === "speech"
        ? SPEECH_MODELS.some((m) => m.id === d.model)
        : d.model === (d.task === "sound" ? SFX_MODEL : MUSIC_MODEL);
    if (!allowed)
      throw new PipelineError("Choose a supported model for this audio task.");
    if (d.task === "speech" && !/^[A-Za-z0-9]{6,64}$/.test(d.voiceId ?? ""))
      throw new PipelineError("Choose a voice for the speech stage.");
    if (
      d.task === "sound" &&
      d.durationSeconds != null &&
      d.durationSeconds > 30
    )
      throw new PipelineError("Sound effects are limited to 30 seconds.");
    if (d.task === "music" && (d.durationSeconds ?? 30) < 10)
      throw new PipelineError("Music must last at least 10 seconds.");
    return {
      projectId,
      text: stage.prompt,
      task: d.task,
      modelId: d.model,
      ...(d.voiceId ? { voiceId: d.voiceId } : {}),
      ...(d.durationSeconds != null
        ? d.task === "music"
          ? { lengthMs: Math.round(d.durationSeconds * 1000) }
          : { durationSeconds: d.durationSeconds }
        : {}),
      stability: d.settings.stability,
      similarity: d.settings.similarity_boost,
      style: d.settings.style,
      speed: d.settings.speed,
      speakerBoost: d.settings.use_speaker_boost,
    };
  }
  const model = MODELS.find(
    (m) =>
      m.id === d.model &&
      m.kind === d.kind &&
      !m.hidden &&
      !m.stillTask &&
      (!m.supportsTasks || m.supportsTasks.includes("generate")),
  );
  if (!model)
    throw new PipelineError(
      "Choose a supported generation model for this stage.",
    );
  if (
    !model.ratios.includes(d.ratio) ||
    !model.resolutions.includes(d.resolution)
  )
    throw new PipelineError(
      "This model does not support the selected aspect or resolution.",
    );
  if (d.kind === "image" && d.seed !== null)
    throw new PipelineError("Image stages do not support a fixed seed.");
  if (
    d.kind === "video" &&
    (!model.durations.includes(d.duration) ||
      (d.generateAudio && !model.supportsAudio))
  )
    throw new PipelineError(
      "This model does not support the selected duration or generated audio.",
    );
  return {
    projectId,
    prompt: stage.prompt,
    model: d.model,
    ratio: d.ratio,
    resolution: d.resolution,
    refine: false,
    ...(d.seed !== null ? { seed: (d.seed + unit) % 2_147_483_648 } : {}),
    ...(d.kind === "video"
      ? { duration: d.duration, generateAudio: d.generateAudio }
      : {}),
    references: inputs.references.map((ref) => ({
      [ref.source === "upload" ? "uploadId" : "genId"]: ref.id,
      role: ref.role,
    })),
  };
}

export async function quotePipelineStage(
  store: PipelineStore,
  actor: AdmissionActor,
  runId: string,
  revision: number,
  stageId: string,
  retryUnits?: number[],
  prepare: { image: Prepare; audio: Prepare } = {
    image: prepareGeneration,
    audio: prepareAudio,
  },
) {
  if (actor.token)
    throw new PipelineError(
      "Approve production pipelines from your browser session.",
      403,
    );
  const run = await store.getRun(actor.user.id, runId);
  if (run.revision !== revision)
    throw new PipelineError(
      "The run changed. Reload before quoting this stage.",
      409,
    );
  const stage = stageOf(run, stageId),
    d = stage.definition;
  if (!("units" in d))
    throw new PipelineError("This stage does not need a paid quote.");
  const inputs = await store.stageInputs(actor.user.id, runId, stageId);
  const chosen =
    retryUnits ??
    Array.from({ length: d.units }, (_, unit) => unit).filter(
      (unit) => !latestAttempt(run, stageId, unit),
    );
  if (
    !chosen.length ||
    chosen.length > d.units ||
    new Set(chosen).size !== chosen.length
  )
    throw new PipelineError("Choose an unstarted or failed unit to quote.");
  const units: { unit: number; prepared: PreparedAdmission }[] = [];
  for (const unit of chosen) {
    if (!Number.isInteger(unit) || unit < 0 || unit >= d.units)
      throw new PipelineError("Unknown stage unit.");
    const latest = latestAttempt(run, stageId, unit);
    if (latest && !["failed", "refused"].includes(latest.state))
      throw new PipelineError(
        "Recover the existing attempt before requesting another quote.",
        409,
      );
    const result = await (d.kind === "audio" ? prepare.audio : prepare.image)(
      stageRequest(stage, inputs, run.compiled.spec.context.projectId, unit),
      actor,
    );
    if (!result.ok)
      throw new PipelineError(
        typeof result.body.error === "string"
          ? result.body.error
          : "This stage cannot be quoted yet.",
        result.status,
      );
    units.push({ unit, prepared: result.value });
  }
  return store.quoteStage(
    actor.user.id,
    runId,
    revision,
    stageId,
    inputs.inputHash,
    units,
  );
}

export { publicRun, type PublicPipelineRun } from "./public";
