"use client";

/**
 * The theatre: one render, full size, with everything known about it on the
 * side — the prompt as it was typed, what it cost, who made it, and the
 * sign-off. Arrow keys walk the wall; Escape leaves. Rendered through a
 * portal so no screen's transform can pin it in place.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Gen } from "./GenCard";
import Review from "./Review";
import { ParticlSpinner } from "./ParticlMark";
import { appConfirm, appPrompt, appAlert } from "./dialog";
import { renameClip } from "./ContextMenu";
import { uploadFile } from "@/lib/uploadClient";
import { useProject } from "@/lib/projectContext";
import { usd, timeAgo, downloadHref, compactTokens } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import { prettyModel } from "@/lib/enhance";
import { IconClose, IconArrowLeft, IconArrowRight, IconDown, IconTrash, IconCopy, IconAudio } from "./Icons";

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

export default function Theatre({
  gens, activeId, onClose, onSelect, onChanged, onUse, onEditExtend,
}: {
  gens: Gen[];
  activeId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onChanged: () => void;
  /** Load this render's prompt into the composer. */
  onUse?: (gen: Gen) => void;
  /** Start an edit or extension from this render. */
  onEditExtend?: (task: "edit" | "extend", gen: Gen) => void;
}) {
  const idx = gens.findIndex((g) => g.id === activeId);
  const gen = idx >= 0 ? gens[idx] : null;
  const prev = idx > 0 ? gens[idx - 1] : null;
  const next = idx >= 0 && idx < gens.length - 1 ? gens[idx + 1] : null;
  const [copied, setCopied] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const { selection } = useProject();
  const projectScope = selection !== "all" && selection !== "unfiled" ? selection : null;

  useEffect(() => {
    if (!gen) return;
    const onKey = (e: KeyboardEvent) => {
      // Typing a note or scrubbing the player must never walk the wall:
      // arrows belong to the caret and the seek bar there. Escape just
      // leaves the field; a second Escape closes the theatre.
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('input,textarea,select,[contenteditable="true"],video')) {
        if (e.key === "Escape") (t as HTMLElement).blur();
        return;
      }
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prev) onSelect(prev.id);
      else if (e.key === "ArrowRight" && next) onSelect(next.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [gen, prev, next, onClose, onSelect]);

  if (!gen || typeof document === "undefined") return null;

  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && Boolean(url);
  const live = gen.status === "queued" || gen.status === "running";
  const still = gen.kind === "image";
  const p = gen.params as {
    resolution?: string; ratio?: string; duration?: number; seed?: number | string | null;
    rawPrompt?: string; cast?: string[];
  };
  const shown = p.rawPrompt || gen.prompt;
  const filing = gen.shotCode ? `${gen.shotCode} · v${gen.version ?? 1}` : clipId(gen.id);
  const title = gen.title || filing;

  async function rename() {
    await renameClip(gen!.id, gen!.title ?? "");
    onChanged();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — nothing sensible to do */ }
  }

  async function remove() {
    if (!(await appConfirm(`Delete ${clipId(gen!.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${gen!.id}`, { method: "DELETE" });
    onChanged();
    onClose();
  }

  /**
   * A still of this render, as a File: the PNG itself for a still, or the
   * frame the player is on for a video — drawn from a same-origin copy the
   * way the wall's posters are, so the canvas may read it.
   */
  async function frameFile(): Promise<File> {
    const base = url!;
    const src = `${base}${base.includes("?") ? "&" : "?"}stream=1`;
    if (still) {
      const blob = await (await fetch(src)).blob();
      return new File([blob], `${clipId(gen!.id)}.png`, { type: "image/png" });
    }
    const at = document.querySelector<HTMLVideoElement>(".theatre-media")?.currentTime ?? 0.1;
    const blob = await new Promise<Blob>((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      const timer = setTimeout(() => reject(new Error("Couldn't read a frame from this render.")), 15_000);
      v.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Couldn't read this render.")); }, { once: true });
      v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(Math.max(at, 0.05), Math.max(0.05, v.duration - 0.05)); }, { once: true });
      v.addEventListener("seeked", () => {
        clearTimeout(timer);
        try {
          const c = document.createElement("canvas");
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext("2d")!.drawImage(v, 0, 0);
          c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the frame."))), "image/png");
        } catch (e) { reject(e as Error); }
        finally { v.removeAttribute("src"); v.load(); }
      }, { once: true });
      v.src = src; v.load();
    });
    return new File([blob], `${clipId(gen!.id)}-frame.png`, { type: "image/png" });
  }

  /** This render becomes a character, a location, a prop or a look in the cast. */
  async function saveToCast(kind: "character" | "location" | "prop" | "style") {
    setSaveMenu(false);
    const what = kind === "style" ? "look" : kind;
    const name = await appPrompt(`Name this ${what}`, "", kind === "character" ? "e.g. Maya" : kind === "location" ? "e.g. HarbourSet" : kind === "prop" ? "e.g. RedHelmet" : "e.g. NoirLook");
    if (!name?.trim()) return;
    const description = await appPrompt("Describe it in a line", "", "what must stay the same, in a breath");
    if (description === null) return;
    setSaving("Capturing…");
    try {
      const f = await frameFile();
      setSaving("Uploading…");
      const up = await uploadFile(f, "reference", (pct) => setSaving(`Uploading ${pct}%`));
      const res = await fetch("/api/cast", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind, description, uploadId: up.id, projectId: gen!.projectId ?? projectScope }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't add it");
      await appAlert(`@${name.trim()} is in the cast`, "Write the name in any prompt and this frame comes with it.");
    } catch (e) {
      await appAlert("Couldn't save it", (e as Error).message);
    } finally { setSaving(null); }
  }

  return createPortal(
    <div className="theatre" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="theatre-stage" onClick={(e) => e.stopPropagation()}
        data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)}
        data-gen-title={gen.title ?? ""}>
        {done ? (
          still ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={gen.id} src={url!} alt={gen.prompt.slice(0, 120)} className="theatre-media" />
          ) : gen.kind === "audio" ? (
            <div className="theatre-face">
              <IconAudio className="!h-10 !w-10 text-white/70" />
              <p className="mt-3 max-w-[52ch] text-center text-[15px] text-white/90">{gen.title || gen.prompt.slice(0, 160)}</p>
              <audio key={gen.id} src={url!} controls autoPlay className="mt-4 w-[min(520px,90%)]" />
            </div>
          ) : (
            <video key={gen.id} src={url!} controls autoPlay loop playsInline className="theatre-media" />
          )
        ) : (
          <div className="theatre-face">
            {live ? (
              <>
                <ParticlSpinner size={34} className="text-white/80" />
                <p className="mt-3 text-[15px] font-medium text-white/90">{gen.status === "queued" ? "Queued" : "Rendering"}…</p>
                <p className="mt-1 text-[13px] text-white/60">It will appear here the moment it lands.</p>
              </>
            ) : (
              <>
                <p className="text-[15px] font-medium text-[#FF6B60]">{gen.status === "cancelled" ? "Cancelled" : "Failed"}</p>
                {gen.error && <p className="mt-2 max-w-[52ch] text-[13.5px] leading-relaxed text-white/70">{gen.error}</p>}
              </>
            )}
          </div>
        )}

        {prev && (
          <button type="button" onClick={() => onSelect(prev.id)} className="theatre-nav theatre-prev" title="Previous  ←">
            <IconArrowLeft />
          </button>
        )}
        {next && (
          <button type="button" onClick={() => onSelect(next.id)} className="theatre-nav theatre-next" title="Next  →">
            <IconArrowRight />
          </button>
        )}
      </div>

      <aside className="theatre-side" onClick={(e) => e.stopPropagation()}>
        <header className="theatre-head">
          <div className="min-w-0">
            <button type="button" onClick={rename} title={gen.title ? "Rename" : "Name this clip"}
              className="block max-w-full truncate text-left text-[16px] font-semibold tracking-[-0.01em] hover:text-blue">
              {title}
            </button>
            <p className="text-[12.5px] text-mute">
              {gen.title ? `${filing} · ` : ""}{gen.projectName ?? "Unfiled"}{gen.authorName ? ` · ${gen.authorName}` : ""} · {timeAgo(gen.createdAt)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="theatre-close" title="Close  Esc"><IconClose /></button>
        </header>

        <div className="theatre-body">
          <p className="theatre-prompt">{shown}</p>
          {p.cast && p.cast.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {p.cast.map((n) => (
                <span key={n} className="rounded-full bg-blue/10 px-2 py-0.5 text-[12px] font-medium text-blue">@{n}</span>
              ))}
            </p>
          )}

          <div className="theatre-meta">
            <span className="font-medium text-dim">{shortLabel(gen.model)}</span>
            {p.resolution && <span>{String(p.resolution).toUpperCase()}</span>}
            {p.ratio && <span>{p.ratio === "adaptive" ? "Auto" : p.ratio}</span>}
            {p.duration != null && <span>{p.duration}s</span>}
            {p.seed != null && p.seed !== "" && <span>seed {p.seed}</span>}
            {(gen.params as { look?: { name?: string } }).look?.name && (
              <span className="rounded-full bg-chip px-2 py-0.5 text-[11.5px] font-medium text-dim">
                {(gen.params as { look: { name: string } }).look.name}
              </span>
            )}
            {gen.costUsd != null && (
              <span className="font-semibold text-bone" title="Render plus prompt">
                {usd(gen.costUsd + (gen.refineCostUsd ?? 0))}
              </span>
            )}
          </div>

          {/* The ledger for this one render: what the engine charged, what
              the writer charged, and the sum that appears everywhere else. */}
          {gen.costUsd != null && (
            <div className="theatre-ledger">
              <span><span className="text-mute">Render</span> {usd(gen.costUsd)}</span>
              <span>
                <span className="text-mute">Prompt</span>{" "}
                {gen.refineCostUsd != null && gen.refineModel
                  ? <>{gen.refineCostUsd > 0 ? usd(gen.refineCostUsd) : "free"}<span className="text-mute"> · {prettyModel(gen.refineModel)}
                      {gen.refineInTokens != null ? ` · ${compactTokens(gen.refineInTokens)} in / ${compactTokens(gen.refineOutTokens ?? 0)} out` : ""}</span></>
                  : <span className="text-mute">as written</span>}
              </span>
              <span className="ml-auto font-semibold text-bone">{usd(gen.costUsd + (gen.refineCostUsd ?? 0))}</span>
            </div>
          )}

          <div className="theatre-actions">
            <button type="button" onClick={copy} className="chip !py-1.5 !text-[13px]">
              <IconCopy /> {copied ? "Copied" : "Copy prompt"}
            </button>
            {onUse && (
              <button type="button" onClick={() => onUse(gen)} className="chip !py-1.5 !text-[13px]" title="Load into the composer">
                Use
              </button>
            )}
            {onEditExtend && done && !still && (
              <>
                <button type="button" onClick={() => onEditExtend("edit", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Change something inside this shot; everything else stays">Edit</button>
                <button type="button" onClick={() => onEditExtend("extend", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Continue this shot from its final frame">Extend</button>
              </>
            )}
            {done && (
              <span className="relative">
                <button type="button" onClick={() => setSaveMenu((v) => !v)} disabled={Boolean(saving)}
                  className="chip !py-1.5 !text-[13px] disabled:opacity-50" title="Keep this as a character, a location, a prop or a look">
                  {saving ?? "Save as…"}
                </button>
                {saveMenu && (
                  <span className="pop-surface absolute left-0 top-[calc(100%+6px)] z-10 block w-[220px]">
                    {([["character", "Character"], ["location", "Location"], ["prop", "Prop"], ["style", "Cast look"]] as const).map(([k, l]) => (
                      <button key={k} type="button" onClick={() => saveToCast(k)} className="menu-item">{l}</button>
                    ))}
                  </span>
                )}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {url && (
                <a href={downloadHref(url)} download={`${clipId(gen.id)}.${still ? "png" : "mp4"}`} title="Download the master"
                  className="theatre-icon"><IconDown /></a>
              )}
              <button type="button" onClick={remove} title="Delete" className="theatre-icon hover:!text-lift"><IconTrash /></button>
            </span>
          </div>

          <Review key={gen.id} genId={gen.id} state={gen.reviewState ?? ""} reviewBy={gen.reviewBy ?? null} onChanged={onChanged} />
        </div>
      </aside>
    </div>,
    document.body
  );
}
