"use client";

import { useRef, useState, useImperativeHandle, type Ref } from "react";
import { previewAttrs } from "@/lib/preview";
import { Film, Upload, X } from "lucide-react";
import { useGenAssetInput, type GenAssetInputHandle } from "@/lib/genAssetInput";
import { useApi } from "@/lib/useApi";
import { useSession, useSignInHref } from "@/lib/session";
import { usePaidAction, paidActionStorageKey } from "@/lib/usePaidAction";
import { useLegacyRecovery } from "@/lib/useRecoverySurface";
import { fileProjectUpload } from "@/lib/workbench/project-library-client";
import { useUploadFile } from "@/lib/useUploadFile";
import { useToast } from "@/components/ui/Toast";
import type { Generation } from "@/lib/jobs";
import type { UploadedFile } from "@/lib/uploadClient";
import type { AdmissionQuote } from "@/lib/admissionTypes";
import styles from "./gen.module.css";
import edit from "./seedance-edit.module.css";

const DEFAULT_MODEL = "dreamina-seedance-2-5-260628";
const EDIT_LABEL: Record<string, string> = { "dreamina-seedance-2-5-260628": "Seedance 2.5 Edit", "dreamina-seedance-2-0-260128": "Seedance 2.0 Edit" };
type Asset = {
  key: string;
  id: string;
  name: string;
  url: string;
  kind: string;
  origin: "upload" | "generation";
  seconds?: number | null;
};
type Reviewed = { body: string; quote: AdmissionQuote };
const uploaded = (u: UploadedFile): Asset => ({
  key: `upload:${u.id}`,
  id: u.id,
  name: u.filename,
  url: u.url,
  kind: u.kind,
  origin: "upload",
  seconds: u.durationS,
});

export default function SeedanceEdit({
  project,
  onBack,
  onMade,
  initialSource,
  controller,
  model = DEFAULT_MODEL,
}: {
  project?: import("@/lib/generationProject").GenerationProject;
  onBack: () => void;
  onMade: () => void;
  initialSource?: string | null;
  controller?: Ref<GenAssetInputHandle>;
  /** The Seedance engine that takes the edit task (lib/models.ts › supportsTasks); 2.5 by default. */
  model?: string;
}) {
  const editLabel = EDIT_LABEL[model] ?? "Seedance Edit";
  const { signedIn, requestScope, workspace, email } = useSession();
  const signIn = useSignInHref();
  const toast = useToast();
  const upload = useUploadFile();
  const legacyRecovery = useLegacyRecovery([paidActionStorageKey(workspace?.id ?? "", email ?? "", "gen:seedance-2.5-edit")], signedIn);
  const paid = usePaidAction(`gen:seedance-2.5-edit${project && !legacyRecovery ? `:${project.id}` : ""}`);
  const {
    data: uploads,
    error: uploadError,
    refresh,
  } = useApi<{ uploads: UploadedFile[] }>((project ? `/api/workbench/library?projectId=${encodeURIComponent(project.id)}&source=uploads&limit=500` : "/api/uploads?limit=500"), 0, requestScope);
  const {
    data: takes,
    error: takeError,
    refresh: refreshTakes,
  } = useApi<{ generations: Generation[] }>(
    (project ? `/api/workbench/library?projectId=${encodeURIComponent(project.id)}&source=generations&limit=500` : "/api/jobs?status=succeeded&limit=500&sync=0"),
    0, requestScope,
  );
  const [added, setAdded] = useState<Asset[]>([]);
  const assets = [
    ...added,
    ...(uploads?.uploads ?? []).map(uploaded),
    ...(takes?.generations ?? [])
      .filter((g) => g.kind !== "audio" && g.status === "succeeded")
      .map((g): Asset => ({
        key: `generation:${g.id}`,
        id: g.id,
        name: g.title || g.prompt.slice(0, 70) || g.id,
        url: `/api/media/${encodeURIComponent(g.id)}`,
        origin: "generation",
        kind: g.kind,
        seconds:
          typeof g.params.duration === "number" ? g.params.duration : null,
      })),
  ].filter(
    (asset, index, all) =>
      all.findIndex((other) => other.key === asset.key) === index,
  );
  const [sourceKey, setSourceKey] = useState(initialSource ?? "");
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState("720p");
  const [audio, setAudio] = useState(true);
  const [referenceKeys, updateReferenceKeys] = useState<string[]>([]);
  const attachedReferences = useRef<string[]>([]);
  function setReferenceKeys(update: (previous: string[]) => string[]) {
    const next = update(attachedReferences.current);
    attachedReferences.current = next;
    updateReferenceKeys(next);
  }
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceInput = useRef<HTMLInputElement>(null),
    referenceInput = useRef<HTMLInputElement>(null);
  const source = assets.find((asset) => asset.key === sourceKey);
  const references = referenceKeys
    .map((key) => assets.find((asset) => asset.key === key))
    .filter((asset): asset is Asset => !!asset);
  const saved = paid.pending
    ? (JSON.parse(paid.pending.body) as Record<string, unknown>)
    : null;
  const savedContext = paid.pending?.context;
  const displayedReferences =
    saved && Array.isArray(savedContext?.references)
      ? (savedContext.references as Asset[])
      : references;
  const body = {
    projectId: project?.productionProjectId ?? null,
    model,
    task: "edit",
    prompt: `Edit @Video1: ${prompt.trim()}`,
    rawPrompt: prompt.trim(),
    sourceGenId: source?.origin === "generation" ? source.id : undefined,
    sourceUploadId: source?.origin === "upload" ? source.id : undefined,
    resolution,
    generateAudio: audio,
    refine: false,
    references: references.map((asset) =>
      asset.origin === "upload"
        ? { uploadId: asset.id, role: "reference_image" }
        : { genId: asset.id, role: "reference_image" },
    ),
  };
  const bodyKey = JSON.stringify(body);
  const quote = reviewed?.body === bodyKey ? reviewed.quote : null;
  const inputLocked = busy || !!paid.pending || !!paid.error;
  const priceLabel = (value: AdmissionQuote) =>
    value.unit === "cr" ? `${value.price} cr` : `$${value.price.toFixed(2)}`;

  const receiver = useGenAssetInput({
    scope: requestScope,
    locked: inputLocked,
    initialSource,
    acceptFile(file, target) {
      if (file.type.startsWith("image/") && attachedReferences.current.length >= 8) throw Error("Remove an image reference before adding another.");
      if (target === "source" && !file.type.startsWith("video/")) throw Error("Choose a video source clip.");
      if (target === "reference" && !file.type.startsWith("image/")) throw Error("Choose an image reference.");
      if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) throw Error("Choose a video source clip or an image reference.");
    },
    upload: async file => {
      const original = await upload(file, "reference");
      if (project && requestScope) await fileProjectUpload(project.id, original.id, requestScope);
      return original;
    },
    onAsset(asset, target) {
      if (target === "source" && asset.kind !== "video") throw Error("Choose a video source clip.");
      if (target === "reference" && asset.kind !== "image") throw Error("Choose an image reference.");
      if (asset.kind !== "image" && asset.kind !== "video") throw Error("Choose a video source clip or an image reference.");
      if (asset.kind === "image" && !attachedReferences.current.includes(asset.key) && attachedReferences.current.length >= 8) throw Error("Remove an image reference before adding another.");
      setAdded((previous) => [asset, ...previous.filter((item) => item.key !== asset.key)]);
      if (asset.kind === "video") setSourceKey(asset.key);
      else setReferenceKeys((previous) => [...new Set([...previous, asset.key])].slice(0, 8));
      setReviewed(null);
      setError(null);
      toast(asset.kind === "video" ? `${asset.name} selected as the source clip.` : `${asset.name} added as an image reference.`);
      void refresh();
    },
    onError: setError,
  });
  const uploading = receiver.busy;
  const blocked = inputLocked || uploading;
  const canQuote =
    signedIn &&
    source?.kind === "video" &&
    prompt.trim().length > 0 &&
    !blocked;
  useImperativeHandle(controller, () => ({ useAsset: receiver.useAsset, useFiles: receiver.useFiles }));
  const addFile = async (file: File | undefined, isSource: boolean) => {
    if (file) await receiver.useFiles([file], isSource ? "source" : "reference");
  };
  async function review() {
    if (!canQuote || !requestScope) return;
    setBusy(true);
    setError(null);
    setReviewed(null);
    try {
      const response = await fetch("/api/generate/quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workbench-Scope": requestScope,
        },
        body: bodyKey,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "The edit could not be quoted.");
      if (
        !Number.isInteger(result.estimatedCredits) ||
        result.estimatedCredits < 0 ||
        !/^[a-f0-9]{64}$/.test(result.fingerprint) ||
        !Number.isFinite(result.price) ||
        !["cr", "usd"].includes(result.unit)
      )
        throw new Error("The quote was incomplete. Review it again.");
      setReviewed({ body: bodyKey, quote: result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (busy || paid.error || (!paid.pending && !quote)) return;
    setBusy(true);
    setError(null);
    try {
      const request = saved ?? {
        ...body,
        maxCredits: quote!.estimatedCredits,
        quoteFingerprint: quote!.fingerprint,
      };
      const result = await paid.run<{ id: string }>("/api/generate", request, {
        context: {
          sourceName: source?.name,
          sourceUrl: source?.url,
          references,
          price: quote ? priceLabel(quote) : undefined,
        },
      });
      if (!result.data.id)
        throw new Error("Check Activity for the saved edit request.");
      setReviewed(null);
      onMade();
      toast("Edit queued. Its progress is in Your takes.");
    } catch (e) {
      setReviewed(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const displayedPrompt = saved
    ? String(saved.rawPrompt ?? saved.prompt ?? "")
    : prompt;
  const previewUrl = savedContext
    ? String(savedContext.sourceUrl ?? "")
    : source?.url;
  return (
    <section className={styles.composer} aria-label={editLabel} data-testid="seedance-edit" data-model={model}>
      <div className={styles.composerScroll}>
        <fieldset className={styles.fields} disabled={blocked}>
          <button
            type="button"
            className={styles.engine}
            onClick={onBack}
            aria-label="Choose a different generation model"
          >
            <Film size={20} />
            <span>
              <strong>{editLabel}</strong>
              <small>Edit an existing shot</small>
            </span>
          </button>
          <div className={edit.source} aria-label="Edit source drop area" onDragOver={receiver.onDragOver} onDrop={(event) => receiver.onDrop(event, "source")}>
            <label className={styles.sectionLabel} htmlFor="edit-source">
              Source clip
            </label>
            <select
              id="edit-source"
              className={edit.select}
              value={
                saved?.sourceGenId
                  ? `generation:${saved.sourceGenId}`
                  : saved?.sourceUploadId
                    ? `upload:${saved.sourceUploadId}`
                    : sourceKey
              }
              onChange={(event) => setSourceKey(event.target.value)}
            >
              <option value="">Choose a workspace video</option>
              {assets
                .filter((asset) => asset.kind === "video")
                .map((asset) => (
                  <option key={asset.key} value={asset.key}>
                    {asset.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={styles.secondary}
              disabled={!signedIn}
              onClick={() => sourceInput.current?.click()}
            >
              <Upload size={16} />
              Upload source clip
            </button>
            <input
              ref={sourceInput}
              type="file"
              accept="video/*"
              aria-label="Upload edit source"
              hidden
              onChange={(event) => {
                void addFile(event.target.files?.[0], true);
                event.target.value = "";
              }}
            />
            {previewUrl && (
              <video
                src={previewUrl}
                {...previewAttrs(previewUrl ? { url: previewUrl, kind: "video", name: "Source video" } : null)}
                controls
                playsInline
                className={edit.preview}
              />
            )}
            <p className={styles.referenceHint}>
              {savedContext?.sourceName
                ? String(savedContext.sourceName)
                : source
                  ? `${source.name} · ${source.seconds ?? "Unknown"}s`
                  : "480p or 720p source · 4–30 seconds"}
            </p>
          </div>
          <div>
            <label className={styles.sectionLabel} htmlFor="edit-prompt">
              Edit direction
            </label>
            <textarea
              id="edit-prompt"
              className={styles.prompt}
              value={displayedPrompt}
              maxLength={9500}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Replace the daylight with soft blue hour. Keep the actor, camera movement and composition. Preserve the dialogue."
            />
          </div>
          <div className={edit.source} aria-label="Edit reference drop area" onDragOver={receiver.onDragOver} onDrop={(event) => receiver.onDrop(event, "reference")}>
            <label className={styles.sectionLabel} htmlFor="edit-reference">
              Visual references · {displayedReferences.length}/8
            </label>
            <select
              id="edit-reference"
              className={edit.select}
              value=""
              disabled={referenceKeys.length >= 8}
              onChange={(event) => {
                if (event.target.value)
                  setReferenceKeys((previous) => [
                    ...previous,
                    event.target.value,
                  ]);
              }}
            >
              <option value="">Add an image from the workspace</option>
              {assets
                .filter(
                  (asset) =>
                    asset.kind === "image" &&
                    !referenceKeys.includes(asset.key),
                )
                .map((asset) => (
                  <option key={asset.key} value={asset.key}>
                    {asset.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={styles.secondary}
              disabled={!signedIn || referenceKeys.length >= 8}
              onClick={() => referenceInput.current?.click()}
            >
              <Upload size={16} />
              Upload reference image
            </button>
            <input
              ref={referenceInput}
              type="file"
              accept="image/*"
              aria-label="Upload edit reference"
              hidden
              onChange={(event) => {
                void addFile(event.target.files?.[0], false);
                event.target.value = "";
              }}
            />
            {displayedReferences.map((asset, index) => (
              <div key={asset.key} className={edit.reference}>
                <span>
                  @Image{index + 1} · {asset.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove reference ${index + 1}`}
                  onClick={() =>
                    setReferenceKeys((previous) =>
                      previous.filter((key) => key !== asset.key),
                    )
                  }
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className={edit.settings}>
            <label>
              Output resolution
              <select
                className={edit.select}
                value={String(saved?.resolution ?? resolution)}
                onChange={(event) => setResolution(event.target.value)}
              >
                <option value="480p">480p</option>
                <option value="720p">720p</option>
              </select>
            </label>
            <label className={edit.audio}>
              <input
                type="checkbox"
                checked={saved ? !!saved.generateAudio : audio}
                onChange={(event) => setAudio(event.target.checked)}
              />
              Native audio
            </label>
          </div>
          <p className={styles.referenceHint}>
            Duration and aspect follow the source. Describe what should change
            and what should stay.
          </p>
        </fieldset>
        {(uploadError || takeError) && (
          <p role="status" className={edit.error}>
            {uploadError || takeError}{" "}
            <button
              type="button"
              onClick={() => {
                void refresh();
                void refreshTakes();
              }}
            >
              Retry library
            </button>
          </p>
        )}
        {(error || paid.error) && (
          <p role="alert" className={edit.error}>
            {error || paid.error}
          </p>
        )}
        {paid.pending && (
          <p role="status" className={edit.recovery}>
            A submitted edit needs confirmation. Recover the saved request to
            check its result.
          </p>
        )}
        {uploading && <p role="status">Uploading source media…</p>}
      </div>
      <footer className={styles.composerFooter}>
        {!signedIn ? (
          <a className={styles.generate} href={signIn}>
            Sign in to edit
          </a>
        ) : (
          <button
            type="button"
            className={styles.generate}
            disabled={
              busy || uploading || !!paid.error || (!paid.pending && !canQuote)
            }
            onClick={() => void (paid.pending || quote ? submit() : review())}
          >
            <span>
              {busy
                ? "Working…"
                : paid.pending
                  ? "Recover edit"
                  : quote
                    ? "Generate edit"
                    : "Review edit cost"}
            </span>
            <strong>
              {paid.pending
                ? String(savedContext?.price ?? "Saved request")
                : quote
                  ? priceLabel(quote)
                  : "—"}
            </strong>
          </button>
        )}
      </footer>
    </section>
  );
}
