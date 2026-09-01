"use client";

/**
 * R3 — the canvas screen: the board plus the rail of things you can put on it.
 *
 * The rail is deliberately the project's own renders and reference uploads,
 * not a file browser. What goes on the wall is what the project made.
 */
import { use, useCallback, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import Canvas, { type CanvasItem } from "@/components/Canvas";
import LazyMedia from "@/components/LazyMedia";
import { useRouter } from "next/navigation";

type Job = {
  id: string; status: string; storedUrl: string | null; kind: "video" | "image";
  prompt: string; version: number; shotCode: string | null; shotScene: string | null;
};
type Project = { id: string; name: string };

export default function CanvasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [railOpen, setRailOpen] = useState(true);

  const { data, refresh } = useApi<{ items: CanvasItem[] }>(
    `/api/canvas?projectId=${encodeURIComponent(id)}`, 5000);
  const { data: jobs } = useApi<{ generations: Job[] }>(
    `/api/jobs?projectId=${encodeURIComponent(id)}&limit=60&sync=0`, 20000);
  const { data: projects } = useApi<{ projects: Project[] }>("/api/projects", 60000);

  const items = data?.items ?? [];
  const onBoard = new Set(items.map((i) => i.refId).filter(Boolean));
  const project = projects?.projects.find((p) => p.id === id);

  const add = useCallback(async (genId: string) => {
    // Drop new cards into open space rather than on top of each other.
    const n = items.length;
    await fetch("/api/canvas", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: id, kind: "generation", refId: genId,
        x: 40 + (n % 5) * 300, y: 40 + Math.floor(n / 5) * 250,
      }),
    });
    refresh();
  }, [id, items.length, refresh]);

  /** "Use assets directly from the canvas for subsequent generations." */
  const use_ = useCallback((genId: string, prompt: string) => {
    try { window.localStorage.setItem("aw_compose_seed", prompt); } catch { /* private mode */ }
    router.push("/generate");
  }, [router]);

  const available = (jobs?.generations ?? []).filter(
    (j) => j.status === "succeeded" && j.storedUrl && !onBoard.has(j.id));

  return (
    <div className="fixed inset-0 top-[var(--topbar)] flex"
         style={{ bottom: "var(--tabbar)" }}>
      <div className="relative min-w-0 flex-1">
        <Canvas projectId={id} items={items} onChanged={refresh} onUse={use_} />
      </div>

      {/* The rail of things not yet on the wall */}
      <aside className={`${railOpen ? "w-[240px]" : "w-[44px]"} flex flex-col border-l border-hair bg-panel transition-[width]`}>
        <button onClick={() => setRailOpen((v) => !v)}
          className="flex h-11 shrink-0 items-center gap-2 px-3 text-[13px] text-dim">
          {railOpen ? <>Renders <span className="ml-auto">›</span></> : "‹"}
        </button>
        {railOpen && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <p className="mb-2 text-[12px] text-mute">
              {project?.name ?? "This project"} · click to pin
            </p>
            {available.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-mute">
                Everything delivered is already on the board.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {available.map((j) => (
                  <button key={j.id} onClick={() => add(j.id)}
                    className="overflow-hidden rounded-[var(--r-sm)] bg-thumb text-left">
                    <div className="aspect-video w-full">
                      <LazyMedia url={j.storedUrl!} kind={j.kind}
                        className="h-full w-full object-cover" alt={j.prompt} />
                    </div>
                    <p className="line-clamp-2 px-2 py-1.5 text-[11px] text-dim">
                      {j.shotCode ? `${j.shotCode} v${j.version} · ` : ""}{j.prompt}
                    </p>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-4 text-center text-[12px] text-mute">
              <Link href={`/projects/${id}`} className="text-blue">Project overview</Link>
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
