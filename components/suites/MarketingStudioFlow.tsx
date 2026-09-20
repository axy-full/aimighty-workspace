"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { GenerationDialog, type GenerationTarget } from "@/components/workbench/GenerationDialog";
import { MoleculrWorkspace } from "@/components/suites/MoleculrWorkspace";
import { PosterDesigner } from "@/components/suites/PosterDesigner";
import { applyAcceptedGeneration } from "@/lib/workbench/accepted-generation";
import {
  EMPTY_MOLECULR,
  moleculrNode,
  moleculrPrompt,
  moleculrReferences,
  moleculrVideoPrompt,
  type MoleculrBrief,
} from "@/lib/workbench/moleculr";
import { creativeTemplate } from "@/lib/workbench/moleculr-creative";
import { bindMoleculrReferences } from "@/lib/workbench/moleculr-graph";
import { buildMoleculrStoryboard, prepareMoleculrVariants } from "@/lib/workbench/moleculr-storyboard";
import { generationReferenceIds } from "@/lib/workbench/node-graph";
import { referenceAdBinding, validateReferenceAdBinding, type ReferenceAdBinding } from "@/lib/workbench/reference-ad";
import { uid, type Asset, type Project, type Stage } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";

/**
 * Marketing Studio's whole flow, in one place: the four sections
 * (Product, Brand & Cast, Message & Format, Variants & Output), the campaign
 * actions that edit the draft, and the generation dialog that prices and
 * dispatches a variant.
 *
 * It was lifted out of Studio.tsx unchanged, so there is exactly one copy of
 * the paid path, and it is a host's to mount rather than Studio's to own.
 * Today /workbench's Moleculr suite mounts it; the /workspace Marketing page is
 * the second host it exists for. Everything it needs arrives through `draft`
 * (the host's draft engine) and the callbacks below; it imports nothing from
 * Studio and reads no context.
 */

/** The host's draft engine: how this flow reads and writes the open project. */
export type MarketingDraftHost = {
  /** The request scope every workbench route checks (X-Workbench-Scope). */
  scope: string;
  /** The draft as the host last rendered it. */
  project: Project;
  /** The draft at call time — newer than `project` inside an await. */
  latest: () => Project;
  /** Whether the host is ready to act at all (signed in, loaded, not switching projects). */
  live: () => boolean;
  /** Whether the host still owns this draft and this scope (checked across every await). */
  owns: (draftId: string) => boolean;
  change: (fn: (previous: Project) => Project) => void;
  /** Flush pending edits; true once the server holds this draft. */
  ensureSaved: (draftId: string, refreshIdentities?: boolean) => Promise<boolean>;
  /** Bracket an upload so the host can block a project switch while it runs. */
  beginUpload: () => void;
  endUpload: () => void;
  updateAsset: (id: string, fields: Partial<Asset>) => void;
};

export type MarketingStudioFlowProps = {
  draft: MarketingDraftHost;
  /** False while the host is loading or switching: the sections read but do not act. */
  enabled: boolean;
  /** The Moleculr page id and the in-page section a link asked for. */
  page: string;
  section: string | null;
  /** The host's agent panels, rendered in the Marketing section. */
  marketing?: ReactNode;
  onPage: (page: string) => void;
  onUpload: (category?: string) => void;
  onIdentity: (assetId?: string) => void;
  onStage: (stage: Stage) => void;
  onRig: (nodeId: string) => void;
  onSequence: (asset: Asset) => void;
  onAgent: () => void;
  /** A generation was accepted: show the host's activity surface. */
  onDispatched: () => void;
  /** The draft that records it was saved: refresh the host's job feeds. */
  onSaved: () => void;
};

export default function MarketingStudioFlow({
  draft,
  enabled,
  page,
  section,
  marketing = null,
  onPage,
  onUpload,
  onIdentity,
  onStage,
  onRig,
  onSequence,
  onAgent,
  onDispatched,
  onSaved,
}: MarketingStudioFlowProps) {
  const { project, scope } = draft;
  const [target, setTarget] = useState<(GenerationTarget & { draftId: string }) | null>(null);
  /* A host that stops being able to act closes the dialog, exactly as a
     project switch does in Studio (beginTransition clears its target). A
     project switch itself remounts this flow, which clears it too. This is
     React's "adjust state when a prop changes" pattern, not an effect: the
     dialog must be gone in the same render that disables the host. */
  const [acting, setActing] = useState(enabled);
  if (acting !== enabled) {
    setActing(enabled);
    if (!enabled && target) setTarget(null);
  }

  async function importRemoteImage(url: string, category: "Product" | "Brand" = "Product"): Promise<Asset> {
    if (!draft.live()) throw new Error("Open a saved project first.");
    const draftId = draft.latest().id;
    if (draft.latest().assets.length >= 500) throw new Error("This project has reached its 500-asset limit.");
    if (!(await draft.ensureSaved(draftId))) throw new Error("Save this project before importing a product image.");
    if (!draft.owns(draftId)) throw new Error("The workspace changed. Return to this project before importing.");
    draft.beginUpload();
    try {
      const response = await fetch("/api/workbench/moleculr/import-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
        body: JSON.stringify({ projectId: draftId, url }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "The product image could not be imported.");
      }
      const mime = response.headers.get("content-type")?.split(";")[0] || "";
      const ext: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" };
      if (!ext[mime] || Number(response.headers.get("content-length") || 0) > 10 * 1024 * 1024)
        throw new Error("The product image has an unsupported format or size.");
      const blob = await response.blob();
      if (blob.size > 10 * 1024 * 1024) throw new Error("Product images must be 10 MB or smaller.");
      if (!draft.owns(draftId)) throw new Error("The project changed. Return to it before importing.");
      const file = new File([blob], `${category.toLowerCase()}-reference.${ext[mime]}`, { type: mime });
      const data = await uploadWorkbench(file, undefined, scope);
      if (!draft.owns(draftId))
        throw new Error("The original is in workspace uploads. Return to the original project to attach it.");
      const asset: Asset = {
        id: data.id,
        uploadId: data.id,
        url: data.url,
        name: file.name,
        kind: "image",
        category,
        mime,
        description: `Original ${category.toLowerCase()} reference imported from ` + new URL(url).hostname,
        prompt: "",
        status: "Draft",
        version: 1,
        locked: false,
        refs: [],
      };
      draft.change((old) => ({ ...old, assets: [...old.assets, asset] }));
      return asset;
    } finally {
      draft.endUpload();
    }
  }

  async function savePoster(file: File, sourceIds: string[]) {
    if (!draft.live()) throw new Error("Open a saved project first.");
    const draftId = draft.latest().id;
    if (draft.latest().assets.length >= 500) throw new Error("This project has reached its 500-asset limit.");
    if (sourceIds.some((id) => !draft.latest().assets.some((asset) => asset.id === id && asset.kind === "image")))
      throw new Error("A poster original is missing. Review its layers.");
    draft.beginUpload();
    try {
      const uploaded = await uploadWorkbench(file, undefined, scope);
      if (!draft.owns(draftId))
        throw new Error("The original is in workspace uploads. Return to the original project to attach it.");
      const asset: Asset = {
        id: uploaded.id,
        uploadId: uploaded.id,
        url: uploaded.url,
        name: file.name.slice(0, 200),
        kind: "image",
        category: "Campaign design",
        mime: "image/png",
        description: "Rendered poster · editable layers retained in Moleculr Design",
        prompt: "",
        status: "Draft",
        version: 1,
        locked: false,
        refs: sourceIds,
      };
      draft.change((old) => ({ ...old, assets: [...old.assets, asset] }));
      if (!(await draft.ensureSaved(draftId)))
        throw new Error("The poster is in your local library, but the project is not saved yet. Keep it open and retry saving.");
    } finally {
      draft.endUpload();
    }
  }

  async function attachConsumerVideo(asset: Asset, draftId: string) {
    if (!draft.live() || !draft.owns(draftId))
      throw new Error("Return to the original project and workspace before adding this video.");
    if (asset.kind !== "video" || !asset.generationId || !/^gen_hfc_[a-f0-9]{40}$/.test(asset.generationId) || asset.url !== `/api/media/${asset.generationId}`)
      throw new Error("A verified stored video original is required.");
    await fileOriginal(asset, draftId);
  }

  async function attachTemplateOriginal(asset: Asset, draftId: string) {
    if (!draft.live() || !draft.owns(draftId))
      throw new Error("Return to the original project and workspace before saving this variant.");
    if (!["image", "video"].includes(asset.kind) || !asset.generationId || !/^gen_hfc_[a-f0-9]{40}$/.test(asset.generationId) || asset.url !== `/api/media/${asset.generationId}`)
      throw new Error("A verified stored original is required.");
    await fileOriginal(asset, draftId);
  }

  /** The shared tail of both: file the original once, then save. */
  async function fileOriginal(asset: Asset, draftId: string) {
    const existing = draft.latest().assets.find((item) => item.generationId === asset.generationId);
    if (!existing) {
      if (draft.latest().assets.length >= 500) throw new Error("This project has reached its 500-asset limit.");
      if (draft.latest().assets.some((item) => item.id === asset.id))
        throw new Error("This original conflicts with an existing project asset.");
      draft.change((old) => ({ ...old, assets: [...old.assets, asset] }));
    }
    if (!(await draft.ensureSaved(draftId)))
      throw new Error("The original is in your local library, but the project is not saved yet. Keep it open and retry saving.");
  }

  function buildStoryboard() {
    if (!draft.live()) return;
    try {
      const next = buildMoleculrStoryboard(draft.latest(), () => uid("campaign"));
      draft.change(() => next);
      onPage("variants");
      toast.success("Editable storyboard shots prepared. Review each generation before rendering.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The storyboard could not be built.");
    }
  }

  function prepareVariants(kind: "image" | "video") {
    if (!draft.live()) return;
    try {
      const next = prepareMoleculrVariants(draft.latest(), kind, () => uid("campaign"));
      draft.change(() => next);
      toast.success("Variations prepared. Review each engine and credit quote before rendering.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The variations could not be prepared.");
    }
  }

  function reviewVariant(nodeId: string) {
    if (!draft.live()) return;
    const current = draft.latest(),
      node = current.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (node.locked) {
      toast.error("Unlock this shot in Rig before generating.");
      return;
    }
    const variant = current.moleculr?.variants.find((item) => item.nodeId === nodeId);
    const refs = generationReferenceIds(node, current);
    if (variant?.referenceVideo) {
      try {
        validateReferenceAdBinding(current, variant.referenceVideo);
        if (!refs.includes(variant.referenceVideo.assetId))
          throw new Error("Reconnect this variant’s original reference ad in Rig before generating.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The reference ad is unavailable.");
        return;
      }
    }
    setTarget({
      node,
      prompt: node.text || node.title,
      refs: variant?.referenceVideo ? refs.filter((id) => id !== node.assetId || id === variant.referenceVideo!.assetId) : refs,
      draftId: current.id,
      options: variant?.generation,
    });
  }

  function createAvatar(prompt: string) {
    if (!draft.live()) return;
    const current = draft.latest();
    if (current.nodes.length >= 250) {
      toast.error("This project has reached its node limit.");
      return;
    }
    const request = `Create an original adult campaign presenter portrait. ${prompt.slice(0, 4000)}. Photorealistic identity reference, natural skin texture, clean neutral background, no product or typography. This portrait will be reusable as a cast reference.`;
    const node = { ...moleculrNode(uid("avatar"), request, "Campaign presenter", current.nodes.length, "image"), type: "character" as const };
    draft.change((old) => ({ ...old, nodes: [...old.nodes, node] }));
    setTarget({
      node,
      prompt: request,
      refs: [],
      draftId: current.id,
      options: { modelId: "higgsfield/marketing-studio-image", marketing: { quality: "high", enhancePrompt: false }, ratio: "3:4" },
    });
  }

  function configureGeneration(hook: string, castId: string | undefined, kind: "image" | "video", options?: GenerationTarget["options"]) {
    if (!draft.live()) return;
    const current = draft.latest(),
      brief: MoleculrBrief = current.moleculr ?? EMPTY_MOLECULR;
    let referenceVideo: ReferenceAdBinding | undefined;
    try {
      referenceVideo = kind === "video" ? referenceAdBinding(current, brief.referenceAd) : undefined;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The reference ad is unavailable.");
      return;
    }
    const rawRequest = (kind === "video" ? moleculrVideoPrompt : moleculrPrompt)(current, brief, hook, castId),
      request = options?.marketing ? rawRequest.slice(0, 5000) : rawRequest;
    const template = creativeTemplate(brief);
    const generation = {
      modelId: options?.modelId,
      marketing: options?.marketing,
      ratio: options?.ratio ?? brief.creative?.aspect,
      duration: options?.duration ?? brief.creative?.seconds,
    };
    const existing = brief.variants.find(
      (item) =>
        item.hook === hook &&
        item.castAssetId === castId &&
        item.kind === kind &&
        item.productId === brief.activeProductId &&
        item.templateId === template?.id &&
        JSON.stringify(item.referenceVideo) === JSON.stringify(referenceVideo) &&
        JSON.stringify(item.generation) === JSON.stringify(generation) &&
        current.nodes.some((node) => node.id === item.nodeId && node.text === request),
    );
    if (existing && current.nodes.find((item) => item.id === existing.nodeId)?.locked) {
      toast.error("This variant is locked in Rig. Unlock it before changing its generation.");
      return;
    }
    if (!existing && (current.nodes.length >= 250 || brief.variants.length >= 100)) {
      toast.error("This project has reached its variant or node limit. Start another project to continue.");
      return;
    }
    const nodeId = existing?.nodeId ?? uid("variant");
    const planned = moleculrNode(nodeId, request, `${brief.productName || current.name} · ${hook}`, current.nodes.length, kind);
    try {
      const base = existing ? { ...current.nodes.find((item) => item.id === nodeId)!, text: request, mode: planned.mode } : planned;
      const chosenRefs = options?.referenceAssetIds
        ? options.referenceAssetIds
            .map((id) => current.assets.find((asset) => asset.id === id && asset.kind === "image"))
            .filter((asset): asset is Asset => !!asset)
        : moleculrReferences(current, { ...brief, castAssetIds: castId ? [castId] : [] }, castId);
      if (options?.referenceAssetIds && chosenRefs.length !== options.referenceAssetIds.length)
        throw new Error("A selected product or cast reference is no longer available.");
      if (referenceVideo) chosenRefs.push(current.assets.find((asset) => asset.id === referenceVideo!.assetId)!);
      const binding = bindMoleculrReferences(current, base, chosenRefs, () => uid("reference"), referenceVideo?.assetId);
      const nextNodes = [
        ...(existing ? current.nodes.map((item) => (item.id === nodeId ? binding.node : item)) : [...current.nodes, binding.node]),
        ...binding.sources,
      ];
      draft.change((old) => ({
        ...old,
        nodes: nextNodes,
        moleculr: {
          ...brief,
          variants: existing
            ? brief.variants
            : [
                ...brief.variants,
                {
                  id: uid("campaign"),
                  nodeId,
                  hook,
                  castAssetId: castId,
                  kind,
                  productId: brief.activeProductId,
                  templateId: template?.id,
                  ...(referenceVideo ? { referenceVideo } : {}),
                  createdAt: new Date().toISOString(),
                  generation,
                },
              ],
        },
      }));
      const targetRefs = generationReferenceIds(binding.node, { ...current, nodes: nextNodes });
      setTarget({
        node: binding.node,
        prompt: request,
        refs: referenceVideo ? targetRefs.filter((id) => id !== binding.node.assetId || id === referenceVideo!.assetId) : targetRefs,
        draftId: current.id,
        options: { ratio: brief.creative?.aspect, duration: brief.creative?.seconds, ...options },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The variant could not be configured.");
    }
  }

  return (
    <>
      <MoleculrWorkspace
        key={`moleculr:${project.id}`}
        scope={scope}
        project={project}
        page={page}
        section={section}
        enabled={enabled}
        design={
          <PosterDesigner
            key={`poster:${project.id}`}
            project={project}
            scope={scope}
            enabled={enabled}
            onChange={(poster) => draft.change((old) => ({ ...old, moleculr: { ...(old.moleculr ?? EMPTY_MOLECULR), poster } }))}
            onSaveAsset={savePoster}
          />
        }
        marketing={marketing}
        onChange={(brief) => draft.change((old) => ({ ...old, moleculr: brief }))}
        onPage={onPage}
        onUpload={onUpload}
        onIdentity={onIdentity}
        onStage={onStage}
        onRig={onRig}
        onSave={() => draft.ensureSaved(project.id)}
        onImportRemote={importRemoteImage}
        onCreateAvatar={createAvatar}
        onBuildStoryboard={buildStoryboard}
        onReviewVariant={reviewVariant}
        onPrepareVariants={prepareVariants}
        onConsumerVideoAsset={attachConsumerVideo}
        onTemplateAsset={attachTemplateOriginal}
        onGenerate={configureGeneration}
        onSequence={onSequence}
        onAgent={onAgent}
      />
      {target && target.draftId === project.id && (
        <GenerationDialog
          scope={scope}
          target={target}
          project={project}
          onClose={() => setTarget(null)}
          onSave={() => draft.ensureSaved(target.draftId)}
          onAsset={(id, fields) => {
            if (draft.latest().id === target.draftId) draft.updateAsset(id, fields);
          }}
          onQueued={(_id, kind, accepted) => {
            if (!draft.owns(target.draftId)) return;
            draft.change((old) => applyAcceptedGeneration(old, target.node.id, kind, accepted));
            void draft.ensureSaved(target.draftId, true).then((saved) => {
              if (saved) onSaved();
            });
            onDispatched();
            toast.success("Generation submitted. Follow its progress in Activity.");
          }}
        />
      )}
    </>
  );
}
