"use client";

import { useEffect, useRef, useState } from "react";
import { appAlert } from "./dialog";
import { IconPlus, IconClose } from "./Icons";
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

/** Lets the island's "+ Reference" chip open this panel's file picker. */
export type RefPicker = { open: () => void } | null;

const ROLE_LABEL: Record<ImageRole, string> = {
  first_frame: "FIRST", last_frame: "LAST",
  reference_image: "REF", reference_video: "REF VID",
};

const kb = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/**
 * Mirrors the server rules in /api/generate so the button can be disabled
 * before a doomed submit. The server still validates — this is the UI's copy.
 */
export function referenceProblem(
  refs: RefItem[], model: ModelDef, prompt = ""
): string | null {
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

/** The right-hand references panel — show the model instead of describing. */
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
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (!pickerRef) return;
    pickerRef.current = { open: () => input.current?.click() };
    return () => { pickerRef.current = null; };
  }, [pickerRef]);

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

  function setRole(id: string, role: ImageRole) {
    setRefs((prev) => prev.map((r) => (r.id === id ? { ...r, role } : r)));
  }

  async function remove(id: string) {
    setRefs((prev) => prev.filter((r) => r.id !== id));
    fetch(`/api/uploads/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const referenceImages = refs.filter((r) => r.kind === "image" && r.role === "reference_image");
  const referenceVideos = refs.filter((r) => r.kind === "video");
  const totalVideoS = referenceVideos.reduce((a, v) => a + (v.durationS ?? 0), 0);
  const unverified = refs.some((r) => !r.verified);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) add(e.dataTransfer.files); }}
      className={`flex min-h-full flex-col gap-3 p-4 transition-colors ${drag ? "bg-lift/8" : ""}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="ptitle text-[13.5px]">References</span>
        <span className="ml-auto font-mono text-[10.5px] text-mute">
          {refs.length > 0
            ? `${refs.length}${referenceVideos.length > 0 ? ` · ${totalVideoS.toFixed(1)}s / ${model.maxVideoSecondsTotal}s` : ""}`
            : ""}
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-dim">
        Show the model instead of describing. Attach stills and clips, then call
        them in the prompt as <span className="font-mono text-lift">@Image1</span> or{" "}
        <span className="font-mono text-lift">@Video1</span>.
      </p>

      <button
        type="button" onClick={() => input.current?.click()} disabled={busy}
        className="desk-grid grid h-[84px] w-full place-items-center rounded-[10px] border border-dashed border-line text-mute transition-colors hover:border-lift/60 hover:text-dim disabled:opacity-40"
        title="Add reference images or videos"
      >
        {busy
          ? <span className="font-mono text-[10px]">{progress ?? "…"}</span>
          : <span className="flex items-center gap-2 font-mono text-[10px] tracking-wide">
              <IconPlus /> drop stills or clips
            </span>}
      </button>
      <input
        ref={input} type="file" multiple hidden
        accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif,video/mp4,video/quicktime"
        onChange={(e) => e.target.files && add(e.target.files)}
      />

      {refs.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {refs.map((r) => {
            const citeIndex = r.kind === "video"
              ? referenceVideos.findIndex((x) => x.id === r.id) + 1
              : r.role === "reference_image"
                ? referenceImages.findIndex((x) => x.id === r.id) + 1
                : 0;
            const citeToken = r.kind === "video" ? `@Video${citeIndex}` : `@Image${citeIndex}`;
            return (
              <div key={r.id} className="min-w-0">
              <div className="group relative h-[84px] overflow-hidden rounded-[10px] border border-line bg-thumb">
                {r.kind === "video" ? (
                  <video src={`${r.url}#t=0.1`} muted preload="metadata" playsInline
                    className="h-full w-full object-cover"
                    title={`${r.filename}\n${r.durationS?.toFixed(1) ?? "?"}s · ${kb(r.bytes)}\nsha256 ${r.sha256.slice(0, 16)}…`} />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={r.url} alt={r.filename}
                    className="h-full w-full object-cover"
                    title={`${r.filename}\n${r.width ?? "?"}×${r.height ?? "?"} · ${kb(r.bytes)}\nsha256 ${r.sha256.slice(0, 16)}…`} />
                )}

                <span className={`absolute left-0 top-0 rounded-br-[6px] px-1.5 py-px font-mono text-[8px] tracking-wide ${
                  r.role === "reference_image" || r.role === "reference_video"
                    ? "bg-black/70 text-lift" : "bg-red text-white"
                }`}>
                  {citeIndex > 0 ? citeToken : ROLE_LABEL[r.role]}
                </span>
                {r.kind === "video" && r.durationS != null && (
                  <span className="absolute right-0 top-0 rounded-bl-[6px] bg-black/70 px-1.5 font-mono text-[8px] text-white/80">
                    {r.durationS.toFixed(1)}s
                  </span>
                )}

                {!r.verified && (
                  <button type="button"
                    onClick={() => appAlert("Hashes don't match",
                      "The stored copy's bytes do not hash-match the original file. Remove it and upload again before spending a render on it.")}
                    className="absolute bottom-0 left-0 bg-red px-1 font-mono text-[8px] text-white"
                    title="Stored bytes do not match the original — tap for details">
                    HASH?
                  </button>
                )}

                <div className="reveal absolute inset-x-0 bottom-0 flex">
                  {r.kind === "image" && (
                    <select
                      value={r.role}
                      onChange={(e) => setRole(r.id, e.target.value as ImageRole)}
                      className="h-[18px] min-w-0 flex-1 border-0 bg-black/80 px-0.5 font-mono text-[8px] text-white/80 max-[860px]:h-[26px]"
                      title="Role"
                    >
                      <option value="reference_image">ref</option>
                      <option value="first_frame">first</option>
                      <option value="last_frame">last</option>
                    </select>
                  )}
                  {citeIndex > 0 && (
                    <button type="button" onClick={() => onCite(citeToken)} title="Cite in prompt"
                      className="h-[18px] flex-1 bg-black/80 px-1 font-mono text-[8px] text-white/80 hover:text-lift max-[860px]:h-[26px] max-[860px]:text-[11px]">@</button>
                  )}
                  <button type="button" onClick={() => remove(r.id)} title="Remove"
                    className="grid h-[18px] w-[18px] shrink-0 place-items-center bg-black/80 text-white/80 hover:text-lift max-[860px]:h-[26px] max-[860px]:w-[26px]">
                    <IconClose />
                  </button>
                </div>
              </div>
              <p className="mt-1 truncate font-mono text-[9px] text-mute" title={r.filename}>
                {r.filename}
              </p>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        {progress && !busy && <span className="font-mono text-[9px] text-run">{progress}</span>}
        {refs.length > 0 && !unverified && !progress && (
          <span className="font-mono text-[9px] tracking-wider text-ok" title="Stored bytes hash-match the originals">
            ✓ BYTE-IDENTICAL
          </span>
        )}
      </div>

      {err && (
        <p className="rounded-[8px] bg-lift/8 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-lift">
          {err}
        </p>
      )}

      <div className="mt-auto border-t border-line pt-3 font-mono text-[10px] leading-relaxed text-mute">
        {model.label} — up to {model.maxReferenceImages} images ·{" "}
        {model.maxReferenceVideos} videos, {model.maxVideoSecondsTotal}s combined.
        Never recompressed: what you drop is byte-for-byte what the model sees.
      </div>
    </div>
  );
}
