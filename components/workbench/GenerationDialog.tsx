"use client";
import { useEffect, useState } from "react";
import type { Asset, CanvasNode, Project } from "@/lib/workbench/studio";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { mediaReferenceIdentity, mediaQuoteReferences } from '@/lib/workbench/media-reference-input';
import { uploadWorkbench } from "@/lib/workbench/upload";
import {
  pendingGenerationKey,
  readPendingGeneration,
  claimPendingGeneration,
  clearPendingGeneration,
  type PendingGeneration,
} from "@/lib/workbench/pending-generation";

type Model = {
  id: string;
  label: string;
  kind: "image" | "video";
  resolutions: string[];
  ratios: string[];
  durations: number[];
  maxReferenceImages: number;
  maxReferenceVideos: number;
  soulIdentity?: boolean;
};
export type GenerationTarget = {
  node: CanvasNode;
  prompt: string;
  refs: string[];
};
export class StudioRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: Record<string, unknown>,
    public resolved = false,
  ) {
    super(message);
    this.name = "StudioRequestError";
  }
}
export async function studioRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  const data = await res
    .json()
    .catch(() => ({ error: "Unable to read the server response." }));
  if (!res.ok)
    throw new StudioRequestError(
      data.error || `Request failed (${res.status})`,
      res.status,
      data,
      res.headers.get("Idempotency-Status") === "complete",
    );
  return data as T;
}
export function GenerationDialog({
  target,
  project,
  scope,
  onClose,
  onSave,
  onQueued,
  onAsset,
}: {
  scope: string;
  target: GenerationTarget;
  project: Project;
  onClose: () => void;
  onSave: () => Promise<boolean>;
  onQueued: (id: string) => void;
  onAsset: (id: string, fields: Partial<Asset>) => void;
}) {
  const storageId = pendingGenerationKey(scope, project.id, target.node.id);
  const [initial] = useState(() => {
    try {
      return {
        pending:
          typeof window === "undefined"
            ? null
            : readPendingGeneration(window.localStorage, storageId),
        error: "",
      };
    } catch {
      return {
        pending: null,
        error:
          "Recovery storage is unavailable. Check Activity and enable local storage before generating.",
      };
    }
  });
  const [pending, setPending] = useState<PendingGeneration | null>(
    initial.pending,
  );
  const saved = initial.pending ? JSON.parse(initial.pending.body) : null;
  const [models, setModels] = useState<Model[]>([]),
    [modelId, setModelId] = useState(saved?.model || ""),
    [resolution, setResolution] = useState(saved?.resolution || ""),
    [ratio, setRatio] = useState(saved?.ratio || project.aspect),
    [duration, setDuration] = useState(saved?.duration || 5),
    [prompt, setPrompt] = useState(saved?.prompt || target.prompt),
    [soulIdentityId, setSoulIdentityId] = useState<string>(saved?.soulIdentityId || ""),
    [soulStrength, setSoulStrength] = useState<number>(saved?.soulStrength ?? 1),
    [quote, setQuote] = useState<{
      key: string;
      credits: number | null;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initial.error);
  const model = models.find((m) => m.id === modelId);
  const boundRefs = target.refs
    .map((id) => [...project.assets, ...(project.sharedAssets ?? [])].find((asset) => asset.id === id))
    .filter((asset): asset is Asset => !!asset && ["image", "video"].includes(asset.kind));
  const soulAssets = boundRefs.filter((asset, index, all) => asset.soulIdentityId && all.findIndex(a => a.soulIdentityId === asset.soulIdentityId) === index);
  const selectedSoulId = soulIdentityId || soulAssets[0]?.soulIdentityId || "";
  const boundSoulId = soulAssets[0]?.soulIdentityId;
  // A trained likeness supplies the face; its cover is not an extra style reference.
  const refs = model?.soulIdentity ? boundRefs.filter(asset => !asset.soulIdentityId) : boundRefs;
  const referenceQuery = mediaQuoteReferences(refs);
  const quoteKey = JSON.stringify({ modelId, resolution, ratio, duration, references: referenceQuery, soulIdentityId: model?.soulIdentity ? selectedSoulId : undefined });
  const cost = pending?.credits ?? (quote?.key === quoteKey ? quote.credits : null);
  useEffect(() => {
    studioRequest<{ models: Model[] }>("/api/workbench/engines")
      .then((d) => {
        setModels(d.models);
        const first = (boundSoulId ? d.models.find(m => m.soulIdentity) : undefined)
          || d.models.find(m => m.kind === "image" && !m.soulIdentity)
          || d.models.find(m => !m.soulIdentity);
        if (first && !initial.pending) {
          setModelId(first.id);
          setResolution(first.resolutions[0]);
          setRatio(first.ratios.includes(project.aspect) ? project.aspect : first.ratios.find(r => r !== 'adaptive') || first.ratios[0]);
          setDuration(first.durations.includes(5) ? 5 : first.durations[0] || 5);
        } else if (!first)
          setError(d.models.some(m => m.soulIdentity)
            ? "Connect a ready Soul character to this node, or connect another image engine in Workspace settings."
            : "No generation engine is configured for this workspace.");
      })
      .catch((e) => setError(e.message));
  }, [initial.pending, project.aspect, boundSoulId]);
  useEffect(() => {
    if (!model || pending) return;
    const abort = new AbortController();
    studioRequest<{ credits: number | null }>(
      "/api/workbench/engines?" +
        new URLSearchParams({
          model: modelId,
          resolution,
          ratio,
          duration: String(duration),
          ...(model.soulIdentity ? { soulIdentityId: selectedSoulId, projectId: project.id } : {}),
        }).toString() + '&' + referenceQuery,
      { signal: abort.signal },
    )
      .then((d) => { setError(""); setQuote({ key: quoteKey, credits: d.credits }); })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [model, modelId, resolution, ratio, duration, referenceQuery, quoteKey, pending, selectedSoulId, project.id]);
  async function submit() {
    if (busy || initial.error || (!pending && (!model || cost == null))) return;
    setBusy(true);
    setError("");
    let attempt: PendingGeneration | null = null;
    try {
      // Recover before saving/mapping/uploading: retries cannot alter the accepted payload.
      attempt = readPendingGeneration(window.localStorage, storageId);
      if (!attempt) {
        if (!(await onSave()))
          throw new Error("Save your latest work before generating.");
        const mapping = await studioRequest<{
          shotId: string;
          productionProjectId: string;
        }>("/api/workbench/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
          body: JSON.stringify({
            action: "map-shot",
            projectId: project.id,
            nodeId: target.node.id,
          }),
        });
        const references = [];
        for (const a of refs) {
          const role =
            a.kind === "video" ? "reference_video" : "reference_image";
          const identity = mediaReferenceIdentity(a);
          if (identity) references.push({ ...identity, role });
          else if (
            a.url.startsWith("/campaign/") ||
            a.url.startsWith("/api/workbench/media/")
          ) {
            const res = await fetch(a.url);
            if (!res.ok) throw new Error("Cannot load reference " + a.name);
            const blob = await res.blob();
            const uploaded = await uploadWorkbench(
              new File([blob], a.name, {
                type: a.mime || blob.type || "image/webp",
              }),
              undefined,
              scope,
            );
            onAsset(a.id, { uploadId: uploaded.id });
            references.push({ uploadId: uploaded.id, role });
          } else
            throw new Error(
              "Upload " +
                a.name +
                " from your device before using it as generation input.",
            );
        }
        const body = JSON.stringify({
          prompt,
          model: model!.id,
          projectId: mapping.productionProjectId,
          shotId: mapping.shotId,
          ratio,
          resolution,
          duration,
          refine: false,
          maxCredits: cost!,
          references,
          ...(model!.soulIdentity ? { soulIdentityId: selectedSoulId, soulStrength, workbenchProjectId: project.id } : {}),
        });
        attempt = claimPendingGeneration(window.localStorage, storageId, {
          key: crypto.randomUUID(),
          body,
          credits: cost!,
        });
        setPending(attempt);
      }
      const result = await studioRequest<{ id: string }>("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.key,
          "X-Workbench-Scope": scope,
        },
        body: attempt.body,
      });
      if (!result.id)
        throw new Error(
          "The server has not confirmed a job yet. Retry to recover this same request.",
        );
      clearPendingGeneration(window.localStorage, storageId, attempt.key);
      onQueued(result.id);
      onClose();
    } catch (e) {
      if (attempt && e instanceof StudioRequestError) {
        if (typeof e.data.id === "string") {
          clearPendingGeneration(window.localStorage, storageId, attempt.key);
          onQueued(e.data.id);
          onClose();
          return;
        }
        // Only a durable, completed refusal permits a fresh request and another quote.
        if (e.resolved && e.status >= 400 && e.status < 500) {
          clearPendingGeneration(window.localStorage, storageId, attempt.key);
          setPending(null);
        }
      }
      setError(
        e instanceof Error ? e.message : "Generation could not be submitted.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="ps ps-dialog" overlayClassName={model?.soulIdentity ? "z-[100]" : undefined} style={model?.soulIdentity ? { zIndex: 101 } : undefined}>
        <DialogHeader>
          <DialogTitle>Generate a new take</DialogTitle>
          <DialogDescription>
            {target.node.title} · {refs.length} bound media references
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-fields">
          <label className="field-label">
            Engine
            <select
              aria-label="Generation engine"
              value={modelId}
              disabled={busy || !!pending}
              onChange={(e) => {
                const m = models.find((m) => m.id === e.target.value)!;
                setModelId(m.id);
                setResolution(m.resolutions[0]);
                if (!m.ratios.includes(ratio))
                  setRatio(
                    m.ratios.find((r) => r !== "adaptive") || m.ratios[0],
                  );
                if (!m.durations.includes(duration))
                  setDuration(m.durations[0] || 5);
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.kind}
                </option>
              ))}
            </select>
          </label>
          {model?.soulIdentity && (
            <div className="generation-options">
              <label className="field-label">Soul identity
                <select aria-label="Soul identity" value={selectedSoulId} disabled={busy || !!pending} onChange={event => setSoulIdentityId(event.target.value)}>
                  {!soulAssets.length && <option value="">Connect a Soul character to this node</option>}
                  {soulAssets.map(asset => <option key={asset.soulIdentityId} value={asset.soulIdentityId}>{asset.name}</option>)}
                </select>
              </label>
              <label className="field-label">Likeness strength · {Math.round(soulStrength * 100)}%
                <input aria-label="Soul likeness strength" type="range" min="0" max="1" step="0.05" value={soulStrength} disabled={busy || !!pending} onChange={event => setSoulStrength(Number(event.target.value))} />
              </label>
            </div>
          )}
          {soulAssets.length > 0 && !model?.soulIdentity && <p className="muted small-copy">This engine uses the character’s reference image. Choose Soul Character to use its trained likeness when that engine is available.</p>}
          <label className="field-label">
            Direction
            <textarea
              aria-label="Generation direction"
              value={prompt}
              disabled={busy || !!pending}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={10000}
            />
          </label>
          <div className="generation-options">
            <label>
              Size
              <select
                aria-label="Generation size"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                disabled={busy || !!pending}
              >
                {model?.resolutions.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Aspect
              <select
                aria-label="Generation aspect"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                disabled={busy || !!pending}
              >
                {model?.ratios.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            {model?.kind === "video" && (
              <label>
                Seconds
                <select
                  aria-label="Generation duration"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  disabled={busy || !!pending}
                >
                  {model.durations.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {pending && (
            <p role="status" className="muted small-copy">
              A previous submission is awaiting confirmation. Retry recovers the
              same take using its saved settings.
            </p>
          )}
          {error && (
            <p role="alert" className="save-problem">
              {error}
            </p>
          )}
          <p className="muted small-copy">
            A separate version is saved to this shot. Track progress and recover
            results in Activity.
          </p>
          <Button
            className="btn primary"
            disabled={
              busy ||
              !!initial.error ||
              (!pending && (cost == null || !prompt.trim() || (model?.soulIdentity && !selectedSoulId)))
            }
            onClick={() => void submit()}
          >
            {busy
              ? "Submitting…"
              : pending
                ? "Recover submitted take"
                : cost == null
                  ? "Loading estimate…"
                  : `Generate · ${cost} cr estimated`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
