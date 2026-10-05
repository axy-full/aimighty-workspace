"use client";
import { ViewportPortal, useStore } from "@xyflow/react";
import { whoIsHere } from "@/lib/board/presence";
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
  const here = whoIsHere(peers);
  if (!here) return null;
  return (
    <div className="bd-here" role="status" aria-label={here.label} data-testid="board-here">
      {here.faces.map((face) => (
        <span key={face.key} className="bd-here-face" data-agent={face.agent ? "" : undefined} title={face.title} style={face.colour ? { borderColor: face.colour } : undefined}>{face.initials}</span>
      ))}
      {here.more ? <span className="bd-here-face" title={here.more.title}>+{here.more.count}</span> : null}
    </div>
  );
}
