"use client";

import { useRef, useState, useImperativeHandle, type Ref } from "react";
import { Image as ImageIcon, Upload } from "lucide-react";
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

import {
  TOPAZ_IMAGE_MODEL as MODEL,
  DEFAULT_TOPAZ_IMAGE,
  TOPAZ_IMAGE_PRESETS,
  type TopazImageSettings,
} from "@/lib/topaz";
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

export default function TopazImageUpscale({
  project,
  onBack,
  onMade,
  initialSource,
  controller,
}: {
  project?: import("@/lib/generationProject").GenerationProject;
  onBack: () => void;
  onMade: () => void;
  initialSource?: string | null;
  controller?: Ref<GenAssetInputHandle>;
}) {
  const { signedIn, requestScope, workspace, email } = useSession();
  const signIn = useSignInHref();
  const toast = useToast();
  const upload = useUploadFile();
  const legacyRecovery = useLegacyRecovery([paidActionStorageKey(workspace?.id ?? "", email ?? "", "gen:topaz-image-upscale")], signedIn);
  const paid = usePaidAction(`gen:topaz-image-upscale${project && !legacyRecovery ? `:${project.id}` : ""}`);
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
      .filter((g) => g.kind === "image" && g.status === "succeeded")
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
  const [settings, setSettings] =
    useState<TopazImageSettings>(DEFAULT_TOPAZ_IMAGE);
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const source = assets.find((asset) => asset.key === sourceKey);
  const saved = paid.pending
    ? (JSON.parse(paid.pending.body) as Record<string, unknown>)
    : null;
  const savedContext = paid.pending?.context;
  const topaz = saved?.topaz ? (saved.topaz as TopazImageSettings) : settings;
  const body = {
    projectId: project?.productionProjectId ?? null,
    model: MODEL,
    task: "generate",
    prompt: "",
    resolution: "24MP",
    ratio: "adaptive",
    refine: false,
    topaz: settings,
    references: source
      ? [
          source.origin === "upload"
            ? { uploadId: source.id, role: "reference_image" }
            : { genId: source.id, role: "reference_image" },
        ]
      : [],
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
    acceptFile(file) {
      if (!file.type.startsWith("image/")) throw Error("Choose a PNG, JPEG or WebP image.");
    },
    upload: async file => {
      const original = await upload(file, "chat");
      if (project && requestScope) await fileProjectUpload(project.id, original.id, requestScope);
      return original;
    },
    onAsset(asset) {
      if (asset.kind !== "image") throw Error("Choose an image for Topaz Image Upscale.");
      setAdded((previous) => [asset, ...previous.filter((item) => item.key !== asset.key)]);
      setSourceKey(asset.key);
      setReviewed(null);
      setError(null);
      toast(`${asset.name} selected for upscale.`);
      void refresh();
    },
    onError: setError,
  });
  const uploading = receiver.busy;
  const blocked = inputLocked || uploading;
  const canQuote = signedIn && source?.kind === "image" && !blocked;
  useImperativeHandle(controller, () => ({ useAsset: receiver.useAsset, useFiles: receiver.useFiles }));
  const addFile = async (file?: File) => { if (file) await receiver.useFiles([file]); };
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
        throw new Error(result.error || "The upscale could not be quoted.");
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
          sourceKey: source?.key,
          price: quote ? priceLabel(quote) : undefined,
        },
      });
      if (!result.data.id)
        throw new Error("Check Activity for the saved upscale request.");
      setReviewed(null);
      onMade();
      toast("Upscale queued. Its progress is in Your takes.");
    } catch (e) {
      setReviewed(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const previewUrl = savedContext
    ? String(savedContext.sourceUrl ?? "")
    : source?.url;
  return (
    <section className={styles.composer} aria-label="Topaz Image Upscale">
      <div className={styles.composerScroll}>
        <fieldset className={styles.fields} disabled={blocked}>
          <button
            type="button"
            className={styles.engine}
            onClick={onBack}
            aria-label="Choose a different generation model"
          >
            <ImageIcon size={20} />
            <span>
              <strong>Topaz Image Upscale</strong>
              <small>Precision enhancement from the original</small>
            </span>
          </button>
          <div className={edit.source} aria-label="Upscale image drop area" onDragOver={receiver.onDragOver} onDrop={receiver.onDrop}>
            <label className={styles.sectionLabel} htmlFor="upscale-source">
              Source image
            </label>
            <select
              id="upscale-source"
              className={edit.select}
              value={
                savedContext?.sourceKey
                  ? String(savedContext.sourceKey)
                  : sourceKey
              }
              onChange={(event) => setSourceKey(event.target.value)}
            >
              <option value="">Choose a workspace image</option>
              {assets
                .filter((asset) => asset.kind === "image")
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
              Upload source image
            </button>
            <input
              ref={sourceInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload upscale source"
              hidden
              onChange={(event) => {
                void addFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            {previewUrl && (
              // The protected original can be a local upload URL.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Original image to upscale"
                className={edit.preview}
              />
            )}
            <p className={styles.referenceHint}>
              {String(
                savedContext?.sourceName ??
                  source?.name ??
                  "Original PNG, JPEG or WebP · up to 30 MB",
              )}
            </p>
          </div>
          <div className={edit.settings}>
            <label>
              Precision model
              <select
                className={edit.select}
                aria-label="Precision model"
                value={topaz.model}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    model: e.target.value as TopazImageSettings["model"],
                  }))
                }
              >
                {TOPAZ_IMAGE_PRESETS.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </label>
            <label>
              Image scale
              <select
                className={edit.select}
                aria-label="Image scale"
                value={topaz.factor}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    factor: Number(
                      e.target.value,
                    ) as TopazImageSettings["factor"],
                  }))
                }
              >
                {[1, 2, 4].map((factor) => (
                  <option value={factor} key={factor}>
                    {factor}×
                  </option>
                ))}
              </select>
            </label>
            <label className={edit.audio}>
              <input
                type="checkbox"
                checked={topaz.faceEnhancement}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    faceEnhancement: e.target.checked,
                  }))
                }
              />
              Enhance faces
            </label>
            {topaz.faceEnhancement && (
              <label>
                Face strength
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={topaz.faceStrength}
                  onChange={(e) =>
                    setSettings((p) => ({
                      ...p,
                      faceStrength: Number(e.target.value),
                    }))
                  }
                />
              </label>
            )}
          </div>
          <p className={styles.referenceHint}>
            PNG output · source aspect preserved · up to 48 megapixels. The
            original file stays in your library.
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
            A submitted upscale needs confirmation. Recover the saved request to
            check its result.
          </p>
        )}
        {uploading && <p role="status">Uploading source media…</p>}
      </div>
      <footer className={styles.composerFooter}>
        {!signedIn ? (
          <a className={styles.generate} href={signIn}>
            Sign in to upscale
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
                  ? "Recover upscale"
                  : quote
                    ? "Upscale image"
                    : "Review upscale cost"}
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
