"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { nodeAudioBody, validAudioQuote, type NodeAudioSetup, type NodeAudioTask } from "@/lib/workbench/generation-audio";
import { videoReferenceProblem } from "@/lib/generationReferences";
import { referenceVideoModels } from "@/lib/workbench/reference-ad";
import type { ModelDef } from "@/lib/models";
import type { MoleculrGenerationOptions } from '@/lib/workbench/moleculr';
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
  family: ModelDef["family"];
  resolutions: string[];
  ratios: string[];
  durations: number[];
  maxReferenceImages: number;
  maxReferenceVideos: number;
  soulIdentity?: boolean;
  marketing?: boolean;
};
export type MarketingGenerationOptions = { quality: "low" | "medium" | "high"; enhancePrompt: boolean; presetId?: string };
export type GenerationTarget = {
  options?: MoleculrGenerationOptions;
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
function validMapping(value: unknown): value is { shotId: string; productionProjectId: string } {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Record<string, unknown>;
  return [mapping.shotId, mapping.productionProjectId].every(item => typeof item === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(item));
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
  onQueued: (id: string, kind?: "image" | "video" | "audio", accepted?: { prompt: string; options: MoleculrGenerationOptions }) => void;
  onAsset: (id: string, fields: Partial<Asset>) => void;
}) {
  const callbacks = useRef({ onSave });
  useEffect(() => { callbacks.current = { onSave }; }, [onSave]);
  const [preparationRevision, setPreparationRevision] = useState(0);
  const [mapped, setMapped] = useState<{ shotId: string; productionProjectId: string } | null>(null);
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
  const [marketing, setMarketing] = useState<MarketingGenerationOptions>(saved?.marketing ?? target.options?.marketing ?? { quality: "high", enhancePrompt: false });
  const initialKind = initial.pending?.endpoint === "/api/audio" || (!initial.pending && target.node.mode === "Audio") ? "audio" : target.node.mode === "Video" || target.node.mode === "Image to video" ? "video" : "image";
  const [kind, setKind] = useState<"image" | "video" | "audio">(initialKind);
  const [audioSetup, setAudioSetup] = useState<NodeAudioSetup | null>(null);
  const [audioTask, setAudioTask] = useState<NodeAudioTask>(saved?.task === "music" || saved?.task === "speech" ? saved.task : "sound");
  const [voiceId, setVoiceId] = useState(saved?.voiceId || "");
  const [speechModel, setSpeechModel] = useState(saved?.modelId || "");
  const [audioSeconds, setAudioSeconds] = useState(saved?.lengthMs ? saved.lengthMs / 1000 : saved?.durationSeconds || 10);
  const [instrumental, setInstrumental] = useState(saved?.instrumental ?? true);
  const [firstFrameId, setFirstFrameId] = useState<string>(saved?.firstFrameAssetId ?? target.options?.firstFrameAssetId ?? "");
  const [models, setModels] = useState<Model[]>([]),
    [modelId, setModelId] = useState(saved?.model || target.options?.modelId || ""),
    [resolution, setResolution] = useState(saved?.resolution || target.options?.resolution || ""),
    [ratio, setRatio] = useState(saved?.ratio || target.options?.ratio || project.aspect),
    [duration, setDuration] = useState(saved?.duration || target.options?.duration || 5),
    [prompt, setPrompt] = useState(saved?.text || saved?.prompt || target.prompt),
    [soulIdentityId, setSoulIdentityId] = useState<string>(saved?.soulIdentityId || target.options?.soulIdentityId || ""),
    [soulStrength, setSoulStrength] = useState<number>(saved?.soulStrength ?? target.options?.soulStrength ?? 1),
    [quote, setQuote] = useState<{
      key: string;
      credits: number | null;
      fingerprint?: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initial.error);
  const model = models.find((m) => m.id === modelId && m.kind === kind);
  const boundRefs = useMemo(() => target.refs
    .map((id) => [...project.assets, ...(project.sharedAssets ?? [])].find((asset) => asset.id === id))
    .filter((asset): asset is Asset => !!asset && ["image", "video"].includes(asset.kind)), [target.refs, project.assets, project.sharedAssets]);
  const soulAssets = boundRefs.filter((asset, index, all) => asset.soulIdentityId && all.findIndex(a => a.soulIdentityId === asset.soulIdentityId) === index);
  const selectedSoulId = soulIdentityId || soulAssets[0]?.soulIdentityId || "";
  const boundSoulId = soulAssets[0]?.soulIdentityId;
  const hasBoundVideo = boundRefs.some(asset => asset.kind === "video");
  const videoReferenceKinds = hasBoundVideo ? boundRefs.map(asset => asset.kind).join(',') : '';
  // A trained likeness supplies the face; its cover is not an extra style reference.
  const refs = useMemo(() => kind === "audio" ? [] : model?.soulIdentity ? boundRefs.filter(asset => !asset.soulIdentityId) : boundRefs, [kind, model?.soulIdentity, boundRefs]);
  const referenceQuery = mediaQuoteReferences(refs);
  const roleFor = (asset: Asset) => asset.kind === "video" ? "reference_video" : kind === "video" && asset.id === firstFrameId ? "first_frame" : "reference_image";
  const referenceProblem = kind === "video" && model ? videoReferenceProblem(model, refs.map(asset => ({ kind: asset.kind, role: roleFor(asset) }))) : null;
  const audioBody = JSON.stringify(nodeAudioBody({ task: audioTask, text: prompt, seconds: audioSeconds, instrumental,
    voiceId: voiceId || audioSetup?.voices[0]?.id || "", modelId: speechModel || audioSetup?.defaultSpeechModel || "" }));
  const quoteKey = kind === "audio" ? audioBody : JSON.stringify({ modelId, resolution, ratio, duration, references: referenceQuery, firstFrameId, soulIdentityId: model?.soulIdentity ? selectedSoulId : undefined, ...(model?.marketing ? { prompt, marketing, shotId: mapped?.shotId, projectId: mapped?.productionProjectId } : {}) });
  const cost = pending?.credits ?? (!referenceProblem && quote?.key === quoteKey ? quote.credits : null);
  useEffect(() => {
    studioRequest<{ models: Model[] }>("/api/workbench/engines", { headers: { "X-Workbench-Scope": scope } })
      .then((d) => {
        const available = initial.pending ? d.models : referenceVideoModels(d.models, videoReferenceKinds.split(','));
        setModels(available);
        const preferred = target.options?.modelId ? available.find(m => m.id === target.options?.modelId) : undefined;
        const first = preferred || (!target.options?.modelId ? (initialKind === "image" && boundSoulId ? d.models.find(m => m.soulIdentity) : undefined)
          || available.find(m => m.kind === initialKind && !m.soulIdentity)
          || (initialKind === "image" ? d.models.find(m => !m.soulIdentity) : undefined) : undefined);
        if (first && !initial.pending && initialKind !== "audio") {
          setKind(first.kind);
          setModelId(first.id);
          setResolution(target.options?.resolution && first.resolutions.includes(target.options.resolution) ? target.options.resolution : first.resolutions[0]);
          const desiredRatio = target.options?.ratio || project.aspect;
          setRatio(first.ratios.includes(desiredRatio) ? desiredRatio : first.ratios.find(r => r !== 'adaptive') || first.ratios[0]);
          const desiredDuration = target.options?.duration || 5;
          setDuration(first.durations.includes(desiredDuration) ? desiredDuration : first.durations[0] || 5);
        } else if (!first && initialKind !== "audio")
          setError(hasBoundVideo ? "No configured video engine accepts these references. Connect a compatible engine or change the attached media before generating." : d.models.some(m => m.soulIdentity)
            ? "Attach a ready identity to this node, or connect another image engine in Workspace settings."
            : "No generation engine is configured for this workspace.");
        if (initial.pending && initial.pending.endpoint !== "/api/audio") {
          const restoredModel = d.models.find(m => m.id === JSON.parse(initial.pending!.body).model);
          if (restoredModel) setKind(restoredModel.kind);
        }
      })
      .catch((e) => setError(e.message));
  }, [initial.pending, initialKind, project.aspect, boundSoulId, hasBoundVideo, videoReferenceKinds, scope, target.options?.modelId, target.options?.ratio, target.options?.duration, target.options?.resolution]);
  useEffect(() => {
    if (kind !== "audio") return;
    const abort = new AbortController();
    studioRequest<NodeAudioSetup>("/api/audio", { signal: abort.signal, headers: { "X-Workbench-Scope": scope } })
      .then(data => { setAudioSetup(data); if (!data.configured) setError("Audio generation is not configured for this workspace."); })
      .catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [kind, scope]);
  useEffect(() => {
    if (kind !== "audio" || pending || !audioSetup?.configured || !prompt.trim() || (audioTask === "speech" && !JSON.parse(audioBody).voiceId)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      studioRequest<{ estimatedCredits: number }>("/api/audio", { method: "POST", signal: abort.signal,
        headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
        body: JSON.stringify({ ...JSON.parse(audioBody), quoteOnly: true }) })
        .then(data => { if (!validAudioQuote(data)) throw new Error("Audio pricing returned an invalid estimate.");
          if (!abort.signal.aborted) { setError(""); setQuote({ key: audioBody, credits: data.estimatedCredits }); } })
        .catch(error => { if (!abort.signal.aborted) { setQuote(null); setError(error.message); } });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [kind, pending, audioSetup?.configured, prompt, audioTask, audioBody, scope]);
  useEffect(() => {
    if (!model?.marketing || pending || mapped) return;
    let active = true;
    void (async () => {
      if (!(await callbacks.current.onSave())) throw new Error("Save this campaign before requesting its quote.");
      if (!active) return;
      const value = await studioRequest<{ shotId: string; productionProjectId: string }>("/api/workbench/projects", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
        body: JSON.stringify({ action: "map-shot", projectId: project.id, nodeId: target.node.id }),
      });
      if (!validMapping(value)) throw new Error("The project mapping could not be verified. Refresh the quote before generating.");
      if (active) setMapped(value);
    })().catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [model?.marketing, pending, mapped, project.id, target.node.id, scope, preparationRevision]);
  useEffect(() => {
    if (kind === "audio" || !model || pending || (model.marketing && !mapped)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      if (model.marketing) {
        const references = refs.map(asset => {
          const identity = mediaReferenceIdentity(asset);
          if (!identity) return null;
          return { ...identity, role: "reference_image" };
        });
        if (references.some(ref => !ref)) { setQuote(null); setError("Upload the product and cast images to this project before requesting a quote."); return; }
        void studioRequest<{ estimatedCredits: number; fingerprint: string }>("/api/generate/quote", {
          method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
          body: JSON.stringify({ model: modelId, prompt, ratio, resolution, refine: false, marketing, references, projectId: mapped!.productionProjectId, shotId: mapped!.shotId }),
        }).then(value => {
          if (!Number.isFinite(value.estimatedCredits) || value.estimatedCredits < 0 || !value.fingerprint) throw new Error("The connected account did not return a valid price. Please refresh the quote.");
          if (!abort.signal.aborted) { setError(""); setQuote({ key: quoteKey, credits: value.estimatedCredits, fingerprint: value.fingerprint }); }
        }).catch(error => { if (!abort.signal.aborted) { setQuote(null); setError(error.message); } });
      } else void studioRequest<{ credits: number | null }>(
        "/api/workbench/engines?" + new URLSearchParams({ model: modelId, resolution, ratio, duration: String(duration),
          ...(model.soulIdentity ? { soulIdentityId: selectedSoulId, projectId: project.id } : {}),
        }).toString() + '&' + referenceQuery,
        { signal: abort.signal, headers: { "X-Workbench-Scope": scope } },
      ).then(value => { if (!abort.signal.aborted) { setError(""); setQuote({ key: quoteKey, credits: value.credits }); } })
        .catch(error => { if (!abort.signal.aborted) { setQuote(null); setError(error.message); } });
    }, model.marketing ? 450 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [kind, model, modelId, resolution, ratio, duration, refs, referenceQuery, quoteKey, pending, selectedSoulId, project.id, scope, mapped, marketing, prompt, preparationRevision]);

  function acceptedSettings(attempt: PendingGeneration) {
    if(attempt.endpoint==='/api/audio')return undefined;
    const body=JSON.parse(attempt.body);
    return {prompt:String(body.prompt??target.prompt),options:{modelId:body.model,resolution:body.resolution,ratio:body.ratio,duration:body.duration,marketing:body.marketing,firstFrameAssetId:body.firstFrameAssetId,soulIdentityId:body.soulIdentityId,soulStrength:body.soulStrength}};
  }
  async function submit() {
    if (busy || initial.error || (!pending && ((kind !== "audio" && !model) || cost == null))) return;
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
        if (!validMapping(mapping)) throw new Error("The project mapping could not be verified. Nothing was submitted.");
        const references = [];
        for (const a of refs) {
          const role = roleFor(a);
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
        const body = JSON.stringify(kind === "audio" ? {
          ...JSON.parse(audioBody), projectId: mapping.productionProjectId, shotId: mapping.shotId, maxCredits: cost!,
        } : {
          prompt,
          model: model!.id,
          projectId: mapping.productionProjectId,
          shotId: mapping.shotId,
          ratio,
          resolution,
          ...(model!.marketing ? {} : { duration }),
          refine: false,
          maxCredits: cost!,
          references,
          ...(model!.marketing ? { marketing, quoteFingerprint: quote?.fingerprint } : {}),
          ...(kind === "video" ? { firstFrameAssetId: firstFrameId } : {}),
          ...(model!.soulIdentity ? { soulIdentityId: selectedSoulId, soulStrength, workbenchProjectId: project.id } : {}),
        });
        attempt = claimPendingGeneration(window.localStorage, storageId, {
          key: crypto.randomUUID(),
          body,
          credits: cost!,
          endpoint: kind === "audio" ? "/api/audio" : "/api/generate",
        });
        setPending(attempt);
      }
      const result = await studioRequest<{ id: string }>(attempt.endpoint ?? "/api/generate", {
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
      onQueued(result.id, attempt.endpoint === "/api/audio" ? "audio" : model?.kind, acceptedSettings(attempt));
      onClose();
    } catch (e) {
      if (attempt && e instanceof StudioRequestError) {
        if (typeof e.data.id === "string") {
          clearPendingGeneration(window.localStorage, storageId, attempt.key);
          onQueued(e.data.id, attempt.endpoint === "/api/audio" ? "audio" : model?.kind, acceptedSettings(attempt));
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
      <DialogContent className="ps ps-dialog" overlayClassName={kind !== "audio" && model?.soulIdentity ? "z-[100]" : undefined} style={kind !== "audio" && model?.soulIdentity ? { zIndex: 101 } : undefined}>
        <DialogHeader>
          <DialogTitle>Generate a new take</DialogTitle>
          <DialogDescription>
            {target.node.title} · {refs.length} bound media references
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-fields">
          <label className="field-label">Generate
            <select aria-label="Generation type" value={kind} disabled={busy || !!pending} onChange={event => {
              const next = event.target.value as typeof kind; setKind(next); setQuote(null); setError("");
              const nextModel = models.find(m => m.kind === next && (!m.soulIdentity || boundSoulId));
              if (nextModel) { setModelId(nextModel.id); setResolution(nextModel.resolutions[0]);
                setRatio(nextModel.ratios.includes(project.aspect) ? project.aspect : nextModel.ratios[0]); setDuration(nextModel.durations[0] || 5); }
              else if (next !== "audio") { setModelId(""); setError(`No ${next} generation engine is configured for this workspace.`); }
            }}>
              <option value="image" disabled={hasBoundVideo}>Image</option><option value="video">Video</option><option value="audio">Audio</option>
            </select>
          </label>
          {kind !== "audio" && <label className="field-label">
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
              {models.filter(m => m.kind === kind).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.kind}
                </option>
              ))}
            </select>
          </label>}
          {kind === "audio" && <div className="generation-options">
            <label className="field-label">Audio type<select aria-label="Audio type" value={audioTask} disabled={busy || !!pending} onChange={event => {
              const task = event.target.value as NodeAudioTask; setAudioTask(task); setAudioSeconds(task === "music" ? 30 : 10);
            }}><option value="sound">Sound effect / ambience</option><option value="music">Music</option><option value="speech">Dialogue / voice</option></select></label>
            {audioTask === "speech" ? <>
              <label className="field-label">Voice<select aria-label="Audio voice" value={voiceId || audioSetup?.voices[0]?.id || ""} disabled={busy || !!pending} onChange={event => setVoiceId(event.target.value)}>
                {!audioSetup?.voices.length && <option value="">No voices available</option>}{audioSetup?.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
              </select></label>
              <label className="field-label">Speech model<select aria-label="Speech model" value={speechModel || audioSetup?.defaultSpeechModel || ""} disabled={busy || !!pending} onChange={event => setSpeechModel(event.target.value)}>
                {audioSetup?.speechModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select></label>
            </> : <label className="field-label">Seconds<input aria-label="Audio duration" type="number" min={audioTask === "music" ? 10 : 0.5} max={audioTask === "music" ? 300 : 30} step={audioTask === "music" ? 1 : 0.5}
              value={audioSeconds} disabled={busy || !!pending} onChange={event => setAudioSeconds(Math.max(audioTask === "music" ? 10 : 0.5, Math.min(audioTask === "music" ? 300 : 30, Number(event.target.value) || 10)))} /></label>}
            {audioTask === "music" && <label><input type="checkbox" checked={instrumental} disabled={busy || !!pending} onChange={event => setInstrumental(event.target.checked)} />Instrumental</label>}
          </div>}
          {kind !== "audio" && model?.marketing && <div className="generation-options">
            <label className="field-label">Image quality<select aria-label="Marketing image quality" value={marketing.quality} disabled={busy || !!pending || marketing.enhancePrompt} onChange={event => setMarketing({ ...marketing, quality: event.target.value as MarketingGenerationOptions['quality'] })}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select></label>
            <p className="muted small-copy">{marketing.enhancePrompt ? "Preset enhancement · product first, optional cast second · high quality" : "Marketing Studio · direct creative direction"}. Price is checked live before rendering.</p>
          </div>}
          {kind !== "audio" && model?.soulIdentity && (
            <div className="generation-options">
              <label className="field-label">Identity
                <select aria-label="Identity" value={selectedSoulId} disabled={busy || !!pending} onChange={event => setSoulIdentityId(event.target.value)}>
                  {!soulAssets.length && <option value="">Attach a ready identity to this node</option>}
                  {soulAssets.map(asset => <option key={asset.soulIdentityId} value={asset.soulIdentityId}>{asset.name}</option>)}
                </select>
              </label>
              <label className="field-label">Likeness strength · {Math.round(soulStrength * 100)}%
                <input aria-label="Identity likeness strength" type="range" min="0" max="1" step="0.05" value={soulStrength} disabled={busy || !!pending} onChange={event => setSoulStrength(Number(event.target.value))} />
              </label>
            </div>
          )}
          {kind !== "audio" && refs.length > 0 && <ul className="generation-references" aria-label="Bound references">
            {refs.map(asset => <li key={asset.id} data-identity={asset.soulIdentityId ? "ready" : undefined}>{asset.name}{asset.soulIdentityId ? " · Identity" : ""}{asset.kind === "video" ? " · Video" : ""}</li>)}
          </ul>}
          {kind !== "audio" && soulAssets.length > 0 && !model?.soulIdentity && <p role="note" className="muted small-copy">{models.some(m => m.soulIdentity)
            ? "This engine uses the identity’s portrait as its reference. Choose the identity engine to render its trained likeness."
            : "Identity rendering is awaiting verification; this take uses the identity’s portrait as its reference."}</p>}
          {kind === "video" && <label className="field-label">First frame<select aria-label="Node first frame" value={firstFrameId} disabled={busy || !!pending} onChange={event => setFirstFrameId(event.target.value)}>
            <option value="">No first frame</option>{refs.filter(asset => asset.kind === "image").map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select></label>}
          {referenceProblem && <p role="alert" className="save-problem">{referenceProblem}</p>}
          <label className="field-label">
            {kind === "audio" && audioTask === "speech" ? "Script" : "Direction"}
            <textarea
              aria-label="Generation direction"
              value={prompt}
              disabled={busy || !!pending}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={kind === "audio" || model?.marketing ? 5000 : 10000}
            />
          </label>
          {kind !== "audio" && <div className="generation-options">
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
          </div>}
          {kind === "audio" && <p className="muted small-copy">Audio uses your written direction or script. The node’s visual references remain attached to the node.</p>}
          {pending && (
            <p role="status" className="muted small-copy">
              A previous submission is awaiting confirmation. Retry recovers the
              same take using its saved settings.
            </p>
          )}
          {error && (
            <p role="alert" className="save-problem">
              {error}
              {!pending && !initial.error && <button type="button" className="btn" disabled={busy} onClick={() => { setQuote(null); setError(""); setPreparationRevision(value => value + 1); }}>Refresh quote</button>}
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
              (!pending && (cost == null || !prompt.trim() || (kind !== "audio" && model?.soulIdentity && !selectedSoulId)))
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
