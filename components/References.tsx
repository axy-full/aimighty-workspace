"use client";

import { useRef, useState } from "react";
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

export default function References({
  refs, setRefs, model, onCite,
}: {
  refs: RefItem[];
  setRefs: React.Dispatch<React.SetStateAction<RefItem[]>>;
  model: ModelDef;
  onCite: (token: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

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
  const problem = referenceProblem(refs, model);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) add(e.dataTransfer.files); }}
      className={`border-b border-line bg-panel transition-colors ${drag ? "bg-lift/8" : ""}`}
    >
      <div className="flex items-center gap-2 px-2.5 pt-1.5">
        <span className="lbl">References</span>
        {refs.length > 0 && (
          <span className="font-mono text-[9px] text-mute">
            {refs.length}
            {referenceVideos.length > 0 && ` · ${totalVideoS.toFixed(1)}s / ${model.maxVideoSecondsTotal}s video`}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {progress && <span className="font-mono text-[9px] text-run">{progress}</span>}
          {refs.length > 0 && !unverified && !progress && (
            <span className="font-mono text-[9px] tracking-wider text-ok" title="Stored bytes hash-match the originals">
              ✓ BYTE-IDENTICAL
            </span>
          )}
          <span className="font-mono text-[9px] text-mute">IMAGES + VIDEOS · DROP OR CLICK +</span>
        </span>
      </div>

      <div className="flex items-stretch gap-1.5 overflow-x-auto px-2.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button" onClick={() => input.current?.click()} disabled={busy}
          className="grid h-[62px] w-[62px] shrink-0 place-items-center rounded-[3px] border border-dashed border-line text-mute transition-colors hover:border-lift hover:text-lift disabled:opacity-40"
          title="Add reference images or videos"
        >
          {busy ? <span className="font-mono text-[9px]">…</span> : <IconPlus />}
        </button>
        <input
          ref={input} type="file" multiple hidden
          accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif,video/mp4,video/quicktime"
          onChange={(e) => e.target.files && add(e.target.files)}
        />

        {refs.map((r) => {
          const citeIndex = r.kind === "video"
            ? referenceVideos.findIndex((x) => x.id === r.id) + 1
            : r.role === "reference_image"
              ? referenceImages.findIndex((x) => x.id === r.id) + 1
              : 0;
          const citeToken = r.kind === "video" ? `@Video${citeIndex}` : `@Image${citeIndex}`;
          return (
            <div key={r.id} className="group relative h-[62px] w-[62px] shrink-0 overflow-hidden rounded-[3px] border border-line bg-desk">
              {r.kind === "video" ? (
                <video src={`${r.url}#t=0.1`} muted preload="metadata"
                  className="h-full w-full object-cover"
                  title={`${r.filename}\n${r.durationS?.toFixed(1) ?? "?"}s · ${kb(r.bytes)}\nsha256 ${r.sha256.slice(0, 16)}…`} />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={r.url} alt={r.filename}
                  className="h-full w-full object-cover"
                  title={`${r.filename}\n${r.width ?? "?"}×${r.height ?? "?"} · ${kb(r.bytes)}\nsha256 ${r.sha256.slice(0, 16)}…`} />
              )}

              <span className={`absolute left-0 top-0 px-1 py-px font-mono text-[8px] tracking-wide ${
                r.role === "reference_image" || r.role === "reference_video"
                  ? "bg-desk/85 text-lift" : "bg-lift text-white"
              }`}>
                {citeIndex > 0 ? citeToken : ROLE_LABEL[r.role]}
              </span>
              {r.kind === "video" && r.durationS != null && (
                <span className="absolute right-0 top-0 bg-desk/85 px-1 font-mono text-[8px] text-dim">
                  {r.durationS.toFixed(1)}s
                </span>
              )}

              {!r.verified && (
                <span className="absolute bottom-0 left-0 bg-lift px-1 font-mono text-[8px] text-white" title="Stored bytes do not match the original">
                  HASH?
                </span>
              )}

              <div className="absolute inset-x-0 bottom-0 flex opacity-0 transition-opacity group-hover:opacity-100">
                {r.kind === "image" && (
                  <select
                    value={r.role}
                    onChange={(e) => setRole(r.id, e.target.value as ImageRole)}
                    className="h-[17px] min-w-0 flex-1 border-0 bg-desk/95 px-0.5 font-mono text-[8px] text-dim"
                    title="Role"
                  >
                    <option value="reference_image">ref</option>
                    <option value="first_frame">first</option>
                    <option value="last_frame">last</option>
                  </select>
                )}
                {citeIndex > 0 && (
                  <button type="button" onClick={() => onCite(citeToken)} title="Cite in prompt"
                    className="h-[17px] flex-1 bg-desk/95 px-1 font-mono text-[8px] text-dim hover:text-lift">@</button>
                )}
                <button type="button" onClick={() => remove(r.id)} title="Remove"
                  className="grid h-[17px] w-[17px] shrink-0 place-items-center bg-desk/95 text-dim hover:text-lift">
                  <IconClose />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {(err || problem) && (
        <p className="border-t border-line bg-lift/8 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-lift">
          {err ?? problem}
        </p>
      )}
    </div>
  );
}
