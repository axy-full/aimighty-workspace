"use client";
import { SampleClipCredit } from "@/components/ui/SampleClipCredit";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import LazyMedia from "@/components/LazyMedia";
import { posterOf } from "@/components/graphite/icons";
import { useProjectCards, useProjectCover, type ProjectCardModel } from "@/components/graphite/home/use-project-cards";
import type { ProjectSummary } from "@/lib/workspace/data";
import { BOARD_FILTERS, FIRST_BOARDS, filterBoards, type BoardFilter } from "@/lib/v12/home";
import { useBoardKinds } from "./use-board-kinds";
import { useTeamBoards } from "./use-team-boards";
import { menuFor } from "@/lib/v12/menus";
import { ContextMenu, useToast, type MenuItem } from "../ui";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { SHARE_TEAM } from "@/lib/workbench/view-only";
import { isSampleDraftId } from "@/lib/demo/sample";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { copyBoardLink, menuItems, useMenuAt } from "../menus/menu-items";
import { FitText } from "./FitText";

/** A card's picture: its board's newest take once it nears the screen (today's cover read), else a swatch. */
/* `onCover` tells the card which picture it drew, so the sample clip's credit can stand beside the card (a link cannot sit inside its button). */
function Cover({ scope, id, name, onCover }: { scope: string; id: string; name: string; onCover?: (url: string | null) => void }) {
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
  const coverUrl = cover?.url ?? null;
  useEffect(() => { onCover?.(coverUrl); }, [coverUrl, onCover]);
  const swatch = posterOf(name);
  return (
    <span className="v12-hm-board-cover" ref={box} data-cover={cover ? cover.kind : "swatch"}
      style={cover ? undefined : ({ "--v12-from": swatch.from, "--v12-to": swatch.to } as CSSProperties)}>
      {cover ? <LazyMedia url={cover.url} kind={cover.kind} alt="" name={cover.name} className="v12-hm-board-media" /> : null}
    </span>
  );
}

function BoardCard({ scope, card, disabled, onOpen, onMenu }: { scope: string; card: ProjectCardModel; disabled: boolean; onOpen: (id: string) => void; onMenu: (event: MouseEvent, id: string) => void }) {
  const line = card.line ?? (card.meta ? { text: card.meta, tone: "quiet" as const } : null);
  const [pic, setPic] = useState<string | null>(null);
  return (
    <li>
      <button type="button" className="v12-hm-board" disabled={disabled} onClick={() => onOpen(card.id)} title={`Open ${card.name}`} aria-label={line ? `${card.name} · ${line.text}` : card.name} data-testid="v12-home-board" data-board={card.id}
        onContextMenu={(e) => onMenu(e, card.id)}>
        <Cover scope={scope} id={card.id} name={card.name} onCover={setPic} />
        <FitText className="v12-hm-board-name" text={card.name} />
        {line ? <span className="v12-hm-board-state" data-tone={line.tone}><span className="v12-hm-dot" data-tone={line.tone} aria-hidden="true" />{line.text}</span> : null}
      </button>
      {pic ? <SampleClipCredit take={pic} className="v12-hm-credit" /> : null}
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
  const kinds = useBoardKinds(scope, projects);
  const listed = filterBoards(projects.map((p) => ({ ...p, kind: kinds.get(p.id) ?? p.kind })), filter);
  const cards = useProjectCards(listed, now, approvals);
  /* The workspace's other members' boards, to look at (view-only): under this person's own, with their makers' names. */
  const { boards: team, mineShared } = useTeamBoards(scope, projects.map((p) => `${p.id}:${p.revision ?? ""}`).join(","));
  const teamListed = filterBoards(team.map((b) => ({ ...b.summary })), filter);
  const teamCards = useProjectCards(teamListed, now, null);
  const makers = new Map(team.map((b) => [b.summary.id, b.owner]));
  const shown = all ? cards : cards.slice(0, FIRST_BOARDS);
  /* A board card's right-click menu (redesign A3): Open, as a click does, and Copy link, as the tab menu's. */
  const toast = useToast();
  const boardMenu = useMenuAt<string>();
  /* Share with team: the author's own boards only; saved at once, with Undo. What was just flipped shows before the list is read again. */
  const fetcher = useScopedFetch(scope);
  /* A sample board, or any board of the sample workspace, is nobody's to share (the ⋯ menu leaves the item out the same way). */
  const spendOff = useSampleWorkspace();
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isShared = (id: string) => flipped.get(id) ?? mineShared.has(id);
  const setShared = async (id: string, to: boolean): Promise<boolean> => {
    const reply = await fetcher("/api/workbench/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "team-share", projectId: id, shared: to }) }).catch(() => null);
    if (!reply?.ok) { toast({ text: "Sharing was not changed. Try again." }); return false; }
    setFlipped((now) => new Map(now).set(id, to));
    return true;
  };
  const toggleShare = async (id: string) => {
    const to = !isShared(id);
    if (await setShared(id, to)) toast({ text: to ? SHARE_TEAM.shared : SHARE_TEAM.stopped, action: { label: "Undo", run: () => void setShared(id, !to) } });
  };
  const menuCard = boardMenu.menu ? cards.find((c) => c.id === boardMenu.menu!.target) ?? null : null;
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
            {shown.map((card) => <BoardCard key={card.id} scope={scope} card={card} disabled={disabled} onOpen={onOpen} onMenu={boardMenu.open} />)}
          </ul>
        )}
        {!all && cards.length > FIRST_BOARDS ? (
          <button type="button" className="v12-hm-link v12-hm-show-all" onClick={() => setAll(true)} data-testid="v12-home-boards-all">Show all {cards.length.toLocaleString("en-US")}</button>
        ) : null}
      </div>
      {teamCards.length ? (
        <div className="v12-hm-boards-body" data-testid="v12-home-team-boards">
          <h3 className="v12-hm-section-title v12-hm-team-title" id="v12-hm-team-title">Teammates’ boards</h3>
          <ul className="v12-hm-board-grid" aria-labelledby="v12-hm-team-title">
            {teamCards.map((card) => (
              <BoardCard key={card.id} scope={scope} disabled={disabled} onOpen={onOpen} onMenu={() => undefined}
                card={{ ...card, line: { text: `${makers.get(card.id) ?? "A teammate"}’s board · view only`, tone: "quiet" } }} />
            ))}
          </ul>
        </div>
      ) : null}
      {boardMenu.menu && menuCard ? (
        <ContextMenu at={boardMenu.menu.at} onClose={boardMenu.close} label={menuCard.name} width={200} testId="v12-board-menu"
          items={[
            ...menuItems(menuFor("board", new Set(disabled ? ["copy-link"] : ["open", "copy-link"])), (id) => { if (id === "open") onOpen(menuCard.id); else copyBoardLink(menuCard.id, toast); }),
            ...(disabled || spendOff || isSampleDraftId(menuCard.id) ? [] : [{ separator: true, id: "share-sep" } as MenuItem, { id: "share-team", label: isShared(menuCard.id) ? SHARE_TEAM.stop : SHARE_TEAM.share, tip: SHARE_TEAM.tip, testId: "v12-menu-share-team", onSelect: () => void toggleShare(menuCard.id) } as MenuItem]),
          ]} />
      ) : null}
    </section>
  );
}
