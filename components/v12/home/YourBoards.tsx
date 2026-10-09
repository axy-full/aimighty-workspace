"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import LazyMedia from "@/components/LazyMedia";
import { posterOf } from "@/components/graphite/icons";
import { useProjectCards, useProjectCover, type ProjectCardModel } from "@/components/graphite/home/use-project-cards";
import type { ProjectSummary } from "@/lib/workspace/data";
import { BOARD_FILTERS, FIRST_BOARDS, filterBoards, type BoardFilter } from "@/lib/v12/home";

/** A card's picture: its board's newest take once it nears the screen (today's cover read), else a swatch. */
function Cover({ scope, id, name }: { scope: string; id: string; name: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { const t = setTimeout(() => setNear(true), 0); return () => clearTimeout(t); }
    const seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); seen.disconnect(); } }, { rootMargin: "240px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const cover = useProjectCover(scope, id, near);
  const swatch = posterOf(name);
  return (
    <span className="v12-hm-board-cover" ref={box} data-cover={cover ? cover.kind : "swatch"}
      style={cover ? undefined : ({ "--v12-from": swatch.from, "--v12-to": swatch.to } as CSSProperties)}>
      {cover ? <LazyMedia url={cover.url} kind={cover.kind} alt="" name={cover.name} className="v12-hm-board-media" /> : null}
    </span>
  );
}

function BoardCard({ scope, card, disabled, onOpen }: { scope: string; card: ProjectCardModel; disabled: boolean; onOpen: (id: string) => void }) {
  const line = card.line ?? (card.meta ? { text: card.meta, tone: "quiet" as const } : null);
  return (
    <li>
      <button type="button" className="v12-hm-board" disabled={disabled} onClick={() => onOpen(card.id)} title={`Open ${card.name}`} data-testid="v12-home-board" data-board={card.id}>
        <Cover scope={scope} id={card.id} name={card.name} />
        <span className="v12-hm-board-name">{card.name}</span>
        {line ? <span className="v12-hm-board-state" data-tone={line.tone}><span className="v12-hm-dot" data-tone={line.tone} aria-hidden="true" />{line.text}</span> : null}
      </button>
    </li>
  );
}

/**
 * Your boards (docs/redesign/inventory.md § 5.9 · 3): this person's boards, newest save first, with kind filters (All ·
 * Films · Campaigns · Social), each card its picture, name and what waits in it; "+ New board" makes an empty one on
 * today's create path.
 */
export function YourBoards({ scope, projects, status, error, onRetry, now, approvals, disabled, onOpen, onNew }: {
  scope: string;
  projects: readonly ProjectSummary[];
  status: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  now: number;
  approvals: ReadonlyMap<string, number> | null;
  disabled: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [all, setAll] = useState(false);
  const listed = filterBoards(projects, filter);
  const cards = useProjectCards(listed, now, approvals);
  const shown = all ? cards : cards.slice(0, FIRST_BOARDS);
  return (
    <section className="v12-hm-boards" aria-labelledby="v12-hm-boards-title" data-testid="v12-home-boards">
      <div className="v12-hm-boards-head">
        <h2 className="v12-hm-section-title" id="v12-hm-boards-title">Your boards</h2>
        <span className="v12-hm-filters" role="group" aria-label="Board kind">
          {BOARD_FILTERS.map((f) => (
            <button key={f.id} type="button" className="v12-hm-filter" aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setAll(false); }}
              data-testid="v12-home-board-filter" data-value={f.id}>{f.label}</button>
          ))}
        </span>
        <span className="v12-hm-grow" />
        <button type="button" className="v12-hm-link" onClick={onNew} disabled={disabled} data-testid="v12-home-new-board">+ New board</button>
      </div>
      <div className="v12-hm-boards-body">
        {status === "error" ? (
          <p className="v12-hm-quiet" role="alert">{error ?? "Your boards could not be read."} <button type="button" className="v12-hm-link" onClick={onRetry}>Try again</button></p>
        ) : status === "loading" && !projects.length ? (
          <p className="v12-hm-quiet">Reading your boards…</p>
        ) : !shown.length ? (
          <p className="v12-hm-quiet" data-testid="v12-home-boards-empty">{filter === "all" ? "No boards yet. Start one with the bar below, or make an empty one with + New board." : "No boards of this kind yet."}</p>
        ) : (
          <ul className="v12-hm-board-grid">
            {shown.map((card) => <BoardCard key={card.id} scope={scope} card={card} disabled={disabled} onOpen={onOpen} />)}
          </ul>
        )}
        {!all && cards.length > FIRST_BOARDS ? (
          <button type="button" className="v12-hm-link v12-hm-show-all" onClick={() => setAll(true)} data-testid="v12-home-boards-all">Show all {cards.length.toLocaleString("en-US")}</button>
        ) : null}
      </div>
    </section>
  );
}
