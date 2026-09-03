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
import { appConfirm } from "./dialog";
import { usd, timeAgo, downloadHref, compactTokens } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import { prettyModel } from "@/lib/enhance";
import { IconClose, IconArrowLeft, IconArrowRight, IconDown, IconTrash, IconCopy } from "./Icons";

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
  const title = gen.shotCode ? `${gen.shotCode} · v${gen.version ?? 1}` : clipId(gen.id);

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

  return createPortal(
    <div className="theatre" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="theatre-stage" onClick={(e) => e.stopPropagation()}
        data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={clipId(gen.id)}>
        {done ? (
          still ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={gen.id} src={url!} alt={gen.prompt.slice(0, 120)} className="theatre-media" />
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
            <p className="truncate text-[16px] font-semibold tracking-[-0.01em]">{title}</p>
            <p className="text-[12.5px] text-mute">
              {gen.projectName ?? "Unfiled"}{gen.authorName ? ` · ${gen.authorName}` : ""} · {timeAgo(gen.createdAt)}
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
