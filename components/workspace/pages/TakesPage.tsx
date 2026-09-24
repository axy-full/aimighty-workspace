"use client";
import { useEffect, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { mediaBands } from "@/lib/workspace/format";
import { useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { usePageAction } from "@/lib/workspace/page-actions";
import { useWorkspace } from "@/lib/workspace/state";
import type { Take } from "@/lib/workspace/takes";
import type { LibFilter } from "@/lib/workspace/types";
import { Button } from "../ui";
import type { PageBodyProps } from "./registry";
import "@/app/workspace-assets.css";
import { VirtualItems } from "../VirtualItems";

/** Status dot + label under each card. Failed renders are not billed and say so. */
export function takeStatus(take: Pick<Take, "status" | "failedUnbilled">): { label: string; dot: string } {
  switch (take.status) {
    case "approved": return { label: "Approved", dot: "var(--pxw-green)" };
    case "picked": return { label: "Picked", dot: "var(--pxw-blue)" };
    case "changes": return { label: "Changes requested", dot: "var(--pxw-amber)" };
    case "review": return { label: "Review", dot: "var(--pxw-amber)" };
    case "rendering": return { label: "Rendering", dot: "var(--pxw-blue)" };
    case "failed": return { label: take.failedUnbilled ? "Failed · not billed" : "Failed", dot: "var(--pxw-red)" };
    default: return { label: "Source", dot: "var(--pxw-neutral-state)" };
  }
}

/** The mono cost cell: settled credits, dollars for a workspace billed in them, else a dash. */
export function takeCost(take: Pick<Take, "kind" | "credits" | "usd" | "failedUnbilled">): string {
  if (take.kind === "UPLOAD") return "—";
  if (take.credits != null) return `${take.credits.toLocaleString("en-US")} cr`;
  if (take.usd != null) return `$${take.usd.toFixed(2)}`;
  return "—";
}

/** Uploads are originals: the design badges them "orig", generations by version. */
export const versionLabel = (take: Pick<Take, "kind" | "version">) => (take.kind === "UPLOAD" ? "orig" : take.version);

export const matchesFilter = (take: Pick<Take, "kind">, filter: LibFilter) =>
  filter === "All" || (filter === "Uploads" ? take.kind === "UPLOAD" : take.kind === "GEN");

/** Real media when the browser can show it; the design's flat block otherwise. */
export function TakeMedia({ entry, hoverPlay = false }: { entry: LibraryEntry; hoverPlay?: boolean }) {
  if (entry.url && (entry.media === "image" || entry.media === "video"))
    return <LazyMedia url={entry.url} kind={entry.media} alt="" className="pxw-lazy" hoverPlay={hoverPlay && entry.media === "video"} />;
  const [top, bottom] = mediaBands(entry.take.id);
  return (
    <span className="pxw-flat" aria-hidden="true">
      <span style={{ background: top }} />
      <span style={{ background: bottom }} />
    </span>
  );
}

/** Takes — the whole project library: uploads and generations together. */
export function TakesPage({ project, scope }: PageBodyProps) {
  const { state, dispatch, syncUrl, toast } = useWorkspace();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const { items } = library;
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /* The shell's selection repair, arrow keys and subtitle read this list. */
  useEffect(() => {
    if (library.state.status !== "ready") return;
    dispatch({
      type: "lists",
      lists: { takes: items.map(({ take }) => ({ id: take.id, name: take.name, kind: take.kind === "UPLOAD" ? "upload" : "generation", credits: take.credits })) },
    });
  }, [items, library.state.status, dispatch]);

  usePageAction("takes", () => {
    if (!project) setProblem("Open a saved project before uploading.");
    else picker.current?.click();
  });

  const visible = items.filter((entry) => matchesFilter(entry.take, state.libFilter));

  /* Arrow keys move the selection; keep the card in view. */
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.selId) return;
    grid.current?.querySelector<HTMLElement>(`[data-take-id="${CSS.escape(state.selId)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [state.selId]);

  const select = (id: string) => {
    dispatch({ type: "patch", patch: { selKind: "take", selId: id, inspector: true } });
    syncUrl();
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setProblem(null);
    try {
      const count = await library.upload(files);
      if (count) toast(`${count.toLocaleString("en-US")} ${count === 1 ? "original" : "originals"} added to this project, stored byte-identical.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The upload could not be completed.");
    }
  };

  const { status, error, uploading, next, moreBusy } = library.state;
  const more = Boolean(next.uploads || next.generations);
  return (
    <div className="pxw-takes" data-page-body="takes">
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Upload originals to this project"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files);
        }}
      />
      {uploading ? (
        <p className="pxw-notice" role="status" data-testid="upload-progress">
          <span className="pxw-dot pxw-dot--pulse" style={{ background: "var(--pxw-blue)" }} aria-hidden="true" />
          {uploading} · originals are stored byte-identical
        </p>
      ) : null}
      {problem || (error && status === "ready") ? (
        <p className="pxw-notice pxw-notice--error" role="alert">{problem ?? error}</p>
      ) : null}
      {status === "error" ? (
        <div className="pxw-empty" role="alert">
          <p>{error}</p>
          <Button onClick={() => void library.refresh()}>Retry</Button>
        </div>
      ) : status !== "ready" ? (
        <p className="pxw-empty" role="status">{project ? "Loading the project library…" : "Open a project to see its library."}</p>
      ) : !items.length ? (
        <p className="pxw-empty">No uploads or generations in this project yet. Upload adds your originals, stored byte-identical.</p>
      ) : !visible.length ? (
        <p className="pxw-empty">{state.libFilter === "Uploads" ? "No uploads in this project yet." : "No generations in this project yet."}</p>
      ) : (
        <div ref={grid}>
        <VirtualItems
          className="pxw-take-grid" attrs={{ "data-testid": "take-grid" }}
          items={visible} getKey={(entry) => entry.take.id} layout={{ minColumnWidth: 230 }} gap={14} estimateRowHeight={210} scroll="ancestor"
          revealKey={state.selKind === "take" ? state.selId : null}
          renderItem={(entry) => {
            const { take } = entry;
            const s = takeStatus(take);
            const selected = state.selKind === "take" && state.selId === take.id;
            return (
              <button
                type="button"
                className="pxw-take-card"
                aria-pressed={selected}
                aria-label={`${take.name}, ${take.version}, ${take.kind === "GEN" ? "generation" : "upload"}`}
                data-take-id={take.id}
                data-kind={take.kind}
                onClick={() => select(take.id)}
              >
                <span className="pxw-take-media">
                  <TakeMedia entry={entry} hoverPlay />
                  <span className="pxw-take-version">{versionLabel(take)}</span>
                  <span className="pxw-take-kind" data-kind={take.kind}>{take.kind}</span>
                </span>
                <span className="pxw-take-body">
                  <span className="pxw-take-name">{take.name}</span>
                  <span className="pxw-take-meta">
                    <span>{take.meta}</span>
                    <span data-testid="take-cost">{takeCost(take)}</span>
                  </span>
                  <span className="pxw-take-status">
                    <span className="pxw-dot" style={{ background: s.dot }} aria-hidden="true" />
                    <span>{s.label}</span>
                  </span>
                </span>
              </button>
            );
          }}
        />
        </div>
      )}
      {status === "ready" && more ? (
        <Button variant="dashed" className="pxw-more" disabled={moreBusy} onClick={() => void library.more()}>
          {moreBusy ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
