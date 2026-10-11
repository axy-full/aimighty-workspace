"use client";
import { useState, type RefObject } from "react";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import type { ProjectSummary } from "@/lib/workspace/data";
import { posterOf } from "@/components/graphite/icons";
import { editedLine } from "@/components/graphite/home/home-model";
import { useProjectCover } from "@/components/graphite/home/use-project-cards";
import { Popover } from "../ui";

/**
 * The + popover (docs/redesign/inventory.md § 5.3; prototype L72): find a board, the recent boards, the boards closed
 * lately, and a new board by kind. A new board opens as a tab of its own, "New board" (components/v12/board/NewBoard.tsx),
 * on the kind picked; nothing is made until Start there, and Start is today's create path.
 */
type Kind = { id: "film" | "previs" | "campaign" | "social"; name: string; line: string };
const KINDS: readonly Kind[] = [
  { id: "film", name: "Film", line: "An AI film or ad" },
  { id: "previs", name: "Pre-vis", line: "Boards for a shoot" },
  { id: "campaign", name: "Campaign", line: "A product’s ads" },
  { id: "social", name: "Social", line: "Narrated or clips" },
];

export function PlusPopover({ open, onClose, anchor, projects, closed, onOpen }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  projects: readonly ProjectSummary[];
  closed: readonly string[];
  onOpen: (id: string) => void;
}) {
  const shell = useShell();
  const [query, setQuery] = useState("");
  const [now] = useState(() => Date.now());
  const q = query.trim().toLowerCase();
  const found = q ? projects.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6) : projects.slice(0, 3);
  const closedRows = closed.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectSummary => Boolean(p));

  /* The Enter that picked a board is spent here (preventDefault), so it never reaches the + button focus returns to. */
  const go = (id: string) => { setQuery(""); onOpen(id); };
  /* A new board is a tab of its own (components/v12/board/NewBoard.tsx): it opens on the kind picked, and nothing is made until Start. */
  const make = (kind: Kind) => {
    setQuery("");
    onClose();
    shell.goBoard({ newBoard: kind.id, closeMake: true });
  };

  return (
    <Popover open={open} onClose={() => { setQuery(""); onClose(); }} anchor={anchor} label="New tab" width={560} testId="v12-plus">
      <div className="v12-plus">
        <input className="v12-plus-find" aria-label="Find a board" placeholder="Find a board…" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && found[0]) { e.preventDefault(); go(found[0].id); } }} data-testid="v12-plus-find" />
        {found.length ? (
          <section aria-label={q ? "Boards" : "Recent boards"}>
            <div className="v12-plus-label">{q ? "Boards" : "Recent boards"}</div>
            <div className="v12-plus-grid">
              {found.map((p) => <BoardCard key={p.id} project={p} meta={editedLine(p, now) || "Board"} visible={open} onOpen={() => go(p.id)} />)}
            </div>
          </section>
        ) : q ? <p className="v12-plus-none">No board is called that.</p> : null}
        {closedRows.length && !q ? (
          <section aria-label="Recently closed">
            <div className="v12-plus-label">Recently closed</div>
            {closedRows.map((p) => <ClosedRow key={p.id} project={p} visible={open} onOpen={() => go(p.id)} />)}
          </section>
        ) : null}
        <section aria-label="New board">
          <div className="v12-plus-label">New board</div>
          <div className="v12-plus-kinds">
            {KINDS.map((k) => (
              <button key={k.id} type="button" className="v12-plus-kind" onClick={() => make(k)} data-testid={`v12-new-${k.id}`}>
                <span className="v12-plus-kind-name">{k.name}</span>
                <span className="v12-plus-kind-line">{k.line}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </Popover>
  );
}

function Thumb({ project, visible, className }: { project: ProjectSummary; visible: boolean; className: string }) {
  const { requestScope } = useSession();
  const cover = useProjectCover(requestScope ?? "", project.id, visible && Boolean(requestScope));
  const swatch = posterOf(project.name);
  return (
    <span className={className} style={cover ? undefined : { background: `linear-gradient(135deg, ${swatch.from}, ${swatch.to})` }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a stored take, as the Library's tiles draw it */}
      {cover?.kind === "image" ? <img src={cover.url} alt="" /> : cover?.kind === "video" ? <video src={cover.url} muted playsInline preload="metadata" /> : null}
    </span>
  );
}

function BoardCard({ project, meta, visible, onOpen }: { project: ProjectSummary; meta: string; visible: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="v12-plus-card" onClick={onOpen} data-testid="v12-plus-board">
      <Thumb project={project} visible={visible} className="v12-plus-thumb" />
      <span className="v12-plus-card-text">
        <span className="v12-plus-card-name">{project.name}</span>
        <span className="v12-plus-card-meta">{meta}</span>
      </span>
    </button>
  );
}

function ClosedRow({ project, visible, onOpen }: { project: ProjectSummary; visible: boolean; onOpen: () => void }) {
  return (
    <div className="v12-plus-closed" data-testid="v12-plus-closed">
      <Thumb project={project} visible={visible} className="v12-plus-mini" />
      <span className="v12-plus-closed-name">{project.name}</span>
      <button type="button" className="v12-plus-reopen" onClick={onOpen}>Reopen</button>
    </div>
  );
}
