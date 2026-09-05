"use client";

import { usd, timeAgo, downloadHref } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import { appConfirm } from "./dialog";
import LazyMedia from "./LazyMedia";
import { ParticlSpinner } from "./ParticlMark";
import { IconDown, IconTrash, IconAudio } from "./Icons";

export type Gen = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind?: "video" | "image" | "audio";
  reviewState?: "" | "approved" | "picked" | "changes";
  reviewBy?: string | null;
  model: string;
  prompt: string;
  /** The name the team gave it, shown in place of the clip id. */
  title?: string | null;
  params: Record<string, unknown>;
  status: string;
  storedUrl: string | null;
  sourceUrl: string | null;
  totalTokens: number | null;
  costUsd: number | null;
  /** The prompt writer's share, and who wrote it. */
  refineCostUsd?: number | null;
  refineModel?: string | null;
  refineInTokens?: number | null;
  refineOutTokens?: number | null;
  error: string | null;
  authorName?: string | null;
  /** Shot filing, as returned by /api/jobs. */
  shotCode?: string | null;
  version?: number;
  task?: string;
  sourceGenId?: string | null;
  createdAt: number;
};

/** Short clip handle, the way a bin shows a shot name. */
const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

/**
 * A render on a library shelf: the frame plays on approach and opens the
 * theatre on a click; the prompt and the ledger line sit under it.
 */
export default function GenCard({
  gen, projects = [], onChanged, onOpen,
}: {
  gen: Gen;
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
  onOpen?: () => void;
}) {
  const url = gen.storedUrl ?? gen.sourceUrl;
  const p = gen.params as { resolution?: string; ratio?: string; duration?: number };
  const done = gen.status === "succeeded" && Boolean(url);
  const live = gen.status === "queued" || gen.status === "running";
  const still = gen.kind === "image";
  const audio = gen.kind === "audio";

  async function move(projectId: string) {
    await fetch(`/api/jobs/${gen.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    onChanged?.();
  }

  async function remove() {
    if (!(await appConfirm(`Delete ${gen.title || clipId(gen.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${gen.id}`, { method: "DELETE" });
    onChanged?.();
  }

  return (
    <article
      data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)}
      data-gen-title={gen.title ?? ""}
      className="group flex flex-col"
    >
      {/* The frame */}
      <div
        role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined}
        onClick={onOpen}
        onKeyDown={(e) => {
          // The download link and delete button inside the frame keep their
          // own Enter/Space; only the frame itself opens the theatre.
          if (e.target !== e.currentTarget) return;
          if (onOpen && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); }
        }}
        className={`tile aspect-video ${live ? "tile-live" : ""} ${gen.status === "failed" ? "tile-failed" : ""} ${onOpen ? "cursor-pointer" : ""}`}
      >
        {done && audio ? (
          <span className="tile-face tile-audio">
            <IconAudio className="!h-6 !w-6 text-dim" />
            <audio controls preload="none" src={url!} className="mt-2 h-9 w-[88%]" onClick={(e) => e.stopPropagation()} />
          </span>
        ) : done ? (
          <LazyMedia url={url!} kind={still ? "image" : "video"} hoverPlay alt={gen.prompt.slice(0, 120)} className="!absolute inset-0" />
        ) : (
          <span className="tile-face">
            {live && <ParticlSpinner size={24} className="text-dim" />}
            <span className={`tile-face-label ${live ? "" : "text-lift"}`}>
              {live ? (gen.status === "queued" ? "Queued…" : "Rendering…") : gen.status === "cancelled" ? "Cancelled" : "Failed"}
            </span>
            {gen.error && <span className="tile-face-error">{gen.error.slice(0, 150)}</span>}
          </span>
        )}

        {gen.reviewState === "approved" && (
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-ok px-2 py-0.5 text-[10.5px] font-semibold text-on-ink">
            ✓ Approved
          </span>
        )}
        {gen.reviewState === "changes" && (
          <span className="absolute left-2 top-2 rounded-full bg-warn px-2 py-0.5 text-[10.5px] font-semibold text-white">
            Changes
          </span>
        )}
        {done && (
          <span className="absolute right-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[10.5px] font-medium text-white backdrop-blur-sm">
            {audio ? shortLabel(gen.model) : still ? String(p.resolution ?? "").toUpperCase() : `${p.duration ?? "—"}s`}
          </span>
        )}

        <span className="reveal absolute bottom-2 right-2 flex items-center gap-1.5">
          {url && (
            <a href={downloadHref(url)} download={`${clipId(gen.id)}.${still ? "png" : audio ? "mp3" : "mp4"}`} title="Download"
              onClick={(e) => e.stopPropagation()}
              className="grid h-8 w-8 place-items-center rounded-full bg-panel/85 text-bone shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:bg-panel">
              <IconDown />
            </a>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); remove(); }} title="Delete"
            className="grid h-8 w-8 place-items-center rounded-full bg-panel/85 text-bone shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:bg-panel hover:text-lift">
            <IconTrash />
          </button>
        </span>
      </div>

      {/* What it is */}
      <p className="mt-2.5 line-clamp-2 text-[14px] leading-snug text-bone" title={gen.prompt}>
        {gen.title
          ? <span className="mr-1.5 font-semibold">{gen.title}</span>
          : gen.shotCode && <span className="mr-1.5 font-semibold">{gen.shotCode} v{gen.version ?? 1}</span>}
        {gen.prompt}
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-mute">
        <span>{shortLabel(gen.model)}</span>
        {p.resolution && <span>· {String(p.resolution).toUpperCase()}</span>}
        {gen.costUsd != null && (
          <span className="font-medium text-dim"
            title={gen.refineModel
              ? `Render ${usd(gen.costUsd)} + prompt ${gen.refineCostUsd ? usd(gen.refineCostUsd) : "free"}`
              : `Render ${usd(gen.costUsd)} · prompt as written`}>
            · {usd(gen.costUsd + (gen.refineCostUsd ?? 0), 2)}
          </span>
        )}
        <span>· {timeAgo(gen.createdAt)}</span>
        {gen.authorName && <span>· {gen.authorName}</span>}
      </div>

      {projects.length > 0 && (
        <select
          value={gen.projectId ?? ""}
          onChange={(e) => move(e.target.value)}
          title="Move to project"
          className="reveal mt-1.5 h-7 w-fit max-w-full rounded-full bg-panel2 px-2 text-[12px] text-dim"
        >
          <option value="">Unfiled</option>
          {projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
        </select>
      )}
    </article>
  );
}
