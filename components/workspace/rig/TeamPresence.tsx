"use client";
import { useRig } from "./RigProvider";

/** Who else is on this production's canvas, above the shot list and the graph alike. */
export function TeamPresence() {
  const { team, project } = useRig();
  if (!project || team.mode === "off") return null;
  if (team.mode === "saved")
    return (
      <p className="pxw-team" data-mode="saved" data-testid="rig-team">
        <span className="pxw-team-dot" aria-hidden="true" />
        Team canvas · every shot and node here is shared with your team
      </p>
    );
  const count = team.peers.length;
  return (
    <p className="pxw-team" data-mode="live" data-testid="rig-team" role="status">
      <span className="pxw-team-dot" aria-hidden="true" />
      {count ? `Live · ${count} ${count === 1 ? "teammate" : "teammates"} here` : "Live · edits reach your team as you make them"}
      {team.peers.slice(0, 6).map((p) => (
        <span key={p.id} className="pxw-team-peer"><i style={{ background: p.color }}>{p.name.slice(0, 1).toUpperCase()}</i>{p.name}</span>
      ))}
      {count > 6 ? <span>+{count - 6}</span> : null}
    </p>
  );
}
