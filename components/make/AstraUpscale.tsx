"use client";
import { useMemo, useRef, useState, useImperativeHandle, type Ref } from "react";
import { Film, Upload } from "lucide-react";
import { useGenAssetInput, type GenAssetInputHandle } from "@/lib/genAssetInput";
import { useApi } from "@/lib/useApi";
import { useSession, useSignInHref } from "@/lib/session";
import { usePaidAction } from "@/lib/usePaidAction";
import { useUploadFile } from "@/lib/useUploadFile";
import { useToast } from "@/components/ui/Toast";
import { ASTRA_MODEL, DEFAULT_ASTRA, type AstraSettings } from "@/lib/astra";
import type { Generation } from "@/lib/jobs";
import type { UploadedFile } from "@/lib/uploadClient";
import type { AdmissionQuote } from "@/lib/admissionTypes";
import styles from "./gen.module.css";
import edit from "./seedance-edit.module.css";

type Source = {
  key: string;
  id: string;
  name: string;
  url: string;
  origin: "upload" | "generation";
};
const asUpload = (file: UploadedFile): Source => ({
  key: `upload:${file.id}`,
  id: file.id,
  name: file.filename,
  url: file.url,
  origin: "upload",
});
export default function AstraUpscale({
  onBack,
  onMade,
  initialSource,
  controller,
}: {
  onBack: () => void;
  onMade: () => void;
  initialSource?: string | null;
  controller?: Ref<GenAssetInputHandle>;
}) {
  const { signedIn, requestScope } = useSession(),
    signIn = useSignInHref(),
    toast = useToast(),
    uploader = useUploadFile();
  const paid = usePaidAction("gen:astra-2-upscale");
  const {
    data: uploads,
    error: uploadError,
    refresh,
  } = useApi<{ uploads: UploadedFile[] }>(
    signedIn ? "/api/uploads?limit=500" : null,
  );
  const {
    data: takes,
    error: takeError,
    refresh: refreshTakes,
  } = useApi<{ generations: Generation[] }>(
    "/api/jobs?status=succeeded&limit=500&sync=0",
  );
  const [added, setAdded] = useState<Source[]>([]),
    [key, setKey] = useState(initialSource || "");
  const [settings, setSettings] = useState(DEFAULT_ASTRA),
    [reviewed, setReviewed] = useState<{
      body: string;
      quote: AdmissionQuote;
    } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const sources = useMemo(() => {
    const all = [
      ...added,
      ...(uploads?.uploads || [])
        .filter((u) => u.kind === "video")
        .map(asUpload),
      ...(takes?.generations || [])
        .filter((g) => g.kind === "video" && g.status === "succeeded")
        .map((g): Source => ({
          key: `generation:${g.id}`,
          id: g.id,
          name: g.title || g.prompt.slice(0, 70) || g.id,
          url: `/api/media/${encodeURIComponent(g.id)}`,
          origin: "generation",
        })),
    ];
    return Array.from(new Map(all.map((item) => [item.key, item])).values());
  }, [added, uploads, takes]);
  const source = sources.find((item) => item.key === key),
    saved = paid.pending
      ? (JSON.parse(paid.pending.body) as Record<string, unknown>)
      : null;
  const displayed = (saved?.astra as AstraSettings | undefined) || settings;
  const body = {
    model: ASTRA_MODEL,
    task: "upscale",
    prompt: "",
    refine: false,
    sourceGenId: source?.origin === "generation" ? source.id : undefined,
    sourceUploadId: source?.origin === "upload" ? source.id : undefined,
    resolution: "4k",
    fps60: settings.fps === 60,
    astra: settings,
    references: [],
  };
  const bodyKey = JSON.stringify(body),
    quote = reviewed?.body === bodyKey ? reviewed.quote : null;
  const inputLocked = busy || !!paid.pending || !!paid.error;
  const price = (value: AdmissionQuote) =>
    value.unit === "cr" ? `${value.price} cr` : `$${value.price.toFixed(2)}`;
  const receiver = useGenAssetInput({
    scope: requestScope,
    locked: inputLocked,
    initialSource,
    acceptFile(file) {
      if (!/\.(mp4|mov)$/i.test(file.name) || file.size > 200 * 1024 * 1024)
        throw Error("Choose an MP4 or MOV original up to 200 MB.");
    },
    upload: (file) => uploader(file, "chat"),
    onAsset(asset) {
      if (asset.kind !== "video") throw Error("Choose a video for Astra upscale.");
      setAdded((previous) => [asset, ...previous.filter((item) => item.key !== asset.key)]);
      setKey(asset.key);
      setReviewed(null);
      setError("");
      toast(`${asset.name} selected for upscale.`);
      void refresh();
    },
    onError: setError,
  });
  const uploading = receiver.busy;
  const blocked = inputLocked || uploading;
  useImperativeHandle(controller, () => ({ useAsset: receiver.useAsset, useFiles: receiver.useFiles }));
  const upload = async (file?: File) => { if (file) await receiver.useFiles([file]); };
  async function review() {
    if (!source || blocked || !requestScope) return;
    setBusy(true);
    setError("");
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
        throw new Error(result.error || "This source could not be quoted.");
      if (
        !Number.isInteger(result.estimatedCredits) ||
        !result.fingerprint ||
        !Number.isFinite(result.price) ||
        !result.unit
      )
        throw new Error("The quote was incomplete. Review it again.");
      setReviewed({ body: bodyKey, quote: result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cost review failed.");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (busy || paid.error || (!paid.pending && !quote)) return;
    setBusy(true);
    setError("");
    try {
      const result = await paid.run<{ id: string }>(
        "/api/generate",
        saved || {
          ...body,
          maxCredits: quote!.estimatedCredits,
          quoteFingerprint: quote!.fingerprint,
        },
        {
          context: {
            sourceName: source?.name,
            sourceUrl: source?.url,
            price: quote ? price(quote) : undefined,
          },
        },
      );
      if (!result.data.id)
        throw new Error("Check Activity for the saved upscale request.");
      setReviewed(null);
      onMade();
      toast("Astra upscale queued. Its progress is in Your takes.");
    } catch (cause) {
      setReviewed(null);
      setError(
        cause instanceof Error ? cause.message : "Upscale submission failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const sourceUrl = paid.pending
    ? String(paid.pending.context?.sourceUrl || "")
    : source?.url;
  return (
    <section className={styles.composer} aria-label="Topaz Astra 2">
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
              <strong>Topaz Astra 2</strong>
              <small>Creative video upscale</small>
            </span>
          </button>
          <div className={edit.source} aria-label="Astra source drop area" onDragOver={receiver.onDragOver} onDrop={receiver.onDrop}>
            <label className={styles.sectionLabel} htmlFor="astra-source">
              Original source clip
            </label>
            <select
              id="astra-source"
              aria-label="Astra source clip"
              className={edit.select}
              value={
                saved?.sourceGenId
                  ? `generation:${saved.sourceGenId}`
                  : saved?.sourceUploadId
                    ? `upload:${saved.sourceUploadId}`
                    : key
              }
              onChange={(event) => setKey(event.target.value)}
            >
              <option value="">Choose a workspace video</option>
              {sources.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.secondary}
              disabled={!signedIn}
              onClick={() => input.current?.click()}
            >
              <Upload size={16} />
              Upload source clip
            </button>
            <input
              ref={input}
              hidden
              type="file"
              accept=".mp4,.mov,video/mp4,video/quicktime"
              aria-label="Upload Astra source"
              onChange={(event) => void upload(event.target.files?.[0])}
            />
            {sourceUrl && (
              <video
                aria-label="Astra original source"
                src={sourceUrl}
                controls
                playsInline
                className={edit.preview}
              />
            )}
            <p className={styles.referenceHint}>
              {String(
                paid.pending?.context?.sourceName ||
                  source?.name ||
                  "MP4 or MOV · up to 5 minutes and 200 MB",
              )}
            </p>
          </div>
          <div className={edit.settings}>
            <label>
              Output frame rate
              <select
                aria-label="Astra output frame rate"
                className={edit.select}
                value={displayed.fps}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    fps: Number(event.target.value) as 30 | 60,
                  }))
                }
              >
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </label>
          </div>
          {(
            [
              ["creativity", "Creativity"],
              ["realism", "Realism"],
              ["sharpness", "Sharpness"],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className={styles.sectionLabel}>
              {label} · {Math.round(displayed[field] * 100)}%
              <input
                aria-label={`Astra ${label.toLowerCase()}`}
                style={{ width: "100%", minHeight: 32, accentColor: "#d1e58d" }}
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(displayed[field] * 100)}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    [field]: Number(event.target.value) / 100,
                  }))
                }
              />
            </label>
          ))}
          <p className={styles.referenceHint}>
            Astra chooses the final dimensions, typically 4K. Cost is estimated
            at the 4K tier using your original clip’s duration and selected
            frame rate. This creative model can reinterpret fine detail; the
            original is retained.
          </p>
        </fieldset>
        {(uploadError || takeError) && (
          <p role="status" className={edit.error}>
            {uploadError || takeError}{" "}
            <button
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
        {uploading && <p role="status">Uploading original clip…</p>}
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
              busy || uploading || !!paid.error || (!paid.pending && !source)
            }
            onClick={() => void (paid.pending || quote ? submit() : review())}
          >
            <span>
              {busy
                ? "Working…"
                : paid.pending
                  ? "Recover Astra upscale"
                  : quote
                    ? "Upscale video"
                    : "Review upscale cost"}
            </span>
            <strong>
              {paid.pending
                ? String(paid.pending.context?.price || "Saved request")
                : quote
                  ? price(quote)
                  : "Review"}
            </strong>
          </button>
        )}
      </footer>
    </section>
  );
}
