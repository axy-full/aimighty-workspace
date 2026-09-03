"use client";

import { useEffect, useRef, useState } from "react";
import { appAlert } from "./dialog";
import { IconClose, IconPlus } from "./Icons";
import { ParticlSpinner } from "./ParticlMark";
import { IMAGE_LIMITS } from "@/lib/imagemeta";
import { uploadFile, sha256OfFile } from "@/lib/uploadClient";
import type { ModelDef } from "@/lib/models";

export type ImageRole = "first_frame" | "last_frame" | "reference_image" | "reference_video";

export type RefItem = {
  id: string; filename: string; mime: string; kind: "image" | "video";
  bytes: number; width: number | null; height: number | null;
  durationS: number | null;
  sha256: string; url: string; base64Bytes: number;
  role: ImageRole; verified: boolean;
};

/** Lets the island open this strip's file picker, or hand it dropped files. */
export type RefPicker = { open: () => void; add: (files: FileList | File[]) => void } | null;

const ROLE_LABEL: Record<ImageRole, string> = {
  first_frame: "FIRST", last_frame: "LAST",
  reference_image: "REF", reference_video: "REF",
};
const ROLE_CYCLE: ImageRole[] = ["reference_image", "first_frame", "last_frame"];

const kb = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/**
 * Mirrors the server rules in /api/generate so the button can be disabled
 * before a doomed submit. The server still validates — this is the UI's copy.
 */
export function referenceProblem(
  refs: RefItem[], model: ModelDef, prompt = ""
): string | null {
  // Still engines (Nano Banana Pro): stills in, one still out. No videos,
  // no first/last-frame mode — every image is simply a reference.
  if (model.kind === "image") {
    const vids = refs.filter((r) => r.kind === "video");
    if (vids.length) return `${model.label} takes image references only — remove the video.`;
    const imgs = refs.filter((r) => r.kind === "image");
    for (const m of prompt.matchAll(/@Image(\d+)/gi)) {
      const n = Number(m[1]);
      if (n < 1 || n > imgs.length) {
        return `The prompt cites @Image${m[1]} but only ${imgs.length} reference image${imgs.length === 1 ? " is" : "s are"} attached.`;
      }
    }
    if (/@Video\d+/i.test(prompt)) {
      return `${model.label} has no video references — remove the @Video citation.`;
    }
    if (imgs.length > model.maxReferenceImages) {
      return `${model.label} accepts at most ${model.maxReferenceImages} reference images.`;
    }
    return null;
  }

  const images = refs.filter((r) => r.kind === "image" && r.role === "reference_image");
  const videos = refs.filter((r) => r.kind === "video");

  // A citation outliving its media would spend real money resolving to the
  // wrong reference or to nothing.
  for (const m of prompt.matchAll(/@Image(\d+)/gi)) {
    const n = Number(m[1]);
    if (n < 1 || n > images.length) {
      return `The prompt cites @Image${m[1]} but only ${images.length} reference image${images.length === 1 ? " is" : "s are"} attached.`;
    }
  }
  for (const m of prompt.matchAll(/@Video(\d+)/gi)) {
    const n = Number(m[1]);
    if (n < 1 || n > videos.length) {
      return `The prompt cites @Video${m[1]} but only ${videos.length} reference video${videos.length === 1 ? " is" : "s are"} attached.`;
    }
  }
  if (!refs.length) return null;

  const frames = refs.filter((r) => r.role === "first_frame" || r.role === "last_frame");
  if (frames.length && (images.length || videos.length)) {
    return "First/last frame and reference media can't be mixed — ModelArk treats them as separate modes.";
  }
  if (frames.length) {
    if (frames.filter((r) => r.role === "first_frame").length > 1) return "Only one first frame.";
    if (frames.filter((r) => r.role === "last_frame").length > 1) return "Only one last frame.";
    if (!frames.some((r) => r.role === "first_frame")) return "A last frame needs a first frame alongside it.";
  }
  if (images.length > model.maxReferenceImages) {
    return `This model accepts at most ${model.maxReferenceImages} reference images.`;
  }
  if (videos.length > model.maxReferenceVideos) {
    return `${model.label} accepts at most ${model.maxReferenceVideos} reference videos.`;
  }
  const totalVideoS = videos.reduce((a, v) => a + (v.durationS ?? 0), 0);
  if (totalVideoS > model.maxVideoSecondsTotal) {
    return `Reference videos total ${totalVideoS.toFixed(1)}s — ${model.label} allows ${model.maxVideoSecondsTotal}s combined.`;
  }
  const imagePayload = refs.filter((r) => r.kind === "image").reduce((a, r) => a + r.base64Bytes, 0);
  if (imagePayload > IMAGE_LIMITS.maxRequestBytes) {
    return `Reference images total ${(imagePayload / 1048576).toFixed(1)} MB encoded — over ModelArk's 64 MB request limit. Remove one; media is never re-compressed to fit.`;
  }
  return null;
}

/**
 * The references, as a strip of thumbnails inside the composer — where they
 * belong, since they travel with the one render being written. Tap a thumb
 * to cite it; tap its tag to change its role; drop files anywhere on the
 * island to add more. Masters are stored byte-for-byte and hash-checked.
 */
export default function References({
  refs, setRefs, model, onCite, pickerRef,
}: {
  refs: RefItem[];
  setRefs: React.Dispatch<React.SetStateAction<RefItem[]>>;
  model: ModelDef;
  onCite: (token: string) => void;
  pickerRef?: React.MutableRefObject<RefPicker>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function add(files: FileList | File[]) {
    setBusy(true); setErr(null);
    const next: RefItem[] = [];

    for (const file of Array.from(files)) {
      try {
        // Hash the original first, so we can prove the stored copy matches.
        const localHash = await sha256OfFile(file);
        const json = await uploadFile(file, "reference", (pct) =>
          setProgress(pct < 100 ? `${file.name} — ${pct}%` : `${file.name} — assembling…`)
        );
        if (json.kind !== "image" && json.kind !== "video") {
          throw new Error("References must be images or videos.");
        }
        next.push({
          ...(json as RefItem),
          role: (json.kind === "video" ? "reference_video" : "reference_image") as ImageRole,
          verified: json.sha256 === localHash,
        });
      } catch (e) {
        setErr(`${file.name}: ${(e as Error).message}`);
      }
    }

    // Functional update: two drops racing (or a remove mid-upload) must not
    // resurrect a stale snapshot of the list.
    if (next.length) setRefs((prev) => [...prev, ...next]);
    setBusy(false); setProgress(null);
    if (input.current) input.current.value = "";
  }

  useEffect(() => {
    if (!pickerRef) return;
    pickerRef.current = { open: () => input.current?.click(), add };
    return () => { pickerRef.current = null; };
    // add() closes over setters only — stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerRef]);

  function cycleRole(r: RefItem) {
    const i = ROLE_CYCLE.indexOf(r.role);
    const role = ROLE_CYCLE[(i + 1) % ROLE_CYCLE.length];
    setRefs((prev) => prev.map((x) => (x.id === r.id ? { ...x, role } : x)));
  }

  function remove(id: string) {
    setRefs((prev) => prev.filter((r) => r.id !== id));
    fetch(`/api/uploads/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const referenceImages = refs.filter((r) => r.kind === "image" && r.role === "reference_image");
  const referenceVideos = refs.filter((r) => r.kind === "video");
  const show = refs.length > 0 || busy || err;

  return (
    <div className={show ? "ref-strip" : "contents"}>
      <input
        ref={input} type="file" multiple hidden
        accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif,video/mp4,video/quicktime"
        onChange={(e) => e.target.files && add(e.target.files)}
      />

      {show && (
        <div className="ref-row">
          {refs.map((r) => {
            const citeIndex = r.kind === "video"
              ? referenceVideos.findIndex((x) => x.id === r.id) + 1
              : r.role === "reference_image"
                ? referenceImages.findIndex((x) => x.id === r.id) + 1
                : 0;
            const token = r.kind === "video" ? `@Video${citeIndex}` : `@Image${citeIndex}`;
            const citable = citeIndex > 0;
            const canCycle = r.kind === "image" && model.kind !== "image";
            const detail = r.kind === "video"
              ? `${r.durationS?.toFixed(1) ?? "?"}s · ${kb(r.bytes)}`
              : `${r.width ?? "?"}×${r.height ?? "?"} · ${kb(r.bytes)}`;
            return (
              <div key={r.id} className={`ref-thumb group ${r.verified ? "" : "ref-unverified"}`}
                title={`${r.filename}\n${detail}${r.verified ? "\nstored byte-identical" : "\nSTORED BYTES DO NOT MATCH"}`}>
                <button type="button"
                  onClick={() => citable && onCite(token)}
                  className="block h-full w-full"
                  aria-label={citable ? `Cite ${token}` : r.filename}>
                  {r.kind === "video" ? (
                    <video src={`${r.url}#t=0.1`} muted preload="metadata" playsInline
                      className="h-full w-full object-cover" />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={r.url} alt={r.filename} className="h-full w-full object-cover" />
                  )}
                </button>
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); if (canCycle) cycleRole(r); }}
                  className={`ref-tag ${citable ? "ref-tag-cite" : "ref-tag-role"}`}
                  title={canCycle ? "Tap to change: reference → first frame → last frame" : undefined}
                  tabIndex={canCycle ? 0 : -1}>
                  {citable ? token : ROLE_LABEL[r.role]}
                </button>
                {!r.verified && (
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); appAlert("Hashes don't match",
                      "The stored copy's bytes do not hash-match the original file. Remove it and upload again before spending a render on it."); }}
                    className="ref-bad" title="Stored bytes do not match the original">!</button>
                )}
                <button type="button" onClick={(e) => { e.stopPropagation(); remove(r.id); }}
                  className="ref-x reveal" title="Remove"><IconClose className="!h-3 !w-3" /></button>
              </div>
            );
          })}
          {busy && (
            <div className="ref-thumb ref-busy" title={progress ?? "Uploading…"}>
              <ParticlSpinner size={18} className="text-dim" />
            </div>
          )}
          {!busy && (
            <button type="button" onClick={() => input.current?.click()} className="ref-thumb ref-add"
              title="Add stills or clips">
              <IconPlus />
            </button>
          )}
        </div>
      )}
      {busy && progress && <p className="ref-note">{progress}</p>}
      {err && <p className="ref-err">{err}</p>}
    </div>
  );
}
