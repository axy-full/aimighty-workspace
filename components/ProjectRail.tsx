"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { useOnChange } from "@/lib/changes";
import { useProject } from "@/lib/projectContext";
import { usd } from "@/lib/format";
import LazyMedia from "./LazyMedia";
import Boundary from "./Boundary";
import { IconChevron, IconPlus } from "./Icons";
import { appPrompt, appAlert } from "./dialog";
import type { Gen } from "./GenCard";

/**
 * The projects, always to hand.
 *
 * Everything the studio makes belongs to a project, but the projects lived
 * on their own screen — so using one meant leaving the room you were working
 * in. The rail keeps them beside the work: open one and its assets unroll
 * underneath, and any of them can be dragged straight into the prompt.
 *
 * It carries no state of its own. Selection is the same global selection the
 * composers already read, so opening a project here files the next render
 * there too, and the right-click menu comes for free: the rows carry the
 * same data attributes the Projects grid does, which is the whole contract
 * ContextMenu looks for.
 */

const DRAG_TYPE = "application/x-particl-asset";

/** What a dragged asset carries. Small on purpose: the drop only needs
 *  enough to attach it, and the composer re-reads the rest from the row. */
export type DraggedAsset = {
  kind: "gen";
  gen: Pick<Gen, "id" | "kind" | "storedUrl" | "sourceUrl" | "prompt" | "title" | "status" | "params" | "projectId">;
};

export default function ProjectRail() {
  const path = usePathname();
  const router = useRouter();
  const { projects, selection, setSelection, refreshProjects } = useProject();
  const [open, setOpen] = useState<string | null>(null);

  useOnChange(refreshProjects);

  // Only the open project's assets are fetched, and only once — a rail that
  // polled every project would cost more than the wall it sits beside.
  const { data, refresh } = useApi<{ generations: Gen[] }>(
    open ? `/api/jobs?projectId=${encodeURIComponent(open)}&limit=40&sync=0` : null, 0
  );
  useOnChange(refresh);
  const assets = data?.generations ?? [];

  async function create() {
    const name = await appPrompt("New project", "", "Project name");
    if (!name?.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Couldn't create the project", json.error); return; }
    refreshProjects();
    setSelection(json.id);
    setOpen(json.id);
  }

  function choose(id: string) {
    setSelection(id);
    setOpen((cur) => (cur === id ? null : id));
  }

  return (
    <aside className="rail" aria-label="Projects">
      <div className="rail-head">
        <span className="grouplabel !pb-0">Projects</span>
        <button type="button" onClick={create} className="ml-auto text-[12.5px] text-blue" title="New project">
          <IconPlus className="!h-3.5 !w-3.5" />
        </button>
      </div>

      <div className="rail-body">
        {projects.length === 0 && (
          <p className="px-3 py-2 text-[12.5px] leading-relaxed text-mute">
            No projects yet. Everything you make lands in Unfiled until there is one.
          </p>
        )}

        {projects.map((p) => {
          const isOpen = open === p.id;
          return (
            <div key={p.id} className="rail-group">
              {/* The row and its assets are SIBLINGS, not parent and child:
                  the right-click menu looks up a clip before a project, so a
                  tile nested inside the row would give a clip menu on the
                  row's own padding. */}
              <button type="button" onClick={() => choose(p.id)}
                data-project-target={p.id} data-project-name={p.name} data-project-count={p.genCount}
                className={`rail-row ${selection === p.id ? "is-on" : ""}`}
                title={`${p.genCount} render${p.genCount === 1 ? "" : "s"} · ${usd(p.spend, 2)}`}>
                <IconChevron className={`!h-3 !w-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-mute">{p.genCount}</span>
              </button>

              {isOpen && (
                <Boundary what="This project's assets" compact resetKey={p.id}>
                  <div className="rail-assets">
                    {assets.length === 0 ? (
                      <p className="px-2 py-1.5 text-[12px] text-mute">Nothing in here yet.</p>
                    ) : assets.map((g) => {
                      const url = g.storedUrl ?? g.sourceUrl;
                      const ready = g.status === "succeeded" && Boolean(url);
                      // Only a finished, visual render can be dropped into a
                      // prompt — the same two gates the server applies, so a
                      // doomed drop is impossible rather than merely refused.
                      const canDrag = ready && g.kind !== "audio";
                      return (
                        <span key={g.id}
                          draggable={canDrag}
                          onDragStart={(e) => {
                            const payload: DraggedAsset = {
                              kind: "gen",
                              gen: {
                                id: g.id, kind: g.kind, storedUrl: g.storedUrl, sourceUrl: g.sourceUrl,
                                prompt: g.prompt, title: g.title, status: g.status,
                                params: g.params, projectId: g.projectId,
                              },
                            };
                            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          data-gen-id={g.id} data-gen-prompt={g.prompt}
                          data-gen-label={g.title || g.id.slice(-6).toUpperCase()}
                          data-gen-title={g.title ?? ""}
                          title={g.title || g.prompt}
                          className={`rail-asset ${canDrag ? "is-draggable" : ""}`}>
                          {ready ? (
                            <LazyMedia url={url!} kind={g.kind === "image" ? "image" : g.kind === "audio" ? "image" : "video"}
                              alt="" className="!absolute inset-0" />
                          ) : (
                            <span className="grid h-full w-full place-items-center text-[9.5px] text-mute">
                              {g.status === "failed" ? "failed" : "…"}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </Boundary>
              )}
            </div>
          );
        })}
      </div>

      <div className="rail-foot">
        <Link href="/projects" className={`rail-link ${path === "/projects" ? "text-ink" : ""}`}>All projects</Link>
        {open && (
          <button type="button" onClick={() => router.push(`/projects/${open}/assets`)} className="rail-link">
            Open
          </button>
        )}
      </div>
    </aside>
  );
}

/** Read a rail drag out of a drop event, or null if it was something else. */
export function readDraggedAsset(e: React.DragEvent): DraggedAsset | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraggedAsset;
    return parsed?.kind === "gen" && parsed.gen?.id ? parsed : null;
  } catch {
    return null;   // a drag from somewhere else entirely
  }
}
