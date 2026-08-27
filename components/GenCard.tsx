"use client";

import { useState } from "react";
import { usd, compactTokens, timeAgo, posterSrc } from "@/lib/format";
import { appConfirm } from "./dialog";
import { IconDown, IconTrash } from "./Icons";

export type Gen = {
  id: string;
  projectId: string | null;
  projectName: string | null;
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
  createdAt: number;
};

const STATUS: Record<string, { cls: string; label: string; live?: boolean }> = {
  queued:    { cls: "text-mute", label: "QUEUED",  live: true },
  running:   { cls: "text-run",  label: "RENDER",  live: true },
  succeeded: { cls: "text-ok",   label: "OK" },
  failed:    { cls: "text-lift", label: "FAILED" },
  cancelled: { cls: "text-mute", label: "CANCELLED" },
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

  async function move(projectId: string) {
    await fetch(`/api/jobs/${gen.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    onChanged?.();
  }

  async function remove() {
    if (!(await appConfirm(`Delete clip ${clipId(gen.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${gen.id}`, { method: "DELETE" });
    onChanged?.();
  }

  return (
    <article
      data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={clipId(gen.id)}
      className="group flex flex-col overflow-hidden rounded-[var(--r)] border border-line bg-panel transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-red/60"
    >
      {/* Slate */}
      <div className="relative aspect-video bg-thumb">
        {done ? (
          <video src={posterSrc(url!)} controls loop preload="metadata" playsInline className="h-full w-full object-cover" />
        ) : (
          <div className={`desk-grid grid h-full place-items-center px-4 ${s.live ? "render-sweep" : ""}`}>
            {gen.error ? (
              <p className="text-center font-mono text-[9.5px] leading-relaxed text-lift/85">
                {gen.error.slice(0, 150)}
              </p>
            ) : (
              <span className={`font-mono text-[10px] tracking-[.2em] ${s.cls}`}>{s.label}</span>
            )}
          </div>
        )}
        <span className="pointer-events-none absolute right-2 top-2 rounded-[5px] bg-black/60 px-1.5 py-px font-mono text-[9px] text-white">
          {gen.model.includes("2-5") ? "2.5" : "2.0"}
        </span>
        <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-[5px] bg-black/60 px-1.5 py-px font-mono text-[9px] text-white/85">
          {s.live && <span className="lamp lamp-live" style={{ width: 5, height: 5 }} />}
          {clipId(gen.id)}
        </span>
      </div>

      {/* Metadata */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p
          onClick={() => setOpen(!open)}
          title="Click to expand"
          className={`cursor-pointer text-[12px] leading-[1.5] text-bone/85 ${open ? "" : "line-clamp-2"}`}
        >
          {gen.prompt}
        </p>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9.5px] text-mute">
          {p.resolution && <span className="text-dim">{p.resolution}</span>}
          {p.ratio && <span>{p.ratio}</span>}
          {p.duration != null && <span>{p.duration}s</span>}
          {gen.totalTokens != null && <span>{compactTokens(gen.totalTokens)}t</span>}
          {gen.costUsd != null && (
            <span className="text-lift" title={gen.refineCostUsd ? "includes prompt refinement" : undefined}>
              {usd(gen.costUsd + (gen.refineCostUsd ?? 0))}
            </span>
          )}
        </div>

        <div className="mt-auto flex items-center gap-2 border-t border-hair pt-2 font-mono text-[9.5px] text-mute">
          <span className="whitespace-nowrap">{timeAgo(gen.createdAt)}</span>
          {gen.authorName && (
            <span className="shrink-0 whitespace-nowrap text-dim">{gen.authorName}</span>
          )}
          {gen.projectName && (
            <span className="min-w-0 truncate rounded-[5px] bg-chip px-1.5 py-px text-dim">
              {gen.projectName}
            </span>
          )}

          <div className="reveal ml-auto flex shrink-0 items-center gap-1">
            {projects.length > 0 && (
              <select
                value={gen.projectId ?? ""}
                onChange={(e) => move(e.target.value)}
                title="Move to project"
                className="h-[22px] max-w-[92px] rounded-[6px] border border-line bg-chip px-1 text-[9.5px] text-dim max-[860px]:h-[28px]"
              >
                <option value="">Unfiled</option>
                {projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            )}
            {url && (
              <a
                href={url} download={`${clipId(gen.id)}.mp4`} title="Download"
                className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-line text-dim hover:border-lift hover:text-lift max-[860px]:h-[28px] max-[860px]:w-[28px]"
              >
                <IconDown />
              </a>
            )}
            <button
              onClick={remove} title="Delete"
              className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-line text-dim hover:border-lift hover:text-lift max-[860px]:h-[28px] max-[860px]:w-[28px]"
            >
              <IconTrash />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
