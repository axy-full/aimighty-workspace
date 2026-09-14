import { createHash } from "node:crypto";
import {
  PIPELINE_LIMITS,
  PipelineError,
  pipelineSpec,
  type CompiledPipeline,
  type CompiledStage,
  type MediaKind,
  type MediaSource,
  type OutputRef,
  type PipelineStage,
} from "./schema";

export function pipelineHash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, next]) => [key, canonical(next)]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export type PublishedPipelineContext = {
  projectId: string;
  version: number;
  body: {
    brief?: string;
    script?: string;
    direction?: string;
    nodes: { id: string; text?: string }[];
    assets: {
      id: string;
      kind: string;
      url?: string;
      uploadId?: string;
      generationId?: string;
      version?: number;
      duration?: number;
      durationS?: number | null;
      refs?: string[];
      parentId?: string;
    }[];
  };
};

/** Compile only an explicit immutable publication. Database callers must load
 * this record from workbench_bibles; private draft bodies are never a fallback. */
export function compilePipeline(
  input: unknown,
  publication: PublishedPipelineContext,
): CompiledPipeline {
  const parsed = pipelineSpec.safeParse(input);
  if (!parsed.success)
    throw new PipelineError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  const spec = parsed.data;
  if (
    spec.context.projectId !== publication.projectId ||
    spec.context.bibleVersion !== publication.version
  )
    throw new PipelineError(
      "Choose the exact published production context before compiling.",
    );
  if (
    Buffer.byteLength(JSON.stringify(publication.body)) >
    PIPELINE_LIMITS.sourceBytes
  )
    throw new PipelineError(
      "This publication is too large for a production pipeline.",
    );
  const definitions = new Map<string, PipelineStage>();
  for (const stage of spec.stages) {
    if (definitions.has(stage.id))
      throw new PipelineError(`Duplicate stage ${stage.id}.`);
    definitions.set(stage.id, stage);
  }
  const assets = new Map(
    publication.body.assets.map((asset) => [asset.id, asset]),
  );
  const nodes = new Map(publication.body.nodes.map((node) => [node.id, node]));
  if (
    assets.size !== publication.body.assets.length ||
    nodes.size !== publication.body.nodes.length
  )
    throw new PipelineError("The publication has duplicate source identities.");
  const complete = new Map<string, CompiledStage>(),
    active = new Set<string>(),
    order: string[] = [];
  const seenAssets = new Set<string>(),
    activeAssets = new Set<string>();
  function validateLineage(id: string) {
    if (activeAssets.has(id))
      throw new PipelineError(
        `Published asset lineage contains a cycle at ${id}.`,
      );
    if (seenAssets.has(id)) return;
    const asset = assets.get(id);
    if (!asset) throw new PipelineError(`Published source ${id} is missing.`);
    activeAssets.add(id);
    for (const reference of [
      ...(asset.refs ?? []),
      ...(asset.parentId ? [asset.parentId] : []),
    ])
      validateLineage(reference);
    activeAssets.delete(id);
    seenAssets.add(id);
  }
  function mediaFor(id: string): MediaSource {
    validateLineage(id);
    const asset = assets.get(id)!;
    if (!["image", "video", "audio"].includes(asset.kind))
      throw new PipelineError(`Published source ${id} is not supported media.`);
    if (Boolean(asset.uploadId) === Boolean(asset.generationId))
      throw new PipelineError(
        `Published source ${id} must name one stored upload or generation.`,
      );
    const source = asset.uploadId ? "upload" : "generation",
      mediaId = (asset.uploadId || asset.generationId)!;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId))
      throw new PipelineError(
        `Published source ${id} has an invalid media identity.`,
      );
    const expectedUrl = `/api/${source === "upload" ? "uploads" : "media"}/${encodeURIComponent(mediaId)}`;
    if (
      asset.url &&
      asset.url !== expectedUrl &&
      !(source === "generation" && asset.url === expectedUrl + "?stream=1")
    )
      throw new PipelineError(
        `Published source ${id} must use its authenticated workspace media URL.`,
      );
    return {
      assetId: id,
      source,
      id: mediaId,
      kind: asset.kind as MediaKind,
      version: asset.version ?? 1,
      durationS: asset.durationS ?? asset.duration ?? null,
    };
  }
  function output(ref: OutputRef): CompiledStage {
    const result = visit(ref.stageId),
      definition = result.definition;
    const units = "units" in definition ? definition.units : 1;
    if (ref.unit >= units)
      throw new PipelineError(
        `Stage ${ref.stageId} does not have output ${ref.unit + 1}.`,
      );
    return result;
  }
  function visit(id: string): CompiledStage {
    if (active.has(id))
      throw new PipelineError(`Pipeline contains a cycle at ${id}.`);
    const cached = complete.get(id);
    if (cached) return cached;
    const stage = definitions.get(id);
    if (!stage) throw new PipelineError(`Input stage ${id} is missing.`);
    active.add(id);
    const dependencies = new Set<string>();
    const result: CompiledStage = {
      definition: stage,
      dependencies: [],
      outputKind: stage.kind === "review" ? "image" : stage.kind,
      inputs: [],
    };
    const dependency = (ref: OutputRef) => {
      const previous = output(ref);
      dependencies.add(ref.stageId);
      return previous;
    };
    if (stage.kind === "review") {
      const candidates = stage.candidates.map(dependency);
      const kind = candidates[0].outputKind;
      if (
        kind === "assembly" ||
        candidates.some(
          (candidate) =>
            candidate.outputKind !== kind ||
            candidate.definition.kind === "review",
        )
      )
        throw new PipelineError(
          "A review compares media of one kind, directly from generation stages.",
        );
      if (
        new Set(
          stage.candidates.map(
            (candidate) => `${candidate.stageId}:${candidate.unit}`,
          ),
        ).size !== stage.candidates.length
      )
        throw new PipelineError("A review cannot repeat the same candidate.");
      result.outputKind = kind;
    } else if (stage.kind === "assembly") {
      for (const clip of stage.clips)
        if (!["image", "video"].includes(dependency(clip).outputKind))
          throw new PipelineError(
            "Assembly pictures must be image or video outputs.",
          );
      if (
        stage.soundtrack &&
        dependency(stage.soundtrack).outputKind !== "audio"
      )
        throw new PipelineError(
          "The assembly soundtrack must be an audio output.",
        );
      if (
        stage.clips.reduce((sum, clip) => sum + clip.durationFrames, 0) >
        stage.fps * 180
      )
        throw new PipelineError("Assembly is limited to three minutes.");
    } else {
      const text =
        stage.prompt.source === "node"
          ? nodes.get(stage.prompt.nodeId)?.text
          : publication.body[stage.prompt.source];
      if (!text?.trim())
        throw new PipelineError(
          `Stage ${stage.label} needs text from the selected publication.`,
        );
      const maximum = stage.kind === "audio" ? 5000 : 12000;
      if (text.length > maximum)
        throw new PipelineError(
          `Stage ${stage.label} exceeds its ${maximum}-character prompt limit.`,
        );
      result.prompt = text.trim();
      if (stage.kind !== "audio") {
        result.inputs = stage.inputs.map((binding) => {
          const media =
            binding.source === "asset" ? mediaFor(binding.assetId) : null;
          const kind =
            media?.kind ??
            dependency(binding as Extract<typeof binding, { source: "stage" }>)
              .outputKind;
          if (
            (binding.role === "reference_video"
              ? kind !== "video"
              : kind !== "image") ||
            (stage.kind === "image" && kind !== "image")
          )
            throw new PipelineError(
              `Stage ${stage.label} has an incompatible ${binding.role} input.`,
            );
          return binding.source === "asset"
            ? { source: "asset", role: binding.role, media: media! }
            : {
                source: "stage",
                role: binding.role,
                stageId: binding.stageId,
                unit: binding.unit,
              };
        });
        for (const role of ["first_frame", "last_frame"] as const)
          if (
            stage.inputs.filter((binding) => binding.role === role).length > 1
          )
            throw new PipelineError(
              `Stage ${stage.label} has more than one ${role}.`,
            );
      }
    }
    result.dependencies = [...dependencies];
    active.delete(id);
    complete.set(id, result);
    order.push(id);
    return result;
  }
  spec.stages.forEach((stage) => visit(stage.id));
  const maximumUnits = spec.stages.reduce(
    (sum, stage) => sum + ("units" in stage ? stage.units : 0),
    0,
  );
  if (maximumUnits < 1 || maximumUnits > PIPELINE_LIMITS.units)
    throw new PipelineError(
      `A pipeline must contain between 1 and ${PIPELINE_LIMITS.units} generation units.`,
    );
  const contextHash = pipelineHash(publication.body);
  const compiled = {
    schemaVersion: 1 as const,
    spec,
    contextHash,
    order,
    stages: order.map((id) => complete.get(id)!),
    maximumUnits,
  };
  return { ...compiled, fingerprint: pipelineHash(compiled) };
}
