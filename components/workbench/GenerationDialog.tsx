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
import { generationRequestBody, resolveGenerationReferences } from "@/lib/workbench/generation-request";
import { audioTaskAvailable, nodeAudioBody, speechVoiceFor, speechVoicesFor, usableAudioTask, validAudioQuote, type NodeAudioSetup, type NodeAudioTask } from "@/lib/workbench/generation-audio";
import { videoReferenceProblem } from "@/lib/generationReferences";
import { referenceVideoModels } from "@/lib/workbench/reference-ad";
import { displayModelName, type ModelDef } from "@/lib/models";
import { CINEMA_STUDIO_CONTROLS, cleanCinemaControls, isCinemaStudioModel } from "@/lib/cinemaStudioTypes";
import { NumberDraftInput } from "./NumberDraftInput";
import { MARKETING_BUILDS, marketingQualities, marketingQualityFor, type MarketingBuild, type MarketingQuality, type MoleculrGenerationOptions } from '@/lib/workbench/moleculr';
import {
  pendingGenerationKey,
  readPendingGeneration,
  claimPendingGeneration,
  clearPendingGeneration,
  type PendingGeneration,
} from "@/lib/workbench/pending-generation";
import { settlePendingGeneration } from "@/lib/workspace/generate-submit";
import { SaveFailedError, saveMessage } from '@/lib/workbench/save-then-continue';

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
  /** Cinema Studio's Sound switch is offered in this workspace (GET /api/workbench/engines › sound). */
  sound?: boolean;
};
export type MarketingGenerationOptions = { variant?: MarketingBuild; quality: MarketingQuality; enhancePrompt: boolean; presetId?: string };
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
      saveMessage(data.error || `Request failed (${res.status})`),
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
type GenerationDialogProps = {
  scope: string;
  target: GenerationTarget;
  project: Project;
  onClose: () => void;
  onSave: () => Promise<boolean>;
  onQueued: (id: string, kind?: "image" | "video" | "audio", accepted?: { prompt: string; options: MoleculrGenerationOptions }) => void;
  onAsset: (id: string, fields: Partial<Asset>) => void;
};
/**
 * A take claimed earlier whose reply was lost is never sent again (it shares
 * its recovery key with the Rig's take of the same node). Recover asks the
 * server what became of it (settlePendingGeneration): landed, that job is
 * followed; never arrived or refused, it is let go and the dialog starts again
 * from the node as it is now, so nothing goes until its fresh price is on the
 * button and that button is pressed.
 */
export function GenerationDialog(props: GenerationDialogProps) {
  const [fresh, setFresh] = useState({ round: 0, notice: "" });
  return <TakeDialog key={fresh.round} {...props} notice={fresh.notice} onLetGo={(notice) => setFresh((f) => ({ round: f.round + 1, notice }))} />;
}
function TakeDialog({
  target,
  project,
  scope,
  onClose,
  onSave,
  onQueued,
  onAsset,
  notice,
  onLetGo,
}: GenerationDialogProps & { notice: string; onLetGo: (notice: string) => void }) {
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
    /* Cinema Studio 4.0's creative controls, as Gen offers them: documented values only, each Auto until picked. */
    [cinema, setCinema] = useState<Record<string, string>>(() => cleanCinemaControls(saved?.cinema ?? target.options?.cinema)),
    /* Cinema Studio 4.0's Sound switch: off unless the take being recovered, or the node's last take, had it on. */
    [sound, setSound] = useState<boolean>(saved ? saved.generateAudio === true : target.options?.generateAudio === true),
    [quote, setQuote] = useState<{
      key: string;
      credits: number | null;
      fingerprint?: string;
      /** Priced from published rates rather than a live figure: the delivered result settles it. */
      approximate?: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initial.error),
    /** The preset's own engine, when this workspace has not connected it and another engine stands in. */
    [missingEngine, setMissingEngine] = useState("");
  const model = models.find((m) => m.id === modelId && m.kind === kind);
  /* Cinema Studio 4.0 also takes the node's sounds as references (WAV uploads; the server checks each). */
  const cinemaModel = kind === "video" && model != null && isCinemaStudioModel(model.id);
  /* Its Sound switch, where this workspace is offered it (once its sound is priced, or in the house workspace). */
  const soundModel = cinemaModel && model?.sound === true;
  const boundRefs = useMemo(() => target.refs
    .map((id) => [...project.assets, ...(project.sharedAssets ?? [])].find((asset) => asset.id === id))
    .filter((asset): asset is Asset => !!asset && ["image", "video"].includes(asset.kind)), [target.refs, project.assets, project.sharedAssets]);
  const boundSounds = useMemo(() => target.refs
    .map((id) => [...project.assets, ...(project.sharedAssets ?? [])].find((asset) => asset.id === id))
    .filter((asset): asset is Asset => !!asset && asset.kind === "audio"), [target.refs, project.assets, project.sharedAssets]);
  const soulAssets = boundRefs.filter((asset, index, all) => asset.soulIdentityId && all.findIndex(a => a.soulIdentityId === asset.soulIdentityId) === index);
  const selectedSoulId = soulIdentityId || soulAssets[0]?.soulIdentityId || "";
  const boundSoulId = soulAssets[0]?.soulIdentityId;
  const hasBoundVideo = boundRefs.some(asset => asset.kind === "video");
  const videoReferenceKinds = hasBoundVideo ? boundRefs.map(asset => asset.kind).join(',') : '';
  // A trained likeness supplies the face; its cover is not an extra style reference.
  const refs = useMemo(() => kind === "audio" ? [] : model?.soulIdentity ? boundRefs.filter(asset => !asset.soulIdentityId)
    : cinemaModel ? [...boundRefs, ...boundSounds] : boundRefs, [kind, model?.soulIdentity, boundRefs, boundSounds, cinemaModel]);
  const referenceQuery = mediaQuoteReferences(refs);
  const roleFor = (asset: Asset) => asset.kind === "video" ? "reference_video" : asset.kind === "audio" ? "reference_audio" : kind === "video" && asset.id === firstFrameId ? "first_frame" : "reference_image";
  const referenceProblem = kind === "video" && model ? videoReferenceProblem(model, refs.map(asset => ({ kind: asset.kind, role: roleFor(asset) })), resolution) : null;
  /* Each speech model reads in its own vendor's voices: the list swaps with the model. */
  const speechModelId = speechModel || audioSetup?.defaultSpeechModel || "";
  const speechVoices = speechVoicesFor(audioSetup, speechModelId);
  const speechVoiceId = speechVoiceFor(speechVoices, voiceId)?.id ?? "";
  const audioBody = JSON.stringify(nodeAudioBody({ task: audioTask, text: prompt, seconds: audioSeconds, instrumental,
    voiceId: speechVoiceId, modelId: speechModelId }));
  /* Sound on is another request: it is priced (and approved) again. Off, the key is as it always was. */
  const withSound = soundModel && sound;
  const quoteKey = kind === "audio" ? audioBody : JSON.stringify({ modelId, resolution, ratio, duration, references: referenceQuery, firstFrameId, soulIdentityId: model?.soulIdentity ? selectedSoulId : undefined, ...(withSound ? { sound: true } : {}), ...(model?.marketing ? { prompt, marketing, shotId: mapped?.shotId, projectId: mapped?.productionProjectId } : {}) });
  const cost = pending?.credits ?? (!referenceProblem && quote?.key === quoteKey ? quote.credits : null);
  useEffect(() => {
    studioRequest<{ models: Model[] }>("/api/workbench/engines", { headers: { "X-Workbench-Scope": scope } })
      .then((d) => {
        const available = initial.pending ? d.models : referenceVideoModels(d.models, videoReferenceKinds.split(','));
        setModels(available);
        const wanted = target.options?.modelId;
        const preferred = wanted ? available.find(m => m.id === wanted) : undefined;
        /* A preset (Marketing Studio, a template) names its engine; when this workspace has not
           connected it, the first engine of the same kind stands in — named, never silently. */
        const first = preferred || (initialKind === "image" && boundSoulId ? d.models.find(m => m.soulIdentity) : undefined)
          || available.find(m => m.kind === initialKind && !m.soulIdentity)
          || (initialKind === "image" ? d.models.find(m => !m.soulIdentity) : undefined);
        if (first && !initial.pending && initialKind !== "audio") {
          if (wanted && !preferred) setMissingEngine(wanted);
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
      .then(data => {
        setAudioSetup(data);
        /* Sound and music are ElevenLabs'; a workspace on Grok Voice alone lands on a spoken line. */
        if (!initial.pending) setAudioTask(task => usableAudioTask(data, task));
        if (!data.configured) setError("Audio generation is not configured for this workspace.");
      })
      .catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [kind, scope, initial.pending]);
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
      if (!(await callbacks.current.onSave())) throw new SaveFailedError();
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
        void studioRequest<{ estimatedCredits: number; fingerprint: string; approximate?: boolean }>("/api/generate/quote", {
          method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
          body: JSON.stringify({ model: modelId, prompt, ratio, resolution, refine: false, marketing, references, projectId: mapped!.productionProjectId, shotId: mapped!.shotId }),
        }).then(value => {
          if (!Number.isFinite(value.estimatedCredits) || value.estimatedCredits < 0 || !value.fingerprint) throw new Error("The connected account did not return a valid price. Please refresh the quote.");
          if (!abort.signal.aborted) { setError(""); setQuote({ key: quoteKey, credits: value.estimatedCredits, fingerprint: value.fingerprint, approximate: value.approximate === true }); }
        }).catch(error => { if (!abort.signal.aborted) { setQuote(null); setError(error.message); } });
      } else void studioRequest<{ credits: number | null; approximate?: boolean }>(
        "/api/workbench/engines?" + new URLSearchParams({ model: modelId, resolution, ratio, duration: String(duration),
          ...(model.soulIdentity ? { soulIdentityId: selectedSoulId, projectId: project.id } : {}),
          ...(withSound ? { audio: "1" } : {}),
        }).toString() + '&' + referenceQuery,
        { signal: abort.signal, headers: { "X-Workbench-Scope": scope } },
      ).then(value => { if (!abort.signal.aborted) { setError(""); setQuote({ key: quoteKey, credits: value.credits, approximate: value.approximate === true }); } })
        .catch(error => { if (!abort.signal.aborted) { setQuote(null); setError(error.message); } });
    }, model.marketing ? 450 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [kind, model, modelId, resolution, ratio, duration, refs, referenceQuery, quoteKey, pending, selectedSoulId, project.id, scope, mapped, marketing, prompt, preparationRevision, withSound]);

  function acceptedSettings(attempt: PendingGeneration) {
    if(attempt.endpoint==='/api/audio')return undefined;
    const body=JSON.parse(attempt.body);
    /* A stand-in engine made this take (the preset's own is not connected here): the preset keeps
       its engine and settings, so it is itself again once that engine is connected. */
    const wanted=target.options?.modelId;
    if(wanted&&body.model!==wanted&&models.length&&!models.some(m=>m.id===wanted))return {prompt:String(body.prompt??target.prompt),options:target.options!};
    const controls=cleanCinemaControls(body.cinema);
    return {prompt:String(body.prompt??target.prompt),options:{modelId:body.model,resolution:body.resolution,ratio:body.ratio,duration:body.duration,marketing:body.marketing,firstFrameAssetId:body.firstFrameAssetId,soulIdentityId:body.soulIdentityId,soulStrength:body.soulStrength,...(Object.keys(controls).length?{cinema:controls}:{}),...(body.generateAudio===true?{generateAudio:true}:{})}};
  }
  async function submit() {
    if (busy || initial.error || (!pending && ((kind !== "audio" && !model) || cost == null))) return;
    setBusy(true);
    setError("");
    let attempt: PendingGeneration | null = null;
    try {
      /* Whatever is claimed for this node is asked about first, by its own key, and never sent again. */
      let claimed: PendingGeneration | null = null;
      try { claimed = readPendingGeneration(window.localStorage, storageId); } catch { /* settled below as unreadable */ }
      const settled = await settlePendingGeneration({ scope, storageId });
      if (settled.state === "unknown") { setError(settled.reason); return; }
      if (settled.state === "landed") {
        /* It reached the server: that take is followed, at the price approved for it, and nothing is sent. */
        onQueued(settled.jobId, claimed?.endpoint === "/api/audio" ? "audio" : model?.kind, claimed ? acceptedSettings(claimed) : undefined);
        onClose();
        return;
      }
      /* Recover never spends. Let go, the node as it is now is priced afresh before anything can go. */
      if (pending) { onLetGo(settled.state === "lost" ? settled.reason : ""); return; }
      if (!(await onSave()))
        throw new SaveFailedError();
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
      const references = await resolveGenerationReferences(refs, roleFor, { scope, onAsset });
      const body = JSON.stringify(kind === "audio" ? {
        ...JSON.parse(audioBody), projectId: mapping.productionProjectId, shotId: mapping.shotId, maxCredits: cost!,
      } : generationRequestBody({
        prompt,
        kind,
        model: model!,
        mapping,
        ratio,
        resolution,
        duration,
        maxCredits: cost!,
        references,
        marketing,
        quoteFingerprint: quote?.fingerprint,
        firstFrameAssetId: firstFrameId,
        soul: { soulIdentityId: selectedSoulId, soulStrength, workbenchProjectId: project.id },
        /* Price-neutral: the approximate quote is the same with or without them (lib/cinemaStudio.ts). The Sound
           switch goes only when it is on and offered; the price on the button was read for it. */
        ...(cinemaModel ? { cinema: cleanCinemaControls(cinema), generateAudio: withSound } : {}),
      }));
      const proposed: PendingGeneration = { key: crypto.randomUUID(), body, credits: cost!, endpoint: kind === "audio" ? "/api/audio" : "/api/generate" };
      const claim = claimPendingGeneration(window.localStorage, storageId, proposed);
      setPending(claim);
      /* Another window claimed this node meanwhile: that request is its own to send, never this one's. */
      if (claim.key !== proposed.key) throw new Error("Another Generate of this is already on its way. Nothing new was sent.");
      attempt = claim;
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
          "The server has not confirmed a job yet. Recover asks what became of it; nothing is sent again.",
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
          {kind !== "audio" && missingEngine && model && <p role="note" className="muted small-copy">{displayModelName(missingEngine)} isn’t connected in this workspace, so this take uses {model.label}.</p>}
          {kind === "audio" && <div className="generation-options">
            <label className="field-label">Audio type<select aria-label="Audio type" value={audioTask} disabled={busy || !!pending} onChange={event => {
              const task = event.target.value as NodeAudioTask; setAudioTask(task); setAudioSeconds(task === "music" ? 30 : 10);
            }}><option value="sound" disabled={!!audioSetup?.configured && !audioTaskAvailable(audioSetup, "sound")}>Sound effect / ambience</option><option value="music" disabled={!!audioSetup?.configured && !audioTaskAvailable(audioSetup, "music")}>Music</option><option value="speech">Dialogue / voice</option></select></label>
            {audioTask === "speech" ? <>
              <label className="field-label">Voice<select aria-label="Audio voice" value={speechVoiceId} disabled={busy || !!pending} onChange={event => setVoiceId(event.target.value)}>
                {!speechVoices.length && <option value="">No voices available</option>}{speechVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
              </select></label>
              <label className="field-label">Speech model<select aria-label="Speech model" value={speechModelId} disabled={busy || !!pending} onChange={event => setSpeechModel(event.target.value)}>
                {audioSetup?.speechModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select></label>
            </> : <label className="field-label">Seconds<NumberDraftInput aria-label="Audio duration" min={audioTask === "music" ? 10 : 0.5} max={audioTask === "music" ? 300 : 30} step={audioTask === "music" ? 1 : 0.5}
              value={audioSeconds} disabled={busy || !!pending} onCommit={setAudioSeconds} /></label>}
            {audioTask === "music" && <label><input type="checkbox" checked={instrumental} disabled={busy || !!pending} onChange={event => setInstrumental(event.target.checked)} />Instrumental</label>}
          </div>}
          {kind !== "audio" && model?.marketing && <div className="generation-options">
            <label className="field-label">Build<select aria-label="Marketing Studio build" value={marketing.variant ?? "alpha"} disabled={busy || !!pending} onChange={event => {
              const variant = event.target.value as MarketingBuild;
              setMarketing({ ...(variant === "alpha" ? {} : { variant }), quality: marketingQualityFor({ ...marketing, variant }),
                enhancePrompt: marketing.enhancePrompt, ...(marketing.presetId ? { presetId: marketing.presetId } : {}) });
            }}>
              {MARKETING_BUILDS.map(build => <option key={build.id} value={build.id}>{build.label}</option>)}
            </select></label>
            <label className="field-label">Image quality<select aria-label="Marketing image quality" value={marketing.quality} disabled={busy || !!pending || (marketing.enhancePrompt && (marketing.variant ?? "alpha") === "alpha")} onChange={event => setMarketing({ ...marketing, quality: event.target.value as MarketingQuality })}>
              {marketingQualities(marketing.variant).map(quality => <option key={quality.id} value={quality.id}>{quality.label}</option>)}
            </select></label>
            <p className="muted small-copy">{marketing.enhancePrompt ? `Preset enhancement · product first, optional cast second${(marketing.variant ?? "alpha") === "alpha" ? " · high quality" : ""}` : "Marketing Studio · direct creative direction"}. {(marketing.variant ?? "alpha") === "alpha" ? "Price is checked live before rendering." : "The price is approximate; the delivered image settles it."}</p>
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
            {refs.map(asset => <li key={asset.id} data-identity={asset.soulIdentityId ? "ready" : undefined}>{asset.name}{asset.soulIdentityId ? " · Identity" : ""}{asset.kind === "video" ? " · Video" : asset.kind === "audio" ? " · Sound" : ""}</li>)}
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
          {/* Cinema Studio 4.0's own documented controls, named and ordered as Gen's chips name them (lib/workspace/
              cinema-vocabulary.ts): each is Auto until picked, and Auto sends nothing, so Cinema Studio chooses. */}
          {cinemaModel && <div className="generation-options cinema-controls" role="group" aria-label="Cinema Studio controls" data-testid="dialog-cinema">
            {CINEMA_STUDIO_CONTROLS.map(control => (
              <label key={control.key}>
                <span data-functional-label="">{control.label}</span>
                <select aria-label={`Cinema Studio ${control.label.toLowerCase()}`} value={cinema[control.key] ?? ""} disabled={busy || !!pending}
                  onChange={event => { const value = event.target.value; setCinema(previous => { const next = { ...previous }; if (value) next[control.key] = value; else delete next[control.key]; return next; }); }}>
                  <option value="">Auto</option>
                  {control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ))}
          </div>}
          {/* Cinema Studio's Sound switch: off unless turned on here, whatever sounds the node is bound to. Turning it on
              or off reads the price again before Generate. */}
          {soundModel && <button type="button" role="switch" className="cinema-sound" aria-checked={sound} disabled={busy || !!pending}
            onClick={() => setSound(on => !on)} data-testid="dialog-cinema-sound">
            <span className="cinema-sound-dot" aria-hidden="true" /><span>With sound</span>
          </button>}
          {kind === "audio" && <p className="muted small-copy">Audio uses your written direction or script. The node’s visual references remain attached to the node.</p>}
          {notice && <p role="status" className="muted small-copy">{notice}</p>}
          {pending && (
            <p role="status" className="muted small-copy">
              Your last Generate of this node is unconfirmed. Recover asks the
              server what became of it; nothing is sent again.
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
                  : quote?.key === quoteKey && quote.approximate
                    ? `Generate · about ${cost} cr`
                    : `Generate · ${cost} cr estimated`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
