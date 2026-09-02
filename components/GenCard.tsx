"use client";

import { useState } from "react";
import { usd, timeAgo, downloadHref } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import { appConfirm } from "./dialog";
import LazyMedia from "./LazyMedia";
import { IconDown, IconTrash } from "./Icons";

export type Gen = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind?: "video" | "image";
  reviewState?: "" | "approved" | "changes";
  reviewBy?: string | null;
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  status: string;
  storedUrl: string | null;
  sourceUrl: string | null;
  totalTokens: number | null;
  costUsd: number | null;
  refineCostUsd?: number | null;
  error: string | null;
  authorName?: string | null;
  /** Shot filing, as returned by /api/jobs. */
  shotCode?: string | null;
  version?: number;
  task?: string;
  sourceGenId?: string | null;
  createdAt: number;
};

const STATUS: Record<string, { cls: string; label: string; live?: boolean }> = {
  queued:    { cls: "text-mute", label: "Queued",   live: true },
  running:   { cls: "text-blue", label: "Rendering", live: true },
  succeeded: { cls: "text-ok",   label: "Ready" },
  failed:    { cls: "text-lift", label: "Failed" },
  cancelled: { cls: "text-mute", label: "Cancelled" },
};

/** Short clip handle, the way a bin shows a shot name. */
const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

export default function GenCard({
  gen, projects = [], onChanged,
}: {
  gen: Gen;
  projects?: { id: string; name: string }[];
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const s = STATUS[gen.status] ?? STATUS.queued;
  const url = gen.storedUrl ?? gen.sourceUrl;
  const p = gen.params as { resolution?: string; ratio?: string; duration?: number };
  const done = gen.status === "succeeded" && url;
  const still = gen.kind === "image";

  async function move(projectId: string) {
    await fetch(`/api/jobs/${gen.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    onChanged?.();
  }

  async function remove() {
    if (!(await appConfirm(`Delete ${clipId(gen.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${gen.id}`, { method: "DELETE" });
    onChanged?.();
  }

  return (
    <article
      data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={clipId(gen.id)}
      className="group flex flex-col"
    >
      {/* The frame */}
      <div className="relative aspect-video overflow-hidden rounded-[var(--r)] bg-thumb shadow-[var(--shadow-card)] transition-transform duration-200 group-hover:-translate-y-1">
        {done ? (
          <LazyMedia url={url!} kind={still ? "image" : "video"} alt={gen.prompt.slice(0, 120)} />
        ) : (
          <div className="grid h-full place-items-center px-4">
            {gen.error ? (
              <p className="text-center text-[12px] leading-relaxed text-lift">
                {gen.error.slice(0, 150)}
              </p>
            ) : (
              <span className={`text-[13px] font-medium ${s.cls} ${s.live ? "render-sweep" : ""}`}>
                {s.label}…
              </span>
            )}
          </div>
        )}

        {gen.reviewState === "approved" && (
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-ok px-2 py-0.5 text-[10.5px] font-semibold text-white">
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
            {still ? String(p.resolution ?? "").toUpperCase() : `${p.duration ?? "—"}s`}
          </span>
        )}

        <span className="reveal absolute bottom-2 right-2 flex items-center gap-1.5">
          {url && (
            <a href={downloadHref(url)} download={`${clipId(gen.id)}.${still ? "png" : "mp4"}`} title="Download"
              className="grid h-8 w-8 place-items-center rounded-full bg-panel/85 text-bone shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:bg-panel">
              <IconDown />
            </a>
          )}
          <button onClick={remove} title="Delete"
            className="grid h-8 w-8 place-items-center rounded-full bg-panel/85 text-bone shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:bg-panel hover:text-lift">
            <IconTrash />
          </button>
        </span>
      </div>

      {/* What it is */}
      <p
        onClick={() => setOpen(!open)}
        title="Click to expand"
        className={`mt-2.5 cursor-pointer text-[14px] leading-snug text-bone ${open ? "" : "line-clamp-2"}`}
      >
        {gen.prompt}
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-mute">
        <span>{shortLabel(gen.model)}</span>
        {p.resolution && <span>· {String(p.resolution).toUpperCase()}</span>}
        {gen.costUsd != null && (
          <span className="font-medium text-dim" title={gen.refineCostUsd ? "includes prompt refinement" : undefined}>
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
