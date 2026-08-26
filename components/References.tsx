"use client";

import { useEffect, useRef, useState } from "react";
import { IconPlus, IconClose } from "./Icons";
import { IMAGE_LIMITS } from "@/lib/imagemeta";

export type ImageRole = "first_frame" | "last_frame" | "reference_image";

export type RefItem = {
  id: string; filename: string; mime: string; bytes: number;
  width: number | null; height: number | null;
  sha256: string; url: string; base64Bytes: number;
  role: ImageRole; verified: boolean;
};

/**
 * Mirrors the server rule in /api/generate so the button can be disabled before
 * a doomed submit. The server still validates — this is only the UI's copy.
 */
export function referenceProblem(refs: RefItem[], maxReference: number): string | null {
  if (!refs.length) return null;
  const frames = refs.filter((r) => r.role !== "reference_image");
  const references = refs.filter((r) => r.role === "reference_image");

  if (frames.length && references.length) {
    return "First/last frame and reference images can't be mixed — ModelArk treats them as separate modes.";
  }
  if (frames.length) {
    if (frames.filter((r) => r.role === "first_frame").length > 1) return "Only one first frame.";
    if (frames.filter((r) => r.role === "last_frame").length > 1) return "Only one last frame.";
    if (!frames.some((r) => r.role === "first_frame")) return "A last frame needs a first frame alongside it.";
  }
  if (references.length > maxReference) {
    return `This model accepts at most ${maxReference} reference images.`;
  }
  const payload = refs.reduce((a, r) => a + r.base64Bytes, 0);
  if (payload > IMAGE_LIMITS.maxRequestBytes) {
    return `References total ${(payload / 1048576).toFixed(1)} MB encoded — over ModelArk's 64 MB request limit. Remove one; images are never re-compressed to fit.`;
  }
  return null;
}

const ROLE_LABEL: Record<ImageRole, string> = {
  first_frame: "FIRST", last_frame: "LAST", reference_image: "REF",
};

const kb = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/** SHA-256 of the file as picked, computed in the browser before upload. */
async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function References({
  refs, setRefs, maxReference, onCite,
}: {
  refs: RefItem[];
  setRefs: (r: RefItem[]) => void;
  maxReference: number;
  onCite: (token: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  // Two upload paths, split by size:
  //  • ≤4MB — through our own authed route (fits under Vercel's 4.5MB request
  //    cap), stored fully private. This covers most reference stills.
  //  • >4MB — browser → Blob directly via the documented client-token flow,
  //    which only supports public objects; addRandomSuffix makes the URL
  //    crypto-random (unguessable), and the app only ever serves it through
  //    the authed proxy. Private client uploads need an SDK flow that isn't
  //    stable yet — revisit when it is.
  useEffect(() => {
    let alive = true;
    fetch("/api/uploads")
      .then((r) => r.json())
      .then((j) => { if (alive) setDirect(Boolean(j.direct)); })
      .catch(() => { if (alive) setDirect(false); });
    return () => { alive = false; };
  }, []);

  const SERVER_ROUTE_MAX = 4 * 1024 * 1024;

  async function uploadOne(file: File) {
    if (direct && file.size > SERVER_ROUTE_MAX) {
      const { upload } = await import("@vercel/blob/client");
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/uploads/token",
        contentType: file.type || undefined,
      });
      const res = await fetch("/api/uploads/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: blob.url, filename: file.name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      return json;
    }

    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body: fd });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Upload failed");
    return json;
  }

  async function add(files: FileList | File[]) {
    setBusy(true); setErr(null);
    const next: RefItem[] = [];

    for (const file of Array.from(files)) {
      try {
        // Hash the original first, so we can prove the stored copy matches.
        const localHash = await hashFile(file);
        const json = await uploadOne(file);

        next.push({
          ...json,
          role: "reference_image" as ImageRole,
          verified: json.sha256 === localHash,
        });
      } catch (e) {
        setErr(`${file.name}: ${(e as Error).message}`);
      }
    }

    if (next.length) setRefs([...refs, ...next]);
    setBusy(false);
    if (input.current) input.current.value = "";
  }

  function setRole(id: string, role: ImageRole) {
    setRefs(refs.map((r) => (r.id === id ? { ...r, role } : r)));
  }

  async function remove(id: string) {
    setRefs(refs.filter((r) => r.id !== id));
    fetch(`/api/uploads/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const referenceRefs = refs.filter((r) => r.role === "reference_image");
  const payload = refs.reduce((a, r) => a + r.base64Bytes, 0);
  const unverified = refs.some((r) => !r.verified);
  const problem = referenceProblem(refs, maxReference);

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
            {refs.length} · {kb(payload)} of 64 MB body
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {refs.length > 0 && !unverified && (
            <span className="font-mono text-[9px] tracking-wider text-ok" title="Stored bytes hash-match the originals">
              ✓ BYTE-IDENTICAL
            </span>
          )}
          <span className="font-mono text-[9px] text-mute">DROP OR CLICK +</span>
        </span>
      </div>

      <div className="flex items-stretch gap-1.5 overflow-x-auto px-2.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button" onClick={() => input.current?.click()} disabled={busy}
          className="grid h-[62px] w-[62px] shrink-0 place-items-center rounded-[3px] border border-dashed border-line text-mute transition-colors hover:border-lift hover:text-lift disabled:opacity-40"
          title="Add reference images"
        >
          {busy ? <span className="font-mono text-[9px]">…</span> : <IconPlus />}
        </button>
        <input
          ref={input} type="file" multiple hidden
          accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif"
          onChange={(e) => e.target.files && add(e.target.files)}
        />

        {refs.map((r, i) => {
          const citeIndex = r.role === "reference_image"
            ? referenceRefs.findIndex((x) => x.id === r.id) + 1 : 0;
          return (
            <div key={r.id} className="group relative h-[62px] w-[62px] shrink-0 overflow-hidden rounded-[3px] border border-line bg-desk">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.url} alt={r.filename}
                className="h-full w-full object-cover"
                title={`${r.filename}\n${r.width ?? "?"}×${r.height ?? "?"} · ${kb(r.bytes)}\nsha256 ${r.sha256.slice(0, 16)}…`} />

              <span className={`absolute left-0 top-0 px-1 py-px font-mono text-[8px] tracking-wide ${
                r.role === "reference_image" ? "bg-desk/85 text-lift" : "bg-lift text-white"
              }`}>
                {r.role === "reference_image" ? `@Image${citeIndex}` : ROLE_LABEL[r.role]}
              </span>

              {!r.verified && (
                <span className="absolute bottom-0 left-0 bg-lift px-1 font-mono text-[8px] text-white" title="Stored bytes do not match the original">
                  HASH?
                </span>
              )}

              <div className="absolute inset-x-0 bottom-0 flex opacity-0 transition-opacity group-hover:opacity-100">
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
                {r.role === "reference_image" && (
                  <button type="button" onClick={() => onCite(`@Image${citeIndex}`)} title="Cite in prompt"
                    className="h-[17px] bg-desk/95 px-1 font-mono text-[8px] text-dim hover:text-lift">@</button>
                )}
                <button type="button" onClick={() => remove(r.id)} title="Remove"
                  className="grid h-[17px] w-[17px] place-items-center bg-desk/95 text-dim hover:text-lift">
                  <IconClose />
                </button>
              </div>
              <span className="sr-only">{i + 1}</span>
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
