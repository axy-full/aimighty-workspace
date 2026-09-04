"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { IconClose, IconSearch } from "./Icons";
import { Empty, Waiting } from "./ParticlMark";
import LazyMedia from "./LazyMedia";
import { getTask, sourceProblem } from "@/lib/tasks";
import type { Gen } from "./GenCard";

/**
 * Choose the clip an edit or an extension works on.
 *
 * Until now a source could only be set by finding a render, opening it and
 * pressing Edit — which is backwards if you already know you want to edit
 * something and are only looking for which. Picking the mode first is how
 * the work actually starts, so the composer needs its own way to go and get
 * a clip.
 *
 * Clips the vendor would refuse are shown, greyed, with the reason. Hiding
 * them would leave someone hunting for a render they can see on the wall and
 * cannot find here; the useful thing is to say why — and the commonest
 * reason is a surprise worth learning once, that a 1080p render is a legal
 * output and an illegal input.
 */
export default function SourcePicker({ task, onPick, onClose }: {
  task: "edit" | "extend";
  onPick: (gen: Gen) => void;
  onClose: () => void;
}) {
  const { selection } = useProject();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [allProjects, setAllProjects] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scoped = !allProjects && selection !== "all" && selection !== "unfiled";
  const { data, loading } = useApi<{ generations: Gen[] }>(
    `/api/jobs?kind=video&status=succeeded&limit=48&sync=0` +
    (scoped ? `&projectId=${encodeURIComponent(selection)}` : "") +
    (query ? `&q=${encodeURIComponent(query)}` : ""), 0
  );
  const clips = (data?.generations ?? []).filter((g) => g.storedUrl);
  const def = getTask(task);

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="sheet !max-w-[760px]" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Choose a clip">
        <header className="sheet-head">
          <span className="flex min-w-0 flex-col">
            <span className="text-[16px] font-semibold tracking-[-0.01em]">
              {task === "edit" ? "Which clip are you editing?" : "Which clip are you continuing?"}
            </span>
            <span className="text-[12.5px] text-mute">
              {task === "edit"
                ? "The output keeps its shape and length; only what you describe changes."
                : "The output picks up from its final frame."}
            </span>
          </span>
          <button type="button" onClick={onClose} className="ml-auto theatre-close" title="Close"><IconClose /></button>
        </header>

        <div className="sheet-body">
          <div className="flex flex-wrap items-center gap-2">
            <span className="relative flex min-w-[200px] flex-1 items-center">
              <span className="pointer-events-none absolute left-3 text-mute"><IconSearch /></span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by prompt or name"
                className="ctl !h-[36px] w-full !pl-9 !text-[14px]" />
            </span>
            {selection !== "all" && selection !== "unfiled" && (
              <button type="button" onClick={() => setAllProjects((v) => !v)}
                className={`chip !py-1.5 !text-[13px] ${allProjects ? "" : "bg-blue text-on-ink"}`}>
                {allProjects ? "All projects" : "This project"}
              </button>
            )}
          </div>

          {loading && !data ? (
            <div className="mt-4"><Waiting label="Reading the library" /></div>
          ) : clips.length === 0 ? (
            <div className="card mt-4">
              <Empty compact title="No finished clips here"
                line={query ? "Nothing matches that." : "Make a video first, then it can be edited."} />
            </div>
          ) : (
            <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
              {clips.map((g) => {
                const p = g.params as { resolution?: string; duration?: number };
                const problem = sourceProblem(def, p);
                return (
                  <button key={g.id} type="button" disabled={Boolean(problem)}
                    onClick={() => { onPick(g); onClose(); }}
                    title={problem ?? g.title ?? g.prompt}
                    className={`group text-left ${problem ? "cursor-not-allowed" : "card-link"}`}>
                    <span className={`relative block aspect-video w-full overflow-hidden rounded-[var(--r)] bg-thumb ${problem ? "opacity-40" : ""}`}>
                      <LazyMedia url={g.storedUrl!} kind="video" hoverPlay={!problem}
                        alt={g.prompt.slice(0, 80)} className="!absolute inset-0" />
                      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
                        {String(p.resolution ?? "").toUpperCase()}{p.duration ? ` · ${p.duration}s` : ""}
                      </span>
                    </span>
                    <span className="mt-1.5 block truncate text-[13px] font-medium">
                      {g.title || g.prompt.slice(0, 40)}
                    </span>
                    {problem
                      ? <span className="mt-0.5 block text-[11.5px] leading-snug text-lift">{problem}</span>
                      : <span className="mt-0.5 block truncate text-[11.5px] text-mute">{g.projectName ?? "Unfiled"}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
