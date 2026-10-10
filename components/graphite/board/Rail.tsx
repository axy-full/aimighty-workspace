"use client";
import type { RailEntry, RegionStatus } from "@/lib/board/regions";
import type { RegionId } from "@/lib/board/types";

/*
 * The outline rail (README § 1.1, the master's board): 88 px, one entry per
 * section with its status dot (empty · working · needs you with a count ·
 * done), its 16 px icon and a 12 px label; the section in view is lit;
 * hovering says the one-line summary; clicking glides the board there.
 * Library and History sit at the bottom as 280 px drawers, closed by default. A Studio board adds the 3D scene's
 * renders (owner Q19: the old render panel stays in Release 1 until renders get a new home).
 */
export type BoardDrawer = "library" | "history" | "render";

const STATE_WORDS: Record<RegionStatus["state"], string> = { empty: "nothing yet", working: "working", needs: "needs you", done: "done" };
const DRAWERS: { id: BoardDrawer; label: string; icon: string }[] = [
  { id: "library", label: "Library", icon: "M2 3h4l2 2h6v8H2z" },
  { id: "history", label: "History", icon: "M8 4v4l3 2M14 8A6 6 0 1 1 8 2a6 6 0 0 1 6 6" },
  { id: "render", label: "3D scene", icon: "M8 2l5.5 3v6L8 14l-5.5-3V5zM8 8l5.5-3M8 8v6M8 8L2.5 5" },
];

export function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Rail({ rail, status, inView, drawer, onGlide, onDrawer, render = false }: {
  rail: readonly RailEntry[];
  status: ReadonlyMap<RegionId, RegionStatus>;
  inView: RegionId | null;
  drawer: BoardDrawer | null;
  onGlide: (region: RegionId) => void;
  onDrawer: (drawer: BoardDrawer | null) => void;
  /** Whether this board offers the 3D scene's render drawer (the Studio board). */
  render?: boolean;
}) {
  return (
    <nav className="bd-rail" aria-label="Board sections" data-testid="board-rail">
      <div className="bd-rail-sections">
        <span className="bd-rail-line" aria-hidden="true" />
        {rail.map((entry) => {
          const s = status.get(entry.id) ?? { state: "empty" as const, count: 0, summary: "", cards: 0 };
          const here = entry.id === inView;
          return (
            <button
              key={entry.id}
              type="button"
              className="bd-rail-item"
              data-region={entry.id}
              data-state={s.state}
              aria-current={here ? "location" : undefined}
              aria-label={`${entry.label} · ${STATE_WORDS[s.state]}${s.count ? ` · ${s.count.toLocaleString("en-US")}` : ""} · ${s.summary}`}
              title={s.summary}
              onClick={() => onGlide(entry.id)}
            >
              <span className="bd-rail-dot" data-state={s.state} aria-hidden="true">
                {s.state === "needs" && s.count ? <span className="bd-rail-count">{s.count.toLocaleString("en-US")}</span> : null}
              </span>
              <Glyph d={entry.icon} />
              <span>{entry.label}</span>
            </button>
          );
        })}
      </div>
      <div className="bd-rail-drawers">
        {DRAWERS.filter((item) => render || item.id !== "render").map((item) => (
          <button key={item.id} type="button" className="bd-rail-item bd-rail-drawer" aria-pressed={drawer === item.id} data-testid={`board-drawer-${item.id}`}
            onClick={() => onDrawer(drawer === item.id ? null : item.id)}>
            <Glyph d={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
