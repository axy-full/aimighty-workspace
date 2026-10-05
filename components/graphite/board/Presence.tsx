"use client";
import { ViewportPortal, useStore } from "@xyflow/react";
import { initialsOf } from "@/lib/board/history";
import type { RoomPeer } from "@/lib/workbench/team-canvas-model";

/*
 * Who else is on the board (live presence from the team canvas; the design draws none, so this follows History's
 * avatars, README § 3.1 frame p): each teammate's cursor with their name, drawn on the board in its own units, and a
 * row of who is here at the canvas's top right, Atomik among them while it works. Atomik's own cursor is not drawn:
 * it shows on the card it is working on instead (the card's ring).
 */
export function PeerCursors({ peers }: { peers: readonly RoomPeer[] }) {
  const zoom = useStore((s) => s.transform[2]);
  const shown = peers.filter((p) => !p.agent && p.cursor);
  if (!shown.length) return null;
  return (
    <ViewportPortal>
      {shown.map((peer) => (
        <span key={peer.id} className="bd-cursor" aria-hidden="true"
          style={{ transform: `translate(${peer.cursor!.x}px, ${peer.cursor!.y}px) scale(${1 / zoom})`, color: peer.color }}>
          <svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l12 9-5.5 1L5 17z" fill="currentColor" stroke="var(--gx-root)" strokeWidth="1" /></svg>
          <span style={{ background: peer.color }}>{peer.name}</span>
        </span>
      ))}
    </ViewportPortal>
  );
}

export function WhoIsHere({ peers }: { peers: readonly RoomPeer[] }) {
  if (!peers.length) return null;
  const people = peers.filter((p) => !p.agent), agent = peers.find((p) => p.agent);
  return (
    <div className="bd-here" role="status" aria-label={`On this board: ${[...people.map((p) => p.name), ...(agent ? ["Atomik"] : [])].join(", ")}`} data-testid="board-here">
      {agent ? <span className="bd-here-face" data-agent="" title={`Atomik · ${agent.doing ?? "working on the board"}`}>AT</span> : null}
      {people.slice(0, 5).map((p) => <span key={p.id} className="bd-here-face" title={p.name} style={{ borderColor: p.color }}>{initialsOf(p.name)}</span>)}
      {people.length > 5 ? <span className="bd-here-face" title={`${people.length - 5} more`}>+{people.length - 5}</span> : null}
    </div>
  );
}
