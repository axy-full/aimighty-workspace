"use client";
import { useEffect, useMemo, useState } from "react";
import type { BoardHistoryEntry, HistoryWho } from "@/lib/board/history";
import { draftRequest } from "@/lib/workbench/draft-request";
import LazyMedia from "@/components/LazyMedia";
import { nodeRole } from "@/lib/board/regions";
import type { MediaJob } from "@/lib/workbench/job-recovery";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { Glyph } from "../Rail";

/*
 * The rail's two drawers (README § 1.1, frames o and p): 280 px beside the rail, over the canvas, closed by default.
 * Library: the project's files as two-column tiles, filtered All · Images · Video · Audio · Cast; a tile drags onto a
 * shot to become its reference. History: what happened on the board, newest first: who changed it, and the renders.
 */
function Drawer({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  return (
    <aside className="bd-drawer" aria-label={title} data-testid={testId}>
      <div className="bd-drawer-head">
        <strong>{title}</strong>
        <button type="button" className="bd-drawer-close" aria-label={`Close ${title}`} onClick={onClose}>×</button>
      </div>
      {children}
    </aside>
  );
}

const FILTERS = ["All", "Images", "Video", "Audio", "Cast"] as const;
type Filter = (typeof FILTERS)[number];

export function LibraryDrawer({ items, project, onClose }: { items: readonly LibraryEntry[]; project: Project; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>("All");
  /* Cast: the files the board's cast, environment and element cards stand for. */
  const cast = useMemo(() => {
    const ids = new Set<string>();
    for (const node of project.nodes) {
      if (nodeRole(node, project.nodes, project).kind !== "cast" || !node.assetId) continue;
      const asset = project.assets.find((a) => a.id === node.assetId);
      for (const id of [asset?.id, asset?.generationId, asset?.uploadId]) if (id) ids.add(id);
    }
    return ids;
  }, [project]);
  const shown = items.filter((entry) => filter === "All" ? true
    : filter === "Images" ? entry.media === "image" : filter === "Video" ? entry.media === "video" : filter === "Audio" ? entry.media === "audio"
    : cast.has(entry.take.sourceId));
  return (
    <Drawer title="Library" onClose={onClose} testId="board-library">
      <div className="bd-drawer-chips" role="group" aria-label="Show">
        {FILTERS.map((f) => <button key={f} type="button" className="bd-drawer-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      <div className="bd-drawer-grid">
        {shown.length ? shown.map((entry) => (
          <div key={entry.take.id} className="bd-tile" draggable title={`${entry.take.name} · drag onto a shot to use it as a reference`}
            onDragStart={(e) => { e.dataTransfer.setData("text/plain", entry.take.id); e.dataTransfer.effectAllowed = "copy"; }}>
            <span className="bd-tile-media">
              {entry.media === "video" && entry.url ? <LazyMedia url={entry.url} kind="video" preview={false} />
                /* eslint-disable-next-line @next/next/no-img-element */
                : entry.media === "image" && entry.url ? <img src={entry.url} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
            </span>
            <span className="bd-tile-name">{entry.take.name}</span>
            <span className="bd-tile-meta">{entry.take.meta}</span>
          </div>
        )) : <p className="bd-drawer-empty">{items.length ? "Nothing here with this filter." : "Nothing in the Library yet."}</p>}
      </div>
    </Drawer>
  );
}

const DONE: Record<string, string> = { succeeded: "rendered", failed: "failed", cancelled: "stopped", held: "waits for an approval" };
const time = (at: number | undefined) => (at ? new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
type Row = { id: string; at: number; who: HistoryWho | null; text: string; card: string | null };

/**
 * What happened on the board, newest first: the canvas's own changes with who made them (the team-canvas GET
 * `history=1`, people only) and the renders the board follows. A row opens the card it is about, when it is still there.
 */
export function HistoryDrawer({ scope, productionId, jobs, project, onClose, onOpen }: {
  scope: string; productionId: string | null; jobs: readonly MediaJob[]; project: Project; onClose: () => void; onOpen: (cardId: string) => void;
}) {
  const [logged, setLogged] = useState<{ pid: string; entries: BoardHistoryEntry[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!productionId) return;
    let live = true;
    draftRequest<{ history?: BoardHistoryEntry[] }>(`/api/workbench/team-canvas?productionId=${encodeURIComponent(productionId)}&history=1`, scope)
      .then((answer) => { if (live) { setLogged({ pid: productionId, entries: Array.isArray(answer.history) ? answer.history : [] }); setFailed(null); } })
      .catch(() => { if (live) setFailed(productionId); });
    return () => { live = false; };
  }, [productionId, scope, attempt]);
  const byShot = useMemo(() => new Map(Object.entries(project.shotMappings ?? {}).map(([nodeId, shotId]) => [shotId, nodeId])), [project.shotMappings]);
  const renders: Row[] = jobs.map((job) => {
    const nodeId = job.shotId ? byShot.get(job.shotId) ?? null : null;
    const name = job.title || (nodeId ? project.nodes.find((n) => n.id === nodeId)?.title : null) || "A take";
    return { id: `job:${job.id}`, at: job.createdAt ?? 0, who: null, text: `${name} ${DONE[job.status] ?? "rendering"}`, card: nodeId };
  });
  const changes: Row[] = logged && logged.pid === productionId ? logged.entries : [];
  const rows = [...changes, ...renders].sort((a, b) => b.at - a.at).slice(0, 120);
  const onBoard = new Set(project.nodes.map((n) => n.id));
  return (
    <Drawer title="History" onClose={onClose} testId="board-history">
      <div className="bd-drawer-list">
        {failed === productionId ? (
          <p className="bd-drawer-empty">History could not be read. <button type="button" className="bd-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
        ) : null}
        {rows.length ? rows.map((row) => {
          const card = row.card && onBoard.has(row.card) ? row.card : null;
          return (
            <button key={row.id} type="button" className="bd-history-row" disabled={!card} onClick={() => card && onOpen(card)}>
              <span className="bd-history-who" data-who={row.who?.kind ?? "render"} aria-hidden="true">{row.who ? row.who.initials : <Glyph d="M2 4h8v8H2zM10 7l4-2v6l-4-2" />}</span>
              <span className="bd-history-what">
                <span>{row.who?.kind === "person" ? `${row.who.name} · ` : ""}{row.text}</span>
                <span className="bd-history-when">{time(row.at)}</span>
              </span>
            </button>
          );
        }) : failed === productionId ? null : <p className="bd-drawer-empty">Nothing yet.</p>}
      </div>
    </Drawer>
  );
}
