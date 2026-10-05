"use client";
import { useReactFlow, useStore } from "@xyflow/react";
import type { BoardBox } from "@/lib/board/types";

/*
 * The board's bottom-left cluster (the master's board, shown on hover and on
 * keyboard focus): the minimap over the zoom pill (− NN % +) and the
 * Board | List switch. The minimap draws the regions and the view; a press on
 * it moves the view there.
 */
const MINI = { w: 150, h: 92 };
const STEP = 0.1;

export function HoverCluster({ regions, bounds, list, onList, onTidy }: { regions: readonly BoardBox[]; bounds: BoardBox | null; list: boolean; onList: (list: boolean) => void; onTidy?: () => void }) {
  const flow = useReactFlow();
  const x = useStore((s) => s.transform[0]), y = useStore((s) => s.transform[1]), zoom = useStore((s) => s.transform[2]);
  const width = useStore((s) => s.width), height = useStore((s) => s.height);
  const view = { x: -x / zoom, y: -y / zoom, w: width / zoom, h: height / zoom };
  const area = bounds ? [bounds, view].reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) })) : view;
  const scale = Math.min(MINI.w / Math.max(1, area.w), MINI.h / Math.max(1, area.h));
  const at = (box: BoardBox) => ({ left: (box.x - area.x) * scale, top: (box.y - area.y) * scale, width: Math.max(2, box.w * scale), height: Math.max(2, box.h * scale) });
  const zoomTo = (next: number) => void flow.zoomTo(Math.min(2, Math.max(0.25, Math.round(next * 10) / 10)), { duration: 150 });
  const panTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const cx = area.x + (event.clientX - box.left) / scale, cy = area.y + (event.clientY - box.top) / scale;
    void flow.setCenter(cx, cy, { zoom, duration: 200 });
  };
  return (
    <div className="bd-cluster" data-testid="board-cluster" data-pinned={list || undefined}>
      {list ? null : (
        <div className="bd-mini" style={{ width: MINI.w, height: MINI.h }} role="img" aria-label="Where the view is on the board" onPointerDown={panTo}>
          {regions.map((box, i) => <span key={i} className="bd-mini-region" style={at(box)} />)}
          <span className="bd-mini-view" style={at(view)} />
        </div>
      )}
      <div className="bd-cluster-row">
        {list ? null : (
          <div className="bd-zoom" role="group" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" onClick={() => zoomTo(zoom - STEP)}>−</button>
            <button type="button" className="bd-zoom-level" aria-label="Zoom to 100%" data-testid="board-zoom" onClick={() => zoomTo(1)}>{Math.round(zoom * 100)}%</button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomTo(zoom + STEP)}>+</button>
          </div>
        )}
        {list || !onTidy ? null : <button type="button" className="bd-tidy" data-testid="board-tidy" title="Lay the free cards out on the grid, in order" onClick={onTidy}>Tidy</button>}
        <div className="gx-seg bd-seg" role="tablist" aria-label="Board or list">
          <button type="button" role="tab" className="gx-seg-btn" aria-selected={!list} onClick={() => onList(false)}><span>Board</span></button>
          <button type="button" role="tab" className="gx-seg-btn" aria-selected={list} onClick={() => onList(true)} data-testid="board-list-toggle"><span>List</span></button>
        </div>
      </div>
    </div>
  );
}
